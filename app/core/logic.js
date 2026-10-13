'use strict';

// Pure parsing and rule logic. No Electron, no child processes, so it runs under `node --test`.

const KEY_ALIASES = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recent: 'KEYCODE_APP_SWITCH',
  wake: 'KEYCODE_WAKEUP',
  sleep: 'KEYCODE_SLEEP',
};
const WORKFLOW_COMMANDS = new Set(['wait', 'keyevent', 'open', 'text', 'screenshot', 'tap', 'swipe', 'run', 'pick', 'pin', 'close', 'taptext', 'taptext?', 'scrolltap', 'waittext', 'checktext', 'checkamount', 'stoptext', ...Object.keys(KEY_ALIASES)]);
// Steps that read the phone's screen for words or values.
const SCREEN_COMMANDS = ['taptext', 'taptext?', 'scrolltap', 'waittext', 'checktext', 'checkamount', 'stoptext'];
// Steps whose argument may hold {1}, {2}… of a job.
const FILLED_COMMANDS = ['text', 'run', 'pick', ...SCREEN_COMMANDS];
const DEFAULT_SWIPE_MS = 300;
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

/**
 * Tap and swipe positions are percentages of the screen, so one workflow fits phones of any
 * resolution: `tap 50% 30%` or `swipe 50% 80% 50% 20% 300` (the last number is milliseconds).
 * Plain numbers are exact pixels instead: `tap 540 960`. One step cannot mix the two.
 * Returns null when the argument is not valid.
 */
function parseGesture(command, argument) {
  const parts = String(argument).split(/\s+/).filter(Boolean);
  const count = command === 'tap' ? 2 : 4;
  const raw = parts.slice(0, count);
  const pixel = raw.every((part) => /^\d{1,5}$/.test(part));
  if (raw.length !== count || (!pixel && !raw.every((part) => /^\d{1,3}(\.\d+)?%$/.test(part)))) return null;
  const points = raw.map((part) => Number.parseFloat(part));
  if (!pixel && points.some((value) => value > 100)) return null;
  const rest = parts.slice(count);
  if (command === 'tap') return rest.length ? null : { points, pixel };
  if (rest.length > 1 || (rest.length && !/^\d{1,5}$/.test(rest[0]))) return null;
  return { points, pixel, duration: rest.length ? Number(rest[0]) : DEFAULT_SWIPE_MS };
}

/** Turn gesture percentages into pixels: even entries are x, odd entries are y. */
function gesturePixels(points, size) {
  return points.map((value, index) => {
    const span = index % 2 ? size.height : size.width;
    return Math.min(span - 1, Math.round((value / 100) * span));
  });
}

/** Reads `dumpsys window displays` (follows rotation) or `wm size`. */
function parseScreenSize(output) {
  const text = String(output);
  const match = text.match(/\bcur=(\d+)x(\d+)/) || text.match(/Override size:\s*(\d+)x(\d+)/) || text.match(/Physical size:\s*(\d+)x(\d+)/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** Touchscreens in `getevent -lp` output: the input devices that report ABS_MT_POSITION_X and _Y. */
function parseTouchDevices(output) {
  const found = [];
  let current = null;
  for (const line of String(output).split(/\r?\n/)) {
    const added = line.match(/^add device \d+:\s*(\S+)/);
    if (added) {
      current = { path: added[1], maxX: 0, maxY: 0 };
      found.push(current);
      continue;
    }
    const axis = line.match(/ABS_MT_POSITION_([XY])\s*:.*\bmax (\d+)/);
    if (axis && current) current[axis[1] === 'X' ? 'maxX' : 'maxY'] = Number(axis[2]);
  }
  return found.filter((device) => device.maxX > 0 && device.maxY > 0);
}

const RECORDED_KEYS = {
  KEY_POWER: 'keyevent KEYCODE_POWER',
  KEY_VOLUMEUP: 'keyevent KEYCODE_VOLUME_UP',
  KEY_VOLUMEDOWN: 'keyevent KEYCODE_VOLUME_DOWN',
  KEY_BACK: 'back',
  KEY_HOMEPAGE: 'home',
  KEY_APPSELECT: 'recent',
};
const TAP_SLOP_PERCENT = 3;
const LONG_PRESS_MS = 500;

/**
 * Turns `getevent -lt` lines into workflow lines as the user touches the phone. Every finger
 * is followed on its own, so fast two-thumb typing keeps each key. A press held in place becomes
 * a swipe that does not move, which Android treats as a long press. Coordinates are the panel's
 * own, so recording assumes portrait.
 */
class TouchRecorder {
  constructor(touchDevices) {
    this.devices = new Map(touchDevices.map((device) => [device.path, device]));
    this.slot = 0;
    this.fingers = new Map();
    this.lastEnd = null;
  }

  finger(slot) {
    if (!this.fingers.has(slot)) this.fingers.set(slot, { x: null, y: null, down: null, pressed: false, released: false });
    return this.fingers.get(slot);
  }

  /** Feed one output line. Returns the workflow lines it completed, usually none. */
  push(line) {
    const match = String(line).match(/^\[\s*(\d+\.\d+)\]\s+(\S+):\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (!match) return [];
    const [, stamp, path, type, code, value] = match;
    const at = Number(stamp) * 1000;
    if (type === 'EV_KEY' && value === 'DOWN' && RECORDED_KEYS[code]) return this.emit(RECORDED_KEYS[code], at, at);
    const device = this.devices.get(path);
    if (!device) return [];
    const finger = this.finger(this.slot);
    if (code === 'ABS_MT_SLOT') this.slot = Number.parseInt(value, 16);
    else if (code === 'SYN_REPORT') return [...this.fingers.values()].flatMap((each) => this.report(each, device, at));
    else if (code === 'ABS_MT_POSITION_X') finger.x = Number.parseInt(value, 16);
    else if (code === 'ABS_MT_POSITION_Y') finger.y = Number.parseInt(value, 16);
    else if (code === 'ABS_MT_TRACKING_ID') finger[value === 'ffffffff' ? 'released' : 'pressed'] = true;
    return [];
  }

  report(finger, device, at) {
    const { pressed, released } = finger;
    finger.pressed = false;
    finger.released = false;
    if (finger.x === null || finger.y === null) return [];
    const point = { x: (finger.x / device.maxX) * 100, y: (finger.y / device.maxY) * 100, at };
    if (pressed && !finger.down) finger.down = point;
    if (!released || !finger.down) return [];
    const from = finger.down;
    finger.down = null;
    const percent = (value) => `${Math.round(Math.min(100, Math.max(0, value)) * 10) / 10}%`;
    const start = `${percent(from.x)} ${percent(from.y)}`;
    const held = Math.round(point.at - from.at);
    if (Math.hypot(point.x - from.x, point.y - from.y) > TAP_SLOP_PERCENT) {
      return this.emit(`swipe ${start} ${percent(point.x)} ${percent(point.y)} ${Math.min(5000, Math.max(100, held))}`, from.at, point.at);
    }
    return this.emit(held >= LONG_PRESS_MS ? `swipe ${start} ${start} ${Math.min(5000, held)}` : `tap ${start}`, from.at, point.at);
  }

  /** Put the pause the user took in front of the step, so replay keeps their pace. */
  emit(step, startedAt, endedAt) {
    const lines = [];
    if (this.lastEnd !== null) {
      const pause = Math.round((startedAt - this.lastEnd) / 100) * 100;
      lines.push(`wait ${Math.min(30000, Math.max(100, pause))}`);
    }
    this.lastEnd = endedAt;
    lines.push(step);
    return lines;
  }
}

function parseWorkflow(text) {
  const steps = [];
  // A comment line is the note of the step that follows it.
  let note = '';
  String(text).split(/\r?\n/).forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      note = line.slice(1).trim();
      return;
    }
    const space = line.indexOf(' ');
    const command = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const argument = space < 0 ? '' : line.slice(space + 1).trim();
    if (!WORKFLOW_COMMANDS.has(command)) throw new Error(`Line ${lineNo}: unknown command '${command}'.`);
    if (command === 'wait') {
      if (!/^\d+$/.test(argument)) throw new Error(`Line ${lineNo}: wait expects milliseconds, for example 'wait 500'.`);
    } else if (command === 'keyevent') {
      if (!isKeyevent(argument)) throw new Error(`Line ${lineNo}: keyevent expects a key such as KEYCODE_ENTER.`);
    } else if (command === 'open' || command === 'close') {
      if (!isPackage(argument)) throw new Error(`Line ${lineNo}: ${command} expects a package name such as com.android.settings.`);
    } else if (command === 'text') {
      if (!argument) throw new Error(`Line ${lineNo}: text expects an argument.`);
    } else if (SCREEN_COMMANDS.includes(command)) {
      if (!argument) throw new Error(`Line ${lineNo}: ${command} expects the words to look for, for example '${command} โอนเงิน'.`);
    } else if (command === 'run') {
      if (!argument) throw new Error(`Line ${lineNo}: run expects the name of a saved workflow, for example 'run bank-{3}'.`);
    } else if (command === 'pin') {
      if (!parsePin(argument)) throw new Error(`Line ${lineNo}: pin expects the keypad's position set, for example 'pin keypad'.`);
    } else if (command === 'pick') {
      if (!parsePick(argument)) throw new Error(`Line ${lineNo}: pick expects a position set and a name, for example 'pick banks {3}'.`);
    } else if (command === 'tap') {
      if (!parseGesture(command, argument)) throw new Error(`Line ${lineNo}: tap expects a position, for example 'tap 50% 30%' or 'tap 540 960'.`);
    } else if (command === 'swipe') {
      if (!parseGesture(command, argument)) throw new Error(`Line ${lineNo}: swipe expects two positions, for example 'swipe 50% 80% 50% 20%'.`);
    } else if (argument) {
      throw new Error(`Line ${lineNo}: ${command} does not take an argument.`);
    }
    steps.push({ lineNo, command, argument, note });
    note = '';
  });
  if (!steps.length) throw new Error('Workflow is empty.');
  return steps;
}

/**
 * The number inside a piece of page text, ready to type: "Account : 053-1-58611-5" gives
 * "0531586115" and "3,001.00THB" gives "3001.00". When the text holds several numbers the
 * longest one wins, so a digit in a label does not replace the value. '' when there is none.
 */
function cleanNumber(text) {
  const runs = String(text).match(/\d[\d,\- ]*(?:\.\d+)?/g) || [];
  const numbers = runs.map((run) => run.replace(/[,\- ]/g, ''));
  return numbers.reduce((best, number) => (number.length > best.length ? number : best), '');
}

/**
 * Drop a fraction that is all zeros: "3001.00" gives "3001". A fraction that is not zero is an
 * error, never rounded: typing 3001 for 3001.50 would send the wrong amount.
 */
function wholeNumber(number) {
  const [whole, fraction = ''] = String(number).split('.');
  if (/[1-9]/.test(fraction)) throw new Error(`${number} has a fraction, and this value is set to whole numbers only.`);
  return whole;
}

/** The words on a phone screen, taken from a `uiautomator dump`: one line per label. */
function parseUiText(xml) {
  const decode = (value) => value
    .replace(/&#(\d+);/g, (whole, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const lines = [];
  for (const match of String(xml).matchAll(/\s(?:text|content-desc)="([^"]*)"/g)) {
    const line = decode(match[1]).trim();
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  }
  return lines.join('\n');
}

/** Lines of `seconds|path` from the phone, newest first, keeping pictures changed at or after `since`. */
function parseImageList(output, since = 0) {
  const images = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^(\d+)\|(\/.+\.(?:jpe?g|png))\s*$/i);
    // A name that starts with a dot is a file the phone is still writing (".pending-…") or has
    // thrown away: it is renamed or gone a moment later, so it is never the picture to read.
    if (match && Number(match[1]) >= since && !/\/\.[^/]*$/.test(match[2])) images.push({ at: Number(match[1]), path: match[2] });
  }
  return images.sort((a, b) => b.at - a.at);
}

// What a bank prints over hidden digits, and what text recognition makes of it: it reads "xxx" as "%%%" at times.
const MASK = 'xX*•●×%';
const MIN_MASKED_LENGTH = 6;
const MIN_SHOWN_DIGITS = 4;

/** True when the screen text shows this value, as a plain number or as a partly hidden account number. */
function screenShows(text, value) {
  const wanted = String(value);
  if (!wanted) return false;
  const numeric = /^\d+(\.\d+)?$/.test(wanted);
  // A number may be written with spaces inside it, or sit next to another number with a space
  // between them, so each pattern is tried both with and without spaces as part of the number.
  const runs = (pattern) => [' ', ''].flatMap((space) => String(text).match(new RegExp(pattern.replaceAll('SPACE', space), 'g')) || []);
  // Numbers: 3001 is on the screen as 3,001.00. Compared as numbers, never as "contains".
  for (const run of runs('\\d[\\d,\\-SPACE]*(?:\\.\\d+)?')) {
    const found = run.replace(/[,\- ]/g, '');
    if (found === wanted || (numeric && Number(found) === Number(wanted))) return true;
  }
  // Banks hide part of an account number: 053-1-xxx11-5 still shows 0531586115.
  if (!/^\d+$/.test(wanted) || wanted.length < MIN_MASKED_LENGTH) return false;
  for (const run of runs(`[\\d${MASK}][\\d${MASK}\\-SPACE]{${MIN_MASKED_LENGTH - 1},}`)) {
    const found = run.replace(/[\- ]/g, '');
    if (found.length !== wanted.length) continue;
    const shown = [...found].filter((char) => !MASK.includes(char)).length;
    if (shown >= MIN_SHOWN_DIGITS && shown < found.length && [...found].every((char, index) => MASK.includes(char) || char === wanted[index])) return true;
  }
  return false;
}

/**
 * Check a phone screen against the job that was just run. Every value must be shown, and so must
 * `phrase` when one is set. Returns what is missing; an empty list means the screen agrees.
 */
function verifyScreen(text, values, phrase) {
  const missing = values.filter((value) => !screenShows(text, value)).map((value) => `value ${value}`);
  const wantedPhrase = String(phrase || '').trim();
  // NFKD: text recognition writes Thai "สำ" as two marks where a keyboard types one.
  const squash = (value) => String(value).normalize('NFKD').replace(/\s+/g, '').toLowerCase();
  if (wantedPhrase && !squash(text).includes(squash(wantedPhrase))) missing.push(`"${wantedPhrase}"`);
  return missing;
}

// Banks as a slip names them: Thai names are looked for with spaces removed, Latin ones as words.
const SLIP_BANKS = [
  ['SCB', 'ธนาคารไทยพาณิชย์', ['ไทยพาณิชย์'], ['scb', 'siam commercial']],
  ['KBANK', 'ธนาคารกสิกรไทย', ['กสิกร'], ['kbank', 'k plus', 'kasikorn', 'kasikornbank']],
  ['BBL', 'ธนาคารกรุงเทพ', ['กรุงเทพ'], ['bbl', 'bangkok bank']],
  ['KTB', 'ธนาคารกรุงไทย', ['กรุงไทย'], ['ktb', 'krungthai', 'krung thai']],
  ['GSB', 'ธนาคารออมสิน', ['ออมสิน'], ['gsb', 'government savings']],
  ['TTB', 'ธนาคารทหารไทยธนชาต', ['ทหารไทย', 'ธนชาต'], ['ttb']],
  ['BAY', 'ธนาคารกรุงศรีอยุธยา', ['กรุงศรี'], ['bay', 'krungsri']],
  ['BAAC', 'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร', ['เพื่อการเกษตร', 'ธ.ก.ส', 'ธกส'], ['baac']],
  ['KKP', 'ธนาคารเกียรตินาคินภัทร', ['เกียรตินาคิน'], ['kkp', 'kiatnakin']],
  ['CIMBT', 'ธนาคารซีไอเอ็มบี ไทย', ['ซีไอเอ็มบี'], ['cimbt', 'cimb']],
  ['UOBT', 'ธนาคารยูโอบี', ['ยูโอบี'], ['uobt', 'uob']],
  ['LHBANK', 'ธนาคารแลนด์ แอนด์ เฮ้าส์', ['แลนด์แอนด์เฮ้าส์'], ['lhbank', 'lh bank', 'lhb', 'land and houses']],
  ['TISCO', 'ธนาคารทิสโก้', ['ทิสโก้'], ['tisco']],
  ['CITI', 'ธนาคารซิตี้แบงก์', ['ซิตี้แบงก์'], ['citi', 'citibank']],
  ['GHB', 'ธนาคารอาคารสงเคราะห์', ['อาคารสงเคราะห์', 'ธอส'], ['ghb', 'gh bank']],
  ['ICBC', 'ธนาคารไอซีบีซี (ไทย)', ['ไอซีบีซี'], ['icbc', 'icbct']],
  ['TCRB', 'ธนาคารไทยเครดิต', ['ไทยเครดิต'], ['tcrb', 'thai credit']],
  ['SCBT', 'ธนาคารสแตนดาร์ดชาร์เตอร์ด (ไทย)', ['สแตนดาร์ดชาร์เตอร์ด'], ['scbt', 'standard chartered']],
  ['HSBC', 'ธนาคารฮ่องกงและเซี่ยงไฮ้', ['ฮ่องกงและเซี่ยงไฮ้', 'เอชเอสบีซี'], ['hsbc']],
  ['SMBC', 'ธนาคารซูมิโตโม มิตซุย', ['ซูมิโตโม'], ['smbc', 'sumitomo']],
  ['MHCB', 'ธนาคารมิซูโฮ', ['มิซูโฮ'], ['mhcb', 'mizuho']],
  ['ISBT', 'ธนาคารอิสลามแห่งประเทศไทย', ['อิสลาม'], ['isbt', 'ibank', 'islamic bank']],
  ['DBBK', 'ธนาคารดอยซ์แบงก์', ['ดอยซ์แบงก์', 'ดอยช์แบงก์'], ['dbbk', 'deutsche']],
  ['BOC', 'ธนาคารแห่งประเทศจีน', ['แห่งประเทศจีน'], ['boc', 'bank of china']],
  ['IOBA', 'ธนาคารอินเดียนโอเวอร์ซีส์', ['อินเดียนโอเวอร์ซีส์'], ['ioba', 'indian overseas']],
  ['BNPP', 'ธนาคารบีเอ็นพี พารีบาส์', ['บีเอ็นพี'], ['bnpp', 'bnp paribas']],
  ['SME', 'ธนาคารพัฒนาวิสาหกิจขนาดกลางและขนาดย่อม', ['วิสาหกิจขนาดกลาง', 'เอสเอ็มอี'], ['sme', 'sme bank']],
  ['JPMC', 'ธนาคารเจพีมอร์แกน เชส', ['เจพีมอร์แกน'], ['jpmc', 'jpmorgan', 'jp morgan']],
];
const SLIP_MASK = MASK;
const SLIP_ACCOUNT_RES = [
  // 324-0-xxx718, xxx-x-x0758-x
  new RegExp(`[${SLIP_MASK}0-9]{1,4}(?:-[${SLIP_MASK}0-9]{1,7}){1,4}`),
  // 5840xxx518: two or more mask marks in a row, so a reference with one X in it is not taken.
  new RegExp(`[0-9]*[${SLIP_MASK}]{2,}[${SLIP_MASK}0-9]*`),
];
// The reader takes the comma of 1,000.00 for a dot now and then, so 1.000.00 is the same amount.
const SLIP_AMOUNT_RE = /\d{1,3}(?:[,.]\d{3})+\.\d{2}|\d+\.\d{2}/;
const SLIP_FEE_RE = /ค่าธรรมเนียม|fee/i;
const SLIP_REFERENCE_RE = /อ้างอิง|เลขที่รายการ|reference|\bref\b/i;

function slipBank(line) {
  const squashed = line.normalize('NFKD').replace(/\s+/g, '');
  const lower = line.toLowerCase();
  const found = SLIP_BANKS.find(([, , thai, latin]) => thai.some((name) => squashed.includes(name.normalize('NFKD')))
    || latin.some((name) => new RegExp(`\\b${name}\\b`).test(lower)));
  return found ? { code: found[0], name: found[1] } : null;
}

function slipAccount(line) {
  if (SLIP_FEE_RE.test(line) || SLIP_REFERENCE_RE.test(line)) return '';
  for (const pattern of SLIP_ACCOUNT_RES) {
    const [token] = line.match(pattern) || [];
    if (!token || /^\d{1,4}-\d{1,2}-\d{2,4}$/.test(token)) continue;
    const digits = token.replace(/\D/g, '').length;
    if (token.length >= 6 && digits >= 2 && digits < 15) return token;
  }
  // An account printed in full, on a line that is not the amount.
  if (SLIP_AMOUNT_RE.test(line)) return '';
  const [full] = line.match(/(?<![0-9A-Za-z])\d{8,14}(?![0-9A-Za-z])/) || [];
  return full || '';
}

/** The short code of the bank a text names, such as BBL for "ธนาคารกรุงเทพ"; '' when it names none. */
const bankCode = (text) => (slipBank(String(text || '')) || { code: '' }).code;

/**
 * Whether an account as a slip prints it, hidden digits as x, can be this whole account number:
 * the same length, and every digit that shows is the same.
 */
function maskAgrees(masked, account) {
  const shown = String(masked || '');
  const whole = String(account || '').replace(/\D/g, '');
  return shown.length > 0 && shown.length === whole.length && /\d/.test(shown) && [...shown].every((char, index) => char === 'x' || char === whole[index]);
}

/**
 * What a transfer slip says, from its recognized text: the amount, and for the paying ("sender")
 * and the paid ("receiver") side the account as printed with hidden digits as x, its last four
 * digits when the slip shows them, and the bank. A slip names the payer first. A field the text
 * does not show clearly is '', never a guess.
 */
function parseSlip(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const slip = {
    amount: '',
    sender_account_masked: '', sender_account_last4: '', bank: '', bank_name_th: '',
    receiver_account_masked: '', receiver_account_last4: '', receiver_bank: '', receiver_bank_name_th: '',
  };
  const amountLine = lines.find((line) => !SLIP_FEE_RE.test(line) && SLIP_AMOUNT_RE.test(line.replace(/ /g, '')));
  if (amountLine) {
    const figure = amountLine.replace(/ /g, '').match(SLIP_AMOUNT_RE)[0];
    slip.amount = figure.slice(0, -3).replace(/[,.]/g, '') + figure.slice(-3);
  }

  const accounts = [];
  lines.forEach((line, index) => {
    const token = slipAccount(line);
    // A number under a "reference" label is the reference, however much it looks like an account.
    const reference = index > 0 && SLIP_REFERENCE_RE.test(lines[index - 1]) && /^\d+$/.test(token);
    if (token && !reference) accounts.push({ index, token });
  });
  // Anything other than exactly two accounts cannot be told apart as payer and paid.
  if (accounts.length !== 2) return slip;
  const mask = new RegExp(`[${SLIP_MASK}]`, 'g');
  accounts.forEach((account, position) => {
    const side = position ? 'receiver' : 'sender';
    const shown = account.token.replace(new RegExp(`[^0-9${SLIP_MASK}]`, 'g'), '').replace(mask, 'x');
    slip[`${side}_account_masked`] = shown;
    // Only digits printed together at the end are the account's real last digits.
    const [tail] = shown.match(/\d+$/) || [''];
    slip[`${side}_account_last4`] = tail.length >= 4 ? tail.slice(-4) : '';
    // The bank is on the account's own line or the nearest line to it, on this side of the other account.
    const other = accounts[1 - position].index;
    const mine = (index) => index >= 0 && index < lines.length && (position ? index > other : index < other);
    const near = [0, 1, -1, 2, -2].map((step) => account.index + step).filter(mine);
    const bank = near.map((index) => slipBank(lines[index])).find(Boolean);
    if (bank) {
      slip[position ? 'receiver_bank' : 'bank'] = bank.code;
      slip[position ? 'receiver_bank_name_th' : 'bank_name_th'] = bank.name;
    }
  });
  // A bank app puts its own name at the top of the slip; that is the payer's bank.
  if (!slip.bank) {
    const header = lines.slice(0, accounts[0].index).map(slipBank).find(Boolean);
    if (header) {
      slip.bank = header.code;
      slip.bank_name_th = header.name;
    }
  }
  return slip;
}

// The labels the back office writes in a withdrawal row. The site spells "username" two ways.
const WITHDRAW_LABELS = {
  user: ['ยูชเซอร์เนม', 'ยูสเซอร์เนม', 'Username'],
  bank: ['ชื่อธนาคาร'],
  holder: ['ชื่อบัญชีธนาคาร'],
  account: ['เลขบัญชีธนาคาร'],
  amount: ['จำนวนเงิน'],
};
const WITHDRAW_TIME_RE = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?/g;

/**
 * One row of the back office's withdrawal table, from the text of its cells: who is paid, at
 * which bank and account, how much, and when it was asked for. Null when the row is not a
 * withdrawal to a bank account, such as the "nothing found" row. `key` tells rows apart: one
 * account does not ask twice for the same amount at the same second.
 */
function parseWithdrawRow(cells) {
  const lines = (Array.isArray(cells) ? cells : []).flatMap((cell) => String(cell || '').split(/\r?\n/)).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // "label : value" on one line, or the label on one line and the value on the next.
  const field = (labels) => {
    for (const [index, line] of lines.entries()) {
      const label = labels.find((each) => line.startsWith(each) && /^\s*:/.test(line.slice(each.length)));
      if (!label) continue;
      const rest = line.slice(label.length).replace(/^\s*:\s*/, '');
      if (rest) return rest;
      const next = lines[index + 1] || '';
      // A line that is itself "label :" is the next field, not this one's value.
      return /\s:(\s|$)/.test(next) ? '' : next;
    }
    return '';
  };
  const account = field(WITHDRAW_LABELS.account).replace(/[\s-]/g, '');
  const amount = cleanNumber(field(WITHDRAW_LABELS.amount));
  if (!/^\d{6,20}$/.test(account) || !(Number(amount) > 0)) return null;
  const times = lines.join('\n').match(WITHDRAW_TIME_RE) || [];
  const row = {
    user: field(WITHDRAW_LABELS.user),
    bank: field(WITHDRAW_LABELS.bank),
    holder: field(WITHDRAW_LABELS.holder),
    account,
    amount,
    requested: times[0] || '',
    approved: times[1] || '',
  };
  return { ...row, key: [row.account, Number(row.amount).toFixed(2), row.requested].join('|') };
}

// A time from the back office's own request, as its page shows it: Thai time, day first.
function thaiTime(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const date = new Date(at + 7 * 3600 * 1000);
  const two = (number) => String(number).padStart(2, '0');
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
}

/**
 * One withdrawal as the back office's own list request gives it, in the shape and with the `key`
 * that parseWithdrawRow gives for the same row of the page. Null when it is not an approved
 * withdrawal to a bank account that is still open, or when what is paid is not the amount asked
 * for (a fee, a tax or a part payment): such a row is left to the page.
 */
function withdrawFromApi(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.bank_type !== 'BANK' || item.approve_status !== 'approve' || item.success_datetime) return null;
  const account = String(item.bank_no || '').replace(/[\s-]/g, '');
  const value = Number(item.withdrawal_amount);
  if (!/^\d{6,20}$/.test(account) || !(value > 0)) return null;
  if (Number(item.total_amount) !== value || Number(item.is_withdraw_partial)) return null;
  const requested = thaiTime(item.withdraw_datetime);
  if (!requested) return null;
  const row = {
    user: String(item.username || ''),
    bank: String(item.member_bank_display || '').trim(),
    holder: [item.first_name, item.last_name].map((name) => String(name || '').trim()).filter(Boolean).join(' '),
    account,
    amount: value.toFixed(2),
    requested,
    approved: thaiTime(item.approve_datetime),
  };
  // The row's own id, kept apart from the fields the page also gives, so a row read by request can
  // be closed by request. Null when the id is not a plain identifier.
  const id = /^[0-9a-f-]{16,64}$/i.test(String(item.id || '')) ? String(item.id) : null;
  return { ...row, id, key: [row.account, row.amount, row.requested].join('|') };
}

/**
 * One of the shop's settlement (paying) accounts, from a row of the back office's own
 * all-settlement-balance request: the account number, its id for closing, what is left in it, and
 * whether it is switched on. Null when the row is not a bank account with an id.
 */
function settlementFromApi(item) {
  if (!item || typeof item !== 'object') return null;
  const account = String(item.bank_no || '').replace(/[\s-]/g, '');
  const id = String(item.settlement_account_id || item.id || '');
  if (!/^\d{6,20}$/.test(account) || !/^[0-9a-f-]{16,64}$/i.test(id)) return null;
  // The bank's name sits either at the top level or inside bank_information, by the request.
  const info = item.bank_information && typeof item.bank_information === 'object' ? item.bank_information : {};
  return {
    account,
    id,
    holder: String(item.settlement_acc_name || '').trim(),
    bank: String(item.bank_name_display || info.bank_name_display || '').trim(),
    bankCode: String(item.bank_code || info.bank_code || '').trim(),
    balance: Number.isFinite(Number(item.balance)) ? Number(item.balance) : null,
    on: Boolean(item.is_active),
  };
}

// The address of the back office's own request that closes one approved withdrawal.
function apiClosePath(id) {
  if (!/^[0-9a-f-]{16,64}$/i.test(String(id || ''))) throw new Error(`"${id}" is not a withdrawal id.`);
  return `/bo/withdrawal-approve/${encodeURIComponent(id)}`;
}

/**
 * The body of that request: close the withdrawal as paid from this settlement account. The same
 * five fields the back office's own form sends, so the service sees no difference.
 */
function closeApproveBody(settlementId) {
  if (!/^[0-9a-f-]{16,64}$/i.test(String(settlementId || ''))) throw new Error('A settlement account id is needed to close a withdrawal.');
  return { approve_tran_remark: '', settlement_account_id: String(settlementId), transfer_already: true, withdraw_state: 'APPROVE', withdraw_status: 'success' };
}

/** Whether the service's answer to a close request says the withdrawal is now paid. */
function closeApproved(answer) {
  return Boolean(answer && typeof answer === 'object' && answer.withdraw_status === 'success' && answer.success_datetime);
}

// The address of the request that switches one of the shop's paying accounts on or off.
function settlementTogglePath(id) {
  if (!/^[0-9a-f-]{16,64}$/i.test(String(id || ''))) throw new Error(`"${id}" is not a settlement account id.`);
  return `/bo/withdrawal-settlement/${encodeURIComponent(id)}`;
}

/** The body of that request: switch the account on (1) or off (0), the one field the form sends. */
function settlementToggleBody(on) {
  return { is_active: on ? 1 : 0 };
}

const SETTLEMENT_LABELS ={ holder: ['ชื่อบัญชี'], account: ['หมายเลขบัญชี'] };

/**
 * One row of the back office's list of the shop's own accounts, from the text of its cells and
 * its status switch: the account, what the back office says is left in it, when that was last
 * updated, and whether the account is switched on. Null when the row is not a bank account.
 */
function parseSettlementRow(cells, on) {
  const list = Array.isArray(cells) ? cells.map((cell) => String(cell || '')) : [];
  const lines = list.flatMap((cell) => cell.split(/\r?\n/)).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const field = (labels) => {
    for (const line of lines) {
      const label = labels.find((each) => line.startsWith(each) && /^\s*:/.test(line.slice(each.length)));
      if (label) return line.slice(label.length).replace(/^\s*:\s*/, '');
    }
    return '';
  };
  const account = field(SETTLEMENT_LABELS.account).replace(/[\s-]/g, '');
  if (!/^\d{6,20}$/.test(account)) return null;
  // The balance is the cell that holds an amount of money, to the satang, and nothing else. The
  // row's running number is a whole number, so it is not taken for one.
  const money = list.map((cell) => cell.replace(/\s+/g, '')).find((cell) => /^-?(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/.test(cell));
  const [updated = ''] = lines.join('\n').match(WITHDRAW_TIME_RE) || [];
  return { account, holder: field(SETTLEMENT_LABELS.holder), balance: money === undefined ? null : Number(money.replace(/,/g, '')), updated, on: typeof on === 'boolean' ? on : null };
}

const INPUT_RE = /\{(\d{1,2})\}/g;

/** How many values a workflow asks for: the highest `{n}` in its text, run and pick steps. */
function workflowInputs(steps) {
  let count = 0;
  for (const step of steps) {
    if (!FILLED_COMMANDS.includes(step.command)) continue;
    for (const match of step.argument.matchAll(INPUT_RE)) count = Math.max(count, Number(match[1]));
  }
  return count;
}

/**
 * Put the caller's values into `{1}`, `{2}`… of the text steps. This runs on parsed steps, so a
 * value can never add a step or change a command, whatever it contains.
 */
function fillWorkflow(steps, values, commands = ['text']) {
  const list = Array.isArray(values) ? values : [];
  return steps.map((step, index) => {
    if (!commands.includes(step.command)) return step;
    const argument = step.argument.replace(INPUT_RE, (whole, number) => {
      const value = list[Number(number) - 1];
      const text = value === undefined || value === null ? '' : String(value);
      if (!text) throw new Error(`Step ${index + 1} needs value ${whole}, which was not sent.`);
      if (text.length > 200 || /[\r\n]/.test(text)) throw new Error(`Value ${whole} must be one line of at most 200 characters.`);
      return text;
    });
    return { ...step, argument };
  });
}

const MAX_RUN_DEPTH = 3;

/**
 * The steps a run will really do: every `run <name>` step is replaced by the steps of the saved
 * workflow of that name, and the caller's values are put into the text steps. A name may hold
 * `{n}`, so the value of a job picks the workflow: `run bank-{3}` runs "bank-KBANK" for one job
 * and "bank-SCB" for another. All of this is worked out before the first step runs, so a job whose
 * workflow is not saved does nothing at all instead of stopping halfway.
 */
function expandWorkflow(steps, values, workflows, sets, pin, trail = []) {
  const saved = workflows && typeof workflows === 'object' ? workflows : {};
  const flat = [];
  for (const step of fillWorkflow(steps, values, FILLED_COMMANDS)) {
    if (step.command === 'pick') {
      flat.push(...pickSteps(step, sets));
      continue;
    }
    if (step.command === 'pin') {
      flat.push(...pinSteps(step, sets, pin));
      continue;
    }
    if (step.command !== 'run') {
      flat.push(step);
      continue;
    }
    const name = Object.keys(saved).find((key) => squashName(key) === squashName(step.argument));
    if (!name) throw new Error(`There is no saved workflow named '${step.argument}'.`);
    if (trail.includes(name)) throw new Error(`Workflow '${name}' runs itself.`);
    if (trail.length >= MAX_RUN_DEPTH) throw new Error(`Workflows run inside each other more than ${MAX_RUN_DEPTH} deep.`);
    let inner;
    try {
      inner = parseWorkflow(saved[name]);
    } catch (error) {
      throw new Error(`Workflow '${name}': ${error.message}`);
    }
    flat.push(...expandWorkflow(inner, values, saved, sets, pin, [...trail, name]));
  }
  return flat;
}

// Spaces and letter case do not tell two names apart: a page may write a bank's name either way.
const squashName = (name) => String(name).normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// The swipe that brings the next page of a list into view. Slow, so the list stops where the
// finger stops and every run lands on the same rows.
const DEFAULT_PICK_SCROLL = '50% 70% 50% 35% 1500';
const PICK_SETTLE_MS = 700;
const MAX_PICK_PAGE = 20;
const MAX_PICK_ALSO = 10;

/**
 * The name in a position set that `wanted` means, or '' when none or more than one does. A name
 * is meant when it or one of its other spellings is written the same, or, for a bank, when both
 * are names of the same bank: "KBANK", "กสิกร" and "ธนาคารกสิกรไทย" are one bank.
 */
function findPick(set, wanted) {
  const entries = Object.entries(set.items);
  const spellings = ([name, item]) => [name, ...item.also];
  const exact = entries.filter((entry) => spellings(entry).some((word) => squashName(word) === squashName(wanted)));
  if (exact.length) return exact.length === 1 ? exact[0][0] : '';
  const bank = slipBank(String(wanted));
  if (!bank) return '';
  const same = entries.filter((entry) => spellings(entry).some((word) => (slipBank(word) || {}).code === bank.code));
  return same.length === 1 ? same[0][0] : '';
}

/** `pick <set> <name>` as its parts, or null. A set's name has no spaces; the name may. */
function parsePick(argument) {
  const match = String(argument).trim().match(/^(\S+)\s+(\S.*)$/);
  return match ? { set: match[1], name: match[2] } : null;
}

/**
 * A position set as saved, cleaned: { scroll, items: { name: { page, at } } }. A set is one list
 * on the phone, such as the banks to choose from. Each name in it has the page of the list it is
 * on (how many scrolls from the top) and where to tap on that page.
 */
function normalizePickSet(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const items = {};
  for (const [name, item] of Object.entries(source.items && typeof source.items === 'object' ? source.items : {})) {
    if (!item || !parseGesture('tap', String(item.at || ''))) continue;
    // Other spellings a job may use for the same name, such as a short form.
    const also = (Array.isArray(item.also) ? item.also : []).map((word) => String(word).trim().slice(0, 60)).filter(Boolean).slice(0, MAX_PICK_ALSO);
    items[name] = { page: Math.min(MAX_PICK_PAGE, Math.max(0, Math.round(item.page) || 0)), at: String(item.at).trim(), also };
  }
  const scroll = String(source.scroll || '').trim();
  return { scroll: parseGesture('swipe', scroll) ? scroll : DEFAULT_PICK_SCROLL, items };
}

const DEFAULT_PIN_GAP_MS = 800;

/** `pin <set> [ms]` as its parts, or null: the keypad's position set and the pause between keys. */
function parsePin(argument) {
  const match = String(argument).trim().match(/^(\S+)(?:\s+(\d{1,5}))?$/);
  return match ? { set: match[1], gap: match[2] === undefined ? DEFAULT_PIN_GAP_MS : Number(match[2]) } : null;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text) => String(text).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, name) => {
  if (name[0] !== '#') return XML_ENTITIES[name.toLowerCase()];
  const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
});

/**
 * Where to tap for the words `wanted` in a phone's view tree (the XML of "uiautomator dump"):
 * the middle of the first thing on screen whose text, or whose description for screen readers,
 * is those words. Spaces and letter case are not told apart. Only the whole label counts: "ปิด"
 * must not tap "เปิดบัญชี". Words written between stars, *like this*, are looked for inside
 * longer labels instead. Resolves with { x, y, label } in pixels, or null.
 */
function findUiText(xml, wanted) {
  const inside = /^\*.+\*$/.test(String(wanted).trim());
  const goal = squashName(inside ? String(wanted).trim().slice(1, -1) : wanted);
  if (!goal) return null;
  const attribute = (node, name) => {
    const match = node.match(new RegExp(`\\s${name}="([^"]*)"`));
    return match ? unescapeXml(match[1]) : '';
  };
  for (const [node] of String(xml).matchAll(/<node\s[^>]*>/g)) {
    const bounds = attribute(node, 'bounds').match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
    if (!bounds) continue;
    const [left, top, right, bottom] = bounds.slice(1).map(Number);
    // Something scrolled off the screen keeps its place in the tree with no size.
    if (right <= left || bottom <= top) continue;
    const spot = { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
    for (const label of [attribute(node, 'text'), attribute(node, 'content-desc')]) {
      const said = squashName(label);
      if (inside ? said.includes(goal) : said === goal) return { ...spot, label };
    }
  }
  return null;
}

/** A PIN as the app keeps one: 4 to 12 digits. */
const isPin = (value) => typeof value === 'string' && /^\d{4,12}$/.test(value);

/**
 * The steps of one `pin` step: a tap for each digit of the phone's PIN, at the position the
 * keypad's set has for that digit. Each step is marked `secret`, so what is shown or logged of
 * the run never says which key was pressed.
 */
function pinSteps(step, sets, pin) {
  const wanted = parsePin(step.argument);
  const all = sets && typeof sets === 'object' ? sets : {};
  const setName = wanted && Object.keys(all).find((key) => squashName(key) === squashName(wanted.set));
  if (!setName) throw new Error(`There is no position set named '${wanted ? wanted.set : step.argument}'.`);
  if (!isPin(pin)) throw new Error('No PIN is set for this phone.');
  const set = normalizePickSet(all[setName]);
  const steps = [];
  for (const digit of pin) {
    // The digit is not named in the error: an error is logged.
    const item = set.items[digit];
    if (!item) throw new Error(`Position set '${setName}' does not have every digit of this phone's PIN.`);
    if (steps.length) steps.push({ ...step, command: 'wait', argument: String(wanted.gap), note: '' });
    steps.push({ ...step, command: 'tap', argument: item.at, note: 'PIN', secret: true });
  }
  return steps;
}

/** The steps of one `pick` step: scroll to the name's page, then tap it. */
function pickSteps(step, sets) {
  const wanted = parsePick(step.argument);
  const all = sets && typeof sets === 'object' ? sets : {};
  const setName = wanted && Object.keys(all).find((key) => squashName(key) === squashName(wanted.set));
  if (!setName) throw new Error(`There is no position set named '${wanted ? wanted.set : step.argument}'.`);
  const set = normalizePickSet(all[setName]);
  const name = findPick(set, wanted.name);
  if (!name) throw new Error(`Position set '${setName}' has no position for '${wanted.name}', or more than one.`);
  const { page, at } = set.items[name];
  const steps = [];
  for (let turn = 0; turn < page; turn += 1) {
    steps.push({ ...step, command: 'swipe', argument: set.scroll, note: `${setName}: page ${turn + 1}` });
    steps.push({ ...step, command: 'wait', argument: String(PICK_SETTLE_MS), note: '' });
  }
  steps.push({ ...step, command: 'tap', argument: at, note: `${setName}: ${name}` });
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
  parseGesture,
  gesturePixels,
  parseScreenSize,
  parseTouchDevices,
  TouchRecorder,
  parseWorkflow,
  workflowInputs,
  fillWorkflow,
  expandWorkflow,
  parsePick,
  normalizePickSet,
  findPick,
  parsePin,
  isPin,
  DEFAULT_PICK_SCROLL,
  cleanNumber,
  wholeNumber,
  parseUiText,
  parseImageList,
  screenShows,
  verifyScreen,
  parseSlip,
  bankCode,
  findUiText,
  maskAgrees,
  parseWithdrawRow,
  withdrawFromApi,
  settlementFromApi,
  apiClosePath,
  closeApproveBody,
  closeApproved,
  settlementTogglePath,
  settlementToggleBody,
  parseSettlementRow,
  normalizePolicy,
  checkPolicy,
  scrcpyArgs,
  mapLimit,
};
