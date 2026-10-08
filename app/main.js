'use strict';

const { app, BrowserWindow, Notification, ipcMain, dialog, shell, nativeImage } = require('electron');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AdbClient } = require('./core/adb');
const { Store } = require('./core/store');
const logic = require('./core/logic');
const { checkForUpdate } = require('./updater');

const APP_NAME = 'Farm Manager';
const DEVICE_PARALLELISM = 4;
const THUMBNAIL_WIDTH = 300;
const LOG_MEMORY = 500;

const UPDATE_INTERVAL_MS = 24 * 3600000;
const UPDATE_POLL_MS = 3600000;
// boot.js sets both; the fallbacks cover running main.js directly.
const VERSION = process.env.FARM_VERSION || app.getVersion();
const baseDir = process.env.FARM_DATA_DIR
  || (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
const store = new Store(baseDir);

let win = null;
let adb = null;
let scrcpyPath = null;
let devices = new Map();
let scanning = false;
let jobRunning = null;
let autoScanTimer = null;
const liveProcesses = new Map();
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
      await sleep(Number(step.argument));
      return;
    case 'keyevent':
      await guard(serial, workflowName);
      await requireAdb().keyevent(serial, step.argument);
      return;
    case 'open':
      await guard(serial, workflowName, { pkg: step.argument, allowManualOnly: true });
      await requireAdb().openPackage(serial, step.argument);
      return;
    case 'text':
      await guard(serial, workflowName);
      await requireAdb().inputText(serial, step.argument);
      return;
    case 'screenshot':
      await guard(serial, workflowName, { allowManualOnly: true, requireCapture: true });
      await captureToFile(serial);
      return;
    default:
      await guard(serial, workflowName);
      await requireAdb().keyevent(serial, logic.KEY_ALIASES[step.command]);
  }
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

  handle('workflow:run', ({ name, text, serials }) => {
    const steps = logic.parseWorkflow(text);
    const workflowName = String(name || 'Workflow').trim() || 'Workflow';
    return runJob(`Workflow ${workflowName}`, serials, async (device) => {
      for (const step of steps) {
        try {
          await runWorkflowStep(device, step, workflowName);
        } catch (error) {
          throw new Error(`line ${step.lineNo} (${step.command}): ${error.message}`);
        }
      }
      return `${steps.length} step(s)`;
    });
  });

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
    createWindow();
    checkUpdateIfDue();
    setInterval(checkUpdateIfDue, UPDATE_POLL_MS);
  });
  app.on('window-all-closed', () => {
    clearTimeout(autoScanTimer);
    closeLive([...liveProcesses.keys()]);
    app.quit();
  });
}
