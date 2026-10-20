const number = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
const optionalNumber = (value) => value === null || value === undefined ? null : number(value, null);
const timestamp = (value) => Number.isFinite(value) ? value : (Date.parse(value) || 0);
const text = (value, length = 1000) => typeof value === 'string' ? value.slice(0, length) : '';

// Whitelist telemetry fields: source text, generated content, reasoning and credentials never enter project storage.
export function normalizeWorkflowProgress(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.requests)) return null;
  const statuses = ['running', 'completed', 'failed', 'stopped'];
  const phases = ['preparing', 'candidate', 'audit', 'repair', 'validating', 'completed', 'failed', 'stopped'];
  if (!statuses.includes(value.status) || !phases.includes(value.phase)) return null;
  return {
    schemaVersion: 1, runId: text(value.runId, 160), projectId: text(value.projectId, 160), sequence: number(value.sequence),
    status: value.status, phase: value.phase, startedAt: timestamp(value.startedAt), updatedAt: timestamp(value.updatedAt),
    ...(value.finishedAt ? { finishedAt: timestamp(value.finishedAt) } : {}), elapsedMs: number(value.elapsedMs),
    preparationMs: optionalNumber(value.preparationMs),
    prompt: {
      systemChars: number(value.prompt?.systemChars), skillChars: number(value.prompt?.skillChars), inputChars: number(value.prompt?.inputChars),
      thinkingMode: value.prompt?.thinkingMode === 'enabled' ? 'enabled' : '', reasoningEffort: value.prompt?.reasoningEffort === 'high' ? 'high' : '',
    },
    repairCount: number(value.repairCount), maxRepairs: number(value.maxRepairs, 1), localValidationMs: number(value.localValidationMs),
    auditIgnored: value.auditIgnored === true,
    error: text(value.error),
    requests: value.requests.slice(-100).filter((item) => item && ['candidate', 'audit', 'repair'].includes(item.kind)).map((item) => ({
      id: number(item.id), kind: item.kind, repairCount: number(item.repairCount), startedAt: timestamp(item.startedAt),
      ...(item.endedAt ? { endedAt: timestamp(item.endedAt) } : {}),
      status: statuses.includes(item.status) ? item.status : 'failed',
      phase: ['waiting', 'thinking', 'generating', 'completed', 'failed', 'stopped'].includes(item.phase) ? item.phase : 'waiting',
      ...(['waiting', 'thinking', 'generating'].includes(item.lastPhase) ? { lastPhase: item.lastPhase } : {}),
      elapsedMs: number(item.elapsedMs), firstResponseMs: optionalNumber(item.firstResponseMs), firstReasoningMs: optionalNumber(item.firstReasoningMs),
      firstContentMs: optionalNumber(item.firstContentMs), waitingMs: number(item.waitingMs), thinkingMs: optionalNumber(item.thinkingMs), outputMs: optionalNumber(item.outputMs),
      reasoningChars: number(item.reasoningChars), outputChars: number(item.outputChars), streamed: Boolean(item.streamed), error: text(item.error),
    })),
  };
}

export function createInitialWorkflowProgress({ runId, projectId, inputChars, now = Date.now() }) {
  return normalizeWorkflowProgress({ schemaVersion: 1, runId, projectId, sequence: 0, status: 'running', phase: 'preparing', startedAt: now, updatedAt: now,
    elapsedMs: 0, preparationMs: null, prompt: { inputChars, thinkingMode: 'enabled', reasoningEffort: 'high' }, repairCount: 0, maxRepairs: 1, requests: [] });
}

export function summarizeWorkflowProgress(value, now = Date.now()) {
  const progress = normalizeWorkflowProgress(value);
  if (!progress) return null;
  const delta = progress.status === 'running' ? Math.max(0, now - progress.updatedAt) : 0;
  const requests = progress.requests.map((request) => {
    if (request.status !== 'running') return request;
    return { ...request, elapsedMs: request.elapsedMs + delta,
      waitingMs: request.waitingMs + (request.phase === 'waiting' ? delta : 0),
      thinkingMs: request.thinkingMs === null ? null : request.thinkingMs + (request.phase === 'thinking' ? delta : 0),
      outputMs: request.outputMs === null ? null : request.outputMs + (request.phase === 'generating' ? delta : 0) };
  });
  const current = requests.findLast((request) => request.status === 'running') || requests.at(-1) || null;
  const generation = requests.filter((request) => request.kind !== 'audit');
  const audits = requests.filter((request) => request.kind === 'audit');
  const observedThinking = requests.filter((request) => request.thinkingMs !== null);
  return { ...progress, requests, elapsedMs: progress.elapsedMs + delta, current,
    generationMs: generation.reduce((sum, request) => sum + request.elapsedMs, 0), generationCount: generation.length,
    auditMs: audits.reduce((sum, request) => sum + request.elapsedMs, 0), auditCount: audits.length,
    thinkingMs: observedThinking.length ? observedThinking.reduce((sum, request) => sum + request.thinkingMs, 0) : null,
  };
}

export function finishWorkflowProgress(value, status, error = '', now = Date.now()) {
  const progress = summarizeWorkflowProgress(value, now);
  if (!progress) return null;
  return normalizeWorkflowProgress({ ...progress, status, phase: status, updatedAt: now, finishedAt: now, error,
    requests: progress.requests.map((request) => request.status === 'running'
      ? { ...request, status, phase: status, lastPhase: request.phase, endedAt: now, ...(error ? { error } : {}) } : request) });
}

export function formatProgressDuration(value) {
  if (value === null || value === undefined) return '—';
  const milliseconds = number(value);
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}
