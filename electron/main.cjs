const { app, BrowserWindow, shell, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { SYSTEM_PROMPT, makeUserPrompt } = require('./deepseek-prompt.cjs');
const {
  DEFAULT_MODEL: SEEDREAM_DEFAULT_MODEL,
  DEFAULT_SIZE: SEEDREAM_DEFAULT_SIZE,
  KNOWN_MODELS: SEEDREAM_MODELS,
  generateAndSave: generateSeedreamAndSave,
  testConnection: testSeedreamConnection,
} = require('./seedream.cjs');
const {
  DEFAULT_MODEL: OPENAI_IMAGE_MODEL,
  DEFAULT_QUALITY: OPENAI_IMAGE_DEFAULT_QUALITY,
  DEFAULT_SIZE: OPENAI_IMAGE_DEFAULT_SIZE,
  KNOWN_QUALITIES: OPENAI_IMAGE_QUALITIES,
  KNOWN_SIZES: OPENAI_IMAGE_SIZES,
  generateAndSave: generateOpenAIImageAndSave,
  testConnection: testOpenAIImageConnection,
} = require('./gpt-image.cjs');
const {
  DEFAULT_DURATION: SEEDANCE_DEFAULT_DURATION,
  DEFAULT_MODEL: SEEDANCE_DEFAULT_MODEL,
  DEFAULT_RATIO: SEEDANCE_DEFAULT_RATIO,
  DEFAULT_RESOLUTION: SEEDANCE_DEFAULT_RESOLUTION,
  KNOWN_DURATIONS: SEEDANCE_DURATIONS,
  KNOWN_MODELS: SEEDANCE_MODELS,
  KNOWN_RATIOS: SEEDANCE_RATIOS,
  KNOWN_RESOLUTIONS: SEEDANCE_RESOLUTIONS,
  createTask: createSeedanceTask,
  downloadAndSave: downloadSeedanceAndSave,
  getTask: getSeedanceTask,
  testConnection: testSeedanceConnection,
} = require('./seedance.cjs');

const SEEDANCE_DEFAULT_GENERATION_MODE = 'batch';
const SEEDANCE_GENERATION_MODES = ['batch', 'confirm'];

const MODEL = 'deepseek-v4-pro';
const API_URL = 'https://api.deepseek.com/chat/completions';

function settingsPath() { return path.join(app.getPath('userData'), 'deepseek-settings.json'); }
function seedreamSettingsPath() { return path.join(app.getPath('userData'), 'seedream-settings.json'); }
function openAIImageSettingsPath() { return path.join(app.getPath('userData'), 'openai-image-settings.json'); }
function seedanceSettingsPath() { return path.join(app.getPath('userData'), 'seedance-settings.json'); }

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

function readSeedreamSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(seedreamSettingsPath(), 'utf8'));
    const apiKey = saved.encryptedKey && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64'))
      : '';
    return {
      apiKey,
      model: SEEDREAM_MODELS.some((item) => item.id === saved.model) ? saved.model : SEEDREAM_DEFAULT_MODEL,
      size: ['2K', '4K'].includes(saved.size) ? saved.size : SEEDREAM_DEFAULT_SIZE,
    };
  } catch {
    return { apiKey: '', model: SEEDREAM_DEFAULT_MODEL, size: SEEDREAM_DEFAULT_SIZE };
  }
}

function storeSeedreamSettings(apiKey, model, size) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境无法启用安全加密存储。');
  if (!SEEDREAM_MODELS.some((item) => item.id === model)) throw new Error('请选择受支持的 Seedream 5.0 模型。');
  if (!['2K', '4K'].includes(size)) throw new Error('请选择 2K 或 4K 图片尺寸。');
  const encryptedKey = safeStorage.encryptString(apiKey).toString('base64');
  fs.writeFileSync(seedreamSettingsPath(), JSON.stringify({ encryptedKey, model, size }, null, 2), 'utf8');
}

function readOpenAIImageSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(openAIImageSettingsPath(), 'utf8'));
    const apiKey = saved.encryptedKey && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64'))
      : '';
    return {
      apiKey,
      model: OPENAI_IMAGE_MODEL,
      size: OPENAI_IMAGE_SIZES.some((item) => item.id === saved.size) ? saved.size : OPENAI_IMAGE_DEFAULT_SIZE,
      quality: OPENAI_IMAGE_QUALITIES.some((item) => item.id === saved.quality) ? saved.quality : OPENAI_IMAGE_DEFAULT_QUALITY,
    };
  } catch {
    return { apiKey: '', model: OPENAI_IMAGE_MODEL, size: OPENAI_IMAGE_DEFAULT_SIZE, quality: OPENAI_IMAGE_DEFAULT_QUALITY };
  }
}

function storeOpenAIImageSettings(apiKey, size, quality) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境无法启用安全加密存储。');
  if (!OPENAI_IMAGE_SIZES.some((item) => item.id === size)) throw new Error('请选择受支持的 GPT Image 2 图片尺寸。');
  if (!OPENAI_IMAGE_QUALITIES.some((item) => item.id === quality)) throw new Error('请选择受支持的 GPT Image 2 图片质量。');
  const encryptedKey = safeStorage.encryptString(apiKey).toString('base64');
  fs.writeFileSync(openAIImageSettingsPath(), JSON.stringify({ encryptedKey, model: OPENAI_IMAGE_MODEL, size, quality }, null, 2), 'utf8');
}

function readSeedanceSettings() {
  const fallbackKey = readSeedreamSettings().apiKey;
  try {
    const saved = JSON.parse(fs.readFileSync(seedanceSettingsPath(), 'utf8'));
    const storedKey = saved.encryptedKey && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64'))
      : '';
    return {
      apiKey: storedKey || fallbackKey,
      inheritedKey: !storedKey && Boolean(fallbackKey),
      model: SEEDANCE_MODELS.some((item) => item.id === saved.model) ? saved.model : SEEDANCE_DEFAULT_MODEL,
      ratio: SEEDANCE_RATIOS.includes(saved.ratio) ? saved.ratio : SEEDANCE_DEFAULT_RATIO,
      resolution: SEEDANCE_RESOLUTIONS.includes(saved.resolution) ? saved.resolution : SEEDANCE_DEFAULT_RESOLUTION,
      duration: SEEDANCE_DURATIONS.includes(Number(saved.duration)) ? Number(saved.duration) : SEEDANCE_DEFAULT_DURATION,
      generationMode: SEEDANCE_GENERATION_MODES.includes(saved.generationMode) ? saved.generationMode : SEEDANCE_DEFAULT_GENERATION_MODE,
      generateAudio: saved.generateAudio !== false,
    };
  } catch {
    return {
      apiKey: fallbackKey,
      inheritedKey: Boolean(fallbackKey),
      model: SEEDANCE_DEFAULT_MODEL,
      ratio: SEEDANCE_DEFAULT_RATIO,
      resolution: SEEDANCE_DEFAULT_RESOLUTION,
      duration: SEEDANCE_DEFAULT_DURATION,
      generationMode: SEEDANCE_DEFAULT_GENERATION_MODE,
      generateAudio: true,
    };
  }
}

function storeSeedanceSettings(apiKey, model, ratio, resolution, duration, generationMode, generateAudio) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境无法启用安全加密存储。');
  if (!SEEDANCE_MODELS.some((item) => item.id === model)) throw new Error('请选择受支持的 Seedance 2.0 模型。');
  if (!SEEDANCE_RATIOS.includes(ratio)) throw new Error('请选择受支持的视频比例。');
  if (!SEEDANCE_RESOLUTIONS.includes(resolution)) throw new Error('请选择受支持的视频分辨率。');
  if (!SEEDANCE_DURATIONS.includes(Number(duration))) throw new Error('视频时长必须为 4 到 15 秒。');
  if (!SEEDANCE_GENERATION_MODES.includes(generationMode)) throw new Error('请选择受支持的视频生成方式。');
  const encryptedKey = safeStorage.encryptString(apiKey).toString('base64');
  fs.writeFileSync(seedanceSettingsPath(), JSON.stringify({
    encryptedKey,
    model,
    ratio,
    resolution,
    duration: Number(duration),
    generationMode,
    generateAudio: Boolean(generateAudio),
  }, null, 2), 'utf8');
}

function assertStoryForgePath(rawPath, kind = '文件') {
  const target = path.resolve(String(rawPath || '').trim());
  const allowedRoot = path.resolve(app.getPath('documents'), 'StoryForge');
  if (!target || (target !== allowedRoot && !target.startsWith(`${allowedRoot}${path.sep}`))) {
    throw new Error(`只能访问 StoryForge 生成的${kind}。`);
  }
  return target;
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

ipcMain.handle('seedream:get-status', () => {
  const settings = readSeedreamSettings();
  return {
    configured: Boolean(settings.apiKey),
    model: settings.model,
    size: settings.size,
    models: SEEDREAM_MODELS,
  };
});
ipcMain.handle('seedream:save-settings', (_event, rawSettings) => {
  const existing = readSeedreamSettings();
  const apiKey = String(rawSettings?.apiKey || '').trim() || existing.apiKey;
  const model = String(rawSettings?.model || SEEDREAM_DEFAULT_MODEL);
  const size = String(rawSettings?.size || SEEDREAM_DEFAULT_SIZE);
  if (!apiKey) throw new Error('请输入火山方舟 API Key。');
  storeSeedreamSettings(apiKey, model, size);
  return { configured: true, model, size, models: SEEDREAM_MODELS };
});
ipcMain.handle('seedream:test', async (_event, rawKey) => {
  const existing = readSeedreamSettings();
  const apiKey = String(rawKey || '').trim() || existing.apiKey;
  if (!apiKey) throw new Error('请先输入火山方舟 API Key。');
  await testSeedreamConnection(apiKey);
  return { ok: true };
});
ipcMain.handle('seedream:generate-image', async (_event, rawTask) => {
  const settings = readSeedreamSettings();
  if (!settings.apiKey) throw new Error('尚未配置火山方舟 API Key。');
  const model = String(rawTask?.model || settings.model);
  const size = String(rawTask?.size || settings.size);
  if (!SEEDREAM_MODELS.some((item) => item.id === model)) throw new Error('Seedream 模型不受支持。');
  if (!['2K', '4K'].includes(size)) throw new Error('图片尺寸不受支持。');
  return generateSeedreamAndSave({
    apiKey: settings.apiKey,
    model,
    size,
    prompt: String(rawTask?.prompt || ''),
    outputRoot: app.getPath('documents'),
    projectTitle: String(rawTask?.projectTitle || '未命名短剧项目'),
    projectId: String(rawTask?.projectId || 'project'),
    fileName: String(rawTask?.fileName || ''),
    index: Number(rawTask?.index || 0),
  });
});
ipcMain.handle('openai-image:get-status', () => {
  const settings = readOpenAIImageSettings();
  return {
    configured: Boolean(settings.apiKey),
    model: settings.model,
    size: settings.size,
    quality: settings.quality,
    sizes: OPENAI_IMAGE_SIZES,
    qualities: OPENAI_IMAGE_QUALITIES,
  };
});
ipcMain.handle('openai-image:save-settings', (_event, rawSettings) => {
  const existing = readOpenAIImageSettings();
  const apiKey = String(rawSettings?.apiKey || '').trim() || existing.apiKey;
  const size = String(rawSettings?.size || OPENAI_IMAGE_DEFAULT_SIZE);
  const quality = String(rawSettings?.quality || OPENAI_IMAGE_DEFAULT_QUALITY);
  if (!apiKey) throw new Error('请输入 OpenAI API Key。');
  storeOpenAIImageSettings(apiKey, size, quality);
  return { configured: true, model: OPENAI_IMAGE_MODEL, size, quality, sizes: OPENAI_IMAGE_SIZES, qualities: OPENAI_IMAGE_QUALITIES };
});
ipcMain.handle('openai-image:test', async (_event, rawKey) => {
  const existing = readOpenAIImageSettings();
  const apiKey = String(rawKey || '').trim() || existing.apiKey;
  if (!apiKey) throw new Error('请先输入 OpenAI API Key。');
  await testOpenAIImageConnection(apiKey);
  return { ok: true, model: OPENAI_IMAGE_MODEL };
});
ipcMain.handle('openai-image:generate-image', async (_event, rawTask) => {
  const settings = readOpenAIImageSettings();
  if (!settings.apiKey) throw new Error('尚未配置 OpenAI API Key。');
  const size = String(rawTask?.size || settings.size);
  const quality = String(rawTask?.quality || settings.quality);
  if (!OPENAI_IMAGE_SIZES.some((item) => item.id === size)) throw new Error('GPT Image 2 图片尺寸不受支持。');
  if (!OPENAI_IMAGE_QUALITIES.some((item) => item.id === quality)) throw new Error('GPT Image 2 图片质量不受支持。');
  return generateOpenAIImageAndSave({
    apiKey: settings.apiKey,
    size,
    quality,
    prompt: String(rawTask?.prompt || ''),
    outputRoot: app.getPath('documents'),
    projectTitle: String(rawTask?.projectTitle || '未命名短剧项目'),
    projectId: String(rawTask?.projectId || 'project'),
    fileName: String(rawTask?.fileName || ''),
    index: Number(rawTask?.index || 0),
  });
});
ipcMain.handle('seedance:get-status', () => {
  const settings = readSeedanceSettings();
  return {
    configured: Boolean(settings.apiKey),
    inheritedKey: settings.inheritedKey,
    model: settings.model,
    ratio: settings.ratio,
    resolution: settings.resolution,
    duration: settings.duration,
    generationMode: settings.generationMode,
    generateAudio: settings.generateAudio,
    models: SEEDANCE_MODELS,
    ratios: SEEDANCE_RATIOS,
    resolutions: SEEDANCE_RESOLUTIONS,
    durations: SEEDANCE_DURATIONS,
  };
});
ipcMain.handle('seedance:save-settings', (_event, rawSettings) => {
  const existing = readSeedanceSettings();
  const apiKey = String(rawSettings?.apiKey || '').trim() || existing.apiKey;
  const model = String(rawSettings?.model || SEEDANCE_DEFAULT_MODEL);
  const ratio = String(rawSettings?.ratio || SEEDANCE_DEFAULT_RATIO);
  const resolution = String(rawSettings?.resolution || SEEDANCE_DEFAULT_RESOLUTION);
  const duration = Number(rawSettings?.duration || SEEDANCE_DEFAULT_DURATION);
  const generationMode = SEEDANCE_GENERATION_MODES.includes(rawSettings?.generationMode) ? rawSettings.generationMode : SEEDANCE_DEFAULT_GENERATION_MODE;
  const generateAudio = rawSettings?.generateAudio !== false;
  if (!apiKey) throw new Error('请输入火山方舟 API Key。');
  storeSeedanceSettings(apiKey, model, ratio, resolution, duration, generationMode, generateAudio);
  return {
    configured: true,
    inheritedKey: false,
    model,
    ratio,
    resolution,
    duration,
    generationMode,
    generateAudio,
    models: SEEDANCE_MODELS,
    ratios: SEEDANCE_RATIOS,
    resolutions: SEEDANCE_RESOLUTIONS,
    durations: SEEDANCE_DURATIONS,
  };
});
ipcMain.handle('seedance:test', async (_event, rawKey) => {
  const existing = readSeedanceSettings();
  const apiKey = String(rawKey || '').trim() || existing.apiKey;
  if (!apiKey) throw new Error('请先输入火山方舟 API Key。');
  await testSeedanceConnection(apiKey);
  return { ok: true };
});
ipcMain.handle('seedance:create-task', async (_event, rawTask) => {
  const settings = readSeedanceSettings();
  if (!settings.apiKey) throw new Error('尚未配置火山方舟 API Key。');
  const imagePaths = Array.isArray(rawTask?.imagePaths)
    ? rawTask.imagePaths.slice(0, 9).map((filePath) => assertStoryForgePath(filePath, '参考图'))
    : [];
  for (const filePath of imagePaths) {
    if (!fs.existsSync(filePath)) throw new Error(`本地参考图不存在：${path.basename(filePath)}`);
  }
  return createSeedanceTask({
    apiKey: settings.apiKey,
    model: String(rawTask?.model || settings.model),
    prompt: String(rawTask?.prompt || ''),
    imagePaths,
    ratio: String(rawTask?.ratio || settings.ratio),
    resolution: String(rawTask?.resolution || settings.resolution),
    duration: Number(rawTask?.duration || settings.duration),
    generateAudio: rawTask?.generateAudio ?? settings.generateAudio,
  });
});
ipcMain.handle('seedance:get-task', async (_event, rawTaskId) => {
  const settings = readSeedanceSettings();
  if (!settings.apiKey) throw new Error('尚未配置火山方舟 API Key。');
  return getSeedanceTask(settings.apiKey, rawTaskId);
});
ipcMain.handle('seedance:download-video', async (_event, rawTask) => {
  const settings = readSeedanceSettings();
  if (!settings.apiKey) throw new Error('尚未配置火山方舟 API Key。');
  const task = await getSeedanceTask(settings.apiKey, rawTask?.taskId);
  if (!['succeeded', 'success'].includes(task.status) || !task.videoUrl) throw new Error('Seedance 视频任务尚未完成。');
  return downloadSeedanceAndSave({
    videoUrl: task.videoUrl,
    outputRoot: app.getPath('documents'),
    projectTitle: String(rawTask?.projectTitle || '未命名短剧项目'),
    projectId: String(rawTask?.projectId || 'project'),
    fileName: String(rawTask?.fileName || ''),
    index: Number(rawTask?.index || 0),
  });
});
ipcMain.handle('seedream:open-output', async (_event, rawPath) => {
  const target = path.resolve(String(rawPath || '').trim());
  if (!target) throw new Error('还没有可打开的图片目录。');
  const allowedRoot = path.resolve(app.getPath('documents'), 'StoryForge');
  if (target !== allowedRoot && !target.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('只能打开 StoryForge 图片目录。');
  const result = await shell.openPath(target);
  if (result) throw new Error(result);
  return { ok: true };
});
ipcMain.handle('seedream:show-item', (_event, rawPath) => {
  const target = path.resolve(String(rawPath || '').trim());
  const allowedRoot = path.resolve(app.getPath('documents'), 'StoryForge');
  if (target !== allowedRoot && !target.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('只能查看 StoryForge 生成的图片。');
  if (!target || !fs.existsSync(target)) throw new Error('本地图片不存在，可能已被移动或删除。');
  shell.showItemInFolder(target);
  return { ok: true };
});
ipcMain.handle('seedance:open-output', async (_event, rawPath) => {
  const target = assertStoryForgePath(rawPath, '视频目录');
  const result = await shell.openPath(target);
  if (result) throw new Error(result);
  return { ok: true };
});
ipcMain.handle('seedance:show-item', (_event, rawPath) => {
  const target = assertStoryForgePath(rawPath, '视频');
  if (!fs.existsSync(target)) throw new Error('本地视频不存在，可能已被移动或删除。');
  shell.showItemInFolder(target);
  return { ok: true };
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
