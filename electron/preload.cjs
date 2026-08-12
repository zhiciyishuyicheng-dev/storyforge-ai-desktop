const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storyforgeAI', {
  getStatus: () => ipcRenderer.invoke('deepseek:get-status'),
  saveKey: (apiKey) => ipcRenderer.invoke('deepseek:save-key', apiKey),
  testConnection: (apiKey) => ipcRenderer.invoke('deepseek:test', apiKey),
  generateWorkflow: (script) => ipcRenderer.invoke('deepseek:generate-workflow', script),
});
