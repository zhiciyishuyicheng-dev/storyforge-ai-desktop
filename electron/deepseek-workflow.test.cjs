const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkflowRunner } = require('./deepseek-workflow.cjs');

function candidate(extra = {}) {
  return { storyboard: { shots: [{ no: '01', prompt: '候选正文' }], ...extra } };
}
// Transport/loop tests isolate publication from model claims. The real policy's
// timing, source-audio and all-60-rule cases are tested in storyboard-policy.
function policy({ candidateValid = true, acceptSubset = false } = {}) {
  return {
    validateCandidate: () => ({ valid: candidateValid, errors: candidateValid ? [] : [{ message: '时间码存在空档' }] }),
    validateAudit: (data, audit) => ({
      valid: audit?.verdict === 'pass' || audit?.verdict === 'blocked' && Boolean(data?.storyboard?.shots?.length),
      errors: audit?.verdict === 'revise' ? [{ message: '台词被改写' }] : [],
      acceptedBlockNos: audit?.verdict === 'pass' || data?.storyboard?.shots?.length && audit?.verdict === 'blocked'
        ? (acceptSubset ? [] : data.storyboard.shots.map((block) => block.no)) : [],
      blocked: audit?.verdict === 'blocked' && !data?.storyboard?.shots?.length,
      blockers: audit?.blockers || [],
    }),
    buildAuditSummary: (_data, audit, { repairCount }) => ({
      version: '2.1', repairCount, finalStatus: audit.verdict === 'blocked' ? '部分通过（存在阻塞）' : '全部通过',
    }),
    hasGenuineBlockers: (data, audit) => Boolean(data?.storyboard?.blockers?.length || audit?.blockers?.length),
    canPublishIgnoredCandidate: data => Boolean(data?.storyboard?.shots?.length && data.storyboard.shots.every(shot => typeof shot?.prompt === 'string' && shot.prompt.trim())),
    buildIgnoredAuditSummary: (_data, _audit, { repairCount, issues }) => ({
      version: '2.1', repairCount, finalStatus: '审计未通过（已忽略）', issues, blockers: [], scope: '文本与计划',
    }),
  };
}

function transport(responses) {
  const calls = [];
  return {
    calls,
    request: async (messages, options) => {
      calls.push({ messages, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, 'Unexpected extra model request');
      return { model: 'deepseek-flash', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, ...next };
    },
  };
}

test('a workflow is published only after a separate audit; model-supplied pass metadata is discarded', async () => {
  const original = candidate({ auditSummary: { repairCount: 999, finalStatus: '全部通过' } });
  const api = transport([{ data: original }, { data: { verdict: 'pass' } }]);
  const result = await createWorkflowRunner({ request: api.request, policy: policy() })('原始声音：“别动。”');
  assert.deepEqual(api.calls.map((call) => call.options.phase), ['candidate', 'audit']);
  assert.equal(result.data.storyboard.auditSummary.repairCount, 0);
  assert.equal(result.data.storyboard.verification.requestCount, 2);
  assert.equal(result.data.storyboard.verification.scope, '文本与计划');
  assert.equal(original.storyboard.auditSummary.repairCount, 999, 'Do not mutate the original response object');
  assert.equal(api.calls[1].messages[1].content.includes('999'), false);
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 });
});

test('a failed independent audit triggers a real repair request and a complete new audit', async () => {
  const api = transport([
    { data: candidate() }, { data: { verdict: 'revise' } },
    { data: candidate({ shots: [{ no: '01', prompt: '修正后的正文' }] }) }, { data: { verdict: 'pass' } },
  ]);
  const progress = [];
  const result = await createWorkflowRunner({ request: api.request, policy: policy(), onProgress: event => progress.push(event) })('锁定原文');
  assert.deepEqual(api.calls.map((call) => call.options.phase), ['candidate', 'audit', 'repair', 'audit']);
  for (const call of api.calls) {
    assert.equal(Object.hasOwn(call.options, 'maxTokens'), false, `${call.options.phase} must not impose an application output-token limit`);
  }
  assert.equal(result.data.storyboard.shots[0].prompt, '修正后的正文');
  assert.equal(result.data.storyboard.auditSummary.repairCount, 1);
  assert.ok(api.calls[2].messages[1].content.includes('台词被改写'));
  assert.equal(progress.at(-1).phase, 'completed');
});

test('one failed repair audit continues with an explicit unapproved result and no further requests', async () => {
  const api = transport(Array.from({ length: 2 }, () => [{ data: candidate() }, { data: { verdict: 'revise' } }]).flat());
  const result = await createWorkflowRunner({ request: api.request, policy: policy() })('锁定原文');
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '审计未通过（已忽略）');
  assert.equal(result.data.storyboard.verification.repairCount, 1);
  assert.equal(result.data.storyboard.verification.auditIgnored, true);
  assert.equal(result.data.storyboard.verification.auditPassed, false);
  assert.equal(result.data.storyboard.auditRecord.verdict, 'revise');
  assert.ok(result.data.storyboard.auditSummary.issues.some(issue => issue.message === '台词被改写'));
  assert.equal(result.progress.status, 'completed');
  assert.equal(result.progress.auditIgnored, true);
  assert.equal(result.progress.maxRepairs, 1);
  assert.equal(api.calls.length, 4);
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit', 'repair', 'audit']);
});

test('missing formal prompt still fails after only one repair', async () => {
  const api = transport(Array.from({ length: 2 }, () => [{ data: candidate({ shots: [{ no: '01' }] }) }, { data: { verdict: 'pass' } }]).flat());
  await assert.rejects(createWorkflowRunner({ request: api.request, policy: policy({ candidateValid: false }) })('原文'), error => {
    assert.equal(error.code, 'STORYBOARD_AUDIT_FAILED');
    assert.equal(error.repairCount, 1);
    assert.match(error.message, /时间码存在空档/);
    return true;
  });
  assert.equal(api.calls.length, 4);
});

test('local content audit failures also become warnings after one repair', async () => {
  const api = transport(Array.from({ length: 2 }, () => [{ data: candidate() }, { data: { verdict: 'pass' } }]).flat());
  const result = await createWorkflowRunner({ request: api.request, policy: policy({ candidateValid: false }) })('原文');
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '审计未通过（已忽略）');
  assert.equal(result.data.storyboard.verification.auditPassed, false);
  assert.ok(result.data.storyboard.auditSummary.issues.some(issue => issue.message === '时间码存在空档'));
  assert.equal(api.calls.length, 4);
});

test('an unparseable final audit is retained as unknown and can be ignored after the one repair', async () => {
  const api = transport([{ data: candidate() }, { data: { verdict: 'revise' } }, { data: candidate() }, { data: null, rawContent: '{broken audit' }]);
  const result = await createWorkflowRunner({ request: api.request, policy: policy() })('原文');
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '审计未通过（已忽略）');
  assert.equal(result.data.storyboard.auditRecord, null);
  assert.equal(result.data.storyboard.verification.requestCount, 4);
});

test('real story blockers and transport failures cannot be presented as ignored audit checks', async () => {
  const blocker = { id: 'B01', question: '缺少原始信件内容' };
  const blocked = transport([{ data: candidate() }, { data: { verdict: 'revise', blockers: [blocker] } }, { data: candidate() }, { data: { verdict: 'revise', blockers: [blocker] } }]);
  await assert.rejects(createWorkflowRunner({ request: blocked.request, policy: policy() })('原文'), /未交付候选/);
  const broken = transport([{ data: candidate() }, { data: { verdict: 'revise' } }, { data: candidate() }, new Error('请求超时')]);
  await assert.rejects(createWorkflowRunner({ request: broken.request, policy: policy() })('原文'), /请求超时/);
});

test('the one-repair ceiling cannot be raised by caller options', () => {
  assert.throws(() => createWorkflowRunner({ request: async () => {}, maxRepairs: 3 }), /0 or 1/);
});

test('even a passing model audit cannot override deterministic errors', async () => {
  const api = transport([{ data: candidate() }, { data: { verdict: 'pass' } }]);
  await assert.rejects(createWorkflowRunner({ request: api.request, policy: policy({ candidateValid: false }), maxRepairs: 0 })('原文'), /时间码存在空档/);
});

test('no unaccepted candidate block is published under a partial-pass claim', async () => {
  const api = transport([{ data: candidate() }, { data: { verdict: 'pass' } }]);
  await assert.rejects(createWorkflowRunner({ request: api.request, policy: policy({ acceptSubset: true }), maxRepairs: 0 })('原文'), /正式结果只能包含独立审计通过/);
});

test('malformed candidate JSON is regenerated without pretending its content was audited', async () => {
  const api = transport([{ data: null, rawContent: '{broken' }, { data: candidate() }, { data: { verdict: 'pass' } }]);
  const result = await createWorkflowRunner({ request: api.request, policy: policy() })('原文');
  assert.deepEqual(api.calls.map((call) => call.options.phase), ['candidate', 'repair', 'audit']);
  assert.equal(result.data.storyboard.auditSummary.repairCount, 1);
});

test('a truncated response cannot be accepted even if the JSON appears complete', async () => {
  const api = transport([{ data: candidate(), truncated: true }]);
  await assert.rejects(createWorkflowRunner({ request: api.request, policy: policy(), maxRepairs: 0 })('原文'), /输出长度上限截断/);
  assert.equal(api.calls.length, 1);
});

test('the final repair cannot ignore a truncated candidate even if its JSON can be displayed', async () => {
  const api = transport([{ data: candidate() }, { data: { verdict: 'revise' } }, { data: candidate(), truncated: true }]);
  await assert.rejects(createWorkflowRunner({ request: api.request, policy: policy() })('原文'), error => {
    assert.equal(error.repairCount, 1);
    assert.match(error.message, /输出长度上限截断/);
    return true;
  });
  assert.equal(api.calls.length, 3);
});

test('independently approved partial content retains its real blocker separately from copied prompts', async () => {
  const blocker = { id: 'B01', question: '请补充缺失的信件原文。' };
  const api = transport([{ data: candidate({ blockers: [blocker] }) }, { data: { verdict: 'blocked', blockers: [blocker] } }]);
  const result = await createWorkflowRunner({ request: api.request, policy: policy() })('现有原文');
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '部分通过（存在阻塞）');
  assert.equal(result.data.storyboard.shots[0].prompt, '候选正文');
});

test('an independently confirmed zero-delivery blocker requests missing information', async () => {
  const blocker = { id: 'B01', question: '谁持有关键道具？' };
  const api = transport([{ data: candidate({ shots: [] }) }, { data: { verdict: 'blocked', blockers: [blocker] } }]);
  await assert.rejects(createWorkflowRunner({ request: api.request, policy: policy() })('原文'), error => {
    assert.equal(error.code, 'STORYBOARD_BLOCKED');
    assert.match(error.message, /谁持有关键道具/);
    return true;
  });
  assert.equal(api.calls.length, 2);
});

test('transport failures are never converted into passed audits or fictional story blockers', async () => {
  const api = transport([{ data: candidate() }, new Error('网络中断')]);
  await assert.rejects(createWorkflowRunner({ request: api.request, policy: policy() })('原文'), /网络中断/);
  assert.equal(api.calls.length, 2);
});
