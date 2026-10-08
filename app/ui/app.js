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
  wf: { name: '', text: '', preview: null },
  policy: { pkg: '', mode: 'assisted', allow_capture: true, notes: '' },
  logFilter: 'all',
};

const NAV = [
  ['อุปกรณ์', [['info', 'ข้อมูลเครื่อง', 'info'], ['actions', 'สั่งงาน', 'zap'], ['live', 'หน้าจอสด', 'monitor'], ['apps', 'แอป', 'grid']]],
  ['ฟลีต', [['apk', 'ติดตั้ง APK', 'box'], ['workflow', 'เวิร์กโฟลว์', 'list'], ['policy', 'กฎของแอป', 'shield']]],
  ['ระบบ', [['log', 'บันทึก', 'file'], ['settings', 'ตั้งค่า', 'sliders']]],
];
const VIEW_HINTS = {
  info: ['ข้อมูลเครื่อง', 'รายละเอียดและชื่อเรียกของเครื่องที่เลือก'],
  actions: ['สั่งงาน', 'ส่งคำสั่งไปยังทุกเครื่องที่เลือก'],
  live: ['หน้าจอสด', 'ควบคุมหน้าจอจริงผ่าน scrcpy'],
  apps: ['แอป', 'แอปที่ติดตั้งในเครื่องที่เลือก'],
  apk: ['ติดตั้ง APK', 'คลัง APK และการติดตั้งหลายเครื่องพร้อมกัน'],
  workflow: ['เวิร์กโฟลว์', 'ชุดคำสั่งที่บันทึกไว้ รันเมื่อสั่งเท่านั้น'],
  policy: ['กฎของแอป', 'กำหนดว่าแอปไหนสั่งงานอัตโนมัติหรือจับภาพได้'],
  log: ['บันทึก', 'เหตุการณ์ของรอบการทำงานนี้'],
  settings: ['ตั้งค่า', 'ธีม การสแกน และตำแหน่งเครื่องมือ'],
};
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
      h('h1', null, 'Farm Manager'),
      h('div', { class: 'status' }, h('span', { class: `dot ${S.scanning ? 'busy' : online ? 'on' : ''}` }), status)),
    h('div', { class: 'spacer' }),
    S.update.status === 'updated' && h('button', { class: 'btn update', onclick: restartForUpdate },
      `อัปเดต ${S.update.version} พร้อมแล้ว · รีสตาร์ต`),
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

function renderDevices() {
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
          }, 'บันทึก'))));
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
    return h('div', { class: 'stack' },
      targetBanner(),
      h('div', { class: 'form-grid' },
        field('ที่บันทึกไว้', h('select', { class: 'field', onchange: (event) => loadWorkflow(event.target.value) },
          names.map((name) => h('option', { value: name, selected: name === wf.name }, name)))),
        field('ชื่อ', input(wf.name, (value) => { wf.name = value; }))),
      field('ขั้นตอน (หนึ่งคำสั่งต่อบรรทัด)', h('textarea', {
        class: 'field mono', spellcheck: false, value: wf.text, oninput: (event) => { wf.text = event.target.value; },
      })),
      h('div', { class: 'muted mono' }, 'wait 500 · back · home · recent · wake · sleep · open <package> · text <ข้อความ> · keyevent KEYCODE_ENTER · screenshot'),
      h('div', { class: 'row wrap' },
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const steps = await attempt(() => call('workflow:preview', { text: wf.text }));
            if (!steps) return;
            const count = onlineTargets().length;
            if (!(await confirmDialog('รันเวิร์กโฟลว์?', `รัน "${wf.name || 'Workflow'}" ${steps.length} ขั้นตอน บน ${count} เครื่องที่เลือก`, 'รัน', false))) return;
            const outcome = await attempt(() => call('workflow:run', { name: wf.name, text: wf.text, serials: targets() }));
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
      wf.preview && h('div', { class: 'section' },
        h('h3', null, `ผ่านการตรวจสอบ · ${wf.preview.length} ขั้นตอน`),
        h('div', { class: 'mono' }, wf.preview.map((step, index) => h('div', null, `${index + 1}. ${step.command} ${step.argument}`)))));
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

function renderInspector() {
  const [title, hint] = VIEW_HINTS[S.view];
  const body = h('div', { class: 'pane-body' }, VIEWS[S.view]());
  const previous = document.querySelector('#inspector .pane-body');
  const scroll = previous ? previous.scrollTop : 0;
  $('inspector').replaceChildren(
    h('div', { class: 'pane-head' }, h('div', { class: 'grow' }, h('h2', null, title), h('p', null, hint))),
    body,
  );
  body.scrollTop = scroll;
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
  if (!typing() && ['info', 'actions', 'live', 'apps', 'apk', 'workflow'].includes(S.view)) renderInspector();
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

window.farm.on('job', (job) => {
  S.job = job;
  renderFooter();
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
