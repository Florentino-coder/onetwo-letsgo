'use strict';

const { app, BrowserWindow, Notification, ipcMain, dialog, shell, nativeImage, safeStorage } = require('electron');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { AdbClient } = require('./core/adb');
const { Store } = require('./core/store');
const logic = require('./core/logic');
const { checkForUpdate } = require('./updater');
const { createJobs } = require('./jobs');
const ocr = require('./ocr');
const secret = require('./secret');

const APP_NAME = 'ADB-OneTwo';
const DEVICE_PARALLELISM = 4;
const THUMBNAIL_WIDTH = 300;
const RECORD_WIDTH = 540;
// Time for the screen to react to a recorded gesture before the next picture is taken.
const RECORD_SETTLE_MS = 700;
const LOG_MEMORY = 500;
// How long to wait for the phone app to finish saving its slip picture.
const SLIP_TRIES = 30;
const SLIP_RETRY_MS = 1500;
// A slip's file is read up to this many times, until it has been written whole.
const SLIP_PULL_TRIES = 8;
const API_DEFAULT_PORT = 8765;
const API_MAX_BODY = 16 * 1024;
const API_MAX_WAITING = 50;

const UPDATE_INTERVAL_MS = 24 * 3600000;
const UPDATE_POLL_MS = 3600000;
// boot.js sets both; the fallbacks cover running main.js directly.
const VERSION = process.env.FARM_VERSION || app.getVersion();
const baseDir = process.env.FARM_DATA_DIR
  || (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
const store = new Store(baseDir);
// Sets saved by an older version lack fields added since; give every set its full shape once.
for (const name of Object.keys(store.state.pick_sets)) store.state.pick_sets[name] = logic.normalizePickSet(store.state.pick_sets[name]);

let win = null;
let adb = null;
let scrcpyPath = null;
let devices = new Map();
let scanning = false;
let jobRunning = null;
let workflowRuns = 0;
let autoScanTimer = null;
const liveProcesses = new Map();
const touchRecorders = new Map();
const jobs = createJobs({
  store,
  appName: APP_NAME,
  send: (channel, payload) => send(channel, payload),
  log: (message, level) => log(message, level),
  // Something the operator should see even with the window out of sight.
  notify: (body) => {
    if (Notification.isSupported()) new Notification({ title: APP_NAME, body }).show();
  },
  runWorkflow: (request) => runWorkflow(request),
  runWorkflowOne: (request) => runWorkflowOne(request),
  onlineSerials: () => [...devices.values()].filter((device) => device.status === 'device').map((device) => device.serial),
  busy: () => jobRunning,
  inputsOf: (text) => logic.workflowInputs(logic.parseWorkflow(text)),
  readScreen: (serial) => readScreen(serial),
  readSlip: (serial, since) => readSlip(serial, since),
  phoneClock: (serial) => requireAdb().clock(serial),
  phones: () => [...devices.values()].filter((device) => device.status === 'device' && deviceMeta(device.serial).pay_on !== false).map((device) => ({ serial: device.serial, label: deviceLabel(device), ...amountRange(device.serial), ...payAccount(device.serial) })),
  // Money left the phone's account: keep the balance the operator entered in step.
  spend: (serial, amount) => {
    const { balance } = payAccount(serial);
    if (balance === null) return;
    store.state.devices[serial] = { ...deviceMeta(serial), balance: Math.max(0, Math.round((balance - Number(amount)) * 100) / 100) };
    store.saveState();
    send('devices', devicesSnapshot());
  },
});
const healthAlerts = new Set();
const logs = [];

// ── tools ────────────────────────────────────────────────────────────────

function findOnPath(name) {
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (dir && fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveTool(name, configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const fromPath = findOnPath(name);
  if (fromPath) return fromPath;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  for (const env of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[env]) candidates.push(path.join(process.env[env], 'platform-tools', exe));
  }
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe));
  candidates.push(path.join(baseDir, 'tools', name, exe));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function loadTools() {
  const adbPath = resolveTool('adb', store.config.adb_path);
  adb = adbPath ? new AdbClient(adbPath) : null;
  scrcpyPath = resolveTool('scrcpy', store.config.scrcpy_path);
}

function requireAdb() {
  if (!adb) throw new Error('ADB was not found. Set its location in Settings.');
  return adb;
}

// ── logging and renderer events ──────────────────────────────────────────

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function log(message, level = 'info', serial = null) {
  const entry = { at: new Date().toISOString(), level, message, serial };
  logs.push(entry);
  if (logs.length > LOG_MEMORY) logs.shift();
  store.appendEvent(entry);
  send('log', entry);
}

// ── device metadata ──────────────────────────────────────────────────────

function deviceMeta(serial) {
  const meta = store.state.devices[serial];
  return meta && typeof meta === 'object' ? meta : {};
}

/** The amounts this phone may pay, as { min, max }; both null when no range is set. */
function amountRange(serial) {
  const { amount_min: min, amount_max: max } = deviceMeta(serial);
  return Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min ? { min, max } : { min: null, max: null };
}

/**
 * The account a phone pays from and what it may spend, as the operator entered them:
 * { bank, account, holder, cap, balance, scale }. `cap` is the most it may pay in a day and
 * `balance` what is left in the account; null for either means "not set, not checked".
 * `scale` stretches every wait of a workflow on this phone, for a slow phone or connection.
 */
function payAccount(serial) {
  const meta = deviceMeta(serial);
  const number = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
  return {
    bank: typeof meta.pay_bank === 'string' ? meta.pay_bank : '',
    account: typeof meta.pay_account === 'string' ? meta.pay_account : '',
    holder: typeof meta.pay_holder === 'string' ? meta.pay_holder : '',
    cap: number(meta.day_cap),
    balance: number(meta.balance),
    scale: Number.isFinite(meta.wait_scale) && meta.wait_scale >= 0.5 && meta.wait_scale <= 5 ? meta.wait_scale : 1,
  };
}

function deviceLabel(device) {
  return deviceMeta(device.serial).name || device.model || device.serial;
}

function deviceView(device) {
  const meta = deviceMeta(device.serial);
  return {
    ...device,
    online: device.status === 'device',
    name: meta.name || '',
    group: meta.group || 'Default',
    slot: meta.slot || '',
    label: deviceLabel(device),
    liveProfile: meta.live_profile || '',
    hasPin: Boolean(meta.pin),
    amountMin: amountRange(device.serial).min,
    amountMax: amountRange(device.serial).max,
    payOn: meta.pay_on !== false,
    pay: payAccount(device.serial),
    live: liveProcesses.has(device.serial),
  };
}

function devicesSnapshot() {
  return [...devices.values()].map(deviceView);
}

function onlineDevices(serials) {
  return serials
    .filter((serial) => logic.isSerial(serial) && devices.get(serial)?.status === 'device')
    .map((serial) => devices.get(serial));
}

// ── scanning ─────────────────────────────────────────────────────────────

function evaluateHealth(list) {
  const lowBattery = Number(store.config.low_battery_percent) || 20;
  const highTemp = Number(store.config.high_temp_c) || 42;
  for (const device of list) {
    if (device.status !== 'device') continue;
    const checks = [
      ['battery', logic.parsePercent(device.battery), (v) => v <= lowBattery, (v) => `battery is low at ${v}%`],
      ['temperature', logic.parseTemperature(device.temperature), (v) => v >= highTemp, (v) => `temperature is high at ${v.toFixed(1)}C`],
    ];
    for (const [kind, value, isBad, describe] of checks) {
      const key = `${device.serial}:${kind}`;
      if (value !== null && isBad(value)) {
        if (!healthAlerts.has(key)) {
          healthAlerts.add(key);
          log(`HEALTH warning: ${deviceLabel(device)} ${describe(value)}.`, 'warning', device.serial);
        }
      } else {
        healthAlerts.delete(key);
      }
    }
  }
}

function scheduleAutoScan() {
  clearTimeout(autoScanTimer);
  if (!store.config.auto_scan_enabled) return;
  const seconds = Math.max(5, Number(store.config.auto_scan_interval_seconds) || 15);
  autoScanTimer = setTimeout(() => scan(), seconds * 1000);
}

async function scan() {
  if (scanning) return;
  scanning = true;
  send('status', { scanning: true });
  try {
    const client = requireAdb();
    let list;
    try {
      list = await client.listDevices();
    } catch (error) {
      if (store.config.auto_restart_adb === false) throw error;
      log(`Scan failed (${error.message}). Restarting ADB server once.`, 'warning');
      await client.restartServer();
      list = await client.listDevices();
    }
    list = await logic.mapLimit(list, DEVICE_PARALLELISM, (device) => client.enrich(device));
    const now = Date.now();
    const next = new Map();
    for (const device of list) {
      const previous = devices.get(device.serial);
      if (!previous) log(`Discovered ${deviceLabel(device)} (${device.serial}) as ${device.status}.`, 'info', device.serial);
      else if (previous.status !== device.status) {
        log(`Status changed for ${deviceLabel(device)}: ${previous.status} -> ${device.status}.`, 'info', device.serial);
      }
      next.set(device.serial, { ...device, lastSeen: now });
    }
    for (const [serial, previous] of devices) {
      if (!next.has(serial)) log(`Device disappeared: ${serial} was ${previous.status}.`, 'warning', serial);
    }
    devices = next;
    evaluateHealth(list);
    send('devices', { devices: devicesSnapshot(), scannedAt: now });
  } catch (error) {
    log(`ERROR: ${error.message}`, 'error');
  } finally {
    scanning = false;
    send('status', { scanning: false });
    scheduleAutoScan();
  }
}

// ── policy guard ─────────────────────────────────────────────────────────

/** Applies the app policy for the package in the foreground (or `pkg` when the action names one). */
async function guard(serial, actionName, { pkg, allowManualOnly = false, requireCapture = false } = {}) {
  const target = pkg || await requireAdb().currentPackage(serial);
  if (!target) return;
  logic.checkPolicy(store.state.policies[target], { actionName, pkg: target, allowManualOnly, requireCapture });
}

// ── device actions ───────────────────────────────────────────────────────

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

function requireApk(apkPath) {
  if (typeof apkPath !== 'string' || path.extname(apkPath).toLowerCase() !== '.apk' || !fs.existsSync(apkPath)) {
    throw new Error('Choose an existing .apk file.');
  }
  return apkPath;
}

function requirePackage(pkg) {
  if (!logic.isPackage(pkg)) throw new Error(`'${pkg}' is not a valid package name.`);
  return pkg;
}

async function captureToFile(serial) {
  const file = path.join(store.dir('captures'), `${safeName(serial)}_${stamp()}.png`);
  fs.writeFileSync(file, await requireAdb().screenshot(serial));
  return file;
}

/**
 * Everything readable on a phone's screen, from two sources: the view tree, which is exact but
 * which some apps keep empty, and text recognition on a screenshot, which some apps blank out.
 * The screenshot is kept in the captures folder as a record of what was checked.
 */
async function readScreen(serial) {
  await guard(serial, 'Read screen', { allowManualOnly: true, requireCapture: true });
  const parts = [];
  const notes = [];
  let file = '';
  try {
    parts.push(logic.parseUiText(await requireAdb().uiDump(serial)));
  } catch (error) {
    notes.push(`view tree: ${error.message}`);
  }
  try {
    file = await captureToFile(serial);
    parts.push(await ocr.recognize(file));
  } catch (error) {
    notes.push(`picture: ${error.message}`);
  }
  return { text: parts.filter(Boolean).join('\n'), file, notes };
}

/**
 * The newest picture the phone saved to its gallery at or after `since` (phone clock), read as
 * text. An app that saves a slip only when its transaction went through makes that picture the
 * proof; no screenshot is taken. A copy is kept in the captures folder.
 */
async function readSlip(serial, since) {
  const client = requireAdb();
  let newest = null;
  for (let attempt = 0; attempt < SLIP_TRIES && !newest; attempt += 1) {
    if (attempt) await sleep(SLIP_RETRY_MS);
    [newest] = await client.newImages(serial, since);
  }
  if (!newest) return { text: '', file: '', notes: ['no new picture in the gallery'] };
  // The phone may still be writing the file: read it until it comes twice the same.
  let bytes = null;
  let fault = null;
  for (let attempt = 0; attempt < SLIP_PULL_TRIES; attempt += 1) {
    await sleep(SLIP_RETRY_MS);
    try {
      const read = await client.pull(serial, newest.path);
      if (bytes && read.equals(bytes)) break;
      bytes = read;
      fault = null;
    } catch (error) {
      fault = error;
    }
  }
  if (!bytes) throw fault || new Error('Unable to read the file from the phone.');
  const file = path.join(store.dir('captures'), `slip_${safeName(serial)}_${stamp()}${path.posix.extname(newest.path).toLowerCase()}`);
  fs.writeFileSync(file, bytes);
  return { text: await ocr.recognize(file), file, notes: [`phone file: ${newest.path}`] };
}

const ACTIONS = {
  async key(serial, arg) {
    const key = logic.KEY_ALIASES[arg] || arg;
    if (!logic.isKeyevent(key)) throw new Error(`'${arg}' is not a valid key.`);
    await guard(serial, arg);
    await requireAdb().keyevent(serial, key);
    return arg;
  },
  async text(serial, arg) {
    if (typeof arg !== 'string' || !arg) throw new Error('Enter text to send.');
    await guard(serial, 'Send text');
    await requireAdb().inputText(serial, arg);
    return 'text sent';
  },
  async open(serial, arg) {
    const pkg = requirePackage(arg);
    await guard(serial, 'Open app', { pkg, allowManualOnly: true });
    await requireAdb().openPackage(serial, pkg);
    return `opened ${pkg}`;
  },
  async screenshot(serial) {
    await guard(serial, 'Screenshot', { allowManualOnly: true, requireCapture: true });
    return captureToFile(serial);
  },
  async reboot(serial) {
    await requireAdb().reboot(serial);
    return 'rebooting';
  },
  install: (serial, arg) => requireAdb().installApk(serial, requireApk(arg)),
  clear: (serial, arg) => requireAdb().clearPackageData(serial, requirePackage(arg)),
  uninstall: (serial, arg) => requireAdb().uninstallPackage(serial, requirePackage(arg)),
};

/** One fleet job at a time: run `worker` on each online device, a few devices in parallel. */
async function runJob(label, serials, worker) {
  if (jobRunning) throw new Error(`Wait for "${jobRunning}" to finish first.`);
  if (soloRuns.size) throw new Error('Wait for the withdrawals being paid to finish first, or switch automatic mode off.');
  const targets = onlineDevices(serials);
  if (!targets.length) throw new Error('Select one or more online devices first.');
  jobRunning = label;
  let done = 0;
  send('job', { label, done, total: targets.length, running: true });
  try {
    const results = await logic.mapLimit(targets, DEVICE_PARALLELISM, async (device) => {
      let result;
      try {
        const detail = await worker(device);
        log(`${label} ok on ${deviceLabel(device)}${detail ? `: ${detail}` : ''}`, 'info', device.serial);
        result = { serial: device.serial, label: deviceLabel(device), ok: true, detail: detail || '' };
      } catch (error) {
        log(`${label} failed on ${deviceLabel(device)}: ${error.message}`, 'error', device.serial);
        result = { serial: device.serial, label: deviceLabel(device), ok: false, detail: error.message };
      }
      done += 1;
      send('job', { label, done, total: targets.length, running: true });
      return result;
    });
    return { label, results, failed: results.filter((r) => !r.ok).length };
  } finally {
    jobRunning = null;
    send('job', { label, done, total: targets.length, running: false });
  }
}

// ── thumbnails ───────────────────────────────────────────────────────────

let thumbnailsRunning = false;

async function refreshThumbnails(serials) {
  if (thumbnailsRunning) return;
  thumbnailsRunning = true;
  try {
    const targets = onlineDevices(serials && serials.length ? serials : [...devices.keys()]);
    await logic.mapLimit(targets, 3, async (device) => {
      const { serial } = device;
      try {
        await guard(serial, 'Thumbnail', { allowManualOnly: true, requireCapture: true });
        const image = nativeImage.createFromBuffer(await requireAdb().screenshot(serial));
        if (image.isEmpty()) throw new Error('Device returned an empty image.');
        const jpeg = image.resize({ width: THUMBNAIL_WIDTH, quality: 'good' }).toJPEG(78);
        send('thumb', { serial, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, at: Date.now() });
      } catch (error) {
        send('thumb', { serial, error: error.message, at: Date.now() });
      }
    });
  } finally {
    thumbnailsRunning = false;
  }
}

// ── live control (scrcpy) ────────────────────────────────────────────────

function profileFor(name) {
  const profileName = logic.SCRCPY_PROFILES[name] ? name : 'Balanced';
  const profile = { ...logic.SCRCPY_PROFILES[profileName] };
  if (store.config.scrcpy_override_profiles && store.config.scrcpy && typeof store.config.scrcpy === 'object') {
    for (const key of ['max_size', 'max_fps', 'bit_rate']) {
      if (key in store.config.scrcpy) profile[key] = store.config.scrcpy[key];
    }
  }
  return { profileName, profile };
}

function defaultProfileName(device) {
  const meta = deviceMeta(device.serial);
  return meta.live_profile
    || store.state.group_live_profiles[meta.group || 'Default']
    || store.config.scrcpy_profile
    || 'Balanced';
}

async function openLive(device, requestedProfile) {
  if (!scrcpyPath) throw new Error('scrcpy was not found. Set its location in Settings.');
  if (liveProcesses.has(device.serial)) return 'already open';
  await guard(device.serial, 'Open live control', { allowManualOnly: true, requireCapture: true });
  const { profileName, profile } = profileFor(requestedProfile || defaultProfileName(device));
  const title = `${APP_NAME} - ${deviceLabel(device)}`;
  const child = childProcess.spawn(scrcpyPath, logic.scrcpyArgs(device.serial, title, profile), {
    stdio: 'ignore',
    windowsHide: false,
  });
  liveProcesses.set(device.serial, child);
  const closed = () => {
    if (liveProcesses.get(device.serial) === child) {
      liveProcesses.delete(device.serial);
      send('devices', { devices: devicesSnapshot() });
    }
  };
  child.once('exit', closed);
  child.once('error', (error) => {
    log(`Unable to open scrcpy: ${error.message}`, 'error', device.serial);
    closed();
  });
  return `${profileName} profile`;
}

function closeLive(serials) {
  let count = 0;
  for (const serial of serials) {
    const child = liveProcesses.get(serial);
    if (child) {
      child.kill();
      count += 1;
    }
  }
  return count;
}

// ── workflows ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWorkflowStep(device, step, workflowName) {
  const { serial } = device;
  switch (step.command) {
    case 'wait':
      // A slow phone or connection is given longer at every wait.
      await sleep(Number(step.argument) * payAccount(serial).scale);
      return;
    case 'keyevent':
      await guard(serial, workflowName);
      await requireAdb().keyevent(serial, step.argument);
      return;
    case 'open':
      await guard(serial, workflowName, { pkg: step.argument, allowManualOnly: true });
      await requireAdb().openPackage(serial, step.argument);
      return;
    case 'close':
      await guard(serial, workflowName, { pkg: step.argument, allowManualOnly: true });
      await requireAdb().forceStop(serial, step.argument);
      return;
    case 'text':
      await guard(serial, workflowName);
      await requireAdb().inputText(serial, step.argument);
      return;
    case 'screenshot':
      await guard(serial, workflowName, { allowManualOnly: true, requireCapture: true });
      await captureToFile(serial);
      return;
    case 'tap':
    case 'swipe': {
      await guard(serial, workflowName);
      const gesture = logic.parseGesture(step.command, step.argument);
      const pixels = gesture.pixel ? gesture.points : logic.gesturePixels(gesture.points, await requireAdb().screenSize(serial));
      if (step.command === 'tap') await requireAdb().tap(serial, ...pixels);
      else await requireAdb().swipe(serial, ...pixels, gesture.duration);
      // Percentages resolve per device, so report the pixels that were used.
      return gesture.pixel ? '' : `${pixels.join(' ')} px`;
    }
    default:
      await guard(serial, workflowName);
      await requireAdb().keyevent(serial, logic.KEY_ALIASES[step.command]);
  }
}

// A phone's app PIN is kept encrypted by Windows for this user account (see secret.js), in the device's saved
// details. It is decrypted to plan a run, and for the window only when the operator asks to see
// it. It is not part of the app's state and is never logged.
// What has been read back since the app started, by its kept form: asking Windows takes half a second.
const pinsRead = new Map();

function devicePin(serial) {
  const kept = deviceMeta(serial).pin;
  if (typeof kept !== 'string' || !kept) return '';
  if (pinsRead.has(kept)) return pinsRead.get(kept);
  let pin = '';
  try {
    // A PIN kept by an older version was encrypted with the window profile's own key.
    if (secret.isProtected(kept)) pin = secret.reveal(kept);
    else if (safeStorage.isEncryptionAvailable()) pin = safeStorage.decryptString(Buffer.from(kept, 'base64'));
  } catch {
    // Kept by another Windows account or computer, or with a key that is gone: as good as not set.
    pin = '';
  }
  pinsRead.set(kept, pin);
  return pin;
}

/**
 * The steps each device will run, worked out before anything is pressed, so a run that cannot be
 * completed on one of them starts on none. Devices differ only in their PIN.
 */
function planWorkflow(text, values, serials) {
  const parsed = logic.parseWorkflow(text);
  const plans = new Map();
  for (const serial of Array.isArray(serials) ? serials : []) {
    try {
      plans.set(serial, logic.expandWorkflow(parsed, values, store.state.workflows, store.state.pick_sets, devicePin(serial)));
    } catch (error) {
      const device = devices.get(serial);
      // A PIN that is kept but cannot be read is a different thing to fix than one never set.
      const unreadable = deviceMeta(serial).pin && !devicePin(serial) && /No PIN is set/.test(error.message);
      const message = unreadable ? 'The PIN kept for this phone can no longer be read. Set it again in the device details.' : error.message;
      throw new Error(serials.length > 1 && device ? `${deviceLabel(device)}: ${message}` : message);
    }
  }
  return plans;
}

/** Run a workflow on each device. `values` fill the {1}, {2}… of its text steps. */
/** Run a workflow's steps on one phone, telling the timeline of each. Resolves with a short summary. */
async function runWorkflowSteps(device, steps, run, workflowName) {
  for (const [index, step] of steps.entries()) {
    // The timeline in the workflow view follows these events step by step. A secret step, such
    // as a key of the PIN, is shown without where it tapped.
    const entry = { run, name: workflowName, serial: device.serial, label: deviceLabel(device), index, total: steps.length, command: step.command, argument: step.secret ? '•••' : step.argument, note: step.note };
    const started = Date.now();
    send('timeline', { ...entry, status: 'running', at: started });
    try {
      const detail = await runWorkflowStep(device, step, workflowName);
      send('timeline', { ...entry, status: 'ok', at: started, ms: Date.now() - started, detail: step.secret ? '' : detail || '' });
    } catch (error) {
      send('timeline', { ...entry, status: 'error', at: started, ms: Date.now() - started, detail: error.message });
      throw new Error(`step ${index + 1} (${step.command}): ${error.message}`);
    }
  }
  return `${steps.length} step(s)`;
}

function runWorkflow({ name, text, serials, values }) {
  const plans = planWorkflow(text, values, serials);
  const workflowName = String(name || 'Workflow').trim() || 'Workflow';
  workflowRuns += 1;
  const run = workflowRuns;
  return runJob(`Workflow ${workflowName}`, serials, (device) => runWorkflowSteps(device, plans.get(device.serial), run, workflowName));
}

// Phones running a workflow of their own, for a withdrawal. Several run side by side; a fleet job
// waits for all of them, and none starts while a fleet job runs.
const soloRuns = new Set();

/** Run a workflow on one phone, apart from the fleet's one job at a time. Resolves as a fleet job does. */
async function runWorkflowOne({ name, text, serial, values }) {
  if (jobRunning) throw new Error(`Wait for "${jobRunning}" to finish first.`);
  if (soloRuns.has(serial)) throw new Error('That phone is already running a workflow.');
  const [device] = onlineDevices([serial]);
  if (!device) throw new Error(`${serial} is not online.`);
  const plans = planWorkflow(text, values, [serial]);
  const workflowName = String(name || 'Workflow').trim() || 'Workflow';
  workflowRuns += 1;
  const run = workflowRuns;
  soloRuns.add(serial);
  try {
    const detail = await runWorkflowSteps(device, plans.get(serial), run, workflowName);
    log(`Workflow ${workflowName} ok on ${deviceLabel(device)}: ${detail}`, 'info', serial);
    return { label: `Workflow ${workflowName}`, results: [{ serial, label: deviceLabel(device), ok: true, detail }], failed: 0 };
  } catch (error) {
    log(`Workflow ${workflowName} failed on ${deviceLabel(device)}: ${error.message}`, 'error', serial);
    return { label: `Workflow ${workflowName}`, results: [{ serial, label: deviceLabel(device), ok: false, detail: error.message }], failed: 1 };
  } finally {
    soloRuns.delete(serial);
  }
}

// ── web API ──────────────────────────────────────────────────────────────
// Lets another system, such as a job page on a website, run a saved workflow with its own values.
// Off until switched on in Settings. Every request needs the key, and the server listens on this
// computer only unless LAN access is switched on as well.

let apiServer = null;
let apiQueue = Promise.resolve();
let apiWaiting = 0;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function apiAuthorized(request) {
  const header = String(request.headers.authorization || '');
  const sent = header.startsWith('Bearer ') ? header.slice(7).trim() : String(request.headers['x-api-key'] || '');
  const key = store.config.api_token;
  if (!key || !sent) return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(sent), digest(key));
}

async function apiRoute(method, pathname, body) {
  if (method === 'GET' && pathname === '/api/status') {
    return {
      devices: [...devices.values()].filter((device) => device.status === 'device').map((device) => ({ serial: device.serial, name: deviceLabel(device) })),
      running: jobRunning,
      waiting: apiWaiting,
    };
  }
  if (method === 'GET' && pathname === '/api/workflows') {
    return Object.entries(store.state.workflows).map(([name, text]) => ({ name, inputs: logic.workflowInputs(logic.parseWorkflow(text)) }));
  }
  if (method !== 'POST' || pathname !== '/api/run') throw new ApiError(404, 'Unknown address. Use POST /api/run, GET /api/workflows or GET /api/status.');

  const name = String(body.workflow || '');
  const text = Object.hasOwn(store.state.workflows, name) ? store.state.workflows[name] : null;
  if (!text) throw new ApiError(404, `Workflow '${name}' is not saved in the app.`);
  let serials = Array.isArray(body.serials) ? body.serials : body.serial ? [body.serial] : null;
  if (!serials) {
    const online = [...devices.values()].filter((device) => device.status === 'device');
    if (online.length !== 1) throw new ApiError(400, `Send "serial": ${online.length} devices are online, so the app cannot pick one.`);
    serials = [online[0].serial];
  }
  // Check the values before queueing, so a bad job is refused at once.
  planWorkflow(text, body.values, serials);
  if (apiWaiting >= API_MAX_WAITING) throw new ApiError(429, 'Too many jobs are waiting.');

  // Web jobs run one after another, in the order they arrive.
  apiWaiting += 1;
  const job = apiQueue.then(() => {
    log(`Web job: workflow ${name}.`);
    return runWorkflow({ name, text, serials, values: body.values });
  });
  apiQueue = job.catch(() => {});
  try {
    const outcome = await job;
    return { ok: outcome.failed === 0, workflow: name, results: outcome.results };
  } catch (error) {
    throw new ApiError(error.message.startsWith('Wait for') ? 409 : 400, error.message);
  } finally {
    apiWaiting -= 1;
  }
}

function onApiRequest(request, response) {
  const reply = (status, data) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      // The key, not the origin, is what protects the API, so a web page may call it.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
    });
    response.end(status === 204 ? '' : JSON.stringify(data));
  };
  if (request.method === 'OPTIONS') {
    reply(204);
    return;
  }
  if (!apiAuthorized(request)) {
    reply(401, { ok: false, error: 'Missing or wrong API key.' });
    return;
  }
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > API_MAX_BODY) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', async () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new ApiError(400, 'The request body is not valid JSON.');
        }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'The request body must be a JSON object.');
      reply(200, await apiRoute(request.method, new URL(request.url, 'http://localhost').pathname, body));
    } catch (error) {
      reply(error.status || 400, { ok: false, error: error.message });
    }
  });
}

function startApi() {
  if (apiServer) {
    apiServer.close();
    apiServer.closeAllConnections();
    apiServer = null;
  }
  if (!store.config.api_enabled) return;
  if (!CONFIG_KEYS.api_token(store.config.api_token)) {
    store.config.api_token = crypto.randomBytes(24).toString('hex');
    store.saveConfig();
  }
  const host = store.config.api_lan ? '0.0.0.0' : '127.0.0.1';
  const port = CONFIG_KEYS.api_port(store.config.api_port);
  const server = http.createServer(onApiRequest);
  server.on('error', (error) => log(`Web API could not start on port ${port}: ${error.message}`, 'error'));
  server.listen(port, host, () => log(`Web API is listening on ${host}:${port}.`));
  apiServer = server;
}

// ── APK library ──────────────────────────────────────────────────────────

function apkLibraryDir() {
  const configured = String(store.config.apk_library_dir || '').trim();
  if (configured) {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  }
  return store.dir('apk-library');
}

function listApkLibrary() {
  const dir = apkLibraryDir();
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.apk'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, path: full, size: stat.size, modified: stat.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── updates ──────────────────────────────────────────────────────────────

let updateState = { status: 'idle' };
let updateChecking = false;

function updateView() {
  return { ...updateState, checkedAt: store.config.last_update_check || null };
}

function updateUrl() {
  try {
    return String(require(path.join(app.getAppPath(), 'package.json')).updateUrl || '');
  } catch {
    return '';
  }
}

async function runUpdateCheck() {
  // A downloaded update stays ready until the restart; do not download it again.
  if (updateState.status === 'updated' || updateChecking) return updateView();
  updateChecking = true;
  try {
    const result = await checkForUpdate({
      baseUrl: updateUrl(),
      currentVersion: VERSION,
      publicKey: fs.readFileSync(path.join(__dirname, 'update-public.pem'), 'utf8'),
      updatesDir: path.join(baseDir, 'installed-updates'),
    });
    updateState = result;
    // Only a completed check counts, so an offline machine tries again at the next poll.
    if (result.status === 'current' || result.status === 'updated') {
      store.config.last_update_check = Date.now();
      store.saveConfig();
    }
    if (result.status === 'updated') {
      log(`Update ${result.version} downloaded. Restart to use it.`);
      if (Notification.isSupported()) {
        new Notification({ title: APP_NAME, body: `อัปเดต ${result.version} พร้อมแล้ว ปิดแล้วเปิดโปรแกรมใหม่เพื่อใช้` }).show();
      }
    } else if (result.status === 'error') {
      log(`Update check failed: ${result.message}`, 'warning');
    }
    send('update', updateView());
    return updateView();
  } finally {
    updateChecking = false;
  }
}

/** Runs a check when 24 hours have passed since the last completed one. */
function checkUpdateIfDue() {
  const last = Number(store.config.last_update_check) || 0;
  if (Date.now() - last >= UPDATE_INTERVAL_MS) runUpdateCheck();
}

// ── IPC ──────────────────────────────────────────────────────────────────

const CONFIG_KEYS = {
  theme: (v) => (v === 'light' ? 'light' : 'dark'),
  device_view: (v) => (v === 'list' ? 'list' : 'cards'),
  auto_scan_enabled: Boolean,
  auto_scan_interval_seconds: (v) => Math.min(3600, Math.max(5, Number.parseInt(v, 10) || 15)),
  thumbnail_interval_seconds: (v) => Math.min(3600, Math.max(3, Number.parseInt(v, 10) || 8)),
  low_battery_percent: (v) => Math.min(100, Math.max(1, Number.parseInt(v, 10) || 20)),
  high_temp_c: (v) => Math.min(80, Math.max(25, Number.parseFloat(v) || 42)),
  scrcpy_profile: (v) => (logic.SCRCPY_PROFILES[v] ? v : 'Balanced'),
  node_name: (v) => String(v || '').trim().slice(0, 60) || os.hostname(),
  api_enabled: Boolean,
  api_lan: Boolean,
  api_port: (v) => Math.min(65535, Math.max(1024, Number.parseInt(v, 10) || API_DEFAULT_PORT)),
  api_token: (v) => (/^[a-f0-9]{32,64}$/.test(v) ? v : ''),
};

function publicState() {
  return {
    version: VERSION,
    update: updateView(),
    // Run each value through its normalizer so a missing key shows its default in Settings.
    config: Object.fromEntries(Object.entries(CONFIG_KEYS).map(([key, normalize]) => [key, normalize(store.config[key])])),
    tools: { adb: adb ? adb.adbPath : null, scrcpy: scrcpyPath },
    dataDir: baseDir,
    apkLibraryDir: apkLibraryDir(),
    devices: devicesSnapshot(),
    workflows: store.state.workflows,
    points: store.state.points,
    pickSets: store.state.pick_sets,
    jobs: jobs.view(),
    policies: store.state.policies,
    groupProfiles: store.state.group_live_profiles,
    profiles: logic.SCRCPY_PROFILES,
    logs,
  };
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await handler(payload || {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function registerIpc() {
  handle('state:get', () => publicState());
  handle('devices:scan', () => scan());

  handle('adb:restart', async () => {
    await requireAdb().restartServer();
    log('ADB server restarted.');
    await scan();
  });

  handle('config:set', (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (CONFIG_KEYS[key]) store.config[key] = CONFIG_KEYS[key](value);
    }
    store.saveConfig();
    scheduleAutoScan();
    if (Object.keys(patch).some((key) => key.startsWith('api_'))) startApi();
    return publicState().config;
  });

  handle('api:token', () => {
    store.config.api_token = crypto.randomBytes(24).toString('hex');
    store.saveConfig();
    log('Web API key replaced.');
    return publicState().config;
  });

  handle('tool:locate', async ({ tool }) => {
    if (tool !== 'adb' && tool !== 'scrcpy') throw new Error('Unknown tool.');
    const result = await dialog.showOpenDialog(win, {
      title: `Locate ${tool}`,
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
    });
    if (result.canceled || !result.filePaths.length) return publicState().tools;
    store.config[`${tool}_path`] = result.filePaths[0];
    store.saveConfig();
    loadTools();
    log(`${tool} path set to ${result.filePaths[0]}.`);
    return publicState().tools;
  });

  handle('device:meta', ({ serial, name, group, slot }) => {
    if (!devices.has(serial)) throw new Error('Select a device first.');
    store.state.devices[serial] = {
      ...deviceMeta(serial),
      name: String(name || '').trim().slice(0, 60),
      group: String(group || '').trim().slice(0, 40) || 'Default',
      slot: String(slot || '').trim().slice(0, 12),
    };
    store.saveState();
    log(`Saved details for ${serial}.`, 'info', serial);
    return devicesSnapshot();
  });

  // The amounts this phone may pay. A withdrawal outside every phone's range is left alone. Empty clears it.
  handle('device:range', ({ serial, min, max }) => {
    if (!devices.has(serial)) throw new Error('Select a device first.');
    const meta = { ...deviceMeta(serial) };
    if (String(min ?? '') === '' && String(max ?? '') === '') {
      delete meta.amount_min;
      delete meta.amount_max;
    } else {
      const low = Number(min);
      const high = Number(max);
      if (!(low > 0) || !(high >= low)) throw new Error('Enter the smallest and the largest amount, for example 100 and 499.');
      meta.amount_min = low;
      meta.amount_max = high;
    }
    store.state.devices[serial] = meta;
    store.saveState();
    log(meta.amount_min ? `${serial} pays withdrawals from ${meta.amount_min} to ${meta.amount_max}.` : `${serial} pays no withdrawals.`, 'info', serial);
    return devicesSnapshot();
  });

  // The account this phone pays from, its daily cap, what is left in it, and how slow the phone is.
  handle('device:account', ({ serial, bank, account, holder, cap, balance, scale }) => {
    if (!devices.has(serial)) throw new Error('Select a device first.');
    const digits = String(account || '').replace(/[\s-]/g, '');
    if (digits && !/^\d{6,20}$/.test(digits)) throw new Error('An account number is 6 to 20 digits.');
    const amount = (value, name) => {
      if (String(value ?? '').trim() === '') return undefined;
      const number = Number(value);
      if (!(number >= 0)) throw new Error(`${name} is an amount of money, or empty.`);
      return number;
    };
    const speed = String(scale ?? '').trim() === '' ? 1 : Number(scale);
    if (!(speed >= 0.5 && speed <= 5)) throw new Error('The wait multiplier is between 0.5 and 5.');
    const meta = { ...deviceMeta(serial), pay_bank: String(bank || '').trim().slice(0, 60), pay_account: digits, pay_holder: String(holder || '').trim().slice(0, 80), wait_scale: speed };
    for (const [key, value] of [['day_cap', amount(cap, 'The daily cap')], ['balance', amount(balance, 'The balance')]]) {
      if (value === undefined) delete meta[key];
      else meta[key] = value;
    }
    store.state.devices[serial] = meta;
    store.saveState();
    log(`Saved the paying account of ${serial}.`, 'info', serial);
    return devicesSnapshot();
  });

  // Whether this phone takes withdrawals at all. Off keeps its range but gives it no rows.
  handle('device:pay', async ({ serial, on }) => {
    if (!devices.has(serial)) throw new Error('Select a device first.');
    const keep = (value) => {
      store.state.devices[serial] = { ...deviceMeta(serial), pay_on: value };
      store.saveState();
      send('devices', devicesSnapshot());
    };
    const signedIn = await jobs.signedIn();
    // A phone is switched on only with the back office signed in: its account is switched on there too.
    if (on && !signedIn) throw new Error('Sign in to the back office first: a phone is switched on only while the back office is signed in.');
    keep(Boolean(on));
    log(`${serial} ${on ? 'takes' : 'no longer takes'} withdrawals.`, 'info', serial);
    // The phone's account stands the same way in the back office. Switched on, it is offered on the
    // close-job form; a phone whose account could not be switched on does not stay on.
    if (signedIn) {
      await jobs.switchAccount(payAccount(serial).account, Boolean(on)).catch((error) => {
        if (on) keep(false);
        throw error;
      });
    }
    return devicesSnapshot();
  });

  // Set or clear the PIN a `pin` step presses on this phone. An empty PIN clears it.
  handle('device:pin', ({ serial, pin }) => {
    if (!devices.has(serial)) throw new Error('Select a device first.');
    const value = String(pin || '');
    const meta = { ...deviceMeta(serial) };
    if (!value) {
      delete meta.pin;
    } else {
      if (!logic.isPin(value)) throw new Error('A PIN is 4 to 12 digits.');
      try {
        meta.pin = secret.protect(value);
      } catch (error) {
        throw new Error(`Windows could not keep the PIN, so it was not saved: ${error.message.split(/\r?\n/)[0]}`);
      }
    }
    store.state.devices[serial] = meta;
    store.saveState();
    log(value ? `Set the PIN for ${serial}.` : `Cleared the PIN for ${serial}.`, 'info', serial);
    return devicesSnapshot();
  });

  // The PIN kept for this phone, for the operator who pressed "show". That it was shown is logged; the PIN is not.
  handle('device:pin-show', ({ serial }) => {
    if (!devices.has(serial)) throw new Error('Select a device first.');
    const pin = devicePin(serial);
    if (!pin) throw new Error('The PIN kept for this phone cannot be read on this Windows account. Set it again.');
    log(`Showed the PIN for ${serial}.`, 'info', serial);
    return pin;
  });

  handle('device:group', ({ serials, group }) => {
    const name = String(group || '').trim().slice(0, 40) || 'Default';
    for (const serial of serials.filter((s) => devices.has(s))) {
      store.state.devices[serial] = { ...deviceMeta(serial), group: name };
    }
    store.saveState();
    return devicesSnapshot();
  });

  handle('device:action', ({ serials, action, arg }) => {
    const run = ACTIONS[action];
    if (!run) throw new Error(`Unknown action '${action}'.`);
    const label = action === 'key' ? String(arg) : action;
    return runJob(label, serials, (device) => run(device.serial, arg));
  });

  handle('thumbs:refresh', ({ serials }) => refreshThumbnails(serials));

  handle('live:open', async ({ serials, profile }) => {
    const results = [];
    for (const device of onlineDevices(serials)) {
      try {
        const detail = await openLive(device, profile);
        log(`Opened live control for ${deviceLabel(device)} (${detail}).`, 'info', device.serial);
        results.push({ serial: device.serial, ok: true });
      } catch (error) {
        log(`Live control failed for ${deviceLabel(device)}: ${error.message}`, 'error', device.serial);
        results.push({ serial: device.serial, ok: false, detail: error.message });
      }
    }
    if (!results.length) throw new Error('Select one or more online devices first.');
    const opened = results.filter((r) => r.ok).map((r) => r.serial);
    if (opened.length) {
      store.config.last_live_serials = opened;
      store.saveConfig();
    }
    send('devices', { devices: devicesSnapshot() });
    return { results, failed: results.filter((r) => !r.ok).length };
  });

  handle('live:close', ({ serials, all }) => closeLive(all ? [...liveProcesses.keys()] : serials));

  handle('live:default', ({ scope, serials, profile }) => {
    const { profileName } = profileFor(profile);
    for (const serial of serials.filter((s) => devices.has(s))) {
      if (scope === 'group') store.state.group_live_profiles[deviceMeta(serial).group || 'Default'] = profileName;
      else store.state.devices[serial] = { ...deviceMeta(serial), live_profile: profileName };
    }
    store.saveState();
    return { devices: devicesSnapshot(), groupProfiles: store.state.group_live_profiles };
  });

  handle('apps:list', async ({ serial, system }) => {
    const [device] = onlineDevices([serial]);
    if (!device) throw new Error('Select an online device first.');
    return requireAdb().listPackages(serial, Boolean(system));
  });

  handle('apps:info', async ({ serial, pkg }) => {
    const [device] = onlineDevices([serial]);
    if (!device) throw new Error('Select an online device first.');
    return requireAdb().packageInfo(serial, requirePackage(pkg));
  });

  handle('apk:library', () => ({ dir: apkLibraryDir(), items: listApkLibrary() }));

  handle('apk:choose', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose APK',
      properties: ['openFile'],
      filters: [{ name: 'Android packages', extensions: ['apk'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('policy:detect', async ({ serial }) => {
    const [device] = onlineDevices([serial]);
    if (!device) throw new Error('Select an online device first.');
    return requireAdb().currentPackage(serial);
  });

  handle('policy:save', ({ pkg, mode, allow_capture, notes }) => {
    store.state.policies[requirePackage(pkg)] = logic.normalizePolicy({ mode, allow_capture, notes });
    store.saveState();
    log(`Saved policy for ${pkg}: ${mode}.`);
    return store.state.policies;
  });

  handle('policy:delete', ({ pkg }) => {
    delete store.state.policies[pkg];
    store.saveState();
    log(`Cleared policy for ${pkg}.`);
    return store.state.policies;
  });

  handle('workflow:save', ({ name, text }) => {
    const workflowName = String(name || '').trim().slice(0, 60);
    if (!workflowName) throw new Error('Enter a workflow name.');
    logic.parseWorkflow(text);
    store.state.workflows[workflowName] = `${String(text).trim()}\n`;
    store.saveState();
    log(`Saved workflow ${workflowName}.`);
    return store.state.workflows;
  });

  handle('workflow:delete', ({ name }) => {
    delete store.state.workflows[name];
    store.saveState();
    log(`Deleted workflow ${name}.`);
    return store.state.workflows;
  });

  handle('workflow:preview', ({ text }) => logic.parseWorkflow(text));

  handle('workflow:run', (request) => runWorkflow(request));

  // Record what the user presses on the phone itself: follow its raw input events until stopped.
  handle('touch:start', async ({ serial, fromHome }) => {
    const [device] = onlineDevices([serial]);
    if (!device) throw new Error('Select an online device first.');
    if (touchRecorders.has(serial)) return true;
    const client = requireAdb();
    // A recording that starts on the home screen replays from the same place every time.
    if (fromHome) {
      await guard(serial, 'Record');
      await client.keyevent(serial, logic.KEY_ALIASES.wake);
      await client.keyevent(serial, logic.KEY_ALIASES.home);
    }
    const touchDevices = logic.parseTouchDevices(await client.text(['shell', 'getevent', '-lp'], { serial, timeout: 8000 }));
    if (!touchDevices.length) throw new Error('This device does not report its touchscreen to ADB.');
    const recorder = new logic.TouchRecorder(touchDevices);
    const child = childProcess.spawn(client.adbPath, ['-s', serial, 'shell', 'getevent', '-lt'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    touchRecorders.set(serial, child);
    let pending = '';
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk.toString('utf8')).split(/\r?\n/);
      pending = lines.pop();
      const steps = lines.flatMap((line) => recorder.push(line));
      if (steps.length) send('touch', { serial, steps });
    });
    const stopped = () => {
      if (touchRecorders.get(serial) !== child) return;
      touchRecorders.delete(serial);
      send('touch', { serial, stopped: true });
    };
    child.once('exit', stopped);
    child.once('error', (error) => {
      log(`Unable to record touches: ${error.message}`, 'error', serial);
      stopped();
    });
    log(`Recording touches on ${deviceLabel(device)}.`, 'info', serial);
    return true;
  });

  handle('touch:stop', ({ serial }) => {
    const child = touchRecorders.get(serial);
    if (child) child.kill();
    return Boolean(child);
  });

  // Named screen positions the workflow builder can drop into a tap step.
  handle('point:save', ({ name, value }) => {
    const pointName = String(name || '').trim().slice(0, 40);
    if (!pointName) throw new Error('Enter a name for the position.');
    const position = String(value || '').trim();
    if (!logic.parseGesture('tap', position)) throw new Error("A position is X and Y, for example '540 960' or '50% 30%'.");
    store.state.points[pointName] = position;
    store.saveState();
    log(`Saved position ${pointName} (${position}).`);
    return store.state.points;
  });

  handle('point:delete', ({ name }) => {
    delete store.state.points[name];
    store.saveState();
    log(`Deleted position ${name}.`);
    return store.state.points;
  });

  // Position sets: one list on the phone, with where each name in it is. A `pick` step taps by name.
  const pickSetName = (name) => {
    const setName = String(name || '').trim();
    if (!/^\S{1,40}$/.test(setName)) throw new Error('A position set needs a name of at most 40 characters, with no spaces.');
    return setName;
  };

  handle('pick:save', ({ set, name, page, at }) => {
    const setName = pickSetName(set);
    const current = logic.normalizePickSet(store.state.pick_sets[setName]);
    // Saving with no name makes the empty set.
    if (name !== undefined) {
      const itemName = String(name || '').trim().slice(0, 60);
      if (!itemName) throw new Error('Enter a name for the position.');
      const position = String(at || '').trim();
      if (!logic.parseGesture('tap', position)) throw new Error("A position is X and Y, for example '50% 30%'.");
      // Taking a position again keeps the name's other spellings.
      current.items[itemName] = { ...current.items[itemName], page: Number(page) || 0, at: position };
      log(`Position set ${setName}: saved ${itemName} (page ${Number(page) || 0}, ${position}).`);
    }
    store.state.pick_sets[setName] = logic.normalizePickSet(current);
    store.saveState();
    return store.state.pick_sets;
  });

  // Change a position's name and the other spellings that mean it.
  handle('pick:edit', ({ set, name, newName, also }) => {
    const current = logic.normalizePickSet(store.state.pick_sets[set]);
    const item = current.items[name];
    if (!item) throw new Error('That position is no longer in the set.');
    const itemName = String(newName || '').trim().slice(0, 60);
    if (!itemName) throw new Error('Enter a name for the position.');
    if (itemName !== name && current.items[itemName]) throw new Error(`The set already has a position named '${itemName}'.`);
    delete current.items[name];
    current.items[itemName] = { ...item, also: Array.isArray(also) ? also : item.also };
    store.state.pick_sets[set] = logic.normalizePickSet(current);
    store.saveState();
    log(`Position set ${set}: ${name} is now ${itemName}${current.items[itemName].also.length ? `, also ${current.items[itemName].also.join(', ')}` : ''}.`);
    return store.state.pick_sets;
  });

  // Rename a set, and the pick steps of saved workflows that use it, so they keep working.
  handle('pick:rename', ({ set, newName }) => {
    const setName = pickSetName(newName);
    if (!store.state.pick_sets[set]) throw new Error('That position set is no longer saved.');
    if (setName === set) return { sets: store.state.pick_sets, workflows: store.state.workflows };
    if (store.state.pick_sets[setName]) throw new Error(`There is already a position set named '${setName}'.`);
    store.state.pick_sets[setName] = store.state.pick_sets[set];
    delete store.state.pick_sets[set];
    let changed = 0;
    for (const [name, text] of Object.entries(store.state.workflows)) {
      const next = String(text).split(/\r?\n/).map((line) => {
        const pick = /^\s*pick\s/i.test(line) ? logic.parsePick(line.trim().slice(5)) : null;
        return pick && pick.set === set ? `pick ${setName} ${pick.name}` : line;
      }).join('\n');
      if (next !== text) {
        store.state.workflows[name] = next;
        changed += 1;
      }
    }
    store.saveState();
    log(`Renamed position set ${set} to ${setName}; ${changed} saved workflow(s) updated.`);
    return { sets: store.state.pick_sets, workflows: store.state.workflows };
  });

  handle('pick:delete', ({ set, name }) => {
    if (name === undefined) delete store.state.pick_sets[set];
    else if (store.state.pick_sets[set]) delete store.state.pick_sets[set].items[name];
    store.saveState();
    log(name === undefined ? `Deleted position set ${set}.` : `Position set ${set}: deleted ${name}.`);
    return store.state.pick_sets;
  });

  handle('pick:scroll', ({ set, value }) => {
    const setName = pickSetName(set);
    const scroll = String(value || '').trim();
    if (!logic.parseGesture('swipe', scroll)) throw new Error("A scroll is a swipe, for example '50% 70% 50% 35% 1500'.");
    store.state.pick_sets[setName] = { ...logic.normalizePickSet(store.state.pick_sets[setName]), scroll };
    store.saveState();
    return store.state.pick_sets;
  });

  // Scroll the phone's list to a page of the set, the way a run does, so positions can be taken there.
  handle('pick:goto', async ({ serial, set, page }) => {
    const [device] = onlineDevices([serial]);
    if (!device) throw new Error('Select an online device first.');
    const { scroll } = logic.normalizePickSet(store.state.pick_sets[set]);
    for (let turn = 0; turn < (Number(page) || 0); turn += 1) {
      await runWorkflowStep(device, { command: 'swipe', argument: scroll }, 'Position set');
      await sleep(700);
    }
    return true;
  });

  // The recorder: optionally perform one tap or swipe on a single device, then return its screen.
  handle('workflow:record', async ({ serial, step }) => {
    const [device] = onlineDevices([serial]);
    if (!device) throw new Error('Select an online device first.');
    if (step) {
      if (jobRunning) throw new Error(`Wait for "${jobRunning}" to finish first.`);
      const [gesture] = logic.parseWorkflow(step);
      if (gesture.command !== 'tap' && gesture.command !== 'swipe') throw new Error('Only tap and swipe can be recorded.');
      await runWorkflowStep(device, gesture, 'Record');
      await sleep(RECORD_SETTLE_MS);
    }
    await guard(serial, 'Record', { allowManualOnly: true, requireCapture: true });
    const image = nativeImage.createFromBuffer(await requireAdb().screenshot(serial));
    if (image.isEmpty()) throw new Error('Device returned an empty image.');
    const jpeg = image.resize({ width: RECORD_WIDTH, quality: 'good' }).toJPEG(80);
    // The full-size picture is in the same pixel space `input tap` uses.
    return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, ...image.getSize() };
  });

  handle('jobs:set', (patch) => jobs.save(patch));
  handle('jobs:open', () => jobs.open());
  handle('jobs:pick', ({ field }) => jobs.pick(field));
  handle('jobs:record', ({ on, field }) => jobs.record(Boolean(on), field));
  handle('jobs:clear', ({ field }) => jobs.clear(field));
  handle('jobs:read', () => jobs.read());
  handle('jobs:run', () => jobs.runOnce());
  handle('jobs:auto', ({ on }) => jobs.setAuto(Boolean(on)));
  handle('jobs:screen', () => jobs.screen());
  handle('jobs:orders', () => jobs.refreshOrders());
  handle('jobs:pay', ({ key }) => jobs.pay(String(key || '')));
  handle('jobs:payauto', ({ on }) => jobs.setPayAuto(Boolean(on)));
  handle('jobs:unhalt', (request) => jobs.unhalt(request && request.serial ? String(request.serial) : ''));
  handle('jobs:resolve', ({ key, note }) => jobs.resolve(String(key || ''), note));

  handle('update:check', () => runUpdateCheck());

  handle('update:restart', () => {
    if (jobRunning) throw new Error(`Wait for "${jobRunning}" to finish first.`);
    app.relaunch();
    app.exit(0);
  });

  handle('folder:open', async ({ which }) => {
    const folders = { data: baseDir, captures: store.dir('captures'), apk: apkLibraryDir() };
    if (!folders[which]) throw new Error('Unknown folder.');
    const failure = await shell.openPath(folders[which]);
    if (failure) throw new Error(failure);
  });
}

// ── window ───────────────────────────────────────────────────────────────

function ensureDefaults() {
  let changed = false;
  if (!Object.keys(store.state.workflows).length) {
    store.state.workflows['Wake Home'] = 'wake\nwait 500\nhome\n';
    store.state.workflows['Settings Screenshot'] = 'open com.android.settings\nwait 1000\nscreenshot\n';
    store.saveState();
  }
  if (!store.config.node_name) {
    store.config.node_name = os.hostname();
    changed = true;
  }
  if (changed) store.saveConfig();
}

function createWindow() {
  const dark = store.config.theme !== 'light';
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    title: APP_NAME,
    backgroundColor: dark ? '#0a0d16' : '#f3f4f8',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  // The back-office window belongs to this one: closing the app closes it too.
  win.on('closed', () => jobs.close());
  // The UI is local files only: never navigate away or open new windows from the renderer.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The theme rides in the query so the first paint already has the right colors.
  win.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: { theme: dark ? 'dark' : 'light' } });
  win.webContents.once('did-finish-load', () => {
    if (adb) scan();
    else log('ADB was not found. Set its location in Settings.', 'error');
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    ensureDefaults();
    loadTools();
    registerIpc();
    startApi();
    createWindow();
    checkUpdateIfDue();
    setInterval(checkUpdateIfDue, UPDATE_POLL_MS);
  });
  // The back-office window only hides when it is closed, so it is closed for good before a quit.
  app.on('before-quit', () => jobs.close());
  app.on('window-all-closed', () => {
    clearTimeout(autoScanTimer);
    closeLive([...liveProcesses.keys()]);
    for (const child of touchRecorders.values()) child.kill();
    if (apiServer) apiServer.close();
    jobs.close();
    app.quit();
  });
}
