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
  assert.throws(() => logic.parseWorkflow('wake\nfly away'), /Line 2: unknown command 'fly'/);
  assert.throws(() => logic.parseWorkflow('wait soon'), /Line 1: wait expects milliseconds/);
  assert.throws(() => logic.parseWorkflow('open notapackage'), /Line 1: open expects a package name/);
  assert.throws(() => logic.parseWorkflow('home now'), /does not take an argument/);
  assert.throws(() => logic.parseWorkflow('\n# only comments\n'), /Workflow is empty/);
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
