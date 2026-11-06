const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fluentaDesktop', {
  platform: process.platform,
  electron: process.versions.electron,
  getServerUrl: () => ipcRenderer.invoke('fluenta:get-server-url'),
  setServerUrl: (url) => ipcRenderer.invoke('fluenta:set-server-url', url),
  resetServerUrl: () => ipcRenderer.invoke('fluenta:reset-server-url'),
});
