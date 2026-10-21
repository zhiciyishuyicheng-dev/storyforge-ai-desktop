import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialWorkflowProgress, finishWorkflowProgress, formatProgressDuration, normalizeWorkflowProgress, summarizeWorkflowProgress } from './workflow-progress.js';

function progress(overrides = {}) {
  return {
    schemaVersion: 1, runId: 'run-1', projectId: 'project-1', sequence: 5, status: 'running', phase: 'audit',
    startedAt: 1000, updatedAt: 10000, elapsedMs: 9000, preparationMs: 12,
    prompt: { systemChars: 44000, skillChars: 43000, inputChars: 420, thinkingMode: 'enabled', reasoningEffort: 'high' },
    repairCount: 1, maxRepairs: 3, localValidationMs: 30,
    requests: [
      { id: 1, kind: 'candidate', status: 'completed', phase: 'completed', startedAt: 1012, endedAt: 6012, elapsedMs: 5000, waitingMs: 1000, thinkingMs: 3000, outputMs: 1000, firstResponseMs: 30, firstReasoningMs: 1000, firstContentMs: 4000, streamed: true },
      { id: 2, kind: 'repair', status: 'completed', phase: 'completed', elapsedMs: 2000, waitingMs: 500, thinkingMs: null, outputMs: 1500 },
      { id: 3, kind: 'audit', status: 'running', phase: 'thinking', startedAt: 8012, elapsedMs: 1900, waitingMs: 400, thinkingMs: 1500, outputMs: null, firstResponseMs: 20, firstReasoningMs: 400, firstContentMs: null, streamed: true },
    ], ...overrides,
  };
}

test('GPT 进度持久保留本次选定模型和强度，禁用思考时不显示已启用', () => {
  for (const reasoningEffort of ['none', 'low', 'medium', 'xhigh']) {
    const initial = createInitialWorkflowProgress({ runId: 'r', projectId: 'p', inputChars: 5,
      provider: 'codex-subscription', model: 'catalog-model', reasoningEffort });
    const restored = normalizeWorkflowProgress(JSON.parse(JSON.stringify(initial)));
    assert.equal(restored.prompt.provider, 'codex-subscription');
    assert.equal(restored.prompt.model, 'catalog-model');
    assert.equal(restored.prompt.reasoningEffort, reasoningEffort);
    assert.equal(restored.prompt.thinkingMode, reasoningEffort === 'none' ? 'disabled' : 'enabled');
  }
  assert.equal(normalizeWorkflowProgress(progress({ prompt: { reasoningEffort: 'untrusted content' } })).prompt.reasoningEffort, '');
});

test('按请求归类统计，思考是包含关系且运行时按最新快照继续计时', () => {
  const value = summarizeWorkflowProgress(progress(), 11000);
  assert.equal(value.elapsedMs, 10000);
  assert.equal(value.generationMs, 7000);
  assert.equal(value.generationCount, 2);
  assert.equal(value.auditMs, 2900);
  assert.equal(value.thinkingMs, 5500);
  assert.equal(value.auditCount, 1);
  assert.equal(value.current.waitingMs, 400);
  assert.equal(value.current.thinkingMs, 2500);
});

test('等待首段不误计为模型思考，未观测思考保持未知', () => {
  const value = summarizeWorkflowProgress(progress({ requests: [{ id: 1, kind: 'candidate', status: 'running', phase: 'waiting', elapsedMs: 9000, waitingMs: 9000 }] }), 12000);
  assert.equal(value.current.waitingMs, 11000);
  assert.equal(value.thinkingMs, null);
  assert.equal(value.current.firstContentMs, null);
});

test('完成、失败与停止终态冻结所有计时', () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    const finished = finishWorkflowProgress(progress(), status, status === 'failed' ? '连接超时' : '', 11000);
    const later = summarizeWorkflowProgress(finished, 9999999);
    assert.equal(later.elapsedMs, 10000);
    assert.equal(later.current.status, status);
    assert.equal(later.auditMs, 2900);
    assert.equal(later.thinkingMs, 5500);
    assert.equal(later.current.lastPhase, 'thinking');
  }
});

test('失败快照保留合法的失败前接收阶段，拒绝未知字段值', () => {
  for (const lastPhase of ['waiting', 'thinking', 'generating']) {
    const value = progress({ status: 'failed', phase: 'failed', requests: [{ id: 1, kind: 'candidate', status: 'failed', phase: 'failed', lastPhase }] });
    assert.equal(normalizeWorkflowProgress(value).requests[0].lastPhase, lastPhase);
  }
  const value = progress({ requests: [{ id: 1, kind: 'candidate', status: 'failed', phase: 'failed', lastPhase: '任意原文' }] });
  assert.equal(normalizeWorkflowProgress(value).requests[0].lastPhase, undefined);
});

test('存储仅接受遥测白名单，清除原文、思考内容和密钥', () => {
  const value = progress();
  value.script = '敏感剧本'; value.apiKey = 'sk-secret'; value.reasoning = '模型思考原文';
  value.requests[0].reasoning_content = '模型思考原文'; value.requests[0].content = '完整分镜';
  value.prompt.system = '系统提示词全文';
  const stored = JSON.stringify(normalizeWorkflowProgress(value));
  assert.doesNotMatch(stored, /敏感剧本|sk-secret|模型思考原文|完整分镜|系统提示词全文/);
  assert.match(stored, /44000/);
  assert.equal(normalizeWorkflowProgress({ schemaVersion: 99, requests: [] }), null);
});

test('初始状态只显示正在准备，格式化不生成百分比或倒计时', () => {
  const initial = createInitialWorkflowProgress({ runId: 'r', projectId: 'p', inputChars: 500, now: 1000 });
  assert.equal(initial.preparationMs, null);
  assert.equal(initial.prompt.inputChars, 500);
  assert.equal(initial.maxRepairs, 1);
  assert.equal(initial.auditIgnored, false);
  assert.equal(formatProgressDuration(null), '—');
  assert.equal(formatProgressDuration(12), '12 毫秒');
  assert.equal(formatProgressDuration(305500), '5 分 05 秒');
});

test('新进度默认只回炉一次，历史明确设置保留，审计忽略只接受布尔标记', () => {
  assert.equal(normalizeWorkflowProgress(progress({ maxRepairs: undefined })).maxRepairs, 1);
  assert.equal(normalizeWorkflowProgress(progress({ maxRepairs: 3 })).maxRepairs, 3);
  assert.equal(normalizeWorkflowProgress(progress({ auditIgnored: '任意文本' })).auditIgnored, false);
  const done = finishWorkflowProgress(progress({ auditIgnored: true, maxRepairs: 1 }), 'completed', '', 11000);
  assert.equal(done.auditIgnored, true);
  assert.equal(done.status, 'completed');
  assert.equal(done.error, '');
});
