const { SKILL_TEXT } = require('./storyboard-skill.cjs');

const STATS = ['elapsedMs', 'firstResponseMs', 'firstReasoningMs', 'firstContentMs', 'waitingMs', 'thinkingMs', 'outputMs', 'reasoningChars', 'outputChars', 'streamed', 'requestId', 'lastPhase'];

function createWorkflowTiming({ script, onProgress = () => {}, now = Date.now, maxRepairs = 1, skillChars = SKILL_TEXT.length,
  provider = 'deepseek', model = 'deepseek-flash', reasoningEffort = 'high' }) {
  const startedAt = now();
  const state = {
    schemaVersion: 1, sequence: 0, status: 'running', phase: 'preparing',
    startedAt, updatedAt: startedAt, elapsedMs: 0, preparationMs: 0,
    prompt: { systemChars: 0, skillChars: Number.isSafeInteger(skillChars) && skillChars >= 0 ? skillChars : SKILL_TEXT.length, inputChars: script.length,
      provider, model, thinkingMode: reasoningEffort === 'none' ? 'disabled' : 'enabled', reasoningEffort },
    repairCount: 0, maxRepairs, localValidationMs: 0, requests: [],
  };
  function publish() {
    state.updatedAt = now();
    state.elapsedMs = Math.max(0, state.updatedAt - startedAt);
    state.sequence += 1;
    const snapshot = structuredClone(state);
    // Closing a renderer or an observer must not invalidate an audited result.
    try { onProgress(snapshot); } catch { /* Observer errors are isolated. */ }
    return snapshot;
  }
  function prepare() { state.phase = 'preparing'; publish(); return now(); }
  function prepared(since, messages) {
    state.preparationMs += Math.max(0, now() - since);
    if (!state.prompt.systemChars) state.prompt.systemChars = messages.filter(item => item.role === 'system').reduce((sum, item) => sum + String(item.content || '').length, 0);
  }
  function beginRequest(kind, repairCount, messages) {
    const id = state.requests.length + 1;
    state.phase = kind;
    state.repairCount = repairCount;
    state.requests.push({
      id, kind, repairCount, startedAt: now(), status: 'running', phase: 'waiting', elapsedMs: 0,
      firstResponseMs: null, firstReasoningMs: null, firstContentMs: null,
      waitingMs: 0, thinkingMs: null, outputMs: null, reasoningChars: 0, outputChars: 0, streamed: false,
      systemChars: messages.filter(item => item.role === 'system').reduce((sum, item) => sum + String(item.content || '').length, 0),
      userChars: messages.filter(item => item.role === 'user').reduce((sum, item) => sum + String(item.content || '').length, 0),
    });
    publish();
    return id;
  }
  function updateRequest(id, event = {}) {
    const request = state.requests.find(item => item.id === id);
    if (!request || request.status !== 'running' || state.status !== 'running') return;
    for (const key of STATS) {
      const value = event[key];
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && value >= 0) || (['requestId', 'lastPhase'].includes(key) && typeof value === 'string')) request[key] = value;
    }
    if (['waiting', 'thinking', 'generating'].includes(event.phase)) request.phase = event.phase;
    publish();
  }
  function endRequest(id, timing = {}, failure) {
    updateRequest(id, timing);
    const request = state.requests.find(item => item.id === id);
    if (!request || request.status !== 'running') return;
    request.endedAt = now();
    request.elapsedMs = Math.max(0, request.endedAt - request.startedAt);
    request.lastPhase = timing.lastPhase || request.phase;
    if (request.firstReasoningMs === null && request.firstContentMs === null) request.waitingMs = request.elapsedMs;
    request.status = failure ? 'failed' : 'completed';
    request.phase = request.status;
    if (failure) request.error = String(failure.message || '请求未完成');
    publish();
  }
  function validating(repairCount) { state.phase = 'validating'; state.repairCount = repairCount; publish(); }
  function addValidation(since) { state.localValidationMs += Math.max(0, now() - since); }
  function terminal(status, failure) {
    if (state.status !== 'running') return structuredClone(state);
    for (const request of state.requests.filter(item => item.status === 'running')) endRequest(request.id, {}, failure || new Error('请求已结束'));
    state.status = status;
    state.phase = status;
    state.finishedAt = now();
    if (failure) state.error = String(failure.message || '本次生成未完成');
    return publish();
  }
  publish();
  return { prepare, prepared, beginRequest, updateRequest, endRequest, validating, addValidation, complete: ({ auditIgnored = false } = {}) => {
    state.auditIgnored = auditIgnored;
    return terminal('completed');
  }, fail: error => terminal('failed', error), snapshot: () => structuredClone(state) };
}

module.exports = { createWorkflowTiming };
