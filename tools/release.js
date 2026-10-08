'use strict';

// Owner-only tool. Builds a signed update from the app/ folder.
//   node tools/release.js 0.20.1
// Then publish the updates/ folder at the URL in package.json "updateUrl" (for a GitHub repo:
// commit and push). Running apps pick the update up at their next daily check.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { isNewer } = require('../app/version.js');

const root = path.join(__dirname, '..');
const version = process.argv[2];
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));

if (!/^\d+\.\d+\.\d+$/.test(version || '') || !isNewer(version, pkg.version)) {
  console.error(`ใส่เลขเวอร์ชันที่ใหม่กว่า ${pkg.version} เช่น node tools/release.js 0.20.1`);
  process.exit(1);
}

function collect(dir, files = {}) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) collect(rel, files);
    else files[rel] = fs.readFileSync(path.join(root, rel)).toString('base64');
  }
  return files;
}

const bundle = zlib.gzipSync(JSON.stringify({ version, files: collect('app') }), { level: 9 });
const signature = crypto.sign(null, bundle, fs.readFileSync(path.join(root, 'update-private.pem'), 'utf8')).toString('base64');
const file = `app-${version}.bin`;
const outDir = path.join(root, 'updates');

fs.mkdirSync(outDir, { recursive: true });
for (const old of fs.readdirSync(outDir)) if (old.endsWith('.bin')) fs.rmSync(path.join(outDir, old));
fs.writeFileSync(path.join(outDir, file), bundle);
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({ version, file, size: bundle.length, signature }));
fs.writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);

console.log(`สร้างอัปเดต ${version} แล้ว ขนาด ${(bundle.length / 1024).toFixed(1)} KB`);
console.log('ขั้นต่อไป: เผยแพร่โฟลเดอร์ updates/ ไปที่ URL ใน package.json "updateUrl"');
