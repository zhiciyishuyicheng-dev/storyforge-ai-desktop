const { app, BrowserWindow, shell, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { SYSTEM_PROMPT, makeUserPrompt } = require('./deepseek-prompt.cjs');

const MODEL = 'deepseek-v4-pro';
const API_URL = 'https://api.deepseek.com/chat/completions';

function settingsPath() { return path.join(app.getPath('userData'), 'deepseek-settings.json'); }

function readStoredKey() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (!saved.encryptedKey || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64'));
  } catch { return ''; }
}

function storeKey(apiKey) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境无法启用安全加密存储。');
  const encryptedKey = safeStorage.encryptString(apiKey).toString('base64');
  fs.writeFileSync(settingsPath(), JSON.stringify({ encryptedKey, model: MODEL }, null, 2), 'utf8');
}

async function callDeepSeek(apiKey, messages, maxTokens = 24000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, messages, response_format: { type: 'json_object' }, temperature: 0.35, max_tokens: maxTokens, stream: false }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('DeepSeek 请求超过五分钟，请检查网络后重试。');
    throw new Error(`无法连接 DeepSeek：${error?.message || '网络请求失败'}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`DeepSeek 返回了无法解析的响应（${response.status}）。`); }
  if (!response.ok) throw new Error(payload?.error?.message || `DeepSeek 请求失败（${response.status}）。`);
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 没有返回生成内容，请重试。');
  let data;
  try { data = JSON.parse(content); } catch { throw new Error('DeepSeek 返回的内容不是有效 JSON，请重试。'); }
  if (messages.some((message) => message.content?.includes('原始剧本'))) validateWorkflow(data);
  return { data, usage: payload.usage || null, model: payload.model || MODEL };
}

function validateWorkflow(data) {
  const characters = data?.analysis?.characters;
  const scenes = data?.script?.scenes;
  const shots = data?.storyboard?.shots;
  const assets = data?.assets;
  if (!Array.isArray(characters) || !characters.length) throw new Error('DeepSeek 未返回有效人物列表，请重试。');
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('DeepSeek 未返回有效剧本场次，请重试。');
  if (!Array.isArray(shots) || shots.length < 3) throw new Error('DeepSeek 返回的分镜数量不足，请重试。');
  for (const shot of shots) {
    if (!Array.isArray(shot.uploads) || !shot.uploads.length || !Array.isArray(shot.segments) || !shot.segments.length || !shot.prompt) throw new Error(`镜头 ${shot.no || ''} 数据不完整，请重试。`);
    const withoutRefs = String(shot.prompt).replace(/@(Image|Video|Audio)\d+/g, '');
    if (/[A-Za-z]{2,}/.test(withoutRefs)) throw new Error(`镜头 ${shot.no || ''} 含有中英文混排，已拒绝本次结果，请重新生成。`);
  }
  if (!assets?.overviewBoard?.prompt) throw new Error('DeepSeek 未返回九宫格制作参考板提示词，请重试。');
  if (!Array.isArray(assets.characterChecklist) || !assets.characterChecklist.length) throw new Error('DeepSeek 未返回人物三视图生成清单，请重试。');
  if (!Array.isArray(assets.characterDifferenceMatrix) || !assets.characterDifferenceMatrix.length) throw new Error('DeepSeek 未返回人物差异化视觉锚点矩阵，请重试。');
  if (!Array.isArray(assets.characters) || assets.characters.some((item) => !item.name || !item.fileName || !item.prompt)) throw new Error('DeepSeek 返回的人物参考图提示词不完整，请重试。');
  const requiredCharacters = assets.characterChecklist.filter((item) => item.requiresTurnaround).map((item) => String(item.name || '').trim()).filter(Boolean);
  const renderedCharacters = new Set(assets.characters.map((item) => String(item.name || '').trim()));
  if (requiredCharacters.some((name) => !renderedCharacters.has(name))) throw new Error('DeepSeek 漏掉了需要单独三视图的重要人物，请重试。');
  if (!Array.isArray(assets.scenes) || !assets.scenes.length || assets.scenes.some((item) => !item.name || !item.fileName || !item.prompt)) throw new Error('DeepSeek 返回的场景参考图提示词不完整，请重试。');
  if (!Array.isArray(assets.props) || assets.props.some((item) => !item.name || !item.fileName || !item.prompt)) throw new Error('DeepSeek 返回的道具参考图提示词不完整，请重试。');
}

ipcMain.handle('deepseek:get-status', () => ({ configured: Boolean(readStoredKey()), model: MODEL }));
ipcMain.handle('deepseek:save-key', (_event, rawKey) => {
  const apiKey = String(rawKey || '').trim();
  if (!apiKey) throw new Error('请输入 DeepSeek API Key。');
  storeKey(apiKey);
  return { configured: true, model: MODEL };
});
ipcMain.handle('deepseek:test', async (_event, rawKey) => {
  const apiKey = String(rawKey || '').trim() || readStoredKey();
  if (!apiKey) throw new Error('请先输入 DeepSeek API Key。');
  await callDeepSeek(apiKey, [{ role: 'system', content: '你只输出 JSON。' }, { role: 'user', content: '输出 {"ok":true}' }], 64);
  return { ok: true, model: MODEL };
});
ipcMain.handle('deepseek:generate-workflow', async (_event, rawScript) => {
  const apiKey = readStoredKey();
  if (!apiKey) throw new Error('尚未配置 DeepSeek API Key。');
  const script = String(rawScript || '').trim();
  if (!script) throw new Error('剧本不能为空。');
  return callDeepSeek(apiKey, [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: makeUserPrompt(script) }]);
});

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: 'StoryForge AI 短剧工坊',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setZoomFactor(1.05);
  win.webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return;
    const current = win.webContents.getZoomFactor();
    if (input.key === '+' || input.key === '=') {
      win.webContents.setZoomFactor(Math.min(1.6, current + 0.1));
      event.preventDefault();
    } else if (input.key === '-') {
      win.webContents.setZoomFactor(Math.max(0.8, current - 0.1));
      event.preventDefault();
    } else if (input.key === '0') {
      win.webContents.setZoomFactor(1.05);
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
};

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
