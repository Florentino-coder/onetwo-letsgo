'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const license = require('../app/license.js');
const pack = require('../app/pack.js');

const owner = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const machine = license.machineCodeOf('11111111-2222-3333-4444-555555555555');

test('a computer\'s code is stable, readable, and its own', () => {
  assert.match(machine, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(license.machineCodeOf('11111111-2222-3333-4444-555555555555'), machine);
  assert.equal(license.machineCodeOf('  11111111-2222-3333-4444-55555555555A '), license.machineCodeOf('11111111-2222-3333-4444-55555555555a'));
  assert.notEqual(license.machineCodeOf('99999999-2222-3333-4444-555555555555'), machine);
});

test('an activation code works on its own computer only, and only when the owner signed it', () => {
  const { code, note } = license.issue({ machine, name: 'ผู้ใช้ ทดสอบ' }, owner.privateKey);
  assert.equal(note.expires, null);
  assert.deepEqual(license.check(code, owner.publicKey, { machine }), { ok: true, reason: '', note, daysLeft: null });
  // Typed with small letters and without the dashes, it is the same computer.
  assert.equal(license.check(code, owner.publicKey, { machine: machine.toLowerCase().replace(/-/g, '') }).ok, true);
  assert.equal(license.check(code, owner.publicKey, { machine: license.machineCodeOf('another') }).reason, 'machine');
  assert.equal(license.check(code, other.publicKey, { machine }).reason, 'forged');
  assert.equal(license.check('', owner.publicKey, { machine }).reason, 'missing');
  assert.equal(license.check('nonsense', owner.publicKey, { machine }).reason, 'forged');
  // A note changed after signing: the end date pushed out.
  const [body, signature] = code.split('.');
  const forged = Buffer.from(JSON.stringify({ ...note, machine: 'AAAAAAAAAAAA' })).toString('base64url');
  assert.equal(license.check(`${forged}.${signature}`, owner.publicKey, { machine: 'AAAA-AAAA-AAAA' }).reason, 'forged');
  assert.equal(license.read(code).name, 'ผู้ใช้ ทดสอบ');
  assert.equal(license.read('nonsense'), null);
  assert.equal(body.includes('.'), false);
});

test('a code with a last day is good through that day, and one without never ends', () => {
  const { code } = license.issue({ machine, name: 'a', expires: '2026-11-10' }, owner.privateKey);
  const during = license.check(code, owner.publicKey, { machine, now: new Date('2026-11-10T22:00:00') });
  assert.equal(during.ok, true);
  assert.equal(during.daysLeft, 1);
  assert.equal(license.check(code, owner.publicKey, { machine, now: new Date('2026-11-03T12:00:00') }).daysLeft, 8);
  assert.equal(license.check(code, owner.publicKey, { machine, now: new Date('2026-11-11T00:00:01') }).reason, 'expired');
  const forever = license.issue({ machine, name: 'a' }, owner.privateKey).code;
  assert.equal(license.check(forever, owner.publicKey, { machine, now: new Date('2099-01-01T00:00:00') }).ok, true);
  assert.throws(() => license.issue({ machine, expires: 'next month' }, owner.privateKey), /YYYY-MM-DD/);
  assert.throws(() => license.issue({ machine: 'ABC' }, owner.privateKey), /12 letters/);
});

test('a cancelled code stops, and the list of cancelled codes must be the owner\'s', () => {
  const { code, note } = license.issue({ machine, name: 'a' }, owner.privateKey);
  const file = license.signCancelled([note.id, 'other'], owner.privateKey);
  const { ids } = license.readCancelled(file, owner.publicKey);
  assert.deepEqual(ids, [note.id, 'other'].sort());
  assert.equal(license.check(code, owner.publicKey, { machine, cancelled: ids }).reason, 'cancelled');
  assert.throws(() => license.readCancelled(file, other.publicKey), /not signed by the owner/);
  assert.throws(() => license.readCancelled(license.signCancelled([], other.privateKey), owner.publicKey), /not signed by the owner/);
});

test('a code that must check the cancelled list stops when it has not for too long', () => {
  const { code } = license.issue({ machine, name: 'a', offlineDays: 7 }, owner.privateKey);
  const now = new Date('2026-12-20T12:00:00');
  assert.equal(license.check(code, owner.publicKey, { machine, now, lastChecked: '2026-12-15T12:00:00' }).ok, true);
  assert.equal(license.check(code, owner.publicKey, { machine, now, lastChecked: '2026-12-10T12:00:00' }).reason, 'offline');
  // With no such rule the list never has to be read.
  const free = license.issue({ machine, name: 'a' }, owner.privateKey).code;
  assert.equal(license.check(free, owner.publicKey, { machine, now, lastChecked: '2020-01-01T00:00:00' }).ok, true);
});

const content = () => ({
  name: 'BBL',
  version: '1.3.0',
  minApp: '1.0.0',
  phone: { model: 'SM-A065F', width: 720, height: 1600 },
  workflows: { pay: 'pick BANKS {3}\ntext {1}\ntext {2}', enter: 'wake\nhome\npin KEYS 1000', rest: 'home' },
  pickSets: { BANKS: { scroll: '50% 70% 50% 35% 1500', items: { 'ธนาคารกรุงเทพ': { page: 0, at: '20% 30%', also: [] } } }, KEYS: { items: { 1: { page: 0, at: '20% 60%' } } } },
  jobs: { workflow: 'pay', enter: 'enter', rest: 'rest', stay: 120, expect: 'รายการสำเร็จ', url: 'https://secret.example/', closeDry: true },
  profile: { profile_id: 'closejob_v1' },
});

test('a pack round-trips when the owner signed it, and carries no address or switch of the studio', () => {
  const file = pack.build(content(), owner.privateKey);
  const opened = pack.open(file, owner.publicKey, '1.0.0');
  assert.equal(opened.name, 'BBL');
  assert.equal(opened.workflows.enter, 'wake\nhome\npin KEYS 1000');
  assert.deepEqual(Object.keys(opened.jobs).sort(), ['enter', 'expect', 'rest', 'stay', 'workflow']);
  assert.equal(JSON.stringify(opened).includes('secret.example'), false);
  assert.equal(opened.pickSets.KEYS.items['1'].at, '20% 60%');
  assert.throws(() => pack.open(file, other.publicKey), /not signed by the owner/);
  assert.throws(() => pack.open('{"pack":"aGVsbG8=","signature":"aGVsbG8="}', owner.publicKey), /not signed by the owner/);
  assert.throws(() => pack.open('hello', owner.publicKey), /not a pack/);
  assert.throws(() => pack.open(file, owner.publicKey, '0.9.0'), /needs program version 1\.0\.0/);
});

test('a pack that could not run is not built', () => {
  const broken = (change) => { const made = content(); change(made); return () => pack.build(made, owner.privateKey); };
  assert.throws(broken((made) => { made.workflows.pay = 'fly away'; }), /Workflow "pay"/);
  assert.throws(broken((made) => { delete made.pickSets.BANKS; }), /position set "BANKS", which is not in the pack/);
  assert.throws(broken((made) => { delete made.pickSets.KEYS; }), /position set "KEYS"/);
  assert.throws(broken((made) => { made.jobs.enter = 'gone'; }), /names "gone" for enter/);
  assert.throws(broken((made) => { made.jobs.workflow = ''; }), /names the workflow that pays/);
  assert.throws(broken((made) => { made.version = 'new'; }), /version is written like/);
  assert.throws(broken((made) => { made.workflows.pay = 'run missing\ntext {1}'; }), /runs "missing"/);
});
