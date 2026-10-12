'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_NAME = 'farm_manager_config.json';
const DEVICE_STATE_NAME = 'farm_manager_devices.json';
const EVENT_LOG_NAME = 'farm_manager_events.jsonl';

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

/** Write to a temp file and rename, so a crash mid-write never leaves a half-written JSON file. */
function writeJson(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(sortKeys(data), null, 2), 'utf8');
  fs.renameSync(temp, file);
}

// Sorted keys keep the files diff-friendly and match what the Python app wrote.
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
    this.configFile = path.join(baseDir, CONFIG_NAME);
    this.stateFile = path.join(baseDir, DEVICE_STATE_NAME);
    this.eventFile = path.join(baseDir, EVENT_LOG_NAME);
    this.config = readJson(this.configFile, {});
    this.state = readJson(this.stateFile, {});
    for (const key of ['devices', 'workflows', 'points', 'pick_sets', 'policies', 'group_live_profiles']) {
      if (!this.state[key] || typeof this.state[key] !== 'object') this.state[key] = {};
    }
  }

  saveConfig() {
    writeJson(this.configFile, this.config);
  }

  saveState() {
    writeJson(this.stateFile, this.state);
  }

  appendEvent(event) {
    try {
      fs.appendFileSync(this.eventFile, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // The event log is best effort; never let it break an action.
    }
  }

  dir(name) {
    const full = path.join(this.baseDir, name);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }
}

module.exports = { Store };
