'use strict';

const root = document.documentElement;
root.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';

const S = {
  version: '',
  config: {},
  tools: {},
  dataDir: '',
  devices: [],
  selected: new Set(),
  focus: null,
  view: 'info',
  thumbs: {},
  logs: [],
  workflows: {},
  points: {},
  pickSets: {},
  // The position set on show, and the taking of positions from the phone when one is running.
  pick: { set: '', pages: 1, rec: null },
  policies: {},
  profiles: {},
  scannedAt: null,
  scanning: false,
  job: null,
  update: { status: 'idle' },
  thumbAuto: false,
  infoDraft: {},
  actions: { text: '', pkg: '', group: '' },
  live: { profile: '' },
  apps: { serial: null, list: [], filter: '', system: false, pkg: null, info: null, loading: false },
  apk: { dir: '', items: [], selected: null },
  wf: { name: '', text: '', preview: null, raw: false },
  timeline: null,
  rec: null,
  jobs: null,
  jobRead: null,
  jobScreen: null,
  policy: { pkg: '', mode: 'assisted', allow_capture: true, notes: '' },
  logFilter: 'all',
};

const NAV = [
  ['อุปกรณ์', [['info', 'ข้อมูลเครื่อง', 'info'], ['actions', 'สั่งงาน', 'zap'], ['live', 'หน้าจอสด', 'monitor'], ['apps', 'แอป', 'grid']]],
  ['ฟลีต', [['apk', 'ติดตั้ง APK', 'box'], ['workflow', 'เวิร์กโฟลว์', 'list'], ['withdraw', 'รายการถอน', 'list'], ['jobs', 'รับงานจากเว็บ', 'globe'], ['policy', 'กฎของแอป', 'shield']]],
  ['ระบบ', [['log', 'บันทึก', 'file'], ['settings', 'ตั้งค่า', 'sliders']]],
];
const VIEW_HINTS = {
  info: ['ข้อมูลเครื่อง', 'รายละเอียดและชื่อเรียกของเครื่องที่เลือก'],
  actions: ['สั่งงาน', 'ส่งคำสั่งไปยังทุกเครื่องที่เลือก'],
  live: ['หน้าจอสด', 'ควบคุมหน้าจอจริงผ่าน scrcpy'],
  apps: ['แอป', 'แอปที่ติดตั้งในเครื่องที่เลือก'],
  apk: ['ติดตั้ง APK', 'คลัง APK และการติดตั้งหลายเครื่องพร้อมกัน'],
  workflow: ['เวิร์กโฟลว์', 'ชุดคำสั่งที่บันทึกไว้ รันเมื่อสั่งเท่านั้น'],
  withdraw: ['รายการถอน', 'อ่านรายการถอนจากหลังบ้าน โอนจากมือถือ ตรวจสลิป แล้วปิดงาน'],
  jobs: ['รับงานจากเว็บ', 'ล็อกอินหลังบ้าน อ่านค่าของงาน แล้วรันเวิร์กโฟลว์'],
  policy: ['กฎของแอป', 'กำหนดว่าแอปไหนสั่งงานอัตโนมัติหรือจับภาพได้'],
  log: ['บันทึก', 'เหตุการณ์ของรอบการทำงานนี้'],
  settings: ['ตั้งค่า', 'ธีม การสแกน และตำแหน่งเครื่องมือ'],
};
const JOB_STATUS = {
  idle: 'ยังไม่เริ่ม',
  closed: 'หน้าต่างหลังบ้านปิดอยู่',
  loading: 'หน้าเว็บกำลังโหลด',
  waiting: 'ยังไม่พบงานบนหน้าเว็บ',
  same: 'งานนี้ทำไปแล้ว รอหน้าเว็บเปลี่ยน',
  running: 'กำลังรัน',
  checking: 'กำลังตรวจหลักฐานจากมือถือ',
  closing: 'กำลังปิดงานในหลังบ้าน',
  done: 'เสร็จ',
  error: 'หยุดแล้ว',
};
const WITHDRAW_STATE = { started: 'เริ่มแล้ว ไม่จบ', paid: 'โอนแล้ว ยังไม่ปิดงาน', trial: 'โอนแล้ว (ทดลอง) ปิดงานเอง', done: 'เสร็จ ปิดงานแล้ว', failed: 'ผิดพลาด', resolved: 'จัดการด้วยมือแล้ว' };
const WITHDRAW_NOTE = {
  closed: 'หน้าต่างหลังบ้านปิดอยู่', signedOut: 'รอล็อกอินในหน้าต่างหลังบ้าน', opening: 'กำลังไปหน้ารายการถอน',
  wrongTab: 'เปิดแท็บ "รายการที่อนุมัติแล้ว" ในหน้าต่างหลังบ้าน', noProfile: 'ไม่มี Closejob สำหรับที่อยู่หลังบ้านนี้', ok: 'อ่านรายการแล้ว',
};
const WITHDRAW_ACCOUNTS = { off: 'ยังไม่ได้อ่าน', ok: 'อ่านแล้ว', signedOut: 'รอล็อกอิน', elsewhere: 'กำลังไปหน้าปรับยอดเงินบัญชีถอน', error: 'อ่านไม่ได้' };
const WITHDRAW_EVENT = { start: 'เริ่มโอน', workflow: 'เวิร์กโฟลว์จบ', slip: 'อ่านสลิป', trial: 'โอนแล้ว ไม่ปิดงาน (ทดลอง)', done: 'ปิดงานแล้ว', error: 'ผิดพลาด', halt: 'หยุดทำงาน', reset: 'รีเซ็ต', auto: 'สลับอัตโนมัติ', broke: 'เงินในบัญชีหมด', rest: 'พักเครื่อง', close: 'เวลาปิดงาน', 'account-on': 'เปิดบัญชีในหลังบ้าน', 'account-off': 'ปิดบัญชีในหลังบ้าน', resolved: 'จัดการด้วยมือแล้ว' };
const STATUS_TH = { device: 'ออนไลน์', offline: 'ออฟไลน์', unauthorized: 'ยังไม่อนุญาต', unknown: 'ไม่ทราบ' };
const POLICY_TH = { assisted: 'สั่งงานอัตโนมัติได้', manual_only: 'ควบคุมด้วยมือเท่านั้น', blocked: 'ห้ามสั่งงานทุกอย่าง' };
const ICONS = {
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 8v5m0-8.5v.5',
  zap: 'M13 3 5 13h6l-1 8 8-10h-6z',
  monitor: 'M4 5h16v11H4zm5 15h6m-3-4v4',
  grid: 'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z',
  box: 'm12 3 8 4.5v9L12 21l-8-4.5v-9zm0 9 8-4.5M12 12 4 7.5M12 12v9',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  shield: 'M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z',
  file: 'M7 3h7l5 5v13H7zm7 0v5h5M10 13h6m-6 4h6',
  sliders: 'M5 6h8m4 0h2M5 12h2m4 0h8M5 18h10m4 0h0M15 4v4M9 10v4M17 16v4',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.3 3 14.7 0 18M12 3c-3 3.3-3 14.7 0 18',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
};

// ── helpers ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

async function call(channel, payload) {
  const reply = await window.farm.call(channel, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

/** Run an action and surface any failure as a toast instead of an unhandled rejection. */
async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(error.message, 'error');
    return undefined;
  }
}

function toast(message, kind = '') {
  const node = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  $('toasts').append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 7000 : 3500);
}

function confirmDialog(title, message, confirmLabel, danger = true) {
  return new Promise((resolve) => {
    const close = (answer) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };
    const cancel = h('button', { class: 'btn ghost', onclick: () => close(false) }, 'ยกเลิก');
    const backdrop = h('div', { class: 'modal-backdrop', onclick: (event) => event.target === backdrop && close(false) },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', null, title),
        h('p', null, message),
        h('div', { class: 'row' }, cancel,
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, confirmLabel))));
    $('modal-root').append(backdrop);
    document.addEventListener('keydown', onKey);
    cancel.focus();
  });
}

/** Ask for one line of text. Resolves with the trimmed text, or null when cancelled or left empty. */
function promptDialog(title, message, confirmLabel, placeholder = '', value = '') {
  return new Promise((resolve) => {
    const close = (answer) => {
      backdrop.remove();
      resolve(answer);
    };
    const box = h('input', {
      class: 'field', spellcheck: false, placeholder, value, maxLength: 200,
      onkeydown: (event) => {
        if (event.key === 'Enter') close(box.value.trim() || null);
        if (event.key === 'Escape') close(null);
      },
    });
    const backdrop = h('div', { class: 'modal-backdrop', onclick: (event) => event.target === backdrop && close(null) },
      h('div', { class: 'modal prompt', role: 'dialog', 'aria-modal': 'true' },
        h('h3', null, title),
        h('p', null, message),
        box,
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => close(null) }, 'ยกเลิก'),
          h('button', { class: 'btn primary', onclick: () => close(box.value.trim() || null) }, confirmLabel))));
    $('modal-root').append(backdrop);
    box.focus();
    box.select();
  });
}

const timeOf = (value) => new Date(value).toLocaleTimeString('th-TH', { hour12: false });
const statusLabel = (device) => STATUS_TH[device.status] || device.status;
const statusClass = (device) => (device.online ? 'online' : device.status === 'unauthorized' ? 'unauthorized' : device.status === 'offline' || device.status === 'unknown' ? '' : 'error');
const focusDevice = () => S.devices.find((device) => device.serial === S.focus) || null;
const targets = () => [...S.selected];
const onlineTargets = () => S.devices.filter((device) => S.selected.has(device.serial) && device.online);

function field(label, control) {
  return h('label', { class: 'grow' }, h('span', { class: 'label' }, label), control);
}

function input(value, oninput, extra = {}) {
  return h('input', { class: 'field', value: value ?? '', spellcheck: false, oninput: (event) => oninput(event.target.value), ...extra });
}

function toggle(label, checked, onchange) {
  return h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked, onchange: (event) => onchange(event.target.checked) }),
    h('span', { class: 'track' }), label);
}

function targetBanner() {
  const online = onlineTargets().length;
  if (!S.selected.size) return h('div', { class: 'targets none' }, 'ยังไม่ได้เลือกเครื่อง คลิกการ์ดเพื่อเลือก (Ctrl+คลิก เลือกหลายเครื่อง)');
  return h('div', { class: `targets ${online ? '' : 'none'}` }, `เลือก ${S.selected.size} เครื่อง · ออนไลน์ ${online} เครื่อง`);
}

async function setConfig(patch) {
  const config = await attempt(() => call('config:set', patch));
  if (config) S.config = config;
}

// ── actions shared by several views ───────────────────────────────────────

async function deviceAction(action, arg, { confirm } = {}) {
  if (confirm && !(await confirmDialog(confirm.title, confirm.message, confirm.label))) return;
  const outcome = await attempt(() => call('device:action', { serials: targets(), action, arg }));
  if (!outcome) return;
  const ok = outcome.results.length - outcome.failed;
  const firstFailure = outcome.results.find((result) => !result.ok);
  if (outcome.failed) toast(`${outcome.label}: สำเร็จ ${ok} · ล้มเหลว ${outcome.failed}\n${firstFailure.label}: ${firstFailure.detail}`, 'error');
  else toast(`${outcome.label}: สำเร็จ ${ok} เครื่อง`, 'success');
  return outcome;
}

function refreshScreens(serials) {
  return attempt(() => call('thumbs:refresh', { serials }));
}

let thumbTimer = null;
function applyThumbAuto() {
  clearInterval(thumbTimer);
  if (!S.thumbAuto) return;
  refreshScreens();
  thumbTimer = setInterval(() => refreshScreens(), Math.max(3, Number(S.config.thumbnail_interval_seconds) || 8) * 1000);
}

function selectDevice(serial, additive) {
  if (additive) {
    if (S.selected.has(serial)) S.selected.delete(serial);
    else S.selected.add(serial);
    S.focus = S.selected.has(serial) ? serial : [...S.selected].pop() || null;
  } else {
    S.selected = new Set([serial]);
    S.focus = serial;
  }
  renderDevices();
  renderInspector();
}

function setView(view) {
  S.view = view;
  renderNav();
  renderInspector();
  if (view === 'apk') loadApkLibrary();
}

async function restartForUpdate() {
  if (!(await confirmDialog('รีสตาร์ตเพื่ออัปเดต?', `ปิดแล้วเปิดโปรแกรมใหม่เพื่อใช้เวอร์ชัน ${S.update.version} หน้าจอสดที่เปิดอยู่จะถูกปิด`, 'รีสตาร์ต', false))) return;
  attempt(() => call('update:restart'));
}

function updateSummary() {
  const update = S.update;
  const checked = update.checkedAt ? `ตรวจล่าสุด ${new Date(update.checkedAt).toLocaleString('th-TH', { hour12: false })}` : 'ยังไม่เคยตรวจ';
  if (update.status === 'disabled') return 'ยังไม่ได้ตั้ง URL อัปเดต (package.json "updateUrl")';
  if (update.status === 'updated') return `ดาวน์โหลดเวอร์ชัน ${update.version} แล้ว รีสตาร์ตเพื่อใช้`;
  if (update.status === 'error') return `ตรวจอัปเดตไม่สำเร็จ: ${update.message} · ${checked}`;
  if (update.status === 'current') return `เป็นเวอร์ชันล่าสุดแล้ว · ${checked}`;
  return checked;
}

// ── workflow builder ──────────────────────────────────────────────────────

// The builder edits the same text the workflow is stored and run as, one row per line.
const WF_STEPS = [
  ['wake', 'ปลุกจอ'], ['home', 'หน้าแรก'], ['back', 'ย้อนกลับ'], ['recent', 'แอปล่าสุด'], ['sleep', 'ปิดจอ'],
  ['wait', 'รอ'], ['open', 'เปิดแอป'], ['close', 'ปิดแอป'], ['text', 'พิมพ์ข้อความ'], ['run', 'รันเวิร์กโฟลว์ย่อย'], ['pick', 'แตะตามชุดตำแหน่ง'], ['pin', 'กดรหัส PIN'], ['keyevent', 'กดปุ่ม'], ['screenshot', 'จับภาพหน้าจอ'],
  ['tap', 'แตะที่ X, Y'], ['swipe', 'ปัดจาก X, Y'],
];
const WF_LABELS = { ...Object.fromEntries(WF_STEPS), tap: 'แตะ', swipe: 'ปัด', '#': 'หมายเหตุ' };
const WF_DEFAULTS = { wait: '1000', keyevent: 'KEYCODE_ENTER' };
const WF_NEEDS = {
  open: 'ยังไม่ได้ใส่ชื่อแพ็กเกจของแอป', close: 'ยังไม่ได้ใส่ชื่อแพ็กเกจของแอป', run: 'ยังไม่ได้ใส่ชื่อเวิร์กโฟลว์ย่อย', pick: 'ยังไม่ได้เลือกชุดตำแหน่งและชื่อ', pin: 'ยังไม่ได้เลือกชุดตำแหน่งของปุ่มตัวเลข', text: 'ยังไม่ได้ใส่ข้อความ', wait: 'ยังไม่ได้ใส่เวลารอ',
  tap: 'ยังใส่ตำแหน่ง X, Y ไม่ครบ', swipe: 'ยังใส่ตำแหน่ง X, Y ไม่ครบ',
};
const isGesture = (step) => step.command === 'tap' || step.command === 'swipe';
// Positions are x y for a tap, from-x from-y to-x to-y for a swipe: percentages of the screen, or pixels without the %.
const WF_SWIPES = [
  ['ปัดขึ้น', '50% 75% 50% 25%'], ['ปัดลง', '50% 25% 50% 75%'], ['ปัดซ้าย', '80% 50% 20% 50%'], ['ปัดขวา', '20% 50% 80% 50%'],
];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// A text step holding {1} or {2} types the value sent with the job, from the web API or asked at run time.
const WF_INPUTS = [1, 2, 3];
const inputLabel = (number) => `ข้อมูลช่อง ${number}`;
/** How many values the workflow asks for: the highest {n} in its text steps. */
function workflowInputCount(text) {
  let count = 0;
  for (const step of workflowSteps(text)) {
    if (!['text', 'run', 'pick'].includes(step.command)) continue;
    for (const match of step.argument.matchAll(/\{(\d{1,2})\}/g)) count = Math.max(count, Number(match[1]));
  }
  return count;
}
const WF_KEYS = [
  ['KEYCODE_ENTER', 'Enter (ตกลง / เรียบร้อย)'], ['KEYCODE_TAB', 'Tab (ช่องถัดไป)'], ['KEYCODE_DEL', 'ลบตัวอักษร'],
  ['KEYCODE_DPAD_UP', 'ลูกศรขึ้น'], ['KEYCODE_DPAD_DOWN', 'ลูกศรลง'], ['KEYCODE_DPAD_LEFT', 'ลูกศรซ้าย'], ['KEYCODE_DPAD_RIGHT', 'ลูกศรขวา'],
  ['KEYCODE_VOLUME_UP', 'เพิ่มเสียง'], ['KEYCODE_VOLUME_DOWN', 'ลดเสียง'],
];

/** One entry per step. A `#` line is the note of the step after it; one with no step after it stays a row of its own. */
function workflowSteps(text) {
  const steps = [];
  let note = null;
  const loose = () => {
    if (note !== null) steps.push({ command: '#', argument: note, note: '' });
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      loose();
      note = line.slice(1).trim();
      continue;
    }
    const space = line.indexOf(' ');
    steps.push(space < 0
      ? { command: line.toLowerCase(), argument: '', note: note || '' }
      : { command: line.slice(0, space).toLowerCase(), argument: line.slice(space + 1).trim(), note: note || '' });
    note = null;
  }
  loose();
  return steps;
}

function workflowText(steps) {
  return steps.flatMap((step) => {
    const line = step.argument || step.command === '#' ? `${step.command} ${step.argument}` : step.command;
    return step.note && step.command !== '#' ? [`# ${step.note}`, line] : [line];
  }).join('\n');
}

/** Catch the gaps a button-built workflow can have, in Thai, before the parser reports them in English. */
function workflowReady(wf) {
  if (wf.raw) return true;
  const steps = workflowSteps(wf.text);
  const gap = steps.findIndex((step) => WF_NEEDS[step.command] && (!step.argument || (isGesture(step) && step.argument.includes('?'))));
  if (!steps.length) toast('ยังไม่มีขั้นตอน กดปุ่มด้านล่างเพื่อเพิ่ม', 'error');
  else if (gap >= 0) toast(`ขั้นที่ ${gap + 1}: ${WF_NEEDS[steps[gap].command]}`, 'error');
  return steps.length > 0 && gap < 0;
}

function workflowBuilder(wf) {
  const steps = workflowSteps(wf.text);
  const sync = () => { wf.text = workflowText(steps); wf.preview = null; };
  const change = (mutate) => { mutate(); sync(); renderInspector(); };
  const setArgument = (step) => (value) => { step.argument = value.trim(); sync(); };

  const control = (step) => {
    if (step.command === 'wait') {
      return [
        input(step.argument ? Number(step.argument) / 1000 : '', (value) => {
          const seconds = Number(value);
          step.argument = value && seconds >= 0 ? String(Math.round(seconds * 1000)) : '';
          sync();
        }, { type: 'number', min: 0, step: 0.5 }),
        h('span', { class: 'muted' }, 'วินาที'),
      ];
    }
    if (step.command === 'keyevent') {
      const known = WF_KEYS.some(([key]) => key === step.argument);
      return h('select', { class: 'field', onchange: (event) => setArgument(step)(event.target.value) },
        !known && h('option', { value: step.argument, selected: true }, step.argument),
        WF_KEYS.map(([key, label]) => h('option', { value: key, selected: key === step.argument }, label)));
    }
    if (step.command === 'open' || step.command === 'close') {
      const box = input(step.argument, setArgument(step), { class: 'field mono', placeholder: 'com.android.settings' });
      // `list` is a read-only property, so h() cannot assign it.
      box.setAttribute('list', 'wf-packages');
      return box;
    }
    if (step.command === 'text') return input(step.argument, setArgument(step), { placeholder: 'ข้อความที่จะพิมพ์' });
    if (step.command === 'run') {
      // A name with {3} in it runs the workflow named after that job's third value.
      const box = input(step.argument, setArgument(step), { placeholder: 'ชื่อเวิร์กโฟลว์ หรือ ธนาคาร-{3}' });
      box.setAttribute('list', 'wf-names');
      return box;
    }
    if (step.command === 'pin') {
      // "<set> [ms]": the keypad's position set, and the pause between keys.
      const [current = '', gap = ''] = step.argument.split(/\s+/);
      const names = Object.keys(S.pickSets).sort();
      const put = (set, pause) => { step.argument = `${set} ${pause}`.trim(); sync(); };
      return [
        h('select', { class: 'field', 'aria-label': 'ชุดตำแหน่งของปุ่มตัวเลข', onchange: (event) => put(event.target.value, step.argument.split(/\s+/)[1] || '') },
          !names.includes(current) && h('option', { value: current, selected: true }, current ? `${current} (ยังไม่มีชุดนี้)` : 'เลือกชุดปุ่มตัวเลข…'),
          names.map((name) => h('option', { value: name, selected: name === current }, name))),
        input(gap ? Number(gap) / 1000 : '', (value) => put(step.argument.split(/\s+/)[0] || '', value && Number(value) >= 0 ? String(Math.round(Number(value) * 1000)) : ''),
          { type: 'number', min: 0, step: 0.1, placeholder: '0.8', 'aria-label': 'เว้นระหว่างปุ่ม (วินาที)' }),
        h('span', { class: 'muted' }, 'วิ/ปุ่ม'),
      ];
    }
    if (step.command === 'pick') {
      // "<set> <name>": the set is chosen from the saved ones, the name is usually a job value.
      const parts = () => {
        const [set = '', ...rest] = step.argument.split(/\s+/);
        return { set, name: rest.join(' ') };
      };
      const names = Object.keys(S.pickSets).sort();
      const put = (next) => { step.argument = `${next.set} ${next.name}`.trim(); sync(); };
      return [
        h('select', { class: 'field', 'aria-label': 'ชุดตำแหน่ง', onchange: (event) => put({ ...parts(), set: event.target.value }) },
          !names.includes(parts().set) && h('option', { value: parts().set, selected: true }, parts().set ? `${parts().set} (ยังไม่มีชุดนี้)` : 'เลือกชุด…'),
          names.map((name) => h('option', { value: name, selected: name === parts().set }, name))),
        input(parts().name, (value) => put({ ...parts(), name: value.trim() }), { placeholder: '{3} หรือชื่อในชุด' }),
      ];
    }
    if (isGesture(step)) return gestureControl(step, sync);
    if (step.command === '#' || !WF_LABELS[step.command]) return input(step.argument, setArgument(step));
    return h('span', { class: 'grow' });
  };
  const move = (index, to) => change(() => steps.splice(to, 0, ...steps.splice(index, 1)));
  const tool = (label, title, disabled, onclick) => h('button', { class: 'btn ghost icon', title, 'aria-label': title, disabled, onclick }, label);
  const savePoint = async (step) => {
    if (!step.argument || step.argument.includes('?')) {
      toast(WF_NEEDS.tap, 'error');
      return;
    }
    const name = await promptDialog('บันทึกตำแหน่งนี้', `ตั้งชื่อให้ตำแหน่ง ${step.argument} เพื่อใช้ซ้ำในเวิร์กโฟลว์อื่น`, 'บันทึก', 'เช่น ปุ่มตกลง', step.note || '');
    if (!name) return;
    const points = await attempt(() => call('point:save', { name, value: step.argument }));
    if (!points) return;
    S.points = points;
    // The name doubles as the step's note when it has none.
    if (!step.note) {
      step.note = name;
      sync();
    }
    toast(`บันทึกตำแหน่ง "${name}" แล้ว`, 'success');
    renderInspector();
  };
  const deletePoint = async (name) => {
    if (!(await confirmDialog('ลบตำแหน่ง?', `ลบ "${name}" ออกจากตำแหน่งที่บันทึกไว้ เวิร์กโฟลว์ที่ใช้ไปแล้วไม่เปลี่ยน`, 'ลบ'))) return;
    const points = await attempt(() => call('point:delete', { name }));
    if (!points) return;
    S.points = points;
    renderInspector();
  };
  const pointNames = Object.keys(S.points).sort();

  return [
    h('datalist', { id: 'wf-packages' }, S.apps.list.map((pkg) => h('option', { value: pkg }))),
    h('datalist', { id: 'wf-names' }, Object.keys(S.workflows).sort().filter((name) => name !== wf.name).map((name) => h('option', { value: name }))),
    h('div', null,
      h('span', { class: 'label' }, 'ขั้นตอน (ทำจากบนลงล่าง)'),
      steps.length
        ? h('div', { class: 'wf-steps' }, steps.map((step, index) => h('div', { class: `wf-step ${isGesture(step) ? 'gesture' : ''}` },
          h('span', { class: 'num' }, index + 1),
          h('span', { class: 'name' }, (WF_SWIPES.find(([, argument]) => step.command === 'swipe' && step.argument === argument) || [])[0]
            || (step.command === 'swipe' && isLongPress(step.argument.split(/\s+/)) && 'กดค้าง') || WF_LABELS[step.command] || step.command),
          control(step),
          step.command === 'tap' && tool('☆', 'บันทึกตำแหน่งนี้ไว้ใช้ซ้ำ', false, () => savePoint(step)),
          tool('↑', 'เลื่อนขึ้น', index === 0, () => move(index, index - 1)),
          tool('↓', 'เลื่อนลง', index === steps.length - 1, () => move(index, index + 1)),
          tool('✕', 'ลบขั้นตอนนี้', false, () => change(() => steps.splice(index, 1))),
          step.command !== '#' && input(step.note || '', (value) => { step.note = value.replace(/\s+/g, ' ').trim(); sync(); },
            { class: 'field wf-note', placeholder: 'โน้ต: ขั้นนี้ทำอะไร', maxLength: 80, 'aria-label': `โน้ตของขั้นที่ ${index + 1}` }))))
        : h('div', { class: 'muted' }, 'ยังไม่มีขั้นตอน กดปุ่มด้านล่างเพื่อเพิ่ม')),
    h('div', { class: 'section' },
      h('h3', null, 'เพิ่มขั้นตอน'),
      h('p', { class: 'hint' }, 'ชื่อแพ็กเกจของแอปดูได้ที่แท็บ "แอป" · "รันเวิร์กโฟลว์ย่อย" ใส่ชื่อแบบ ธนาคาร-{3} ได้: แต่ละงานจะรันเวิร์กโฟลว์ที่ชื่อตรงกับข้อมูลช่อง 3 ถ้าไม่มีชื่อนั้น งานจะไม่เริ่ม'),
      h('div', { class: 'button-grid' },
        WF_STEPS.map(([command, label]) => h('button', {
          class: 'btn', onclick: () => change(() => steps.push({ command, argument: command === 'pin' ? (S.pick.set || Object.keys(S.pickSets).sort()[0] || '') : command === 'pick' ? `${S.pick.set || Object.keys(S.pickSets).sort()[0] || 'ชุด'} {3}` : WF_DEFAULTS[command] || '' })),
        }, `+ ${label}`)),
        WF_SWIPES.map(([label, argument]) => h('button', {
          class: 'btn', onclick: () => change(() => steps.push({ command: 'swipe', argument })),
        }, `+ ${label}`)),
        // The keyboard's own "เรียบร้อย" (Done) key: Enter in a one-line box does what that key does.
        h('button', {
          class: 'btn', title: 'กดปุ่ม "เรียบร้อย" ของแป้นพิมพ์บนมือถือ เพื่อจบการพิมพ์ในช่องที่โฟกัสอยู่',
          onclick: () => change(() => steps.push({ command: 'keyevent', argument: 'KEYCODE_ENTER', note: 'เรียบร้อย' })),
        }, '+ เรียบร้อย'),
        WF_INPUTS.map((number) => h('button', {
          class: 'btn', title: 'พิมพ์ค่าที่ส่งมากับงานจากเว็บ ลงช่องที่โฟกัสอยู่',
          onclick: () => change(() => steps.push({ command: 'text', argument: `{${number}}`, note: inputLabel(number) })),
        }, `+ พิมพ์${inputLabel(number)}`))),
      h('button', { class: 'btn primary block wf-record', onclick: () => openRecorder(wf) }, 'บันทึกการแตะและปัดจากหน้าจอเครื่อง'),
      h('button', { class: `btn block wf-record ${S.rec ? 'danger' : ''}`, onclick: toggleTouchRecording },
        S.rec ? 'หยุดบันทึกจากตัวเครื่อง' : 'บันทึกตามที่กดบนตัวเครื่องจริง')),
    pickSection((step) => change(() => steps.push(step))),
    h('div', { class: 'section' },
      h('h3', null, 'ตำแหน่งที่บันทึกไว้'),
      h('p', { class: 'hint' }, 'กด ☆ ที่ขั้น "แตะ" เพื่อบันทึกตำแหน่ง X, Y พร้อมโน้ต แล้วกดชื่อที่นี่เพื่อเพิ่มขั้นแตะพร้อมโน้ตเดิม'),
      pointNames.length
        ? h('div', { class: 'wf-points' }, pointNames.map((name) => h('div', { class: 'wf-point' },
          h('button', { class: 'btn', onclick: () => change(() => steps.push({ command: 'tap', argument: S.points[name], note: name })) }, `+ แตะ ${name}`),
          h('span', { class: 'mono muted' }, S.points[name]),
          tool('✕', `ลบตำแหน่ง ${name}`, false, () => deletePoint(name)))))
        : h('div', { class: 'muted' }, 'ยังไม่มีตำแหน่งที่บันทึกไว้')),
  ];
}

/** Follow the touches made on the focused phone itself and append them to the workflow as they happen. */
async function toggleTouchRecording() {
  if (S.rec) {
    await attempt(() => call('touch:stop', { serial: S.rec.serial }));
    return;
  }
  const device = focusDevice();
  if (!device || !device.online) {
    toast('เลือกเครื่องที่ออนไลน์ 1 เครื่องก่อน แล้วกดบันทึกอีกครั้ง', 'error');
    return;
  }
  // An empty workflow starts from the home screen, on the phone now and in the steps for replay.
  const fromHome = !S.wf.raw && !workflowSteps(S.wf.text).length;
  if (!(await attempt(() => call('touch:start', { serial: device.serial, fromHome })))) return;
  if (fromHome) {
    S.wf.text = 'wake\nwait 500\nhome\nwait 1000';
    toast('เริ่มจากหน้าแรกของเครื่อง เพื่อให้รันซ้ำได้ตรงทุกครั้ง');
  }
  S.rec = { serial: device.serial, label: device.name || device.model || device.serial, count: 0 };
  renderInspector();
}

// A kept PIN is drawn as dots of one length, so the dots do not tell how long it is.
const PIN_HIDDEN = '••••••';
const PIN_SHOW_MS = 15000;
let pinHideTimer = null;

const pickPageLabel = (page) => (page ? `หน้า ${page} (เลื่อน ${page} ครั้ง)` : 'หน้า 0 (ไม่เลื่อน)');

/** Start or stop taking positions for one page of a set from taps on the phone itself. */
async function togglePickRecording(set, page) {
  if (S.pick.rec) {
    await attempt(() => call('touch:stop', { serial: S.pick.rec.serial }));
    return;
  }
  const device = focusDevice();
  if (!device || !device.online || S.rec) {
    toast(S.rec ? 'หยุดการบันทึกเวิร์กโฟลว์ก่อน' : 'เลือกเครื่องที่ออนไลน์ 1 เครื่องก่อน', 'error');
    return;
  }
  const serial = device.serial;
  // The list is scrolled the way a run scrolls it, so a position taken here is the one a run finds.
  if (page && !(await attempt(() => call('pick:goto', { serial, set, page })))) return;
  if (!(await attempt(() => call('touch:start', { serial, fromHome: false })))) return;
  S.pick.rec = { serial, set, page, label: device.name || device.model || device.serial, asking: false };
  renderInspector();
}

/** One tap on the phone while positions are being taken: ask what it is, and keep it. */
async function keepPickTap(at) {
  const rec = S.pick.rec;
  // A tap made while the name of the one before is being asked for is not a position.
  if (!rec || rec.asking) return;
  rec.asking = true;
  // The job on the back-office page names what is being paid to; offer it.
  const fromJob = S.jobs && S.jobs.open ? ((await call('jobs:read').catch(() => [])) || [])[2] || '' : '';
  const name = await promptDialog('ตำแหน่งนี้คืออะไร', `แตะที่ ${at} · ${pickPageLabel(rec.page)}\nใส่ชื่อให้ตรงกับที่หน้าเว็บเขียน เช่น ธนาคารกสิกรไทย`, 'บันทึก', 'ชื่อ', fromJob);
  rec.asking = false;
  if (!name || !name.trim()) return;
  const sets = await attempt(() => call('pick:save', { set: rec.set, name: name.trim(), page: rec.page, at }));
  if (!sets) return;
  S.pickSets = sets;
  toast(`บันทึก "${name.trim()}" แล้ว · เปิดรายการบนมือถืออีกครั้ง แล้วแตะตัวถัดไป`, 'success');
  if (S.view === 'workflow') renderInspector();
}

/** Position sets: where each name of a list on the phone is, shown three to a row like the phone. */
function pickSection(addStep) {
  const names = Object.keys(S.pickSets).sort();
  if (!names.includes(S.pick.set)) Object.assign(S.pick, { set: names[0] || '', pages: 1 });
  const set = S.pickSets[S.pick.set];
  const rec = S.pick.rec;
  const apply = async (request) => {
    const sets = await attempt(request);
    if (sets) S.pickSets = sets;
    renderInspector();
    return sets;
  };
  const items = set ? Object.entries(set.items).map(([name, item]) => [name, { also: [], ...item }]) : [];
  const pages = Math.max(S.pick.pages, ...items.map(([, item]) => item.page + 1), rec ? rec.page + 1 : 1);
  // Top to bottom, then left to right: the order the phone shows them in.
  const place = ([, item]) => item.at.split(/\s+/).map((part) => Number.parseFloat(part) || 0);
  const ordered = (page) => items.filter(([, item]) => item.page === page).sort((a, b) => {
    const [ax, ay] = place(a);
    const [bx, by] = place(b);
    return Math.abs(ay - by) > 3 ? ay - by : ax - bx;
  });
  return h('div', { class: 'section' },
    h('h3', null, 'ชุดตำแหน่ง (เลือกจากรายการตามชื่อ)'),
    h('p', { class: 'hint' }, 'ใช้กับรายการบนมือถือที่ต้องเลือกต่างกันในแต่ละงาน เช่น ธนาคารผู้รับ ขั้น "แตะตามชุดตำแหน่ง" จะเลื่อนไปหน้าของชื่อนั้นแล้วแตะ ชื่อที่ไม่มีในชุด งานจะไม่เริ่ม'),
    h('div', { class: 'row wrap' },
      names.length > 0 && h('select', { class: 'field pick-set', 'aria-label': 'ชุดตำแหน่ง', disabled: Boolean(rec), onchange: (event) => { Object.assign(S.pick, { set: event.target.value, pages: 1 }); renderInspector(); } },
        names.map((name) => h('option', { value: name, selected: name === S.pick.set }, `${name} (${Object.keys(S.pickSets[name].items).length})`))),
      h('button', {
        class: 'btn',
        disabled: Boolean(rec),
        onclick: async () => {
          const name = await promptDialog('ชุดตำแหน่งใหม่', 'ตั้งชื่อชุด ไม่มีช่องว่าง เช่น ธนาคาร', 'สร้าง', 'ธนาคาร');
          if (!name || !name.trim()) return;
          if (await apply(() => call('pick:save', { set: name.trim() }))) Object.assign(S.pick, { set: name.trim(), pages: 1 });
          renderInspector();
        },
      }, '+ ชุดใหม่'),
      set && h('button', { class: 'btn', onclick: () => addStep({ command: 'pick', argument: `${S.pick.set} {3}`, note: `เลือก${S.pick.set}ตาม${inputLabel(3)}` }) }, '+ ใส่ในเวิร์กโฟลว์'),
      set && h('button', {
        class: 'btn',
        disabled: Boolean(rec),
        onclick: async () => {
          const name = await promptDialog('เปลี่ยนชื่อชุด', 'ไม่มีช่องว่าง เวิร์กโฟลว์ที่บันทึกไว้และใช้ชุดนี้จะถูกแก้ชื่อตามให้', 'เปลี่ยนชื่อ', 'ธนาคาร', S.pick.set);
          if (!name || !name.trim() || name.trim() === S.pick.set) return;
          const result = await attempt(() => call('pick:rename', { set: S.pick.set, newName: name.trim() }));
          if (!result) return;
          // The workflow being edited may use the set too; it is not saved yet, so fix it here.
          const old = S.pick.set;
          S.wf.text = workflowText(workflowSteps(S.wf.text).map((step) => (step.command === 'pick' && step.argument.split(/\s+/)[0] === old
            ? { ...step, argument: [name.trim(), ...step.argument.split(/\s+/).slice(1)].join(' ') } : step)));
          Object.assign(S, { pickSets: result.sets, workflows: result.workflows });
          S.pick.set = name.trim();
          renderInspector();
        },
      }, 'เปลี่ยนชื่อชุด'),
      set && h('button', {
        class: 'btn danger',
        disabled: Boolean(rec),
        onclick: async () => {
          if (await confirmDialog('ลบชุดตำแหน่ง?', `ลบชุด "${S.pick.set}" และตำแหน่งทั้ง ${items.length} ตำแหน่ง เวิร์กโฟลว์ที่ใช้ชุดนี้จะรันไม่ได้`, 'ลบ')) apply(() => call('pick:delete', { set: S.pick.set }));
        },
      }, 'ลบชุด')),
    rec && h('div', { class: 'targets recording' },
      h('span', { class: 'dot busy' }),
      h('span', { class: 'grow' }, `กำลังเก็บตำแหน่ง ${pickPageLabel(rec.page)} จาก ${rec.label} · แตะรายการบนตัวเครื่องทีละตัว แล้วใส่ชื่อ`),
      rec.page > 0 && h('button', { class: 'btn', title: 'เปิดรายการที่บนสุดก่อน แล้วกดปุ่มนี้', onclick: () => attempt(() => call('pick:goto', { serial: rec.serial, set: rec.set, page: rec.page })) }, 'เลื่อนไปหน้านี้อีกครั้ง'),
      h('button', { class: 'btn danger', onclick: () => togglePickRecording() }, 'หยุดเก็บ')),
    set && Array.from({ length: pages }, (unused, page) => h('div', { class: 'stack pick-page' },
      h('div', { class: 'row wrap' },
        h('span', { class: 'label grow' }, pickPageLabel(page)),
        h('button', {
          class: 'btn',
          disabled: Boolean(rec),
          title: page ? 'เปิดรายการบนมือถือที่บนสุดไว้ก่อน แอปจะเลื่อนให้เอง' : 'เปิดรายการบนมือถือที่บนสุดไว้ก่อน',
          onclick: () => togglePickRecording(S.pick.set, page),
        }, 'เก็บตำแหน่งจากตัวเครื่อง'),
        h('button', {
          class: 'btn',
          disabled: Boolean(rec),
          title: 'ใส่ชื่อและค่า X, Y ที่มีอยู่แล้ว เช่น จากขั้น "แตะ" ในเวิร์กโฟลว์',
          onclick: async () => {
            const name = await promptDialog('เพิ่มตำแหน่งเอง', `${pickPageLabel(page)}\nชื่อของตำแหน่ง เช่น 1 สำหรับปุ่มเลข 1 หรือชื่อธนาคาร`, 'ถัดไป', 'ชื่อ');
            if (!name || !name.trim()) return;
            const at = await promptDialog(`ตำแหน่งของ "${name.trim()}"`, 'ค่า X และ Y เป็นเปอร์เซ็นต์ของจอ คั่นด้วยช่องว่าง', 'บันทึก', '15.2% 58.2%');
            if (!at || !at.trim()) return;
            // "15.2 58.2" is taken as percentages, the way the tap steps show them.
            const position = at.trim().split(/[\s,]+/).map((part) => (/^\d+(\.\d+)?$/.test(part) ? `${part}%` : part)).join(' ');
            apply(() => call('pick:save', { set: S.pick.set, name: name.trim(), page, at: position }));
          },
        }, '+ เพิ่มตำแหน่งเอง')),
      ordered(page).length
        ? h('div', { class: 'pick-grid' }, ordered(page).map(([name, item]) => h('div', { class: 'pick-cell' },
          h('div', { class: 'grow' },
            h('div', { class: 'pick-name' }, name),
            item.also.length > 0 && h('div', { class: 'muted pick-also', title: item.also.join(', ') }, `= ${item.also.join(', ')}`),
            h('div', { class: 'mono muted' }, item.at)),
          h('button', {
            class: 'btn ghost icon',
            title: `แก้ชื่อ ${name}`,
            'aria-label': `แก้ชื่อ ${name}`,
            disabled: Boolean(rec),
            onclick: async () => {
              const newName = await promptDialog('ชื่อของตำแหน่งนี้', 'ชื่อที่แสดงในตาราง ใช้ตัวย่อได้', 'ถัดไป', 'ชื่อ', name);
              if (!newName || !newName.trim()) return;
              const also = await promptDialog('ชื่ออื่นที่หมายถึงตำแหน่งนี้', 'ใส่คำที่หน้าเว็บอาจเขียน คั่นด้วยจุลภาค เว้นว่างได้\nชื่อธนาคารไทยที่รู้จัก แอปจับคู่ให้เองอยู่แล้ว เช่น KBANK กับ ธนาคารกสิกรไทย', 'บันทึก', 'เช่น กสิกร, K-Bank', item.also.join(', '));
              if (also === null) return;
              apply(() => call('pick:edit', { set: S.pick.set, name, newName: newName.trim(), also: also.split(',').map((word) => word.trim()).filter(Boolean) }));
            },
          }, '✎'),
          h('button', { class: 'btn ghost icon', title: `ลบ ${name}`, 'aria-label': `ลบ ${name}`, onclick: () => apply(() => call('pick:delete', { set: S.pick.set, name })) }, '✕'))))
        : h('div', { class: 'muted' }, 'ยังไม่มีตำแหน่งในหน้านี้'))),
    set && h('div', { class: 'row wrap' },
      h('button', { class: 'btn', disabled: Boolean(rec), onclick: () => { S.pick.pages = pages + 1; renderInspector(); } }, '+ เพิ่มหน้า'),
      field('การปัดที่ใช้เลื่อน 1 หน้า (จาก X Y ไป X Y เวลา ms)', h('input', {
        class: 'field mono', spellcheck: false, value: set.scroll, disabled: Boolean(rec),
        onchange: (event) => apply(() => call('pick:scroll', { set: S.pick.set, value: event.target.value })),
      }))));
}

// A swipe that ends where it started is how Android is told to press and hold.
const isLongPress = (parts) => parts.length >= 4 && parts[0] === parts[2] && parts[1] === parts[3];

function stepText({ command, argument }) {
  const parts = argument.split(/\s+/);
  if (command === 'swipe' && isLongPress(parts)) return `กดค้างที่ X ${parts[0]}, Y ${parts[1]} นาน ${(Number(parts[4]) || 300) / 1000} วินาที`;
  if (command === 'wait') return `รอ ${Number(argument) / 1000} วินาที`;
  if (command === 'open') return `เปิดแอป ${argument}`;
  if (command === 'close') return `ปิดแอป ${argument}`;
  if (command === 'text') return `พิมพ์ "${argument}"`;
  if (command === 'keyevent') return `กดปุ่ม ${(WF_KEYS.find(([key]) => key === argument) || [])[1] || argument}`;
  if (command === 'tap') return `แตะที่ X ${parts[0]}, Y ${parts[1]}`;
  if (command === 'swipe') {
    const preset = WF_SWIPES.find(([, value]) => value === argument);
    return preset ? preset[0] : `ปัดจาก ${parts[0]}, ${parts[1]} ไป ${parts[2]}, ${parts[3]}`;
  }
  return WF_LABELS[command] || command;
}

/** What the last run did on each device, one row per step, in the order the steps started. */
function workflowTimeline(timeline) {
  const state = (row) => {
    const seconds = `${(row.ms / 1000).toFixed(1)} วิ`;
    if (row.status === 'running') return 'กำลังทำ…';
    return row.status === 'ok' ? `สำเร็จ · ${seconds}` : `ล้มเหลว · ${seconds}`;
  };
  return h('div', { class: 'section wf-timeline' },
    h('h3', null, `ไทม์ไลน์ · ${timeline.name}${timeline.running ? ' · กำลังรัน…' : ''}`),
    timeline.rows.length
      ? timeline.rows.map((row) => h('div', { class: `tl-row ${row.status}` },
        h('span', { class: 'mono muted' }, timeOf(row.at)),
        h('div', { class: 'grow' },
          h('div', null, `${row.index + 1}/${row.total} · ${row.note ? `${row.note} · ` : ''}${stepText(row)}`),
          h('div', { class: 'muted' }, [row.label, row.detail].filter(Boolean).join(' · '))),
        h('span', { class: 'tl-state' }, state(row))))
      : h('div', { class: 'muted' }, timeline.running ? 'กำลังเริ่ม…' : 'ไม่มีขั้นตอนที่ถูกรัน'));
}

function showTimeline() {
  const section = document.querySelector('.wf-timeline');
  if (section) section.scrollIntoView({ block: 'nearest' });
}

/** X and Y boxes for a tap or swipe. An empty box is stored as `?`, so a half-typed step survives a re-render. */
function gestureControl(step, sync) {
  const count = step.command === 'tap' ? 2 : 4;
  const parts = step.argument.split(/\s+/).filter(Boolean);
  const values = Array.from({ length: count }, (_, index) => (parts[index] || '').replace(/[%?]/g, ''));
  const duration = parts.slice(count);
  let unit = parts.slice(0, count).some((part) => part.endsWith('%')) ? '%' : 'px';
  const tidy = (value) => {
    const number = Number(value);
    if (value === '' || !(number >= 0)) return '';
    return String(unit === '%' ? Math.round(number * 10) / 10 : Math.round(number));
  };
  const write = () => {
    step.argument = values.every((value) => value === '')
      ? ''
      : [...values.map((value) => (value === '' ? '?' : unit === '%' ? `${value}%` : value)), ...duration].join(' ');
    sync();
  };
  const box = (index) => {
    const label = `${count === 4 ? (index < 2 ? 'จาก ' : 'ไป ') : ''}${index % 2 ? 'Y' : 'X'}`;
    return input(values[index], (value) => { values[index] = tidy(value); write(); },
      { type: 'number', min: 0, placeholder: index % 2 ? 'Y' : 'X', title: label, 'aria-label': label });
  };
  return h('div', { class: 'wf-xy' },
    box(0), box(1),
    count === 4 && [h('span', { class: 'muted' }, 'ไป'), box(2), box(3)],
    h('select', {
      class: 'field', title: 'หน่วย: px = พิกเซลบนจอ, % = สัดส่วนของจอ', 'aria-label': 'หน่วย',
      onchange: (event) => { unit = event.target.value; values.forEach((value, index) => { values[index] = tidy(value); }); write(); },
    }, ['px', '%'].map((name) => h('option', { value: name, selected: name === unit }, name))));
}

/**
 * Record taps and swipes by pointing at a picture of the focused device's screen. A click adds a
 * tap, a drag adds a swipe. While "live" is on, each gesture is also sent to that device and the
 * picture refreshes, so the user walks through the real screens.
 */
function openRecorder(wf) {
  const device = focusDevice();
  if (!device || !device.online) {
    toast('เลือกเครื่องที่ออนไลน์ 1 เครื่องก่อน แล้วกดบันทึกอีกครั้ง', 'error');
    return;
  }
  let live = true;
  let busy = false;
  let start = null;
  let lastAt = 0;
  let count = 0;
  // h() skips false props, so stop the browser's own image drag here: it would cancel the swipe.
  const img = h('img', { class: 'rec-screen', alt: 'หน้าจอเครื่อง', ondragstart: (event) => event.preventDefault() });
  const status = h('p', null, 'กำลังโหลดภาพหน้าจอ…');
  const say = (message, failed) => { status.textContent = message; status.className = failed ? 'error' : ''; };
  const idle = () => say(count ? `บันทึกแล้ว ${count} ขั้นตอน · คลิกหรือลากบนภาพต่อได้` : 'คลิกบนภาพ = แตะ · ลากบนภาพ = ปัด');
  let size = null;
  const position = h('div', { class: 'rec-pos mono muted' }, 'ชี้บนภาพเพื่อดูตำแหน่ง X, Y');
  const load = async (step) => {
    busy = true;
    try {
      size = await call('workflow:record', { serial: device.serial, step });
      img.src = size.dataUrl;
      idle();
    } catch (error) {
      say(error.message, true);
    }
    busy = false;
  };
  const point = (event) => {
    const box = img.getBoundingClientRect();
    return { x: clamp(((event.clientX - box.left) / box.width) * 100, 0, 100), y: clamp(((event.clientY - box.top) / box.height) * 100, 0, 100), at: Date.now() };
  };
  const percent = (value) => `${Math.round(value * 10) / 10}%`;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    renderInspector();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  img.addEventListener('pointermove', (event) => {
    if (!size) return;
    const at = point(event);
    const pixel = (value, span) => Math.min(span - 1, Math.round((value / 100) * span));
    position.textContent = `X ${pixel(at.x, size.width)}, Y ${pixel(at.y, size.height)} px · ${percent(at.x)}, ${percent(at.y)} · จอ ${size.width}x${size.height}`;
  });
  img.addEventListener('pointerdown', (event) => {
    if (busy || !img.src) return;
    start = point(event);
    img.setPointerCapture(event.pointerId);
  });
  img.addEventListener('pointerup', (event) => {
    if (!start) return;
    const from = start;
    const to = point(event);
    start = null;
    const line = Math.hypot(to.x - from.x, to.y - from.y) > 3
      ? `swipe ${percent(from.x)} ${percent(from.y)} ${percent(to.x)} ${percent(to.y)} ${clamp(to.at - from.at, 100, 3000)}`
      : `tap ${percent(from.x)} ${percent(from.y)}`;
    const steps = workflowSteps(wf.text);
    // Replay needs the pause the user took, which also covers the screen loading.
    if (lastAt) steps.push({ command: 'wait', argument: String(live ? clamp(Math.round((from.at - lastAt) / 500) * 500, 500, 10000) : 1000) });
    steps.push(...workflowSteps(line));
    Object.assign(wf, { text: workflowText(steps), preview: null });
    count += 1;
    lastAt = to.at;
    if (live) {
      say('กำลังส่งไปที่เครื่อง…');
      load(line);
    } else idle();
  });

  const backdrop = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal recorder', role: 'dialog', 'aria-modal': 'true' },
      h('h3', null, `บันทึกจากหน้าจอ · ${device.name || device.model || device.serial}`),
      status,
      img,
      position,
      h('div', { class: 'row wrap' },
        toggle('ทำบนเครื่องจริงด้วย', live, (checked) => { live = checked; }),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => !busy && load() }, icon('refresh'), 'ภาพใหม่'),
        h('button', { class: 'btn primary', onclick: close }, 'เสร็จ'))));
  $('modal-root').append(backdrop);
  document.addEventListener('keydown', onKey);
  load();
}

// ── header, nav, footer ───────────────────────────────────────────────────

function renderHeader() {
  const online = S.devices.filter((device) => device.online).length;
  const status = S.scanning
    ? 'กำลังสแกน…'
    : S.scannedAt
      ? `ออนไลน์ ${online} · ไม่พร้อม ${S.devices.length - online} · สแกนล่าสุด ${timeOf(S.scannedAt)}`
      : 'ยังไม่ได้สแกน';
  const dark = root.dataset.theme === 'dark';
  $('header').replaceChildren(
    h('img', { class: 'logo', src: 'logo.svg', alt: '', draggable: false }),
    h('div', { class: 'brand' },
      h('h1', null, 'ADB-OneTwo'),
      h('div', { class: 'status' }, h('span', { class: `dot ${S.scanning ? 'busy' : online ? 'on' : ''}` }), status)),
    h('div', { class: 'spacer' }),
    // replaceChildren prints a bare `false`, unlike h(), so fall back to an empty string.
    S.update.status === 'updated' ? h('button', { class: 'btn update', onclick: restartForUpdate },
      `อัปเดต ${S.update.version} พร้อมแล้ว · รีสตาร์ต`) : '',
    toggle(`สแกนอัตโนมัติ ${S.config.auto_scan_interval_seconds || 15} วิ`, Boolean(S.config.auto_scan_enabled),
      async (checked) => { await setConfig({ auto_scan_enabled: checked }); renderHeader(); }),
    h('button', {
      class: 'btn icon ghost', title: dark ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด', 'aria-label': 'สลับธีม',
      onclick: async () => {
        root.dataset.theme = dark ? 'light' : 'dark';
        renderHeader();
        await setConfig({ theme: root.dataset.theme });
      },
    }, icon(dark ? 'sun' : 'moon')),
    h('button', { class: 'btn primary', disabled: S.scanning, onclick: () => attempt(() => call('devices:scan')) }, icon('refresh'), 'สแกนเครื่อง'),
  );
}

function renderNav() {
  $('nav').replaceChildren(...NAV.flatMap(([group, items]) => [
    h('div', { class: 'nav-group' }, group),
    ...items.map(([view, label, iconName]) => h('button', {
      class: `nav-item ${S.view === view ? 'active' : ''}`,
      'aria-current': S.view === view ? 'page' : null,
      onclick: () => setView(view),
    }, icon(iconName), label)),
  ]));
}

function renderFooter() {
  const job = S.job && S.job.running ? S.job : null;
  const bar = h('div');
  if (job) bar.style.width = `${Math.round((job.done / Math.max(1, job.total)) * 100)}%`;
  $('footer').replaceChildren(
    job ? h('div', { class: 'row' }, h('div', { class: 'progress' }, bar), `กำลังรัน ${job.label} ${job.done}/${job.total}`) : 'พร้อมใช้งาน',
    h('div', { class: 'spacer' }),
    h('span', { class: 'mono' }, S.tools.adb ? `ADB: ${S.tools.adb}` : 'ไม่พบ ADB'),
    h('span', null, `v${S.version}`),
  );
}

// ── devices pane ──────────────────────────────────────────────────────────

function deviceCard(device) {
  const thumb = S.thumbs[device.serial];
  const screen = device.online && thumb && thumb.dataUrl
    ? h('img', { src: thumb.dataUrl, alt: `หน้าจอ ${device.label}`, draggable: false })
    : !device.online ? statusLabel(device) : thumb && thumb.error ? 'จับภาพไม่สำเร็จ' : 'ยังไม่มีภาพหน้าจอ';
  return h('div', {
    class: `device-card ${S.selected.has(device.serial) ? 'selected' : ''}`,
    tabIndex: 0,
    title: thumb && thumb.error ? thumb.error : 'คลิกเพื่อเลือก · Ctrl+คลิก เลือกหลายเครื่อง · ดับเบิลคลิก เปิดหน้าจอสด',
    onclick: (event) => selectDevice(device.serial, event.ctrlKey || event.metaKey),
    ondblclick: () => attempt(() => call('live:open', { serials: [device.serial] })),
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectDevice(device.serial, event.ctrlKey);
      }
    },
  },
  h('div', { class: 'top' },
    h('span', { class: 'name' }, device.label),
    device.live && h('span', { class: 'badge live' }, 'สด'),
    h('span', { class: `badge ${statusClass(device)}` }, statusLabel(device))),
  h('div', { class: 'serial mono' }, device.serial),
  h('div', { class: 'screen' }, screen),
  h('div', { class: 'meta' },
    h('span', null, device.slot ? `ช่อง ${device.slot} · ${device.group}` : device.group),
    device.battery && h('span', null, `แบต ${device.battery}`),
    device.temperature && h('span', null, device.temperature.replace('C', '°C'))));
}

function deviceTable() {
  return h('table', null,
    h('thead', null, h('tr', null, ['ช่อง', 'ชื่อ', 'กลุ่ม', 'สถานะ', 'Android', 'แบต', 'Serial'].map((title) => h('th', null, title)))),
    h('tbody', null, S.devices.map((device) => h('tr', {
      class: S.selected.has(device.serial) ? 'selected' : '',
      onclick: (event) => selectDevice(device.serial, event.ctrlKey || event.metaKey),
      ondblclick: () => attempt(() => call('live:open', { serials: [device.serial] })),
    },
    h('td', null, device.slot || '—'),
    h('td', null, device.label),
    h('td', null, device.group),
    h('td', null, h('span', { class: `badge ${statusClass(device)}` }, statusLabel(device))),
    h('td', null, device.android || '—'),
    h('td', null, device.battery || '—'),
    h('td', { class: 'mono' }, device.serial)))));
}

/**
 * Remember how far everything in and around `root` is scrolled; the function it returns puts it all
 * back after `root` has been drawn again. What is inside is found again by its place in the tree.
 */
function keepScroll(root) {
  const placeOf = (el) => {
    const place = [];
    for (let each = el; each !== root; each = each.parentElement) place.unshift([...each.parentElement.children].indexOf(each));
    return place;
  };
  const inside = [...root.querySelectorAll('*')].filter((el) => el.scrollTop || el.scrollLeft).map((el) => [placeOf(el), el.scrollTop, el.scrollLeft]);
  const around = [];
  for (let each = root; each; each = each.parentElement) around.push([each, each.scrollTop, each.scrollLeft]);
  return () => {
    for (const [place, top, left] of inside) {
      const el = place.reduce((at, index) => at && at.children[index], root);
      if (el) el.scrollTo(left, top);
    }
    for (const [el, top, left] of around) el.scrollTo(left, top);
  };
}

function renderDevices() {
  const restore = keepScroll($('devices-pane'));
  const online = S.devices.filter((device) => device.online).length;
  const cards = S.config.device_view !== 'list';
  const setDeviceView = async (view) => { await setConfig({ device_view: view }); renderDevices(); };
  const body = !S.devices.length
    ? h('div', { class: 'empty' }, h('strong', null, 'ยังไม่พบเครื่อง'),
      'เสียบมือถือผ่าน USB เปิด USB debugging แล้วกด "สแกนเครื่อง"')
    : cards ? h('div', { class: 'device-grid' }, S.devices.map(deviceCard)) : deviceTable();
  $('devices-pane').replaceChildren(
    h('div', { class: 'pane-head' },
      h('div', { class: 'grow' }, h('h2', null, 'อุปกรณ์'),
        h('p', null, `ออนไลน์ ${online} จาก ${S.devices.length} เครื่อง${S.selected.size ? ` · เลือก ${S.selected.size}` : ''}`)),
      h('div', { class: 'segment', role: 'tablist' },
        h('button', { class: cards ? 'active' : '', onclick: () => setDeviceView('cards') }, 'การ์ด'),
        h('button', { class: cards ? '' : 'active', onclick: () => setDeviceView('list') }, 'ตาราง'))),
    h('div', { class: 'toolbar' },
        h('button', { class: 'btn', onclick: () => refreshScreens() }, icon('refresh'), 'ภาพหน้าจอ'),
        toggle('ภาพอัตโนมัติ', S.thumbAuto, (checked) => { S.thumbAuto = checked; applyThumbAuto(); }),
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn ghost',
          onclick: () => {
            const all = S.devices.filter((device) => device.online).map((device) => device.serial);
            S.selected = S.selected.size === all.length ? new Set() : new Set(all);
            S.focus = [...S.selected][0] || null;
            renderDevices();
            renderInspector();
          },
        }, S.selected.size && S.selected.size === online ? 'ยกเลิกเลือก' : 'เลือกทั้งหมด')),
    h('div', { class: 'pane-body' }, body),
  );
  restore();
}

// ── inspector views ───────────────────────────────────────────────────────

const VIEWS = {
  info() {
    const device = focusDevice();
    if (!device) return h('div', { class: 'empty' }, h('strong', null, 'เลือกเครื่องเพื่อดูข้อมูล'), 'คลิกการ์ดหรือแถวในรายการอุปกรณ์');
    const draft = S.infoDraft[device.serial] || (S.infoDraft[device.serial] = { name: device.name, group: device.group, slot: device.slot });
    return h('div', { class: 'stack' },
      h('div', { class: 'section' },
        h('dl', { class: 'facts' }, [
          ['Serial', h('span', { class: 'mono' }, device.serial)],
          ['สถานะ', h('span', { class: `badge ${statusClass(device)}` }, statusLabel(device))],
          ['รุ่น', device.model || '—'],
          ['Product', device.product || '—'],
          ['Android', device.android ? `${device.android} (SDK ${device.sdk || '?'})` : '—'],
          ['แบตเตอรี่', device.battery || '—'],
          ['กำลังชาร์จ', device.charging === 'yes' ? 'ใช่' : device.charging === 'no' ? 'ไม่' : '—'],
          ['อุณหภูมิ', device.temperature ? device.temperature.replace('C', ' °C') : '—'],
          ['เห็นล่าสุด', device.lastSeen ? timeOf(device.lastSeen) : '—'],
        ].flatMap(([term, value]) => [h('dt', null, term), h('dd', null, value)]))),
      h('div', { class: 'section' },
        h('h3', null, 'ชื่อเรียกและการจัดกลุ่ม'),
        h('div', { class: 'stack' },
          field('ชื่อเครื่อง', input(draft.name, (value) => { draft.name = value; }, { placeholder: device.model || device.serial })),
          h('div', { class: 'form-grid' },
            field('กลุ่ม', input(draft.group, (value) => { draft.group = value; }, { placeholder: 'Default' })),
            field('ช่อง (slot)', input(draft.slot, (value) => { draft.slot = value; }, { placeholder: 'เช่น A1' }))),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              const devices = await attempt(() => call('device:meta', { serial: device.serial, ...draft }));
              if (!devices) return;
              S.devices = devices;
              delete S.infoDraft[device.serial];
              toast('บันทึกแล้ว', 'success');
              renderDevices();
              renderInspector();
            },
          }, 'บันทึก'))),
      h('div', { class: 'section' },
        h('h3', null, 'บัญชีที่เครื่องนี้ใช้จ่าย'),
        h('p', { class: 'hint' }, 'ใส่บัญชีธนาคารของแอปบนเครื่องนี้ หลังโอน แอปตรวจว่าสลิปออกจากบัญชีนี้จริง เพดานและยอดคงเหลือเว้นว่างได้ = ไม่ตรวจ ยอดคงเหลือถูกหักเองทุกครั้งที่โอนสำเร็จ'),
        h('div', { class: 'stack' },
          h('div', { class: 'form-grid' },
            field('ธนาคาร', h('input', { class: 'field', id: 'pay-bank', value: device.pay.bank, placeholder: 'เช่น ธนาคารกรุงเทพ หรือ BBL', spellcheck: false })),
            field('เลขบัญชี', h('input', { class: 'field mono', id: 'pay-account', value: device.pay.account, inputMode: 'numeric', placeholder: 'ตัวเลขล้วน', spellcheck: false }))),
          field('ชื่อบัญชี', h('input', { class: 'field', id: 'pay-holder', value: device.pay.holder, spellcheck: false })),
          h('div', { class: 'form-grid' },
            field('เพดานต่อวัน (บาท)', h('input', { class: 'field', id: 'pay-cap', type: 'number', min: 0, value: device.pay.cap ?? '', placeholder: 'ว่าง = ไม่จำกัด' })),
            field('ยอดคงเหลือสำรอง (บาท) ใช้เมื่ออ่านจากหลังบ้านไม่ได้', h('input', { class: 'field', id: 'pay-balance', type: 'number', min: 0, step: 0.01, value: device.pay.balance ?? '', placeholder: 'ว่าง = ไม่ตรวจ' }))),
          field('ตัวคูณเวลารอของเวิร์กโฟลว์บนเครื่องนี้ (1 = ปกติ, 1.5 = รอนานขึ้นครึ่งเท่า สำหรับเครื่องหรือเน็ตช้า)', h('input', { class: 'field', id: 'pay-scale', type: 'number', min: 0.5, max: 5, step: 0.1, value: device.pay.scale })),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              const devices = await attempt(() => call('device:account', { serial: device.serial, bank: $('pay-bank').value, account: $('pay-account').value, holder: $('pay-holder').value, cap: $('pay-cap').value, balance: $('pay-balance').value, scale: $('pay-scale').value }));
              if (!devices) return;
              S.devices = devices;
              toast('บันทึกบัญชีของเครื่องแล้ว', 'success');
              renderDevices();
              renderInspector();
            },
          }, 'บันทึกบัญชี'))),
      h('div', { class: 'section' },
        h('h3', null, 'ช่วงยอดถอนที่เครื่องนี้จ่าย'),
        h('p', { class: 'hint' }, 'หน้า "รายการถอน" จะให้เครื่องนี้จ่ายเฉพาะรายการที่ยอดอยู่ในช่วงนี้ เครื่องที่ไม่ตั้งช่วงจะไม่จ่ายรายการใดเลย'),
        h('div', { class: 'row wrap' },
          h('span', { class: `badge ${device.amountMin !== null ? 'online' : ''}` }, device.amountMin !== null ? `${device.amountMin} ถึง ${device.amountMax} บาท` : 'ยังไม่ได้ตั้งช่วง'),
          h('input', { class: 'field pin-box', type: 'number', min: 1, step: 1, placeholder: 'ตั้งแต่ เช่น 100', value: device.amountMin ?? '', id: 'device-amount-min', 'aria-label': 'ยอดต่ำสุด' }),
          h('input', { class: 'field pin-box', type: 'number', min: 1, step: 1, placeholder: 'ไม่เกิน เช่น 499', value: device.amountMax ?? '', id: 'device-amount-max', 'aria-label': 'ยอดสูงสุด' }),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              const devices = await attempt(() => call('device:range', { serial: device.serial, min: $('device-amount-min').value, max: $('device-amount-max').value }));
              if (!devices) return;
              S.devices = devices;
              toast('บันทึกช่วงยอดแล้ว', 'success');
              renderDevices();
              renderInspector();
            },
          }, 'บันทึกช่วงยอด'))),
      h('div', { class: 'section' },
        h('h3', null, 'รหัส PIN ของแอปบนเครื่องนี้'),
        h('p', { class: 'hint' }, 'ขั้น "กดรหัส PIN" ในเวิร์กโฟลว์จะแตะปุ่มตัวเลขตามรหัสนี้ แต่ละเครื่องตั้งรหัสของตัวเองได้ รหัสถูกเข้ารหัสด้วย Windows ของบัญชีผู้ใช้นี้ และไม่เขียนลง log กดลูกตาเพื่อดูรหัสที่ตั้งไว้'),
        device.hasPin && h('div', { class: 'row wrap pin-kept' },
          h('span', { class: 'label' }, 'รหัสที่ตั้งไว้'),
          h('span', { class: 'mono pin-value', id: 'device-pin-kept', 'aria-live': 'polite' }, PIN_HIDDEN),
          // The PIN is asked for only when the eye is pressed, and goes back to dots by itself.
          h('button', {
            class: 'btn ghost icon',
            type: 'button',
            title: 'แสดงรหัสที่ตั้งไว้',
            'aria-label': 'แสดงรหัสที่ตั้งไว้',
            'aria-pressed': 'false',
            onclick: async (event) => {
              const button = event.currentTarget;
              const shown = $('device-pin-kept');
              const hide = () => {
                clearTimeout(pinHideTimer);
                // The view may have been drawn again since; only touch what is still on the page.
                if (shown.isConnected) shown.textContent = PIN_HIDDEN;
                button.textContent = '👁';
                button.title = 'แสดงรหัสที่ตั้งไว้';
                button.setAttribute('aria-label', button.title);
                button.setAttribute('aria-pressed', 'false');
              };
              if (button.getAttribute('aria-pressed') === 'true') {
                hide();
                return;
              }
              const pin = await attempt(() => call('device:pin-show', { serial: device.serial }));
              if (!pin || !shown.isConnected) return;
              shown.textContent = pin;
              button.textContent = '🙈';
              button.title = 'ซ่อนรหัสที่ตั้งไว้';
              button.setAttribute('aria-label', button.title);
              button.setAttribute('aria-pressed', 'true');
              clearTimeout(pinHideTimer);
              pinHideTimer = setTimeout(hide, PIN_SHOW_MS);
            },
          }, '👁')),
        h('div', { class: 'row wrap' },
          h('span', { class: `badge ${device.hasPin ? 'online' : ''}` }, device.hasPin ? 'ตั้งรหัสไว้แล้ว' : 'ยังไม่ได้ตั้งรหัส'),
          h('input', { class: 'field pin-box', type: 'password', inputMode: 'numeric', autocomplete: 'off', maxLength: 12, placeholder: device.hasPin ? 'รหัสใหม่' : 'รหัส 4-12 หลัก', id: 'device-pin', 'aria-label': 'รหัส PIN' }),
          // Shows what is being typed, to check it before it is kept. A PIN already kept cannot be shown.
          h('button', {
            class: 'btn ghost icon',
            type: 'button',
            title: 'แสดงรหัสที่พิมพ์',
            'aria-label': 'แสดงรหัสที่พิมพ์',
            'aria-pressed': 'false',
            onclick: (event) => {
              const box = $('device-pin');
              const show = box.type === 'password';
              box.type = show ? 'text' : 'password';
              const button = event.currentTarget;
              button.textContent = show ? '🙈' : '👁';
              button.title = show ? 'ซ่อนรหัสที่พิมพ์' : 'แสดงรหัสที่พิมพ์';
              button.setAttribute('aria-label', button.title);
              button.setAttribute('aria-pressed', String(show));
              box.focus();
            },
          }, '👁'),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              const box = $('device-pin');
              if (!/^\d{4,12}$/.test(box.value)) {
                toast('รหัสต้องเป็นตัวเลข 4-12 หลัก', 'error');
                return;
              }
              const devices = await attempt(() => call('device:pin', { serial: device.serial, pin: box.value }));
              box.value = '';
              if (!devices) return;
              S.devices = devices;
              toast('ตั้งรหัสแล้ว', 'success');
              renderInspector();
            },
          }, device.hasPin ? 'เปลี่ยนรหัส' : 'ตั้งรหัส'),
          device.hasPin && h('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!(await confirmDialog('ลบรหัส PIN?', 'เวิร์กโฟลว์ที่มีขั้น "กดรหัส PIN" จะรันบนเครื่องนี้ไม่ได้จนกว่าจะตั้งรหัสใหม่', 'ลบรหัส'))) return;
              const devices = await attempt(() => call('device:pin', { serial: device.serial, pin: '' }));
              if (!devices) return;
              S.devices = devices;
              renderInspector();
            },
          }, 'ลบรหัส'))));
  },

  actions() {
    const key = (label, name) => h('button', { class: 'btn', onclick: () => deviceAction('key', name) }, label);
    return h('div', { class: 'stack' },
      targetBanner(),
      h('div', { class: 'section' },
        h('h3', null, 'ปุ่มลัด'),
        h('div', { class: 'button-grid' },
          key('ย้อนกลับ', 'back'), key('โฮม', 'home'), key('แอปล่าสุด', 'recent'),
          key('ปลุกจอ', 'wake'), key('ปิดจอ', 'sleep'),
          h('button', {
            class: 'btn',
            onclick: async () => {
              const outcome = await deviceAction('screenshot');
              if (outcome && outcome.failed < outcome.results.length) attempt(() => call('folder:open', { which: 'captures' }));
            },
          }, 'ถ่ายภาพหน้าจอ'))),
      h('div', { class: 'section' },
        h('h3', null, 'ส่งข้อความ'),
        h('p', { class: 'hint' }, 'พิมพ์ลงช่องที่โฟกัสอยู่บนเครื่อง รองรับเฉพาะตัวอักษรอังกฤษ ตัวเลข และสัญลักษณ์ (ข้อจำกัดของ adb)'),
        h('div', { class: 'row' },
          input(S.actions.text, (value) => { S.actions.text = value; }, { placeholder: 'ข้อความ' }),
          h('button', { class: 'btn', onclick: () => deviceAction('text', S.actions.text) }, 'ส่ง'))),
      h('div', { class: 'section' },
        h('h3', null, 'เปิดแอป'),
        h('div', { class: 'row' },
          input(S.actions.pkg, (value) => { S.actions.pkg = value.trim(); }, { placeholder: 'com.example.app', class: 'field mono' }),
          h('button', { class: 'btn', onclick: () => deviceAction('open', S.actions.pkg) }, 'เปิด'))),
      h('div', { class: 'section' },
        h('h3', null, 'ย้ายกลุ่ม'),
        h('div', { class: 'row' },
          input(S.actions.group, (value) => { S.actions.group = value; }, { placeholder: 'ชื่อกลุ่ม' }),
          h('button', {
            class: 'btn',
            disabled: !S.selected.size,
            onclick: async () => {
              const devices = await attempt(() => call('device:group', { serials: targets(), group: S.actions.group }));
              if (!devices) return;
              S.devices = devices;
              S.infoDraft = {};
              renderDevices();
              toast('ย้ายกลุ่มแล้ว', 'success');
            },
          }, 'ตั้งกลุ่ม'))),
      h('div', { class: 'section' },
        h('h3', null, 'คำสั่งที่กระทบเครื่อง'),
        h('button', {
          class: 'btn danger',
          onclick: () => deviceAction('reboot', null, {
            confirm: { title: 'รีบูตเครื่อง?', message: `รีบูต ${onlineTargets().length} เครื่องที่เลือก งานที่ค้างบนเครื่องจะหยุด`, label: 'รีบูต' },
          }),
        }, 'รีบูต')));
  },

  live() {
    const profileNames = Object.keys(S.profiles);
    const profile = S.live.profile || S.config.scrcpy_profile || 'Balanced';
    const spec = S.profiles[profile] || {};
    const sessions = S.devices.filter((device) => device.live);
    const setDefault = async (scope) => {
      const data = await attempt(() => call('live:default', { scope, serials: targets(), profile }));
      if (!data) return;
      S.devices = data.devices;
      toast(scope === 'group' ? 'ตั้งค่าเริ่มต้นของกลุ่มแล้ว' : 'ตั้งค่าเริ่มต้นของเครื่องแล้ว', 'success');
    };
    return h('div', { class: 'stack' },
      targetBanner(),
      !S.tools.scrcpy && h('div', { class: 'targets none' }, 'ไม่พบ scrcpy ไปที่ "ตั้งค่า" เพื่อระบุตำแหน่ง scrcpy.exe'),
      h('div', { class: 'section' },
        h('h3', null, 'เปิดหน้าจอสด'),
        h('div', { class: 'stack' },
          field('โปรไฟล์คุณภาพ', h('select', {
            class: 'field',
            onchange: (event) => { S.live.profile = event.target.value; setConfig({ scrcpy_profile: event.target.value }); renderInspector(); },
          }, profileNames.map((name) => h('option', { value: name, selected: name === profile }, name)))),
          h('div', { class: 'muted' }, `${spec.max_size || '?'}px · ${spec.max_fps || '?'} fps · ${spec.bit_rate || '?'} bitrate`),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', onclick: () => attempt(() => call('live:open', { serials: targets(), profile })) }, 'เปิดด้วยโปรไฟล์นี้'),
            h('button', { class: 'btn', onclick: () => attempt(() => call('live:open', { serials: targets() })) }, 'เปิดด้วยค่าเริ่มต้นของเครื่อง')))),
      h('div', { class: 'section' },
        h('h3', null, 'ค่าเริ่มต้น'),
        h('p', { class: 'hint' }, `จำโปรไฟล์ "${profile}" ไว้ใช้ตอนดับเบิลคลิกการ์ด`),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', disabled: !S.selected.size, onclick: () => setDefault('device') }, 'ใช้กับเครื่องที่เลือก'),
          h('button', { class: 'btn', disabled: !S.selected.size, onclick: () => setDefault('group') }, 'ใช้กับทั้งกลุ่ม'))),
      h('div', { class: 'section' },
        h('h3', null, `หน้าจอที่เปิดอยู่ (${sessions.length})`),
        sessions.length
          ? h('div', { class: 'stack' },
            h('div', { class: 'list' }, sessions.map((device) => h('div', { class: 'list-item' },
              h('span', { class: 'grow' }, device.label), h('span', { class: 'mono muted' }, device.serial)))),
            h('div', { class: 'row wrap' },
              h('button', { class: 'btn', onclick: () => attempt(() => call('live:close', { serials: targets() })) }, 'ปิดเครื่องที่เลือก'),
              h('button', { class: 'btn danger', onclick: () => attempt(() => call('live:close', { all: true })) }, 'ปิดทั้งหมด')))
          : h('div', { class: 'muted' }, 'ยังไม่มีหน้าจอสดที่เปิดอยู่')));
  },

  apps() {
    const device = focusDevice();
    if (!device || !device.online) return h('div', { class: 'empty' }, h('strong', null, 'เลือกเครื่องที่ออนไลน์'), 'รายการแอปอ่านจากเครื่องที่คลิกล่าสุด');
    const apps = S.apps;
    const stale = apps.serial !== device.serial;
    const shown = stale ? [] : apps.list.filter((pkg) => pkg.toLowerCase().includes(apps.filter.toLowerCase()));
    const load = async () => {
      apps.loading = true;
      renderInspector();
      const list = await attempt(() => call('apps:list', { serial: device.serial, system: apps.system }));
      Object.assign(apps, { loading: false, serial: device.serial, list: list || [], pkg: null, info: null });
      renderInspector();
    };
    const pick = async (pkg) => {
      Object.assign(apps, { pkg, info: null });
      renderInspector();
      apps.info = await attempt(() => call('apps:info', { serial: device.serial, pkg })) || null;
      if (apps.pkg === pkg) renderInspector();
    };
    const count = onlineTargets().length;
    return h('div', { class: 'stack' },
      h('div', { class: 'row' },
        input(apps.filter, (value) => { apps.filter = value; renderInspector.keepFocus(); }, { placeholder: 'ค้นหา package', id: 'apps-filter' }),
        toggle('แอประบบ', apps.system, (checked) => { apps.system = checked; load(); }),
        h('button', { class: 'btn', disabled: apps.loading, onclick: load }, icon('refresh'), apps.loading ? 'กำลังโหลด…' : 'โหลด')),
      h('div', { class: 'muted' }, stale ? `กด "โหลด" เพื่ออ่านรายการแอปจาก ${device.label}` : `${shown.length} จาก ${apps.list.length} แอป · ${device.label}`),
      shown.length > 0 && h('div', { class: 'list tall' }, shown.map((pkg) => h('div', {
        class: `list-item mono ${apps.pkg === pkg ? 'selected' : ''}`, onclick: () => pick(pkg),
      }, pkg))),
      apps.pkg && !stale && h('div', { class: 'section' },
        h('h3', { class: 'mono' }, apps.pkg),
        apps.info
          ? h('dl', { class: 'facts' }, [
            ['เวอร์ชัน', `${apps.info.version_name || '—'} (${apps.info.version_code || '—'})`],
            ['Target SDK', apps.info.target_sdk || '—'],
            ['ติดตั้งครั้งแรก', apps.info.first_install || '—'],
            ['อัปเดตล่าสุด', apps.info.last_update || '—'],
            ['ติดตั้งจาก', apps.info.installer || '—'],
          ].flatMap(([term, value]) => [h('dt', null, term), h('dd', null, value)]))
          : h('div', { class: 'muted' }, 'กำลังอ่านรายละเอียด…'),
        h('div', { class: 'muted note' }, `ปุ่มด้านล่างทำกับทุกเครื่องที่เลือกและออนไลน์ (${count} เครื่อง)`),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: () => deviceAction('open', apps.pkg) }, 'เปิดแอป'),
          h('button', { class: 'btn', onclick: () => { S.policy = { pkg: apps.pkg, ...(S.policies[apps.pkg] || { mode: 'assisted', allow_capture: true, notes: '' }) }; setView('policy'); } }, 'ตั้งกฎ'),
          h('button', {
            class: 'btn danger',
            onclick: () => deviceAction('clear', apps.pkg, { confirm: { title: 'ล้างข้อมูลแอป?', message: `ล้างข้อมูลของ ${apps.pkg} บน ${count} เครื่อง ข้อมูลในแอปจะหายถาวร`, label: 'ล้างข้อมูล' } }),
          }, 'ล้างข้อมูล'),
          h('button', {
            class: 'btn danger',
            onclick: async () => {
              const outcome = await deviceAction('uninstall', apps.pkg, { confirm: { title: 'ถอนการติดตั้ง?', message: `ถอน ${apps.pkg} ออกจาก ${count} เครื่อง`, label: 'ถอนการติดตั้ง' } });
              if (outcome) load();
            },
          }, 'ถอนการติดตั้ง'))));
  },

  apk() {
    const apk = S.apk;
    const count = onlineTargets().length;
    const install = async (file, name) => {
      if (!file) return;
      await deviceAction('install', file, { confirm: { title: 'ติดตั้ง APK?', message: `ติดตั้ง ${name} ลง ${count} เครื่องที่เลือก`, label: 'ติดตั้ง' } });
    };
    const selected = apk.items.find((item) => item.path === apk.selected);
    return h('div', { class: 'stack' },
      targetBanner(),
      h('div', { class: 'section' },
        h('h3', null, 'คลัง APK'),
        h('p', { class: 'hint mono' }, apk.dir),
        h('div', { class: 'stack' },
          apk.items.length
            ? h('div', { class: 'list tall' }, apk.items.map((item) => h('div', {
              class: `list-item ${apk.selected === item.path ? 'selected' : ''}`,
              onclick: () => { apk.selected = item.path; renderInspector(); },
            },
            h('span', { class: 'grow' }, item.name),
            h('span', { class: 'muted' }, `${(item.size / 1048576).toFixed(1)} MB`),
            h('span', { class: 'muted' }, new Date(item.modified).toLocaleDateString('th-TH')))))
            : h('div', { class: 'muted' }, 'คลังยังว่าง วางไฟล์ .apk ลงในโฟลเดอร์คลังแล้วกด "สแกนคลัง"'),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', disabled: !selected, onclick: () => install(selected.path, selected.name) }, 'ติดตั้งไฟล์ที่เลือก'),
            h('button', { class: 'btn', onclick: loadApkLibrary }, icon('refresh'), 'สแกนคลัง'),
            h('button', { class: 'btn ghost', onclick: () => attempt(() => call('folder:open', { which: 'apk' })) }, 'เปิดโฟลเดอร์')))),
      h('div', { class: 'section' },
        h('h3', null, 'ไฟล์อื่น'),
        h('button', {
          class: 'btn',
          onclick: async () => {
            const file = await attempt(() => call('apk:choose'));
            if (file) install(file, file.split(/[\\/]/).pop());
          },
        }, 'เลือกไฟล์ APK…')));
  },

  workflow() {
    const wf = S.wf;
    const names = Object.keys(S.workflows).sort();
    const loadWorkflow = (name) => { Object.assign(wf, { name, text: S.workflows[name] || '', preview: null }); renderInspector(); };
    if (!wf.name && !wf.text && names.length) Object.assign(wf, { name: names[0], text: S.workflows[names[0]] });
    // A workflow being written that is not saved yet, or differs from what is saved under its name.
    const unsaved = Boolean(wf.text.trim()) && wf.text.trim() !== (S.workflows[wf.name] || '').trim();
    const createWorkflow = async () => {
      if (S.rec) {
        toast('หยุดการบันทึกเวิร์กโฟลว์ก่อน', 'error');
        return;
      }
      if (unsaved && !(await confirmDialog('ทิ้งที่ยังไม่บันทึก?', `"${wf.name || 'เวิร์กโฟลว์นี้'}" มีขั้นตอนที่ยังไม่ได้บันทึก สร้างใหม่แล้วขั้นตอนเหล่านั้นจะหาย`, 'สร้างใหม่'))) return;
      const name = await promptDialog('สร้างเวิร์กโฟลว์ใหม่', 'ตั้งชื่อชุดคำสั่งใหม่ เริ่มจากว่าง แล้วเพิ่มขั้นตอนด้านล่าง', 'สร้าง', 'เช่น T.B-เข้า');
      if (name === null) return;
      const clean = name.trim();
      if (!clean) {
        toast('ใส่ชื่อเวิร์กโฟลว์ก่อน', 'error');
        return;
      }
      if (S.workflows[clean]) {
        toast(`มีเวิร์กโฟลว์ชื่อ "${clean}" อยู่แล้ว เลือกจากช่อง "ที่บันทึกไว้"`, 'error');
        return;
      }
      Object.assign(wf, { name: clean, text: '', preview: null });
      renderInspector();
      toast(`เริ่ม "${clean}" แล้ว เพิ่มขั้นตอน แล้วกด "บันทึก"`, 'success');
    };
    // Put the steps of another saved workflow after the ones here. The other workflow is not changed.
    const copyFrom = async (name) => {
      const source = S.workflows[name];
      if (!source) return;
      const added = workflowSteps(source);
      const have = workflowSteps(wf.text);
      if (!added.length) {
        toast(`"${name}" ไม่มีขั้นตอน`, 'error');
        renderInspector();
        return;
      }
      if (have.length && !(await confirmDialog('คัดลอกขั้นตอน?', `ต่อท้าย ${added.length} ขั้นตอนจาก "${name}" เข้ากับ ${have.length} ขั้นตอนที่มีอยู่ "${name}" ไม่ถูกแก้`, 'ต่อท้าย', false))) {
        renderInspector();
        return;
      }
      Object.assign(wf, { text: workflowText([...have, ...added]), preview: null });
      renderInspector();
      toast(`คัดลอก ${added.length} ขั้นตอนจาก "${name}" แล้ว ยังไม่ได้บันทึก`, 'success');
    };
    const others = names.filter((name) => name !== wf.name);
    return h('div', { class: 'stack' },
      targetBanner(),
      S.rec && h('div', { class: 'targets recording' },
        h('span', { class: 'dot busy' }),
        h('span', { class: 'grow' }, `กำลังบันทึกจาก ${S.rec.label} · ได้ ${S.rec.count} ขั้นตอน · กดบนตัวเครื่องได้เลย`),
        h('button', { class: 'btn danger', onclick: toggleTouchRecording }, 'หยุดบันทึก')),
      h('div', { class: 'form-grid' },
        field('ที่บันทึกไว้', h('div', { class: 'row' },
          h('select', { class: 'field grow', onchange: (event) => loadWorkflow(event.target.value) },
            wf.name && !S.workflows[wf.name] && h('option', { value: wf.name, selected: true }, `${wf.name} (ใหม่ ยังไม่บันทึก)`),
            names.map((name) => h('option', { value: name, selected: name === wf.name }, name))),
          h('button', { class: 'btn', onclick: createWorkflow }, '+ สร้างใหม่'))),
        others.length > 0 && field('คัดลอกขั้นตอนจากชุดอื่น', h('select', { class: 'field', onchange: (event) => copyFrom(event.target.value) },
          h('option', { value: '', selected: true }, 'เลือกชุดที่จะคัดลอกมาต่อท้าย…'),
          others.map((name) => h('option', { value: name }, `${name} · ${workflowSteps(S.workflows[name]).length} ขั้นตอน`)))),
        field('ชื่อ', input(wf.name, (value) => { wf.name = value; }))),
      wf.raw
        ? [
          field('ขั้นตอน (หนึ่งคำสั่งต่อบรรทัด)', h('textarea', {
            class: 'field mono', spellcheck: false, value: wf.text, oninput: (event) => { wf.text = event.target.value; },
          })),
          h('div', { class: 'muted mono' }, 'wait 500 · back · home · recent · wake · sleep · open <package> · text <ข้อความ> · keyevent KEYCODE_ENTER · screenshot'),
        ]
        : workflowBuilder(wf),
      toggle('แก้เป็นข้อความ (ขั้นสูง)', wf.raw, (checked) => { wf.raw = checked; renderInspector(); }),
      h('div', { class: 'row wrap' },
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!workflowReady(wf)) return;
            const steps = await attempt(() => call('workflow:preview', { text: wf.text }));
            if (!steps) return;
            const count = onlineTargets().length;
            const values = [];
            for (let number = 1; number <= workflowInputCount(wf.text); number += 1) {
              const value = await promptDialog(inputLabel(number), `ค่าที่จะพิมพ์แทน {${number}} ในรอบนี้ งานจากเว็บจะส่งค่านี้มาเอง`, 'ต่อไป', 'เช่น 1234567890');
              if (value === null) return;
              values.push(value);
            }
            if (!(await confirmDialog('รันเวิร์กโฟลว์?', `รัน "${wf.name || 'Workflow'}" ${steps.length} ขั้นตอน บน ${count} เครื่องที่เลือก`, 'รัน', false))) return;
            S.timeline = { name: wf.name || 'Workflow', rows: [], running: true, run: null };
            renderInspector();
            showTimeline();
            const outcome = await attempt(() => call('workflow:run', { name: wf.name, text: wf.text, serials: targets(), values }));
            S.timeline.running = false;
            if (S.view === 'workflow') renderInspector();
            if (!outcome) return;
            const failure = outcome.results.find((result) => !result.ok);
            if (failure) toast(`ล้มเหลว ${outcome.failed} เครื่อง\n${failure.label}: ${failure.detail}`, 'error');
            else toast(`รันสำเร็จ ${outcome.results.length} เครื่อง`, 'success');
          },
        }, 'รัน'),
        h('button', {
          class: 'btn',
          onclick: async () => { wf.preview = await attempt(() => call('workflow:preview', { text: wf.text })) || null; renderInspector(); },
        }, 'ตรวจสอบ'),
        h('button', {
          class: 'btn',
          onclick: async () => {
            if (!workflowReady(wf)) return;
            if (!wf.name.trim()) {
              toast('ใส่ชื่อเวิร์กโฟลว์ในช่อง "ชื่อ" ก่อนบันทึก', 'error');
              return;
            }
            const workflows = await attempt(() => call('workflow:save', { name: wf.name, text: wf.text }));
            if (!workflows) return;
            S.workflows = workflows;
            toast('บันทึกเวิร์กโฟลว์แล้ว', 'success');
            renderInspector();
          },
        }, 'บันทึก'),
        h('button', {
          class: 'btn danger',
          disabled: !S.workflows[wf.name],
          onclick: async () => {
            if (!(await confirmDialog('ลบเวิร์กโฟลว์?', `ลบ "${wf.name}" ออกจากรายการที่บันทึกไว้`, 'ลบ'))) return;
            const workflows = await attempt(() => call('workflow:delete', { name: wf.name }));
            if (!workflows) return;
            S.workflows = workflows;
            Object.assign(wf, { name: '', text: '', preview: null });
            renderInspector();
          },
        }, 'ลบ')),
      S.timeline && workflowTimeline(S.timeline),
      wf.preview && h('div', { class: 'section' },
        h('h3', null, `ผ่านการตรวจสอบ · ${wf.preview.length} ขั้นตอน`),
        h('div', { class: 'mono' }, wf.preview.map((step, index) => h('div', null, `${index + 1}. ${step.command} ${step.argument}`)))));
  },

  withdraw() {
    const jobs = S.jobs;
    const { config, orders, halt } = jobs;
    const apply = async (request) => {
      const next = await attempt(request);
      if (next) S.jobs = next;
      renderInspector();
      return next;
    };
    const set = (patch) => apply(() => call('jobs:set', patch));
    const devices = async (request) => {
      const next = await attempt(request);
      if (next) S.devices = next;
      renderDevices();
      renderInspector();
      return next;
    };
    const baht = (amount) => Number(amount).toLocaleString('th-TH', { minimumFractionDigits: 2 });
    const state = JOB_STATUS[jobs.status.code] || jobs.status.code;
    const busy = ['running', 'checking'].includes(jobs.status.code);
    const today = new Date().toDateString();
    const bad = (entry) => ['failed', 'started', 'paid'].includes(entry.state);
    const open = jobs.history.filter(bad);
    const tab = S.withdrawTab || 'queue';
    const tabs = [['queue', `คิว (${orders.list.filter((order) => !order.state).length})`], ['history', `ประวัติ (${jobs.history.length})`], ['log', 'บันทึก'], ['settings', 'ตั้งค่า']];

    // One card for each phone that pays, or could: what it takes, what waits for it, what it did today.
    const card = (device) => {
      const mine = jobs.history.filter((entry) => entry.serial === device.serial && new Date(entry.at).toDateString() === today);
      // Only a row with a slip counts as paid: the slip is the proof that money left the account.
      const paid = mine.filter((entry) => entry.slip);
      const waiting = orders.list.filter((order) => order.serial === device.serial && !order.state).length;
      const spent = jobs.spent[device.serial] || 0;
      // What the back office lists for this phone's account, when that was read not long ago.
      const listed = jobs.accounts.fresh && device.pay.account ? jobs.accounts.map[device.pay.account] || null : null;
      const balance = listed && listed.balance !== null ? listed.balance : device.pay.balance;
      const switchedOff = Boolean(listed && listed.on === false);
      // At its cap, or with less left than its smallest amount, a phone takes nothing more today.
      const moneyOut = balance !== null && device.amountMin !== null && balance < device.amountMin;
      const spentOut = (device.pay.cap !== null && spent >= device.pay.cap) || moneyOut;
      const ready = device.online && device.payOn && device.amountMin !== null && !spentOut && !switchedOff;
      const working = busy && jobs.history[0] && jobs.history[0].serial === device.serial && jobs.history[0].state === 'started';
      const problems = [
        !device.online && 'ออฟไลน์', device.amountMin === null && 'ยังไม่ตั้งช่วงยอด', !device.hasPin && 'ยังไม่ตั้ง PIN', !device.pay.account && 'ยังไม่ใส่บัญชีของเครื่อง',
        device.pay.cap !== null && spent >= device.pay.cap && 'ถึงเพดานวันนี้แล้ว',
        moneyOut && 'เงินหมด: ยอดคงเหลือต่ำกว่ายอดต่ำสุด เติมเงินเข้าบัญชีนี้',
        switchedOff && 'บัญชีนี้ปิดสถานะอยู่ในหลังบ้าน',
        device.pay.account && jobs.accounts.fresh && !listed && 'ไม่พบบัญชีนี้ในหน้าปรับยอดเงินบัญชีถอน',
      ].filter(Boolean);
      return h('div', { class: `pay-card ${ready ? '' : 'idle'} ${S.focus === device.serial ? 'selected' : ''}` },
        h('div', { class: 'row' },
          h('strong', { class: 'grow pay-name' }, device.label),
          h('span', { class: `badge ${working ? 'live' : ready ? 'online' : device.online ? '' : 'error'}` }, working ? 'กำลังโอน' : ready ? 'พร้อม' : !device.online ? 'ออฟไลน์' : switchedOff ? 'บัญชีปิดอยู่' : moneyOut ? 'เงินหมด' : spentOut ? 'เต็มวงเงิน' : 'ไม่รับงาน')),
        h('div', { class: 'mono muted' }, device.serial),
        device.pay.account && h('div', { class: 'pay-account' },
          h('div', null, device.pay.bank || '—'),
          h('div', { class: 'mono' }, device.pay.account),
          device.pay.holder && h('div', { class: 'muted' }, device.pay.holder)),
        h('dl', { class: 'facts pay-facts' },
          h('dt', null, 'คงเหลือ'), h('dd', { class: balance !== null && device.amountMin !== null && balance < device.amountMin ? 'job-warn-text' : '', title: listed ? `จากหน้าปรับยอดเงินบัญชีถอน อัปเดต ${listed.updated}` : 'ตัวเลขที่ใส่เองในข้อมูลเครื่อง' },
            balance !== null ? `${baht(balance)}${listed && listed.balance !== null ? ' (หลังบ้าน)' : ' (ใส่เอง)'}` : 'ไม่ทราบ'),
          listed && h('dt', null, 'สถานะบัญชี'), listed && h('dd', { class: switchedOff ? 'job-warn-text' : '' }, switchedOff ? 'ปิดอยู่ในหลังบ้าน' : 'เปิดใช้งาน'),
          h('dt', null, 'ช่วงยอด'), h('dd', null, device.amountMin !== null ? `${device.amountMin.toLocaleString('th-TH')} – ${device.amountMax.toLocaleString('th-TH')}` : '—'),
          h('dt', null, 'คิวที่รอ'), h('dd', null, String(waiting)),
          h('dt', null, 'วันนี้'), h('dd', null, `${paid.length} รายการ · ${baht(paid.reduce((sum, entry) => sum + Number(entry.amount), 0))}`),
          device.pay.cap !== null && h('dt', null, 'เพดาน'), device.pay.cap !== null && h('dd', null, `ใช้ ${baht(spent)} จาก ${baht(device.pay.cap)}`)),
        problems.length > 0 && h('div', { class: 'job-warn-text' }, problems.join(' · ')),
        h('div', { class: 'row wrap pay-range' },
          h('input', { class: 'field', type: 'number', min: 1, placeholder: 'ตั้งแต่', value: device.amountMin ?? '', 'aria-label': `ยอดต่ำสุดของ ${device.label}`, id: `pay-min-${device.serial}` }),
          h('input', { class: 'field', type: 'number', min: 1, placeholder: 'ไม่เกิน', value: device.amountMax ?? '', 'aria-label': `ยอดสูงสุดของ ${device.label}`, id: `pay-max-${device.serial}` }),
          h('button', { class: 'btn', onclick: () => devices(() => call('device:range', { serial: device.serial, min: $(`pay-min-${device.serial}`).value, max: $(`pay-max-${device.serial}`).value })) }, 'บันทึก')),
        h('div', { class: 'row wrap' },
          toggle(device.payOn ? 'สถานะ: เปิด' : 'สถานะ: ปิด', device.payOn, (checked) => devices(() => call('device:pay', { serial: device.serial, on: checked }))),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn ghost', title: 'ตั้งชื่อ กลุ่ม และรหัส PIN', onclick: () => { S.focus = device.serial; S.view = 'info'; renderNav(); renderDevices(); renderInspector(); } }, 'ข้อมูลเครื่อง')));
    };

    const row = (order) => {
      const stopped = halt && halt.key === order.key;
      const label = stopped ? 'หยุด: ต้องตรวจด้วยมือ' : WITHDRAW_STATE[order.state] || (order.serial ? 'รอทำ' : order.short === 'cap' ? 'เครื่องถึงเพดานวันนี้' : order.short === 'balance' ? 'ยอดคงเหลือของเครื่องไม่พอ' : order.short === 'off' ? 'บัญชีของเครื่องปิดอยู่ในหลังบ้าน' : 'ไม่มีเครื่องรับยอดนี้');
      return h('tr', { class: stopped || bad(order) ? 'bad' : order.state === 'done' ? 'good' : '' },
        h('td', { class: 'mono num' }, baht(order.amount)),
        h('td', null, h('div', null, order.bank), h('div', { class: 'mono muted' }, order.account)),
        h('td', null, h('div', null, order.holder || '—'), h('div', { class: 'mono muted' }, order.requested)),
        h('td', null, order.phone || '—'),
        h('td', null, h('span', { class: `badge ${stopped || bad(order) ? 'error' : order.state === 'done' ? 'online' : ''}`, title: order.detail || '' }, label)),
        h('td', null, h('button', {
          class: 'btn',
          disabled: Boolean(order.state) || !order.serial || Boolean(halt) || busy || jobs.payAuto,
          onclick: async () => {
            const dry = config.closeDry ? '\n\nโหมดทดลองเปิดอยู่: โอนจริง แต่ไม่ปิดงานในหลังบ้าน ต้องปิดงานนี้เอง' : '\n\nสลิปตรงแล้วแอปจะปิดงานในหลังบ้านเอง';
            if (!(await confirmDialog('ทำรายการนี้?', `โอน ${baht(order.amount)} บาท\nไป ${order.bank} ${order.account}\nจากเครื่อง ${order.phone} ด้วย "${config.workflow}"${dry}`, 'โอน'))) return;
            if (await apply(() => call('jobs:pay', { key: order.key }))) toast('ทำรายการเสร็จแล้ว', 'success');
          },
        }, 'ทำรายการนี้')));
    };

    const past = (entry) => h('tr', { class: bad(entry) ? 'bad' : '' },
      h('td', { class: 'mono' }, h('div', null, timeOf(entry.at)), h('div', { class: 'muted' }, new Date(entry.at).toLocaleDateString('th-TH'))),
      h('td', { class: 'mono num' }, baht(entry.amount)),
      h('td', null, h('div', null, entry.bank), h('div', { class: 'mono muted' }, entry.account)),
      h('td', null, entry.phone || entry.serial || '—'),
      h('td', null,
        h('span', { class: `badge ${bad(entry) ? 'error' : entry.state === 'done' ? 'online' : ''}` }, WITHDRAW_STATE[entry.state] || entry.state),
        (entry.detail || entry.note) && h('div', { class: 'muted pay-detail' }, entry.state === 'resolved' ? `${entry.note || 'ไม่มีหมายเหตุ'} (เดิม: ${WITHDRAW_STATE[entry.was] || entry.was})` : entry.detail)),
      h('td', null, bad(entry) && h('button', {
        class: 'btn',
        title: 'ใช้เมื่อปิดงานนี้เองแล้ว หรือตรวจแล้วว่าเงินไม่ออก',
        onclick: async () => {
          const note = await promptDialog('จัดการรายการนี้แล้ว?', `${baht(entry.amount)} บาท ไป ${entry.bank} ${entry.account}\nเขียนว่าจัดการอย่างไร เช่น "โอนสำเร็จ ปิดงานเองแล้ว" รายการนี้จะไม่ถูกทำซ้ำไม่ว่ากรณีใด`, 'บันทึก', 'หมายเหตุ');
          if (note === null) return;
          apply(() => call('jobs:resolve', { key: entry.key, note }));
        },
      }, 'จัดการแล้ว')));

    const panes = {
      queue: () => [
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', onclick: () => apply(() => call('jobs:open')) }, jobs.open ? (jobs.hidden ? 'แสดงหน้าต่างหลังบ้าน (ซ่อนอยู่ ยังทำงาน)' : 'ไปที่หน้าต่างหลังบ้าน') : 'เปิดหน้าล็อกอิน'),
          h('button', { class: 'btn', disabled: !jobs.open || busy, onclick: () => apply(() => call('jobs:orders')) }, 'อ่านรายการตอนนี้'),
          h('span', { class: 'muted grow' }, `${WITHDRAW_NOTE[orders.note] || orders.note}${orders.at ? ` · ${timeOf(orders.at)}` : ''}${orders.error ? ` · อ่านหน้าเว็บไม่ได้: ${orders.error}` : ''}`)),
        !config.url && h('p', { class: 'hint job-warn' }, 'ยังไม่ได้ใส่ที่อยู่หลังบ้าน ใส่ที่เมนู "รับงานจากเว็บ" ข้อ 1'),
        orders.list.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'orders' },
            h('thead', null, h('tr', null, ['ยอด (บาท)', 'ธนาคาร / เลขบัญชี', 'ชื่อบัญชี / เวลาที่ขอ', 'เครื่องที่จ่าย', 'สถานะ', ''].map((name) => h('th', null, name)))),
            h('tbody', null, orders.list.map(row))))
          : h('div', { class: 'muted' }, orders.note === 'ok' ? 'ไม่มีรายการในช่วงยอดที่ตั้งไว้' : 'ยังอ่านรายการไม่ได้'),
      ],
      history: () => [
        h('p', { class: 'hint' }, 'ทุกรายการที่แอปเคยเริ่มโอน ใหม่สุดอยู่บน รายการในนี้จะไม่ถูกทำซ้ำ รายการสีแดงคือรายการที่ไม่จบ ตรวจแล้วกด "จัดการแล้ว"'),
        jobs.history.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'orders' },
            h('thead', null, h('tr', null, ['เวลา', 'ยอด (บาท)', 'ธนาคาร / เลขบัญชี', 'เครื่อง', 'ผล', ''].map((name) => h('th', null, name)))),
            h('tbody', null, jobs.history.map(past))))
          : h('div', { class: 'muted' }, 'ยังไม่มีประวัติ'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: () => attempt(() => call('folder:open', { which: 'captures' })) }, 'เปิดโฟลเดอร์รูปสลิป'),
          h('button', { class: 'btn', onclick: () => attempt(() => call('folder:open', { which: 'data' })) }, 'เปิดโฟลเดอร์ข้อมูล (สมุดและบันทึก)')),
      ],
      log: () => [
        h('p', { class: 'hint' }, 'ทุกขั้นของทุกรายการ ใหม่สุดอยู่บน เก็บครบในไฟล์ withdraw_audit.jsonl ที่นี่แสดง 80 บรรทัดล่าสุด'),
        jobs.audits.length
          ? h('div', { class: 'mono audit' }, jobs.audits.map((entry) => h('div', { class: entry.event === 'error' || entry.event === 'halt' ? 'bad' : '' },
            `${new Date(entry.at).toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit' })} ${timeOf(entry.at)} · ${WITHDRAW_EVENT[entry.event] || entry.event}${entry.key ? ` · ${entry.key.split('|').slice(0, 2).join(' · ')}` : ''}${entry.message ? ` · ${entry.message}` : ''}`)))
          : h('div', { class: 'muted' }, 'ยังไม่มีบันทึก'),
      ],
      settings: () => [
        h('dl', { class: 'facts' },
          h('dt', null, 'เวิร์กโฟลว์โอน'), h('dd', null, config.workflow ? `${config.workflow} · ช่อง 1 = เลขบัญชี, ช่อง 2 = ยอด, ช่อง 3 = ชื่อธนาคาร` : 'ยังไม่ได้เลือก (เมนู "รับงานจากเว็บ" ข้อ 3)'),
          h('dt', null, 'เข้าแอปก่อน'), h('dd', null, config.enter ? `${config.enter} · ข้ามถ้างานก่อนหน้าจบไม่เกิน ${config.stay} วินาที${config.again ? ` แล้วรัน ${config.again} แทน` : ''}${config.rest ? ` · ว่างเกินนั้นรัน ${config.rest}` : ''}` : 'ไม่ใช้'),
          h('dt', null, 'ข้อความในสลิป'), h('dd', null, config.expect || 'ไม่ตรวจ (แนะนำใส่ "รายการสำเร็จ" ที่เมนู "รับงานจากเว็บ" ข้อ 4)')),
        toggle('ทดลองก่อน: โอนจริง แต่ไม่ปิดงานในหลังบ้าน (ตีกรอบปุ่มให้ดู)', config.closeDry, (checked) => set({ closeDry: checked })),
        toggle('พาหน้าต่างหลังบ้านไปหน้ารายการที่อนุมัติแล้ว และกดค้นหาเองเป็นระยะ', config.watch, (checked) => set({ watch: checked })),
        toggle('ใส่ช่วงยอดของเครื่องลงช่องกรองของหน้าเว็บ', config.filter, (checked) => set({ filter: checked })),
        toggle('อ่านยอดคงเหลือและสถานะบัญชีจากหน้า "ปรับยอดเงินบัญชีถอน" (หน้าต่างซ่อน กดค้นหาเองทุก 30 วินาที)', config.balances, (checked) => set({ balances: checked })),
        h('div', { class: 'muted' }, `บัญชีของร้าน: ${WITHDRAW_ACCOUNTS[jobs.accounts.note] || jobs.accounts.note}${jobs.accounts.at ? ` · ${timeOf(jobs.accounts.at)} · ${Object.keys(jobs.accounts.map).length} บัญชี` : ''}${jobs.accounts.error ? ` · ${jobs.accounts.error}` : ''}`),
      ],
    };

    // Phones that take withdrawals but whose account holds less than their smallest amount.
    const outOfMoney = S.devices.filter((device) => {
      if (!device.online || !device.payOn || device.amountMin === null) return false;
      const listed = jobs.accounts.fresh && device.pay.account ? jobs.accounts.map[device.pay.account] || null : null;
      const balance = listed && listed.balance !== null ? listed.balance : device.pay.balance;
      return balance !== null && balance < device.amountMin;
    });

    return h('div', { class: 'stack' },
      outOfMoney.length > 0 && h('div', { class: 'targets halt' },
        h('span', { class: 'grow' }, h('strong', null, 'เงินหมด: '), outOfMoney.map((device) => device.label).join(', '), h('div', { class: 'muted' }, 'ยอดคงเหลือต่ำกว่ายอดต่ำสุดของเครื่อง เติมเงินเข้าบัญชีแล้วเครื่องจะรับงานต่อเอง'))),
      halt && h('div', { class: 'targets halt' },
        h('span', { class: 'grow' }, h('strong', null, 'หยุดทำงาน: '), halt.message, h('div', { class: 'muted' }, `${timeOf(halt.at)} · ตรวจรายการสีแดงในหลังบ้านและในแอปธนาคารก่อน ว่าเงินออกหรือไม่ แล้วค่อยรีเซ็ต`)),
        h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (await confirmDialog('รีเซ็ตสถานะหยุด?', 'ยืนยันว่าตรวจรายการที่ผิดพลาดแล้ว รายการนั้นจะไม่ถูกทำซ้ำ งานถัดไปจะเริ่มจากเวิร์กโฟลว์เข้าแอปใหม่', 'รีเซ็ต')) apply(() => call('jobs:unhalt'));
          },
        }, 'รีเซ็ต')),
      h('div', { class: `targets ${jobs.payAuto ? '' : 'none'}` },
        jobs.payAuto && h('span', { class: 'dot busy' }),
        h('span', { class: 'grow' }, `${jobs.payAuto ? 'ทำรายการอัตโนมัติ' : 'ทำรายการเมื่อกดเอง'} · ${state}${jobs.status.detail ? `: ${jobs.status.detail}` : ''}${open.length ? ` · ค้างตรวจ ${open.length} รายการ` : ''}`),
        toggle('อัตโนมัติ', jobs.payAuto, async (checked) => {
          if (checked && !(await confirmDialog('เปิดทำรายการอัตโนมัติ?', `แอปจะโอนทุกรายการที่ยอดอยู่ในช่วงของเครื่อง ด้วย "${config.workflow}" โดยไม่มีคนกดยืนยันทีละรายการ\n\nผิดพลาดขั้นไหน แอปหยุดทั้งหมดและขึ้นสีแดง จนกว่าจะกดรีเซ็ต`, 'เปิดอัตโนมัติ'))) {
            renderInspector();
            return;
          }
          apply(() => call('jobs:payauto', { on: checked }));
        })),
      h('div', { class: 'section' },
        h('h3', null, `เครื่อง · ${S.devices.length} เครื่อง · พร้อม ${S.devices.filter((device) => device.online && device.payOn && device.amountMin !== null).length}`),
        S.devices.length
          ? h('div', { class: 'pay-cards' }, [...S.devices].sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label)).map(card))
          : h('div', { class: 'muted' }, 'ยังไม่พบเครื่อง ต่อมือถือแล้วกดสแกน')),
      h('div', { class: 'section' },
        h('div', { class: 'seg', role: 'tablist' }, tabs.map(([name, label]) => h('button', {
          class: `seg-item ${tab === name ? 'active' : ''}`, role: 'tab', 'aria-selected': String(tab === name), onclick: () => { S.withdrawTab = name; renderInspector(); },
        }, label))),
        h('div', { class: 'stack pay-pane' }, panes[tab]())));
  },

  jobs() {
    const jobs = S.jobs;
    const { config } = jobs;
    const apply = async (request) => {
      const next = await attempt(request);
      if (next) S.jobs = next;
      renderInspector();
      return next;
    };
    const set = (patch) => apply(() => call('jobs:set', patch));
    const names = Object.keys(S.workflows).sort();
    const needed = config.workflow && S.workflows[config.workflow] ? workflowInputCount(S.workflows[config.workflow]) : 0;
    const online = S.devices.filter((device) => device.online);
    const record = (key, label, hint) => h('div', { class: 'job-field' },
      h('div', { class: 'grow' },
        h('div', null, label),
        h('div', { class: 'mono muted' }, config[key] || hint)),
      h('button', {
        class: 'btn',
        disabled: !jobs.open,
        onclick: async () => {
          toast(`คลิกที่ "${label}" ในหน้าต่างหลังบ้าน (กด Esc เพื่อยกเลิก)`);
          const next = await apply(() => call('jobs:pick', { field: key }));
          if (next && next.picked) toast(`บันทึกแล้ว เห็นข้อความ: ${next.picked.text || '(ว่าง)'}`, 'success');
        },
      }, config[key] ? 'บันทึกใหม่' : 'บันทึก'),
      config[key] && h('button', { class: 'btn ghost icon', title: 'ล้าง', 'aria-label': `ล้าง ${label}`, onclick: () => set({ [key]: '' }) }, '✕'));
    // Accepting or closing a job can take several clicks, so each is recorded as the clicks themselves.
    const macro = (which, label, hint, how) => {
      const steps = config[`${which}Steps`];
      const recording = jobs.recording && jobs.recording.which === which;
      return h('div', { class: 'stack' },
        h('div', { class: 'job-field' },
          h('div', { class: 'grow' },
            h('div', null, `มาโคร${label}`),
            h('div', { class: 'muted' }, recording
              ? `กำลังบันทึก · ${jobs.recording.count} คลิก · คลิกตามลำดับในหน้าต่างหลังบ้าน แล้วกด "หยุดบันทึก"`
              : steps.length ? `บันทึกไว้ ${steps.length} คลิก` : hint)),
          h('button', {
            class: `btn ${recording ? 'primary' : ''}`,
            disabled: !jobs.open || jobs.auto || Boolean(jobs.recording && !recording),
            onclick: async () => {
              if (!recording && !(await confirmDialog(`บันทึกมาโคร${label}?`, `ระหว่างบันทึก ทุกคลิกในหน้าต่างหลังบ้านจะถูกกดจริง\n\n${how} แล้วกลับมากด "หยุดบันทึก"\n\nบันทึกเฉพาะการคลิก ไม่บันทึกการพิมพ์`, 'เริ่มบันทึก', false))) return;
              const next = await apply(() => call('jobs:record', { on: !recording, field: which }));
              if (!next || !recording) return;
              const count = next.config[`${which}Steps`].length;
              toast(count ? `มาโคร${label}มี ${count} คลิก` : 'ไม่มีคลิกที่บันทึก', count ? 'success' : '');
            },
          }, recording ? 'หยุดบันทึก' : steps.length ? 'บันทึกใหม่' : 'เริ่มบันทึก'),
          steps.length > 0 && !recording && h('button', { class: 'btn ghost icon', title: 'ล้าง', 'aria-label': `ล้างมาโคร${label}`, onclick: () => apply(() => call('jobs:clear', { field: which })) }, '✕')),
        steps.length > 0 && !recording && h('ol', { class: 'job-steps mono muted' }, steps.map((step, index) => h('li', null,
          `${index ? `รอ ${(step.wait / 1000).toFixed(1)} วิ · ` : ''}${step.text ? `"${step.text}" · ` : ''}${step.selector}`))));
    };
    // How a recorded value is taken from the page.
    const source = (number) => config[`value${number}`] && h('div', { class: 'job-source' },
      h('select', { class: 'field', 'aria-label': `วิธีเอาค่า${inputLabel(number)}`, onchange: (event) => set({ [`mode${number}`]: event.target.value }) },
        h('option', { value: 'text', selected: config[`mode${number}`] !== 'copy' }, 'อ่านข้อความที่เห็น'),
        h('option', { value: 'copy', selected: config[`mode${number}`] === 'copy' }, 'กดปุ่มคัดลอก แล้วเอาค่าที่คัดลอก')),
      toggle('เอาเฉพาะตัวเลข', config[`number${number}`], (checked) => set({ [`number${number}`]: checked })),
      config[`number${number}`] && toggle('ไม่เอาทศนิยม', config[`whole${number}`], (checked) => set({ [`whole${number}`]: checked })));
    const state = JOB_STATUS[jobs.status.code] || jobs.status.code;
    return h('div', { class: 'stack' },
      h('div', { class: `targets ${jobs.auto ? '' : 'none'}` },
        jobs.auto && h('span', { class: 'dot busy' }),
        h('span', { class: 'grow' }, `${jobs.auto ? 'รับงานอัตโนมัติ' : 'รับงานเอง'} · ${state}${jobs.status.detail ? `: ${jobs.status.detail}` : ''} · ${timeOf(jobs.status.at)}`)),
      h('div', { class: 'section' },
        h('h3', null, '1. ล็อกอินหลังบ้าน'),
        h('p', { class: 'hint' }, 'พิมพ์ username, password และ OTP เองในหน้าต่างหลังบ้าน แอปไม่พิมพ์แทนและไม่เก็บรหัส'),
        h('div', { class: 'stack' },
          field('ที่อยู่หลังบ้าน', h('input', { class: 'field mono', spellcheck: false, placeholder: 'https://', value: config.url, onchange: (event) => set({ url: event.target.value }) })),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', onclick: () => apply(() => call('jobs:open')) }, jobs.open ? (jobs.hidden ? 'แสดงหน้าต่างหลังบ้าน (ซ่อนอยู่ ยังทำงาน)' : 'ไปที่หน้าต่างหลังบ้าน') : 'เปิดหน้าล็อกอิน'),
            h('span', { class: 'muted mono job-url' }, jobs.open ? jobs.url : 'ยังไม่ได้เปิด')))),
      h('div', { class: 'section' },
        h('h3', null, '2. บันทึกตำแหน่งบนหน้าเว็บ'),
        h('p', { class: 'hint' }, 'ล็อกอินแล้วเปิดหน้างานให้เห็นงาน 1 งาน จากนั้นกด "บันทึก" แล้วคลิกที่ตัวเลข หรือที่ปุ่มคัดลอกข้างตัวเลข ปุ่มที่คลิกตอนบันทึกจะไม่ถูกกดจริง'),
        h('div', { class: 'stack' },
          record('value1', inputLabel(1), 'ยังไม่ได้บันทึก'),
          source(1),
          record('value2', inputLabel(2), 'ยังไม่ได้บันทึก'),
          source(2),
          record('value3', `${inputLabel(3)} (เช่น ชื่อธนาคารผู้รับ ใช้เลือกเวิร์กโฟลว์ย่อย)`, 'ไม่บังคับ'),
          source(3),
          macro('accept', 'รับงาน', 'ไม่บังคับ: เล่นก่อนอ่านค่า เฉพาะโหมดอัตโนมัติ ถ้าไม่เจอปุ่มแรกถือว่ายังไม่มีงาน', 'เปิดหน้าที่มีงานรอรับไว้ก่อน คลิกปุ่มรับงานและปุ่มยืนยันตามลำดับ'),
          h('div', { class: 'job-source' },
            h('select', { class: 'field', 'aria-label': 'วิธีปิดงาน', onchange: (event) => set({ closeBy: event.target.value }) },
              h('option', { value: 'macro', selected: config.closeBy !== 'profile' }, 'ปิดงานด้วยมาโครคลิก'),
              h('option', { value: 'profile', selected: config.closeBy === 'profile' }, 'ปิดงานด้วย Closejob (เลือกสถานะ ธนาคาร บัญชี จากสลิป)'))),
          config.closeBy !== 'profile' && macro('done', 'ปิดงาน', 'ไม่บังคับ: เล่นหลังเวิร์กโฟลว์รันสำเร็จ', 'เปิดงานที่ปิดได้ไว้ก่อน คลิกปุ่มปิดงานและปุ่มยืนยันตามลำดับ'),
          config.closeBy === 'profile' && h('div', { class: 'stack' },
            h('div', { class: jobs.profile ? 'muted' : 'job-warn-text' }, jobs.profile
              ? `Closejob: ${jobs.profile} · เปิดหน้ารายการถอน แท็บรายการที่อนุมัติแล้วค้างไว้ แอปหาแถวจากยอดเงินในสลิป`
              : 'ไม่มี Closejob สำหรับที่อยู่หลังบ้านนี้'),
            toggle('ทดลองก่อน: ตีกรอบปุ่มแรก ไม่กดจริง งานไม่ถูกปิด', config.closeDry, async (checked) => {
              if (!checked && !(await confirmDialog('ปิดงานจริง?', 'แอปจะเลือกสถานะ "สำเร็จ" ธนาคารและบัญชีที่จ่ายจากสลิป กดบันทึก และกดยืนยันเองในหลังบ้าน\n\nลองโหมดทดลองให้เจอแถวถูกก่อน', 'ปิดงานจริง'))) {
                renderInspector();
                return;
              }
              set({ closeDry: checked });
            }),
            h('div', { class: 'muted' }, 'ต้องมีสลิป: แอปอ่านรูปสลิปจากมือถือทุกงาน แม้ปิดการตรวจในข้อ 4')))),
      h('div', { class: 'section' },
        h('h3', null, '3. รันด้วยอะไร'),
        h('div', { class: 'form-grid' },
          field('เวิร์กโฟลว์', h('select', { class: 'field', onchange: (event) => set({ workflow: event.target.value }) },
            h('option', { value: '', selected: !config.workflow }, 'เลือก…'),
            names.map((name) => h('option', { value: name, selected: name === config.workflow }, `${name} (${workflowInputCount(S.workflows[name])} ช่อง)`)))),
          field('เครื่อง', h('select', { class: 'field', onchange: (event) => set({ serial: event.target.value }) },
            h('option', { value: '', selected: !config.serial }, 'เครื่องเดียวที่ออนไลน์'),
            config.serial && !online.some((device) => device.serial === config.serial) && h('option', { value: config.serial, selected: true }, `${config.serial} (ออฟไลน์)`),
            online.map((device) => h('option', { value: device.serial, selected: device.serial === config.serial }, device.name || device.model || device.serial))))),
        h('div', { class: 'form-grid job-enter' },
          field('เวิร์กโฟลว์เข้าแอป (ไม่บังคับ)', h('select', { class: 'field', onchange: (event) => set({ enter: event.target.value }) },
            h('option', { value: '', selected: !config.enter }, 'ไม่ใช้: เวิร์กโฟลว์หลักเข้าแอปเอง'),
            config.enter && !names.includes(config.enter) && h('option', { value: config.enter, selected: true }, `${config.enter} (ไม่มีแล้ว)`),
            names.filter((name) => name !== config.workflow).map((name) => h('option', { value: name, selected: name === config.enter }, name)))),
          config.enter && field('ข้ามการเข้าแอป ถ้างานก่อนหน้าจบไม่เกิน (วินาที)', h('input', { class: 'field', type: 'number', min: 0, max: 3600, value: config.stay, onchange: (event) => set({ stay: event.target.value }) }))),
        config.enter && config.stay > 0 && h('div', { class: 'form-grid job-enter' },
          field('เวิร์กโฟลว์ทำต่อ (ไม่บังคับ): รันก่อนเวิร์กโฟลว์หลัก เมื่อข้ามการเข้าแอป', h('select', { class: 'field', onchange: (event) => set({ again: event.target.value }) },
            h('option', { value: '', selected: !config.again }, 'ไม่ใช้: งานก่อนจบที่หน้าเริ่มของเวิร์กโฟลว์หลักอยู่แล้ว'),
            config.again && !names.includes(config.again) && h('option', { value: config.again, selected: true }, `${config.again} (ไม่มีแล้ว)`),
            names.filter((name) => name !== config.workflow && name !== config.enter).map((name) => h('option', { value: name, selected: name === config.again }, name)))),
          field('เวิร์กโฟลว์พัก (ไม่บังคับ): รันเมื่อไม่มีงานเกินเวลาข้างบน', h('select', { class: 'field', onchange: (event) => set({ rest: event.target.value }) },
            h('option', { value: '', selected: !config.rest }, 'ไม่ใช้: ปล่อยค้างหน้าเดิม'),
            config.rest && !names.includes(config.rest) && h('option', { value: config.rest, selected: true }, `${config.rest} (ไม่มีแล้ว)`),
            names.filter((name) => name !== config.workflow && name !== config.enter).map((name) => h('option', { value: name, selected: name === config.rest }, name))))),
        config.enter && h('p', { class: 'hint job-note' }, config.stay
          ? `งานที่เริ่มภายใน ${config.stay} วินาทีหลังงานก่อนหน้าจบสำเร็จ จะรันเฉพาะ "${config.workflow}" งานอื่นจะรัน "${config.enter}" ก่อน ตั้งค่านี้ให้ต่ำกว่าเวลาที่แอปบนมือถือเด้งออกเองอย่างน้อยครึ่งหนึ่ง`
          : `ทุกงานรัน "${config.enter}" ก่อน แล้วต่อด้วย "${config.workflow}" (0 วินาที = เข้าแอปใหม่ทุกงาน ปลอดภัยที่สุด)`),
        config.workflow && !needed && h('p', { class: 'hint job-warn' }, 'เวิร์กโฟลว์นี้ไม่มีขั้น "พิมพ์ข้อมูลช่อง" ค่าจากเว็บจะไม่ถูกใช้')),
      h('div', { class: 'section' },
        h('h3', null, '4. ตรวจผลก่อนปิดงาน'),
        h('p', { class: 'hint' }, 'หลังเวิร์กโฟลว์รันจบ แอปอ่านหลักฐานจากมือถือ ถ้าไม่เห็นค่าของงานครบ จะไม่กดปุ่มปิดงาน และหยุดอัตโนมัติ สำเนารูปเก็บไว้ในโฟลเดอร์ภาพหน้าจอ'),
        h('div', { class: 'stack' },
          toggle('ตรวจก่อนกดปุ่มปิดงาน', config.verify, (checked) => set({ verify: checked })),
          config.verify && [
            field('ตรวจจาก', h('select', { class: 'field', onchange: (event) => { S.jobScreen = null; set({ source: event.target.value }); } },
              h('option', { value: 'gallery', selected: config.source !== 'screen' }, 'รูปใหม่ในแกลเลอรี่ (สลิปที่แอปบันทึกเมื่อสำเร็จ)'),
              h('option', { value: 'screen', selected: config.source === 'screen' }, 'หน้าจอมือถือตอนเวิร์กโฟลว์จบ (แคปหน้าจอ)'))),
            config.source !== 'screen' && h('p', { class: 'hint job-note' }, 'ไม่แคปหน้าจอ ใช้รูปที่มือถือบันทึกหลังเริ่มรันงานนี้เท่านั้น ถ้าไม่มีรูปใหม่ งานจะไม่ถูกปิด'),
            field(config.source === 'screen' ? 'ข้อความที่ต้องเห็นบนจอด้วย (เช่น ข้อความว่าทำรายการสำเร็จ)' : 'ข้อความที่ต้องเห็นในรูปด้วย (ภาษาไทยอ่านด้วย Tesseract ที่ติดตั้งข้อมูลภาษาไทย)',
              h('input', { class: 'field', spellcheck: false, value: config.expect, placeholder: 'เว้นว่าง = ไม่ตรวจ', onchange: (event) => set({ expect: event.target.value }) })),
            h('div', { class: 'row wrap' },
              h('button', {
                class: 'btn',
                onclick: async () => {
                  toast(config.source === 'screen' ? 'กำลังอ่านหน้าจอมือถือ…' : 'กำลังอ่านรูปล่าสุดในแกลเลอรี่…');
                  S.jobScreen = await attempt(() => call('jobs:screen')) || null;
                  renderInspector();
                },
              }, config.source === 'screen' ? 'ลองอ่านหน้าจอมือถือตอนนี้' : 'ลองอ่านรูปล่าสุดในแกลเลอรี่')),
            S.jobScreen && h('div', { class: 'stack' },
              h('div', { class: 'muted' }, S.jobScreen.text ? 'ข้อความที่แอปอ่านได้:' : config.source === 'screen' ? 'อ่านข้อความจากหน้าจอนี้ไม่ได้ แอปนี้อาจปิดกั้นการอ่านหน้าจอ' : 'ไม่พบรูปใน 24 ชั่วโมงที่ผ่านมา หรืออ่านข้อความจากรูปไม่ได้'),
              S.jobScreen.text && h('pre', { class: 'job-screen mono' }, S.jobScreen.text),
              S.jobScreen.notes.length > 0 && h('div', { class: 'muted' }, S.jobScreen.notes.join(' · ')),
              S.jobScreen.values.some(Boolean) && h('dl', { class: 'facts' }, S.jobScreen.values.flatMap((value, index) => (value
                ? [h('dt', null, inputLabel(index + 1)), h('dd', { class: 'mono' }, `${value} · ${screenHas(S.jobScreen.text, value) ? 'เห็น' : 'ไม่เห็น'}`)]
                : []))),
              config.closeBy === 'profile' && S.jobScreen.slip && h('dl', { class: 'facts' },
                [['ยอดเงิน', S.jobScreen.slip.amount], ['ธนาคารที่จ่าย', S.jobScreen.slip.bank_name_th], ['บัญชีที่จ่าย', S.jobScreen.slip.sender_account_masked],
                  ['ธนาคารผู้รับ', S.jobScreen.slip.receiver_bank_name_th], ['บัญชีผู้รับ', S.jobScreen.slip.receiver_account_masked]]
                  .flatMap(([name, value]) => [h('dt', null, name), h('dd', { class: 'mono' }, value || 'อ่านไม่ได้')]))),
          ])),
      h('div', { class: 'section' },
        h('h3', null, '5. รับงาน'),
        h('div', { class: 'stack' },
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn',
              disabled: !jobs.open,
              onclick: async () => {
                S.jobRead = await attempt(() => call('jobs:read')) || null;
                renderInspector();
              },
            }, 'อ่านงานตอนนี้'),
            h('button', {
              class: 'btn primary',
              disabled: !jobs.open || jobs.auto,
              onclick: async () => {
                const values = await attempt(() => call('jobs:read'));
                if (!values) return;
                S.jobRead = values;
                renderInspector();
                const shown = values.slice(0, needed).map((value, index) => `${inputLabel(index + 1)}: ${value || '(ไม่พบ)'}`).join('\n');
                if (!(await confirmDialog('รันงานนี้?', `${shown || 'ไม่มีค่าที่ต้องส่ง'}\n\nรัน "${config.workflow}" ด้วยค่านี้`, 'รัน', false))) return;
                if (await apply(() => call('jobs:run'))) toast('รันงานเสร็จแล้ว', 'success');
              },
            }, 'รันงานนี้')),
          S.jobRead && h('dl', { class: 'facts' }, S.jobRead.flatMap((value, index) => [h('dt', null, inputLabel(index + 1)), h('dd', { class: 'mono' }, value || 'ไม่พบ')])),
          toggle('รับงานอัตโนมัติ', jobs.auto, async (checked) => {
            if (checked && !(await confirmDialog('เปิดรับงานอัตโนมัติ?',
              `แอปจะอ่านงานจากหน้าเว็บทุก ${config.interval} วินาที แล้วรัน "${config.workflow}" เองโดยไม่มีคนตรวจค่า\n\nเวิร์กโฟลว์แตะตามตำแหน่งบนจอ ไม่ได้ตรวจว่าผลลัพธ์ถูก ลองกด "รันงานนี้" ให้ผ่านหลายงานก่อน\n\nโหมดนี้หยุดเองเมื่อมีขั้นไหนล้มเหลว และปิดทุกครั้งที่เปิดแอปใหม่`, 'เปิดอัตโนมัติ'))) {
              renderInspector();
              return;
            }
            apply(() => call('jobs:auto', { on: checked }));
          }),
          h('div', { class: 'form-grid' },
            field('ตรวจงานใหม่ทุก (วินาที)', h('input', { class: 'field', type: 'number', min: 2, max: 600, value: config.interval, onchange: (event) => set({ interval: event.target.value }) })),
            h('div', { class: 'job-reload' }, toggle('รีเฟรชหน้าเมื่อไม่พบงาน', config.reload, (checked) => set({ reload: checked })))))));
  },

  policy() {
    const policy = S.policy;
    const device = focusDevice();
    const names = Object.keys(S.policies).sort();
    const save = async () => {
      const policies = await attempt(() => call('policy:save', policy));
      if (!policies) return;
      S.policies = policies;
      toast('บันทึกกฎแล้ว', 'success');
      renderInspector();
    };
    return h('div', { class: 'stack' },
      h('div', { class: 'section' },
        h('h3', null, 'กฎของแอป'),
        h('p', { class: 'hint' }, 'กฎมีผลเมื่อแอปนั้นอยู่หน้าจอ ใช้กันไม่ให้สั่งงานอัตโนมัติหรือจับภาพในแอปที่อ่อนไหว'),
        h('div', { class: 'stack' },
          h('div', { class: 'row' },
            input(policy.pkg, (value) => { policy.pkg = value.trim(); }, { placeholder: 'com.example.app', class: 'field mono' }),
            h('button', {
              class: 'btn',
              disabled: !device || !device.online,
              onclick: async () => {
                const pkg = await attempt(() => call('policy:detect', { serial: device.serial }));
                if (pkg === undefined) return;
                if (!pkg) { toast('อ่านแอปที่อยู่หน้าจอไม่ได้', 'error'); return; }
                S.policy = { pkg, mode: 'assisted', allow_capture: true, notes: '', ...(S.policies[pkg] || {}) };
                renderInspector();
              },
            }, 'ตรวจจากหน้าจอ')),
          field('โหมด', h('select', { class: 'field', onchange: (event) => { policy.mode = event.target.value; } },
            Object.entries(POLICY_TH).map(([mode, label]) => h('option', { value: mode, selected: mode === policy.mode }, label)))),
          toggle('อนุญาตให้จับภาพหน้าจอและเปิดหน้าจอสด', policy.allow_capture, (checked) => { policy.allow_capture = checked; }),
          field('หมายเหตุ', input(policy.notes, (value) => { policy.notes = value; })),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', onclick: save }, 'บันทึกกฎ'),
            h('button', {
              class: 'btn danger',
              disabled: !S.policies[policy.pkg],
              onclick: async () => {
                const policies = await attempt(() => call('policy:delete', { pkg: policy.pkg }));
                if (!policies) return;
                S.policies = policies;
                renderInspector();
              },
            }, 'ลบกฎ')))),
      h('div', { class: 'section' },
        h('h3', null, `กฎที่ตั้งไว้ (${names.length})`),
        names.length
          ? h('div', { class: 'list tall' }, names.map((pkg) => h('div', {
            class: `list-item ${policy.pkg === pkg ? 'selected' : ''}`,
            onclick: () => { S.policy = { pkg, mode: 'assisted', allow_capture: true, notes: '', ...S.policies[pkg] }; renderInspector(); },
          },
          h('span', { class: 'grow mono' }, pkg),
          h('span', { class: `badge ${S.policies[pkg].mode === 'blocked' ? 'error' : S.policies[pkg].mode === 'manual_only' ? 'unauthorized' : 'online'}` }, POLICY_TH[S.policies[pkg].mode] || S.policies[pkg].mode),
          S.policies[pkg].allow_capture === false && h('span', { class: 'badge' }, 'ห้ามจับภาพ'))))
          : h('div', { class: 'muted' }, 'ยังไม่มีกฎ ทุกแอปสั่งงานอัตโนมัติได้')));
  },

  log() {
    const filters = [['all', 'ทั้งหมด'], ['warning', 'คำเตือน'], ['error', 'ข้อผิดพลาด']];
    const shown = S.logs.filter((entry) => S.logFilter === 'all' || entry.level === S.logFilter);
    return h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('div', { class: 'segment' }, filters.map(([value, label]) => h('button', {
          class: S.logFilter === value ? 'active' : '', onclick: () => { S.logFilter = value; renderInspector(); },
        }, label))),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => attempt(() => call('folder:open', { which: 'data' })) }, 'เปิดโฟลเดอร์ข้อมูล')),
      shown.length
        ? h('div', { class: 'log mono', id: 'log-lines' }, shown.slice(-300).reverse().map((entry) => h('div', { class: `log-line ${entry.level}` },
          h('span', { class: 'time' }, timeOf(entry.at)), h('span', { class: 'msg' }, entry.message))))
        : h('div', { class: 'empty' }, 'ยังไม่มีรายการ'));
  },

  settings() {
    const config = S.config;
    const number = (label, key, extra) => field(label, h('input', {
      class: 'field', type: 'number', value: config[key] ?? '', ...extra,
      onchange: async (event) => { await setConfig({ [key]: event.target.value }); renderHeader(); applyThumbAuto(); renderInspector(); },
    }));
    const tool = (name, label) => h('div', { class: 'stack' },
      h('span', { class: 'label' }, label),
      h('div', { class: 'row' },
        h('div', { class: 'field mono grow row' }, S.tools[name] || 'ไม่พบ'),
        h('button', {
          class: 'btn',
          onclick: async () => {
            const tools = await attempt(() => call('tool:locate', { tool: name }));
            if (!tools) return;
            S.tools = tools;
            renderInspector();
            renderFooter();
          },
        }, 'ระบุตำแหน่ง…')));
    return h('div', { class: 'stack' },
      h('div', { class: 'section' },
        h('h3', null, `อัปเดต · เวอร์ชัน ${S.version}`),
        h('p', { class: 'hint' }, 'ตรวจอัปเดตเองทุก 24 ชั่วโมง ดาวน์โหลดแล้วแจ้งเตือน และเริ่มใช้เมื่อรีสตาร์ต'),
        h('div', { class: 'stack' },
          h('div', { class: 'muted' }, updateSummary()),
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                const update = await attempt(() => call('update:check'));
                if (!update) return;
                S.update = update;
                if (update.status === 'current') toast('เป็นเวอร์ชันล่าสุดแล้ว', 'success');
                renderHeader();
                renderInspector();
              },
            }, 'ตรวจอัปเดตตอนนี้'),
            S.update.status === 'updated' && h('button', { class: 'btn primary', onclick: restartForUpdate }, 'รีสตาร์ตเพื่ออัปเดต')))),
      h('div', { class: 'section' },
        h('h3', null, 'การสแกนและภาพหน้าจอ'),
        h('div', { class: 'form-grid' },
          number('สแกนอัตโนมัติทุก (วินาที)', 'auto_scan_interval_seconds', { min: 5 }),
          number('ภาพอัตโนมัติทุก (วินาที)', 'thumbnail_interval_seconds', { min: 3 }))),
      h('div', { class: 'section' },
        h('h3', null, 'เกณฑ์แจ้งเตือนสุขภาพเครื่อง'),
        h('div', { class: 'form-grid' },
          number('แบตเตอรี่ต่ำกว่า (%)', 'low_battery_percent', { min: 1, max: 100 }),
          number('อุณหภูมิสูงกว่า (°C)', 'high_temp_c', { min: 25, max: 80, step: 0.5 }))),
      apiSettings(),
      h('div', { class: 'section' },
        h('h3', null, 'เครื่องมือ'),
        h('div', { class: 'stack' },
          tool('adb', 'adb'),
          tool('scrcpy', 'scrcpy'),
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                if (await attempt(() => call('adb:restart').then(() => true))) toast('รีสตาร์ต ADB แล้ว', 'success');
              },
            }, 'รีสตาร์ต ADB'),
            h('button', { class: 'btn ghost', onclick: () => attempt(() => call('folder:open', { which: 'data' })) }, 'โฟลเดอร์ข้อมูล'),
            h('button', { class: 'btn ghost', onclick: () => attempt(() => call('folder:open', { which: 'captures' })) }, 'โฟลเดอร์ภาพหน้าจอ')))));
  },
};

/** A quick look for the setup screen only. The real check runs in the main process. */
function screenHas(text, value) {
  const digits = (input) => String(input).replace(/[,\- ]/g, '');
  return digits(text).includes(digits(value));
}

function apiSettings() {
  const config = S.config;
  const address = `http://${config.api_lan ? 'IP-ของเครื่องนี้' : '127.0.0.1'}:${config.api_port}`;
  const set = async (patch) => { await setConfig(patch); renderInspector(); };
  const copy = async (text, what) => {
    await navigator.clipboard.writeText(text);
    toast(`คัดลอก${what}แล้ว`, 'success');
  };
  const names = Object.keys(S.workflows).sort();
  const sample = names.find((name) => workflowInputCount(S.workflows[name])) || names[0] || 'ชื่อเวิร์กโฟลว์';
  const example = `curl -X POST ${address}/api/run -H "Authorization: Bearer ${config.api_token || 'KEY'}" -H "Content-Type: application/json" -d "{\\"workflow\\":\\"${sample}\\",\\"values\\":[\\"1234567890\\",\\"250\\"]}"`;
  return h('div', { class: 'section' },
    h('h3', null, 'รับงานจากเว็บ (API)'),
    h('p', { class: 'hint' }, 'ให้ระบบอื่นสั่งรันเวิร์กโฟลว์ที่บันทึกไว้ พร้อมส่งค่ามาแทน {1} และ {2} ทุกคำขอต้องมีคีย์'),
    h('div', { class: 'stack' },
      toggle('เปิดรับงานจากเว็บ', Boolean(config.api_enabled), (checked) => set({ api_enabled: checked })),
      config.api_enabled && [
        toggle('ให้เครื่องอื่นในวง LAN เรียกได้', Boolean(config.api_lan), async (checked) => {
          if (checked && !(await confirmDialog('เปิดให้เครื่องอื่นเรียก?', 'ทุกเครื่องในเครือข่ายเดียวกันที่มีคีย์ จะสั่งมือถือในแร็กนี้ได้ การเชื่อมต่อไม่ได้เข้ารหัส ใช้เฉพาะเครือข่ายที่ไว้ใจได้ และอย่าเปิดพอร์ตนี้ออกอินเทอร์เน็ตโดยตรง', 'เปิด'))) {
            renderInspector();
            return;
          }
          set({ api_lan: checked });
        }),
        h('div', { class: 'form-grid' },
          field('พอร์ต', h('input', { class: 'field', type: 'number', min: 1024, max: 65535, value: config.api_port, onchange: (event) => set({ api_port: event.target.value }) })),
          field('ที่อยู่', h('div', { class: 'field mono row' }, address))),
        field('คีย์ (ส่งในหัวข้อ Authorization: Bearer …)', h('div', { class: 'field mono row api-key' }, config.api_token)),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: () => attempt(() => copy(config.api_token, 'คีย์')) }, 'คัดลอกคีย์'),
          h('button', { class: 'btn', onclick: () => attempt(() => copy(example, 'ตัวอย่างคำสั่ง')) }, 'คัดลอกตัวอย่าง curl'),
          h('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!(await confirmDialog('เปลี่ยนคีย์?', 'ระบบที่ใช้คีย์เดิมจะเรียกไม่ได้จนกว่าจะใส่คีย์ใหม่', 'เปลี่ยนคีย์'))) return;
              const fresh = await attempt(() => call('api:token'));
              if (!fresh) return;
              S.config = fresh;
              renderInspector();
            },
          }, 'เปลี่ยนคีย์')),
        h('div', { class: 'muted mono api-example' }, `POST ${address}/api/run\n{"workflow": "${sample}", "values": ["1234567890", "250"], "serial": "ไม่ใส่ก็ได้ถ้ามีเครื่องเดียว"}`),
      ]));
}

function renderInspector() {
  const [title, hint] = VIEW_HINTS[S.view];
  const body = h('div', { class: 'pane-body' }, VIEWS[S.view]());
  const restore = keepScroll($('inspector'));
  $('inspector').replaceChildren(
    h('div', { class: 'pane-head' }, h('div', { class: 'grow' }, h('h2', null, title), h('p', null, hint))),
    body,
  );
  restore();
}

/** Re-render while the user is typing in a filter box, then put the caret back. */
renderInspector.keepFocus = () => {
  const active = document.activeElement;
  const id = active && active.id;
  const caret = active && active.selectionStart;
  renderInspector();
  if (id && $(id)) {
    $(id).focus();
    $(id).setSelectionRange(caret, caret);
  }
};

async function loadApkLibrary() {
  const data = await attempt(() => call('apk:library'));
  if (!data) return;
  Object.assign(S.apk, data);
  if (!data.items.some((item) => item.path === S.apk.selected)) S.apk.selected = null;
  if (S.view === 'apk') renderInspector();
}

// ── events from the main process ──────────────────────────────────────────

const typing = () => {
  const active = document.activeElement;
  return active && $('inspector').contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
};

window.farm.on('devices', ({ devices, scannedAt }) => {
  S.devices = devices;
  if (scannedAt) S.scannedAt = scannedAt;
  const known = new Set(devices.map((device) => device.serial));
  S.selected = new Set([...S.selected].filter((serial) => known.has(serial)));
  if (!known.has(S.focus)) S.focus = [...S.selected][0] || null;
  if (!S.focus && devices.length) {
    S.focus = devices[0].serial;
    S.selected.add(S.focus);
  }
  renderHeader();
  renderDevices();
  // Do not rebuild a form the user is typing in; it picks up fresh data on the next interaction.
  if (!typing() && ['info', 'actions', 'live', 'apps', 'apk', 'workflow', 'jobs', 'withdraw'].includes(S.view)) renderInspector();
});

window.farm.on('jobs', (jobs) => {
  S.jobs = jobs;
  if ((S.view === 'jobs' || S.view === 'withdraw') && !typing()) renderInspector();
});

window.farm.on('thumb', ({ serial, dataUrl, error, at }) => {
  S.thumbs[serial] = error ? { ...S.thumbs[serial], error, at } : { dataUrl, at };
  renderDevices();
});

window.farm.on('log', (entry) => {
  S.logs.push(entry);
  if (S.logs.length > 500) S.logs.shift();
  if (S.view === 'log') renderInspector();
});

window.farm.on('touch', ({ serial, steps, stopped }) => {
  if (S.pick.rec && S.pick.rec.serial === serial) {
    if (stopped) {
      S.pick.rec = null;
      if (S.view === 'workflow') renderInspector();
      return;
    }
    const tap = steps.find((step) => step.startsWith('tap '));
    if (tap) keepPickTap(tap.slice(4));
    return;
  }
  if (!S.rec || S.rec.serial !== serial) return;
  if (stopped) {
    toast(`หยุดบันทึกแล้ว · ได้ ${S.rec.count} ขั้นตอน`, 'success');
    S.rec = null;
  } else {
    Object.assign(S.wf, { text: workflowText([...workflowSteps(S.wf.text), ...workflowSteps(steps.join('\n'))]), preview: null });
    S.rec.count += steps.filter((step) => !step.startsWith('wait ')).length;
  }
  if (S.view === 'workflow' && !typing()) renderInspector();
});

window.farm.on('timeline', (entry) => {
  if (S.timeline && S.timeline.run === null) S.timeline.run = entry.run;
  if (!S.timeline || S.timeline.run !== entry.run) S.timeline = { name: entry.name, rows: [], running: true, run: entry.run };
  const { rows } = S.timeline;
  const index = rows.findIndex((row) => row.serial === entry.serial && row.index === entry.index);
  if (index < 0) rows.push(entry);
  else rows[index] = entry;
  if (S.view !== 'workflow' || typing()) return;
  renderInspector();
  showTimeline();
});

window.farm.on('job', (job) => {
  S.job = job;
  renderFooter();
  if (!job.running && S.timeline && S.timeline.running) {
    S.timeline.running = false;
    if (S.view === 'workflow' && !typing()) renderInspector();
  }
});

window.farm.on('update', (update) => {
  const fresh = update.status === 'updated' && S.update.status !== 'updated';
  S.update = update;
  if (fresh) toast(`อัปเดต ${update.version} พร้อมแล้ว รีสตาร์ตเพื่อใช้`, 'success');
  renderHeader();
  if (S.view === 'settings' && !typing()) renderInspector();
});

window.farm.on('status', ({ scanning }) => {
  S.scanning = scanning;
  renderHeader();
});

(async function start() {
  const state = await call('state:get');
  Object.assign(S, {
    version: state.version,
    update: state.update,
    config: state.config,
    tools: state.tools,
    dataDir: state.dataDir,
    devices: state.devices,
    workflows: state.workflows,
    points: state.points,
    pickSets: state.pickSets || {},
    jobs: state.jobs,
    policies: state.policies,
    profiles: state.profiles,
    logs: state.logs.slice(),
  });
  S.apk.dir = state.apkLibraryDir;
  root.dataset.theme = S.config.theme === 'light' ? 'light' : 'dark';
  renderHeader();
  renderNav();
  renderDevices();
  renderInspector();
  renderFooter();
})();
