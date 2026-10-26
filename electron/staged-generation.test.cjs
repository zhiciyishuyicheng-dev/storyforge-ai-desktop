const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createWorkflowRunner } = require('./deepseek-workflow.cjs');
const { outlineResult, normalizeConfirmedOutline } = require('./generation-stages.cjs');
const { validateCandidate, canPublishIgnoredCandidate, buildIgnoredAuditSummary } = require('./storyboard-policy.cjs');
const { makeSystemPrompt, makeAuditSystemPrompt } = require('./deepseek-prompt.cjs');

const script = '阿宁在书房打开信封，看见来信后抬头。';
const skills = { storyboard: { name: '分镜.md', content: '分镜专属要求：保持原文，按自然节点设计。' }, assets: { name: '资产.md', content: '资产专属要求：人物图使用版画风。' } };
const outline = () => ({ title: '分镜大纲', rows: [{ no: '01', duration: 5, scene: '书房', content: '阿宁打开来信。镜头观察拆信动作与读信后的反应。' }] });
const manifest = () => ({ characters: [{ name: '阿宁', fileName: '阿宁.png', description: '实际出镜人物' }], scenes: [{ name: '书房', fileName: '书房.png', description: '来信发生的书房' }], props: [], groups: [], characterChecklist: [{ name: '阿宁', requiresReferenceImage: true }], characterDifferenceMatrix: [] });
function storyboard() {
  return { outline: outline(), storyboard: { shots: [{ no: '01', duration: 5, title: '打开来信', scene: '书房', outline: outline().rows[0].content, sceneId: 'S01',
    uploads: [{ ref: '@阿宁', asset: '阿宁', purpose: '人物参考' }, { ref: '@书房', asset: '书房', purpose: '场景参考' }], segments: [{ time: '0-5秒', visual: '阿宁拆开信封，读信后抬头。' }], prompt: '阿宁在书房拆信并抬头的完整正式分镜。' }], blockers: [] }, assets: manifest() };
}
function audit(data, failed = false) {
  return { verdict: failed ? 'revise' : 'pass', blocks: data.storyboard.shots.map(shot => ({ no: shot.no, checks: [{ rule: '按用户规范保留原文与镜头计划', status: failed ? '失败' : '通过', note: '阿宁拆信与抬头两项动作已对照，时长和场景与确认大纲一致。' }] })),
    batchChecks: [{ rule: '完整覆盖原文和具名素材身份', status: '通过', note: '唯一生成块覆盖拆信和抬头，阿宁与书房名称准确。' }], issues: [], blockers: [], acceptedBlockNos: failed ? [] : data.storyboard.shots.map(shot => shot.no) };
}
function transport(responses) {
  const calls = [];
  return { calls, request: async (messages, options) => {
    calls.push({ messages, options });
    assert.ok(responses.length, 'No out-of-stage model calls');
    const data = responses.shift();
    return { data, model: 'test-model', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  } };
}

test('第一步只请求并交付大纲：不审计分镜、不提前使用资产Skill、完成后结束', async () => {
  for (const provider of ['deepseek', 'codex-subscription']) {
    const api = transport([{ outline: outline() }]);
    const progress = [];
    const result = await createWorkflowRunner({ request: api.request, provider, onProgress: event => progress.push(event) })(script, { stage: 'outline', stageSkills: skills });
    assert.equal(result.stage, 'outline');
    assert.deepEqual(result.data.outline.rows, outline().rows);
    assert.deepEqual(Object.keys(result.data), ['outline']);
    assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate']);
    assert.ok(api.calls[0].messages[0].content.includes(skills.storyboard.content));
    assert.ok(!api.calls[0].messages.some(message => message.content.includes(skills.assets.content)));
    assert.equal(progress.at(-1).status, 'completed');
    assert.equal(result.data.outline.verification.stageSkills.assets, null);
  }
});

test('大纲拒绝完整工作流和执行字段，最多修正一次且不泄漏下步结果', async () => {
  const invalid = { outline: outline(), storyboard: storyboard().storyboard };
  const api = transport([invalid, { outline: outline() }]);
  const result = await createWorkflowRunner({ request: api.request })(script, { stage: 'outline' });
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'repair']);
  assert.equal(Object.hasOwn(result.data, 'storyboard'), false);
  const row = { ...outline().rows[0], prompt: '不应提前生成执行正文' };
  assert.equal(outlineResult({ outline: { rows: [row] } }).valid, false);
  const broken = transport([invalid, invalid]);
  await assert.rejects(createWorkflowRunner({ request: broken.request })(script, { stage: 'outline' }), error => error.code === 'STAGE_VALIDATION_FAILED');
  assert.equal(broken.calls.length, 2);
});

test('大纲保留真实时长与范围，平台约束不静默改秒数', () => {
  for (const duration of [0, NaN, '5秒', 16, 2.5]) {
    const value = outline(); value.rows[0].duration = duration;
    assert.equal(outlineResult({ outline: value }).valid, false);
  }
  const value = outline(); value.rows[0].duration = 30;
  assert.equal(outlineResult({ outline: value }, { stageSkills: skills }).valid, true);
  assert.equal(outlineResult({ outline: value }, { stageSkills: skills, videoReady: true }).valid, false);
  value.rows[0].duration = 3;
  assert.equal(outlineResult({ outline: value }, { videoReady: true }).valid, false);
  value.rows[0].no = '03';
  assert.throws(() => normalizeConfirmedOutline(value), error => error.code === 'INVALID_CONFIRMED_OUTLINE');
});

test('第二步必须先有确认大纲，错误前置结果不发出模型请求', async () => {
  const api = transport([]);
  const runner = createWorkflowRunner({ request: api.request });
  await assert.rejects(runner(script, { stage: 'storyboard' }), error => error.code === 'INVALID_CONFIRMED_OUTLINE');
  await assert.rejects(runner(script, { stage: 'assets' }), error => error.code === 'INVALID_CONFIRMED_STORYBOARD');
  await assert.rejects(runner(script, { stage: 'unknown' }), error => error.code === 'INVALID_WORKFLOW_STAGE');
  assert.equal(api.calls.length, 0);
});

test('第二步独立审计分镜，仅生成素材身份，严格继承用户确认大纲', async () => {
  const value = storyboard();
  const original = structuredClone(value);
  const context = { stage: 'storyboard', confirmedOutline: outline(), stageSkills: skills };
  assert.equal(validateCandidate(value, { script, context }).valid, true);
  assert.equal(canPublishIgnoredCandidate(value, { context }), true);
  assert.equal(validateCandidate(value, { script, context: { stageSkills: skills } }).valid, false, 'Legacy combined stage still needs production asset prompts');
  const api = transport([value, audit(value)]);
  const result = await createWorkflowRunner({ request: api.request })(script, context);
  assert.equal(result.stage, 'storyboard');
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '全部通过');
  assert.deepEqual(result.data.outline, outline());
  assert.ok(!result.data.assets.characters[0].prompt);
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit']);
  for (const call of api.calls) assert.ok(!call.messages.some(message => message.content.includes(skills.assets.content)));
  assert.deepEqual(value, original);
  assert.equal(result.data.storyboard.verification.stageSkills.assets, null);
});

test('回炉不能擅改确认大纲，时长或内容冲突在一次修正后仍阻止交付', async () => {
  for (const change of [data => data.storyboard.shots[0].duration = 6, data => data.storyboard.shots[0].outline = '改成另一个事件', data => data.assets.characters[0].prompt = '提前生产资产提示词']) {
    const value = storyboard(); change(value);
    const api = transport([value, audit(value), value, audit(value)]);
    await assert.rejects(createWorkflowRunner({ request: api.request })(script, { stage: 'storyboard', confirmedOutline: outline(), stageSkills: skills }), error => error.code === 'STORYBOARD_AUDIT_FAILED');
    assert.equal(api.calls.length, 4);
  }
  const bad = storyboard(); bad.storyboard.shots[0].duration = 6;
  const fixed = storyboard();
  const api = transport([bad, audit(bad), fixed, audit(fixed)]);
  const result = await createWorkflowRunner({ request: api.request })(script, { stage: 'storyboard', confirmedOutline: outline(), stageSkills: skills });
  assert.equal(result.data.storyboard.shots[0].duration, 5);
  assert.equal(result.data.storyboard.verification.repairCount, 1);
});

test('第二步一次回炉后保留审计警告，不要求提前生成资产提示词', async () => {
  const value = storyboard();
  const api = transport([value, audit(value, true), value, audit(value, true)]);
  const result = await createWorkflowRunner({ request: api.request })(script, { stage: 'storyboard', confirmedOutline: outline(), stageSkills: skills });
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '审计未通过（已忽略）');
  assert.equal(result.data.storyboard.verification.repairCount, 1);
  assert.equal(api.calls.length, 4);
  const builtinSummary = buildIgnoredAuditSummary(value, null, { repairCount: 1, context: { stage: 'storyboard', confirmedOutline: outline() }, issues: [{ message: '时长计划仍待复核' }] });
  assert.equal(builtinSummary.finalStatus, '审计未通过（已忽略）');
});

test('分镜系统与审核提示词直接调用也不会提前应用资产Skill', () => {
  for (const build of [makeSystemPrompt, makeAuditSystemPrompt]) {
    const text = build({ stage: 'storyboard', stageSkills: skills });
    assert.ok(text.includes(skills.storyboard.content));
    assert.ok(!text.includes(skills.assets.content));
    assert.ok(text.includes('当前只执行第二步'));
  }
});

test('第三步只生成资产提示词并使用资产Skill，不改分镜或提前生图', async () => {
  const confirmed = storyboard();
  const assets = manifest();
  for (const kind of ['characters', 'scenes']) assets[kind].forEach(item => item.prompt = `${item.name}按资产规范生成的独立参考图完整提示词。`);
  const api = transport([{ assets }]);
  const result = await createWorkflowRunner({ request: api.request })(script, { stage: 'assets', confirmedStoryboard: confirmed, stageSkills: skills });
  assert.equal(result.stage, 'assets');
  assert.deepEqual(Object.keys(result.data), ['assets']);
  assert.equal(api.calls.length, 1);
  assert.ok(api.calls[0].messages[0].content.includes(skills.assets.content));
  assert.ok(!api.calls[0].messages.some(message => message.content.includes(skills.storyboard.content)));
  assert.deepEqual(confirmed, storyboard());
});

test('确认结果的原文指纹不匹配时停止，不以旧结果生成后续步骤', async () => {
  const api = transport([]);
  const runner = createWorkflowRunner({ request: api.request });
  const old = createHash('sha256').update('旧原文').digest('hex');
  const value = outline(); value.verification = { inputSha256: old };
  await assert.rejects(runner(script, { stage: 'storyboard', confirmedOutline: value }), error => error.code === 'STALE_CONFIRMED_OUTLINE');
  const board = storyboard(); board.storyboard.verification = { inputSha256: old };
  await assert.rejects(runner(script, { stage: 'assets', confirmedStoryboard: board }), error => error.code === 'STALE_CONFIRMED_STORYBOARD');
  assert.equal(api.calls.length, 0);
});
