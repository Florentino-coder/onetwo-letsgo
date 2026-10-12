'use strict';

// Owner-only tool. Builds the signed work pack from the studio's saved settings, without opening
// the studio:
//   node tools/make-pack.js BBL 1.0.0
// It writes the pack in two places: app/packs/default.onetwopack, which the next installer of
// OneTwo ADB brings along, and updates/ with pack-latest.json, which `npm run release:user` puts
// on the user channel for every user program. The studio's own button does the same for one
// activation code only.
const fs = require('node:fs');
const path = require('node:path');
const logic = require('../app/core/logic.js');
const pack = require('../app/pack.js');

const root = path.join(__dirname, '..');
const [name, version] = process.argv.slice(2);
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

function main() {
  if (!name || !/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('ใส่ชื่อและเวอร์ชันของชุดงาน เช่น node tools/make-pack.js BBL 1.0.0');
  const keyFile = path.join(root, 'update-private.pem');
  if (!fs.existsSync(keyFile)) throw new Error('ไม่พบ update-private.pem ในโฟลเดอร์โปรแกรม เครื่องนี้ลงชื่อไม่ได้');
  const pkg = read('package.json');
  const state = read('farm_manager_devices.json');
  const jobs = read('farm_manager_config.json').jobs || {};
  if (!jobs.workflow) throw new Error('ยังไม่ได้เลือกเวิร์กโฟลว์ที่ใช้จ่าย (เมนู "รับงานจากเว็บ" ข้อ 3)');

  const workflows = {};
  const pickSets = {};
  // Every workflow the job uses, and every workflow and position set those lean on.
  const take = (key) => {
    const text = (state.workflows || {})[key];
    if (!text) throw new Error(`ไม่พบเวิร์กโฟลว์ "${key}"`);
    if (workflows[key]) return;
    workflows[key] = text;
    for (const step of logic.parseWorkflow(text)) {
      const first = String(step.argument || '').split(/\s+/)[0];
      if (step.command === 'pick' || step.command === 'pin') {
        if (!(state.pick_sets || {})[first]) throw new Error(`เวิร์กโฟลว์ "${key}" ใช้ชุดตำแหน่ง "${first}" ซึ่งไม่มี`);
        pickSets[first] = state.pick_sets[first];
      }
      if (step.command === 'run' && !/\{\d\}/.test(first)) take(step.argument);
    }
  };
  for (const key of [jobs.workflow, jobs.enter, jobs.again, jobs.rest].filter(Boolean)) take(key);

  const profile = read('app/closejob/profiles/closejob_v1.json');
  const text = pack.build({
    name, version,
    // A pack runs on the program that was current when it was built, and on any newer one.
    minApp: Object.values(workflows).some((text) => /^\s*taptext\??\s/m.test(text)) ? '0.23.0' : '0.21.0',
    workflows, pickSets,
    jobs: Object.fromEntries(pack.JOB_KEYS.filter((key) => key in jobs).map((key) => [key, jobs[key]])),
    // The steps travel; the address of the owner's own back office and the owner's notes do not.
    profile: { ...profile, domain_patterns: [], _notes: undefined },
  }, fs.readFileSync(keyFile, 'utf8'));
  // What was just built must open with the program's own public key.
  const opened = pack.open(text, fs.readFileSync(path.join(root, 'app', 'update-public.pem'), 'utf8'), pkg.version);

  fs.mkdirSync(path.join(root, 'app', 'packs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'packs', 'default.onetwopack'), text, 'utf8');
  const updates = path.join(root, 'updates');
  fs.mkdirSync(updates, { recursive: true });
  for (const old of fs.readdirSync(updates)) if (/^pack-.*\.onetwopack$/.test(old)) fs.rmSync(path.join(updates, old));
  const file = `pack-${opened.version}.onetwopack`;
  fs.writeFileSync(path.join(updates, file), text, 'utf8');
  fs.writeFileSync(path.join(updates, 'pack-latest.json'), JSON.stringify({ name: opened.name, version: opened.version, file }), 'utf8');
  console.log(`ชุดงาน ${opened.name} ${opened.version}: ${Object.keys(opened.workflows).join(', ')} · ชุดตำแหน่ง ${Object.keys(opened.pickSets).join(', ')} · ${Buffer.byteLength(text)} ไบต์`);
  console.log('ขั้นต่อไป: npm run release:user แล้วเผยแพร่โฟลเดอร์ user-channel/updates');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
