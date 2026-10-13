'use strict';

// A work pack: everything built in the studio for one bank on one model of phone, in one signed
// file. The program handed to other people runs from a pack and cannot change it. A pack holds no
// PIN, no back-office address, no account and no history: those stay on the computer that uses it.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const logic = require('./core/logic.js');
const { isNewer } = require('./version.js');

const MAX_PACK_BYTES = 2 * 1024 * 1024;
// The settings of a job that belong to how the workflows fit together, and so travel with them.
// `bank` and `flows`: the bank whose app those workflows drive, and the workflows of other banks' apps.
const JOB_KEYS = ['workflow', 'enter', 'again', 'rest', 'stay', 'expect', 'bank', 'flows'];

/**
 * Check a pack's content and give it its full shape. Throws, naming what is wrong: a pack that
 * cannot run must not be signed, and one that arrives broken must not be used.
 */
function normalize(content) {
  const pack = content && typeof content === 'object' ? content : {};
  const name = String(pack.name || '').trim().slice(0, 60);
  if (!name) throw new Error('A pack needs a name.');
  if (!/^\d+\.\d+\.\d+$/.test(String(pack.version || ''))) throw new Error('A pack\'s version is written like 1.0.0.');
  if (!/^\d+\.\d+\.\d+$/.test(String(pack.minApp || ''))) throw new Error('A pack names the oldest program version it runs on, like 1.0.0.');
  const workflows = {};
  for (const [key, text] of Object.entries(pack.workflows || {})) {
    try {
      logic.parseWorkflow(String(text));
    } catch (error) {
      throw new Error(`Workflow "${key}": ${error.message}`);
    }
    workflows[key] = String(text);
  }
  const jobs = {};
  for (const key of JOB_KEYS) if (key in (pack.jobs || {})) jobs[key] = pack.jobs[key];
  if (!jobs.workflow || !workflows[jobs.workflow]) throw new Error('A pack names the workflow that pays, and holds it.');
  for (const key of ['enter', 'again', 'rest']) {
    if (jobs[key] && !workflows[jobs[key]]) throw new Error(`The pack names "${jobs[key]}" for ${key}, but does not hold it.`);
  }
  for (const [code, flow] of Object.entries(jobs.flows && typeof jobs.flows === 'object' ? jobs.flows : {})) {
    for (const key of ['workflow', 'enter', 'again']) {
      if (flow && flow[key] && !workflows[flow[key]]) throw new Error(`The pack names "${flow[key]}" for ${code}, but does not hold it.`);
    }
  }
  const pickSets = {};
  for (const [key, set] of Object.entries(pack.pickSets || {})) pickSets[key] = logic.normalizePickSet(set);
  // Every position set and workflow a step leans on must be in the pack itself.
  for (const [key, text] of Object.entries(workflows)) {
    for (const step of logic.parseWorkflow(text)) {
      const first = String(step.argument || '').split(/\s+/)[0];
      if ((step.command === 'pick' || step.command === 'pin') && !pickSets[first]) throw new Error(`Workflow "${key}" uses the position set "${first}", which is not in the pack.`);
      if (step.command === 'run' && !/\{\d\}/.test(first) && !workflows[step.argument]) throw new Error(`Workflow "${key}" runs "${step.argument}", which is not in the pack.`);
    }
  }
  return {
    v: 1,
    name,
    version: String(pack.version),
    minApp: String(pack.minApp),
    phone: { model: String((pack.phone || {}).model || ''), width: Number((pack.phone || {}).width) || 0, height: Number((pack.phone || {}).height) || 0 },
    workflows,
    pickSets,
    jobs,
    profile: pack.profile && typeof pack.profile === 'object' ? pack.profile : null,
    built: String(pack.built || new Date().toISOString()),
  };
}

/** The text of a signed pack file. */
function build(content, privateKey) {
  const body = zlib.gzipSync(JSON.stringify(normalize(content)), { level: 9 });
  return JSON.stringify({ pack: body.toString('base64'), signature: crypto.sign(null, body, privateKey).toString('base64') });
}

/** A signed pack file's content, checked. Throws when it is not the owner's, broken, or too new for this program. */
function open(fileText, publicKey, appVersion) {
  if (Buffer.byteLength(String(fileText)) > MAX_PACK_BYTES) throw new Error('The pack file is too large.');
  let body;
  let signature;
  try {
    const file = JSON.parse(String(fileText));
    body = Buffer.from(String(file.pack), 'base64');
    signature = Buffer.from(String(file.signature), 'base64');
  } catch {
    throw new Error('That file is not a pack.');
  }
  // Verify before parsing: nothing from an unsigned pack is read.
  if (!crypto.verify(null, body, publicKey, signature)) throw new Error('The pack is not signed by the owner.');
  const content = normalize(JSON.parse(zlib.gunzipSync(body).toString('utf8')));
  if (appVersion && isNewer(content.minApp, appVersion)) throw new Error(`This pack needs program version ${content.minApp} or newer. Update the program first.`);
  return content;
}

module.exports = { build, open, normalize, JOB_KEYS };
