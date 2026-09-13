'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thaiasiaUpdater', {
  getSettings: () => ipcRenderer.invoke('thaiasia-updater:get-settings'),
  saveSettings: (input) => ipcRenderer.invoke('thaiasia-updater:save-settings', input),
  checkNow: () => ipcRenderer.invoke('thaiasia-updater:check-now'),
  installNow: () => ipcRenderer.invoke('thaiasia-updater:install-now'),
  onStatus: (callback) => ipcRenderer.on('thaiasia-updater:status-changed', (_, status) => callback(status))
});

