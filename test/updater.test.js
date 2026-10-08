'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { checkForUpdate, validBaseUrl } = require('../app/updater');
const { isNewer } = require('../app/version');

const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const BASE = 'https://updates.example.test/farm/';

function makeBundle(version, files, signingKey = keys.privateKey) {
  const encoded = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text).toString('base64')]));
  const bundle = zlib.gzipSync(JSON.stringify({ version, files: encoded }));
  return { bundle, signature: crypto.sign(null, bundle, signingKey).toString('base64') };
}

/** Serves latest.json and one bundle from memory in place of the network. */
function serve(t, latest, bundle) {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    const name = String(url).slice(BASE.length);
    const body = name === 'latest.json' ? Buffer.from(JSON.stringify(latest)) : name === latest.file ? bundle : null;
    return { ok: body !== null, status: body ? 200 : 404, arrayBuffer: async () => body };
  });
  return requested;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('isNewer compares version numbers, not strings', () => {
  assert.ok(isNewer('0.20.0', '0.19.9'));
  assert.ok(isNewer('0.10.0', '0.9.0'));
  assert.ok(!isNewer('0.20.0', '0.20.0'));
  assert.ok(!isNewer('0.19.0', '0.20.0'));
});

test('update URL must be https and end with a slash', () => {
  assert.ok(validBaseUrl(BASE));
  assert.ok(!validBaseUrl(''));
  assert.ok(!validBaseUrl('http://updates.example.test/farm/'));
  assert.ok(!validBaseUrl('https://updates.example.test/farm'));
});

test('no URL means the updater is disabled and never touches the network', async (t) => {
  const requested = serve(t, {}, null);
  assert.deepEqual(await checkForUpdate({ baseUrl: '', currentVersion: '0.20.0', publicKey, updatesDir: tempDir(t) }), { status: 'disabled' });
  assert.equal(requested.length, 0);
});

test('same version reports current and downloads only latest.json', async (t) => {
  const requested = serve(t, { version: '0.20.0', file: 'app-0.20.0.bin' }, null);
  const result = await checkForUpdate({ baseUrl: BASE, currentVersion: '0.20.0', publicKey, updatesDir: tempDir(t) });
  assert.deepEqual(result, { status: 'current' });
  assert.deepEqual(requested, [`${BASE}latest.json`]);
});

test('a signed newer bundle is unpacked and becomes the current pointer', async (t) => {
  const { bundle, signature } = makeBundle('0.21.0', { 'app/main.js': 'new main', 'app/ui/app.js': 'new ui' });
  serve(t, { version: '0.21.0', file: 'app-0.21.0.bin', signature }, bundle);
  const updatesDir = tempDir(t);
  const result = await checkForUpdate({ baseUrl: BASE, currentVersion: '0.20.0', publicKey, updatesDir });
  assert.deepEqual(result, { status: 'updated', version: '0.21.0' });
  assert.equal(fs.readFileSync(path.join(updatesDir, '0.21.0', 'app', 'main.js'), 'utf8'), 'new main');
  assert.equal(fs.readFileSync(path.join(updatesDir, '0.21.0', 'app', 'ui', 'app.js'), 'utf8'), 'new ui');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(updatesDir, 'current.json'), 'utf8')), { version: '0.21.0' });
});

test('a bundle signed with another key is rejected and nothing is written', async (t) => {
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey;
  const { bundle, signature } = makeBundle('0.21.0', { 'app/main.js': 'evil' }, stranger);
  serve(t, { version: '0.21.0', file: 'app-0.21.0.bin', signature }, bundle);
  const updatesDir = tempDir(t);
  const result = await checkForUpdate({ baseUrl: BASE, currentVersion: '0.20.0', publicKey, updatesDir });
  assert.equal(result.status, 'error');
  assert.deepEqual(fs.readdirSync(updatesDir), []);
});

test('a tampered bundle is rejected', async (t) => {
  const { bundle, signature } = makeBundle('0.21.0', { 'app/main.js': 'good' });
  const tampered = Buffer.from(bundle);
  tampered[tampered.length - 5] ^= 0xff;
  serve(t, { version: '0.21.0', file: 'app-0.21.0.bin', signature }, tampered);
  const updatesDir = tempDir(t);
  assert.equal((await checkForUpdate({ baseUrl: BASE, currentVersion: '0.20.0', publicKey, updatesDir })).status, 'error');
  assert.ok(!fs.existsSync(path.join(updatesDir, 'current.json')));
});

test('a bundle whose inner version differs from latest.json is rejected', async (t) => {
  const { bundle, signature } = makeBundle('0.20.5', { 'app/main.js': 'old' });
  serve(t, { version: '0.21.0', file: 'app-0.21.0.bin', signature }, bundle);
  const updatesDir = tempDir(t);
  assert.equal((await checkForUpdate({ baseUrl: BASE, currentVersion: '0.20.0', publicKey, updatesDir })).status, 'error');
  assert.ok(!fs.existsSync(path.join(updatesDir, 'current.json')));
});

test('a signed bundle cannot write outside its own folder', async (t) => {
  const { bundle, signature } = makeBundle('0.21.0', { '../../escape.js': 'x' });
  serve(t, { version: '0.21.0', file: 'app-0.21.0.bin', signature }, bundle);
  const updatesDir = path.join(tempDir(t), 'a', 'b');
  const result = await checkForUpdate({ baseUrl: BASE, currentVersion: '0.20.0', publicKey, updatesDir });
  assert.equal(result.status, 'error');
  assert.ok(!fs.existsSync(path.join(updatesDir, '..', 'escape.js')));
  assert.ok(!fs.existsSync(path.join(updatesDir, 'current.json')));
});

test('an odd file name in latest.json is refused before any download', async (t) => {
  const requested = serve(t, { version: '0.21.0', file: '../other.bin', signature: 'x' }, null);
  const result = await checkForUpdate({ baseUrl: BASE, currentVersion: '0.20.0', publicKey, updatesDir: tempDir(t) });
  assert.equal(result.status, 'error');
  assert.deepEqual(requested, [`${BASE}latest.json`]);
});

test('offline reports an error instead of throwing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  const result = await checkForUpdate({ baseUrl: BASE, currentVersion: '0.20.0', publicKey, updatesDir: tempDir(t) });
  assert.deepEqual(result, { status: 'error', message: 'getaddrinfo ENOTFOUND' });
});
