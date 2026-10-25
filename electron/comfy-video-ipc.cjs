const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, normalizeSettings, createService } = require('./comfy-video.cjs');

function registerComfyVideo({ ipcMain, app, safeStorage, assertSender, assertImagePath }) {
  const settingsPath = () => path.join(app.getPath('userData'), 'comfy-video-settings.json');
  function readSettings() {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      const credentials = saved.encryptedConnection && safeStorage.isEncryptionAvailable()
        ? JSON.parse(safeStorage.decryptString(Buffer.from(saved.encryptedConnection, 'base64'))) : {};
      return { ...DEFAULTS, ...saved.options, ...credentials };
    } catch { return { ...DEFAULTS }; }
  }
  function publicSettings(settings = readSettings()) {
    const { token, ...visible } = settings;
    return { ...visible, tokenConfigured: Boolean(token), configured: Boolean(settings.baseUrl) };
  }
  function draft(raw = {}) {
    const saved = readSettings();
    return normalizeSettings({ ...saved, ...raw, token: raw.clearToken ? '' : String(raw.token || '').trim() || saved.token });
  }
  const service = createService({ readSettings, jobsPath: path.join(app.getPath('userData'), 'comfy-video-jobs.json'), outputRoot: app.getPath('documents'), assertImagePath });
  const handle = (name, callback) => ipcMain.handle(`comfy-video:${name}`, (event, value) => { assertSender(event); return callback(value); });
  handle('get-status', () => publicSettings());
  handle('save-settings', raw => {
    const settings = draft(raw);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境无法启用安全加密存储。');
    const { baseUrl, token, ...options } = settings;
    const encryptedConnection = safeStorage.encryptString(JSON.stringify({ baseUrl, token })).toString('base64');
    fs.writeFileSync(settingsPath(), JSON.stringify({ options, encryptedConnection }, null, 2), 'utf8');
    return publicSettings(settings);
  });
  handle('test', raw => service.test(draft(raw)));
  handle('create-task', task => service.createTask(task));
  handle('get-task', id => service.getTask(id));
  handle('download-video', task => service.download(task));
}

module.exports = { registerComfyVideo };
