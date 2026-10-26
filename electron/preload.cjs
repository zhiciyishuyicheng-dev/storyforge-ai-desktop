const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storyforgeAI', {
  getStatus: () => ipcRenderer.invoke('deepseek:get-status'),
  saveKey: (apiKey) => ipcRenderer.invoke('deepseek:save-key', apiKey),
  testConnection: (apiKey) => ipcRenderer.invoke('deepseek:test', apiKey),
  generateWorkflow: (script, run = {}) => ipcRenderer.invoke('deepseek:generate-workflow', script, { runId: run.runId, projectId: run.projectId, stageSkills: run.stageSkills, autoRunToVideo: run.autoRunToVideo, provider: run.provider, model: run.model, reasoningEffort: run.reasoningEffort, stage: run.stage, confirmedOutline: run.confirmedOutline, confirmedStoryboard: run.confirmedStoryboard }),
  cancelWorkflow: (run = {}) => ipcRenderer.invoke('deepseek:cancel-workflow', { runId: run.runId, projectId: run.projectId }),
  getCodexTextStatus: () => ipcRenderer.invoke('codex-text:get-status'),
  chooseCodexTextCli: () => ipcRenderer.invoke('codex-text:choose-cli'),
  importSkillDocument: (task = {}) => ipcRenderer.invoke('skills:import-document', { stage: task.stage }),
  onWorkflowProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('deepseek:workflow-progress', listener);
    return () => ipcRenderer.removeListener('deepseek:workflow-progress', listener);
  },
  getSeedreamStatus: () => ipcRenderer.invoke('seedream:get-status'),
  saveSeedreamSettings: (settings) => ipcRenderer.invoke('seedream:save-settings', settings),
  testSeedreamConnection: (apiKey) => ipcRenderer.invoke('seedream:test', apiKey),
  generateSeedreamImage: (task) => ipcRenderer.invoke('seedream:generate-image', task),
  getOpenAIImageStatus: () => ipcRenderer.invoke('openai-image:get-status'),
  saveOpenAIImageSettings: (settings) => ipcRenderer.invoke('openai-image:save-settings', settings),
  testOpenAIImageConnection: (apiKey) => ipcRenderer.invoke('openai-image:test', apiKey),
  generateOpenAIImage: (task) => ipcRenderer.invoke('openai-image:generate-image', task),
  getCodexImageStatus: () => ipcRenderer.invoke('codex-image:get-status'),
  chooseCodexImageCli: () => ipcRenderer.invoke('codex-image:choose-cli'),
  generateCodexImage: (task) => ipcRenderer.invoke('codex-image:generate', task),
  cancelCodexImage: (jobId) => ipcRenderer.invoke('codex-image:cancel', jobId),
  selectLocalAssetImages: (task) => ipcRenderer.invoke('assets:select-local-images', task),
  openLocalAssetOutput: (directory) => ipcRenderer.invoke('assets:open-output', directory),
  showLocalAssetImage: (filePath) => ipcRenderer.invoke('assets:show-item', filePath),
  getSeedanceStatus: () => ipcRenderer.invoke('seedance:get-status'),
  getComfyVideoStatus: () => ipcRenderer.invoke('comfy-video:get-status'),
  saveComfyVideoSettings: (settings) => ipcRenderer.invoke('comfy-video:save-settings', settings),
  testComfyVideoConnection: (settings) => ipcRenderer.invoke('comfy-video:test', settings),
  createComfyVideoTask: (task) => ipcRenderer.invoke('comfy-video:create-task', task),
  getComfyVideoTask: (taskId) => ipcRenderer.invoke('comfy-video:get-task', taskId),
  downloadComfyVideo: (task) => ipcRenderer.invoke('comfy-video:download-video', task),
  saveSeedanceSettings: (settings) => ipcRenderer.invoke('seedance:save-settings', settings),
  testSeedanceConnection: (apiKey) => ipcRenderer.invoke('seedance:test', apiKey),
  createSeedanceTask: (task) => ipcRenderer.invoke('seedance:create-task', task),
  getSeedanceTask: (taskId) => ipcRenderer.invoke('seedance:get-task', taskId),
  downloadSeedanceVideo: (task) => ipcRenderer.invoke('seedance:download-video', task),
  openSeedanceOutput: (directory) => ipcRenderer.invoke('seedance:open-output', directory),
  showSeedanceVideo: (filePath) => ipcRenderer.invoke('seedance:show-item', filePath),
  openSeedreamOutput: (directory) => ipcRenderer.invoke('seedream:open-output', directory),
  showSeedreamImage: (filePath) => ipcRenderer.invoke('seedream:show-item', filePath),
});
