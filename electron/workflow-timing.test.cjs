const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkflowTiming } = require('./workflow-timing.cjs');

function clock() {
  let time = 1000;
  const events = [];
  const timing = createWorkflowTiming({ script: '原始输入', onProgress: event => events.push(event), now: () => time });
  return { timing, events, advance: ms => { time += ms; } };
}
const messages = [{ role: 'system', content: '系统提示词' }, { role: 'user', content: '原始输入' }];

test('GPT timing records the selected model and effort instead of the DeepSeek defaults', () => {
  for (const reasoningEffort of ['none', 'low', 'medium', 'xhigh']) {
    const timing = createWorkflowTiming({ script: '输入', provider: 'codex-subscription', model: 'catalog-model', reasoningEffort });
    assert.deepEqual({ ...timing.snapshot().prompt, systemChars: 0, skillChars: 0, inputChars: 0 }, {
      systemChars: 0, skillChars: 0, inputChars: 0, provider: 'codex-subscription', model: 'catalog-model',
      reasoningEffort, thinkingMode: reasoningEffort === 'none' ? 'disabled' : 'enabled',
    });
  }
});

test('the Skill character count describes the active uploaded documents without exposing them', () => {
  const timing = createWorkflowTiming({ script: '原始输入', skillChars: 172 });
  assert.equal(timing.snapshot().prompt.skillChars, 172);
  assert.equal(JSON.stringify(timing.snapshot()).includes('content'), false);
});

test('preparation and each candidate/audit/repair request have independent measured timings', () => {
  const { timing, events, advance } = clock();
  const since = timing.prepare(); advance(3); timing.prepared(since, messages);
  for (const [kind, duration] of [['candidate', 70], ['audit', 30], ['repair', 40], ['audit', 20]]) {
    const id = timing.beginRequest(kind, kind === 'repair' ? 1 : 0, messages);
    advance(duration);
    timing.endRequest(id, { streamed: true, firstReasoningMs: 10, firstContentMs: 20, thinkingMs: 10, outputMs: duration - 20 });
  }
  const final = timing.complete();
  assert.equal(final.preparationMs, 3);
  assert.equal(final.prompt.systemChars, 5);
  assert.equal(final.prompt.inputChars, 4);
  assert.deepEqual(final.requests.map(item => item.kind), ['candidate', 'audit', 'repair', 'audit']);
  assert.deepEqual(final.requests.map(item => item.elapsedMs), [70, 30, 40, 20]);
  assert.equal(final.requests.filter(item => item.kind === 'audit').reduce((sum, item) => sum + item.elapsedMs, 0), 50);
  assert.equal(final.elapsedMs, 163);
  assert.equal(final.status, 'completed');
  assert.ok(events.every((item, index) => item.sequence === index + 1));
});

test('progress whitelists statistics and immutable copies exclude prompts and reasoning content', () => {
  const { timing, events } = clock();
  const id = timing.beginRequest('candidate', 0, messages);
  timing.updateRequest(id, { phase: 'thinking', thinkingMs: 12, reasoningChars: 55, reasoning_content: '秘密思考', content: '秘密正文', apiKey: '秘密密钥', usage: { unknown: '任意对象' } });
  const current = events.at(-1);
  assert.equal(current.requests[0].thinkingMs, 12);
  assert.doesNotMatch(JSON.stringify(current), /秘密|reasoning_content|apiKey|usage/);
  current.requests[0].thinkingMs = 999;
  assert.equal(timing.snapshot().requests[0].thinkingMs, 12);
});

test('request failures retain the last observed phase and freeze the final totals', () => {
  const { timing, advance } = clock();
  const id = timing.beginRequest('audit', 2, messages);
  advance(10); timing.updateRequest(id, { phase: 'thinking', firstReasoningMs: 10, thinkingMs: 0 });
  advance(90); timing.endRequest(id, { phase: 'failed', lastPhase: 'thinking', thinkingMs: 90 }, new Error('请求超时'));
  const failed = timing.fail(new Error('请求超时'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.requests[0].lastPhase, 'thinking');
  assert.equal(failed.requests[0].elapsedMs, 100);
  advance(5000); timing.updateRequest(id, { elapsedMs: 9000 });
  assert.deepEqual(timing.snapshot(), failed);
});

test('nonstreaming responses leave unmeasurable thought/output intervals unknown', () => {
  const { timing, advance } = clock();
  const id = timing.beginRequest('candidate', 0, messages); advance(50); timing.endRequest(id);
  const request = timing.complete().requests[0];
  assert.equal(request.streamed, false);
  assert.equal(request.thinkingMs, null);
  assert.equal(request.outputMs, null);
  assert.equal(request.waitingMs, 50);
});

test('a renderer observer exception cannot interrupt the generation pipeline', () => {
  const timing = createWorkflowTiming({ script: '输入', onProgress: () => { throw new Error('窗口关闭'); } });
  assert.doesNotThrow(() => timing.complete());
});
