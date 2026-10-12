'use strict';

const childProcess = require('node:child_process');
const logic = require('./logic');

const DEFAULT_TIMEOUT_MS = 12000;
// A screen size is asked for again after this long; one that could not be read is stood in for by
// the last one read, for no longer than the second figure.
const SCREEN_SIZE_FRESH_MS = 20000;
const SCREEN_SIZE_KEPT_MS = 600000;

class AdbError extends Error {}

class AdbClient {
  constructor(adbPath) {
    this.adbPath = adbPath;
  }

  /** Resolves with { code, stdout: Buffer, stderr: string }. Rejects only when adb cannot run or times out. */
  run(args, { serial, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const fullArgs = serial ? ['-s', serial, ...args] : args;
    return new Promise((resolve, reject) => {
      childProcess.execFile(
        this.adbPath,
        fullArgs,
        { timeout, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && error.killed) {
            reject(new AdbError(`ADB command timed out after ${Math.round(timeout / 1000)}s: adb ${fullArgs.join(' ')}`));
            return;
          }
          if (error && typeof error.code !== 'number') {
            reject(new AdbError(error.message));
            return;
          }
          resolve({ code: error ? error.code : 0, stdout, stderr: stderr.toString('utf8') });
        },
      );
    });
  }

  async text(args, options) {
    const result = await this.run(args, options);
    const stdout = result.stdout.toString('utf8').trim();
    if (result.code !== 0) throw new AdbError(result.stderr.trim() || stdout || 'ADB command failed');
    return stdout;
  }

  async listDevices() {
    return logic.parseDevices(await this.text(['devices', '-l'], { timeout: 8000 }));
  }

  async getprop(serial, prop) {
    try {
      return await this.text(['shell', 'getprop', prop], { serial, timeout: 5000 });
    } catch {
      return '';
    }
  }

  async readBattery(serial) {
    try {
      return logic.parseBattery(await this.text(['shell', 'dumpsys', 'battery'], { serial, timeout: 6000 }));
    } catch {
      return {};
    }
  }

  async enrich(device) {
    if (device.status !== 'device') return device;
    const { serial } = device;
    const [model, product, android, sdk, battery] = await Promise.all([
      device.model || this.getprop(serial, 'ro.product.model'),
      device.product || this.getprop(serial, 'ro.product.name'),
      this.getprop(serial, 'ro.build.version.release'),
      this.getprop(serial, 'ro.build.version.sdk'),
      this.readBattery(serial),
    ]);
    return {
      ...device,
      model,
      product,
      android,
      sdk,
      battery: battery.level || '',
      charging: battery.charging || '',
      temperature: battery.temperature || '',
    };
  }

  async currentPackage(serial) {
    for (const command of [['shell', 'dumpsys', 'window'], ['shell', 'dumpsys', 'activity', 'activities']]) {
      try {
        const pkg = logic.extractCurrentPackage(await this.text(command, { serial, timeout: 8000 }));
        if (pkg) return pkg;
      } catch {
        // try the next source
      }
    }
    return '';
  }

  keyevent(serial, key) {
    return this.text(['shell', 'input', 'keyevent', key], { serial, timeout: 5000 });
  }

  inputText(serial, value) {
    return this.text(['shell', 'input', 'text', logic.quoteInputText(value)], { serial, timeout: 8000 });
  }

  tap(serial, x, y) {
    return this.text(['shell', 'input', 'tap', String(x), String(y)], { serial, timeout: 5000 });
  }

  swipe(serial, x1, y1, x2, y2, duration) {
    return this.text(['shell', 'input', 'swipe', ...[x1, y1, x2, y2, duration].map(String)], { serial, timeout: 5000 + duration });
  }

  /** Screen size in the current orientation, which is the space `input tap` works in. */
  async screenSize(serial) {
    this.sizes = this.sizes || new Map();
    const known = this.sizes.get(serial);
    // A size read a moment ago still holds: the taps of one workflow follow each other closely.
    if (known && Date.now() - known.at < SCREEN_SIZE_FRESH_MS) return known.size;
    // A busy phone now and then gives no answer: ask a few times before giving up.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 700));
      for (const command of [['shell', 'dumpsys', 'window', 'displays'], ['shell', 'wm', 'size']]) {
        try {
          const size = logic.parseScreenSize(await this.text(command, { serial, timeout: 8000 }));
          if (size) {
            this.sizes.set(serial, { size, at: Date.now() });
            return size;
          }
        } catch {
          // try the next source
        }
      }
    }
    // No answer at all: the size this phone gave within the last while is far more likely right than not.
    if (known && Date.now() - known.at < SCREEN_SIZE_KEPT_MS) return known.size;
    throw new AdbError('Unable to read the screen size.');
  }

  /** Close an app the way "Force stop" in Settings does, so it next opens on its first screen. */
  forceStop(serial, pkg) {
    return this.text(['shell', 'am', 'force-stop', pkg], { serial, timeout: 10000 });
  }

  openPackage(serial, pkg) {
    return this.text(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { serial, timeout: 10000 });
  }

  async listPackages(serial, includeSystem) {
    const args = ['shell', 'pm', 'list', 'packages'];
    if (!includeSystem) args.push('-3');
    return logic.parsePackages(await this.text(args, { serial, timeout: 25000 }));
  }

  async packageInfo(serial, pkg) {
    return logic.parsePackageInfo(await this.text(['shell', 'dumpsys', 'package', pkg], { serial, timeout: 15000 }));
  }

  clearPackageData(serial, pkg) {
    return this.text(['shell', 'pm', 'clear', pkg], { serial, timeout: 25000 });
  }

  uninstallPackage(serial, pkg) {
    return this.text(['uninstall', pkg], { serial, timeout: 60000 });
  }

  async installApk(serial, apkPath) {
    return (await this.text(['install', '-r', apkPath], { serial, timeout: 180000 })) || 'Installed';
  }

  reboot(serial) {
    return this.text(['reboot'], { serial, timeout: 15000 });
  }

  async screenshot(serial) {
    const result = await this.run(['exec-out', 'screencap', '-p'], { serial, timeout: 20000 });
    if (result.code !== 0 || !result.stdout.length) throw new AdbError(result.stderr.trim() || 'Screenshot failed');
    return result.stdout;
  }

  /** The screen's view tree as XML. Works where a screenshot is blocked, since it carries text, not pixels. */
  async uiDump(serial) {
    const result = await this.run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { serial, timeout: 20000 });
    const xml = result.stdout.toString('utf8');
    if (!xml.includes('<hierarchy')) throw new AdbError(result.stderr.trim() || xml.trim().slice(0, 200) || 'Screen text is not available');
    return xml;
  }

  /** The phone's own clock in seconds, which is what its file times are measured against. */
  async clock(serial) {
    const seconds = Number.parseInt(await this.text(['shell', 'date', '+%s'], { serial, timeout: 5000 }), 10);
    if (!Number.isFinite(seconds)) throw new AdbError('Unable to read the phone clock.');
    return seconds;
  }

  /** Pictures in the gallery folders changed at or after `since` (phone clock), newest first. */
  async newImages(serial, since) {
    const minutes = Math.max(1, Math.ceil(((await this.clock(serial)) - since) / 60) + 1);
    const command = `find /sdcard/DCIM /sdcard/Pictures /sdcard/Download -type f -mmin -${minutes} `
      + "\\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \\) -exec stat -c '%Y|%n' {} + 2>/dev/null";
    // find reports a missing folder through its exit code; the pictures it did find still count.
    const result = await this.run(['shell', command], { serial, timeout: 20000 });
    return logic.parseImageList(result.stdout.toString('utf8'), since);
  }

  /** The bytes of one file on the phone. */
  async pull(serial, devicePath) {
    const quoted = `'${String(devicePath).replace(/'/g, `'\\''`)}'`;
    // One command string: adb re-quotes any separate argument that holds a space, which would
    // turn these quotes into part of the file name.
    const result = await this.run(['exec-out', `cat ${quoted}`], { serial, timeout: 30000 });
    // exec-out does not pass on cat's exit code, and its error text arrives as if it were the file.
    if (result.code !== 0 || !result.stdout.length || result.stdout.subarray(0, 5).toString('latin1') === 'cat: ') {
      // What cat said, without the folders: "No such file or directory" tells a renamed file from a lost phone.
      const said = result.stdout.subarray(0, 300).toString('utf8').trim().split(/\r?\n/)[0].replace(/\/\S*\//g, '');
      throw new AdbError(result.stderr.trim() || (said.startsWith('cat: ') ? `Unable to read the file from the phone (${said.slice(5)})` : 'Unable to read the file from the phone'));
    }
    return result.stdout;
  }

  async restartServer() {
    await this.run(['kill-server'], { timeout: 8000 });
    await this.text(['start-server'], { timeout: 15000 });
  }
}

module.exports = { AdbClient, AdbError };
