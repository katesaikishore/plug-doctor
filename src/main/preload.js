'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the page and the system. The page can ask for
 * things by name; it can never pass a command to run. Fixes are referenced
 * by device and plan ID and looked up again in the main process.
 */
const on = (channel) => (fn) => {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('plugDoctor', {
  platform: process.platform,
  listDevices: () => ipcRenderer.invoke('devices:list'),
  diagnose: (deviceId) => ipcRenderer.invoke('devices:diagnose', deviceId),
  runFix: (deviceId, planId) => ipcRenderer.invoke('fix:run', deviceId, planId),
  manualDone: (token, done) => ipcRenderer.invoke('fix:manual-done', token, done),
  report: (deviceId) => ipcRenderer.invoke('report:get', deviceId),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  askAssistant: (text, deviceId) => ipcRenderer.invoke('assistant:send', text, deviceId),
  stopAssistant: () => ipcRenderer.invoke('assistant:stop'),
  stopFix: (deviceId) => ipcRenderer.invoke('fix:stop', deviceId),
  resetAssistant: () => ipcRenderer.invoke('assistant:reset'),
  answerApproval: (token, approved) => ipcRenderer.invoke('approval:respond', token, approved),
  quit: () => ipcRenderer.invoke('app:quit'),
  onDevices: on('devices'),
  onDiagnosis: on('diagnosis'),
  onFixProgress: on('fix-progress'),
  onAssistant: on('assistant'),
  onApprovalRequest: on('approval-request'),
  onNavigate: on('navigate'),
});
