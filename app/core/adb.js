'use strict';

const childProcess = require('node:child_process');
const logic = require('./logic');

const DEFAULT_TIMEOUT_MS = 12000;

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

  async restartServer() {
    await this.run(['kill-server'], { timeout: 8000 });
    await this.text(['start-server'], { timeout: 15000 });
  }
}

module.exports = { AdbClient, AdbError };
