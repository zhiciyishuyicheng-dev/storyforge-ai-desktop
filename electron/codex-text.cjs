const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { AppServer, discoverCli } = require('./codex-image.cjs');

const jobs = new Map();
// Process-local overrides leave the user's Codex settings untouched. No tool,
// plugin, hook, project instruction, or MCP configuration is needed for prose.
const TEXT_CONFIG = Object.freeze([
  'features.shell_tool=false', 'features.unified_exec=false',
  'features.apps=false', 'features.plugins=false', 'features.image_generation=false',
  'features.hooks=false', 'features.browser_use=false', 'features.browser_use_external=false',
  'features.computer_use=false', 'features.code_mode=false', 'features.code_mode_host=false',
  'features.multi_agent=false', 'features.multi_agent_v2=false',
  'features.memories=false', 'features.skill_search=false', 'features.skip_host_skill_discovery=true',
  'features.tool_suggest=false', 'features.workspace_dependencies=false',
  'features.sleep_tool=false', 'features.goals=false', 'tools.view_image=false',
  'features.view_image=false', 'web_search="disabled"', 'mcp_servers={}',
  'project_doc_max_bytes=0',
]);
const TEXT_INSTRUCTIONS = 'You are XStudio, a text-only storyboard outline and storyboard generator. Follow the supplied creative specification and return exactly one complete JSON object. Never call tools, read files, browse, execute code, generate images, use plugins or MCP, request permissions, or obtain credentials. All necessary material is supplied as text. Do not output hidden reasoning, commentary, Markdown fences, or text outside JSON. Use only the current ChatGPT subscription; never fall back to an API key or another provider.';

function textError(code, message) { return Object.assign(new Error(message), { code }); }
function safeString(value, maximum = 200) {
  return typeof value === 'string' && value.trim() && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value.trim() : null;
}
function safeFailure(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('CODEX_')) return error;
  return textError('CODEX_TEXT_CONNECTION', 'GPT 订阅连接或响应读取中断，本次内容未交付，请重试。');
}

function normalizeModel(value) {
  if (!value || value.hidden === true || (Array.isArray(value.inputModalities) && !value.inputModalities.includes('text'))) return null;
  const id = safeString(value.id);
  const model = safeString(value.model);
  const defaultReasoningEffort = safeString(value.defaultReasoningEffort, 32);
  if (!id || !model || !defaultReasoningEffort || !Array.isArray(value.supportedReasoningEfforts)) return null;
  const supportedReasoningEfforts = [];
  for (const option of value.supportedReasoningEfforts) {
    const reasoningEffort = safeString(option?.reasoningEffort, 32);
    if (!reasoningEffort || supportedReasoningEfforts.some(item => item.reasoningEffort === reasoningEffort)) continue;
    supportedReasoningEfforts.push({ reasoningEffort, description: safeString(option.description, 1000) || '' });
  }
  if (!supportedReasoningEfforts.some(option => option.reasoningEffort === defaultReasoningEffort)) return null;
  return { id, model, displayName: safeString(value.displayName) || model, defaultReasoningEffort, supportedReasoningEfforts, isDefault: value.isDefault === true };
}

async function readModels(client) {
  const models = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const response = await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(response?.data)) throw textError('CODEX_TEXT_MODEL_LIST', 'Codex 未返回可用的 GPT 模型列表，请更新 Codex 后重试。');
    for (const item of response.data) {
      const model = normalizeModel(item);
      if (model && !models.some(existing => existing.model === model.model)) models.push(model);
    }
    if (!response.nextCursor) return models;
    if (typeof response.nextCursor !== 'string' || cursors.has(response.nextCursor)) break;
    cursor = response.nextCursor;
    cursors.add(cursor);
  }
  throw textError('CODEX_TEXT_MODEL_LIST', 'Codex 模型列表未完整读取，请重试。');
}

async function readTextStatus(client, { initialized = false } = {}) {
  if (!initialized) await client.initialize();
  const response = await client.request('account/read', { refreshToken: false });
  if (response?.account?.type !== 'chatgpt') return { authenticated: false, configured: false, models: [], error: '请先在官方 Codex 中使用 ChatGPT 账户登录；API Key 登录不能用于 GPT 订阅分镜。' };
  const models = await readModels(client);
  return { authenticated: true, configured: models.length > 0, models,
    ...(models.length ? {} : { error: '当前 Codex 账户没有可用的文本模型，请检查订阅、管理员设置或更新 Codex。' }) };
}

function inspectTextPolicy(config) {
  const disabledFeatures = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'image_generation', 'hooks', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode', 'code_mode_host', 'multi_agent', 'multi_agent_v2', 'view_image'];
  if (!config || disabledFeatures.some(name => config.features?.[name] !== false) || config.web_search !== 'disabled') {
    throw textError('CODEX_TEXT_POLICY_MISMATCH', 'Codex 未关闭分镜文本生成之外的工具，请更新 Codex 或检查管理员设置后重试。');
  }
  const servers = config.mcp_servers || {};
  if (typeof servers !== 'object' || Array.isArray(servers)) throw textError('CODEX_TEXT_POLICY_MISMATCH', 'Codex 未返回有效的工具权限设置，本次请求已停止。');
  const enabledServers = Object.entries(servers).filter(([, server]) => server?.enabled !== false).map(([name]) => name);
  if (enabledServers.some(name => !/^[A-Za-z0-9_-]{1,128}$/.test(name))) throw textError('CODEX_TEXT_POLICY_MISMATCH', '当前 Codex 存在无法安全关闭的外部工具配置，本次请求已停止。');
  return enabledServers;
}

function selectModel(models, selectedModel, selectedEffort) {
  if (selectedModel !== undefined && selectedModel !== null && (typeof selectedModel !== 'string' || (selectedModel && !safeString(selectedModel)))) throw textError('CODEX_TEXT_INVALID_MODEL', '请选择有效的 GPT 模型。');
  const model = selectedModel ? models.find(item => item.model === selectedModel || item.id === selectedModel) : (models.find(item => item.isDefault) || models[0]);
  if (!model) throw textError('CODEX_TEXT_INVALID_MODEL', '所选 GPT 模型当前不可用，请刷新模型列表并重新选择。');
  const effort = selectedEffort === undefined || selectedEffort === null || selectedEffort === '' ? model.defaultReasoningEffort : selectedEffort;
  if (typeof effort !== 'string' || !model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) throw textError('CODEX_TEXT_INVALID_EFFORT', '所选 GPT 模型不支持该思考强度，请重新选择。');
  return { model: model.model, reasoningEffort: effort };
}

function usageFromNotification(value) {
  const source = value?.last;
  if (!source || typeof source !== 'object') return null;
  const result = {};
  for (const [from, to] of [['inputTokens', 'prompt_tokens'], ['outputTokens', 'completion_tokens'], ['totalTokens', 'total_tokens']]) {
    if (Number.isSafeInteger(source[from]) && source[from] >= 0) result[to] = source[from];
  }
  return Object.keys(result).length ? result : null;
}

function turnFailure(turn) {
  const code = turn?.error?.codexErrorInfo;
  if (['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'].includes(code)) return textError('CODEX_TEXT_USAGE_LIMIT', 'GPT 订阅额度或速率达到限制，请等待恢复后重试。');
  if (code === 'contextWindowExceeded') return textError('CODEX_TEXT_CONTEXT_LIMIT', '当前材料与 Skill 超出所选 GPT 模型的上下文容量，请缩小本次范围或更换模型。');
  return textError('CODEX_TEXT_TURN_FAILED', turn?.status === 'interrupted' ? 'GPT 订阅分镜已中断，本次内容未交付。' : 'GPT 订阅分镜未成功完成，请检查账户、额度或网络后重试。');
}

function createProgress(onProgress, now) {
  const startedAt = now();
  let firstResponseAt = null;
  let firstReasoningAt = null;
  let firstContentAt = null;
  let reasoningChars = 0;
  let outputChars = 0;
  let phase = 'waiting';
  let lastEmission = -Infinity;
  let lastPhase;
  let usage = null;
  const snapshot = (current = phase) => {
    const timestamp = now();
    return { phase: current, timestamp, elapsedMs: Math.max(0, timestamp - startedAt),
      firstResponseMs: firstResponseAt === null ? null : Math.max(0, firstResponseAt - startedAt),
      firstReasoningMs: firstReasoningAt === null ? null : Math.max(0, firstReasoningAt - startedAt),
      firstContentMs: firstContentAt === null ? null : Math.max(0, firstContentAt - startedAt),
      waitingMs: Math.max(0, Math.min(firstReasoningAt ?? timestamp, firstContentAt ?? timestamp) - startedAt),
      thinkingMs: firstReasoningAt === null ? null : Math.max(0, (firstContentAt ?? timestamp) - firstReasoningAt),
      outputMs: firstContentAt === null ? null : Math.max(0, timestamp - firstContentAt),
      reasoningChars, outputChars, streamed: true, ...(usage ? { usage } : {}) };
  };
  const emit = (next, force = false) => {
    phase = next;
    const time = now();
    if (typeof onProgress !== 'function' || (!force && lastPhase === phase && time - lastEmission < 250)) return;
    lastEmission = time; lastPhase = phase;
    try { onProgress(snapshot()); } catch {}
  };
  emit('waiting', true);
  return { snapshot, emit, response() { if (firstResponseAt === null) firstResponseAt = now(); },
    reasoning(count) { if (firstReasoningAt === null) firstReasoningAt = now(); reasoningChars += count; emit(firstContentAt === null ? 'thinking' : 'generating'); },
    output(count) { if (firstContentAt === null) firstContentAt = now(); outputChars += count; emit('generating'); },
    finalOutput(count) { if (firstContentAt === null) firstContentAt = now(); outputChars = count; },
    usage(value) { usage = usageFromNotification(value) || usage; } };
}

function waitForTextTurn(client, threadId, startTurn, { timeoutMs, progress } = {}) {
  let turnId;
  let settled = false;
  const early = [];
  const messages = new Map();
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('notification', onNotification);
      client.off('failure', onFailure);
      if (error) reject(error); else resolve(value);
    };
    const onFailure = error => finish(error);
    const receive = (method, event) => {
      if (settled || (method === 'turn/completed' ? event.turn?.id : event.turnId) !== turnId) return;
      progress?.response();
      if (method === 'item/started' || method === 'item/completed') {
        const item = event.item;
        if (!item || typeof item.type !== 'string') { finish(textError('CODEX_TEXT_PROTOCOL', 'Codex 文本事件格式异常，请更新 Codex。')); return; }
        if (!['agentMessage', 'reasoning', 'userMessage'].includes(item.type)) {
          const error = textError('CODEX_TEXT_TOOL_BLOCKED', 'GPT 分镜请求了文本生成之外的操作，本次任务已停止，请重试。');
          finish(error); client.fail(error); return;
        }
        if (item.type === 'reasoning') progress?.reasoning(0);
        if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string' && item.phase !== 'commentary' && item.phase !== 'partial_answer') {
          if (!safeString(item.id, 256)) { finish(textError('CODEX_TEXT_PROTOCOL', 'Codex 未返回有效的文本消息编号。')); return; }
          messages.set(item.id, item.text);
        }
      } else if (method === 'item/agentMessage/delta') progress?.output(event.characters);
      else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') progress?.reasoning(event.characters);
      else if (method === 'thread/tokenUsage/updated') progress?.usage(event.tokenUsage);
      else if (method === 'turn/completed') {
        if (event.turn.status !== 'completed' || event.turn.error) { finish(turnFailure(event.turn)); return; }
        // Completion events are authoritative; never turn a partial delta,
        // commentary message, tool output, or failed turn into a delivered result.
        if (messages.size !== 1 || ![...messages.values()][0].trim()) { finish(textError('CODEX_TEXT_NO_RESULT', 'GPT 未返回唯一完整的 JSON 文本结果，本次内容未交付，请重试。')); return; }
        const content = [...messages.values()][0];
        progress?.finalOutput(content.length);
        finish(null, content);
      }
    };
    const onNotification = (method, params) => {
      if (params.threadId !== threadId || !['item/started', 'item/completed', 'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'thread/tokenUsage/updated', 'turn/completed'].includes(method)) return;
      // Keep only counts for streaming thoughts; raw thought text never enters
      // retained progress, early-event queues, logs, IPC, or saved projects.
      let event;
      if (method.endsWith('Delta') || method.endsWith('/delta')) event = { threadId, turnId: params.turnId, characters: typeof params.delta === 'string' ? params.delta.length : 0 };
      else if (method === 'item/started' || method === 'item/completed') {
        const item = params.item;
        event = { threadId, turnId: params.turnId, item: item ? { id: item.id, type: item.type,
          ...(item.type === 'agentMessage' ? { phase: item.phase, text: item.text } : {}) } : null };
      } else if (method === 'turn/completed') event = { threadId, turn: { id: params.turn?.id, status: params.turn?.status,
        error: params.turn?.error ? { codexErrorInfo: typeof params.turn.error.codexErrorInfo === 'string' ? params.turn.error.codexErrorInfo : 'other' } : null } };
      else event = { threadId, turnId: params.turnId, tokenUsage: { last: params.tokenUsage?.last } };
      if (!turnId) {
        if (early.length >= 8192) { finish(textError('CODEX_TEXT_PROTOCOL', 'Codex 返回了异常数量的任务事件。')); return; }
        early.push([method, event]); return;
      }
      receive(method, event);
    };
    // Production turns have no elapsed-time deadline. A bounded timeout remains
    // injectable only through the internal test factory for deterministic tests.
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      const error = textError('CODEX_TEXT_TIMEOUT', 'GPT 订阅测试请求已达到指定的等待上限，本次内容未交付。');
      finish(error); client.fail(error);
    }, timeoutMs) : null;
    client.on('notification', onNotification);
    client.on('failure', onFailure);
    Promise.resolve().then(startTurn).then(response => {
      if (settled) return;
      turnId = safeString(response?.turn?.id, 256);
      if (!turnId) { finish(textError('CODEX_TEXT_PROTOCOL', 'Codex 未返回文本任务编号。')); return; }
      progress?.response();
      for (const [method, event] of early) receive(method, event);
      early.length = 0;
      if (!settled && response.turn.status && response.turn.status !== 'inProgress') receive('turn/completed', { threadId, turn: response.turn });
    }, error => finish(safeFailure(error)));
  });
}

function createTextClient({ resolveCli = discoverCli, createClient = (cliPath, { extraConfig = [] } = {}) => new AppServer(cliPath, { configOverrides: [...TEXT_CONFIG, ...extraConfig], interactionMessage: 'Codex 请求了分镜文本流程不支持的权限或交互，本次任务已停止。' }), timeoutMs, now = Date.now } = {}) {
  async function connect(cliPath, job) {
    let client;
    let extraConfig = [];
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (job?.cancelled || job?.closed) throw textError('CODEX_TEXT_CANCELLED', '已停止 GPT 订阅分镜。');
        client = createClient(cliPath, { extraConfig });
        if (job) job.client = client;
        await client.initialize();
        const response = await client.request('config/read', { includeLayers: false });
        const enabledServers = inspectTextPolicy(response?.config);
        if (!enabledServers.length) return client;
        // Empty tables may merge with the user's table. Explicit scalar false
        // overrides plus an effective-config recheck make disabling unambiguous.
        extraConfig = enabledServers.map(name => `mcp_servers.${name}.enabled=false`);
        client.close();
        client = null;
      }
      throw textError('CODEX_TEXT_POLICY_MISMATCH', 'Codex 未关闭现有外部工具，本次请求已停止。');
    } catch (error) { client?.close(); throw error; }
  }
  async function getStatus({ preferredPath } = {}) {
    let client;
    const status = { available: false, authenticated: false, configured: false, cliPath: null, models: [] };
    try {
      status.cliPath = await resolveCli(preferredPath);
      status.available = true;
      client = await connect(status.cliPath);
      Object.assign(status, await readTextStatus(client, { initialized: true }));
    } catch (error) { status.error = safeFailure(error).message; }
    finally { client?.close(); }
    return status;
  }

  async function createSession({ preferredPath, model, reasoningEffort, jobId = randomUUID() } = {}) {
    if (!safeString(jobId, 256) || jobs.has(jobId)) throw textError('CODEX_TEXT_DUPLICATE_JOB', 'GPT 分镜任务编号无效或任务已在运行。');
    const job = { cancelled: false, client: null, active: false, closed: false };
    jobs.set(jobId, job);
    const check = () => { if (job.cancelled || job.closed) throw textError('CODEX_TEXT_CANCELLED', '已停止 GPT 订阅分镜。'); };
    const close = () => {
      if (job.closed) return;
      job.closed = true;
      if (job.active) job.client?.fail(textError('CODEX_TEXT_CANCELLED', '已停止 GPT 订阅分镜。'));
      else job.client?.close();
      jobs.delete(jobId);
    };
    job.close = close;
    try {
      const cliPath = await resolveCli(preferredPath);
      check();
      job.client = await connect(cliPath, job);
      const status = await readTextStatus(job.client, { initialized: true });
      check();
      if (!status.configured) throw textError('CODEX_TEXT_NOT_CONFIGURED', status.error);
      const selection = selectModel(status.models, model, reasoningEffort);
      return { ...selection, close, async request(messages, { onProgress } = {}) {
        check();
        if (job.active) throw textError('CODEX_TEXT_BUSY', '同一 GPT 分镜任务不能并发提交请求。');
        if (!Array.isArray(messages) || !messages.length || messages.some(item => !item || !['system', 'developer', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string')) throw textError('CODEX_TEXT_INVALID_PROMPT', 'GPT 分镜请求内容无效。');
        const instructions = messages.filter(item => item.role === 'system' || item.role === 'developer').map(item => item.content).join('\n\n');
        const conversation = messages.filter(item => item.role === 'user' || item.role === 'assistant');
        if (!conversation.length || conversation.at(-1).role !== 'user') throw textError('CODEX_TEXT_INVALID_PROMPT', 'GPT 分镜缺少本次生成要求。');
        const input = conversation.length === 1 ? conversation[0].content : `The following JSON array is the conversation to continue. Respond to the last user request with one complete JSON object.\n${JSON.stringify(conversation)}`;
        const progress = createProgress(onProgress, now);
        job.active = true;
        try {
          const thread = await job.client.request('thread/start', { ephemeral: true, cwd: os.tmpdir(), sandbox: 'read-only', approvalPolicy: 'never',
            modelProvider: 'openai', model: selection.model,
            baseInstructions: TEXT_INSTRUCTIONS, developerInstructions: instructions,
            config: { model_reasoning_effort: selection.reasoningEffort } });
          check();
          const threadId = safeString(thread?.thread?.id, 256);
          if (!threadId || thread.modelProvider !== 'openai' || thread.model !== selection.model || thread.sandbox?.type !== 'readOnly' || thread.approvalPolicy !== 'never'
            || (thread.reasoningEffort !== undefined && thread.reasoningEffort !== null && thread.reasoningEffort !== selection.reasoningEffort)) throw textError('CODEX_TEXT_POLICY_MISMATCH', 'Codex 未采用所选 GPT 模型、思考强度或只读权限设置，本次请求已停止。');
          const content = await waitForTextTurn(job.client, threadId, () => job.client.request('turn/start', {
            threadId, input: [{ type: 'text', text: input }], model: selection.model, effort: selection.reasoningEffort,
          }), { timeoutMs, progress });
          check();
          let data;
          try { data = JSON.parse(content); } catch { data = null; }
          progress.emit('completed', true);
          return { data, ...(data === null ? { rawContent: content } : {}), truncated: false, usage: progress.snapshot().usage || null, model: selection.model, timing: progress.snapshot('completed') };
        } catch (error) {
          const failure = safeFailure(error);
          const lastPhase = progress.snapshot().phase;
          progress.emit('failed', true);
          failure.timing = { ...progress.snapshot('failed'), lastPhase };
          throw failure;
        } finally { job.active = false; }
      } };
    } catch (error) { close(); throw safeFailure(error); }
  }
  return { getStatus, createSession };
}

function cancel(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  job.client?.fail(textError('CODEX_TEXT_CANCELLED', '已停止 GPT 订阅分镜。'));
  job.close();
  return true;
}
function cancelAll() { for (const jobId of [...jobs.keys()]) cancel(jobId); }
const { getStatus, createSession } = createTextClient();
module.exports = { getStatus, createSession, cancel, cancelAll,
  _test: { createTextClient, readTextStatus, readModels, normalizeModel, selectModel, inspectTextPolicy, waitForTextTurn, createProgress, TEXT_CONFIG } };
