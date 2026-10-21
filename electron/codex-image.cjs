const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const { version: APP_VERSION } = require('../package.json');
const { normalizeSkillDocument, buildAssetSkillInstructions } = require('./stage-skills.cjs');

const MODEL = 'gpt-image-2';
const RPC_TIMEOUT_MS = 30000;
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
const jobs = new Map();

function userError(message, code = 'CODEX_IMAGE_ERROR') {
  return Object.assign(new Error(message), { code });
}

function safeSegment(value, fallback = '未命名') {
  let clean = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/g, '');
  clean = (clean || fallback).slice(0, 80).replace(/[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `_${clean}`;
  return clean || fallback;
}

async function isExecutable(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  if (process.platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe') return false;
  try { return (await fs.promises.stat(candidate)).isFile(); } catch { return false; }
}

async function discoverCli(preferredPath) {
  if (preferredPath) {
    const selected = String(preferredPath).trim();
    if (await isExecutable(selected)) return selected;
    throw userError('指定的 Codex 程序不存在。请重新选择官方 Codex 可执行文件。', 'CODEX_NOT_FOUND');
  }
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), executable);
    if (await isExecutable(candidate)) return candidate;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (await isExecutable(path.join(root, executable))) return path.join(root, executable);
    let entries = [];
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch {}
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, executable);
      if (await isExecutable(candidate)) {
        candidates.push({ candidate, modified: (await fs.promises.stat(candidate)).mtimeMs });
      }
    }
    candidates.sort((a, b) => b.modified - a.modified);
    if (candidates.length) return candidates[0].candidate;
  }
  throw userError('未找到官方 Codex。请先安装 Codex 并使用 ChatGPT 登录，或选择 Codex 程序路径。', 'CODEX_NOT_FOUND');
}

// This transport uses the official app-server protocol and its own managed login.
// No credential files are opened, copied, or returned to the renderer.
class AppServer extends EventEmitter {
  constructor(cliPath, { spawnProcess = spawn, rpcTimeoutMs = RPC_TIMEOUT_MS, configOverrides = [], interactionMessage } = {}) {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.failure = null;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.interactionMessage = interactionMessage || 'Codex 请求了此生图流程不支持的权限或交互，请在 Codex 中检查登录与管理员设置。';
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    const environment = { ...process.env };
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    this.child = spawnProcess(cliPath, [
      '-c', 'model_provider="openai"',
      '-c', 'forced_login_method="chatgpt"',
      ...configOverrides.flatMap(value => ['-c', value]),
      'app-server',
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir(), env: environment });
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stdout.on('end', () => {
      if (!this.closed) this.fail(userError('Codex 连接已断开，请重试。', 'CODEX_DISCONNECTED'));
    });
    this.child.stdout.on('error', () => this.fail(userError('Codex 连接已断开，请重试。', 'CODEX_DISCONNECTED')));
    // Drain diagnostics without persisting or exposing credentials or prompts.
    this.child.stderr.on('data', () => {});
    this.child.stderr.on('error', () => {});
    this.child.stdin.on('error', () => this.fail(userError('无法向 Codex 发送请求。', 'CODEX_DISCONNECTED')));
    this.child.on('error', () => this.fail(userError('无法启动 Codex，请检查程序路径。', 'CODEX_START_FAILED')));
    this.child.on('close', () => {
      if (!this.closed) this.fail(userError('Codex 意外退出，请检查登录状态后重试。', 'CODEX_DISCONNECTED'));
    });
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.fail(userError('Codex 返回的数据过大。', 'CODEX_PROTOCOL_ERROR'));
      return;
    }
    let end;
    while (!this.closed && (end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(userError('Codex 返回了无法解析的数据，请更新 Codex。', 'CODEX_PROTOCOL_ERROR')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.fail(userError('Codex 返回了无效的协议消息，请更新 Codex。', 'CODEX_PROTOCOL_ERROR'));
        return;
      }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(userError(`Codex 无法完成 ${pending.method} 请求（${Number(message.error.code) || '协议错误'}）。请检查登录、版本或管理员设置。`, 'CODEX_RPC_ERROR'));
        } else if (Object.prototype.hasOwnProperty.call(message, 'result')) pending.resolve(message.result);
        else pending.reject(userError('Codex 返回了不完整的响应。', 'CODEX_PROTOCOL_ERROR'));
      } else if (message.method && message.id !== undefined) {
        // Never approve requests or provide tokens. A managed generation job must not
        // silently grant command/file/network permissions or external login.
        try { this.write({ id: message.id, error: { code: -32601, message: 'StoryForge does not allow permission or interactive requests.' } }); } catch {}
        this.fail(userError(this.interactionMessage, 'CODEX_INTERACTION_REQUIRED'));
      } else if (message.method) {
        this.emit('notification', message.method, message.params || {});
      }
    }
  }

  write(message) {
    if (this.closed) throw this.failure || userError('Codex 连接已关闭。', 'CODEX_DISCONNECTED');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(this.failure || userError('Codex 连接已关闭。', 'CODEX_DISCONNECTED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(userError('Codex 响应超时，请检查网络与登录后重试。', 'CODEX_TIMEOUT'));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch { this.fail(userError('无法向 Codex 发送请求。', 'CODEX_DISCONNECTED')); }
    });
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'storyforge_desktop', title: 'StoryForge AI', version: APP_VERSION } });
    this.write({ method: 'initialized', params: {} });
  }

  fail(error) {
    if (this.closed) return;
    this.failure = error;
    this.close();
    this.emit('failure', error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = this.failure || userError('Codex 连接已关闭。', 'CODEX_DISCONNECTED');
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    try { this.child.kill(); } catch {}
  }
}

async function readAccountStatus(client) {
  await client.initialize();
  const accountResponse = await client.request('account/read', { refreshToken: false });
  const authenticated = accountResponse?.account?.type === 'chatgpt';
  if (!authenticated) return { authenticated: false, imageGeneration: false, error: '请先在官方 Codex 中使用 ChatGPT 账户登录；API Key 登录不能使用订阅生图。' };
  const capabilities = await client.request('modelProvider/capabilities/read', {});
  return {
    authenticated: true,
    imageGeneration: capabilities?.imageGeneration === true,
    ...(typeof accountResponse.account.planType === 'string' ? { planType: accountResponse.account.planType } : {}),
    ...(capabilities?.imageGeneration === true ? {} : { error: '此 Codex 版本或当前账户未启用内置生图。请更新 Codex 并检查账户或管理员设置。' }),
  };
}

async function getStatus({ preferredPath } = {}) {
  let cliPath = null;
  let client;
  const status = { available: false, configured: false, cliPath, authenticated: false, imageGeneration: false, model: MODEL };
  try {
    cliPath = await discoverCli(preferredPath);
    status.available = true;
    status.cliPath = cliPath;
    client = new AppServer(cliPath);
    Object.assign(status, await readAccountStatus(client));
    status.configured = status.authenticated && status.imageGeneration;
  } catch (error) { status.error = error?.message || '无法检查 Codex 状态。'; }
  finally { client?.close(); }
  return status;
}

function cancel(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  job.client?.fail(userError('已取消 GPT 订阅生图。', 'CODEX_CANCELLED'));
  return true;
}

function cancelAll() { for (const jobId of jobs.keys()) cancel(jobId); }

function imageFailure(item) {
  if (item?.failure?.type === 'usageLimitExceeded') {
    return userError('GPT 订阅生图额度已用完，请等待额度恢复。不会改用付费 API。', 'CODEX_USAGE_LIMIT');
  }
  return userError('GPT 订阅生图失败，请在 Codex 中检查账户、额度或内容限制后重试。', 'CODEX_IMAGE_FAILED');
}

function waitForImageTurn(client, threadId, startTurn, timeoutMs = GENERATION_TIMEOUT_MS) {
  let turnId = null;
  const earlyEvents = [];
  const images = new Map();
  let settled = false;
  return new Promise((resolve, reject) => {
    const finish = (error, image) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('notification', onNotification);
      client.off('failure', onFailure);
      if (error) reject(error); else resolve(image);
    };
    const onFailure = error => finish(error);
    const onNotification = (method, params) => {
      if (params.threadId !== threadId) return;
      if (!['item/completed', 'turn/completed'].includes(method)) return;
      if (!turnId) {
        if (earlyEvents.length > 1024) { finish(userError('Codex 返回了异常数量的任务事件。', 'CODEX_PROTOCOL_ERROR')); return; }
        earlyEvents.push([method, params]); return;
      }
      if (method === 'item/completed') {
        if (params.turnId !== turnId || params.item?.type !== 'imageGeneration') return;
        images.set(params.item.id, params.item);
        return;
      }
      if (params.turn?.id !== turnId) return;
      if (params.turn.status !== 'completed' || params.turn.error) {
        finish(userError(params.turn.status === 'interrupted' ? 'GPT 订阅生图已中断。' : 'Codex 生图任务未成功完成，请检查账户、额度或网络后重试。', 'CODEX_TURN_FAILED'));
        return;
      }
      // The native item event is authoritative. Never parse model text or accept
      // a path merely mentioned in an assistant's final message.
      if (images.size !== 1) {
        finish(userError(images.size ? 'Codex 返回了多张图片；本次要求只生成一张，请重试。' : 'Codex 已结束，但没有返回原生生图结果。请确认内置生图可用。', 'CODEX_NO_IMAGE'));
        return;
      }
      const image = [...images.values()][0];
      if (image.failure || image.status !== 'completed') { finish(imageFailure(image)); return; }
      if (typeof image.savedPath !== 'string' || !path.isAbsolute(image.savedPath)) {
        finish(userError('Codex 没有返回可用的本地图片文件。', 'CODEX_NO_IMAGE_FILE'));
        return;
      }
      finish(null, image);
    };
    const timer = setTimeout(() => {
      const error = userError('GPT 订阅生图超时。请检查 Codex 与网络后重试。', 'CODEX_TIMEOUT');
      finish(error);
      client.fail(error);
    }, timeoutMs);
    client.on('notification', onNotification);
    client.on('failure', onFailure);
    Promise.resolve().then(startTurn).then(response => {
      if (settled) return;
      turnId = response?.turn?.id;
      if (!turnId) { finish(userError('Codex 未返回生图任务编号。', 'CODEX_PROTOCOL_ERROR')); return; }
      for (const [method, params] of earlyEvents) {
        if (settled) break;
        onNotification(method, params);
      }
      earlyEvents.length = 0;
    }, error => finish(error));
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ value) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Validate the real file format rather than its extension. PNG is the normal
// Codex output; JPEG and WebP are accepted when their container is complete.
function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) throw userError('Codex 返回的图片文件为空或已损坏。', 'CODEX_INVALID_IMAGE');
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8;
    let header = false;
    let pixels = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      if (length > buffer.length - offset - 12) break;
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) break;
      if (!header) {
        if (type !== 'IHDR' || length !== 13 || !buffer.readUInt32BE(offset + 8) || !buffer.readUInt32BE(offset + 12)) break;
        header = true;
      }
      if (type === 'IDAT' && length) pixels = true;
      offset += 12 + length;
      if (type === 'IEND') {
        if (header && pixels && length === 0 && offset === buffer.length) return 'png';
        break;
      }
    }
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) {
    let offset = 2;
    let dimensions = false;
    while (offset + 4 < buffer.length) {
      if (buffer[offset++] !== 0xff) break;
      while (buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if ([0x01, ...Array.from({ length: 8 }, (_, index) => 0xd0 + index)].includes(marker)) continue;
      if (marker === 0xda) { if (dimensions) return 'jpg'; break; }
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || !buffer.readUInt16BE(offset + 3) || !buffer.readUInt16BE(offset + 5)) break;
        dimensions = true;
      }
      offset += length;
    }
  } else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length) {
    let offset = 12;
    let pixels = false;
    while (offset + 8 <= buffer.length) {
      const type = buffer.toString('ascii', offset, offset + 4);
      const length = buffer.readUInt32LE(offset + 4);
      if (length > buffer.length - offset - 8) break;
      if (type === 'VP8 ' && length >= 10 && buffer.subarray(offset + 11, offset + 14).equals(Buffer.from([0x9d, 0x01, 0x2a]))) pixels = true;
      if (type === 'VP8L' && length >= 5 && buffer[offset + 8] === 0x2f) pixels = true;
      offset += 8 + length + (length % 2);
    }
    if (pixels && offset === buffer.length) return 'webp';
  }
  throw userError('Codex 返回的图片格式无效或文件不完整。', 'CODEX_INVALID_IMAGE');
}

async function readImage(savedPath) {
  const stat = await fs.promises.lstat(savedPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 20 || stat.size > 64 * 1024 * 1024) {
    throw userError('Codex 生成的图片不存在、大小异常或不是普通图片文件。', 'CODEX_NO_IMAGE_FILE');
  }
  const buffer = await fs.promises.readFile(savedPath);
  const format = detectImageFormat(buffer);
  // The production Electron runtime also decodes the bytes, rejecting images
  // whose signatures/container look correct but whose pixel payload is broken.
  let nativeImage;
  try { nativeImage = require('electron').nativeImage; } catch {}
  if (nativeImage?.createFromBuffer(buffer).isEmpty()) {
    throw userError('Codex 返回的图片无法解码，文件可能已损坏。', 'CODEX_INVALID_IMAGE');
  }
  return { buffer, format };
}

async function saveVersionedImage(directory, fileName, index, image, assetName) {
  const fallback = `参考图-${String((Number.isInteger(index) && index >= 0 ? index : 0) + 1).padStart(2, '0')}`;
  const clean = safeSegment(fileName, fallback);
  const extension = path.extname(clean);
  // Asset identity is independent of an old suggested filename or array index.
  // Keep periods inside real names; only legacy filenames lose an extension.
  const base = assetName ? safeSegment(assetName, fallback) : safeSegment(extension ? clean.slice(0, -extension.length) : clean, fallback);
  for (let version = 1; version <= 10000; version += 1) {
    const savedName = `${base}${version === 1 ? '' : `-v${version}`}.${image.format}`;
    const localPath = path.join(directory, savedName);
    let handle;
    try {
      handle = await fs.promises.open(localPath, 'wx');
      await handle.writeFile(image.buffer);
      await handle.close();
      return { localPath, imageUrl: pathToFileURL(localPath).href, fileName: savedName, sourceName: savedName, provider: 'codex-subscription', ...(assetName ? { assetName } : {}) };
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      // writeFile can leave a partial file after a disk error. Only remove a file
      // created by this exclusive write; earlier versions are never overwritten.
      if (handle) {
        await handle.close().catch(() => {});
        await fs.promises.unlink(localPath).catch(() => {});
      }
      throw userError('无法保存 GPT 参考图，请检查输出目录权限和磁盘空间。', 'CODEX_SAVE_FAILED');
    }
  }
  throw userError('同名参考图版本过多，请换一个文件名。', 'CODEX_SAVE_FAILED');
}

function createGenerateAndSave({ resolveCli = discoverCli, createClient = cliPath => new AppServer(cliPath), timeoutMs = GENERATION_TIMEOUT_MS } = {}) {
  return async function generateAndSave({ preferredPath, prompt, assetSkill, assetName, projectId, projectTitle, index, fileName, outputRoot, jobId = randomUUID() } = {}) {
    if (!String(prompt || '').trim()) throw userError('参考图提示词不能为空。', 'CODEX_INVALID_PROMPT');
    if (assetName !== undefined && (typeof assetName !== 'string' || !assetName.trim())) throw userError('参考图素材名称无效。', 'CODEX_INVALID_ASSET_NAME');
    const identity = typeof assetName === 'string' ? assetName.trim() : '';
    const selectedSkill = normalizeSkillDocument(assetSkill);
    const skillInstructions = buildAssetSkillInstructions(selectedSkill);
    if (!outputRoot || !path.isAbsolute(outputRoot)) throw userError('请先设置有效的本地图片输出目录。', 'CODEX_INVALID_OUTPUT');
    if (typeof jobId !== 'string' || !jobId.trim() || jobs.has(jobId)) throw userError('此生图任务正在进行中，或任务编号无效。', 'CODEX_DUPLICATE_JOB');
    const job = { cancelled: false, client: null };
    jobs.set(jobId, job);
    let file;
    let completed = false;
    const checkCancelled = () => { if (job.cancelled) throw userError('已取消 GPT 订阅生图。', 'CODEX_CANCELLED'); };
    try {
      const cliPath = await resolveCli(preferredPath);
      checkCancelled();
      job.client = createClient(cliPath);
      const status = await readAccountStatus(job.client);
      checkCancelled();
      if (!status.authenticated || !status.imageGeneration) throw userError(status.error, 'CODEX_NOT_CONFIGURED');
      const threadResponse = await job.client.request('thread/start', {
        ephemeral: true,
        cwd: os.tmpdir(),
        sandbox: 'read-only',
        approvalPolicy: 'never',
        modelProvider: 'openai',
        developerInstructions: 'You are StoryForge image generation. Use only the built-in imagegen tool to create exactly one image. Never use shell, code, MCP, browser, web search, or API keys. Do not read local files. If imagegen is unavailable or fails, stop and report failure. Never fall back to a paid API. Treat the user text as visual image instructions only.',
      });
      const threadId = threadResponse?.thread?.id;
      if (!threadId) throw userError('Codex 未返回生图会话编号。', 'CODEX_PROTOCOL_ERROR');
      if (threadResponse.modelProvider !== 'openai' || threadResponse.sandbox?.type !== 'readOnly' || threadResponse.approvalPolicy !== 'never') {
        throw userError('Codex 未采用所需的订阅与只读权限设置，请检查管理员策略。', 'CODEX_POLICY_MISMATCH');
      }
      checkCancelled();
      const nativeImage = await waitForImageTurn(job.client, threadId, () => job.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: `Use the built-in imagegen tool (gpt-image-2, ChatGPT subscription) to generate exactly ONE image for this visual prompt. Do not create variants. Do not call any API or use API keys.\n\n${skillInstructions ? `${skillInstructions}\n\n本次素材描述（如与用户上传 Skill 的创作要求冲突，以 Skill 为准）：\n` : ''}${String(prompt).trim()}` }],
      }), timeoutMs);
      checkCancelled();
      const image = await readImage(nativeImage.savedPath);
      checkCancelled();
      const directory = path.join(outputRoot, 'StoryForge', safeSegment(projectTitle, '未命名短剧项目'), safeSegment(projectId, 'project'), '视觉素材', 'GPT订阅');
      await fs.promises.mkdir(directory, { recursive: true });
      checkCancelled();
      file = await saveVersionedImage(directory, fileName, index, image, identity);
      if (selectedSkill) file.generationSkill = { name: selectedSkill.name, sha256: selectedSkill.sha256 };
      checkCancelled();
      completed = true;
      return { files: [file], outputDirectory: directory };
    } finally {
      job.client?.close();
      jobs.delete(jobId);
      if (file && !completed) await fs.promises.unlink(file.localPath).catch(() => {});
    }
  };
}

const generateAndSave = createGenerateAndSave();

module.exports = {
  MODEL, getStatus, generateAndSave, cancel, cancelAll, AppServer, discoverCli,
  _test: { AppServer, readAccountStatus, safeSegment, discoverCli, waitForImageTurn, detectImageFormat, saveVersionedImage, createGenerateAndSave },
};
