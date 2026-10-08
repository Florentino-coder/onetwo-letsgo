'use strict';

// Pure parsing and rule logic. No Electron, no child processes, so it runs under `node --test`.

const KEY_ALIASES = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recent: 'KEYCODE_APP_SWITCH',
  wake: 'KEYCODE_WAKEUP',
  sleep: 'KEYCODE_SLEEP',
};
const WORKFLOW_COMMANDS = new Set(['wait', 'keyevent', 'open', 'text', 'screenshot', ...Object.keys(KEY_ALIASES)]);
const SCRCPY_PROFILES = {
  'Low bandwidth': { max_size: 720, max_fps: 15, bit_rate: '1M' },
  Balanced: { max_size: 1024, max_fps: 30, bit_rate: '2M' },
  Quality: { max_size: 1280, max_fps: 60, bit_rate: '4M' },
};
const POLICY_MODES = ['assisted', 'manual_only', 'blocked'];

const SERIAL_RE = /^[A-Za-z0-9._:-]+$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const KEYEVENT_RE = /^(KEYCODE_[A-Z0-9_]+|\d{1,3})$/;

function isSerial(value) {
  return typeof value === 'string' && SERIAL_RE.test(value);
}

function isPackage(value) {
  return typeof value === 'string' && PACKAGE_RE.test(value);
}

function isKeyevent(value) {
  return typeof value === 'string' && KEYEVENT_RE.test(value);
}

function extractField(parts, name) {
  const prefix = `${name}:`;
  const hit = parts.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

function parseDevices(output) {
  const devices = [];
  for (const rawLine of String(output).split(/\r?\n/)) {
    const raw = rawLine.trim();
    // Skip the header and the "* daemon started" chatter adb prints on a cold start.
    if (!raw || raw.startsWith('*') || raw.startsWith('List of devices')) continue;
    const parts = raw.split(/\s+/);
    if (!isSerial(parts[0])) continue;
    devices.push({
      serial: parts[0],
      status: parts[1] || 'unknown',
      product: extractField(parts, 'product'),
      model: extractField(parts, 'model').replace(/_/g, ' '),
    });
  }
  return devices;
}

function parseBattery(output) {
  const data = {};
  let status = '';
  for (const raw of String(output).split(/\r?\n/)) {
    const index = raw.indexOf(':');
    if (index < 0) continue;
    const key = raw.slice(0, index).trim().toLowerCase();
    const value = raw.slice(index + 1).trim();
    if (key === 'level') data.level = `${value}%`;
    else if (key === 'status') status = value;
    else if (key === 'temperature') {
      const tenths = Number.parseInt(value, 10);
      data.temperature = Number.isNaN(tenths) ? value : `${(tenths / 10).toFixed(1)}C`;
    }
  }
  // BatteryManager: 2 = charging, 5 = full.
  data.charging = status === '2' || status === '5' ? 'yes' : 'no';
  return data;
}

function extractCurrentPackage(output) {
  const markers = ['mCurrentFocus', 'mFocusedApp', 'topResumedActivity', 'ResumedActivity'];
  for (const line of String(output).split(/\r?\n/)) {
    if (!markers.some((marker) => line.includes(marker))) continue;
    const match = line.match(/\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\//);
    if (match) return match[1];
  }
  return '';
}

function parsePackages(output) {
  const packages = new Set();
  for (const raw of String(output).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('package:')) line = line.slice('package:'.length);
    if (line.includes('=')) line = line.slice(line.lastIndexOf('=') + 1);
    if (line) packages.add(line);
  }
  return [...packages].sort();
}

function parsePackageInfo(output) {
  const fields = {
    version_name: '', version_code: '', target_sdk: '',
    first_install: '', last_update: '', installer: '',
  };
  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('versionName=')) fields.version_name = line.slice('versionName='.length);
    else if (line.startsWith('versionCode=')) {
      fields.version_code = (line.match(/versionCode=(\S+)/) || [])[1] || '';
      fields.target_sdk = (line.match(/targetSdk=(\S+)/) || [])[1] || '';
    } else if (line.startsWith('firstInstallTime=')) fields.first_install = line.slice('firstInstallTime='.length);
    else if (line.startsWith('lastUpdateTime=')) fields.last_update = line.slice('lastUpdateTime='.length);
    else if (line.startsWith('installerPackageName=')) fields.installer = line.slice('installerPackageName='.length);
  }
  return fields;
}

function parsePercent(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : null;
}

function parseTemperature(value) {
  const cleaned = String(value || '').replace(/c/gi, '').trim();
  if (!cleaned) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * `adb shell` joins its arguments and hands them to the device shell, so the text has to be
 * quoted for that shell. `input text` itself reads %s as a space.
 */
function quoteInputText(value) {
  const spaced = String(value).replace(/ /g, '%s');
  return `'${spaced.replace(/'/g, `'\\''`)}'`;
}

function parseWorkflow(text) {
  const steps = [];
  String(text).split(/\r?\n/).forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const space = line.indexOf(' ');
    const command = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const argument = space < 0 ? '' : line.slice(space + 1).trim();
    if (!WORKFLOW_COMMANDS.has(command)) throw new Error(`Line ${lineNo}: unknown command '${command}'.`);
    if (command === 'wait') {
      if (!/^\d+$/.test(argument)) throw new Error(`Line ${lineNo}: wait expects milliseconds, for example 'wait 500'.`);
    } else if (command === 'keyevent') {
      if (!isKeyevent(argument)) throw new Error(`Line ${lineNo}: keyevent expects a key such as KEYCODE_ENTER.`);
    } else if (command === 'open') {
      if (!isPackage(argument)) throw new Error(`Line ${lineNo}: open expects a package name such as com.android.settings.`);
    } else if (command === 'text') {
      if (!argument) throw new Error(`Line ${lineNo}: text expects an argument.`);
    } else if (argument) {
      throw new Error(`Line ${lineNo}: ${command} does not take an argument.`);
    }
    steps.push({ lineNo, command, argument });
  });
  if (!steps.length) throw new Error('Workflow is empty.');
  return steps;
}

function normalizePolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: POLICY_MODES.includes(source.mode) ? source.mode : 'assisted',
    allow_capture: source.allow_capture !== false,
    notes: typeof source.notes === 'string' ? source.notes : '',
  };
}

/** Throws when the policy for `pkg` forbids the action. */
function checkPolicy(rawPolicy, { actionName, pkg, allowManualOnly = false, requireCapture = false }) {
  const policy = normalizePolicy(rawPolicy);
  if (requireCapture && !policy.allow_capture) {
    throw new Error(`Policy blocks screenshots/thumbnails for ${pkg}.`);
  }
  if (policy.mode === 'blocked') {
    throw new Error(`Policy blocks ${actionName} while ${pkg} is active.`);
  }
  if (policy.mode === 'manual_only' && !allowManualOnly) {
    throw new Error(`Policy marks ${pkg} as manual-only; use live manual control instead of ADB automation.`);
  }
}

function scrcpyArgs(serial, title, profile) {
  return [
    '-s', serial,
    '--window-title', title,
    '--max-size', String(profile.max_size),
    '--max-fps', String(profile.max_fps),
    '--video-bit-rate', String(profile.bit_rate),
  ];
}

/** Run `worker` over `items` with at most `limit` in flight. Resolves with results in input order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

module.exports = {
  KEY_ALIASES,
  SCRCPY_PROFILES,
  POLICY_MODES,
  isSerial,
  isPackage,
  isKeyevent,
  parseDevices,
  parseBattery,
  extractCurrentPackage,
  parsePackages,
  parsePackageInfo,
  parsePercent,
  parseTemperature,
  quoteInputText,
  parseWorkflow,
  normalizePolicy,
  checkPolicy,
  scrcpyArgs,
  mapLimit,
};
