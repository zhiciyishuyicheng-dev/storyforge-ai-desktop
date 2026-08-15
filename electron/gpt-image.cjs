const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_SIZE = '1536x1024';
const DEFAULT_QUALITY = 'medium';
const KNOWN_SIZES = [
  { id: '1536x1024', label: '1536 x 1024（横版推荐）' },
  { id: '1024x1536', label: '1024 x 1536（竖版）' },
  { id: '1024x1024', label: '1024 x 1024（方形）' },
  { id: '2048x1152', label: '2048 x 1152（2K 横版）' },
  { id: '2160x3840', label: '2160 x 3840（4K 竖版，实验性）' },
];
const KNOWN_QUALITIES = [
  { id: 'low', label: '低（快速草稿）' },
  { id: 'medium', label: '中（推荐）' },
  { id: 'high', label: '高（最终素材）' },
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
  const message = String(payload?.error?.message || payload?.message || '').trim();
  if (status === 401) return new Error('OpenAI API Key 无效，请检查后重试。');
  if (status === 403) return new Error(`当前 OpenAI 账号没有 GPT Image 2 权限。${message ? ` ${message}` : ''}`);
  if (status === 429) return new Error('OpenAI 请求过于频繁、余额不足或已达到额度上限，请检查账户用量后重试。');
  if (/organization verification|verify your organization/i.test(message)) {
    return new Error('使用 GPT Image 2 前需要在 OpenAI 平台完成组织验证。');
  }
  return new Error(message || `GPT Image 2 请求失败（${status}）。`);
}

async function fetchJson(url, options, timeoutMs = 300000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('GPT Image 2 请求超时，请检查网络后重试。');
    throw new Error(`无法连接 OpenAI：${error?.message || '网络请求失败'}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`OpenAI 返回了无法解析的响应（${response.status}）。`); }
  if (!response.ok) throw apiError(payload, response.status);
  return payload;
}

async function testConnection(apiKey) {
  await fetchJson(`${API_BASE}/models/${DEFAULT_MODEL}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }, 30000);
  return true;
}

async function requestImage(apiKey, { prompt, size, quality }) {
  const payload = await fetchJson(`${API_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      prompt,
      size: size || DEFAULT_SIZE,
      quality: quality || DEFAULT_QUALITY,
      output_format: 'png',
      n: 1,
    }),
  });
  const result = payload?.data?.[0];
  if (!result?.b64_json && !result?.url) throw new Error('GPT Image 2 没有返回图片，请重试。');
  return { result, usage: payload.usage || null, model: DEFAULT_MODEL };
}

async function imageBuffer(result) {
  if (result.b64_json) return Buffer.from(result.b64_json, 'base64');
  const response = await fetch(result.url);
  if (!response.ok) throw new Error(`下载 GPT Image 2 图片失败（${response.status}）。`);
  return Buffer.from(await response.arrayBuffer());
}

async function generateAndSave({ apiKey, size, quality, prompt, outputRoot, projectTitle, projectId, fileName, index }) {
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
  const response = await requestImage(apiKey, {
    prompt: String(prompt).trim(),
    size,
    quality,
  });
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
  DEFAULT_QUALITY,
  DEFAULT_SIZE,
  KNOWN_QUALITIES,
  KNOWN_SIZES,
  generateAndSave,
  testConnection,
};
