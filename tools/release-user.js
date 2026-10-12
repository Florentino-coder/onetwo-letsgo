'use strict';

// Owner-only tool. Puts what the user programs read on their own channel into one folder:
//   node tools/release-user.js [folder]
// - the program update: app/ at the version in package.json, without the studio's window and
//   without the close-job profiles (a profile names the owner's back office; the pack carries
//   the steps instead), signed
// - the list of cancelled activation codes and the work pack on offer, when updates/ holds them
// Then publish the folder at the URL in package.json "userUpdateUrl" (for a GitHub repo: copy it
// into the public repo's updates/ folder, commit and push).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// What the user program never runs. Fonts and the logo under app/ui/ stay: its window uses them.
const LEFT_OUT = [/^app\/ui\/[^/]+\.(js|html|css)$/, /^app\/closejob\/profiles\//, /^app\/packs\//];

function collect(root, dir, files = {}) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) collect(root, rel, files);
    else if (!LEFT_OUT.some((pattern) => pattern.test(rel))) files[rel] = fs.readFileSync(path.join(root, rel)).toString('base64');
  }
  return files;
}

/** The user program's update: { bundle, latest } where `latest` is the content of latest.json. */
function buildUserUpdate(root, version, privateKey) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('The version is written like 1.0.0.');
  const bundle = zlib.gzipSync(JSON.stringify({ version, files: collect(root, 'app') }), { level: 9 });
  const file = `app-${version}.bin`;
  return { bundle, latest: { version, file, size: bundle.length, signature: crypto.sign(null, bundle, privateKey).toString('base64') } };
}

function main() {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const outDir = path.resolve(process.argv[2] || path.join(root, 'user-channel', 'updates'));
  const keyFile = path.join(root, 'update-private.pem');
  if (!fs.existsSync(keyFile)) {
    console.error('ไม่พบ update-private.pem ในโฟลเดอร์โปรแกรม เครื่องนี้ลงชื่อไม่ได้');
    process.exit(1);
  }
  const publicKey = fs.readFileSync(path.join(root, 'app', 'update-public.pem'), 'utf8');
  const { bundle, latest } = buildUserUpdate(root, pkg.version, fs.readFileSync(keyFile, 'utf8'));
  // What goes out must pass the same check the programs make.
  if (!crypto.verify(null, bundle, publicKey, Buffer.from(latest.signature, 'base64'))) throw new Error('The key on this computer does not match the program\'s public key.');

  fs.mkdirSync(outDir, { recursive: true });
  for (const old of fs.readdirSync(outDir)) if (/^app-.*\.bin$|^pack-.*\.onetwopack$/.test(old)) fs.rmSync(path.join(outDir, old));
  fs.writeFileSync(path.join(outDir, latest.file), bundle);
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest));
  console.log(`โปรแกรมผู้ใช้งาน ${latest.version}: ${(bundle.length / 1024).toFixed(1)} KB`);

  const license = require('../app/license.js');
  const pack = require('../app/pack.js');
  const updates = path.join(root, 'updates');
  const cancelled = path.join(updates, 'cancelled.json');
  if (fs.existsSync(cancelled)) {
    const list = license.readCancelled(fs.readFileSync(cancelled, 'utf8'), publicKey);
    fs.copyFileSync(cancelled, path.join(outDir, 'cancelled.json'));
    console.log(`รายชื่อรหัสที่ยกเลิก: ${list.ids.length} รหัส`);
  } else {
    console.log('ยังไม่มีรายชื่อรหัสที่ยกเลิก (ออกรหัสเปิดใช้ในโปรแกรมก่อน)');
  }
  const offerFile = path.join(updates, 'pack-latest.json');
  if (fs.existsSync(offerFile)) {
    const offer = JSON.parse(fs.readFileSync(offerFile, 'utf8'));
    const content = pack.open(fs.readFileSync(path.join(updates, offer.file), 'utf8'), publicKey, pkg.version);
    fs.copyFileSync(path.join(updates, offer.file), path.join(outDir, offer.file));
    fs.copyFileSync(offerFile, path.join(outDir, 'pack-latest.json'));
    console.log(`ชุดงาน ${content.name} ${content.version}: ${offer.only ? `เฉพาะ ${offer.only.length} รหัส` : 'ผู้ใช้งานทุกคน'}`);
  } else {
    fs.rmSync(path.join(outDir, 'pack-latest.json'), { force: true });
    console.log('ไม่มีชุดงานบนช่องอัปเดต');
  }
  console.log(`วางไว้ที่ ${outDir}`);
  console.log('ขั้นต่อไป: เผยแพร่โฟลเดอร์นี้ไปที่ URL ใน package.json "userUpdateUrl"');
}

if (require.main === module) main();

module.exports = { buildUserUpdate, LEFT_OUT };
