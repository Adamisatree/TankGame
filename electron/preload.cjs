/**
 * Bridges the renderer to the two things a browser cannot do: UDP discovery and
 * knowing that it is running inside the desktop app.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tankGame', {
  isDesktop: true,
  scanLan: () => ipcRenderer.invoke('lan:scan'),
  /**
   * v1.6.4: the renderer cannot write files, and a crash report needs one. Both
   * channels are one-way and length-clipped: nothing here can be used to push a
   * file path or a big payload at the main process.
   */
  log: {
    write: (entry) => {
      const item = entry && typeof entry === 'object' ? entry : {};
      ipcRenderer.send('log:write', {
        level: String(item.level ?? 'error').slice(0, 16),
        source: String(item.source ?? 'renderer').slice(0, 64),
        message: String(item.message ?? '').slice(0, 2000),
        stack: String(item.stack ?? '').slice(0, 8000),
      });
    },
    heartbeat: (state) => ipcRenderer.send('log:heartbeat', String(state ?? '').slice(0, 300)),
    folder: () => ipcRenderer.invoke('log:path'),
    reveal: () => ipcRenderer.invoke('log:reveal'),
  },
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
