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
