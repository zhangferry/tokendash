const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openDashboard(url) {
    return ipcRenderer.invoke('tokendash:open-dashboard', url);
  },
  getAppInfo() {
    return ipcRenderer.invoke('tokendash:get-app-info');
  },
  setLaunchAtLogin(enabled) {
    return ipcRenderer.invoke('tokendash:set-launch-at-login', enabled);
  },
  checkForUpdates() {
    return ipcRenderer.invoke('tokendash:check-for-updates');
  },
  downloadUpdate(updateInfo) {
    return ipcRenderer.invoke('tokendash:download-update', updateInfo);
  },
  onUpdateDownloadProgress(callback) {
    if (typeof callback !== 'function') return function noop() {};
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('tokendash:update-download-progress', listener);
    return function unsubscribe() {
      ipcRenderer.removeListener('tokendash:update-download-progress', listener);
    };
  },
  quitApp() {
    return ipcRenderer.invoke('tokendash:quit');
  },
  setSelectedAgents(agents) {
    return ipcRenderer.invoke('tokendash:set-selected-agents', agents);
  },
  updateTraySnapshot(snapshot) {
    return ipcRenderer.invoke('tokendash:update-tray-snapshot', snapshot);
  },
});
