'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../app/core/logic');

test('parseDevices skips the header and daemon chatter', () => {
  const output = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    'R8YY506FYFN            device product:a15x model:SM_A155F device:a15 transport_id:1',
    'R94Y60AQQYW            offline transport_id:2',
    'R58M123ABCD            unauthorized usb:1-4 transport_id:3',
    '',
  ].join('\r\n');
  assert.deepEqual(logic.parseDevices(output), [
    { serial: 'R8YY506FYFN', status: 'device', product: 'a15x', model: 'SM A155F' },
    { serial: 'R94Y60AQQYW', status: 'offline', product: '', model: '' },
    { serial: 'R58M123ABCD', status: 'unauthorized', product: '', model: '' },
  ]);
});

test('parseBattery reads level, temperature and charging state', () => {
  const output = 'Current Battery Service state:\n  status: 2\n  level: 87\n  temperature: 314\n';
  assert.deepEqual(logic.parseBattery(output), { level: '87%', temperature: '31.4C', charging: 'yes' });
  assert.equal(logic.parseBattery('  status: 3\n  level: 5').charging, 'no');
});

test('extractCurrentPackage finds the focused app', () => {
  const output = '  mCurrentFocus=Window{a1b2 u0 com.android.settings/com.android.settings.Settings}';
  assert.equal(logic.extractCurrentPackage(output), 'com.android.settings');
  assert.equal(logic.extractCurrentPackage('nothing here'), '');
});

test('parsePackages strips prefixes and sorts', () => {
  assert.deepEqual(
    logic.parsePackages('package:com.b.app\npackage:/data/app/x.apk=com.a.app\n\npackage:com.b.app\n'),
    ['com.a.app', 'com.b.app'],
  );
});

test('parsePackageInfo reads version fields', () => {
  const info = logic.parsePackageInfo('    versionCode=42 minSdk=24 targetSdk=34\n    versionName=1.2.3\n    installerPackageName=com.android.vending');
  assert.equal(info.version_code, '42');
  assert.equal(info.target_sdk, '34');
  assert.equal(info.version_name, '1.2.3');
  assert.equal(info.installer, 'com.android.vending');
});

test('quoteInputText keeps shell metacharacters literal', () => {
  assert.equal(logic.quoteInputText('hello world'), `'hello%sworld'`);
  assert.equal(logic.quoteInputText('a; reboot'), `'a;%sreboot'`);
  assert.equal(logic.quoteInputText(`it's $(id)`), `'it'\\''s%s$(id)'`);
});

test('validators reject injection attempts', () => {
  assert.ok(logic.isPackage('com.android.settings'));
  assert.ok(!logic.isPackage('com.a; rm -rf /'));
  assert.ok(!logic.isPackage('settings'));
  assert.ok(logic.isKeyevent('KEYCODE_ENTER'));
  assert.ok(logic.isKeyevent('66'));
  assert.ok(!logic.isKeyevent('KEYCODE_ENTER; reboot'));
  assert.ok(logic.isSerial('192.168.1.20:5555'));
  assert.ok(!logic.isSerial('abc def'));
});

test('parseWorkflow accepts valid steps and reports the failing line', () => {
  const steps = logic.parseWorkflow('# comment\nwake\nwait 500\nopen com.android.settings\ntext hello there\nkeyevent KEYCODE_ENTER\nscreenshot\n');
  assert.deepEqual(steps.map((step) => step.command), ['wake', 'wait', 'open', 'text', 'keyevent', 'screenshot']);
  assert.equal(steps[3].argument, 'hello there');
  assert.equal(steps[0].note, 'comment');
  assert.equal(steps[1].note, '');
  assert.deepEqual(logic.parseWorkflow('# open the chat\n\ntap 50% 30%\nhome').map((step) => step.note), ['open the chat', '']);
  assert.throws(() => logic.parseWorkflow('wake\nfly away'), /Line 2: unknown command 'fly'/);
  assert.throws(() => logic.parseWorkflow('wait soon'), /Line 1: wait expects milliseconds/);
  assert.throws(() => logic.parseWorkflow('open notapackage'), /Line 1: open expects a package name/);
  assert.throws(() => logic.parseWorkflow('home now'), /does not take an argument/);
  assert.throws(() => logic.parseWorkflow('\n# only comments\n'), /Workflow is empty/);
});

test('tap and swipe take screen percentages', () => {
  const steps = logic.parseWorkflow('tap 50% 30.5%\nswipe 50% 80% 50% 20%\nswipe 10% 50% 90% 50% 1200\n');
  assert.deepEqual(steps.map((step) => step.command), ['tap', 'swipe', 'swipe']);
  assert.deepEqual(logic.parseGesture('tap', '50% 30.5%'), { points: [50, 30.5], pixel: false });
  assert.deepEqual(logic.parseGesture('swipe', '50% 80% 50% 20%'), { points: [50, 80, 50, 20], pixel: false, duration: 300 });
  assert.equal(logic.parseGesture('swipe', '10% 50% 90% 50% 1200').duration, 1200);
  assert.deepEqual(logic.parseGesture('tap', '540 960'), { points: [540, 960], pixel: true });
  assert.deepEqual(logic.parseGesture('swipe', '540 1800 540 600 400'), { points: [540, 1800, 540, 600], pixel: true, duration: 400 });
  assert.doesNotThrow(() => logic.parseWorkflow('tap 540 960\nswipe 540 1800 540 600'));
  assert.throws(() => logic.parseWorkflow('tap 540 30%'), /Line 1: tap expects a position/);
  assert.throws(() => logic.parseWorkflow('tap 54.5 960'), /Line 1: tap expects a position/);
  assert.throws(() => logic.parseWorkflow('tap ? 960'), /Line 1: tap expects a position/);
  assert.throws(() => logic.parseWorkflow('tap 50% 101%'), /Line 1: tap expects a position/);
  assert.throws(() => logic.parseWorkflow('tap 50% 30% 20%'), /Line 1: tap expects a position/);
  assert.throws(() => logic.parseWorkflow('wake\nswipe 50% 80%'), /Line 2: swipe expects two positions/);
  assert.throws(() => logic.parseWorkflow('swipe 50% 80% 50% 20% fast'), /Line 1: swipe expects two positions/);
});

test('gesturePixels and parseScreenSize map percentages onto the screen', () => {
  const size = { width: 720, height: 1600 };
  assert.deepEqual(logic.gesturePixels([50, 25], size), [360, 400]);
  assert.deepEqual(logic.gesturePixels([0, 0, 100, 100], size), [0, 0, 719, 1599]);
  assert.deepEqual(logic.parseScreenSize('  init=720x1600 320dpi cur=1600x720 app=1600x664'), { width: 1600, height: 720 });
  assert.deepEqual(logic.parseScreenSize('Physical size: 1080x2400\nOverride size: 720x1600'), { width: 720, height: 1600 });
  assert.deepEqual(logic.parseScreenSize('Physical size: 1080x2400'), { width: 1080, height: 2400 });
  assert.equal(logic.parseScreenSize('error: closed'), null);
});

test('TouchRecorder turns getevent lines into workflow lines', () => {
  const devices = logic.parseTouchDevices([
    'add device 2: /dev/input/event4',
    '  name:     "mtk-pmic-keys"',
    '    KEY (0001): KEY_VOLUMEDOWN        KEY_POWER',
    'add device 7: /dev/input/event6',
    '  name:     "gcore"',
    '    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0',
    '                ABS_MT_POSITION_X     : value 0, min 0, max 719, fuzz 0, flat 0, resolution 0',
    '                ABS_MT_POSITION_Y     : value 0, min 0, max 1599, fuzz 0, flat 0, resolution 0',
  ].join('\n'));
  assert.deepEqual(devices, [{ path: '/dev/input/event6', maxX: 719, maxY: 1599 }]);

  const recorder = new logic.TouchRecorder(devices);
  const hex = (value) => value.toString(16).padStart(8, '0');
  const touch = (at, code, value) => `[${at.toFixed(6).padStart(15)}] /dev/input/event6: ${code.startsWith('SYN') ? 'EV_SYN' : code.startsWith('BTN') ? 'EV_KEY' : 'EV_ABS'}       ${code.padEnd(20)} ${value}`;
  const feed = (lines) => lines.flatMap((line) => recorder.push(line));
  const press = (at, x, y) => [touch(at, 'ABS_MT_TRACKING_ID', hex(5)), touch(at, 'BTN_TOUCH', 'DOWN'), touch(at, 'ABS_MT_POSITION_X', hex(x)), touch(at, 'ABS_MT_POSITION_Y', hex(y)), touch(at, 'SYN_REPORT', hex(0))];
  const lift = (at) => [touch(at, 'ABS_MT_TRACKING_ID', 'ffffffff'), touch(at, 'BTN_TOUCH', 'UP'), touch(at, 'SYN_REPORT', hex(0))];

  // A quick tap in the middle: no wait before the first step.
  assert.deepEqual(feed([...press(100, 360, 800), ...lift(100.08)]), ['tap 50.1% 50%']);
  // A drag up, 1.5 s later.
  assert.deepEqual(feed([
    ...press(101.58, 360, 1280),
    touch(101.7, 'ABS_MT_POSITION_Y', hex(800)), touch(101.7, 'SYN_REPORT', hex(0)),
    touch(101.88, 'ABS_MT_POSITION_Y', hex(320)), touch(101.88, 'SYN_REPORT', hex(0)),
    ...lift(101.88),
  ]), ['wait 1500', 'swipe 50.1% 80.1% 50.1% 20% 300']);
  // A press held in place is a long press. X did not change, so the panel sends only Y.
  assert.deepEqual(feed([
    touch(103, 'ABS_MT_TRACKING_ID', hex(6)), touch(103, 'ABS_MT_POSITION_Y', hex(400)), touch(103, 'SYN_REPORT', hex(0)),
    ...lift(103.9),
  ]), ['wait 1100', 'swipe 50.1% 25% 50.1% 25% 900']);
  // Two thumbs typing: the second key goes down before the first is lifted, and both are kept.
  assert.deepEqual(feed([
    ...press(104, 180, 1200),
    touch(104.05, 'ABS_MT_SLOT', hex(1)), touch(104.05, 'ABS_MT_TRACKING_ID', hex(7)), touch(104.05, 'ABS_MT_POSITION_X', hex(540)), touch(104.05, 'ABS_MT_POSITION_Y', hex(1200)), touch(104.05, 'SYN_REPORT', hex(0)),
    touch(104.1, 'ABS_MT_SLOT', hex(0)), ...lift(104.1),
    touch(104.2, 'ABS_MT_SLOT', hex(1)), ...lift(104.2),
    touch(104.2, 'ABS_MT_SLOT', hex(0)),
  ]), ['wait 100', 'tap 25% 75%', 'wait 100', 'tap 75.1% 75%']);
  // A hardware key is recorded, other devices are not.
  assert.deepEqual(recorder.push('[     105.900000] /dev/input/event4: EV_KEY       KEY_POWER            DOWN'), ['wait 1700', 'keyevent KEYCODE_POWER']);
  assert.deepEqual(recorder.push('[     106.000000] /dev/input/event2: EV_ABS       ABS_DISTANCE         00000001'), []);
  assert.deepEqual(recorder.push('garbage'), []);
  // Every recorded line is a valid workflow line.
  assert.doesNotThrow(() => logic.parseWorkflow('tap 50.1% 50%\nwait 1500\nswipe 50.1% 80.1% 50.1% 20% 300\nswipe 50.1% 25% 50.1% 25% 900\nkeyevent KEYCODE_POWER'));
});

test('fillWorkflow puts values into text steps only', () => {
  const steps = logic.parseWorkflow('tap 50% 30%\ntext {1}\ntap 50% 40%\ntext {2}\ntext ref {1}-{2}\nwait 500');
  assert.equal(logic.workflowInputs(steps), 2);
  assert.equal(logic.workflowInputs(logic.parseWorkflow('home\ntext hello')), 0);
  assert.deepEqual(logic.fillWorkflow(steps, ['1234567890', 250]).map((step) => step.argument), ['50% 30%', '1234567890', '50% 40%', '250', 'ref 1234567890-250', '500']);
  assert.throws(() => logic.fillWorkflow(steps, ['1234567890']), /Step 4 needs value \{2\}/);
  assert.throws(() => logic.fillWorkflow(steps, ['1', '']), /Step 4 needs value \{2\}/);
  assert.throws(() => logic.fillWorkflow(steps, ['1\nopen com.android.settings', '2']), /one line/);
  assert.throws(() => logic.fillWorkflow(steps, ['x'.repeat(201), '2']), /at most 200/);
  // A value is typed as it is, never read as a command.
  const filled = logic.fillWorkflow(steps, ['open com.android.settings', '{1}']);
  assert.deepEqual(filled.map((step) => step.command), ['tap', 'text', 'tap', 'text', 'text', 'wait']);
  assert.equal(filled[3].argument, '{1}');
});

test('cleanNumber takes the value out of page text', () => {
  assert.equal(logic.cleanNumber('เลขบัญชีธนาคาร : 0531586115'), '0531586115');
  assert.equal(logic.cleanNumber('3,001.00THB'), '3001.00');
  assert.equal(logic.cleanNumber('จำนวนเงิน :\n3,001.00THB'), '3001.00');
  assert.equal(logic.cleanNumber('Account 053-1-58611-5'), '0531586115');
  assert.equal(logic.cleanNumber('ช่อง 2: 1,250,000'), '1250000');
  assert.equal(logic.cleanNumber('0531586115'), '0531586115');
  assert.equal(logic.cleanNumber('250'), '250');
  assert.equal(logic.cleanNumber('ไม่มีตัวเลข'), '');
  assert.equal(logic.cleanNumber(''), '');
});

test('wholeNumber drops a zero fraction and refuses any other', () => {
  assert.equal(logic.wholeNumber('3001.00'), '3001');
  assert.equal(logic.wholeNumber('3001.0'), '3001');
  assert.equal(logic.wholeNumber('3001'), '3001');
  assert.equal(logic.wholeNumber('0531586115'), '0531586115');
  assert.equal(logic.wholeNumber(''), '');
  assert.equal(logic.wholeNumber(logic.cleanNumber('จำนวนเงิน : 3,001.00THB')), '3001');
  assert.throws(() => logic.wholeNumber('3001.50'), /3001\.50 has a fraction/);
  assert.throws(() => logic.wholeNumber('0.01'), /has a fraction/);
});

test('verifyScreen checks the phone screen against the job', () => {
  const slip = logic.parseUiText('<node text="โอนเงินสำเร็จ" content-desc="" /><node text="ไปยัง" /><node text="053-1-xxx11-5" /><node text="จำนวนเงิน" /><node text="3,001.00 บาท" /><node text="ค่าธรรมเนียม 0.00 &amp; อื่นๆ" content-desc="ปิด" />');
  assert.equal(slip, 'โอนเงินสำเร็จ\nไปยัง\n053-1-xxx11-5\nจำนวนเงิน\n3,001.00 บาท\nค่าธรรมเนียม 0.00 & อื่นๆ\nปิด');
  assert.deepEqual(logic.verifyScreen(slip, ['0531586115', '3001'], 'สำเร็จ'), []);
  assert.deepEqual(logic.verifyScreen(slip, ['0531586115', '3001'], ''), []);
  // A different amount, account or a missing success message each fail.
  assert.deepEqual(logic.verifyScreen(slip, ['0531586115', '3000'], 'สำเร็จ'), ['value 3000']);
  assert.deepEqual(logic.verifyScreen(slip, ['0531586125', '3001'], 'สำเร็จ'), ['value 0531586125']);
  assert.deepEqual(logic.verifyScreen(slip, ['0531586115', '3001'], 'รายการสำเร็จแล้ว'), ['"รายการสำเร็จแล้ว"']);
  assert.deepEqual(logic.verifyScreen('', ['0531586115', '3001'], 'สำเร็จ'), ['value 0531586115', 'value 3001', '"สำเร็จ"']);
  // An amount is compared as a number: 3001 is not shown by 13,001.00 or 3,001.50.
  assert.ok(logic.screenShows('ยอด 3,001.00 บาท', '3001'));
  assert.ok(logic.screenShows('ยอด 3001 บาท', '3001.00'));
  assert.ok(!logic.screenShows('ยอด 13,001.00 บาท', '3001'));
  assert.ok(!logic.screenShows('ยอด 3,001.50 บาท', '3001'));
  // Account numbers: in full, with dashes, or partly hidden. Fully hidden proves nothing.
  assert.ok(logic.screenShows('บัญชี 053-1-58611-5', '0531586115'));
  assert.ok(logic.screenShows('บัญชี XXX-X-X8611-X', '0531586115'));
  assert.ok(!logic.screenShows('บัญชี XXX-X-XXXX1-5', '0531586115'));
  assert.ok(!logic.screenShows('บัญชี xxx-x-x8612-x', '0531586115'));
  assert.ok(!logic.screenShows('อะไรก็ได้', ''));
  // Text read from a picture can put two numbers on one line, or spaces inside one.
  assert.ok(logic.screenShows('053-1-58611-5 3,001.00', '3001'));
  assert.ok(logic.screenShows('053-1-58611-5 3,001.00', '0531586115'));
  assert.ok(logic.screenShows('053 1 58611 5', '0531586115'));
});

test('findUiText gives the middle of the words on the screen, wherever they are', () => {
  const xml = '<?xml version="1.0"?><hierarchy rotation="0">'
    + '<node index="0" text="" content-desc="ปิด" clickable="true" bounds="[646,133][691,178]" />'
    + '<node index="1" text="" content-desc="โอนเงิน" clickable="true" bounds="[26,911][177,1095]"><node text="โอนเงิน" content-desc="" bounds="[30,1015][173,1049]" /></node>'
    + '<node index="2" text="ถอนเงินไม่ใช้บัตร" content-desc="" bounds="[358,1015][501,1079]" />'
    + '<node index="3" text="Tom &amp; Co" content-desc="" bounds="[0,0][100,40]" />'
    + '<node index="4" text="เลื่อนพ้นจอ" content-desc="" bounds="[0,0][0,0]" />'
    + '</hierarchy>';
  assert.deepEqual(logic.findUiText(xml, 'โอนเงิน'), { x: 102, y: 1003, label: 'โอนเงิน' });
  assert.deepEqual(logic.findUiText(xml, ' ปิด '), { x: 669, y: 156, label: 'ปิด' });
  // Part of a label is not the label: "ปิด" must never tap "เปิด…". Stars ask for a part.
  assert.equal(logic.findUiText(xml, 'ไม่ใช้บัตร'), null);
  assert.equal(logic.findUiText(xml, 'โอน'), null);
  assert.equal(logic.findUiText(xml, '*ไม่ใช้บัตร*').label, 'ถอนเงินไม่ใช้บัตร');
  assert.equal(logic.findUiText(xml, 'tom & co').x, 50);
  assert.equal(logic.findUiText(xml, 'เลื่อนพ้นจอ'), null);
  assert.equal(logic.findUiText(xml, 'ไม่มีคำนี้'), null);
  assert.equal(logic.findUiText(xml, ''), null);
});

test('taptext steps parse, need words, and take a job\'s values', () => {
  const steps = logic.parseWorkflow('taptext? ปิด\ntaptext โอนเงิน\ntaptext {3}');
  assert.deepEqual(steps.map((step) => [step.command, step.argument]), [['taptext?', 'ปิด'], ['taptext', 'โอนเงิน'], ['taptext', '{3}']]);
  assert.throws(() => logic.parseWorkflow('taptext'), /expects the words/);
  assert.equal(logic.workflowInputs(steps), 3);
  assert.equal(logic.expandWorkflow(steps, ['a', 'b', 'ธนาคารกสิกรไทย'], {}, {}, '')[2].argument, 'ธนาคารกสิกรไทย');
});

test('parseImageList keeps new pictures, newest first', () => {
  const output = '1791492000|/sdcard/DCIM/Camera/old.jpg\r\n1791492700|/sdcard/Pictures/Bualuang mBanking/slip 2.JPG\n1791492650|/sdcard/Pictures/Bualuang mBanking/slip 1.png\nfind: /sdcard/Download: No such file\n1791492800|/sdcard/Download/notes.txt\n';
  assert.deepEqual(logic.parseImageList(output, 1791492600), [
    { at: 1791492700, path: '/sdcard/Pictures/Bualuang mBanking/slip 2.JPG' },
    { at: 1791492650, path: '/sdcard/Pictures/Bualuang mBanking/slip 1.png' },
  ]);
  assert.equal(logic.parseImageList(output).length, 3);
  // A picture the phone is still writing is not offered.
  assert.deepEqual(logic.parseImageList('1791492700|/sdcard/Pictures/.pending-1791492900-slip.jpg\n1791492650|/sdcard/Pictures/slip.jpg\n'), [{ at: 1791492650, path: '/sdcard/Pictures/slip.jpg' }]);
  assert.deepEqual(logic.parseImageList('', 0), []);
});

test('checkPolicy enforces mode and capture rules', () => {
  const base = { actionName: 'home', pkg: 'com.bank.app' };
  assert.doesNotThrow(() => logic.checkPolicy(undefined, base));
  assert.throws(() => logic.checkPolicy({ mode: 'blocked' }, base), /Policy blocks home/);
  assert.throws(() => logic.checkPolicy({ mode: 'blocked' }, { ...base, allowManualOnly: true }), /Policy blocks home/);
  assert.throws(() => logic.checkPolicy({ mode: 'manual_only' }, base), /manual-only/);
  assert.doesNotThrow(() => logic.checkPolicy({ mode: 'manual_only' }, { ...base, allowManualOnly: true }));
  assert.throws(() => logic.checkPolicy({ allow_capture: false }, { ...base, requireCapture: true }), /blocks screenshots/);
  assert.doesNotThrow(() => logic.checkPolicy({ allow_capture: false }, base));
});

test('mapLimit keeps order and respects the limit', async () => {
  let running = 0;
  let peak = 0;
  const results = await logic.mapLimit([30, 10, 20, 5, 15], 2, async (ms) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running -= 1;
    return ms * 2;
  });
  assert.deepEqual(results, [60, 20, 40, 10, 30]);
  assert.equal(peak, 2);
  assert.deepEqual(await logic.mapLimit([], 3, async () => 1), []);
});

test('verifyScreen matches Thai typed with one mark against recognized text with two', () => {
  assert.deepEqual(logic.verifyScreen('รายการสํา เร็จ\n739.00', ['739'], 'รายการสำเร็จ'), []);
  assert.deepEqual(logic.verifyScreen('739.00', ['739'], 'รายการสำเร็จ'), ['"รายการสำเร็จ"']);
});

test('parseSlip reads payer, paid side and amount from a slip with the amount on top', () => {
  const text = [
    '@ Bangkok Bank', 'รายการสําเร็จ', '08 ต.ค. 69, 06:58', 'จํานวนเงิน', '739.00 tHe',
    '9     นาย ทดสอบ', '324-0-xxx718', 'ธนาคารกรุงเทพ',
    '๑   นาย ผู้รับ ทดสอบ', '020-1-xxxxx8-76', 'ธนาคารเพื่อการเกษตรและ',
    'ค่าธรรมเนียม 0.00 THB', 'หมายเลขอ้างอิง', '202610080658123456', 'เลขที่อ้างอิง', '123456789012',
  ].join('\n');
  assert.deepEqual(logic.parseSlip(text), {
    amount: '739.00',
    sender_account_masked: '3240xxx718', sender_account_last4: '', bank: 'BBL', bank_name_th: 'ธนาคารกรุงเทพ',
    receiver_account_masked: '0201xxxxx876', receiver_account_last4: '', receiver_bank: 'BAAC', receiver_bank_name_th: 'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร',
  });
});

test('parseSlip reads a slip that names the bank before the account', () => {
  const text = ['K+', 'โอนเงินสำเร็จ', 'นาย ทดสอบ', 'ธ.กสิกรไทย', 'xxx-x-x0758-x', 'นาง ผู้รับ', 'ธ.ไทยพาณิชย์', 'xxx-xxx747-6', 'จำนวน:', '1,067.00 บาท', 'ค่าธรรมเนียม:', '0.00 บาท'].join('\n');
  const slip = logic.parseSlip(text);
  assert.equal(slip.amount, '1067.00');
  assert.equal(slip.sender_account_masked, 'xxxxx0758x');
  assert.equal(slip.bank, 'KBANK');
  assert.equal(slip.receiver_account_masked, 'xxxxxx7476');
  assert.equal(slip.receiver_account_last4, '7476');
  assert.equal(slip.receiver_bank, 'SCB');
});

test('mediaRowsToList turns the rows of the picture index into lines parseImageList reads', () => {
  const rows = 'Row: 0 date_modified=1791492650, _data=/storage/emulated/0/Pictures/Bank/slip, one.jpg\r\n'
    + 'Row: 1 date_modified=1791492700, _data=/storage/emulated/0/Android/media/app/other.jpg\n'
    + 'Row: 2 date_modified=1791492600, _data=/storage/emulated/0/DCIM/Camera/old.jpg\n'
    + 'No result found.\n';
  assert.deepEqual(logic.parseImageList(logic.mediaRowsToList(rows), 1791492640), [{ at: 1791492650, path: '/storage/emulated/0/Pictures/Bank/slip, one.jpg' }]);
  assert.equal(logic.mediaRowsToList('No result found.'), '');
});

test('parseSlip reads the whole amount when the reader puts a dot after the comma', () => {
  assert.equal(logic.parseSlip('1,.600.00THB\n524-0-xxx547\n044-7-xxx124').amount, '1600.00');
  assert.equal(logic.parseSlip('1.600.00 THB').amount, '1600.00');
  assert.equal(logic.parseSlip('12,.345,678.50').amount, '12345678.50');
  // A figure the pattern cannot take whole gives no amount, never its last digits.
  assert.equal(logic.parseSlip('1,,,600.00').amount, '');
});

test('parseSlip gives no accounts when it cannot tell payer from paid', () => {
  assert.equal(logic.parseSlip('739.00\n324-0-xxx718').sender_account_masked, '');
  assert.equal(logic.parseSlip('').amount, '');
});

test('expandWorkflow puts the saved workflow a run step names in its place', () => {
  const saved = { 'bank-KBANK': '# pick KBank\ntap 30% 40%\n', 'Bank-SCB': 'swipe 50% 75% 50% 25%\ntap 30% 60%\n', loop: 'run loop\n', outer: 'run bank-{3}\ntext {1}\n' };
  const main = logic.parseWorkflow('open com.bank.app\nrun bank-{3}\ntext {1}\nrun outer');
  assert.equal(logic.workflowInputs(main), 3);
  assert.deepEqual(
    logic.expandWorkflow(main, ['739', '0201', 'KBANK'], saved).map((step) => `${step.command} ${step.argument}`),
    ['open com.bank.app', 'tap 30% 40%', 'text 739', 'tap 30% 40%', 'text 739'],
  );
  // The name is matched without regard to letter case or spaces.
  assert.equal(logic.expandWorkflow(main, ['739', '0201', ' scb '], saved).length, 7);
  assert.throws(() => logic.expandWorkflow(main, ['739', '0201', 'TTB'], saved), /no saved workflow named 'bank-TTB'/);
  assert.throws(() => logic.expandWorkflow(main, ['739', '0201'], saved), /needs value \{3\}/);
  assert.throws(() => logic.expandWorkflow(logic.parseWorkflow('run loop'), [], saved), /runs itself/);
  assert.throws(() => logic.expandWorkflow(logic.parseWorkflow('run toString'), [], saved), /no saved workflow/);
  assert.throws(() => logic.parseWorkflow('run'), /run expects the name/);
});

test('expandWorkflow turns a pick step into scrolls and a tap from the position set', () => {
  const sets = {
    banks: {
      scroll: '50% 70% 50% 35% 1500',
      items: { 'ธนาคารกสิกรไทย': { page: 0, at: '17% 30%' }, 'ธ.ก.ส.': { page: 2, at: '50% 42%' }, broken: { page: 0, at: 'nowhere' } },
    },
  };
  const main = logic.parseWorkflow('open com.bank.app\npick banks {3}\ntext {1}');
  assert.equal(logic.workflowInputs(main), 3);
  const lines = (values) => logic.expandWorkflow(main, values, {}, sets).map((step) => `${step.command} ${step.argument}`);
  assert.deepEqual(lines(['739', '', 'ธนาคาร กสิกรไทย']), ['open com.bank.app', 'tap 17% 30%', 'text 739']);
  assert.deepEqual(lines(['739', '', 'ธ.ก.ส.']), [
    'open com.bank.app', 'swipe 50% 70% 50% 35% 1500', 'wait 700', 'swipe 50% 70% 50% 35% 1500', 'wait 700', 'tap 50% 42%', 'text 739',
  ]);
  assert.throws(() => lines(['739', '', 'ธนาคารออมสิน']), /Position set 'banks' has no position for 'ธนาคารออมสิน', or more than one/);
  assert.throws(() => lines(['739', '', 'broken']), /has no position for 'broken'/);
  assert.throws(() => lines(['739']), /needs value \{3\}/);
  assert.throws(() => logic.expandWorkflow(logic.parseWorkflow('pick cards {1}'), ['a'], {}, sets), /no position set named 'cards'/);
  assert.throws(() => logic.expandWorkflow(logic.parseWorkflow('pick banks {1}'), ['a'], {}, undefined), /no position set named 'banks'/);
  assert.throws(() => logic.parseWorkflow('pick banks'), /pick expects a position set and a name/);
  assert.equal(logic.normalizePickSet({ scroll: 'bad' }).scroll, logic.DEFAULT_PICK_SCROLL);
});

test('findPick matches a name, its other spellings, and a bank under any of its names', () => {
  const set = logic.normalizePickSet({
    items: {
      KBANK: { page: 0, at: '17% 30%' },
      'ไทยพาณิชย์': { page: 0, at: '50% 30%' },
      TMW: { page: 1, at: '83% 30%', also: ['ทรูมันนี่ วอลเล็ท', ' TrueMoney '] },
    },
  });
  assert.equal(logic.findPick(set, 'kbank'), 'KBANK');
  assert.equal(logic.findPick(set, 'ธนาคารกสิกรไทย'), 'KBANK');
  assert.equal(logic.findPick(set, 'SCB'), 'ไทยพาณิชย์');
  assert.equal(logic.findPick(set, 'ทรูมันนี่วอลเล็ท'), 'TMW');
  assert.equal(logic.findPick(set, 'truemoney'), 'TMW');
  // A bank the set does not have, and a word that is no bank, find nothing.
  assert.equal(logic.findPick(set, 'ธนาคารกรุงเทพ'), '');
  assert.equal(logic.findPick(set, 'อะไรก็ไม่รู้'), '');
  // Two positions for one bank cannot be told apart, so neither is taken.
  const twice = logic.normalizePickSet({ items: { KBANK: { page: 0, at: '17% 30%' }, 'กสิกร': { page: 0, at: '50% 30%' } } });
  assert.equal(logic.findPick(twice, 'ธนาคารกสิกรไทย'), '');
  assert.equal(logic.findPick(twice, 'กสิกร'), 'กสิกร');
});

test('findPick knows every bank of a full list by its short name and its Thai name', () => {
  const short = ['BBL', 'Kbank', 'KTB', 'TTB', 'SCB', 'CIMBT', 'UOBT', 'BAY', 'GSB', 'LHBANK', 'KKP', 'TISCO', 'BAAC', 'CITI', 'GHB', 'ICBC', 'TCRB', 'SCBT', 'HSBC', 'SMBC', 'MHCB', 'ISBT', 'DBBK', 'BOC', 'IOBA', 'BNPP', 'SME', 'JPMC'];
  const set = logic.normalizePickSet({ items: Object.fromEntries(short.map((name, index) => [name, { page: 0, at: `${index + 1}% 30%` }])) });
  const thai = {
    'ธนาคารกรุงเทพ': 'BBL', 'ธนาคารกสิกรไทย': 'Kbank', 'ธนาคารกรุงไทย': 'KTB', 'ธนาคารทหารไทยธนชาต': 'TTB', 'ธนาคารไทยพาณิชย์': 'SCB',
    'ธนาคารซีไอเอ็มบี ไทย': 'CIMBT', 'ธนาคารยูโอบี': 'UOBT', 'ธนาคารกรุงศรีอยุธยา': 'BAY', 'ธนาคารออมสิน': 'GSB', 'ธนาคารแลนด์ แอนด์ เฮ้าส์': 'LHBANK',
    'ธนาคารเกียรตินาคินภัทร': 'KKP', 'ธนาคารทิสโก้': 'TISCO', 'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร': 'BAAC', 'ธนาคารซิตี้แบงก์': 'CITI',
    'ธนาคารอาคารสงเคราะห์': 'GHB', 'ธนาคารไอซีบีซี (ไทย)': 'ICBC', 'ธนาคารไทยเครดิต': 'TCRB', 'ธนาคารสแตนดาร์ดชาร์เตอร์ด (ไทย)': 'SCBT',
    'ธนาคารฮ่องกงและเซี่ยงไฮ้': 'HSBC', 'ธนาคารซูมิโตโม มิตซุย': 'SMBC', 'ธนาคารมิซูโฮ': 'MHCB', 'ธนาคารอิสลามแห่งประเทศไทย': 'ISBT',
    'ธนาคารดอยซ์แบงก์': 'DBBK', 'ธนาคารแห่งประเทศจีน': 'BOC', 'ธนาคารอินเดียนโอเวอร์ซีส์': 'IOBA', 'ธนาคารบีเอ็นพี พารีบาส์': 'BNPP',
    'ธนาคารพัฒนาวิสาหกิจขนาดกลางและขนาดย่อม': 'SME', 'ธนาคารเจพีมอร์แกน เชส': 'JPMC',
  };
  assert.equal(Object.keys(thai).length, short.length);
  for (const [name, wanted] of Object.entries(thai)) assert.equal(logic.findPick(set, name), wanted, name);
  for (const name of short) assert.equal(logic.findPick(set, name.toUpperCase()), name, name);
});

test('expandWorkflow turns a pin step into one secret tap per digit of the phone PIN', () => {
  const sets = { keypad: { items: { 1: { page: 0, at: '15% 58%' }, 2: { page: 0, at: '50% 58%' }, 3: { page: 0, at: '85% 58%' }, 4: { page: 0, at: '15% 68%' } } } };
  const main = logic.parseWorkflow('open com.bank.app\npin keypad\ntext {1}');
  assert.equal(logic.workflowInputs(main), 1);
  const steps = logic.expandWorkflow(main, ['739'], {}, sets, '1231');
  assert.deepEqual(steps.map((step) => `${step.command} ${step.argument}`), [
    'open com.bank.app', 'tap 15% 58%', 'wait 800', 'tap 50% 58%', 'wait 800', 'tap 85% 58%', 'wait 800', 'tap 15% 58%', 'text 739',
  ]);
  // Nothing about a PIN step says which key it is.
  const taps = steps.filter((step) => step.secret);
  assert.equal(taps.length, 4);
  assert.ok(taps.every((step) => step.note === 'PIN'));
  assert.equal(logic.expandWorkflow(logic.parseWorkflow('pin keypad 250'), [], {}, sets, '1234')[1].argument, '250');
  // A workflow run from another reaches the same PIN.
  assert.equal(logic.expandWorkflow(logic.parseWorkflow('run unlock'), [], { unlock: 'pin keypad\n' }, sets, '4321').length, 7);
  assert.throws(() => logic.expandWorkflow(main, ['739'], {}, sets, ''), /No PIN is set for this phone/);
  assert.throws(() => logic.expandWorkflow(main, ['739'], {}, sets, undefined), /No PIN is set for this phone/);
  assert.throws(() => logic.expandWorkflow(main, ['739'], {}, sets, '12a4'), /No PIN is set for this phone/);
  assert.throws(() => logic.expandWorkflow(main, ['739'], {}, {}, '1234'), /no position set named 'keypad'/);
  const short = () => logic.expandWorkflow(main, ['739'], {}, sets, '1239');
  assert.throws(short, /does not have every digit/);
  // The error, which is logged, does not name the digit.
  assert.throws(short, (error) => !/9/.test(error.message));
  assert.throws(() => logic.parseWorkflow('pin'), /pin expects the keypad/);
  assert.equal(logic.parseWorkflow('close com.bank.app')[0].command, 'close');
  assert.throws(() => logic.parseWorkflow('close not a package'), /close expects a package name/);
  assert.equal(logic.isPin('1234'), true);
  assert.equal(logic.isPin('123'), false);
});

test('parseWithdrawRow reads a withdrawal row of the back office table', () => {
  const cells = [
    '', '1',
    'ยูชเซอร์เนม : 0812345678\nชื่อธนาคาร : ธนาคารไทยพาณิชย์\nชื่อบัญชีธนาคาร : นาย ทดสอบ ระบบ\nเลขบัญชีธนาคาร : 123-4-56789-0\nตรวจสอบสถานะสมาชิก :\nตรวจสอบที่อยู่ไอพีสมาชิก :\nรับโปรโมชัน : ไม่รับ\nทรูวอลเลท : -\nแท็ก :\nเงื่อนไข :\n-\nโน้ต :',
    'จำนวนเงิน :\n1,250.00THB\nถอน :\nเต็มจำนวน',
    'ถอน :\n11/10/2026 05:41:07\nอนุมัติ :\n11/10/2026 05:42:30',
    'อนุมัติ', 'อนุมัติโดย :\nแอดมิน', 'ถูกต้อง', '',
  ];
  assert.deepEqual(logic.parseWithdrawRow(cells), {
    user: '0812345678', bank: 'ธนาคารไทยพาณิชย์', holder: 'นาย ทดสอบ ระบบ', account: '1234567890', amount: '1250.00',
    requested: '11/10/2026 05:41:07', approved: '11/10/2026 05:42:30', key: '1234567890|1250.00|11/10/2026 05:41:07',
  });
  // An empty label does not swallow the label after it.
  assert.equal(logic.parseWithdrawRow(cells.map((cell) => cell.replace('ชื่อบัญชีธนาคาร : นาย ทดสอบ ระบบ', 'ชื่อบัญชีธนาคาร :'))).holder, '');
  // Rows that are not a withdrawal to a bank account.
  assert.equal(logic.parseWithdrawRow(['ไม่พบข้อมูล']), null);
  assert.equal(logic.parseWithdrawRow(cells.map((cell) => cell.replace('123-4-56789-0', ''))), null);
  assert.equal(logic.parseWithdrawRow(cells.map((cell) => cell.replace('1,250.00THB', '0.00THB'))), null);
  assert.equal(logic.parseWithdrawRow(undefined), null);
});

test('withdrawFromApi gives the row and the key that the page gives', () => {
  const item = {
    id: '00000000-0000-4000-8000-000000000000', username: '0812345678', bank_type: 'BANK', bank_no: '1234567890',
    member_bank_display: 'ธนาคารไทยพาณิชย์', first_name: 'นาย ทดสอบ', last_name: 'ระบบ', approve_status: 'approve', success_datetime: null,
    withdrawal_amount: 1250, total_amount: 1250, is_withdraw_partial: 0,
    withdraw_datetime: '2026-10-10T22:41:07.000Z', approve_datetime: '2026-10-10T22:42:30.000Z',
  };
  const cells = [
    'ยูชเซอร์เนม : 0812345678\nชื่อธนาคาร : ธนาคารไทยพาณิชย์\nชื่อบัญชีธนาคาร : นาย ทดสอบ ระบบ\nเลขบัญชีธนาคาร : 123-4-56789-0',
    'จำนวนเงิน :\n1,250.00THB', 'ถอน :\n11/10/2026 05:41:07\nอนุมัติ :\n11/10/2026 05:42:30',
  ];
  const fromApi = logic.withdrawFromApi(item);
  const { id, ...fromApiRow } = fromApi;
  assert.deepEqual(fromApiRow, logic.parseWithdrawRow(cells));
  // The id is kept apart from the page's fields, so the row can be closed by request.
  assert.equal(id, '00000000-0000-4000-8000-000000000000');
  assert.equal(logic.withdrawFromApi({ ...item, id: 'not an id' }).id, null);
  // The day turns over in Thai time, not in the request's.
  assert.equal(logic.withdrawFromApi({ ...item, withdraw_datetime: '2026-12-31T17:00:05.000Z' }).requested, '01/01/2027 00:00:05');
  // Rows that are not a plain, open withdrawal to a bank account.
  assert.equal(logic.withdrawFromApi({ ...item, bank_type: 'CRYPTO' }), null);
  assert.equal(logic.withdrawFromApi({ ...item, approve_status: 'pending' }), null);
  assert.equal(logic.withdrawFromApi({ ...item, success_datetime: '2026-10-10T22:50:00.000Z' }), null);
  assert.equal(logic.withdrawFromApi({ ...item, total_amount: 1240 }), null);
  assert.equal(logic.withdrawFromApi({ ...item, is_withdraw_partial: 1 }), null);
  assert.equal(logic.withdrawFromApi({ ...item, withdraw_datetime: '' }), null);
  assert.equal(logic.withdrawFromApi(null), null);
});

test('settlementFromApi reads one of the shop\'s paying accounts', () => {
  const item = {
    id: '43b88cce-5fdc-414a-8b98-075807612df1', settlement_account_id: '43b88cce-5fdc-414a-8b98-075807612df1',
    bank_no: '5240274547', bank_code: 'BBL', bank_name_display: 'ธนาคารกรุงเทพ', settlement_acc_name: 'นาย ก', balance: 9609, is_active: true,
  };
  assert.deepEqual(logic.settlementFromApi(item), {
    account: '5240274547', id: '43b88cce-5fdc-414a-8b98-075807612df1', holder: 'นาย ก', bank: 'ธนาคารกรุงเทพ', bankCode: 'BBL', balance: 9609, on: true,
  });
  assert.equal(logic.settlementFromApi({ ...item, is_active: false }).on, false);
  assert.equal(logic.settlementFromApi({ ...item, is_active: 1 }).on, true);
  // The withdrawal-settlement-search shape: id is the settlement account id, bank name is nested.
  assert.deepEqual(logic.settlementFromApi({
    id: '814271bf-f364-4f34-a1d7-a9615bb4842d', bank_no: '0989522651', balance: 9092, is_active: 1,
    settlement_acc_name: 'นาย ข', bank_information: { bank_name_display: 'ธนาคารกรุงเทพ', bank_code: 'BBL' },
  }), {
    account: '0989522651', id: '814271bf-f364-4f34-a1d7-a9615bb4842d', holder: 'นาย ข', bank: 'ธนาคารกรุงเทพ', bankCode: 'BBL', balance: 9092, on: true,
  });
  assert.equal(logic.settlementFromApi({ ...item, bank_no: '' }), null);
  assert.equal(logic.settlementFromApi({ ...item, settlement_account_id: '', id: '' }), null);
  assert.equal(logic.settlementFromApi(null), null);
});

test('apiClosePath and closeApproveBody build the close request; closeApproved reads the answer', () => {
  const id = '060a8459-b13d-4898-bcc1-f3d6cfa89b7e';
  const settlement = '814271bf-f364-4f34-a1d7-a9615bb4842d';
  assert.equal(logic.apiClosePath(id), `/bo/withdrawal-approve/${id}`);
  assert.throws(() => logic.apiClosePath('nope'), /is not a withdrawal id/);
  assert.deepEqual(logic.closeApproveBody(settlement), {
    approve_tran_remark: '', settlement_account_id: settlement, transfer_already: true, withdraw_state: 'APPROVE', withdraw_status: 'success',
  });
  assert.throws(() => logic.closeApproveBody(''), /settlement account id is needed/);
  assert.equal(logic.closeApproved({ withdraw_status: 'success', success_datetime: '2026-10-12T23:34:13.000Z' }), true);
  assert.equal(logic.closeApproved({ withdraw_status: 'success', success_datetime: null }), false);
  assert.equal(logic.closeApproved({ withdraw_status: 'pending', success_datetime: '2026-10-12T23:34:13.000Z' }), false);
  assert.equal(logic.closeApproved(null), false);
});

test('settlementTogglePath and settlementToggleBody build the on/off request', () => {
  const id = 'dee51691-cbee-4d4e-b685-be31b9aa186a';
  assert.equal(logic.settlementTogglePath(id), `/bo/withdrawal-settlement/${id}`);
  assert.throws(() => logic.settlementTogglePath('nope'), /is not a settlement account id/);
  assert.deepEqual(logic.settlementToggleBody(true), { is_active: 1 });
  assert.deepEqual(logic.settlementToggleBody(false), { is_active: 0 });
});

test('a slip whose hidden digits were recognized as percent signs still reads', () => {
  const text = ['Bangkok Bank', 'รายการสําเร็จ', 'จํานวนเงิน', '2,002.00 THB', 'จาก   นาย ร้าน', '324-0-xxx718', 'ธนาคารกรุงเทพ', 'ไปที่   นาย ผู้รับ', '123-4-%%%890', 'ธนาคารกสิกรไทย', 'ค่าธรรมเนียม 0.00 THB'].join('\n');
  const slip = logic.parseSlip(text);
  assert.equal(slip.sender_account_masked, '3240xxx718');
  assert.equal(slip.receiver_account_masked, '1234xxx890');
  assert.equal(slip.receiver_bank, 'KBANK');
  assert.equal(logic.screenShows(text, '1234567890'), true);
  assert.equal(logic.screenShows(text, '1234567891'), false);
  // A percentage in the text is not an account.
  assert.equal(logic.screenShows('ดอกเบี้ย 1.50% ต่อปี 100%', '1234567890'), false);
});

test('maskAgrees and bankCode tell whether a slip came from a given account', () => {
  assert.equal(logic.maskAgrees('3240xxx718', '3240555718'), true);
  assert.equal(logic.maskAgrees('3240xxx718', '324-0-55571-8'), true);
  assert.equal(logic.maskAgrees('3240xxx718', '3240555719'), false);
  assert.equal(logic.maskAgrees('3240xxx718', '32405557180'), false);
  assert.equal(logic.maskAgrees('xxxxxxxxxx', '3240555718'), false);
  assert.equal(logic.maskAgrees('', '3240555718'), false);
  assert.equal(logic.bankCode('ธนาคารกรุงเทพ'), 'BBL');
  assert.equal(logic.bankCode('bbl'), 'BBL');
  assert.equal(logic.bankCode('ร้านค้า'), '');
});

test('parseSettlementRow reads one of the shop accounts off the back office list', () => {
  const cells = ['3', 'Bank', 'ชื่อบัญชี : ร้าน ทดสอบ / BBL 50K\nหมายเลขบัญชี : 3240555718\nแท็ก :', 'THB', '1,649.00', '11/10/2026 06:59:06', '-', '', ''];
  assert.deepEqual(logic.parseSettlementRow(cells, true), { account: '3240555718', holder: 'ร้าน ทดสอบ / BBL 50K', balance: 1649, updated: '11/10/2026 06:59:06', on: true });
  assert.equal(logic.parseSettlementRow(cells, false).on, false);
  assert.equal(logic.parseSettlementRow(cells).on, null);
  // The running number of the row is not taken for the balance.
  assert.equal(logic.parseSettlementRow(cells.map((cell) => (cell === '1,649.00' ? '' : cell)), true).balance, null);
  assert.equal(logic.parseSettlementRow(cells.map((cell) => (cell === '1,649.00' ? '0.00' : cell)), true).balance, 0);
  // A row that is not a bank account, such as a payment gateway.
  assert.equal(logic.parseSettlementRow(['1', 'gateway', 'ชื่อเกตเวย์ : abc\n\nโทเคน :', 'THB', '646.00', '11/10/2026 06:59:06'], true), null);
});

test('parseSlip reads an amount whose comma the reader took for a dot', () => {
  assert.equal(logic.parseSlip('รายการสำเร็จ\n1.000.00 บาท\nค่าธรรมเนียม 0.00 THB').amount, '1000.00');
  assert.equal(logic.parseSlip('รายการสำเร็จ\n12,345.50 บาท').amount, '12345.50');
  assert.equal(logic.parseSlip('รายการสำเร็จ\n1.234.567.00 บาท').amount, '1234567.00');
  assert.equal(logic.parseSlip('รายการสำเร็จ\n739.50 บาท').amount, '739.50');
});

test('a slip whose hidden digits were read as other letters, and steps for a keypad and a field the app names', () => {
  const slip = logic.parseSlip(['รายการโอนเงินสำเร็จ', 'จำนวนเงิน', '300.00', 'นางสาว ก ข', 'ธนาคารออมสิน', '0204xxxx9590', 'นางสาว ค ง', 'ธนาคารไทยพาณิชย์', '74๒๐๐%2354'].join('\n'));
  assert.equal(slip.amount, '300.00');
  assert.equal(slip.sender_account_masked, '0204xxxx9590');
  assert.equal(slip.bank, 'GSB');
  assert.equal(slip.receiver_account_masked, '74xxxx2354');
  assert.equal(slip.receiver_bank, 'SCB');
  assert.equal(slip.receiver_account_loose, true);
  assert.equal(slip.sender_account_loose, undefined);
  assert.equal(logic.endsAgree('74xxxx2354', '7412342354'), true);
  assert.equal(logic.endsAgree('74xxx2354', '7412342354'), true);
  assert.equal(logic.endsAgree('74xxxx2354', '7512342354'), false);
  assert.equal(logic.endsAgree('74xxxx2354', '7412342355'), false);
  assert.equal(logic.endsAgree('74xxxx2354', '742354'), false);
  // Such a line counts only under a bank's name.
  assert.equal(logic.parseSlip(['300.00', 'ธนาคารออมสิน', '0204xxxx9590', 'รหัส', '74๒๐๐%2354'].join('\n')).receiver_account_masked, '');

  const steps = logic.expandWorkflow(logic.parseWorkflow('tapid pinTextView\npintext 200\nslidetext เลื่อนเพื่อส่ง'), [], {}, {}, '1234');
  assert.deepEqual(steps.map((step) => step.command), ['tapid', 'taptext', 'wait', 'taptext', 'wait', 'taptext', 'wait', 'taptext', 'slidetext']);
  assert.equal(steps.filter((step) => step.command === 'taptext').every((step) => step.secret), true);
  assert.throws(() => logic.expandWorkflow(logic.parseWorkflow('pintext'), [], {}, {}, ''), /No PIN/);
  assert.throws(() => logic.parseWorkflow('pintext abc'), /pintext/);
  const xml = '<node text="" resource-id="com.app:id/amountEditText" bounds="[60,710][660,790]" /><node text="" resource-id="com.app:id/gone" bounds="[0,0][0,0]" />';
  assert.deepEqual(logic.findUiId(xml, 'amountEditText'), { x: 360, y: 750 });
  assert.equal(logic.findUiId(xml, 'gone'), null);
  assert.equal(logic.findUiId(xml, 'EditText'), null);
});

test('a slip whose account begins with a 0 read as the letter O', () => {
  const text = ['รายการโอนเงินสำเร็จ', 'จำนวนเงิน', '518.00', 'ธนาคารออมสิน', '0204xxxx9590', 'ธนาคารกสิกรไทย', 'O4xxxx258O', 'QR Code'].join('\n');
  const slip = logic.parseSlip(text);
  assert.equal(slip.receiver_account_masked, '04xxxx2580');
  assert.equal(slip.receiver_bank, 'KBANK');
  assert.equal(logic.screenShows(logic.slipDigits(text), '0412342580'), true);
  assert.equal(logic.screenShows(logic.slipDigits(text), '0412342581'), false);
  // An O in a word is left alone.
  assert.equal(logic.slipDigits('QR Code Oxxford TOxxx12'), 'QR Code Oxxford TOxxx12');
});

test('a slip whose account begins with a 4 read as A, or has a digit too many', () => {
  const text = ['รายการโอนเงินสำเร็จ', 'จำนวนเงิน', '2,936.00', 'ธนาคารออมสิน', '0204xxxx5783', 'ธนาคารกรุงไทย', 'AOxxxx9805', 'QR Code'].join('\n');
  const slip = logic.parseSlip(text);
  assert.equal(slip.receiver_account_masked, '40xxxx9805');
  assert.equal(slip.receiver_bank, 'KTB');
  assert.equal(logic.screenShows(logic.slipDigits(text), '4012349805'), true);
  assert.equal(logic.screenShows(logic.slipDigits(text), '4112349805'), false);
  // An A in a word, or in a mark that does not end in four digits, is left alone.
  assert.equal(logic.slipDigits('Axxess Axxx12 KAxxxx1234'), 'Axxess Axxx12 KAxxxx1234');

  const extra = logic.parseSlip(['รายการโอนเงินสำเร็จ', 'จำนวนเงิน', '600.00', 'ธนาคารออมสิน', '0204xxxx6087', 'ธนาคารกรุงไทย', '12xxxx65517'].join('\n'));
  assert.equal(extra.receiver_account_masked, '12xxxx65517');
  assert.equal(logic.endsAgree(extra.receiver_account_masked, '1212345517'), true);
  assert.equal(logic.endsAgree(extra.receiver_account_masked, '1312345517'), false);
  assert.equal(logic.endsAgree(extra.receiver_account_masked, '1212345518'), false);
  assert.equal(logic.endsAgree('12xxxx5517', '125517'), false);
});

test('rows are paid oldest first', () => {
  const rows = [
    { key: 'c', requested: '14/10/2026 06:36:30', approved: '14/10/2026 06:37:00' },
    { key: 'none', requested: '', approved: '' },
    { key: 'b', requested: '14/10/2026 06:36:22', approved: '14/10/2026 06:38:00' },
    { key: 'a2', requested: '13/10/2026 23:59:59', approved: '14/10/2026 06:40:00' },
    { key: 'a1', requested: '13/10/2026 23:59:59', approved: '14/10/2026 06:39:00' },
    { key: 'd', requested: '14/10/2026 6:40', approved: '' },
  ];
  assert.deepEqual(logic.oldestFirst(rows).map((row) => row.key), ['a1', 'a2', 'b', 'c', 'd', 'none']);
  // The list given is left as it was.
  assert.equal(rows[0].key, 'c');
  // A new month and a new year come after the old ones, which they would not as text.
  assert.deepEqual(logic.oldestFirst([{ key: 'new', requested: '01/01/2027 00:00:01' }, { key: 'old', requested: '31/12/2026 23:59:59' }]).map((row) => row.key), ['old', 'new']);
});

test('a day that begins at an hour of its own, and two daily caps', () => {
  const at = (hour, minute = 0) => new Date(2026, 9, 14, hour, minute).getTime();
  assert.equal(logic.dayStart('BBL', at(10)), new Date(2026, 9, 14, 0, 0).getTime());
  assert.equal(logic.dayStart('GSB', at(10)), new Date(2026, 9, 13, 23, 0).getTime());
  assert.equal(logic.dayStart('GSB', at(22, 59)), new Date(2026, 9, 13, 23, 0).getTime());
  assert.equal(logic.dayStart('GSB', at(23)), new Date(2026, 9, 14, 23, 0).getTime());
  assert.equal(logic.dayStart('', at(0)), new Date(2026, 9, 14, 0, 0).getTime());

  const spent = { own: 99500, other: 40000 };
  // Two caps: each is its own.
  const two = { bankCode: 'GSB', cap: 100000, capOwn: 100000 };
  assert.equal(logic.capShort(two, spent, 500, 'GSB'), '');
  assert.equal(logic.capShort(two, spent, 501, 'GSB'), 'capown');
  assert.equal(logic.capShort(two, spent, 60000, 'KBANK'), '');
  assert.equal(logic.capShort(two, spent, 60001, 'KBANK'), 'capother');
  assert.equal(logic.capShort({ ...two, cap: null }, spent, 999999, 'KBANK'), '');
  // One cap for everything: a bank's account with no limit of its own for the bank, and every other bank.
  const one = { bankCode: 'GSB', cap: 140000, capOwn: null };
  assert.equal(logic.capShort(one, spent, 500, 'GSB'), '');
  assert.equal(logic.capShort(one, spent, 501, 'KBANK'), 'cap');
  assert.equal(logic.capShort({ bankCode: 'BBL', cap: 140000, capOwn: 5 }, spent, 500, 'BBL'), '');
  assert.equal(logic.capShort({ bankCode: 'BBL', cap: 140000, capOwn: 5 }, spent, 501, 'BBL'), 'cap');
  assert.equal(logic.capShort({ bankCode: 'BBL', cap: null, capOwn: null }, spent, 1e9, 'KBANK'), '');
});

test('a look at the screen that never stops the run', () => {
  const steps = logic.expandWorkflow(logic.parseWorkflow('waittext ทำรายการสำเร็จ\nchecktext? {1}'), ['3087270280', '1112.00'], {}, {}, '');
  assert.deepEqual(steps.map((step) => [step.command, step.argument]), [['waittext', 'ทำรายการสำเร็จ'], ['checktext?', '3087270280']]);
  assert.throws(() => logic.parseWorkflow('checktext?'), /checktext\?/);
});

test('a PIN typed from one look at the keypad, counted before its last key', () => {
  const steps = logic.expandWorkflow(logic.parseWorkflow('pintext 400 once'), [], {}, {}, '123456');
  assert.deepEqual(steps.map((step) => step.command), ['pinkeys', 'pinkey', 'wait', 'pinkey', 'wait', 'pinkey', 'wait', 'pinkey', 'wait', 'pinkey', 'wait', 'pincount', 'pinkey']);
  assert.equal(steps.filter((step) => step.command === 'pinkey').every((step) => step.secret), true);
  assert.equal(steps.find((step) => step.command === 'pincount').argument, '5');
  assert.equal(steps.filter((step) => step.command === 'wait').every((step) => step.argument === '400'), true);
  assert.throws(() => logic.parseWorkflow('pintext once'), /pintext/);
  assert.throws(() => logic.parseWorkflow('pintext 400 twice'), /pintext/);
  // The old form is unchanged.
  assert.equal(logic.expandWorkflow(logic.parseWorkflow('pintext 300'), [], {}, {}, '123456').filter((step) => step.command === 'taptext').length, 6);

  const key = (digit, x, y) => `<node text="${digit}" resource-id="app:id/t9_key_${digit}" bounds="[${x},${y}][${x + 200},${y + 90}]" />`;
  const pad = [key(1, 15, 1077), key(2, 247, 1077), key(3, 479, 1077), key(4, 15, 1183), key(5, 247, 1183), key(6, 479, 1183), key(7, 15, 1289), key(8, 247, 1289), key(9, 479, 1289), key(0, 250, 1395)].join('');
  const keys = logic.findKeypad(pad);
  assert.deepEqual(keys['5'], { x: 347, y: 1228 });
  assert.equal(Object.keys(keys).length, 10);
  assert.equal(logic.findKeypad(pad.replace(key(0, 250, 1395), '')), null);
  assert.equal(logic.findKeypad(pad + key(3, 10, 10)), null);

  const field = (text) => `<node text="${text}" resource-id="app:id/pinTextView" password="true" bounds="[222,813][496,843]" /><node text="ลืมรหัสผ่าน" password="false" bounds="[0,900][720,940]" />`;
  assert.equal(logic.pinMarks(field('•••••')), 5);
  assert.equal(logic.pinMarks(field('')), 0);
  assert.equal(logic.pinMarks(field('••••') + field('•')), null);
  assert.equal(logic.pinMarks('<node text="x" password="false" />'), null);
});

test('a bank pause, from a little before its start until its end', () => {
  const at = (h, m, s = 0) => new Date(2026, 9, 15, h, m, s);
  const bbl = { from: '02:30', to: '03:00' };
  assert.equal(logic.pauseUntil(bbl, at(2, 27, 59)), '');
  assert.equal(logic.pauseUntil(bbl, at(2, 28)), '03:00');
  assert.equal(logic.pauseUntil(bbl, at(2, 45)), '03:00');
  assert.equal(logic.pauseUntil(bbl, at(2, 59, 59)), '03:00');
  assert.equal(logic.pauseUntil(bbl, at(3, 0)), '');
  assert.equal(logic.pauseUntil(bbl, at(14, 0)), '');
  // Past midnight.
  const late = { from: '23:50', to: '00:10' };
  assert.equal(logic.pauseUntil(late, at(23, 47)), '');
  assert.equal(logic.pauseUntil(late, at(23, 48)), '00:10');
  assert.equal(logic.pauseUntil(late, at(0, 5)), '00:10');
  assert.equal(logic.pauseUntil(late, at(0, 10)), '');
  // A pause starting at midnight begins its lead the evening before.
  assert.equal(logic.pauseUntil({ from: '00:00', to: '00:30' }, at(23, 59)), '00:30');
  // No pause, or one that is not two different times.
  assert.equal(logic.pauseUntil(undefined, at(2, 45)), '');
  assert.equal(logic.pauseUntil({ from: '02:30', to: '02:30' }, at(2, 30)), '');
  assert.equal(logic.pauseUntil({ from: '2:30', to: '03:00' }, at(2, 45)), '');
  assert.deepEqual(logic.cleanPause({ from: ' 02:30 ', to: '03:00' }), { from: '02:30', to: '03:00' });
  assert.equal(logic.cleanPause({ from: '24:00', to: '03:00' }), null);
  assert.deepEqual(logic.DEFAULT_PAUSES.BBL, { from: '02:30', to: '03:00' });
});
