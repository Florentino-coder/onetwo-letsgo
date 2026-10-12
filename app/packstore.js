'use strict';

// Where the user program keeps its work pack. A pack is checked against the owner's key every
// time it is read, so a file changed on disk is never run. The pack before the last one is kept,
// so a pack that turns out bad on real phones can be taken back with one press.
const fs = require('node:fs');
const path = require('node:path');
const pack = require('./pack.js');
const { isNewer } = require('./version.js');

const CURRENT = 'current.onetwopack';
const PREVIOUS = 'previous.onetwopack';
// The version a rollback took out of use. The update channel must not put it straight back.
const DECLINED = 'declined.json';

/**
 * `dir` is the folder the packs are kept in, `bundled` the pack file that came with the program
 * (used until one is installed), `publicKey` the owner's key and `appVersion` this program's version.
 */
function createPackStore({ dir, bundled, publicKey, appVersion }) {
  const file = (name) => path.join(dir, name);
  const readText = (target) => {
    try {
      return fs.readFileSync(target, 'utf8');
    } catch {
      return '';
    }
  };
  const openOr = (text) => {
    if (!text) return null;
    try {
      return pack.open(text, publicKey, appVersion);
    } catch {
      return null;
    }
  };

  /** The pack to run from, or null when there is none that passes the check. */
  function current() {
    return openOr(readText(file(CURRENT))) || openOr(bundled ? readText(bundled) : '');
  }

  /** The pack that `rollback` would bring back, or null. */
  function previous() {
    return openOr(readText(file(PREVIOUS)));
  }

  /** Put a pack file's text in use. Throws when it is not the owner's or cannot run here. */
  function install(fileText) {
    const content = pack.open(fileText, publicKey, appVersion);
    fs.mkdirSync(dir, { recursive: true });
    const kept = readText(file(CURRENT)) || (bundled ? readText(bundled) : '');
    // Installing the same pack again must not push the real previous one out.
    if (kept && kept !== String(fileText) && openOr(kept)) fs.writeFileSync(file(PREVIOUS), kept, 'utf8');
    fs.rmSync(file(DECLINED), { force: true });
    const temp = `${file(CURRENT)}.tmp`;
    fs.writeFileSync(temp, String(fileText), 'utf8');
    fs.renameSync(temp, file(CURRENT));
    return content;
  }

  /** Swap back to the pack that was in use before the last install. Throws when none is kept. */
  function rollback() {
    const before = readText(file(PREVIOUS));
    const content = openOr(before);
    if (!content) throw new Error('No earlier pack is kept on this computer.');
    const now = readText(file(CURRENT));
    const leaving = openOr(now);
    if (leaving) fs.writeFileSync(file(DECLINED), JSON.stringify({ version: leaving.version }), 'utf8');
    fs.writeFileSync(file(CURRENT), before, 'utf8');
    if (now) fs.writeFileSync(file(PREVIOUS), now, 'utf8');
    else fs.rmSync(file(PREVIOUS), { force: true });
    return content;
  }

  const brief = (content) => (content ? { name: content.name, version: content.version, built: content.built, phone: content.phone, workflows: Object.keys(content.workflows).length } : null);

  function view() {
    return { current: brief(current()), previous: brief(previous()) };
  }

  /**
   * Whether a pack offered by the owner's update channel is for this program: newer than the one
   * in use, and either for everyone or for this program's activation code. `offer` is the
   * channel's { version, file, only? } and `licenseId` this program's code id.
   */
  function wants(offer, licenseId) {
    if (!offer || !/^\d+\.\d+\.\d+$/.test(String(offer.version || '')) || !/^pack-\d+\.\d+\.\d+\.onetwopack$/.test(String(offer.file || ''))) return false;
    if (Array.isArray(offer.only) && offer.only.length && !offer.only.map(String).includes(String(licenseId || ''))) return false;
    let declined = '';
    try {
      declined = String(JSON.parse(readText(file(DECLINED))).version || '');
    } catch {
      // Nothing was taken back.
    }
    if (declined && !isNewer(String(offer.version), declined)) return false;
    const now = current();
    return !now || isNewer(String(offer.version), now.version);
  }

  return { current, previous, install, rollback, view, wants };
}

module.exports = { createPackStore };
