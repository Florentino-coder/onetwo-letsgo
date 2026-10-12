'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CALLS = [
  'state:get', 'devices:scan', 'adb:restart', 'config:set', 'tool:locate',
  'device:meta', 'device:pin', 'device:range', 'device:pay', 'device:account', 'device:pin-show', 'device:group', 'device:action', 'thumbs:refresh',
  'live:open', 'live:close', 'live:default',
  'apps:list', 'apps:info', 'apk:library', 'apk:choose',
  'policy:detect', 'policy:save', 'policy:delete',
  'workflow:save', 'workflow:delete', 'workflow:preview', 'workflow:run', 'workflow:record',
  'point:save', 'point:delete', 'pick:save', 'pick:edit', 'pick:rename', 'pick:delete', 'pick:scroll', 'pick:goto', 'touch:start', 'touch:stop', 'api:token',
  'jobs:set', 'jobs:open', 'jobs:pick', 'jobs:record', 'jobs:clear','jobs:read', 'jobs:run', 'jobs:auto', 'jobs:screen', 'jobs:orders', 'jobs:pay', 'jobs:payauto', 'jobs:unhalt', 'jobs:resolve',
  'folder:open', 'update:check', 'update:restart',
  'handout:view', 'handout:issue', 'handout:cancel', 'handout:pack', 'handout:release',
  'license:set', 'pack:import', 'pack:rollback', 'user:setup', 'user:signed',
  'slip:view', 'history:search', 'report:save', 'telegram:set', 'telegram:test', 'user:prefs',
];
const EVENTS = ['log', 'devices', 'thumb', 'job', 'status', 'update', 'timeline', 'touch', 'jobs', 'state', 'alert'];

contextBridge.exposeInMainWorld('farm', {
  call(channel, payload) {
    if (!CALLS.includes(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, listener) {
    if (!EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (_event, payload) => listener(payload));
  },
});
