'use strict';

// Owner-only tool, run once. Adds the workflows that read the Bangkok Bank app's screen
// (T.B2-เข้า, T.B2-โอน, T.B2-ต่อ) beside the ones that tap fixed positions, which stay as they are.
//   node tools/add-b2-workflows.js
// The studio keeps its workflows in memory and writes them all back when it saves, so it must be
// closed while this runs. Nothing is chosen for paying here: choose the new workflows in the
// studio (menu "รับงานจากเว็บ" ข้อ 3) when you are ready to try them.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const logic = require('../app/core/logic.js');

const root = path.join(__dirname, '..');
const file = path.join(root, 'farm_manager_devices.json');

const WORKFLOWS = {
  // From any state to the page that lists the banks. Runs when the phone had no job for a
  // while, so the bank app has signed itself out: starting it afresh is the one sure way in.
  'T.B2-เข้า': [
    'close com.bbl.mobilebanking',
    'wake',
    'home',
    '# เปิดแอป แล้วรอหน้าแรก',
    'open com.bbl.mobilebanking',
    'waittext เช็กยอดเงินทันใจ',
    '# ปิดแถบประกาศ ถ้ามี',
    'taptext? ปิด',
    '# กดโอน',
    'taptext โอนเงิน',
    '# หน้าใส่รหัส: ใช้ชุดตำแหน่งเดิม',
    'wait 2000',
    'pin BBL-PIN 1000',
    '# เมนูโอนเงิน',
    'waittext บัญชีผู้อื่น',
    'taptext บัญชีผู้อื่น',
    '# รอหน้าเลือกธนาคาร',
    'waittext โอนเงินไปที่',
  ],
  // From the page that lists the banks to the page that says the transfer is done.
  'T.B2-โอน': [
    '# เลือกธนาคารตามช่อง 3',
    'scrolltap {3}',
    '# ช่องเลขบัญชี ตามช่อง 1',
    'taptext เลขที่บัญชี',
    'text {1}',
    'wait 500',
    'keyevent KEYCODE_TAB',
    'wait 500',
    '# ยอดเงิน ตามช่อง 2',
    'text {2}',
    'keyevent KEYCODE_ENTER',
    'wait 1000',
    '# กดต่อไป',
    'scrolltap ต่อไป',
    '# หน้ายืนยัน: ต้องเจอเลขบัญชีและยอดของรายการ จึงกดยืนยัน',
    'waittext ตรวจสอบการโอนเงิน',
    'checktext {1}',
    'checkamount {2}',
    'taptext ยืนยัน',
    '# รอจนโอนสำเร็จ',
    'waittext รายการสำเร็จ',
    'wait 2000',
  ],
  // From the page that says a transfer is done, back to the page that lists the banks,
  // without leaving the app.
  'T.B2-ต่อ': [
    '# จากหน้าโอนสำเร็จ ไปเมนูโอนเงิน',
    'scrolltap โอนเงินรายการอื่น',
    'waittext บัญชีผู้อื่น',
    'taptext บัญชีผู้อื่น',
    '# รอหน้าเลือกธนาคาร',
    'waittext โอนเงินไปที่',
  ],
};

function studioRuns() {
  try {
    return /OneTwo ADB Studio\.exe/i.test(execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }));
  } catch {
    return false;
  }
}

function main() {
  if (studioRuns()) throw new Error('ปิด OneTwo ADB Studio ก่อน แล้วรันคำสั่งนี้อีกครั้ง (Studio จะเขียนทับสิ่งที่เพิ่มถ้ายังเปิดอยู่)');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!state.pick_sets || !state.pick_sets['BBL-PIN']) throw new Error('ไม่พบชุดตำแหน่ง BBL-PIN ที่เวิร์กโฟลว์ใหม่ใช้กดรหัส');
  const backup = path.join(root, 'backups', `farm_manager_devices.before-b2-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(file, backup);
  for (const [name, lines] of Object.entries(WORKFLOWS)) {
    const text = `${lines.join('\n')}\n`;
    logic.parseWorkflow(text);
    console.log(`${state.workflows[name] ? 'แทนที่' : 'เพิ่ม'} ${name}: ${logic.parseWorkflow(text).length} ขั้น`);
    state.workflows[name] = text;
  }
  const sorted = (value) => (Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(sorted(state), null, 2), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  console.log(`สำรองของเดิมไว้ที่ backups/${path.basename(backup)}`);
  console.log('เวิร์กโฟลว์ที่ใช้จ่ายยังเป็นชุดเดิม เลือกชุดใหม่ใน Studio เมื่อพร้อมลอง');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
