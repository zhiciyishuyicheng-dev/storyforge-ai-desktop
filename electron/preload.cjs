const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storyforgeAI', {
  getStatus: () => ipcRenderer.invoke('deepseek:get-status'),
  saveKey: (apiKey) => ipcRenderer.invoke('deepseek:save-key', apiKey),
  testConnection: (apiKey) => ipcRenderer.invoke('deepseek:test', apiKey),
  generateWorkflow: (script) => ipcRenderer.invoke('deepseek:generate-workflow', script),
  getSeedreamStatus: () => ipcRenderer.invoke('seedream:get-status'),
  saveSeedreamSettings: (settings) => ipcRenderer.invoke('seedream:save-settings', settings),
  testSeedreamConnection: (apiKey) => ipcRenderer.invoke('seedream:test', apiKey),
  generateSeedreamImage: (task) => ipcRenderer.invoke('seedream:generate-image', task),
  openSeedreamOutput: (directory) => ipcRenderer.invoke('seedream:open-output', directory),
  showSeedreamImage: (filePath) => ipcRenderer.invoke('seedream:show-item', filePath),
});
