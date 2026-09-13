
const { contextBridge, ipcRenderer } = require('electron');
// Expose both app info and ipcRenderer for custom window opening
contextBridge.exposeInMainWorld('electronAppInfo', {
  getInfo: () => ipcRenderer.invoke('get-app-info')
});
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    send: (...args) => ipcRenderer.send(...args),
    on: (...args) => ipcRenderer.on(...args),
    invoke: (...args) => ipcRenderer.invoke(...args)
  }
});
