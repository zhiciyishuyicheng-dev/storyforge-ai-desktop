const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const API_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedream-5-0-lite-260128';
const DEFAULT_SIZE = '2K';
const KNOWN_MODELS = [
  { id: 'doubao-seedream-5-0-lite-260128', label: 'Seedream 5.0 Lite', pricePerImage: 0.22 },
  { id: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0 正式版', pricePerImage: null },
];

function safeSegment(value, fallback = '未命名') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

function normalizeFileName(value, index = 0) {
  const original = safeSegment(value, `参考图-${String(index + 1).padStart(2, '0')}.png`);
  const extension = path.extname(original).toLowerCase();
  const base = extension ? original.slice(0, -extension.length) : original;
  return `${safeSegment(base, `参考图-${String(index + 1).padStart(2, '0')}`)}.png`;
}

function apiError(payload, status) {
  const message = payload?.error?.message || payload?.message;
  if (/has not activated the model|model service.*not activated|not activated.*model/i.test(String(message || ''))) {
    const model = String(message || '').match(/doubao-seedream-[a-z0-9-]+/i)?.[0] || '';
    const label = model.includes('-lite-') ? 'Seedream 5.0 Lite' : 'Seedream 5.0 正式版';
    return new Error(`当前火山方舟账号尚未开通 ${label}${model ? `（${model}）` : ''}。充值不会自动开通模型，请到火山方舟“开通管理”启用该模型，或在软件模型设置中切换到已开通的版本。`);
  }
  if (status === 401 || status === 403) return new Error('Seedream API Key 无效或没有模型权限。');
  if (status === 429) return new Error('Seedream 请求过于频繁或账户额度不足，请稍后重试。');
  return new Error(message || `Seedream 请求失败（${status}）。`);
}

async function fetchJson(url, options, timeoutMs = 300000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Seedream 请求超时，请检查网络后重试。');
    throw new Error(`无法连接火山方舟：${error?.message || '网络请求失败'}`);
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

async function requestImage(apiKey, { model, prompt, size }) {
  const payload = await fetchJson(`${API_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      prompt,
      size: size || DEFAULT_SIZE,
      sequential_image_generation: 'disabled',
      stream: false,
      response_format: 'url',
      output_format: 'png',
      watermark: false,
    }),
  });
  const result = payload?.data?.[0];
  if (!result?.url && !result?.b64_json) throw new Error('Seedream 没有返回图片，请重试。');
  return { result, usage: payload.usage || null, model: payload.model || model || DEFAULT_MODEL };
}

async function imageBuffer(result) {
  if (result.b64_json) return Buffer.from(result.b64_json, 'base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let response;
  try { response = await fetch(result.url, { signal: controller.signal }); }
  catch (error) {
    if (error?.name === 'AbortError') throw new Error('下载 Seedream 图片超时，请重试。');
    throw new Error(`下载 Seedream 图片失败：${error?.message || '网络请求失败'}`);
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(`下载 Seedream 图片失败（${response.status}）。`);
  return Buffer.from(await response.arrayBuffer());
}

async function generateAndSave({ apiKey, model, size, prompt, outputRoot, projectTitle, projectId, fileName, index }) {
  if (!String(prompt || '').trim()) throw new Error('参考图提示词不能为空。');
  const directory = path.join(
    outputRoot,
    'StoryForge',
    safeSegment(projectTitle, '未命名短剧项目'),
    safeSegment(projectId, 'project'),
    '视觉素材',
  );
  fs.mkdirSync(directory, { recursive: true });
  const savedName = normalizeFileName(fileName, index);
  const targetPath = path.join(directory, savedName);
  const response = await requestImage(apiKey, { model, prompt: String(prompt).trim(), size });
  fs.writeFileSync(targetPath, await imageBuffer(response.result));
  return {
    localPath: targetPath,
    imageUrl: pathToFileURL(targetPath).href,
    fileName: savedName,
    outputDirectory: directory,
    model: response.model,
    usage: response.usage,
  };
}

module.exports = {
  API_BASE,
  DEFAULT_MODEL,
  DEFAULT_SIZE,
  KNOWN_MODELS,
  generateAndSave,
  normalizeFileName,
  safeSegment,
  testConnection,
};
