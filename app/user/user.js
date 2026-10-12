'use strict';

// The window of OneTwo ADB, the program handed to other people. Three pages: home, history,
// settings. Everything used daily is on the home page. All text is Thai, the faults too.

const S = { state: null, page: 'home', wizard: 'link', signedIn: false, busy: false, stale: false };
const SPEEDS = [[1.5, 'ช้า (เครื่องหรือเน็ตช้า)'], [1, 'ปกติ'], [0.8, 'เร็ว'], [0.6, 'เร็วมาก']];
const BANK = 'ธนาคารกรุงเทพ';
const PHONE_STATE = { running: 'กำลังโอน', checking: 'อ่านสลิป', closing: 'ปิดงาน', resting: 'กำลังพัก' };
const ROW_STATE = { started: ['ค้าง ต้องตรวจ', 'bad'], paid: ['จ่ายแล้ว รอปิดงาน', 'run'], done: ['ปิดงานแล้ว', 'ok'], failed: ['ไม่สำเร็จ', 'bad'], resolved: ['จัดการแล้ว', 'wait'] };
const LICENSE_REASON = { missing: 'ยังไม่ได้ใส่รหัสเปิดใช้', forged: 'รหัสเปิดใช้ไม่ถูกต้อง', machine: 'รหัสนี้เป็นของคอมเครื่องอื่น', expired: 'รหัสเปิดใช้หมดอายุแล้ว', cancelled: 'รหัสเปิดใช้ถูกยกเลิก', offline: 'ต้องต่ออินเทอร์เน็ตเพื่อตรวจรหัสเปิดใช้' };

// ── small tools ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === false || child === null || child === undefined || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const money = (value) => Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (value) => Number(value).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const timeOf = (at) => (at ? new Date(at).toLocaleTimeString('th-TH', { hour12: false }) : '');
const dayOf = (at) => new Date(at).toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit' });
/** An account number is never shown whole: the last four digits are enough to tell accounts apart. */
const tail = (account) => (account ? `···${String(account).slice(-4)}` : '—');
const isToday = (at) => new Date(at).toDateString() === new Date().toDateString();

/** What went wrong, in Thai. The program's own messages are English, for the log. */
const FAULTS = [
  [/slip does not agree on .*the amount \(slip ([^,]+), row ([^)]+)\)/, (m) => `ยอดในสลิปไม่ตรงกับรายการ (สลิป ${m[1] === 'unread' ? 'อ่านไม่ได้' : m[1]} · รายการ ${m[2]})`],
  [/slip does not agree on .*the account paid to/, () => 'เลขบัญชีปลายทางในสลิปไม่ตรงกับรายการ'],
  [/slip does not agree on .*the paying account/, () => 'สลิปไม่ได้มาจากบัญชีของเครื่องนี้'],
  [/slip does not agree on .*the paying bank/, () => 'ธนาคารในสลิปไม่ตรงกับบัญชีของเครื่องนี้'],
  [/slip does not agree/, () => 'สลิปไม่ตรงกับรายการ'],
  [/saved no new picture/, () => 'โอนแล้วแต่ไม่พบสลิปใหม่ในเครื่อง'],
  [/Unable to read the screen size/, () => 'อ่านขนาดหน้าจอของเครื่องไม่ได้ สายหรือการเชื่อมต่ออาจหลุด'],
  [/Unable to read the file/, () => 'ดึงรูปสลิปจากเครื่องไม่ได้ สายหรือการเชื่อมต่ออาจหลุด'],
  [/unauthorized/, () => 'เครื่องยังไม่อนุญาตการแก้ไขข้อบกพร่อง USB กดอนุญาตบนหน้าจอเครื่อง'],
  [/not online|device .* not found|device offline|no devices/i, () => 'เครื่องหลุดการเชื่อมต่อ'],
  [/No PIN is set|PIN kept for this phone/, () => 'ยังไม่ได้ตั้ง PIN ของเครื่อง หรืออ่าน PIN ไม่ได้ ตั้งใหม่ที่รายละเอียดเครื่อง'],
  [/A PIN is 4 to 12 digits/, () => 'PIN ต้องเป็นตัวเลข 4 ถึง 12 หลัก'],
  [/An account number is 6 to 20 digits/, () => 'เลขบัญชีต้องเป็นตัวเลข 6 ถึง 20 หลัก'],
  [/Enter the smallest and the largest amount/, () => 'ใส่ยอดต่ำสุดและยอดสูงสุด เช่น 100 และ 499'],
  [/is an amount of money, or empty/, () => 'เพดานและยอดคงเหลือต้องเป็นตัวเลข หรือเว้นว่าง'],
  [/Sign in to the back office first|Open the back office and sign in first/, () => 'ล็อกอินหลังบ้านก่อน'],
  [/Enter the back-office address first/, () => 'ใส่ลิงก์หลังบ้านก่อน ขึ้นต้นด้วย https://'],
  [/Pay one row by hand first/, () => 'กดจ่ายเองให้สำเร็จหนึ่งรายการก่อน จึงเปิดจ่ายอัตโนมัติได้'],
  [/Withdrawals are stopped/, () => 'โปรแกรมหยุดอยู่ ตรวจรายการสีแดงแล้วกดรีเซ็ตก่อน'],
  [/no longer on the page/, () => 'รายการนี้ไม่อยู่ในหน้าหลังบ้านแล้ว'],
  [/already begun by this app/, () => 'รายการนี้เคยเริ่มจ่ายแล้ว โปรแกรมไม่จ่ายซ้ำ'],
  [/Every phone that can pay .* is busy/, () => 'เครื่องที่รับยอดนี้กำลังทำงานอยู่ ลองใหม่อีกครู่'],
  [/The phone that takes .* is stopped/, () => 'เครื่องที่รับยอดนี้หยุดอยู่ ตรวจแล้วรีเซ็ตเครื่องนั้นก่อน'],
  [/No online phone can pay/, () => 'ไม่มีเครื่องที่พร้อมจ่ายยอดนี้'],
  [/no close-job profile/, () => 'ชุดงานนี้ไม่มีขั้นตอนปิดงานสำหรับหลังบ้านนี้'],
  [/Choose a saved workflow for paying first/, () => 'ยังไม่มีชุดงาน นำเข้าชุดงานที่หน้าตั้งค่า'],
  [/Switch automatic mode off and wait/, () => 'ปิดจ่ายอัตโนมัติและรอให้ทุกเครื่องทำงานเสร็จก่อน'],
  [/No earlier pack is kept/, () => 'ไม่มีชุดงานรุ่นก่อนเก็บไว้ในเครื่องนี้'],
  [/pack is not signed by the owner|not a pack/, () => 'ไฟล์นี้ไม่ใช่ชุดงานจากผู้พัฒนา'],
  [/pack needs program version/, () => 'ชุดงานนี้ต้องใช้โปรแกรมรุ่นใหม่กว่า อัปเดตโปรแกรมก่อน'],
  [/Paste the activation code/, () => 'วางรหัสเปิดใช้ก่อน'],
  [/not an activation code from the owner/, () => LICENSE_REASON.forged],
  [/code is for another computer/, () => LICENSE_REASON.machine],
  [/code has expired/, () => LICENSE_REASON.expired],
  [/code was cancelled/, () => LICENSE_REASON.cancelled],
  [/not activated/, () => 'โปรแกรมยังไม่ได้เปิดใช้'],
  [/could not be switched|switch .* account/i, () => 'เปิดหรือปิดบัญชีของเครื่องในหลังบ้านไม่ได้'],
  [/step \d+ \((\w+)\)/, (m) => `เวิร์กโฟลว์บนเครื่องทำไม่จบ (ขั้น ${m[0].match(/\d+/)[0]})`],
  [/Wait for ".*" to finish first|already running/, () => 'มีงานกำลังทำอยู่ รอให้เสร็จก่อน'],
];

function thai(message) {
  const text = String(message || '');
  for (const [pattern, say] of FAULTS) {
    const match = text.match(pattern);
    if (match) return say(match);
  }
  return text;
}

function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, text);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

/** Ask the program for something. Resolves with the answer, or null after saying what went wrong. */
async function ask(channel, payload) {
  const answer = await window.farm.call(channel, payload);
  if (answer.ok) return answer.data;
  toast(thai(answer.error), 'bad');
  return null;
}

/** Take in whatever a request answered: the whole state, the devices, or the jobs. */
function absorb(data) {
  if (!data || !S.state) return;
  if (data.version && data.jobs) S.state = data;
  else if (Array.isArray(data)) S.state.devices = data;
  else if (Array.isArray(data.devices)) S.state.devices = data.devices;
  else if (data.config && data.orders) S.state.jobs = data;
}

async function act(channel, payload, done) {
  if (S.busy) return null;
  S.busy = true;
  try {
    const data = await ask(channel, payload);
    absorb(data);
    if (data !== null && done) toast(done, 'good');
    return data;
  } finally {
    S.busy = false;
    render(true);
  }
}

// ── what the pages show ──────────────────────────────────────────────────

/** One phone as the home page lists it: its money, and the one word that says how it stands. */
function phoneView(device) {
  const { jobs } = S.state;
  const listed = jobs.accounts.fresh && device.pay.account ? jobs.accounts.map[device.pay.account] || null : null;
  const balance = listed && listed.balance !== null ? listed.balance : device.pay.balance;
  const spent = jobs.spent[device.serial] || 0;
  const stop = jobs.stops[device.serial] || null;
  const working = jobs.paying[device.serial];
  const unset = !device.hasPin || !device.pay.account || device.amountMin === null;
  let word = ['พร้อม', 'ok'];
  if (stop) word = ['หยุด', 'bad'];
  else if (!device.online) word = ['ออฟไลน์', 'wait'];
  else if (working) word = [PHONE_STATE[working.state] || 'กำลังทำงาน', 'run'];
  else if (unset) word = ['ยังตั้งไม่ครบ', 'run'];
  else if (!device.payOn) word = ['ปิดอยู่', 'wait'];
  else if (listed && listed.on === false) word = ['ปิดในหลังบ้าน', 'wait'];
  else if (balance !== null && balance < device.amountMin) word = ['เงินหมด', 'bad'];
  else if (device.pay.cap !== null && spent >= device.pay.cap) word = ['ถึงเพดาน', 'wait'];
  return { device, balance, spent, stop, word, ready: word[0] === 'พร้อม' || Boolean(working) };
}

const signedOut = () => !S.state.jobs.open || !S.signedIn;
const packName = () => {
  const { current } = S.state.user.pack;
  return current ? `${current.name} ${current.version}` : 'ยังไม่มีชุดงาน';
};

// ── pages ────────────────────────────────────────────────────────────────

function activation() {
  const { license } = S.state.user;
  return h('div', { class: 'wiz' },
    wizardSteps('code'),
    h('div', { class: 'form' },
      h('div', { class: 't' }, 'รหัสเปิดใช้'),
      h('div', { class: 's' }, 'ส่งรหัสเครื่องด้านล่างให้ผู้พัฒนา แล้ววางรหัสเปิดใช้ที่ได้รับกลับมา รหัสหนึ่งใช้ได้กับคอมเครื่องนี้เครื่องเดียว'),
      h('div', { class: 'fld' }, h('label', null, 'รหัสเครื่องของคอมนี้'),
        h('div', { class: 'acts' }, h('span', { class: 'code' }, license.machine || 'อ่านไม่ได้'),
          h('button', { class: 'lk', onclick: () => navigator.clipboard.writeText(license.machine).then(() => toast('คัดลอกรหัสเครื่องแล้ว', 'good')) }, 'คัดลอก'))),
      h('div', { class: 'fld' }, h('label', null, 'รหัสเปิดใช้'), h('textarea', { class: 'inp', id: 'license-code', spellcheck: 'false' })),
      license.reason && license.reason !== 'missing' && h('div', { class: 'badline' }, LICENSE_REASON[license.reason] || 'รหัสเปิดใช้ใช้ไม่ได้'),
      h('div', { class: 'acts' }, h('button', { class: 'btn gold', onclick: () => act('license:set', { code: $('license-code').value }, 'เปิดใช้แล้ว') }, 'เปิดใช้'))));
}

function wizardSteps(now) {
  const { license } = S.state.user;
  const order = ['code', 'link', 'login'];
  const names = { code: 'รหัสเปิดใช้', link: 'ลิงก์หลังบ้าน', login: 'ล็อกอินหลังบ้าน' };
  const mark = (key, index) => {
    const done = order.indexOf(key) < order.indexOf(now);
    return h('div', { class: `stepmark ${done ? 'done' : key === now ? 'now' : ''}` }, h('span', { class: 'd' }, done ? '✓' : index + 1),
      h('span', null, names[key], key === 'code' && license.ok && h('small', null, `ออกโดย ${S.state.user.developer}`)));
  };
  return h('div', { class: 'steps' },
    h('div', { class: 'brand' }, 'OneTwo ', h('span', null, 'ADB')),
    order.map(mark),
    h('div', { class: 'stepmark' }, h('span', { class: 'd' }, 4), h('span', null, 'เครื่องและบัญชี', h('small', null, 'ตั้งที่หน้าหลัก'))),
    h('div', { class: 'stepmark' }, h('span', { class: 'd' }, 5), h('span', null, 'ลองหนึ่งรายการ', h('small', null, 'กดจ่ายเองที่หน้าหลัก'))),
    h('div', { class: 'foot' }, `เวอร์ชัน ${S.state.version}`));
}

function wizard() {
  const { jobs } = S.state;
  if (S.wizard === 'link') {
    return h('div', { class: 'wiz' }, wizardSteps('link'),
      h('div', { class: 'form' },
        h('div', { class: 't' }, 'ลิงก์หลังบ้านของคุณ'),
        h('div', { class: 's' }, 'วางลิงก์หน้าเข้าสู่ระบบของหลังบ้าน โปรแกรมจำไว้ในเครื่องนี้เท่านั้น เปลี่ยนได้ภายหลังที่หน้าตั้งค่า'),
        h('div', { class: 'fld' }, h('label', null, 'ลิงก์หลังบ้าน'), h('input', { class: 'inp', id: 'wizard-url', value: jobs.config.url, placeholder: 'https://', spellcheck: 'false' })),
        h('div', { class: 'acts' }, h('button', { class: 'btn gold', onclick: async () => {
          const url = $('wizard-url').value.trim();
          if (!/^https:\/\/\S+$/i.test(url)) return toast('ลิงก์ต้องขึ้นต้นด้วย https://', 'bad');
          if (await act('jobs:set', { url })) { S.wizard = 'login'; render(true); }
          return null;
        } }, 'ต่อไป'))));
  }
  return h('div', { class: 'wiz' }, wizardSteps('login'),
    h('div', { class: 'form' },
      h('div', { class: 't' }, 'ล็อกอินหลังบ้าน'),
      h('div', { class: 's' }, 'กดเปิดหน้าต่างหลังบ้าน แล้วล็อกอินด้วยชื่อและรหัสของคุณเอง โปรแกรมไม่เห็นและไม่เก็บรหัสผ่าน ปิดหน้าต่างนั้นได้ โปรแกรมยังทำงานต่อ'),
      S.signedIn ? h('div', { class: 'okline' }, 'ล็อกอินอยู่') : h('div', { class: 'hint' }, jobs.open ? 'ยังไม่ได้ล็อกอิน' : 'ยังไม่ได้เปิดหน้าต่างหลังบ้าน'),
      h('div', { class: 'acts' },
        h('button', { class: 'btn', onclick: () => { S.wizard = 'link'; render(true); } }, 'ย้อนกลับ'),
        h('button', { class: `btn ${S.signedIn ? '' : 'gold'}`, onclick: () => act('jobs:open') }, jobs.open ? 'แสดงหน้าต่างหลังบ้าน' : 'เปิดหน้าล็อกอิน'),
        h('button', { class: `btn ${S.signedIn ? 'gold' : ''}`, disabled: !S.signedIn, onclick: () => act('user:setup', { done: true }) }, 'เสร็จ ไปหน้าหลัก'))));
}

function shell(content) {
  const { jobs, version, user } = S.state;
  const nav = (page, name) => h('button', { class: `nav ${S.page === page ? 'on' : ''}`, onclick: () => { S.page = page; render(true); } }, name);
  const days = user.license.daysLeft;
  return h('div', { class: 'shell' },
    h('div', { class: 'rail' },
      h('div', { class: 'brand' }, 'OneTwo ', h('span', null, 'ADB')),
      nav('home', 'หน้าหลัก'), nav('history', 'ประวัติ'), nav('settings', 'ตั้งค่า'),
      h('div', { class: 'foot' },
        h('div', null, 'หลังบ้าน: ', signedOut() ? h('span', { class: 'bad' }, jobs.open ? 'ยังไม่ล็อกอิน' : 'ยังไม่เปิด') : h('span', { class: 'good' }, 'ล็อกอินอยู่')),
        days !== null && days <= 7 && h('div', { class: 'bad' }, `รหัสเปิดใช้เหลือ ${Math.max(0, days)} วัน`),
        h('div', null, `เวอร์ชัน ${version}`))),
    h('div', { class: 'main' }, content));
}

/** What to do about a stop, in the order to do it. `serial` is '' when everything is stopped. */
function stopBlock(stop, serial) {
  const { jobs } = S.state;
  const entry = jobs.history.find((each) => each.key === stop.key);
  const device = S.state.devices.find((each) => each.serial === serial);
  const about = entry ? `รายการ ${money(entry.amount)} ไป${entry.bank || ''} ${tail(entry.account)}` : 'ไม่มีรายการที่เกี่ยวข้อง';
  const open = entry && entry.state !== 'done' && entry.state !== 'resolved';
  return h('div', { class: 'alert' },
    h('div', { class: 'x' },
      h('b', null, `${device ? `${device.label}: ` : ''}${thai(stop.message)}`),
      h('div', null, `${about} · หยุดเมื่อ ${timeOf(stop.at)}`),
      h('small', null, 'เงินอาจออกแล้ว เปิดแอปธนาคารของเครื่องดูรายการล่าสุดก่อน ถ้าเงินออกแล้ว ปิดงานในหลังบ้านเอง ถ้าเงินยังไม่ออก โอนรายการนี้เองด้วยมือ โปรแกรมไม่จ่ายรายการนี้ซ้ำ เสร็จแล้วกด "จัดการแล้ว" จากนั้นจึงกดรีเซ็ต')),
    h('div', { class: 'acts' },
      open && h('button', { class: 'btn', onclick: () => act('jobs:resolve', { key: stop.key, note: 'ตรวจด้วยมือ' }, 'บันทึกว่าจัดการแล้ว') }, 'จัดการแล้ว'),
      h('button', { class: 'btn red', disabled: Boolean(open), title: open ? 'กด "จัดการแล้ว" ก่อน' : '', onclick: () => act('jobs:unhalt', { serial }, 'รีเซ็ตแล้ว') }, serial ? 'รีเซ็ตเครื่องนี้' : 'รีเซ็ต')));
}

function home() {
  const { jobs, devices, user } = S.state;
  const phones = devices.map(phoneView);
  const orders = jobs.orders.list;
  const today = jobs.history.filter((entry) => isToday(entry.at));
  const stopped = Object.entries(jobs.stops);
  const firstDone = jobs.history.some((entry) => entry.state === 'done');
  const out = signedOut();
  const noPack = !user.pack.current;
  const title = jobs.halt ? ['หยุดทำงาน', 'bad'] : noPack ? ['ยังไม่มีชุดงาน', 'bad'] : out ? ['ยังไม่ได้ล็อกอินหลังบ้าน', ''] : jobs.payAuto ? ['กำลังทำงาน', ''] : ['พร้อม', ''];
  const sub = jobs.halt ? `หยุดเมื่อ ${timeOf(jobs.halt.at)} · ไม่มีรายการใดถูกจ่ายต่อจนกว่าจะรีเซ็ต`
    : `${jobs.orders.at ? `ตรวจรายการล่าสุด ${timeOf(jobs.orders.at)}` : 'ยังไม่ได้ตรวจรายการ'} · ชุดงาน ${packName()}${jobs.payAuto ? '' : ' · จ่ายเองทีละรายการ'}`;

  const phoneRow = (view) => h('button', { class: 'row phone', onclick: () => openPhone(view.device.serial) },
    h('span', null, view.device.label),
    h('span', { class: 'c' }, `${tail(view.device.pay.account)}${view.balance !== null ? ` · ${whole(view.balance)}` : ''}`),
    h('span', { class: `st ${view.word[1]}` }, view.word[0]));

  const orderRow = (order) => {
    const onPhone = Object.entries(jobs.paying).find(([, each]) => each.key === order.key);
    const worker = onPhone && devices.find((device) => device.serial === onPhone[0]);
    let status;
    if (onPhone) status = h('span', { class: 'st run' }, `${worker ? worker.label : ''} · ${PHONE_STATE[onPhone[1].state] || 'กำลังทำงาน'}`);
    else if (order.state) status = h('span', { class: `st ${ROW_STATE[order.state] ? ROW_STATE[order.state][1] : 'wait'}` }, ROW_STATE[order.state] ? ROW_STATE[order.state][0] : order.state);
    else if (!order.serial) status = h('span', { class: 'st wait' }, { cap: 'เครื่องถึงเพดาน', balance: 'เงินในเครื่องไม่พอ', off: 'บัญชีเครื่องปิดอยู่', stopped: 'เครื่องหยุดอยู่' }[order.short] || 'ไม่มีเครื่องรับยอดนี้');
    else if (jobs.payAuto) status = h('span', { class: 'st wait' }, `รอ · ${order.phone}`);
    else status = h('span', { class: 'st' }, h('button', { class: 'btn small gold', disabled: Boolean(jobs.halt) || out, onclick: () => act('jobs:pay', { key: order.key }) }, `จ่าย · ${order.phone}`));
    return h('div', { class: 'row order' }, h('span', { class: 'a' }, money(order.amount)), h('span', { class: 'b' }, order.bank), h('span', { class: 'c' }, tail(order.account)), status);
  };

  return shell([
    h('div', { class: 'mh' },
      h('div', null, h('div', { class: `t ${title[1]}` }, title[0]), h('div', { class: 's' }, sub)),
      h('span', { class: 'sp' }),
      out && !jobs.halt && h('button', { class: 'btn gold', onclick: () => act('jobs:open') }, jobs.open ? 'แสดงหน้าต่างหลังบ้าน' : 'เปิดหน้าล็อกอิน'),
      h('button', { class: `sw ${jobs.payAuto ? 'on' : ''}`, disabled: Boolean(jobs.halt) || out, onclick: () => act('jobs:payauto', { on: !jobs.payAuto }) }, h('i'), 'จ่ายอัตโนมัติ')),
    jobs.halt && stopBlock(jobs.halt, ''),
    stopped.map(([serial, stop]) => stopBlock(stop, serial)),
    noPack && h('div', { class: 'alert' },
      h('div', { class: 'x' }, h('b', null, 'โปรแกรมยังไม่มีชุดงาน จึงยังไม่ทำงาน'), h('div', null, 'ชุดงานคือขั้นตอนโอนและปิดงานจากผู้พัฒนา'), h('small', null, 'กด "ตรวจหาชุดงาน" เพื่อรับจากผู้พัฒนาทางอินเทอร์เน็ต หรือกด "นำเข้าจากไฟล์" ถ้าได้รับไฟล์ชุดงานมา')),
      h('div', { class: 'acts' },
        h('button', { class: 'btn', onclick: () => act('pack:import', {}, 'นำเข้าชุดงานแล้ว') }, 'นำเข้าจากไฟล์'),
        h('button', { class: 'btn gold', onclick: async () => { const result = await ask('update:check'); if (result) S.state.update = result; const state = await ask('state:get'); if (state) S.state = state; toast(S.state.user.pack.current ? 'ได้รับชุดงานแล้ว' : 'ยังไม่มีชุดงานจากผู้พัฒนา', S.state.user.pack.current ? 'good' : 'bad'); render(true); } }, 'ตรวจหาชุดงาน'))),
    !noPack && !jobs.halt && !out && !firstDone && h('div', { class: 'note' }, h('span', null, h('b', null, 'ลองหนึ่งรายการก่อน. '), 'ตั้งเครื่องให้ครบ แล้วกด "จ่าย" ที่รายการในคิวหนึ่งรายการ ดูให้จบจนขึ้น "ปิดงานแล้ว" จากนั้นจึงเปิดจ่ายอัตโนมัติได้')),
    h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'จ่ายวันนี้'), h('div', { class: 'v gold' }, money(Object.values(jobs.spent).reduce((sum, value) => sum + value, 0)))),
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'สำเร็จ'), h('div', { class: 'v' }, today.filter((entry) => entry.state === 'done').length)),
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'รอในคิว'), h('div', { class: 'v' }, orders.filter((order) => !order.state).length)),
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'ต้องตรวจ'), h('div', { class: `v ${stopped.length || jobs.halt ? 'bad' : ''}` }, stopped.length + (jobs.halt ? 1 : 0)))),
    h('div', { class: 'cols' },
      h('div', { class: 'pane' },
        h('div', { class: 'h' }, 'เครื่อง', h('b', null, `${phones.filter((view) => view.ready).length} จาก ${phones.length} พร้อม`)),
        h('div', { class: 'list' }, phones.length ? phones.map(phoneRow) : h('div', { class: 'empty' }, S.state.tools.adb ? 'ยังไม่พบเครื่อง เสียบสาย USB และเปิดการแก้ไขข้อบกพร่อง USB ที่มือถือ' : 'ไม่พบตัวเชื่อมต่อมือถือ (ADB) ในคอมเครื่องนี้ ติดตั้งโปรแกรมใหม่ หรือแจ้งผู้พัฒนา'))),
      h('div', { class: 'pane' },
        h('div', { class: 'h' }, 'คิว', h('b', null, 'เรียงตามที่หลังบ้านแสดง')),
        h('div', { class: 'list' }, orders.length ? orders.map(orderRow) : h('div', { class: 'empty' }, out ? 'ล็อกอินหลังบ้านเพื่อดูรายการ' : 'ไม่มีรายการในช่วงยอดของเครื่อง')))),
  ]);
}

function history() {
  const { jobs, devices } = S.state;
  const label = (serial) => (devices.find((device) => device.serial === serial) || { label: serial || '—' }).label;
  const row = (entry) => {
    const state = ROW_STATE[entry.state] || [entry.state, 'wait'];
    const open = entry.state === 'started' || entry.state === 'paid' || entry.state === 'failed';
    return h('div', { class: 'row past' },
      h('span', { class: 'c' }, `${dayOf(entry.at)} ${timeOf(entry.at).slice(0, 5)}`),
      h('span', { class: 'a' }, money(entry.amount)),
      h('span', { class: 'b' }, entry.bank),
      h('span', { class: 'c' }, tail(entry.account)),
      h('span', { class: 'b' }, entry.phone || label(entry.serial)),
      h('span', { class: `st ${state[1]}` }, open && entry.state !== 'failed' ? h('button', { class: 'lk', onclick: () => act('jobs:resolve', { key: entry.key, note: 'ตรวจด้วยมือ' }, 'บันทึกว่าจัดการแล้ว') }, `${state[0]} · จัดการแล้ว`) : state[0]));
  };
  return shell([
    h('div', { class: 'mh' }, h('div', null, h('div', { class: 't' }, 'ประวัติ'), h('div', { class: 's' }, 'ทุกรายการที่โปรแกรมเริ่มจ่าย ใหม่สุดอยู่บน เก็บในเครื่องนี้เท่านั้น'))),
    h('div', { class: 'pane' }, h('div', { class: 'list' }, jobs.history.length ? jobs.history.map(row) : h('div', { class: 'empty' }, 'ยังไม่มีรายการ'))),
  ]);
}

function settings() {
  const { jobs, user, version, update } = S.state;
  const { license, pack } = user;
  const updateWord = { current: ['เป็นเวอร์ชันล่าสุด', 'ok'], updated: [`รุ่น ${update.version} พร้อมแล้ว`, 'run'], error: ['ตรวจไม่ได้ ลองใหม่ภายหลัง', 'bad'], disabled: ['ยังไม่ได้ตั้งช่องอัปเดต', 'wait'] }[update.status] || ['ยังไม่ได้ตรวจ', 'wait'];
  const line = (key, value, ...rest) => h('div', { class: 'line' }, h('span', { class: 'k' }, key), value, rest);
  return shell([
    h('div', { class: 'mh' }, h('div', null, h('div', { class: 't' }, 'ตั้งค่า'))),
    h('div', { class: 'two' },
      h('div', { class: 'pane' },
        h('div', { class: 'h' }, 'หลังบ้าน'),
        line('ลิงก์', h('input', { class: 'inp', id: 'settings-url', value: jobs.config.url, spellcheck: 'false' }),
          h('button', { class: 'lk', onclick: () => {
            const url = $('settings-url').value.trim();
            if (!/^https:\/\/\S+$/i.test(url)) return toast('ลิงก์ต้องขึ้นต้นด้วย https://', 'bad');
            return act('jobs:set', { url }, 'บันทึกลิงก์แล้ว ปิดแล้วเปิดโปรแกรมใหม่เพื่อใช้ลิงก์ใหม่');
          } }, 'บันทึก')),
        line('สถานะ', h('span', { class: `v plain ${signedOut() ? 'bad' : 'ok'}` }, signedOut() ? (jobs.open ? 'ยังไม่ล็อกอิน' : 'ยังไม่เปิด') : 'ล็อกอินอยู่'),
          h('button', { class: 'lk', onclick: () => act('jobs:open') }, jobs.open ? 'แสดงหน้าต่าง' : 'เปิดหน้าล็อกอิน')),
        h('div', { class: 'h gap' }, 'ชุดงาน'),
        line('ที่ใช้อยู่', h('span', { class: 'v' }, packName()), h('button', { class: 'lk', onclick: () => act('pack:import', {}, 'นำเข้าชุดงานแล้ว') }, 'นำเข้าจากไฟล์')),
        pack.previous && line('รุ่นก่อน', h('span', { class: 'v' }, `${pack.previous.name} ${pack.previous.version}`), h('button', { class: 'lk', onclick: () => act('pack:rollback', {}, 'ย้อนกลับไปชุดงานรุ่นก่อนแล้ว') }, 'ย้อนกลับไปรุ่นนี้')),
        pack.current && pack.current.phone.model && line('ทดสอบกับ', h('span', { class: 'v plain' }, `${pack.current.phone.model}${pack.current.phone.width ? ` · ${pack.current.phone.width}×${pack.current.phone.height}` : ''}`)),
        h('div', { class: 'h gap' }, 'การจ่าย'),
        line('ช่วงยอดหน้าเว็บ', h('span', { class: 'v plain' }, 'ให้หลังบ้านแสดงเฉพาะยอดของเครื่อง'), h('button', { class: `sw ${jobs.config.filter ? 'on' : ''}`, onclick: () => act('jobs:set', { filter: !jobs.config.filter }) }, h('i')))),
      h('div', { class: 'pane' },
        h('div', { class: 'h' }, 'เกี่ยวกับ'),
        h('div', { class: 'big' }, 'OneTwo ', h('span', null, 'ADB')),
        line('เวอร์ชัน', h('span', { class: 'v' }, `${version} · ช่องผู้ใช้งาน`)),
        line('อัปเดต', h('span', { class: `v plain ${updateWord[1]}` }, updateWord[0]),
          update.status === 'updated'
            ? h('button', { class: 'lk', onclick: () => act('update:restart') }, 'ปิดเปิดเพื่อใช้')
            : h('button', { class: 'lk', onclick: async () => { const result = await ask('update:check'); if (result) { S.state.update = result; render(true); } } }, 'ตรวจตอนนี้')),
        line('ผู้พัฒนา', h('span', { class: 'v plain gold' }, user.developer)),
        line('ข้อมูล', h('span', { class: 'v plain' }, 'เก็บในเครื่องนี้เท่านั้น'), h('button', { class: 'lk', onclick: () => ask('folder:open', { which: 'data' }) }, 'เปิดโฟลเดอร์')),
        h('div', { class: 'h gap' }, 'รหัสเปิดใช้'),
        line('ออกให้', h('span', { class: 'v plain' }, license.name || '—')),
        line('ใช้ได้ถึง', h('span', { class: 'v plain' }, license.expires ? `${license.expires} (เหลือ ${Math.max(0, license.daysLeft)} วัน)` : 'ไม่จำกัดวัน')),
        line('รหัสเครื่อง', h('span', { class: 'v' }, license.machine)))),
  ]);
}

// ── a phone's details ────────────────────────────────────────────────────

function openPhone(serial) {
  const view = phoneView(S.state.devices.find((device) => device.serial === serial));
  const { device } = view;
  const close = () => { $('modal').replaceChildren(); render(true); };
  const field = (label, control, wide) => h('div', { class: `fld ${wide ? 'wide' : ''}` }, h('label', null, label), control);
  const save = async () => {
    const value = (id) => $(id).value.trim();
    const calls = [
      ['device:meta', { serial, name: value('phone-name'), group: device.group, slot: device.slot }],
      ['device:account', { serial, bank: BANK, account: value('phone-account'), holder: value('phone-holder'), cap: value('phone-cap'), balance: value('phone-balance'), scale: value('phone-speed') }],
      ['device:range', { serial, min: value('phone-min'), max: value('phone-max') }],
    ];
    if (value('phone-pin')) calls.push(['device:pin', { serial, pin: value('phone-pin') }]);
    for (const [channel, payload] of calls) {
      const data = await ask(channel, payload);
      if (data === null) return;
      absorb(data);
    }
    toast('บันทึกแล้ว', 'good');
    close();
  };
  const speed = SPEEDS.reduce((best, each) => (Math.abs(each[0] - device.pay.scale) < Math.abs(best[0] - device.pay.scale) ? each : best))[0];
  $('modal').replaceChildren(h('div', { class: 'veil', onmousedown: (event) => { if (event.target === event.currentTarget) close(); } },
    h('div', { class: 'sheet' },
      h('div', { class: 'acts' }, h('div', { class: 't' }, device.label), h('span', { class: `st ${view.word[1]}` }, view.word[0]), h('span', { class: 'sp' }),
        h('button', { class: `sw ${device.payOn ? 'on' : ''}`, onclick: async () => {
          const data = await ask('device:pay', { serial, on: !device.payOn });
          if (data === null) return;
          absorb(data);
          toast(device.payOn ? 'ปิดสถานะแล้ว' : 'เปิดสถานะแล้ว', 'good');
          openPhone(serial);
        } }, h('i'), device.payOn ? 'สถานะ: เปิด' : 'สถานะ: ปิด')),
      h('div', { class: 'hint' }, `${device.model || ''} · ${device.serial} · ${device.online ? 'ต่ออยู่' : 'ออฟไลน์'}${view.spent ? ` · จ่ายวันนี้ ${money(view.spent)}` : ''}`),
      h('div', { class: 'grid' },
        field('ชื่อเครื่อง', h('input', { class: 'inp plain', id: 'phone-name', value: device.name, placeholder: device.model || '' })),
        field(device.hasPin ? 'PIN แอปธนาคาร (ตั้งแล้ว ใส่เมื่อจะเปลี่ยน)' : 'PIN แอปธนาคาร', h('input', { class: 'inp', id: 'phone-pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: device.hasPin ? '••••••' : '' })),
        field(`เลขบัญชี ${BANK} ของเครื่อง`, h('input', { class: 'inp', id: 'phone-account', value: device.pay.account, inputmode: 'numeric' })),
        field('ชื่อบัญชี', h('input', { class: 'inp plain', id: 'phone-holder', value: device.pay.holder })),
        field('ยอดต่ำสุดที่เครื่องนี้จ่าย', h('input', { class: 'inp', id: 'phone-min', type: 'number', min: 1, value: device.amountMin ?? '' })),
        field('ยอดสูงสุดที่เครื่องนี้จ่าย', h('input', { class: 'inp', id: 'phone-max', type: 'number', min: 1, value: device.amountMax ?? '' })),
        field('เพดานต่อวัน (เว้นว่าง = ไม่จำกัด)', h('input', { class: 'inp', id: 'phone-cap', type: 'number', min: 0, value: device.pay.cap ?? '' })),
        field('ยอดคงเหลือในบัญชี (ใส่เองเมื่อหลังบ้านไม่แสดง)', h('input', { class: 'inp', id: 'phone-balance', type: 'number', min: 0, value: device.pay.balance ?? '' })),
        field('ความเร็วของเครื่องนี้', h('select', { class: 'inp plain', id: 'phone-speed' }, SPEEDS.map(([scale, name]) => h('option', { value: scale, selected: scale === speed }, name))), true)),
      h('div', { class: 'hint' }, 'เริ่มที่ "ปกติ" ก่อน เร่งทีละขั้นเมื่อจ่ายได้นิ่งแล้ว ถ้าเครื่องแตะพลาดหรือหน้าจอโหลดไม่ทัน ให้ลดความเร็วลง'),
      view.stop && h('div', { class: 'badline' }, `เครื่องนี้หยุดอยู่: ${thai(view.stop.message)}`),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'ปิด'), h('button', { class: 'btn gold', onclick: save }, 'บันทึก')))));
}

// ── drawing ──────────────────────────────────────────────────────────────

/**
 * Draw the window again. News from the program arrives every few seconds; while a field is being
 * typed in, drawing waits, so what was typed is not thrown away. `force` is for the user's own actions.
 */
function render(force = false) {
  if (!S.state) return;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement || {}).tagName) && $('app').contains(document.activeElement);
  if (typing && !force) {
    S.stale = true;
    return;
  }
  S.stale = false;
  const { user } = S.state;
  let page;
  if (!user.license.ok) page = activation();
  else if (!user.setupDone) page = wizard();
  else page = { home, history, settings }[S.page]();
  const scroll = [...document.querySelectorAll('#app .list, #app .main')].map((el) => el.scrollTop);
  $('app').replaceChildren(page);
  [...document.querySelectorAll('#app .list, #app .main')].forEach((el, index) => { el.scrollTop = scroll[index] || 0; });
}

async function checkSignedIn() {
  if (!S.state || !S.state.user.license.ok) return;
  const answer = await window.farm.call('user:signed');
  const now = Boolean(answer.ok && answer.data.signedIn);
  if (now !== S.signedIn) {
    S.signedIn = now;
    render();
  }
}

async function start() {
  const answer = await window.farm.call('state:get');
  if (!answer.ok) {
    $('app').replaceChildren(h('div', { class: 'form' }, h('div', { class: 't' }, 'เปิดโปรแกรมไม่ได้'), h('div', { class: 's' }, answer.error)));
    return;
  }
  S.state = answer.data;
  if (S.state.jobs.config.url) S.wizard = 'login';
  window.farm.on('state', (state) => { S.state = state; render(); });
  window.farm.on('jobs', (jobs) => { S.state.jobs = jobs; render(); });
  window.farm.on('devices', (data) => { absorb(data); render(); });
  window.farm.on('update', (update) => { S.state.update = update; render(); });
  document.addEventListener('focusout', () => setTimeout(() => { if (S.stale) render(); }, 150));
  render(true);
  await checkSignedIn();
  setInterval(checkSignedIn, 4000);
  window.farm.call('devices:scan');
}

start();
