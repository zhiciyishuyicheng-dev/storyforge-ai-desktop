const { app, BrowserWindow, shell, ipcMain, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
// Keep the installed app's existing profile when changing its display name.
// Respect an explicitly selected userData path (for example --user-data-dir).
if (app.isPackaged) {
  const appData = app.getPath('appData');
  const defaultProfile = path.join(appData, app.getName());
  if (path.resolve(app.getPath('userData')).toLowerCase() === path.resolve(defaultProfile).toLowerCase()) {
    const existingProfile = path.join(appData, 'StoryForge AI 短剧工坊');
    fs.mkdirSync(existingProfile, { recursive: true });
    app.setPath('userData', existingProfile);
  }
}
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('url');
const { createWorkflowRunner } = require('./deepseek-workflow.cjs');
const { createDeepSeekClient } = require('./deepseek-client.cjs');
const { importSkillDocument } = require('./skill-documents.cjs');
const { normalizeSkillDocument, normalizeStageSkills } = require('./stage-skills.cjs');
const callDeepSeek = createDeepSeekClient();
const {
  getStatus: getCodexImageStatus,
  generateAndSave: generateCodexImageAndSave,
  cancel: cancelCodexImage,
  cancelAll: cancelAllCodexImages,
} = require('./codex-image.cjs');
const {
  getStatus: getCodexTextStatus,
  createSession: createCodexTextSession,
  cancel: cancelCodexText,
  cancelAll: cancelAllCodexText,
} = require('./codex-text.cjs');
const {
  DEFAULT_MODEL: SEEDREAM_DEFAULT_MODEL,
  DEFAULT_SIZE: SEEDREAM_DEFAULT_SIZE,
  KNOWN_MODELS: SEEDREAM_MODELS,
  generateAndSave: generateSeedreamAndSave,
  safeSegment,
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

require('./comfy-video-ipc.cjs').registerComfyVideo({
  ipcMain, app, safeStorage,
  assertSender: assertCodexImageSender,
  assertImagePath: (rawPath) => assertStoryForgePath(rawPath, '参考图'),
});

const MODEL = 'deepseek-flash';
// 视觉素材停用付费 API 生图，使用本机 Codex 的 ChatGPT 订阅或本地上传。
const IMAGE_MODEL_GENERATION_ENABLED = false;
const LOCAL_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

function settingsPath() { return path.join(app.getPath('userData'), 'deepseek-settings.json'); }
function seedreamSettingsPath() { return path.join(app.getPath('userData'), 'seedream-settings.json'); }
function openAIImageSettingsPath() { return path.join(app.getPath('userData'), 'openai-image-settings.json'); }
function seedanceSettingsPath() { return path.join(app.getPath('userData'), 'seedance-settings.json'); }
function codexImageSettingsPath() { return path.join(app.getPath('userData'), 'codex-image-settings.json'); }

function readCodexImageSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(codexImageSettingsPath(), 'utf8'));
    return { preferredPath: typeof saved.cliPath === 'string' ? saved.cliPath : '' };
  } catch { return { preferredPath: '' }; }
}

function assertCodexImageSender(event) {
  const expected = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  const actual = String(event.senderFrame?.url || '').split(/[?#]/)[0];
  if (actual !== expected || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('只能从 XStudio 主窗口使用订阅生图。');
  }
}

const codexImageOwners = new Map();
const workflowOwners = new Map();

function cancelWorkflowJob(job) {
  job.cancelled = true;
  if (job.provider === 'codex-subscription') cancelCodexText(job.jobId);
  job.session?.close();
}

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
    throw new Error(`只能访问 XStudio 生成的${kind}。`);
  }
  return target;
}

function uniqueLocalAssetPath(directory, baseName, extension) {
  let attempt = 0;
  let target;
  do {
    const suffix = attempt ? `-${attempt + 1}` : '';
    target = path.join(directory, `${baseName}${suffix}${extension}`);
    attempt += 1;
  } while (fs.existsSync(target));
  return target;
}

ipcMain.handle('skills:import-document', async (event, rawTask = {}) => {
  const expected = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  if (event.senderFrame !== event.sender.mainFrame || String(event.senderFrame?.url || '').split(/[?#]/)[0] !== expected) throw new Error('只能从 XStudio 主窗口上传 Skill。');
  if (!['storyboard', 'assets'].includes(rawTask?.stage)) throw new Error('请选择分镜或素材阶段上传 Skill。');
  const selection = await dialog.showOpenDialog({
    title: rawTask.stage === 'storyboard' ? '选择分镜生成 Skill 文档' : '选择视觉素材 Skill 文档',
    properties: ['openFile'],
    filters: [{ name: 'Skill 文档（TXT / Markdown / Word / PDF）', extensions: ['txt', 'md', 'docx', 'pdf'] }],
  });
  if (selection.canceled || !selection.filePaths?.length) return null;
  return normalizeSkillDocument(await importSkillDocument(selection.filePaths[0]));
});

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
  const tested = await callDeepSeek(apiKey, [{ role: 'system', content: '你只输出 JSON。' }, { role: 'user', content: '输出 {"ok":true}' }], 64);
  if (tested.truncated || tested.data?.ok !== true) throw new Error('DeepSeek 未返回有效的连接测试结果，请重试。');
  return { ok: true, model: MODEL };
});
ipcMain.handle('deepseek:generate-workflow', async (event, rawScript, rawRun = {}) => {
  const sender = event.sender;
  const frame = event.senderFrame;
  const expected = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  if (frame !== sender.mainFrame || String(frame?.url || '').split(/[?#]/)[0] !== expected) throw new Error('只能从 XStudio 主窗口生成分镜。');
  const run = rawRun && typeof rawRun === 'object' && !Array.isArray(rawRun) ? rawRun : {};
  for (const key of ['runId', 'projectId']) if (run[key] !== undefined && (typeof run[key] !== 'string' || run[key].length > 128)) throw new Error('生成任务标识无效，请重新开始。');
  if (run.autoRunToVideo !== undefined && typeof run.autoRunToVideo !== 'boolean') throw new Error('全流程自动生成开关无效，请重新设置。');
  if (run.stage !== undefined && !['outline', 'storyboard', 'assets'].includes(run.stage)) throw new Error('生成步骤无效，请重新选择。');
  for (const key of ['confirmedOutline', 'confirmedStoryboard']) {
    if (run[key] !== undefined && (!run[key] || typeof run[key] !== 'object' || Array.isArray(run[key]))) throw new Error('已确认的上一步结果无效，请重新生成并确认。');
  }
  const provider = run.provider === undefined ? 'deepseek' : run.provider;
  if (!['deepseek', 'codex-subscription'].includes(provider)) throw new Error('分镜生成方式无效，请重新选择。');
  if (run.model !== undefined && (typeof run.model !== 'string' || (run.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(run.model)))) throw new Error('分镜模型无效，请重新选择。');
  if (run.reasoningEffort !== undefined && (typeof run.reasoningEffort !== 'string' || (run.reasoningEffort && !/^[a-z]{1,32}$/.test(run.reasoningEffort)))) throw new Error('思考强度无效，请重新选择。');
  const runId = run.runId || randomUUID();
  const projectId = run.projectId || '';
  const stageSkills = normalizeStageSkills(run.stageSkills);
  const script = String(rawScript || '').trim();
  if (!script) throw new Error('剧本不能为空。');
  const ownerKey = `${sender.id}:${runId}`;
  if (workflowOwners.has(ownerKey)) throw new Error('这个分镜任务正在进行中。');
  const job = { senderId: sender.id, runId, projectId, provider, jobId: randomUUID(), cancelled: false, session: null };
  workflowOwners.set(ownerKey, job);
  const checkCancelled = () => {
    if (job.cancelled || sender.isDestroyed() || sender.mainFrame !== frame || String(frame.url || '').split(/[?#]/)[0] !== expected) {
      throw Object.assign(new Error('本次分镜生成已停止。'), { code: 'WORKFLOW_CANCELLED' });
    }
  };
  const onProgress = snapshot => {
    try {
      if (!job.cancelled && workflowOwners.get(ownerKey) === job && !sender.isDestroyed() && sender.mainFrame === frame && String(frame.url || '').split(/[?#]/)[0] === expected) frame.send('deepseek:workflow-progress', { ...snapshot, runId, projectId });
    } catch { /* A closed/navigated renderer cannot consume this task's progress. */ }
  };
  try {
    let request;
    let model = MODEL;
    let reasoningEffort = 'high';
    if (provider === 'codex-subscription') {
      job.session = await createCodexTextSession({ ...readCodexImageSettings(), jobId: job.jobId, model: run.model, reasoningEffort: run.reasoningEffort });
      checkCancelled();
      model = job.session.model;
      reasoningEffort = job.session.reasoningEffort;
      request = (messages, options) => job.session.request(messages, options);
    } else {
      const apiKey = readStoredKey();
      if (!apiKey) throw new Error('尚未配置 DeepSeek API Key。');
      request = (messages, options) => callDeepSeek(apiKey, messages, undefined, options.onProgress);
    }
    checkCancelled();
    const generateWorkflow = createWorkflowRunner({
      request: async (messages, options) => {
        checkCancelled();
        const result = await request(messages, options);
        checkCancelled();
        return result;
      },
      onProgress, provider, model, reasoningEffort,
    });
    const result = await generateWorkflow(script, { ratio: readSeedanceSettings().ratio, stageSkills, ...(run.autoRunToVideo === true ? { videoReady: true } : {}),
      ...(run.stage !== undefined ? { stage: run.stage,
        ...(run.confirmedOutline !== undefined ? { confirmedOutline: structuredClone(run.confirmedOutline) } : {}),
        ...(run.confirmedStoryboard !== undefined ? { confirmedStoryboard: structuredClone(run.confirmedStoryboard) } : {}),
      } : {}),
    });
    checkCancelled();
    return { ...result, progress: { ...result.progress, runId, projectId } };
  } finally {
    job.session?.close();
    if (workflowOwners.get(ownerKey) === job) workflowOwners.delete(ownerKey);
  }
});

ipcMain.handle('deepseek:cancel-workflow', (event, run = {}) => {
  const expected = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  if (event.senderFrame !== event.sender.mainFrame || String(event.senderFrame?.url || '').split(/[?#]/)[0] !== expected) throw new Error('只能从 XStudio 主窗口停止分镜。');
  if (!run || typeof run.runId !== 'string' || !run.runId || run.runId.length > 128 || typeof run.projectId !== 'string' || run.projectId.length > 128) throw new Error('生成任务标识无效。');
  const job = workflowOwners.get(`${event.sender.id}:${run.runId}`);
  if (!job || job.projectId !== run.projectId) return { canceled: false };
  cancelWorkflowJob(job);
  return { canceled: true };
});

ipcMain.handle('codex-text:get-status', async (event) => {
  const expected = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  if (event.senderFrame !== event.sender.mainFrame || String(event.senderFrame?.url || '').split(/[?#]/)[0] !== expected) throw new Error('只能从 XStudio 主窗口检查 GPT 分镜连接。');
  return getCodexTextStatus(readCodexImageSettings());
});

ipcMain.handle('codex-text:choose-cli', async (event) => {
  const expected = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  if (event.senderFrame !== event.sender.mainFrame || String(event.senderFrame?.url || '').split(/[?#]/)[0] !== expected) throw new Error('只能从 XStudio 主窗口配置 GPT 分镜。');
  const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '选择本机 Codex 程序（codex.exe）', properties: ['openFile'],
    filters: [{ name: 'Codex 程序', extensions: ['exe'] }],
  });
  if (selection.canceled || !selection.filePaths?.length) return { ...(await getCodexTextStatus(readCodexImageSettings())), canceled: true };
  const cliPath = selection.filePaths[0];
  if (path.basename(cliPath).toLowerCase() !== 'codex.exe') throw new Error('请选择官方 Codex 程序 codex.exe。');
  const status = await getCodexTextStatus({ preferredPath: cliPath });
  if (status.available) fs.writeFileSync(codexImageSettingsPath(), JSON.stringify({ cliPath }, null, 2), 'utf8');
  return status;
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
  if (!IMAGE_MODEL_GENERATION_ENABLED) throw new Error('付费 API 生图已暂停，请使用 GPT 订阅生图或本地参考图上传。');
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
  if (!IMAGE_MODEL_GENERATION_ENABLED) throw new Error('付费 API 生图已暂停，请使用 GPT 订阅生图或本地参考图上传。');
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
ipcMain.handle('codex-image:get-status', async (event) => {
  assertCodexImageSender(event);
  return getCodexImageStatus(readCodexImageSettings());
});
ipcMain.handle('codex-image:choose-cli', async (event) => {
  assertCodexImageSender(event);
  const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '选择本机 Codex 程序（codex.exe）',
    properties: ['openFile'],
    filters: [{ name: 'Codex 程序', extensions: ['exe'] }],
  });
  if (selection.canceled || !selection.filePaths.length) {
    return { ...(await getCodexImageStatus(readCodexImageSettings())), canceled: true };
  }
  const cliPath = selection.filePaths[0];
  if (path.basename(cliPath).toLowerCase() !== 'codex.exe') throw new Error('请选择官方 Codex 程序 codex.exe。');
  const status = await getCodexImageStatus({ preferredPath: cliPath });
  if (status.available) fs.writeFileSync(codexImageSettingsPath(), JSON.stringify({ cliPath }, null, 2), 'utf8');
  return status;
});
ipcMain.handle('codex-image:generate', async (event, rawTask) => {
  assertCodexImageSender(event);
  const jobId = String(rawTask?.jobId || '');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new Error('订阅生图任务编号无效。');
  if (codexImageOwners.has(jobId)) throw new Error('这个订阅生图任务正在进行中。');
  const prompt = String(rawTask?.prompt || '').trim();
  if (!prompt || prompt.length > 80000) throw new Error('生图描述不能为空，且不能超过 80000 字。');
  const assetSkill = normalizeSkillDocument(rawTask?.assetSkill);
  const index = Number(rawTask?.index ?? 0);
  if (!Number.isInteger(index) || index < 0 || index > 10000) throw new Error('参考图素材编号无效。');
  codexImageOwners.set(jobId, event.sender.id);
  try {
    return await generateCodexImageAndSave({
      ...readCodexImageSettings(),
      prompt,
      assetSkill,
      index,
      jobId,
      projectId: String(rawTask?.projectId || 'project'),
      projectTitle: String(rawTask?.projectTitle || '未命名短剧项目'),
      fileName: String(rawTask?.fileName || ''),
      assetName: String(rawTask?.assetName || ''),
      outputRoot: app.getPath('documents'),
    });
  } finally { codexImageOwners.delete(jobId); }
});
ipcMain.handle('codex-image:cancel', (event, rawJobId) => {
  assertCodexImageSender(event);
  const jobId = String(rawJobId || '');
  if (codexImageOwners.get(jobId) !== event.sender.id) return { canceled: false };
  return { canceled: cancelCodexImage(jobId) };
});
ipcMain.handle('assets:select-local-images', async (_event, rawTask) => {
  const selection = await dialog.showOpenDialog({
    title: `为${String(rawTask?.assetName || '当前素材')}选择参考图片`,
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '参考图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
    ],
  });
  if (selection.canceled || !selection.filePaths.length) return { canceled: true, files: [] };

  const directory = path.join(
    app.getPath('documents'),
    'StoryForge',
    safeSegment(rawTask?.projectTitle, '未命名短剧项目'),
    safeSegment(rawTask?.projectId, 'project'),
    '视觉素材',
    '本地上传',
  );
  fs.mkdirSync(directory, { recursive: true });
  const assetName = safeSegment(`${rawTask?.assetType || '参考图'}-${rawTask?.assetName || `素材${Number(rawTask?.index || 0) + 1}`}`, '参考图');
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const files = selection.filePaths.slice(0, 9).map((sourcePath, fileIndex) => {
    const extension = path.extname(sourcePath).toLowerCase();
    if (!LOCAL_IMAGE_EXTENSIONS.has(extension)) throw new Error(`不支持的参考图格式：${extension || '未知格式'}`);
    const targetPath = uniqueLocalAssetPath(directory, `${assetName}-${stamp}-${fileIndex + 1}`, extension);
    fs.copyFileSync(sourcePath, targetPath);
    return {
      localPath: targetPath,
      imageUrl: pathToFileURL(targetPath).href,
      fileName: path.basename(targetPath),
      sourceName: path.basename(sourcePath),
    };
  });
  return { canceled: false, files, outputDirectory: directory };
});
ipcMain.handle('assets:open-output', async (_event, rawPath) => {
  const target = assertStoryForgePath(rawPath, '图片目录');
  const result = await shell.openPath(target);
  if (result) throw new Error(result);
  return { ok: true };
});
ipcMain.handle('assets:show-item', (_event, rawPath) => {
  const target = assertStoryForgePath(rawPath, '参考图');
  if (!fs.existsSync(target)) throw new Error('本地参考图不存在，可能已被移动或删除。');
  shell.showItemInFolder(target);
  return { ok: true };
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
  const rawImageInputs = Array.isArray(rawTask?.imageInputs) && rawTask.imageInputs.length
    ? rawTask.imageInputs
    : Array.isArray(rawTask?.imagePaths) ? rawTask.imagePaths.map((localPath) => ({ localPath })) : [];
  if (rawImageInputs.length > 9) throw new Error('单个 Seedance 任务最多只能提交 9 张参考图。');
  const imageInputs = rawImageInputs.map((input, index) => {
    const referenceNumber = Number(input?.referenceNumber || index + 1);
    if (referenceNumber !== index + 1) throw new Error(`参考图顺序错误：请求位置 ${index + 1} 必须对应图片${index + 1}。`);
    const assetId = String(input?.assetId || '').trim().replace(/^asset:\/\//i, '');
    if (assetId) {
      if (!/^asset-[a-z0-9-]+$/i.test(assetId)) throw new Error('可信素材 Asset ID 格式无效。');
      return { assetId, localPath: '', referenceNumber };
    }
    const localPath = assertStoryForgePath(input?.localPath, '参考图');
    if (!fs.existsSync(localPath)) throw new Error(`本地参考图不存在：${path.basename(localPath)}`);
    return { assetId: '', localPath, referenceNumber };
  });
  const imagePaths = imageInputs.map((input) => input.localPath).filter(Boolean);
  for (const filePath of imagePaths) {
    if (!fs.existsSync(filePath)) throw new Error(`本地参考图不存在：${path.basename(filePath)}`);
  }
  return createSeedanceTask({
    apiKey: settings.apiKey,
    model: String(rawTask?.model || settings.model),
    prompt: String(rawTask?.prompt || ''),
    imageInputs,
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
  if (target !== allowedRoot && !target.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('只能打开 XStudio 图片目录。');
  const result = await shell.openPath(target);
  if (result) throw new Error(result);
  return { ok: true };
});
ipcMain.handle('seedream:show-item', (_event, rawPath) => {
  const target = path.resolve(String(rawPath || '').trim());
  const allowedRoot = path.resolve(app.getPath('documents'), 'StoryForge');
  if (target !== allowedRoot && !target.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('只能查看 XStudio 生成的图片。');
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
    title: 'XStudio',
    icon: path.join(__dirname, '..', 'dist', 'studio.ico'),
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

  const ownerId = win.webContents.id;
  win.webContents.once('destroyed', () => {
    for (const [jobId, senderId] of codexImageOwners) {
      if (senderId === ownerId) cancelCodexImage(jobId);
    }
    for (const job of workflowOwners.values()) {
      if (job.senderId === ownerId) cancelWorkflowJob(job);
    }
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
  if (process.platform === 'win32') app.setAppUserModelId('com.storyforge.desktop');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const job of workflowOwners.values()) cancelWorkflowJob(job);
  cancelAllCodexImages();
  cancelAllCodexText();
});
