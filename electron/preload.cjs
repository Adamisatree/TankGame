/**
 * Bridges the renderer to the two things a browser cannot do: UDP discovery and
 * knowing that it is running inside the desktop app.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tankGame', {
  isDesktop: true,
  scanLan: () => ipcRenderer.invoke('lan:scan'),
});
