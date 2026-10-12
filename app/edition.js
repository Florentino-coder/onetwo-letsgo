'use strict';

// One code base, two programs. The studio is the owner's: it builds workflows and signs what is
// handed out. The user program only pays, from a signed work pack it cannot change.
const path = require('node:path');

const DEVELOPER = 'Florentino356';
const NAMES = { studio: 'ADB-OneTwo', user: 'OneTwo ADB' };

/** 'user' for the program handed to other people, else 'studio'. `pkg` is the installed package.json. */
function editionOf(pkg, env = process.env) {
  const wanted = String(env.ONETWO_EDITION || (pkg && pkg.edition) || '').toLowerCase();
  return wanted === 'user' ? 'user' : 'studio';
}

function edition() {
  let pkg = null;
  try {
    pkg = require(path.join(__dirname, '..', 'package.json'));
  } catch {
    // Running from an update folder, which holds app/ only: the starter passed the edition on.
  }
  return editionOf(pkg);
}

module.exports = { edition, editionOf, DEVELOPER, NAMES };
