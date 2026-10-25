/**
 * Bridges the renderer to the two things a browser cannot do: UDP discovery and
 * knowing that it is running inside the desktop app.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tankGame', {
  isDesktop: true,
  scanLan: () => ipcRenderer.invoke('lan:scan'),
  update: {
    info: () => ipcRenderer.invoke('update:info'),
    check: (options) => ipcRenderer.invoke('update:check', options),
    probeMirrors: () => ipcRenderer.invoke('update:probe'),
    download: (payload) => ipcRenderer.invoke('update:download', payload),
    install: (options) => ipcRenderer.invoke('update:install', options),
    localVersions: () => ipcRenderer.invoke('update:local'),
    installFile: (payload) => ipcRenderer.invoke('update:install-file', payload),
    reveal: (filePath) => ipcRenderer.invoke('update:reveal', filePath),
    saveSettings: (patch) => ipcRenderer.invoke('update:settings', patch),
    openRelease: (version) => ipcRenderer.invoke('update:open-release', version),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    },
    onProbe: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('update:probe-progress', listener);
      return () => ipcRenderer.removeListener('update:probe-progress', listener);
    },
    onAvailable: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('update:available', listener);
      return () => ipcRenderer.removeListener('update:available', listener);
    },
  },
});
