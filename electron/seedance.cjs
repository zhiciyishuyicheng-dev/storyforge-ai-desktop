const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { safeSegment } = require('./seedream.cjs');

const API_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128';
const DEFAULT_RATIO = '9:16';
const DEFAULT_RESOLUTION = '720p';
const DEFAULT_DURATION = 5;
const KNOWN_MODELS = [
  { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0' },
  { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast' },
];
const KNOWN_RATIOS = ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9', 'adaptive'];
const KNOWN_RESOLUTIONS = ['480p', '720p'];
const KNOWN_DURATIONS = Array.from({ length: 12 }, (_value, index) => index + 4);

function apiError(payload, status) {
  const message = String(payload?.error?.message || payload?.message || '').trim();
  if (/has not activated the model|model service.*not activated|not activated.*model/i.test(message)) {
    return new Error('当前火山方舟账号尚未开通所选 Seedance 2.0 模型，请先到开通管理启用视频模型。');
  }
  if (status === 401 || status === 403) return new Error(`Seedance API Key 无效或没有视频模型权限。${message ? ` ${message}` : ''}`);
  if (status === 429) return new Error('Seedance 请求过于频繁或账户额度不足，请稍后重试。');
  return new Error(message || `Seedance 请求失败（${status}）。`);
}

async function fetchJson(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Seedance 请求超时，请检查网络后重试。');
    throw new Error(`无法连接火山方舟 Seedance：${error?.message || '网络请求失败'}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`火山方舟返回了无法解析的响应（${response.status}）。`); }
  if (!response.ok) throw apiError(payload, response.status);
  return payload;
}

async function testConnection(apiKey) {
  await fetchJson(`${API_BASE}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }, 30000);
  return true;
}

function imageDataUrl(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
  };
  const mimeType = mimeTypes[extension];
  if (!mimeType) throw new Error(`Seedance 不支持参考图格式：${extension || '未知格式'}。`);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('参考图路径不是文件。');
  if (stat.size > 30 * 1024 * 1024) throw new Error(`参考图 ${path.basename(filePath)} 超过 30 MB。`);
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function validateOptions({ model, ratio, resolution, duration }) {
  if (!KNOWN_MODELS.some((item) => item.id === model)) throw new Error('请选择受支持的 Seedance 2.0 模型。');
  if (!KNOWN_RATIOS.includes(ratio)) throw new Error('Seedance 视频比例不受支持。');
  if (!KNOWN_RESOLUTIONS.includes(resolution)) throw new Error('Seedance 视频分辨率不受支持。');
  if (!KNOWN_DURATIONS.includes(Number(duration))) throw new Error('Seedance 视频时长必须为 4 到 15 秒。');
}

function normalizeTrustedAssetId(value) {
  return String(value || '').trim().replace(/^asset:\/\//i, '');
}

async function createTask({ apiKey, model, prompt, imageInputs = [], imagePaths = [], ratio, resolution, duration, generateAudio = true }) {
  const normalized = {
    model: model || DEFAULT_MODEL,
    ratio: ratio || DEFAULT_RATIO,
    resolution: resolution || DEFAULT_RESOLUTION,
    duration: Number(duration || DEFAULT_DURATION),
  };
  validateOptions(normalized);
  const text = String(prompt || '').trim();
  if (!text) throw new Error('视频提示词不能为空。');
  const requestedInputs = Array.isArray(imageInputs) && imageInputs.length
    ? imageInputs
    : imagePaths.map((localPath) => ({ localPath }));
  if (requestedInputs.length > 9) throw new Error('单个 Seedance 任务最多只能提交 9 张参考图。');
  const orderedImages = [];
  for (let index = 0; index < requestedInputs.length; index += 1) {
    const input = requestedInputs[index];
    const assetId = normalizeTrustedAssetId(input?.assetId);
    const localPath = String(input?.localPath || '').trim();
    if (assetId && !/^asset-[a-z0-9-]+$/i.test(assetId)) throw new Error('可信素材 Asset ID 格式无效。');
    if (!assetId && !localPath) throw new Error(`图片${index + 1}没有可提交的本地文件或可信素材。`);
    orderedImages.push({ assetId, localPath });
  }
  const content = [{ type: 'text', text }];
  for (const input of orderedImages) {
    content.push({
      type: 'image_url',
      image_url: { url: input.assetId ? `asset://${input.assetId}` : imageDataUrl(input.localPath) },
      role: 'reference_image',
    });
  }
  const payload = await fetchJson(`${API_BASE}/contents/generations/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: normalized.model,
      content,
      generate_audio: Boolean(generateAudio),
      resolution: normalized.resolution,
      ratio: normalized.ratio,
      duration: normalized.duration,
      watermark: false,
    }),
  }, 120000);
  if (!payload?.id) throw new Error('Seedance 没有返回任务 ID，请重试。');
  return {
    id: payload.id,
    model: payload.model || normalized.model,
    status: payload.status || 'queued',
    createdAt: payload.created_at || null,
  };
}

async function getTask(apiKey, taskId) {
  const id = String(taskId || '').trim();
  if (!/^cgt-[a-z0-9-]+$/i.test(id)) throw new Error('Seedance 任务 ID 无效。');
  const payload = await fetchJson(`${API_BASE}/contents/generations/tasks/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }, 30000);
  return {
    id: payload.id || id,
    model: payload.model || '',
    status: payload.status || 'queued',
    error: String(payload.error?.message || (typeof payload.error === 'string' ? payload.error : '') || ''),
    videoUrl: payload.content?.video_url || '',
    lastFrameUrl: payload.content?.last_frame_url || '',
    usage: payload.usage || null,
    resolution: payload.resolution || '',
    ratio: payload.ratio || '',
    duration: payload.duration || null,
    framesPerSecond: payload.framespersecond || null,
    createdAt: payload.created_at || null,
    updatedAt: payload.updated_at || null,
  };
}

function normalizeVideoFileName(value, index = 0) {
  const original = safeSegment(value, `镜头-${String(index + 1).padStart(2, '0')}.mp4`);
  const extension = path.extname(original).toLowerCase();
  const base = extension ? original.slice(0, -extension.length) : original;
  return `${safeSegment(base, `镜头-${String(index + 1).padStart(2, '0')}`)}.mp4`;
}

async function downloadAndSave({ videoUrl, outputRoot, projectTitle, projectId, fileName, index }) {
  const url = String(videoUrl || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('Seedance 没有返回可下载的视频地址。');
  const directory = path.join(
    outputRoot,
    'StoryForge',
    safeSegment(projectTitle, '未命名短剧项目'),
    safeSegment(projectId, 'project'),
    '视频片段',
  );
  fs.mkdirSync(directory, { recursive: true });
  const requestedName = normalizeVideoFileName(fileName, index);
  const temporary = path.join(directory, `.storyforge-video-${randomUUID()}.tmp`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  let targetPath;
  let savedName;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`下载 Seedance 视频失败（${response.status}）。`);
    if (response.body) {
      const input = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
      await pipeline(input, fs.createWriteStream(temporary, { flags: 'wx' }), { signal: controller.signal });
    } else {
      // Support providers/mocks that expose a body only as an ArrayBuffer.
      await fs.promises.writeFile(temporary, Buffer.from(await response.arrayBuffer()), { flag: 'wx', signal: controller.signal });
    }
    const stat = await fs.promises.stat(temporary);
    if (!stat.size) throw new Error('Seedance 返回了空视频，请重试。');
    const base = requestedName.slice(0, -4);
    let version = 1;
    // Exclusive reservations make simultaneous completions choose different
    // names. Publish only a complete download; historical files are never opened
    // for writing or overwritten by a later generation.
    while (true) {
      savedName = version === 1 ? requestedName : `${base}-v${version}.mp4`;
      targetPath = path.join(directory, savedName);
      let reservation;
      try { reservation = await fs.promises.open(targetPath, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') { version += 1; continue; } throw error; }
      await reservation.close();
      try { await fs.promises.rename(temporary, targetPath); }
      catch (error) { await fs.promises.unlink(targetPath).catch(() => {}); throw error; }
      break;
    }
  }
  catch (error) {
    if (error?.name === 'AbortError') throw new Error('下载 Seedance 视频超时，请重试。');
    if (/^下载 Seedance 视频失败|空视频/.test(error?.message || '')) throw error;
    throw new Error(`下载 Seedance 视频失败：${error?.message || '网络请求失败'}`);
  } finally {
    clearTimeout(timeout);
    await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return {
    localPath: targetPath,
    videoFileUrl: pathToFileURL(targetPath).href,
    fileName: savedName,
    outputDirectory: directory,
  };
}

module.exports = {
  API_BASE,
  DEFAULT_DURATION,
  DEFAULT_MODEL,
  DEFAULT_RATIO,
  DEFAULT_RESOLUTION,
  KNOWN_DURATIONS,
  KNOWN_MODELS,
  KNOWN_RATIOS,
  KNOWN_RESOLUTIONS,
  createTask,
  downloadAndSave,
  getTask,
  imageDataUrl,
  normalizeVideoFileName,
  testConnection,
};
