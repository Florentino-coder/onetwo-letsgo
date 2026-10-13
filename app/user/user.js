'use strict';

// The window of OneTwo ADB, the program handed to other people. Three pages: home, history,
// settings. Everything used daily is on the home page. All text is Thai, the faults too.

const S = { state: null, page: 'home', wizard: 'link', signedIn: false, busy: false, stale: false, find: { text: '', state: '', day: '' }, found: null };
const SPEEDS = [[1.5, 'ช้า (เครื่องหรือเน็ตช้า)'], [1, 'ปกติ'], [0.8, 'เร็ว'], [0.6, 'เร็วมาก']];
const BANK = 'ธนาคารกรุงเทพ';
const PHONE_STATE = { running: 'กำลังโอน', checking: 'อ่านสลิป', closing: 'ปิดงาน', resting: 'กำลังพัก' };
const ROW_STATE = { started: ['ค้าง ต้องตรวจ', 'bad'], paid: ['จ่ายแล้ว รอปิดงาน', 'run'], done: ['ปิดงานแล้ว', 'ok'], failed: ['ไม่สำเร็จ', 'bad'], name: ['ชื่อไม่ตรง', 'bad'], resolved: ['จัดการแล้ว', 'wait'] };
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
  [/name on the phone's screen \("([^"]*)"\) is not the name of the job \("([^"]*)"\)/, (m) => `ชื่อผู้รับไม่ตรง: แอปธนาคารแสดง "${m[1]}" รายการคือ "${m[2]}" โปรแกรมจึงไม่กดยืนยัน`],
  [/name on the phone's screen cannot be compared .*\(screen "([^"]*)", job "([^"]*)"\)/, (m) => `เทียบชื่อผู้รับไม่ได้: แอปธนาคารแสดง "${m[1] === 'no name' ? 'ไม่มีชื่อ' : m[1]}" รายการคือ "${m[2]}" โปรแกรมข้ามรายการนี้`],
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
  [/is still being checked/, () => 'เครื่องที่รับยอดนี้กำลังตรวจสอบอยู่ รอสักครู่แล้วลองใหม่'],
  [/are passed over for now/, () => 'ธนาคารนี้ถูกตั้งให้ข้ามอยู่ เอาออกจากรายการข้ามก่อน'],
  [/is not one the phones' app lists/, () => 'ธนาคารนี้ไม่อยู่ในรายการของแอปธนาคาร จึงไม่จ่าย'],
  [/no close-job profile/, () => 'ชุดงานนี้ไม่มีขั้นตอนปิดงานสำหรับหลังบ้านนี้'],
  [/Choose a saved workflow for paying first/, () => 'ยังไม่มีชุดงาน นำเข้าชุดงานที่หน้าตั้งค่า'],
  [/Switch automatic mode off and wait/, () => 'ปิดจ่ายอัตโนมัติและรอให้ทุกเครื่องทำงานเสร็จก่อน'],
  [/No earlier pack is kept/, () => 'ไม่มีชุดงานรุ่นก่อนเก็บไว้ในเครื่องนี้'],
  [/pack is not signed by the owner|not a pack/, () => 'ไฟล์นี้ไม่ใช่ชุดงานจากผู้พัฒนา'],
  [/pack needs program version/, () => 'ชุดงานนี้ต้องใช้โปรแกรมรุ่นใหม่กว่า อัปเดตโปรแกรมก่อน'],
  [/does not show the amount ([\d.,]+)/, (m) => `หน้ายืนยันของแอปธนาคารไม่แสดงยอด ${m[1]} โปรแกรมจึงไม่กดยืนยัน เงินยังไม่ออก`],
  [/screen does not show "([^"]*)"/, (m) => `หน้ายืนยันของแอปธนาคารไม่แสดงเลขบัญชี ${m[1]} โปรแกรมจึงไม่กดยืนยัน เงินยังไม่ออก`],
  [/The phone shows "([^"]*)"/, (m) => `แอปธนาคารขึ้นข้อความ: ${m[1]}`],
  [/"([^"]*)" (?:is not on the screen|did not come on the screen)/, (m) => `ไม่พบ "${m[1]}" บนจอมือถือ`],
  [/The screen could not be read/, () => 'อ่านหน้าจอมือถือไม่ได้ สายหรือการเชื่อมต่ออาจหลุด'],
  [/Paste the activation code/, () => 'วางรหัสเปิดใช้ก่อน'],
  [/not a bot token/, () => 'โทเค็นของบอตไม่ถูกต้อง คัดลอกจาก @BotFather อีกครั้ง'],
  [/chat id is a number/, () => 'Chat ID ต้องเป็นตัวเลข เช่น 123456789'],
  [/Enter the bot token and the chat id first/, () => 'ใส่โทเค็นของบอตและ Chat ID แล้วกดบันทึกก่อน'],
  [/Telegram said: (.*)/, (m) => `Telegram ตอบว่า: ${m[1]} (ตรวจโทเค็น Chat ID และกด Start ที่บอตแล้วหรือยัง)`],
  [/no slip picture kept/, () => 'ไม่มีรูปสลิปเก็บไว้สำหรับรายการนี้'],
  [/slip picture is too large/, () => 'รูปสลิปใหญ่เกินกว่าจะแสดง'],
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

let audio = null;
/** Three short tones: something needs the operator. No sound file is needed. */
function beep() {
  try {
    audio = audio || new AudioContext();
    [0, 0.28, 0.56].forEach((start, index) => {
      const tone = audio.createOscillator();
      const level = audio.createGain();
      tone.type = 'sine';
      tone.frequency.value = index === 2 ? 660 : 880;
      level.gain.setValueAtTime(0.0001, audio.currentTime + start);
      level.gain.exponentialRampToValueAtTime(0.35, audio.currentTime + start + 0.02);
      level.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + start + 0.22);
      tone.connect(level).connect(audio.destination);
      tone.start(audio.currentTime + start);
      tone.stop(audio.currentTime + start + 0.24);
    });
  } catch {
    // No sound device: the notice on the screen still shows.
  }
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

// The banks whose mark is kept as a picture in banks/. Any other bank shows its first letter.
const BANK_MARKS = new Set(['BAAC', 'BAY', 'BBL', 'CIMBT', 'CITI', 'GHB', 'GSB', 'HSBC', 'ISBT', 'ICBC', 'KBANK', 'KKP', 'KTB', 'LHBANK', 'SCB', 'TCRB', 'TISCO', 'TTB', 'UOBT']);

/** A bank's mark, by its code: its picture, or a letter in a circle. */
function bankMark(code, big) {
  if (BANK_MARKS.has(code)) return h('img', { class: `mark ${big ? 'big' : ''}`, src: `banks/${code}.png`, alt: '' });
  return h('span', { class: `mark letter ${big ? 'big' : ''}` }, (code || '?')[0]);
}

/** The code of the bank a phone pays from; a phone set up before there was a choice pays from the first bank. */
const phoneBank = (device) => ((S.state.banks || []).find((bank) => bank.name === device.pay.bank) || { code: (S.state.jobs.payBanks || [])[0] || 'BBL' }).code;

/** A state as a pill: 'ok' ready, 'run' at work, 'warn' passed over, 'bad' to be looked at, 'wait' idle. */
const pill = (text, kind, title) => h('span', { class: `pill ${kind || 'wait'}`, title }, text);
const rangeText = (min, max) => `${whole(min)}–${whole(max)}`;

/** The amounts the queue shows: from the smallest set on any phone to the largest; null when none is set. */
function shownRange() {
  const ranged = S.state.devices.filter((device) => device.amountMin !== null);
  return ranged.length ? [Math.min(...ranged.map((device) => device.amountMin)), Math.max(...ranged.map((device) => device.amountMax))] : null;
}

/**
 * The banks to tick, as the phones' app lists them. `chosen` is the codes ticked now; `changed`
 * is given the new list each time one is ticked or cleared.
 */
function bankChips(chosen, changed) {
  const now = new Set(chosen);
  return h('div', { class: 'chips' }, S.state.banks.map((bank) => {
    const chip = h('button', { class: `chip ${now.has(bank.code) ? 'on' : ''}`, type: 'button', title: bank.name }, bankMark(bank.code), bank.code);
    chip.addEventListener('click', () => {
      if (now.has(bank.code)) now.delete(bank.code);
      else now.add(bank.code);
      chip.classList.toggle('on');
      changed(S.state.banks.map((each) => each.code).filter((code) => now.has(code)));
    });
    return chip;
  }));
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
  else if (unset) word = ['ยังตั้งไม่ครบ', 'warn'];
  else if ((jobs.noFlow || []).includes(device.serial)) word = ['ไม่มีชุดงานของธนาคารนี้', 'bad'];
  else if ((jobs.checking || []).includes(device.serial)) word = ['กำลังตรวจสอบ', 'run'];
  else if (!device.payOn || (listed && listed.on === false)) word = ['ปิดอยู่', 'wait'];
  else if (jobs.accounts.fresh && !listed) word = ['ไม่พบบัญชีในหลังบ้าน', 'bad'];
  else if (balance !== null && balance < device.amountMin) word = ['เงินหมด', 'bad'];
  else if (device.pay.cap !== null && spent >= device.pay.cap) word = ['ถึงเพดาน', 'wait'];
  return { device, balance, spent, stop, word, ready: word[0] === 'พร้อม' || Boolean(working) };
}

/** In link mode a pass held is "signed in"; otherwise the back-office window must be signed in. */
const hasPass = () => Boolean(S.state.jobs.api && S.state.jobs.api.pass);
const apiBaseSet = () => /^https:\/\/\S+$/i.test(String(S.state.jobs.config.apiBase || ''));
const signedOut = () => !hasPass() && (!S.state.jobs.open || !S.signedIn);
const packName = () => {
  const { current } = S.state.user.pack;
  return current ? `${current.name} ${current.version}` : 'ยังไม่มีชุดงาน';
};

/** The program's mark: its icon, its name, and who made it underneath. */
function brandMark() {
  return h('div', { class: 'brand' }, h('img', { src: '../assets/icon.png', alt: '' }),
    h('div', null, h('div', { class: 'name' }, 'OneTwo ', h('span', null, 'ADB')), h('div', { class: 'by' }, `By ${S.state.user.developer}`)));
}

// ── pages ────────────────────────────────────────────────────────────────

/** The two onboarding steps, shown down the side of the setup and gate pages. */
function onboardSteps(now) {
  const order = ['setup', 'pass'];
  const names = { setup: 'ตั้งค่าที่อยู่หลังบ้าน', pass: 'ใส่พาสเข้าใช้งาน' };
  const mark = (key, index) => {
    const done = order.indexOf(key) < order.indexOf(now);
    return h('div', { class: `stepmark ${done ? 'done' : key === now ? 'now' : ''}` }, h('span', { class: 'd' }, done ? '✓' : index + 1), h('span', null, names[key]));
  };
  return h('div', { class: 'steps' },
    brandMark(),
    order.map(mark),
    h('div', { class: 'stepmark' }, h('span', { class: 'd' }, 3), h('span', null, 'เครื่องและบัญชี', h('small', null, 'ตั้งที่หน้าหลัก'))),
    h('div', { class: 'stepmark' }, h('span', { class: 'd' }, 4), h('span', null, 'ลองหนึ่งรายการ', h('small', null, 'กดจ่ายเองที่หน้าหลัก'))),
    h('div', { class: 'foot' }, `เวอร์ชัน ${S.state.version}`));
}

/** First run: the addresses of the back office, saved on this computer. Shown once, until set. */
function setupPage() {
  const { jobs } = S.state;
  const fld = (label, id, value, placeholder, hint) => h('div', { class: 'fld' },
    h('label', null, label), h('input', { class: 'inp', id, value: value || '', placeholder, spellcheck: 'false' }), hint && h('small', { class: 'hint' }, hint));
  return h('div', { class: 'wiz' }, onboardSteps('setup'),
    h('div', { class: 'form' },
      h('div', { class: 't' }, 'ตั้งค่าหลังบ้าน (ครั้งแรกครั้งเดียว)'),
      h('div', { class: 's' }, 'ใส่ที่อยู่ของหลังบ้านจากแท็บ Network ใน F12 โปรแกรมจำไว้ในเครื่องนี้เท่านั้น เปลี่ยนได้ภายหลังที่หน้าตั้งค่า'),
      fld('ที่อยู่บริการ (apiBase)', 'setup-apibase', jobs.config.apiBase, 'https://....api.example.com', 'ช่อง Request URL ตัดเหลือเฉพาะชื่อโฮสต์ก็ได้ วางทั้งลิงก์ก็ได้'),
      fld('ที่อยู่หน้าเว็บ (apiOrigin)', 'setup-apiorigin', jobs.config.apiOrigin, 'https://manage.example.com', 'ช่อง origin หรือ referer'),
      h('div', { class: 'acts' }, h('button', { class: 'btn gold', onclick: async () => {
        const apiBase = $('setup-apibase').value.trim();
        const apiOrigin = $('setup-apiorigin').value.trim();
        if (!/^https:\/\/\S+$/i.test(apiBase)) return toast('ที่อยู่บริการต้องขึ้นต้นด้วย https://', 'bad');
        if (apiOrigin && !/^https:\/\/\S+$/i.test(apiOrigin)) return toast('ที่อยู่หน้าเว็บต้องขึ้นต้นด้วย https://', 'bad');
        if (await act('jobs:set', { apiBase, apiOrigin }, 'บันทึกที่อยู่แล้ว')) { await ask('user:setup', { done: true }); S.editSetup = false; render(true); }
        return null;
      } }, 'บันทึก ไปใส่พาส'))));
}

/** Every launch once the addresses are set: paste the pass. Kept in memory, gone when the app closes. */
function gatePage() {
  const api = S.state.jobs.api || {};
  const status = api.wrong ? ['พาสหรือกุญแจไม่ตรง ลองวางพาสใหม่', 'bad'] : api.pass ? ['กำลังตรวจพาส...', 'run'] : ['', ''];
  return h('div', { class: 'wiz' }, onboardSteps('pass'),
    h('div', { class: 'form' },
      h('div', { class: 't' }, 'ใส่พาสเพื่อเข้าใช้งาน'),
      h('div', { class: 's' }, 'วางพาส (Bearer token) จากหลังบ้าน โปรแกรมเก็บไว้ในหน่วยความจำเท่านั้น หายเมื่อปิดโปรแกรม ต้องวางใหม่ทุกครั้งที่เปิด'),
      h('div', { class: 'fld' }, h('label', null, 'พาส (Bearer token)'),
        h('input', { class: 'inp', id: 'gate-pass', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'วางพาสที่นี่',
          onkeydown: (event) => { if (event.key === 'Enter') $('gate-enter').click(); } })),
      status[0] && h('div', { class: status[1] === 'bad' ? 'badline' : 'okline' }, status[0]),
      h('div', { class: 'acts' },
        h('button', { class: 'lk', onclick: () => { S.editSetup = true; render(true); } }, 'แก้ที่อยู่หลังบ้าน'),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn gold', id: 'gate-enter', onclick: async () => {
          const token = $('gate-pass').value.trim();
          if (!token) return toast('วางพาสก่อน', 'bad');
          await act('jobs:apitoken', { token }, 'รับพาสแล้ว');
          return render(true);
        } }, 'เข้าใช้งาน'))));
}

function shell(content) {
  const { jobs, version, user } = S.state;
  const nav = (page, name) => h('button', { class: `nav ${S.page === page ? 'on' : ''}`, onclick: () => { S.page = page; render(true); } }, name);
  const days = user.license.daysLeft;
  return h('div', { class: 'shell' },
    h('div', { class: 'rail' },
      brandMark(),
      nav('home', 'หน้าหลัก'), nav('history', 'ประวัติ'), nav('settings', 'ตั้งค่า'),
      h('div', { class: 'foot' },
        h('div', null, 'หลังบ้าน: ', signedOut() ? h('span', { class: 'bad' }, jobs.open ? 'ยังไม่ล็อกอิน' : 'ยังไม่เปิด') : h('span', { class: 'good' }, 'ล็อกอินอยู่')),
        days !== null && days <= 7 && h('div', { class: 'bad' }, `รหัสเปิดใช้เหลือ ${Math.max(0, days)} วัน`),
        h('div', null, `เวอร์ชัน ${version}`))),
    h('div', { class: 'main' }, h('div', { class: 'wrap' }, content)));
}

/** What to do about a stop, in the order to do it. `serial` is '' when everything is stopped. */
function stopBlock(stop, serial) {
  const { jobs } = S.state;
  const entry = jobs.history.find((each) => each.key === stop.key);
  const device = S.state.devices.find((each) => each.serial === serial);
  const about = entry ? `รายการ ${money(entry.amount)} ไป${entry.bank || ''} ${entry.account}${entry.holder ? ` (${entry.holder})` : ''}` : 'ไม่มีรายการที่เกี่ยวข้อง';
  const open = entry && entry.state !== 'done' && entry.state !== 'resolved';
  return h('div', { class: 'alert' },
    h('div', { class: 'x' },
      h('b', null, `${device ? `${device.label}: ` : ''}${thai(stop.message)}`),
      h('div', null, `${about} · หยุดเมื่อ ${timeOf(stop.at)}`),
      h('ol', { class: 'todo' }, (/is not the name of the job/.test(stop.message)
        ? ['เงินยังไม่ออก โปรแกรมหยุดที่หน้ายืนยันและไม่ได้กดยืนยัน', 'ตรวจชื่อและเลขบัญชีของรายการนี้ในหลังบ้าน ถ้าถูกต้อง โอนรายการนี้เองด้วยมือ โปรแกรมไม่จ่ายรายการนี้ซ้ำ', 'กด "จัดการแล้ว" จากนั้นจึงกดรีเซ็ต']
        : ['เงินอาจออกแล้ว เปิดแอปธนาคารของเครื่องดูรายการล่าสุดก่อน', 'ถ้าเงินออกแล้ว ปิดงานในหลังบ้านเอง ถ้าเงินยังไม่ออก โอนรายการนี้เองด้วยมือ โปรแกรมไม่จ่ายรายการนี้ซ้ำ', 'กด "จัดการแล้ว" จากนั้นจึงกดรีเซ็ต']).map((step) => h('li', null, step)))),
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
  const online = devices.filter((device) => device.online).length;
  const noPack = !user.pack.current;
  const title = jobs.halt ? ['หยุดทำงาน', 'bad'] : noPack ? ['ยังไม่มีชุดงาน', 'bad'] : out ? ['ยังไม่ได้ล็อกอินหลังบ้าน', ''] : jobs.payAuto ? ['กำลังทำงาน', ''] : ['พร้อม', ''];
  const sub = jobs.halt ? `หยุดเมื่อ ${timeOf(jobs.halt.at)} · ไม่มีรายการใดถูกจ่ายต่อจนกว่าจะรีเซ็ต`
    : `${jobs.orders.at ? `ตรวจรายการล่าสุด ${timeOf(jobs.orders.at)}` : 'ยังไม่ได้ตรวจรายการ'} · ชุดงาน ${packName()}${jobs.payAuto ? '' : ' · จ่ายเองทีละรายการ'}`;

  const shown = shownRange();
  const phoneRow = (view) => {
    const { device } = view;
    const extra = [device.skipBanks.length ? `ข้าม ${device.skipBanks.join(', ')}` : '', device.drops ? `หลุด ${device.drops} ครั้ง` : ''].filter(Boolean).join(' · ');
    return h('button', { class: 'row phone', onclick: () => openPhone(device.serial) },
      // The mark of the bank whose app the phone pays from, once its account is set.
      h('span', { class: 'top' }, device.pay.account ? bankMark(phoneBank(device)) : null, h('span', { class: 'nm' }, device.label), pill(view.word[0], view.word[1])),
      h('span', { class: 'c' }, [tail(device.pay.account), view.balance !== null ? `คงเหลือ ${whole(view.balance)}` : '', device.amountMin !== null ? `ยอด ${rangeText(device.amountMin, device.amountMax)}` : ''].filter(Boolean).join(' · ')),
      extra ? h('span', { class: `c ${device.drops >= 3 ? 'bad' : 'warn'}`, title: 'ธนาคารที่เครื่องนี้ข้าม และจำนวนครั้งที่เครื่องหลุดการเชื่อมต่อใน 1 ชั่วโมงที่ผ่านมา' }, extra) : null);
  };

  // Why no phone takes a row: a few words for the pill, the whole of it for the pointer.
  const WHY = {
    cap: ['ถึงเพดาน', 'wait', 'เครื่องที่รับยอดนี้ถึงเพดานต่อวันแล้ว'], balance: ['เงินไม่พอ', 'wait', 'เงินในเครื่องที่รับยอดนี้ไม่พอ'],
    off: ['บัญชีปิดอยู่', 'wait', 'บัญชีของเครื่องที่รับยอดนี้ปิดอยู่'], stopped: ['เครื่องหยุด', 'bad', 'เครื่องที่รับยอดนี้หยุดอยู่ รอตรวจและรีเซ็ต'],
    noflow: ['ไม่มีชุดงาน', 'bad', 'ชุดงานไม่มีเวิร์กโฟลว์ของแอปธนาคารที่เครื่องนี้ใช้'],
    checking: ['กำลังตรวจสอบ', 'run', 'เครื่องที่รับยอดนี้เพิ่งเสียบสาย กำลังตรวจสอบ'], missing: ['ไม่พบบัญชี', 'bad', 'ไม่พบบัญชีของเครื่องในหลังบ้าน'],
    skipbank: ['ข้ามธนาคาร', 'warn', 'ธนาคารนี้ถูกตั้งให้ข้ามอยู่'], nobank: ['ไม่รองรับ', 'warn', 'ธนาคารนี้ไม่อยู่ในรายการของแอปธนาคาร'],
  };
  const orderRow = (order) => {
    const onPhone = Object.entries(jobs.paying).find(([, each]) => each.key === order.key);
    const worker = onPhone && devices.find((device) => device.serial === onPhone[0]);
    const cell = (top, under) => h('span', { class: 'do' }, top, under ? h('small', null, under) : null);
    let status;
    if (onPhone) status = cell(pill(PHONE_STATE[onPhone[1].state] || 'กำลังทำงาน', 'run'), worker ? worker.label : '');
    else if (order.state) status = cell(pill(ROW_STATE[order.state] ? ROW_STATE[order.state][0] : order.state, ROW_STATE[order.state] ? ROW_STATE[order.state][1] : 'wait'));
    else if (!order.serial) {
      const off = devices.some((device) => device.online && !device.payOn && device.amountMin !== null && Number(order.amount) >= device.amountMin && Number(order.amount) <= device.amountMax);
      const why = WHY[order.short] || (off ? WHY.off : ['ไม่มีเครื่องรับ', 'wait', 'ไม่มีเครื่องออนไลน์ที่ช่วงยอดครอบคลุมรายการนี้']);
      status = cell(pill(why[0], why[1], why[2]));
    } else if (jobs.payAuto) status = cell(pill('รอ', 'wait'), order.phone);
    else status = cell(h('button', { class: 'btn small gold', disabled: Boolean(jobs.halt) || out, onclick: () => act('jobs:pay', { key: order.key }) }, 'จ่าย'), order.phone);
    return h('div', { class: 'row order' }, h('span', { class: 'a' }, money(order.amount)), bankMark(order.bankCode),
      h('span', { class: 'who', title: `${order.holder || ''} · ${order.bank}` }, h('span', null, order.holder || '—'), h('small', null, `${order.bankCode || order.bank} · `, h('span', { class: 'acct' }, order.account))),
      status);
  };

  const ownSkips = devices.filter((device) => device.skipBanks.length);
  const tags = h('div', { class: 'tags' },
    jobs.skipBanks.length ? h('span', { class: 'pill warn', title: 'รายการไปธนาคารนี้ไม่ถูกจ่าย เอาออกได้ที่หน้าตั้งค่า' }, 'ข้ามธนาคารทุกเครื่อง:', jobs.skipBanks.map((code) => bankMark(code)), jobs.skipBanks.join(', ')) : null,
    ownSkips.map((device) => pill(`${device.label} ข้าม ${device.skipBanks.join(', ')}`, 'warn', 'ตั้งในหน้าต่างของเครื่อง')),
    pill(`เช็กชื่อผู้รับ: ${jobs.config.checkName === false ? 'ปิด' : 'เปิด'}`, jobs.config.checkName === false ? 'wait' : 'run', 'เปิดหรือปิดได้ที่หน้าตั้งค่า'),
    shown ? pill(`คิวแสดงยอด ${rangeText(shown[0], shown[1])}`, 'wait', 'จากยอดต่ำสุดถึงยอดสูงสุดที่ตั้งไว้ของทุกเครื่อง') : null);
  const emptyQueue = out ? 'ใส่พาสเพื่อดูรายการ' : jobs.orders.error ? 'อ่านรายการจากหลังบ้านไม่ได้ โปรแกรมลองใหม่เอง' : shown ? `ไม่มีรายการในช่วงยอด ${rangeText(shown[0], shown[1])}` : 'ไม่มีรายการรอจ่าย';

  return shell([
    h('div', { class: 'mh' },
      h('div', null, h('div', { class: `t ${title[1]}` }, title[0]), h('div', { class: 's' }, sub)),
      h('span', { class: 'sp' }),
      h('span', { class: `count ${online ? 'ok' : 'bad'}` }, h('i'), `ออนไลน์ ${online} จาก ${devices.length} เครื่อง`),
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
    tags,
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
        orders.length ? h('div', { class: 'row order head' }, h('span', { class: 'a' }, 'ยอด (บาท)'), h('span'), h('span', null, 'ชื่อบัญชี · ธนาคาร · เลขบัญชี'), h('span', { class: 'st' }, 'สถานะ')) : null,
        h('div', { class: 'list' }, orders.length ? orders.map(orderRow) : h('div', { class: 'empty' }, emptyQueue)))),
  ]);
}

/** One row of the history, as the history page and a search both show it. */
function historyRow(entry) {
  const { devices } = S.state;
  const label = (serial) => (devices.find((device) => device.serial === serial) || { label: serial || '—' }).label;
  const state = ROW_STATE[entry.state] || [entry.state, 'wait'];
  const open = entry.state === 'started' || entry.state === 'paid' || entry.state === 'name';
  // What the bank app showed where the names could not be compared.
  const shown = entry.state === 'name' ? (/screen "([^"]*)"/.exec(entry.detail || '') || [])[1] : '';
  return h('div', { class: 'row past' },
    h('span', { class: 'c' }, `${dayOf(entry.at)} ${timeOf(entry.at).slice(0, 5)}`),
    h('span', { class: 'a' }, money(entry.amount)),
    bankMark(entry.bankCode),
    h('span', { class: 'who', title: `${entry.holder || ''} · ${entry.bank}` }, h('span', null, entry.holder || '—'),
      h('small', null, `${entry.bankCode || entry.bank} · `, h('span', { class: 'acct' }, entry.account), ` · ${entry.phone || label(entry.serial)}`,
        shown ? ` · แอปแสดง "${shown === 'no name' ? 'ไม่มีชื่อ' : shown}"` : '',
        entry.slip ? [' · ', h('button', { class: 'lk', onclick: () => openSlip(entry) }, 'ดูสลิป')] : null)),
    h('span', { class: 'do' }, pill(state[0], state[1]),
      open ? h('button', { class: 'lk', onclick: () => act('jobs:resolve', { key: entry.key, note: 'ตรวจด้วยมือ' }, 'บันทึกว่าจัดการแล้ว') }, 'จัดการแล้ว') : null));
}

const searching = () => Boolean(S.find.text || S.find.state || S.find.day);

/** Fill the list of the history page from what it should show now, without drawing the page again. */
function drawHistoryList() {
  const list = $('history-list');
  if (!list) return;
  const rows = searching() && S.found ? S.found : S.state.jobs.history;
  list.replaceChildren(...(rows.length ? rows.map(historyRow) : [h('div', { class: 'empty' }, searching() ? 'ไม่พบรายการที่ตรงกับที่ค้นหา' : 'ยังไม่มีรายการ')]));
  $('history-count').textContent = searching() ? `พบ ${rows.length} รายการ${rows.length === 500 ? ' (แสดง 500 รายการแรก)' : ''}` : `${rows.length} รายการล่าสุด`;
}

let findTimer = null;
function runFind() {
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    S.find = { text: $('find-text').value.trim(), state: $('find-state').value, day: $('find-day').value };
    S.found = searching() ? await ask('history:search', S.find) : null;
    drawHistoryList();
  }, 250);
}

function history() {
  const states = [['', 'ทุกสถานะ'], ['done', 'ปิดงานแล้ว'], ['paid', 'จ่ายแล้ว รอปิดงาน'], ['started', 'ค้าง ต้องตรวจ'], ['failed', 'ไม่สำเร็จ'], ['name', 'ชื่อไม่ตรง'], ['resolved', 'จัดการแล้ว']];
  const today = S.state.jobs.history.filter((entry) => isToday(entry.at));
  // Today's rows of one state, counted and added up. Pressing it shows those rows.
  const tile = (name, state, bad) => {
    const rows = today.filter((entry) => entry.state === state);
    return h('button', { class: 'kpi', title: 'กดเพื่อดูเฉพาะรายการนี้', onclick: () => { $('find-state').value = state; runFind(); } },
      h('div', { class: 'l' }, `${name} วันนี้`),
      h('div', { class: `v ${bad && rows.length ? 'bad' : ''}` }, `${rows.length} · ${whole(rows.reduce((sum, entry) => sum + Number(entry.amount), 0))}`));
  };
  const page = shell([
    h('div', { class: 'mh' }, h('div', null, h('div', { class: 't' }, 'ประวัติ'), h('div', { class: 's' }, 'ทุกรายการที่โปรแกรมเริ่มจ่าย ใหม่สุดอยู่บน เก็บในเครื่องนี้เท่านั้น'))),
    h('div', { class: 'kpis' }, tile('ปิดงานแล้ว', 'done'), tile('ค้าง ต้องตรวจ', 'started', true), tile('ชื่อไม่ตรง', 'name', true), tile('จัดการแล้ว', 'resolved')),
    h('div', { class: 'finder' },
      h('input', { class: 'inp plain', id: 'find-text', value: S.find.text, placeholder: 'ค้นหา เลขบัญชี ชื่อบัญชี ธนาคาร หรือยอด', spellcheck: 'false', oninput: runFind }),
      h('select', { class: 'inp plain', id: 'find-state', onchange: runFind }, states.map(([value, name]) => h('option', { value, selected: value === S.find.state }, name))),
      h('input', { class: 'inp plain', id: 'find-day', type: 'date', value: S.find.day, onchange: runFind }),
      h('button', { class: 'lk', onclick: () => { S.find = { text: '', state: '', day: '' }; S.found = null; render(true); } }, 'ล้าง'),
      h('span', { class: 'sp' }),
      h('span', { class: 'hint', id: 'history-count' })),
    h('div', { class: 'pane grow' },
      h('div', { class: 'row past head' }, h('span', null, 'เวลา'), h('span', { class: 'a' }, 'ยอด (บาท)'), h('span'), h('span', null, 'ชื่อบัญชี · ธนาคาร · เลขบัญชี · เครื่องที่จ่าย'), h('span', { class: 'st' }, 'สถานะ')),
      h('div', { class: 'list', id: 'history-list' })),
  ]);
  // The list is filled once the page is in the window: it is found by its id.
  queueMicrotask(drawHistoryList);
  return page;
}

async function openSlip(entry) {
  const data = await ask('slip:view', { key: entry.key });
  if (!data) return;
  const close = () => $('modal').replaceChildren();
  $('modal').replaceChildren(h('div', { class: 'veil', onmousedown: (event) => { if (event.target === event.currentTarget) close(); } },
    h('div', { class: 'sheet slip' },
      h('div', { class: 'acts' }, h('div', { class: 't' }, `สลิป ${money(entry.amount)}`), h('span', { class: 'sp' }), h('button', { class: 'btn', onclick: close }, 'ปิด')),
      h('div', { class: 'hint' }, `${entry.holder || ''} · ${entry.bank} ${entry.account} · ${dayOf(entry.at)} ${timeOf(entry.at)}`),
      h('img', { src: data.image, alt: 'สลิป' }))));
}

function settings() {
  const { jobs, user, version, update } = S.state;
  const { license, pack } = user;
  const updateWord = { current: ['เป็นเวอร์ชันล่าสุด', 'ok'], updated: [`รุ่น ${update.version} พร้อมแล้ว`, 'run'], error: ['ตรวจไม่ได้ ลองใหม่ภายหลัง', 'bad'], disabled: ['ยังไม่ได้ตั้งช่องอัปเดต', 'wait'] }[update.status] || ['ยังไม่ได้ตรวจ', 'wait'];
  const line = (key, value, ...rest) => h('div', { class: 'line' }, h('span', { class: 'k' }, key), value, rest);
  // A switch with what it does when on, in one line under its name.
  const option = (name, about, on, press, disabled) => h('div', { class: 'opt' }, h('span', { class: 'x' }, h('span', null, name), h('small', null, about)),
    h('button', { class: `sw ${on ? 'on' : ''}`, disabled, 'aria-label': name, onclick: press }, h('i')));
  return shell([
    h('div', { class: 'mh' }, h('div', null, h('div', { class: 't' }, 'ตั้งค่า'))),
    h('div', { class: 'two' },
      h('div', { class: 'pane' },
        h('div', { class: 'h' }, 'หลังบ้าน'),
        line('ที่อยู่บริการ', h('span', { class: 'v plain mono' }, jobs.config.apiBase || '—'),
          h('button', { class: 'lk', onclick: () => { S.editSetup = true; render(true); } }, 'แก้ที่อยู่')),
        line('พาส', h('span', { class: `v plain ${hasPass() ? 'ok' : 'bad'}` }, hasPass() ? (jobs.api.wrong ? 'กุญแจไม่ตรง' : jobs.api.proven ? 'อ่านรายการได้' : 'มีพาสแล้ว') : 'ยังไม่มีพาส'),
          hasPass() && h('button', { class: 'lk', onclick: () => act('jobs:apitoken', { token: '' }, 'ล้างพาสแล้ว') }, 'ล้างพาส')),
        h('div', { class: 'h gap' }, 'ชุดงาน'),
        line('ที่ใช้อยู่', h('span', { class: 'v' }, packName()), h('button', { class: 'lk', onclick: () => act('pack:import', {}, 'นำเข้าชุดงานแล้ว') }, 'นำเข้าจากไฟล์')),
        pack.previous && line('รุ่นก่อน', h('span', { class: 'v' }, `${pack.previous.name} ${pack.previous.version}`), h('button', { class: 'lk', onclick: () => act('pack:rollback', {}, 'ย้อนกลับไปชุดงานรุ่นก่อนแล้ว') }, 'ย้อนกลับไปรุ่นนี้')),
        pack.current && pack.current.phone.model && line('ทดสอบกับ', h('span', { class: 'v plain' }, `${pack.current.phone.model}${pack.current.phone.width ? ` · ${pack.current.phone.width}×${pack.current.phone.height}` : ''}`)),
        h('div', { class: 'h gap' }, 'การจ่าย'),
        option('เช็กชื่อผู้รับ', 'ชื่อบนหน้ายืนยันต้องตรงกับรายการ จึงกดยืนยัน', jobs.config.checkName !== false, () => act('jobs:set', { checkName: jobs.config.checkName === false })),
        option('ต้องมีนามสกุล', 'แอปแสดงนามสกุล แต่รายการไม่มี ให้ข้ามรายการ', Boolean(jobs.config.checkFamily), () => act('jobs:set', { checkFamily: !jobs.config.checkFamily }), jobs.config.checkName === false),
        option('ช่วงยอดหน้าเว็บ', 'ให้หลังบ้านส่งเฉพาะยอดในช่วงของเครื่อง', Boolean(jobs.config.filter), () => act('jobs:set', { filter: !jobs.config.filter })),
        h('div', { class: 'h gap' }, 'ธนาคารที่ข้าม ทุกเครื่อง'),
        bankChips(jobs.skipBanks, (codes) => act('banks:skip', { codes })),
        h('div', { class: 'hint pad' }, jobs.skipBanks.length
          ? `ข้ามอยู่ ${jobs.skipBanks.length} ธนาคาร รายการไปธนาคารนี้รออยู่ในคิว เครื่องจ่ายรายการอื่นต่อ กดอีกครั้งเพื่อเอาออก`
          : 'กดเลือกธนาคารที่โอนไม่ได้ชั่วคราว รายการไปธนาคารนั้นจะรออยู่ในคิว เครื่องจ่ายรายการอื่นต่อ ตั้งแยกรายเครื่องได้ในหน้าต่างของเครื่อง')),
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
    h('div', { class: 'two' },
      h('div', { class: 'pane' },
        h('div', { class: 'h' }, 'การแจ้งเตือน'),
        line('เสียงเตือน', h('span', { class: 'v plain' }, 'เมื่อเครื่องหยุด เงินหมด หรือเครื่องหลุด'), h('button', { class: `sw ${user.sound ? 'on' : ''}`, onclick: () => act('user:prefs', { sound: !user.sound }) }, h('i'))),
        line('Telegram', h('span', { class: `v plain ${user.telegram.on ? 'ok' : 'wait'}` }, user.telegram.on ? 'เปิดอยู่' : user.telegram.hasToken ? 'ปิดอยู่' : 'ยังไม่ได้ตั้ง'),
          h('button', { class: `sw ${user.telegram.on ? 'on' : ''}`, onclick: () => act('telegram:set', { on: !user.telegram.on }) }, h('i'))),
        line('โทเค็นของบอต', h('input', { class: 'inp', id: 'tg-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: user.telegram.hasToken ? 'ตั้งแล้ว ใส่เมื่อจะเปลี่ยน' : '123456789:AA...' })),
        line('Chat ID', h('input', { class: 'inp', id: 'tg-chat', value: user.telegram.chat, spellcheck: 'false', placeholder: '123456789' }),
          h('button', { class: 'lk', onclick: () => act('telegram:set', { token: $('tg-token').value.trim(), chat: $('tg-chat').value.trim() }, 'บันทึกแล้ว') }, 'บันทึก'),
          h('button', { class: 'lk', onclick: async () => { if (await ask('telegram:test')) toast('ส่งข้อความทดสอบแล้ว ดูใน Telegram', 'good'); } }, 'ส่งทดสอบ')),
        h('div', { class: 'hint pad' }, 'วิธีตั้ง: ใน Telegram คุยกับ @BotFather พิมพ์ /newbot แล้วคัดลอกโทเค็นมาวาง จากนั้นเปิดบอตของคุณแล้วกด Start และถาม @userinfobot เพื่อดู Chat ID ของคุณ')),
      h('div', { class: 'pane' },
        h('div', { class: 'h' }, 'ช่วยเหลือ'),
        line('รายงานปัญหา', h('span', { class: 'v plain' }, 'รวมบันทึกและประวัติเป็นไฟล์เดียว'), h('button', { class: 'lk', onclick: async () => { const made = await ask('report:save'); if (made && made.saved) toast('บันทึกไฟล์รายงานแล้ว ส่งไฟล์นี้ให้ผู้พัฒนา', 'good'); } }, 'สร้างไฟล์')),
        h('div', { class: 'hint pad' }, 'ในไฟล์มีบันทึกการทำงาน ประวัติรายการ และรายชื่อเครื่อง ไม่มี PIN ไม่มีรหัสเปิดใช้ ไม่มีโทเค็น Telegram ส่งให้ผู้พัฒนาเมื่อโปรแกรมทำงานผิดปกติ'))),
  ]);
}

const EYE_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.5 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.5 4.5-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

/**
 * The eye beside a secret field: shows what is typed, and hides it again. With `serial`, an
 * empty field is first filled with the PIN kept for that phone, so it can be checked.
 */
function eyeButton(fieldId, serial) {
  const button = h('button', { class: 'eye', type: 'button', title: 'แสดงหรือซ่อน PIN', 'aria-label': 'แสดงหรือซ่อน PIN' });
  button.innerHTML = EYE_OPEN;
  button.addEventListener('click', async () => {
    const box = $(fieldId);
    if (box.type === 'password') {
      if (!box.value && serial) {
        const kept = await ask('device:pin-show', { serial });
        if (kept === null) return;
        box.value = kept;
      }
      box.type = 'text';
      button.innerHTML = EYE_SHUT;
    } else {
      box.type = 'password';
      button.innerHTML = EYE_OPEN;
    }
  });
  return button;
}

// ── a phone's details ────────────────────────────────────────────────────

function openPhone(serial) {
  const view = phoneView(S.state.devices.find((device) => device.serial === serial));
  const { device } = view;
  const close = () => { $('modal').replaceChildren(); render(true); };
  const field = (label, control, wide) => h('div', { class: `fld ${wide ? 'wide' : ''}` }, h('label', null, label), control);
  const payBanks = (S.state.jobs.payBanks || []).map((code) => (S.state.banks || []).find((bank) => bank.code === code)).filter(Boolean);
  // A phone set up before there was a choice pays from the first bank.
  const ownBank = (payBanks.find((bank) => bank.name === device.pay.bank) || payBanks[0] || { name: BANK }).name;
  const save = async () => {
    const value = (id) => $(id).value.trim();
    const calls = [
      ['device:meta', { serial, name: value('phone-name'), group: device.group, slot: device.slot }],
      ['device:account', { serial, bank: $('phone-bank') ? $('phone-bank').value : device.pay.bank || BANK, account: value('phone-account'), holder: value('phone-holder'), cap: value('phone-cap'), balance: value('phone-balance'), scale: value('phone-speed') }],
      ['device:range', { serial, min: value('phone-min'), max: value('phone-max') }],
    ];
    calls.push(['device:skip', { serial, codes: skip }]);
    if (value('phone-pin')) calls.push(['device:pin', { serial, pin: value('phone-pin') }]);
    for (const [channel, payload] of calls) {
      const data = await ask(channel, payload);
      if (data === null) return;
      absorb(data);
    }
    toast('บันทึกแล้ว', 'good');
    close();
  };
  let skip = device.skipBanks;
  const speed = SPEEDS.reduce((best, each) => (Math.abs(each[0] - device.pay.scale) < Math.abs(best[0] - device.pay.scale) ? each : best))[0];
  const { jobs } = S.state;
  const listed = jobs.accounts.fresh && device.pay.account ? jobs.accounts.map[device.pay.account] || null : null;
  $('modal').replaceChildren(h('div', { class: 'veil', onmousedown: (event) => { if (event.target === event.currentTarget) close(); } },
    h('div', { class: 'sheet fixed' },
      h('div', { class: 'sheet-head' }, bankMark('BBL', true),
        h('div', { class: 'x' }, h('div', { class: 't' }, device.label),
          h('div', { class: 'hint' }, [device.model, device.serial, device.online ? 'ต่ออยู่' : 'ออฟไลน์', view.spent ? `จ่ายวันนี้ ${money(view.spent)}` : ''].filter(Boolean).join(' · '))),
        pill(view.word[0], view.word[1]),
        h('button', { class: `sw ${device.payOn ? 'on' : ''}`, disabled: view.word[0] === 'กำลังตรวจสอบ', title: 'สถานะนี้คือสถานะของบัญชีในหน้ารายการปรับยอดถอน กดแล้วโปรแกรมเปิดหรือปิดบัญชีที่หลังบ้านให้', onclick: async () => {
          const data = await ask('device:pay', { serial, on: !device.payOn });
          if (data === null) return;
          absorb(data);
          toast(device.payOn ? 'ปิดสถานะแล้ว' : 'เปิดสถานะแล้ว', 'good');
          openPhone(serial);
        } }, h('i'), device.payOn ? 'สถานะ: เปิด' : 'สถานะ: ปิด')),
      h('div', { class: 'sheet-body' },
        h('div', { class: 'h' }, 'บัญชี'),
        h('div', { class: 'grid' },
          field('ชื่อเครื่อง', h('input', { class: 'inp plain', id: 'phone-name', value: device.name, placeholder: device.model || '' })),
          field(device.hasPin ? 'PIN แอปธนาคาร (ตั้งแล้ว ใส่เมื่อจะเปลี่ยน)' : 'PIN แอปธนาคาร', h('div', { class: 'peek' },
            h('input', { class: 'inp', id: 'phone-pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: device.hasPin ? '••••••' : '' }),
            eyeButton('phone-pin', device.hasPin ? serial : ''))),
          // The bank is chosen only when the work pack drives more than one bank's app.
          payBanks.length > 1 ? field('แอปธนาคารของเครื่อง', h('select', { class: 'inp plain', id: 'phone-bank' }, payBanks.map((bank) => h('option', { value: bank.name, selected: bank.name === ownBank }, bank.name)))) : null,
          field(payBanks.length > 1 ? 'เลขบัญชีของเครื่อง' : `เลขบัญชี ${BANK} ของเครื่อง`, h('input', { class: 'inp', id: 'phone-account', value: device.pay.account, inputmode: 'numeric' })),
          field('ชื่อบัญชี', h('input', { class: 'inp plain', id: 'phone-holder', value: device.pay.holder }))),
        h('div', { class: 'hint' }, listed && listed.balance !== null ? `หลังบ้าน: คงเหลือ ${money(listed.balance)} · อ่านเมื่อ ${timeOf(jobs.accounts.at)}` : 'หลังบ้านยังไม่แสดงยอดของบัญชีนี้ โปรแกรมใช้ยอดที่ใส่เองด้านล่าง'),
        h('div', { class: 'h gap' }, 'ช่วงยอดและเพดาน'),
        h('div', { class: 'grid four' },
          field('ยอดต่ำสุด', h('input', { class: 'inp', id: 'phone-min', type: 'number', min: 1, value: device.amountMin ?? '' })),
          field('ยอดสูงสุด', h('input', { class: 'inp', id: 'phone-max', type: 'number', min: 1, value: device.amountMax ?? '' })),
          field('เพดานต่อวัน', h('input', { class: 'inp', id: 'phone-cap', type: 'number', min: 0, placeholder: 'ไม่จำกัด', value: device.pay.cap ?? '' })),
          field('ยอดคงเหลือ (ใส่เอง)', h('input', { class: 'inp', id: 'phone-balance', type: 'number', min: 0, placeholder: 'ใช้ของหลังบ้าน', value: device.pay.balance ?? '' }))),
        field('ความเร็วของเครื่องนี้', h('select', { class: 'inp plain', id: 'phone-speed' }, SPEEDS.map(([scale, name]) => h('option', { value: scale, selected: scale === speed }, name)))),
        h('div', { class: 'hint' }, 'เริ่มที่ "ปกติ" ก่อน เร่งทีละขั้นเมื่อจ่ายได้นิ่งแล้ว ถ้าเครื่องแตะพลาดหรือหน้าจอโหลดไม่ทัน ให้ลดความเร็วลง'),
        h('div', { class: 'h gap' }, 'ธนาคารที่เครื่องนี้ข้าม'),
        bankChips(skip, (codes) => { skip = codes; }),
        h('div', { class: 'hint' }, 'กดเลือก แล้วกดบันทึก รายการไปธนาคารที่เลือกจะไปเครื่องอื่นที่รับยอดนั้น หรือรออยู่ในคิว'),
        view.stop && h('div', { class: 'badline' }, `เครื่องนี้หยุดอยู่: ${thai(view.stop.message)}`)),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn', onclick: close }, 'ปิด'), h('button', { class: 'btn gold', onclick: save }, 'บันทึก')))));
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
  let page;
  if (!apiBaseSet() || S.editSetup) page = setupPage();
  else if (!hasPass()) page = gatePage();
  else page = { home, history, settings }[S.page]();
  const scroll = [...document.querySelectorAll('#app .list, #app .main')].map((el) => el.scrollTop);
  $('app').replaceChildren(page);
  [...document.querySelectorAll('#app .list, #app .main')].forEach((el, index) => { el.scrollTop = scroll[index] || 0; });
}

async function checkSignedIn() {
  if (!S.state) return;
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
  window.farm.on('state', (state) => { S.state = state; render(); });
  window.farm.on('jobs', (jobs) => { S.state.jobs = jobs; render(); });
  window.farm.on('devices', (data) => { absorb(data); render(); });
  window.farm.on('update', (update) => { S.state.update = update; render(); });
  window.farm.on('alert', (alert) => { toast(alert.text, 'bad'); if (S.state.user.sound) beep(); });
  document.addEventListener('focusout', () => setTimeout(() => { if (S.stale) render(); }, 150));
  render(true);
  await checkSignedIn();
  setInterval(checkSignedIn, 4000);
  window.farm.call('devices:scan');
}

start();
