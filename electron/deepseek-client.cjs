const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function tokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = Math.trunc(value[key]);
  }
  return Object.keys(result).length ? result : null;
}

function safeRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

/** Receive observable progress without retaining or forwarding model thoughts. */
function createDeepSeekClient({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 300000 } = {}) {
  return async function callDeepSeek(apiKey, messages, maxTokens, onProgress) {
    const wantsStream = typeof onProgress === 'function';
    const isConnectionProbe = !wantsStream && maxTokens === 64;
    const body = {
      model: MODEL,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.35,
      stream: wantsStream,
      thinking: { type: isConnectionProbe ? 'disabled' : 'enabled' },
      ...(!isConnectionProbe ? { reasoning_effort: 'high' } : {}),
      ...(wantsStream ? { stream_options: { include_usage: true } } : {}),
    };
    // Workflow output uses the provider's budget. Only explicit probes set a cap.
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const controller = new AbortController();
    const startedAt = now();
    let firstResponseAt = null;
    let firstReasoningAt = null;
    let firstContentAt = null;
    let reasoningChars = 0;
    let outputChars = 0;
    let streamed = false;
    let requestId;
    let usage = null;
    let model = MODEL;
    let content = '';
    let phase = 'waiting';
    let lastEmitAt = -Infinity;
    let lastEmittedPhase;
    let reader;
    let timedOut = false;
    const deltaMs = (time) => time === null ? null : Math.max(0, time - startedAt);
    const snapshot = (currentPhase, timestamp = now()) => ({
      phase: currentPhase,
      timestamp,
      elapsedMs: Math.max(0, timestamp - startedAt),
      firstResponseMs: deltaMs(firstResponseAt),
      firstReasoningMs: deltaMs(firstReasoningAt),
      firstContentMs: deltaMs(firstContentAt),
      waitingMs: Math.max(0, Math.min(firstReasoningAt ?? timestamp, firstContentAt ?? timestamp) - startedAt),
      thinkingMs: streamed && firstReasoningAt !== null
        ? Math.max(0, (firstContentAt ?? timestamp) - firstReasoningAt) : null,
      outputMs: streamed && firstContentAt !== null ? Math.max(0, timestamp - firstContentAt) : null,
      reasoningChars,
      outputChars,
      streamed,
      ...(requestId ? { requestId } : {}),
      ...(usage ? { usage } : {}),
    });
    const emit = (nextPhase, force = false, extra = {}) => {
      phase = nextPhase;
      const timestamp = now();
      if (!wantsStream || (!force && lastEmittedPhase === phase && timestamp - lastEmitAt < 250)) return;
      lastEmitAt = timestamp;
      lastEmittedPhase = phase;
      // Rendering and window teardown must not affect the provider request.
      try { onProgress({ ...snapshot(phase, timestamp), ...extra }); } catch {}
    };
    emit('waiting', true);

    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        const minutes = timeoutMs / 60000;
        const limit = Number.isInteger(minutes) && minutes >= 1 ? `${minutes} 分钟` : `${timeoutMs / 1000} 秒`;
        reject(clientError('DEEPSEEK_TIMEOUT', `DeepSeek 单次请求已等待 ${limit}，达到程序超时上限；这不代表一定是网络故障。`));
        controller.abort();
      }, timeoutMs);
    });
    const withinTimeout = (promise) => Promise.race([promise, timeoutPromise]);

    try {
      const response = await withinTimeout(fetchImpl(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      }));
      firstResponseAt = now();
      requestId = safeRequestId(response.headers?.get?.('x-request-id'));
      if (!response.ok) {
        throw clientError('DEEPSEEK_HTTP', `DeepSeek 请求失败（HTTP ${Number(response.status) || '未知'}），请稍后重试或检查服务状态。`);
      }
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      const canReadStream = response.body && typeof response.body.getReader === 'function';
      streamed = Boolean(canReadStream && (contentType.includes('text/event-stream')
        || (wantsStream && !contentType.includes('application/json'))));
      emit('waiting', true);

      let finishReason;
      if (streamed) {
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let pending = '';
        let eventData = [];
        let doneMarker = false;
        const consumeEvent = () => {
          if (!eventData.length) return;
          const text = eventData.join('\n');
          eventData = [];
          if (!text.trim()) return;
          if (text.trim() === '[DONE]') {
            doneMarker = true;
            return;
          }
          let payload;
          try { payload = JSON.parse(text); } catch {
            throw clientError('DEEPSEEK_STREAM_INVALID', 'DeepSeek 返回了无法解析的流式事件，本次内容未交付，请重试。');
          }
          if (!payload || typeof payload !== 'object' || payload.error || !Array.isArray(payload.choices)) {
            throw clientError('DEEPSEEK_STREAM_INVALID', 'DeepSeek 返回了异常的流式事件，本次内容未交付，请重试。');
          }
          if (payload.usage) usage = tokenUsage(payload.usage);
          if (typeof payload.model === 'string') model = payload.model;
          if (!requestId) requestId = safeRequestId(payload.id);
          const choice = payload.choices[0];
          if (!choice) return;
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (delta !== undefined && (!delta || typeof delta !== 'object')) {
            throw clientError('DEEPSEEK_STREAM_INVALID', 'DeepSeek 流式内容格式异常，本次内容未交付，请重试。');
          }
          for (const field of ['reasoning_content', 'content']) {
            if (delta?.[field] !== undefined && delta[field] !== null && typeof delta[field] !== 'string') {
              throw clientError('DEEPSEEK_STREAM_INVALID', 'DeepSeek 流式内容格式异常，本次内容未交付，请重试。');
            }
          }
          const reasoning = delta?.reasoning_content;
          const output = delta?.content;
          if (reasoning) {
            if (firstReasoningAt === null) firstReasoningAt = now();
            reasoningChars += reasoning.length;
          }
          if (output) {
            if (firstContentAt === null) firstContentAt = now();
            content += output;
            outputChars += output.length;
          }
          if (reasoning || output) emit(firstContentAt === null ? 'thinking' : 'generating');
        };
        const consumeLine = (line) => {
          if (line === '') { consumeEvent(); return; }
          if (line.startsWith(':')) return; // Provider keepalive is not model output.
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          if (field !== 'data') return;
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          eventData.push(value);
        };
        const consumeLines = (flush = false) => {
          while (!doneMarker) {
            const match = /[\r\n]/.exec(pending);
            if (!match) break;
            const index = match.index;
            // Hold a CR at a chunk boundary so split CRLF stays one newline.
            if (!flush && pending[index] === '\r' && index === pending.length - 1) break;
            const line = pending.slice(0, index);
            const width = pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
            pending = pending.slice(index + width);
            consumeLine(line);
          }
          if (flush && !doneMarker) {
            if (pending) consumeLine(pending);
            pending = '';
            consumeEvent();
          }
        };
        while (!doneMarker) {
          const item = await withinTimeout(reader.read());
          if (item.done) {
            pending += decoder.decode();
            consumeLines(true);
            break;
          }
          pending += decoder.decode(item.value, { stream: true });
          consumeLines();
        }
        if (!doneMarker || !['stop', 'length'].includes(finishReason)) {
          throw clientError('DEEPSEEK_STREAM_INCOMPLETE', 'DeepSeek 流式响应未完整结束，本次内容未交付，请重试。');
        }
      } else {
        const text = await withinTimeout(response.text());
        let payload;
        try { payload = JSON.parse(text); } catch {
          throw clientError('DEEPSEEK_RESPONSE_INVALID', 'DeepSeek 返回了无法解析的响应，请重试。');
        }
        if (payload?.error) throw clientError('DEEPSEEK_RESPONSE_INVALID', 'DeepSeek 返回了异常响应，请重试或检查服务状态。');
        content = payload?.choices?.[0]?.message?.content;
        finishReason = payload?.choices?.[0]?.finish_reason;
        if (!['stop', 'length'].includes(finishReason)) {
          throw clientError('DEEPSEEK_RESPONSE_INCOMPLETE', 'DeepSeek 响应未完整结束，本次内容未交付，请重试。');
        }
        usage = tokenUsage(payload?.usage);
        model = typeof payload?.model === 'string' ? payload.model : MODEL;
        if (!requestId) requestId = safeRequestId(payload?.id);
        const reasoning = payload?.choices?.[0]?.message?.reasoning_content;
        reasoningChars = typeof reasoning === 'string' ? reasoning.length : 0;
        outputChars = typeof content === 'string' ? content.length : 0;
      }
      if (typeof content !== 'string' || !content.length) {
        throw clientError('DEEPSEEK_EMPTY', 'DeepSeek 没有返回生成内容，请重试。');
      }
      let data;
      try { data = JSON.parse(content); } catch { data = null; }
      emit('completed', true);
      return {
        data,
        ...(data === null ? { rawContent: content } : {}),
        truncated: finishReason === 'length',
        usage,
        model,
        timing: snapshot('completed'),
      };
    } catch (error) {
      const lastPhase = phase;
      let safeError = error?.code?.startsWith?.('DEEPSEEK_') ? error : null;
      if (!safeError) {
        safeError = timedOut
          ? clientError('DEEPSEEK_TIMEOUT', 'DeepSeek 请求达到程序超时上限，本次内容未交付。')
          : clientError('DEEPSEEK_CONNECTION', 'DeepSeek 连接或响应读取中断，本次内容未交付，请重试。');
      }
      emit('failed', true, { lastPhase });
      safeError.timing = { ...snapshot('failed'), lastPhase };
      throw safeError;
    } finally {
      clearTimeout(timeout);
      if (reader) {
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
        try { reader.releaseLock(); } catch {}
      }
    }
  };
}

module.exports = { createDeepSeekClient };
