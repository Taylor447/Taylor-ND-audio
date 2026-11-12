// Cầu nối giới hạn giữa giao diện và các API Electron được cho phép.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioApp', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  checkAgain: () => ipcRenderer.invoke('app:check-again'),
  applyProfile: (profile) => ipcRenderer.invoke('profile:apply', profile),
  updateAutomationPresets: (presets) => ipcRenderer.invoke('automation:set-presets', presets),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  listDevices: () => ipcRenderer.invoke('engine:list-devices'),
  startEngine: (options) => ipcRenderer.invoke('engine:start', options),
  stopEngine: () => ipcRenderer.invoke('engine:stop'),
  setEngineBypass: (bypass) => ipcRenderer.invoke('engine:set-bypass', bypass),
  loadEngineImpulse: (filePath) => ipcRenderer.invoke('engine:load-impulse', filePath),
  openSoundSettings: () => ipcRenderer.invoke('engine:open-sound-settings'),
  setAutostart: (enabled) => ipcRenderer.invoke('settings:set-autostart', enabled),
  chooseFile: (kind) => ipcRenderer.invoke('dialog:choose-file', kind),
  restartAdmin: () => ipcRenderer.invoke('app:restart-admin'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  onStatus: (callback) => ipcRenderer.on('app:status', (_event, payload) => callback(payload)),
  onEngineUpdate: (callback) => ipcRenderer.on('engine:update', (_event, payload) => callback(payload)),
  onMaximized: (callback) => ipcRenderer.on('window:maximized', (_event, value) => callback(value)),
  onWindowHidden: (callback) => ipcRenderer.on('app:window-hidden', callback)
});
