'use strict';

// Starts the newest app code: a signed update unpacked in the data folder, or the installed copy.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { isNewer } = require('./version.js');
const { edition } = require('./edition.js');

// Which of the two programs this is. Passed on, because an update folder holds app/ only.
const EDITION = edition();
process.env.ONETWO_EDITION = EDITION;

// Dev runs keep data beside the code, where the Python app kept it. Installed builds use userData.
// Resolved here, not in main.js, because main.js may be running from an update folder.
const dataDir = process.env.FARM_DATA_DIR
  || (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..', EDITION === 'user' ? 'user-data' : ''));
process.env.FARM_DATA_DIR = dataDir;
// A development run of the user program keeps its window profile apart from the studio's, so both can be open.
if (!app.isPackaged && EDITION === 'user' && !app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(dataDir, 'profile'));
// Installed copies only: with this ID a development run shows the Electron icon on the taskbar.
if (app.isPackaged) app.setAppUserModelId('com.adbonetwo.app');

const installed = require('../package.json').version;
const updatesDir = path.join(dataDir, 'installed-updates');
const pointer = path.join(updatesDir, 'current.json');

process.env.FARM_VERSION = installed;

let entry = './main.js';
try {
  const { version } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  const candidate = path.join(updatesDir, version, 'app', 'main.js');
  if (isNewer(version, installed) && fs.existsSync(candidate)) {
    entry = candidate;
    process.env.FARM_VERSION = version;
  }
} catch {
  // No update installed.
}

try {
  require(entry);
} catch (error) {
  if (entry === './main.js') throw error;
  // A broken update must not lock the user out: drop it and start the installed copy.
  fs.rmSync(pointer, { force: true });
  app.relaunch();
  app.exit(0);
}
