'use strict';

// Code-only updates. A check downloads one small JSON file; an update downloads one compressed
// bundle of the app/ folder, signed with the owner's private key.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { isNewer } = require('./version.js');

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

async function download(baseUrl, name) {
  const res = await fetch(new URL(name, baseUrl), { cache: 'no-store', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BUNDLE_BYTES) throw new Error('ไฟล์อัปเดตใหญ่เกินกำหนด');
  return body;
}

function unpack(bundle, publicKey, signature, expectedVersion, updatesDir) {
  // Verify before parsing: nothing from an unsigned bundle is ever read.
  if (!crypto.verify(null, bundle, publicKey, Buffer.from(String(signature), 'base64'))) {
    throw new Error('ลายเซ็นของไฟล์อัปเดตไม่ถูกต้อง');
  }
  const { version, files } = JSON.parse(zlib.gunzipSync(bundle).toString('utf8'));
  if (version !== expectedVersion || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('เวอร์ชันของไฟล์อัปเดตไม่ตรง');

  const target = path.join(updatesDir, version);
  const staging = `${target}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(staging, name);
    if (!file.startsWith(staging + path.sep)) throw new Error('ไฟล์อัปเดตมีที่อยู่ไฟล์ไม่ถูกต้อง');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  fs.writeFileSync(path.join(updatesDir, 'current.json'), JSON.stringify({ version }));
}

function validBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).protocol === 'https:' && baseUrl.endsWith('/');
  } catch {
    return false;
  }
}

// Returns { status: 'disabled' | 'current' | 'updated' | 'error', version?, message? }.
async function checkForUpdate({ baseUrl, currentVersion, publicKey, updatesDir }) {
  if (!validBaseUrl(baseUrl)) return { status: 'disabled' };
  try {
    const latest = JSON.parse((await download(baseUrl, 'latest.json')).toString('utf8'));
    if (!isNewer(latest.version, currentVersion)) return { status: 'current' };
    if (!/^app-\d+\.\d+\.\d+\.bin$/.test(String(latest.file))) throw new Error('ชื่อไฟล์อัปเดตไม่ถูกต้อง');
    fs.mkdirSync(updatesDir, { recursive: true });
    unpack(await download(baseUrl, latest.file), publicKey, latest.signature, latest.version, updatesDir);
    return { status: 'updated', version: latest.version };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

module.exports = { checkForUpdate, unpack, validBaseUrl };
