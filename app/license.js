'use strict';

// Activation codes for the program handed to other people. The owner signs a small note that
// names one computer; the program accepts a code only when the signature is the owner's and the
// note names the computer it runs on. No server is asked: everything needed is in the code.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');

const encode = (bytes) => Buffer.from(bytes).toString('base64url');
const decode = (text) => Buffer.from(String(text), 'base64url');

/** A short code for a computer, shaped XXXX-XXXX-XXXX, from an id that stays the same on it. */
function machineCodeOf(id) {
  const digest = crypto.createHash('sha256').update(`onetwo-adb|${String(id).trim().toLowerCase()}`).digest();
  // Letters and digits that are not mistaken for each other when read out or typed.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let index = 0; index < 12; index += 1) code += alphabet[digest[index] % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** This computer's code. Windows gives every installation an id of its own. */
function machineCode() {
  const output = childProcess.execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
  if (!match) throw new Error('This computer\'s id could not be read.');
  return machineCodeOf(match[1]);
}

const cleanMachine = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Make an activation code. `expires` is a date (YYYY-MM-DD, good through that day) or null for a
 * code with no end. `offlineDays` is how many days the program may go without a successful check
 * of the list of cancelled codes; 0 means it never has to.
 */
function issue({ machine, name, expires = null, offlineDays = 0, id }, privateKey) {
  const target = cleanMachine(machine);
  if (target.length !== 12) throw new Error('A computer\'s code is 12 letters and digits, shaped XXXX-XXXX-XXXX.');
  if (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(expires))) throw new Error('The last day is written YYYY-MM-DD, or left empty for no end.');
  const note = {
    v: 1,
    id: id || crypto.randomBytes(6).toString('hex'),
    machine: target,
    name: String(name || '').trim().slice(0, 80),
    issued: new Date().toISOString().slice(0, 10),
    expires,
    offlineDays: Math.max(0, Math.round(Number(offlineDays) || 0)),
  };
  const body = Buffer.from(JSON.stringify(note), 'utf8');
  return { code: `${encode(body)}.${encode(crypto.sign(null, body, privateKey))}`, note };
}

/** Read a code's note without judging it, or null when it is not a code. For showing what was pasted. */
function read(code) {
  try {
    const note = JSON.parse(decode(String(code).trim().split('.')[0]).toString('utf8'));
    return note && typeof note === 'object' ? note : null;
  } catch {
    return null;
  }
}

/**
 * Judge a code on this computer. Resolves with { ok, reason, note, daysLeft }:
 * reason is '' when ok, else 'missing', 'forged', 'machine', 'expired', 'cancelled' or 'offline'.
 * `cancelled` is the ids the owner has cancelled; `lastChecked` is when that list was last read.
 */
function check(code, publicKey, { machine, now = new Date(), cancelled = [], lastChecked = null } = {}) {
  const text = String(code || '').trim();
  if (!text) return { ok: false, reason: 'missing', note: null, daysLeft: null };
  const [body, signature] = text.split('.');
  let note = null;
  try {
    const bytes = decode(body);
    // Verify before parsing: nothing from an unsigned note is read.
    if (!signature || !crypto.verify(null, bytes, publicKey, decode(signature))) return { ok: false, reason: 'forged', note: null, daysLeft: null };
    note = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'forged', note: null, daysLeft: null };
  }
  if (!note || note.v !== 1 || note.machine !== cleanMachine(machine)) return { ok: false, reason: 'machine', note, daysLeft: null };
  if (cancelled.includes(note.id)) return { ok: false, reason: 'cancelled', note, daysLeft: null };
  let daysLeft = null;
  if (note.expires) {
    // Good through the whole of its last day, by this computer's own clock.
    const end = new Date(`${note.expires}T23:59:59`);
    daysLeft = Math.ceil((end - now) / 86400000);
    if (now > end) return { ok: false, reason: 'expired', note, daysLeft };
  }
  if (note.offlineDays > 0) {
    const since = lastChecked ? new Date(lastChecked) : new Date(`${note.issued}T00:00:00`);
    if ((now - since) / 86400000 > note.offlineDays) return { ok: false, reason: 'offline', note, daysLeft };
  }
  return { ok: true, reason: '', note, daysLeft };
}

/** The list of cancelled codes, signed, as the file the programs read: { ids, at, signature }. */
function signCancelled(ids, privateKey) {
  const list = { ids: [...new Set(ids.map(String))].sort(), at: new Date().toISOString() };
  const body = Buffer.from(JSON.stringify(list), 'utf8');
  return JSON.stringify({ list: encode(body), signature: encode(crypto.sign(null, body, privateKey)) });
}

/** The ids in a signed list of cancelled codes. Throws when the signature is not the owner's. */
function readCancelled(fileText, publicKey) {
  const { list, signature } = JSON.parse(String(fileText));
  const body = decode(list);
  if (!crypto.verify(null, body, publicKey, decode(signature))) throw new Error('The list of cancelled codes is not signed by the owner.');
  const parsed = JSON.parse(body.toString('utf8'));
  return { ids: Array.isArray(parsed.ids) ? parsed.ids.map(String) : [], at: String(parsed.at || '') };
}

module.exports = { machineCode, machineCodeOf, issue, read, check, signCancelled, readCancelled };
