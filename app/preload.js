'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CALLS = [
  'state:get', 'devices:scan', 'adb:restart', 'config:set', 'tool:locate',
  'device:meta', 'device:group', 'device:action', 'thumbs:refresh',
  'live:open', 'live:close', 'live:default',
  'apps:list', 'apps:info', 'apk:library', 'apk:choose',
  'policy:detect', 'policy:save', 'policy:delete',
  'workflow:save', 'workflow:delete', 'workflow:preview', 'workflow:run',
  'folder:open', 'update:check', 'update:restart',
];
const EVENTS = ['log', 'devices', 'thumb', 'job', 'status', 'update'];

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
