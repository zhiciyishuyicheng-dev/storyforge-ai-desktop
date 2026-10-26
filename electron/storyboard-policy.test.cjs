'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validateCandidate, validateAudit, buildAuditSummary, buildIgnoredAuditSummary, hasGenuineBlockers, canPublishIgnoredCandidate } = require('./storyboard-policy.cjs');
const { AUDIT_RULE_IDS, SKILL_SHA256 } = require('./storyboard-skill.cjs');
const { createWorkflowRunner } = require('./deepseek-workflow.cjs');

const BATCH = ['A1', 'A2', 'A3', 'A4', 'H1', 'H2', 'H3', 'H4', 'H5'];
const LINE = '我会把信送到，你在这里等我。';
const ORIGINAL = `阿青坐在窗边，右手托着白瓷杯。阿青说：“${LINE}”`;
const clone = value => JSON.parse(JSON.stringify(value));

function updatePrompt(candidate) {
  for (const shot of candidate.storyboard.shots) {
    shot.prompt = `🎬 生成块 ${shot.no}（时长：${shot.duration}秒）\n\n本段总时长：${shot.duration}秒\n人物：@Image1 是阿青（参考音色：成年女声，中音清晰，语气克制）\n场景：@Image2 是书房（白天，窗在东侧，桌在窗下）\n\n（无对白字幕，无BGM，中文配音，东方古装影视级CG写实风格）\n\n空间与位置保持稳定：阿青坐在东窗下，面向西侧房门，右手托着白瓷杯。\n\n${shot.segments.map(segment => `[${segment.time}] ${segment.visual}`).join('\n\n')}`;
  }
  return candidate;
}

function candidate({ voice = false, duration = 8, twoShots = false } = {}) {
  const value = {
    outline: { title: '分镜大纲' },
    assets: {
      characters: [{ name: '阿青', fileName: '人物-阿青-参考图.png', prompt: '阿青的独立单人参考图，成年女子，古装衣着，清楚展示脸部与全身服装轮廓，不含文字。' }],
      scenes: [{ name: '书房', fileName: '场景-书房-参考图.png', prompt: '白天古装书房的一张单机位空镜图，东侧窗户下有木桌，西侧有房门，空间结构清楚，不含文字。' }],
      groups: [], props: [], characterChecklist: [{ name: '阿青', requiresReferenceImage: true }], characterDifferenceMatrix: [{ name: '阿青', faceCode: 'C01' }],
    },
    storyboard: {
      skillVersion: '2.1', unifiedSuffix: '',
      shots: [{
        no: '01', title: '窗边的决定', duration, sceneId: '书房_白天', scene: '书房·白天',
        outline: '窗边的决定。阿青坐在东窗下托着白瓷杯，看向西侧房门；镜头观察她作出决定后的平静神情。',
        startState: '阿青坐在东窗下，面向西侧房门，右手托着白瓷杯。',
        endState: '阿青仍坐在东窗下，白瓷杯仍在右手，目光落在西侧房门。',
        uploads: [{ ref: '@Image1', asset: '阿青', purpose: '阿青唯一外观参考' }, { ref: '@Image2', asset: '书房', purpose: '白天书房唯一场景参考' }],
        segments: [{ time: `0-${duration}秒`, visual: '侧面中近景，阿青坐在东窗下，右手稳稳托住白瓷杯，目光落在西侧房门；摄影机固定，观察她作出决定后的平静神情。' }],
        sound: '窗外风声，杯底轻触桌面的声音。', prompt: '',
      }],
      voiceSources: [], voiceFragments: [], deferredVoices: [], blockers: [],
    },
  };
  const shot = value.storyboard.shots[0];
  if (twoShots) shot.segments = [
    { time: '0-4秒', visual: '侧面中近景，阿青坐在东窗下，右手托住白瓷杯，目光看向西侧房门。' },
    { time: `4-${duration}秒`, visual: '从房门一侧反打阿青近景，东窗位于她身后，阿青右手仍托着白瓷杯；她平静地看着房门。' },
  ];
  if (voice) {
    value.storyboard.voiceSources.push({ id: 'S001', speaker: '阿青', type: '对白', text: LINE });
    value.storyboard.voiceFragments.push({ id: 'F001', sourceId: 'S001', blockNo: '01', segmentIndex: 1, text: LINE, ...(twoShots ? { voiceId: 'V01', covers: [1, 2] } : {}) });
    shot.segments[0].visual += `【配音：阿青；${twoShots ? '语段V01连续覆盖第1—2镜；' : ''}状态：让对方放心；声音表现：正常语速，语气克制；台词：“${LINE}”】`;
    if (twoShots) shot.segments[1].visual += '【续音：V01连续承接，不重新起声】';
  }
  return updatePrompt(value);
}

function auditFor(value, verdict = 'pass') {
  return {
    verdict,
    blocks: value.storyboard.shots.map(shot => ({
      no: shot.no,
      checks: Object.fromEntries(AUDIT_RULE_IDS.map(id => [id, '通过'])),
      notes: {
        C6: '先估算原声自然发声与同步持杯表演，按整体节拍落切点，没有预填三秒格子。',
        C7: '坐姿、持杯和看向房门可以同步发生，镜内没有起身绕路等额外顺序操作。',
        C9: '指定范围已经到书房事件结尾，下一节点属于次日街道的新场景，不能接入。',
        D6: '声音自然发声约六秒；比较了切镜与同镜表演，当前画面保持杯与房门的关系，必要时在第二镜延续。',
        E9: '第二镜观察阿青表情，第一镜持杯的右手和东窗方向连续，没有重新起势。',
        E10: '固定构图明确观察阿青与房门的关系，使用转焦时从杯沿连续转到眼睛，不堆抽象运镜名。',
        F8: '阿青始终坐在东窗下，白瓷杯保持在右手，换机位时没有重演持杯起势或无依据换位。',
      },
    })),
    batchChecks: Object.fromEntries(BATCH.map(id => [id, '通过'])),
    batchNotes: {}, issues: [], blockers: [],
    acceptedBlockNos: value.storyboard.shots.map(shot => shot.no),
  };
}

function expectCode(result, code) {
  assert.equal(result.valid, false, `expected failure ${code}`);
  assert.ok(result.errors.some(error => error.code === code), JSON.stringify(result.errors));
}

function blocker(no = '02') {
  return { id: 'B001', affectedBlockNos: [no], reason: '下一场关键钥匙的持有者未在原文中明确。', question: '下一场钥匙由谁持有？', missingInformation: '下一场开始前钥匙的确认持有者。' };
}

test('一个完整生成块即可通过，不要求至少三块或固定十五秒', () => {
  const value = candidate();
  assert.deepEqual(Object.keys(value).sort(), ['assets', 'outline', 'storyboard']);
  assert.deepEqual(validateCandidate(value, { script: ORIGINAL }).errors, []);
  const result = validateAudit(value, auditFor(value), { script: ORIGINAL });
  assert.equal(result.valid, true);
  assert.deepEqual(result.acceptedBlockNos, ['01']);
  const summary = buildAuditSummary(value, auditFor(value), { repairCount: 2 });
  assert.equal(summary.finalStatus, '全部通过');
  assert.equal(summary.repairCount, 2);
  assert.equal(summary.scope, '文本与计划');
});

test('回炉一次后可保留未通过审计摘要，缺失证据明确显示而不伪造通过', () => {
  const value = candidate({ voice: true, twoShots: true });
  const audit = auditFor(value, 'revise');
  delete audit.blocks[0].notes.C6;
  delete audit.blocks[0].notes.C7;
  delete audit.blocks[0].notes.E9;
  const originalAudit = clone(audit);
  const gate = validateAudit(value, audit, { script: ORIGINAL });
  assert.equal(gate.valid, false);
  const summary = buildIgnoredAuditSummary(value, audit, { repairCount: 1, issues: gate.errors });
  assert.equal(summary.version, '2.1');
  assert.equal(summary.finalStatus, '审计未通过（已忽略）');
  assert.equal(summary.repairCount, 1);
  assert.equal(summary.range, '生成块01—01');
  assert.equal(summary.scope, '文本与计划');
  assert.deepEqual(summary.blockers, []);
  assert.equal(summary.rows.find(row => row.label === '节拍与动作耗时复核').status, '未通过');
  assert.equal(summary.rows.find(row => row.label === '运镜表达与连续变镜').status, '未通过');
  assert.ok(['C6', 'C7', 'E9'].every(id => summary.issues.some(issue => issue.ruleId === id && issue.blockNo === '01')));
  assert.deepEqual(audit, originalAudit);
  assert.equal(summary.acceptedBlockNos, undefined);
  assert.throws(() => buildAuditSummary(value, audit, { repairCount: 1 }), /完整通过/u);
});

test('审计 JSON 不完整或无效时，忽略摘要展示未通过或未核实而不冒充全部通过', () => {
  const value = candidate();
  for (const audit of [null, 'not json', {}, { verdict: 'revise', blocks: null, batchChecks: null }]) {
    const summary = buildIgnoredAuditSummary(value, audit, { repairCount: 1 });
    assert.equal(summary.finalStatus, '审计未通过（已忽略）');
    assert.ok(summary.rows.every(row => ['未通过', '未核实'].includes(row.status)));
    assert.ok(summary.issues.length > 0);
  }
});

test('重复块号的审计不能采用第一条通过结论冒充唯一有效审核', () => {
  const value = candidate();
  const audit = auditFor(value, 'revise');
  audit.blocks.push(clone(audit.blocks[0]));
  audit.blocks[1].checks.C1 = '失败';
  audit.blocks[1].notes.C1 = '第二条同号审计不能被第一条通过结果覆盖。';
  const gate = validateAudit(value, audit, { script: ORIGINAL });
  const summary = buildIgnoredAuditSummary(value, audit, { issues: gate.errors });
  assert.equal(summary.finalStatus, '审计未通过（已忽略）');
  assert.ok(summary.issues.some(issue => issue.code === 'AUDIT_BLOCK_COVERAGE'));
  assert.ok(['未通过', '未核实'].includes(summary.rows.find(row => row.label === '单块≤15秒').status));
  assert.equal(summary.rows.find(row => row.label === '单块≤5镜').status, '未通过');
  assert.equal(summary.rows.find(row => row.label === '空间与道具连续性').status, '未通过');
});

test('失败审计问题归一保留简短依据，不将思考或模型自报通过注入摘要', () => {
  const value = candidate();
  const audit = auditFor(value, 'revise');
  audit.blocks[0].checks.F1 = '失败';
  audit.blocks[0].notes.F1 = '第二镜未保持房门相对方向。';
  audit.reasoning_content = '模型内部思考，不应导出';
  audit.issues = [{ blockNo: 1, ruleId: 'F1', message: '第二镜未保持房门相对方向。', reasoning_content: '不能透传' }];
  const summary = buildIgnoredAuditSummary(value, audit, { issues: [{ code: 'AUDIT_EVIDENCE_REQUIRED', ruleId: 'C7', blockNo: '1', message: ' C7\n\t缺少实际复核事实。 ', reasoning: '不应透传' }] });
  assert.equal(summary.rows.find(row => row.label === '空间与道具连续性').status, '未通过');
  assert.deepEqual(summary.issues.find(issue => issue.code === 'AUDIT_EVIDENCE_REQUIRED'), { code: 'AUDIT_EVIDENCE_REQUIRED', blockNo: '01', ruleId: 'C7', message: 'C7 缺少实际复核事实。' });
  assert.equal(JSON.stringify(summary).includes('不应导出'), false);
  assert.equal(JSON.stringify(summary).includes('不能透传'), false);
  assert.equal(JSON.stringify(summary).includes('不应透传'), false);
});

test('忽略审计必须已有一次回炉且有完整生成块，真实剧情阻塞不能被忽略', () => {
  const value = candidate();
  const audit = auditFor(value, 'revise');
  assert.throws(() => buildIgnoredAuditSummary(value, audit, { repairCount: 0 }), /实际回炉/u);
  const empty = clone(value); empty.storyboard.shots = [];
  assert.throws(() => buildIgnoredAuditSummary(empty, audit), /完整可用/u);
  const blockedCandidate = clone(value); blockedCandidate.storyboard.blockers = [blocker()];
  assert.equal(hasGenuineBlockers(blockedCandidate, audit), true);
  assert.throws(() => buildIgnoredAuditSummary(blockedCandidate, audit), /剧情阻塞/u);
  const blockedAudit = clone(audit); blockedAudit.blockers = [blocker()];
  assert.equal(hasGenuineBlockers(value, blockedAudit), true);
  assert.throws(() => buildIgnoredAuditSummary(value, blockedAudit), /剧情阻塞/u);
  assert.deepEqual(validateCandidate(value, { script: ORIGINAL }).errors, []);
});

test('审计中技术失败伪阻塞会记录问题，但不会冒充真实剧情阻塞拦住忽略', () => {
  const value = candidate();
  const audit = auditFor(value, 'blocked');
  audit.blockers = [{ ...blocker(), reason: '接口请求失败，无法完成审核。', missingInformation: '接口请求失败，缺少审计结果。' }];
  assert.equal(hasGenuineBlockers(value, audit), false);
  const gate = validateAudit(value, audit, { script: ORIGINAL });
  const summary = buildIgnoredAuditSummary(value, audit, { issues: gate.errors });
  assert.equal(summary.finalStatus, '审计未通过（已忽略）');
  assert.ok(summary.issues.some(issue => issue.code === 'INVALID_AUDIT_BLOCKER'));
  assert.deepEqual(summary.blockers, []);
});

test('忽略交付只要求基础结构可用，时间轴、时长、原声、引用与标题问题作为警告保留', () => {
  const value = candidate({ voice: true });
  value.storyboard.shots[0].duration = 21;
  value.storyboard.shots[0].title = '';
  value.storyboard.shots[0].segments[0].time = '2-6秒';
  value.storyboard.shots[0].uploads[0].asset = '未登记的素材';
  value.storyboard.voiceFragments[0].text = '发生漏词。';
  assert.equal(validateCandidate(value, { script: ORIGINAL }).valid, false);
  assert.equal(canPublishIgnoredCandidate(value), true);
  const audit = auditFor(value, 'revise');
  const gate = validateAudit(value, audit, { script: ORIGINAL });
  const summary = buildIgnoredAuditSummary(value, audit, { issues: gate.errors });
  assert.equal(summary.finalStatus, '审计未通过（已忽略）');
  assert.ok(summary.issues.some(issue => issue.code === 'BLOCK_DURATION'));
  assert.ok(summary.issues.some(issue => issue.code.startsWith('VOICE_')));
  assert.equal(summary.rows.find(row => row.label === '单块≤15秒').status, '未通过');
});

test('忽略交付仍拒绝缺正文、null段、无效时长、坏素材及基础数组结构', () => {
  const mutations = [
    value => { value.storyboard.shots[0].prompt = ''; },
    value => { value.storyboard.shots[0].segments = [null]; },
    value => { value.storyboard.shots[0].segments[0].visual = ''; },
    value => { value.storyboard.shots[0].uploads = [null]; },
    value => { value.storyboard.shots[0].duration = 0; },
    value => { value.storyboard.shots[0].duration = Infinity; },
    value => { value.storyboard.shots[0].no = null; },
    value => { value.storyboard.shots[0].no = { unexpected: '01' }; },
    value => { value.outline = null; },
    value => { delete value.outline; },
    value => { value.assets.characters = [null]; },
    value => { value.assets.scenes[0].prompt = ''; },
    value => { value.assets.characterChecklist = [null]; },
  ];
  for (const mutate of mutations) {
    const value = candidate();
    mutate(value);
    assert.equal(canPublishIgnoredCandidate(value), false);
    assert.throws(() => buildIgnoredAuditSummary(value, auditFor(value)), /完整可用/u);
  }
  assert.equal(canPublishIgnoredCandidate(null), false);
  const technical = candidate();
  technical.storyboard.blockers = [{ ...blocker(), reason: 'API请求失败。', missingInformation: 'API请求失败。' }];
  assert.equal(canPublishIgnoredCandidate(technical), true);
  const actual = candidate(); actual.storyboard.blockers = [blocker()];
  assert.equal(canPublishIgnoredCandidate(actual), false);
});

test('不显示的声音与阻塞记录缺失仅保留警告，不阻止结构完整的分镜继续', () => {
  const value = candidate();
  for (const key of ['blockers', 'voiceSources', 'voiceFragments', 'deferredVoices']) delete value.storyboard[key];
  assert.equal(validateCandidate(value, { script: ORIGINAL }).valid, false);
  assert.equal(canPublishIgnoredCandidate(value), true);
  const audit = auditFor(value, 'revise');
  const checked = validateAudit(value, audit, { script: ORIGINAL });
  const summary = buildIgnoredAuditSummary(value, audit, { issues: checked.errors });
  assert.equal(summary.finalStatus, '审计未通过（已忽略）');
  assert.ok(summary.issues.some(issue => issue.code === 'RECORD_ARRAY'));
  value.storyboard.blockers = null;
  assert.equal(canPublishIgnoredCandidate(value), true);
});

test('三秒短块经实际范围接入复核可通过', () => {
  const value = candidate({ duration: 3 });
  assert.equal(validateAudit(value, auditFor(value), { script: ORIGINAL }).valid, true);
});

test('videoReady只按原始duration检查4—15整数并触发可修问题，用户Skill也不能覆盖平台输入范围', () => {
  const short = candidate({ duration: 3 });
  assert.equal(validateCandidate(short, { script: ORIGINAL }).valid, true);
  expectCode(validateCandidate(short, { script: ORIGINAL, context: { videoReady: true } }), 'VIDEO_DURATION');
  expectCode(validateAudit(short, auditFor(short), { script: ORIGINAL, context: { videoReady: true } }), 'VIDEO_DURATION');
  for (const duration of [3, 20, 4.5, '8']) {
    const value = candidate({ duration });
    const context = { videoReady: true, maxDuration: 30, precision: 'half-second' };
    const result = validateCandidate(value, { script: ORIGINAL, context });
    expectCode(result, 'VIDEO_DURATION');
    assert.equal(result.errors.find(issue => issue.code === 'VIDEO_DURATION').blockNo, '01');
    assert.equal(value.storyboard.shots[0].duration, duration);
  }
  for (const duration of [4, 15]) assert.equal(validateCandidate(candidate({ duration }), { script: ORIGINAL, context: { videoReady: true } }).valid, true);
  const custom = customCandidate();
  const context = { stageSkills: USER_SKILLS };
  assert.equal(validateCandidate(custom, { script: ORIGINAL, context }).valid, true);
  expectCode(validateCandidate(custom, { script: ORIGINAL, context: { ...context, videoReady: true } }), 'VIDEO_DURATION');
  expectCode(validateAudit(custom, customAudit(custom), { script: ORIGINAL, context: { ...context, videoReady: true } }), 'VIDEO_DURATION');
});

test('无声音的片段不制造配音或原声表', () => {
  const value = candidate();
  const audit = auditFor(value);
  for (const id of AUDIT_RULE_IDS.filter(id => id.startsWith('D'))) { audit.blocks[0].checks[id] = '不适用'; audit.blocks[0].notes[id] = '原文无任何需要发声的内容，当前仅有环境与动作音。'; }
  assert.equal(validateAudit(value, audit, { script: '阿青看向房门。' }).valid, true);
});

test('同一生成块的 V 编号连续承载长声音，仅首次写完整原文', () => {
  const value = candidate({ voice: true, twoShots: true });
  assert.deepEqual(validateCandidate(value, { script: ORIGINAL }).errors, []);
  assert.equal(validateAudit(value, auditFor(value), { script: ORIGINAL }).valid, true);
});

test('六秒单镜对白经过画面承载检查可以保留长镜头', () => {
  const value = candidate({ voice: true });
  const audit = auditFor(value);
  audit.blocks[0].notes.D6 = '比较了反打和同镜调度，固定构图中杯与房门关系持续清楚，人物克制的表演有明确价值。';
  assert.equal(validateAudit(value, audit, { script: ORIGINAL }).valid, true);
});

test('反打作为时间片的新机位、连续转焦均不按关键词误判硬切', () => {
  const value = candidate({ twoShots: true });
  value.storyboard.shots[0].segments[1].visual += '焦点从杯沿连续转到阿青的眼睛，摄影机保持固定。';
  updatePrompt(value);
  assert.equal(validateAudit(value, auditFor(value), { script: ORIGINAL }).valid, true);
});

test('超出十五秒拒绝，不能通过模型自报通过放行', () => {
  const value = candidate({ duration: 16 });
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'BLOCK_DURATION');
  expectCode(validateAudit(value, auditFor(value), { script: ORIGINAL }), 'BLOCK_DURATION');
});

test('六个时间片超镜头数即拒绝', () => {
  const value = candidate({ duration: 6 });
  value.storyboard.shots[0].segments = Array.from({ length: 6 }, (_, index) => ({ time: `${index}-${index + 1}秒`, visual: '固定机位，阿青观察房门。' }));
  updatePrompt(value);
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'SHOT_COUNT');
});

test('时间空档、重叠、非零起点和末点不等总长均被拒绝', () => {
  for (const times of [['1-4秒', '4-8秒'], ['0-3秒', '4-8秒'], ['0-5秒', '4-8秒']]) {
    const value = candidate({ twoShots: true });
    value.storyboard.shots[0].segments.forEach((segment, index) => { segment.time = times[index]; });
    updatePrompt(value);
    expectCode(validateCandidate(value, { script: ORIGINAL }), 'TIMELINE');
  }
  const value = candidate();
  value.storyboard.shots[0].segments[0].time = '0-7秒';
  updatePrompt(value);
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'TIMELINE_END');
});

test('默认整数切点；用户明确指定的半秒精度可执行', () => {
  const value = candidate({ duration: 3.5 });
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'TIME_PRECISION');
  assert.equal(validateCandidate(value, { script: ORIGINAL, context: { precision: 'half' } }).valid, true);
});

test('用户明确更新有效时长与镜头上限后按当前规格校验', () => {
  const value = candidate({ duration: 16 });
  assert.equal(validateCandidate(value, { script: ORIGINAL, context: { maxDuration: 20 } }).valid, true);
});

test('锁稿片段改写、漏标点和重复原文均拒绝', () => {
  for (const text of [LINE.replace('把信送到', '送这封信'), LINE.slice(0, -1), LINE + LINE]) {
    const value = candidate({ voice: true });
    value.storyboard.voiceFragments[0].text = text;
    value.storyboard.shots[0].segments[0].visual = value.storyboard.shots[0].segments[0].visual.replace(LINE, text);
    updatePrompt(value);
    expectCode(validateCandidate(value, { script: ORIGINAL }), 'VOICE_COVERAGE_TEXT');
  }
});

test('原声、片段、正文即使内部一致也必须回查原始输入', () => {
  const value = candidate({ voice: true });
  const rewritten = '我保证一切安好，你先回家。';
  value.storyboard.voiceSources[0].text = rewritten;
  value.storyboard.voiceFragments[0].text = rewritten;
  value.storyboard.shots[0].segments[0].visual = value.storyboard.shots[0].segments[0].visual.replace(LINE, rewritten);
  updatePrompt(value);
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'VOICE_NOT_IN_ORIGINAL');
});

test('缺少原始剧本时不能使用生成的 candidate.script 自证原声', () => {
  const value = candidate({ voice: true });
  value.script = { text: ORIGINAL };
  expectCode(validateCandidate(value), 'VOICE_NOT_IN_ORIGINAL');
});

test('正文对白与片段记录不一致、说话者或声音类型错位拒绝', () => {
  const value = candidate({ voice: true });
  value.storyboard.shots[0].segments[0].visual = value.storyboard.shots[0].segments[0].visual.replace(LINE, '你先走。');
  updatePrompt(value);
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'SPOKEN_TEXT_MISMATCH');
  const wrongSpeaker = candidate({ voice: true });
  wrongSpeaker.storyboard.shots[0].segments[0].visual = wrongSpeaker.storyboard.shots[0].segments[0].visual.replace('【配音：阿青', '【配音（心声）：阿白');
  updatePrompt(wrongSpeaker);
  expectCode(validateCandidate(wrongSpeaker, { script: ORIGINAL }), 'SPEAKER_TYPE_MISMATCH');
});

test('重复 V 编号、错误覆盖区间与续音错位拒绝', () => {
  const value = candidate({ voice: true, twoShots: true });
  const second = clone(value.storyboard.voiceFragments[0]);
  second.id = 'F002';
  value.storyboard.voiceFragments.push(second);
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'DUPLICATE_VOICE_ID');
  const badCoverage = candidate({ voice: true, twoShots: true });
  badCoverage.storyboard.voiceFragments[0].covers = [1, 3];
  expectCode(validateCandidate(badCoverage, { script: ORIGINAL }), 'VOICE_COVERAGE');
  const wrongV = candidate({ voice: true, twoShots: true });
  wrongV.storyboard.shots[0].segments[1].visual = wrongV.storyboard.shots[0].segments[1].visual.replace('续音：V01', '续音：V02');
  updatePrompt(wrongV);
  expectCode(validateCandidate(wrongV, { script: ORIGINAL }), 'VOICE_CONTINUATION');
});

test('正文中新增未记录配音以及重复完整台词不能漏过', () => {
  const value = candidate();
  value.storyboard.shots[0].segments[0].visual += '【配音：阿青；状态：轻声；声音表现：平静；台词：“我来了。”】';
  updatePrompt(value);
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'SPOKEN_TEXT_MISMATCH');
});

test('有真实阻塞时原声可精确分配已呈现前段与顺延尾段', () => {
  const value = candidate({ voice: true });
  const first = '我会把信送到，';
  const tail = '你在这里等我。';
  value.storyboard.voiceFragments[0].text = first;
  value.storyboard.shots[0].segments[0].visual = value.storyboard.shots[0].segments[0].visual.replace(LINE, first);
  value.storyboard.deferredVoices = [{ sourceId: 'S001', text: tail, reason: 'B001：下一场钥匙持有者影响后续动作。' }];
  value.storyboard.blockers = [blocker()];
  updatePrompt(value);
  assert.equal(validateCandidate(value, { script: ORIGINAL }).valid, true);
  const audit = auditFor(value, 'blocked');
  audit.blockers = [blocker()];
  audit.batchChecks.A1 = '阻塞';
  audit.batchNotes.A1 = '已完成第一块；第二块钥匙持有者未知，相关尾段有准确顺延记录。';
  const result = validateAudit(value, audit, { script: ORIGINAL });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.partial, true);
  assert.equal(buildAuditSummary(value, audit).finalStatus, '部分通过（存在阻塞）');
});

test('没有真实阻塞不得使用顺延掩盖声音遗漏', () => {
  const value = candidate({ voice: true });
  value.storyboard.voiceFragments = [];
  value.storyboard.deferredVoices = [{ sourceId: 'S001', text: LINE, reason: '本次先不做' }];
  value.storyboard.shots[0].segments[0].visual = '阿青静静坐在东窗下。';
  updatePrompt(value);
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'DEFERRED_WITHOUT_BLOCKER');
});

test('素材身份逐字对应，旧编号不要求连续，但正文映射不能对调或缺失', () => {
  const missing = candidate();
  missing.storyboard.shots[0].uploads[0].asset = '阿青别名';
  expectCode(validateCandidate(missing, { script: ORIGINAL }), 'UPLOAD_ASSET');
  const ref = candidate();
  ref.storyboard.shots[0].uploads[1].ref = '@Image3';
  expectCode(validateCandidate(ref, { script: ORIGINAL }), 'UPLOAD_DECLARATION');
  ref.storyboard.shots[0].prompt = ref.storyboard.shots[0].prompt.replace('@Image2', '@Image3');
  assert.equal(validateCandidate(ref, { script: ORIGINAL }).valid, true);
  const switched = candidate();
  switched.storyboard.shots[0].prompt = switched.storyboard.shots[0].prompt.replace('@Image1 是阿青', '@Image1 是书房').replace('@Image2 是书房', '@Image2 是阿青');
  expectCode(validateCandidate(switched, { script: ORIGINAL }), 'UPLOAD_DECLARATION');
});

test('具名素材从生成到独立审计可直接通过，名称前缀相同也保持唯一身份', () => {
  const value = candidate();
  const shot = value.storyboard.shots[0];
  shot.uploads = shot.uploads.map(upload => ({ ...upload, ref: `@${upload.asset}` }));
  shot.prompt = shot.prompt.replace('@Image1 是阿青', '@阿青 ').replace('@Image2 是书房', '@书房 ');
  value.assets.props.push({ name: '阿青的杯子', fileName: '阿青的杯子.png', prompt: '白瓷杯单张参考图，杯身光洁。' });
  shot.uploads.push({ ref: '@阿青的杯子', asset: '阿青的杯子', purpose: '手中白瓷杯外观参考' });
  shot.prompt = shot.prompt.replace('场景：@书房', '道具：@阿青的杯子 （白瓷杯）\n场景：@书房');
  assert.deepEqual(validateCandidate(value, { script: ORIGINAL }).errors, []);
  assert.equal(validateAudit(value, auditFor(value), { script: ORIGINAL }).valid, true);
  const ambiguous = structuredClone(value);
  ambiguous.storyboard.shots[0].uploads[2].ref = '@阿青';
  expectCode(validateCandidate(ambiguous, { script: ORIGINAL }), 'UPLOAD_REF');
  const missing = structuredClone(value);
  missing.storyboard.shots[0].uploads.pop();
  expectCode(validateCandidate(missing, { script: ORIGINAL }), 'REFERENCE_LOCATION');
});

test('@ 只能在开头素材声明；正文与结构化时间片不能双版本', () => {
  const value = candidate();
  value.storyboard.shots[0].segments[0].visual += '@Image1';
  updatePrompt(value);
  expectCode(validateCandidate(value, { script: ORIGINAL }), 'INLINE_REFERENCE');
  const mismatch = candidate();
  mismatch.storyboard.shots[0].prompt = mismatch.storyboard.shots[0].prompt.replace('稳稳托住', '放下');
  expectCode(validateCandidate(mismatch, { script: ORIGINAL }), 'PROMPT_TIMELINE_MISMATCH');
});

test('每块全部六十项与全批九项缺一都不能通过', () => {
  const value = candidate();
  const missingBlock = auditFor(value);
  delete missingBlock.blocks[0].checks.F8;
  expectCode(validateAudit(value, missingBlock, { script: ORIGINAL }), 'AUDIT_MISSING_CHECK');
  const missingBatch = auditFor(value);
  delete missingBatch.batchChecks.H5;
  expectCode(validateAudit(value, missingBatch, { script: ORIGINAL }), 'AUDIT_MISSING_CHECK');
  assert.throws(() => buildAuditSummary(value, missingBlock), /独立审计/u);
});

test('无条件检查不可 NA，覆盖必须有用户明确授权及说明', () => {
  const value = candidate();
  const na = auditFor(value);
  na.blocks[0].checks.C1 = '不适用'; na.blocks[0].notes.C1 = '模型选择不做。';
  expectCode(validateAudit(value, na, { script: ORIGINAL }), 'AUDIT_INVALID_NA');
  const overridden = auditFor(value);
  overridden.blocks[0].checks.G6 = '本次被覆盖'; overridden.blocks[0].notes.G6 = '用户明确要求本次使用配乐。';
  expectCode(validateAudit(value, overridden, { script: ORIGINAL }), 'AUDIT_UNAUTHORIZED_OVERRIDE');
  assert.equal(validateAudit(value, overridden, { script: ORIGINAL, context: { overrides: { G6: '用户明确要求本次使用配乐' } } }).valid, true);
});

test('时长、动作、接入、长声音、运镜与连续性七项必须提供实际复核事实', () => {
  for (const id of ['C6', 'C7', 'C9', 'D6', 'E9', 'E10', 'F8']) {
    const value = candidate({ voice: true, twoShots: true });
    const audit = auditFor(value);
    audit.blocks[0].notes[id] = '已检查';
    expectCode(validateAudit(value, audit, { script: ORIGINAL }), 'AUDIT_EVIDENCE_REQUIRED');
    delete audit.blocks[0].notes[id];
    expectCode(validateAudit(value, audit, { script: ORIGINAL }), 'AUDIT_EVIDENCE_REQUIRED');
  }
  const value = candidate();
  const audit = auditFor(value);
  audit.blocks[0].checks.C9 = '不适用'; audit.blocks[0].notes.C9 = '当前只有八秒。';
  expectCode(validateAudit(value, audit, { script: ORIGINAL }), 'AUDIT_SHORT_BLOCK_NA');
});

test('verdict 自报 pass 不能掩盖失败检查、遗留问题或未交付候选', () => {
  const value = candidate();
  const failed = auditFor(value);
  failed.blocks[0].checks.C3 = '失败'; failed.blocks[0].notes.C3 = '同一片段存在两个硬切。';
  expectCode(validateAudit(value, failed, { script: ORIGINAL }), 'AUDIT_FAILED_CHECK');
  const issue = auditFor(value);
  issue.issues = [{ blockNo: '01', ruleId: 'B1', message: '本块拼接两个独立叙事场景。' }];
  expectCode(validateAudit(value, issue, { script: ORIGINAL }), 'AUDIT_UNRESOLVED_ISSUE');
  const omitted = auditFor(value); omitted.acceptedBlockNos = [];
  expectCode(validateAudit(value, omitted, { script: ORIGINAL }), 'AUDIT_FALSE_PASS');
});

test('独立审核不能清空调用方已有的本地失败', () => {
  const value = candidate();
  const result = validateAudit(value, auditFor(value), { script: ORIGINAL, localErrors: [{ code: 'PERSISTED_LOCAL_FAILURE', message: '先前的本地失败。' }] });
  expectCode(result, 'PERSISTED_LOCAL_FAILURE');
  assert.deepEqual(result.acceptedBlockNos, []);
});

test('partial 不允许受阻块留在 shots，也不允许通过块依赖阻塞', () => {
  const value = candidate();
  value.storyboard.blockers = [blocker('01')];
  const audit = auditFor(value, 'blocked');
  audit.blockers = [blocker('01')];
  expectCode(validateAudit(value, audit, { script: ORIGINAL }), 'AUDIT_FALSE_ACCEPTANCE');
  const dependent = candidate();
  dependent.storyboard.blockers = [blocker('02')];
  dependent.storyboard.shots[0].dependsOn = ['02'];
  const dependencyAudit = auditFor(dependent, 'blocked');
  dependencyAudit.blockers = [blocker('02')];
  expectCode(validateAudit(dependent, dependencyAudit, { script: ORIGINAL }), 'AUDIT_BLOCKED_DEPENDENCY');
});

test('技术重试耗尽或 JSON 截断不能伪装成需要用户补剧情', () => {
  const value = candidate();
  const technical = { ...blocker(), reason: 'JSON 输出截断，重试次数已耗尽。', missingInformation: '需要更多 token 上限。' };
  value.storyboard.blockers = [technical];
  const audit = auditFor(value, 'blocked'); audit.blockers = [technical];
  expectCode(validateAudit(value, audit, { script: ORIGINAL }), 'INVALID_AUDIT_BLOCKER');
});

test('真实零块阻塞可被明确识别，但不能伪装成最终通过', () => {
  const value = candidate();
  value.storyboard.shots = [];
  value.storyboard.blockers = [blocker('01')];
  const audit = auditFor(value, 'blocked');
  audit.blockers = [blocker('01')];
  audit.batchChecks.A1 = '阻塞'; audit.batchNotes.A1 = '第一块依赖缺失的钥匙持有者信息，无法自行补造。';
  const result = validateAudit(value, audit, { script: ORIGINAL });
  assert.equal(result.valid, false);
  assert.equal(result.blocked, true, JSON.stringify(result.errors));
  assert.equal(result.partial, false);
  assert.throws(() => buildAuditSummary(value, audit), /独立审计/u);
  delete audit.batchChecks.H3;
  assert.equal(validateAudit(value, audit, { script: ORIGINAL }).blocked, false);
});

test('坏结构作为可修正错误返回，不让本地校验进程崩溃', () => {
  for (const mutate of [value => { value.storyboard.shots = [null]; }, value => { value.storyboard.voiceSources = [null]; }, value => { value.storyboard.shots[0].segments = [null]; }, value => { value.storyboard.shots[0].segments = {}; }]) {
    const value = candidate(); mutate(value);
    assert.doesNotThrow(() => validateCandidate(value, { script: ORIGINAL }));
    assert.equal(validateCandidate(value, { script: ORIGINAL }).valid, false);
  }
});

test('基础工作流外壳、素材名称与文件名严格唯一', () => {
  const noOutline = candidate(); delete noOutline.outline;
  expectCode(validateCandidate(noOutline, { script: ORIGINAL }), 'OUTLINE_SHAPE');
  const noOutlineTitle = candidate(); noOutlineTitle.outline.title = '';
  expectCode(validateCandidate(noOutlineTitle, { script: ORIGINAL }), 'OUTLINE_TITLE');
  for (const key of ['scene', 'outline']) {
    const missing = candidate(); delete missing.storyboard.shots[0][key];
    expectCode(validateCandidate(missing, { script: ORIGINAL }), 'OUTLINE_BLOCK_FIELDS');
  }
  const noSceneId = candidate(); noSceneId.storyboard.shots[0].sceneId = '';
  expectCode(validateCandidate(noSceneId, { script: ORIGINAL }), 'SCENE_ID');
  const duplicateName = candidate(); duplicateName.assets.props.push({ ...duplicateName.assets.characters[0], fileName: '道具-杯-参考图.png' });
  expectCode(validateCandidate(duplicateName, { script: ORIGINAL }), 'ASSET_NAME_DUPLICATE');
  const duplicateFile = candidate(); duplicateFile.assets.scenes[0].fileName = duplicateFile.assets.characters[0].fileName.toUpperCase();
  expectCode(validateCandidate(duplicateFile, { script: ORIGINAL }), 'ASSET_FILENAME_DUPLICATE');
  const noImagePrompt = candidate(); noImagePrompt.assets.characters[0].prompt = '';
  expectCode(validateCandidate(noImagePrompt, { script: ORIGINAL }), 'ASSET_FIELDS');
  const missingCharacter = candidate(); missingCharacter.assets.characterChecklist.push({ name: '阿白', requiresReferenceImage: true });
  expectCode(validateCandidate(missingCharacter, { script: ORIGINAL }), 'REQUIRED_CHARACTER_IMAGE');
});

test('无人出镜或纯画外音允许人物记录与人物图数组为空', () => {
  const value = candidate();
  value.assets.characters = [];
  value.assets.characterChecklist = [];
  value.assets.characterDifferenceMatrix = [];
  const shot = value.storyboard.shots[0];
  shot.uploads = [{ ref: '@Image1', asset: '书房', purpose: '书房场景参考' }];
  shot.segments[0].visual = '固定全景，白天的书房空无一人，东窗光线落在木桌上，门在西侧。';
  updatePrompt(value);
  shot.prompt = shot.prompt.replace(/^人物：.+\n/mu, '').replace('@Image2 是书房', '@Image1 是书房');
  assert.equal(validateCandidate(value, { script: '书房里空无一人。' }).valid, true);
  value.assets.characterChecklist = [{ name: '旁白', requiresReferenceImage: false }];
  assert.equal(validateCandidate(value, { script: '书房里空无一人。' }).valid, true);
});

test('旧故事分析对象不再是创作或素材门禁，旧项目从最终分镜兼容生成大纲', async () => {
  const legacy = candidate();
  delete legacy.outline;
  delete legacy.storyboard.shots[0].outline;
  delete legacy.storyboard.shots[0].scene;
  legacy.analysis = { title: '旧故事分析', characters: null, visualKeywords: null };
  const original = clone(legacy);
  assert.equal(validateCandidate(legacy, { script: ORIGINAL }).valid, true);
  assert.equal(canPublishIgnoredCandidate(legacy), true);
  const api = workflowTransport([legacy, auditFor(legacy)]);
  const result = await createWorkflowRunner({ request: api.request })(ORIGINAL);
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit']);
  assert.equal(result.data.outline.title, '分镜大纲');
  assert.equal(result.data.storyboard.shots[0].scene, '书房');
  assert.match(result.data.storyboard.shots[0].outline, /阿青坐在东窗下/u);
  assert.deepEqual(legacy, original);
});

test('直接从原文生成分镜不要求分集大纲或改编剧本，旧冗余字段兼容忽略', () => {
  const value = candidate({ voice: true, twoShots: true });
  assert.equal(Object.hasOwn(value, 'episodes'), false);
  assert.equal(Object.hasOwn(value, 'script'), false);
  assert.equal(validateAudit(value, auditFor(value), { script: ORIGINAL }).valid, true);
  value.episodes = null;
  value.script = { scenes: '旧项目中的无效冗余数据', text: '这里不是原始台词。' };
  assert.equal(validateAudit(value, auditFor(value), { script: ORIGINAL }).valid, true);
  expectCode(validateCandidate(value, { script: '这里不是原始台词。' }), 'VOICE_NOT_IN_ORIGINAL');
});

function workflowTransport(responses) {
  const calls = [];
  return {
    calls,
    request: async (messages, options) => {
      calls.push({ messages, options });
      const next = responses.shift();
      assert.ok(next, '不应出现未规划的额外模型调用');
      return { data: clone(next), model: 'deepseek-flash', usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
    },
  };
}

test('真实policy集成：合法候选必须经独立审核后发布并记录输入与规范校验信息', async () => {
  const value = candidate({ voice: true, twoShots: true });
  value.storyboard.auditSummary = { repairCount: 999, finalStatus: '全部通过' };
  value.storyboard.verification = { requestCount: 999, skillSha256: '伪造' };
  const audit = auditFor(value);
  const api = workflowTransport([value, audit]);
  const result = await createWorkflowRunner({ request: api.request })(ORIGINAL);
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit']);
  assert.deepEqual(result.data.storyboard.auditRecord, audit);
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '全部通过');
  assert.equal(result.data.storyboard.auditSummary.repairCount, 0);
  assert.equal(result.data.storyboard.verification.requestCount, 2);
  assert.equal(result.data.storyboard.verification.skillSha256, SKILL_SHA256);
  assert.equal(result.data.storyboard.verification.inputSha256, createHash('sha256').update(ORIGINAL).digest('hex'));
  assert.equal(result.data.storyboard.verification.scope, '文本与计划');
  assert.equal(api.calls[1].messages[1].content.includes('999'), false);
  assert.deepEqual(result.usage, { prompt_tokens: 24, completion_tokens: 16, total_tokens: 40 });
});

test('真实policy集成：证据不足仅回炉一次，二次审计仍失败则带真实警告发布并完成流程', async () => {
  const value = candidate({ voice: true, twoShots: true });
  const originalValue = clone(value);
  const audit = auditFor(value, 'revise');
  for (const id of ['C6', 'C7', 'E9']) audit.blocks[0].notes[id] = '已检查';
  audit.acceptedBlockNos = [];
  const originalAudit = clone(audit);
  const progressEvents = [];
  const api = workflowTransport([value, audit, value, audit]);
  const result = await createWorkflowRunner({ request: api.request, onProgress: event => progressEvents.push(event) })(ORIGINAL);
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit', 'repair', 'audit']);
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '审计未通过（已忽略）');
  assert.equal(result.data.storyboard.auditSummary.repairCount, 1);
  assert.ok(['C6', 'C7', 'E9'].every(id => result.data.storyboard.auditSummary.issues.some(issue => issue.ruleId === id && issue.code === 'AUDIT_EVIDENCE_REQUIRED')));
  assert.equal(result.data.storyboard.verification.repairCount, 1);
  assert.equal(result.data.storyboard.verification.requestCount, 4);
  assert.equal(result.data.storyboard.verification.auditIgnored, true);
  assert.equal(result.data.storyboard.verification.auditPassed, false);
  assert.deepEqual(result.data.storyboard.auditRecord, originalAudit);
  assert.equal(result.data.storyboard.auditRecord.verdict, 'revise');
  assert.deepEqual(result.data.storyboard.auditRecord.acceptedBlockNos, []);
  assert.equal(result.progress.status, 'completed');
  assert.equal(result.progress.auditIgnored, true);
  assert.equal(progressEvents.at(-1).status, 'completed');
  assert.equal(progressEvents.at(-1).auditIgnored, true);
  assert.deepEqual(value, originalValue);
  assert.deepEqual(audit, originalAudit);
});

test('真实policy集成：回炉后时间轴或原声内容校验仍失败，完整候选继续交付且保留警告', async () => {
  for (const failure of ['TIMELINE_END', 'VOICE_NOT_IN_ORIGINAL']) {
    const value = candidate({ voice: true, twoShots: true });
    if (failure === 'TIMELINE_END') value.storyboard.shots[0].segments[1].time = '4-7秒';
    else {
      value.storyboard.voiceSources[0].text = '我会把书送到，你在这里等我。';
      value.storyboard.voiceFragments[0].text = value.storyboard.voiceSources[0].text;
      value.storyboard.shots[0].segments[0].visual = value.storyboard.shots[0].segments[0].visual.replace(LINE, value.storyboard.voiceSources[0].text);
    }
    updatePrompt(value);
    const originalValue = clone(value);
    const checked = validateCandidate(value, { script: ORIGINAL });
    assert.ok(checked.errors.some(issue => issue.code === failure), JSON.stringify(checked.errors));
    assert.equal(canPublishIgnoredCandidate(value), true);
    const audit = auditFor(value, 'revise');
    audit.acceptedBlockNos = [];
    const ruleId = failure === 'TIMELINE_END' ? 'C1' : 'D1';
    audit.blocks[0].checks[ruleId] = '失败';
    audit.blocks[0].notes[ruleId] = failure === 'TIMELINE_END' ? '镜头末点与块总长不一致。' : '原声出现原文中没有的改词。';
    audit.issues = [{ blockNo: '01', ruleId, message: audit.blocks[0].notes[ruleId] }];
    const originalAudit = clone(audit);
    const api = workflowTransport([value, audit, value, audit]);
    const result = await createWorkflowRunner({ request: api.request })(ORIGINAL);
    assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit', 'repair', 'audit']);
    assert.equal(result.data.storyboard.verification.repairCount, 1);
    assert.equal(result.data.storyboard.verification.auditPassed, false);
    assert.equal(result.data.storyboard.verification.auditIgnored, true);
    assert.equal(result.data.storyboard.auditSummary.finalStatus, '审计未通过（已忽略）');
    assert.ok(result.data.storyboard.auditSummary.issues.some(issue => issue.code === failure));
    assert.deepEqual(result.data.storyboard.auditRecord, originalAudit);
    assert.deepEqual(result.data.storyboard.shots, originalValue.storyboard.shots);
    assert.deepEqual(value, originalValue);
  }
});

test('真实policy集成：模型自报通过不能覆盖时间或原声错误，实际回炉修复后重新独立审核', async () => {
  for (const failure of ['duration', 'voice']) {
    const repaired = candidate({ voice: true, twoShots: true });
    const invalid = clone(repaired);
    invalid.storyboard.shots[0].scene = '旧场景摘要';
    invalid.storyboard.shots[0].outline = '旧内容摘要';
    if (failure === 'duration') {
      invalid.storyboard.shots[0].duration = 16;
      invalid.storyboard.shots[0].segments[1].time = '4-16秒';
    } else {
      const fabricated = '你快回去，我很快就来。';
      invalid.storyboard.voiceSources[0].text = fabricated;
      invalid.storyboard.voiceFragments[0].text = fabricated;
      invalid.storyboard.shots[0].segments[0].visual = invalid.storyboard.shots[0].segments[0].visual.replace(LINE, fabricated);
    }
    updatePrompt(invalid);
    const api = workflowTransport([invalid, auditFor(invalid), repaired, auditFor(repaired)]);
    const result = await createWorkflowRunner({ request: api.request })(ORIGINAL);
    assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit', 'repair', 'audit']);
    assert.equal(result.data.storyboard.verification.requestCount, 4);
    assert.equal(result.data.storyboard.verification.repairCount, 1);
    assert.equal(result.data.storyboard.auditSummary.repairCount, 1);
    assert.equal(result.data.storyboard.shots[0].duration, 8);
    assert.equal(Object.hasOwn(result.data, 'analysis'), false);
    assert.equal(result.data.outline.title, '分镜大纲');
    assert.equal(result.data.storyboard.shots[0].scene, repaired.storyboard.shots[0].scene);
    assert.equal(result.data.storyboard.shots[0].outline, repaired.storyboard.shots[0].outline);
    assert.match(api.calls[2].messages[1].content, /同步更新最终每块scene与outline/u);
    assert.equal(result.data.storyboard.voiceSources[0].text, LINE);
    assert.match(api.calls[2].messages[1].content, failure === 'duration' ? /BLOCK_DURATION/u : /VOICE_NOT_IN_ORIGINAL/u);
    assert.equal(validateAudit(result.data, result.data.storyboard.auditRecord, { script: ORIGINAL }).valid, true);
  }
});

test('真实policy集成：独立合规部分与真实阻塞、原声顺延完整通过后可以发布partial', async () => {
  const value = candidate({ voice: true });
  const first = '我会把信送到，';
  value.storyboard.voiceFragments[0].text = first;
  value.storyboard.shots[0].segments[0].visual = value.storyboard.shots[0].segments[0].visual.replace(LINE, first);
  value.storyboard.deferredVoices = [{ sourceId: 'S001', text: '你在这里等我。', reason: 'B001：下一场关键钥匙的持有者不明，暂停相关内容。' }];
  value.storyboard.blockers = [blocker()];
  updatePrompt(value);
  const audit = auditFor(value, 'blocked');
  audit.blockers = [blocker()];
  audit.batchChecks.A1 = '阻塞';
  audit.batchNotes.A1 = '本次仅第一块可独立完成，第二块缺少关键钥匙持有者，准确尾段已顺延。';
  const api = workflowTransport([value, audit]);
  const result = await createWorkflowRunner({ request: api.request })(ORIGINAL);
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit']);
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '部分通过（存在阻塞）');
  assert.deepEqual(result.data.storyboard.auditSummary.blockers[0].affectedBlockNos, ['02']);
  assert.deepEqual(result.data.storyboard.shots.map(shot => shot.no), ['01']);
  assert.equal(result.data.storyboard.deferredVoices[0].text, '你在这里等我。');
  assert.equal(result.data.storyboard.verification.repairCount, 0);
});

test('存在实际声音时不能用虚假的无声音原因把 D1/D4/D9/D10 标为不适用', () => {
  const value = candidate({ voice: true });
  for (const id of ['D1', 'D4', 'D9', 'D10']) {
    const audit = auditFor(value);
    audit.blocks[0].checks[id] = '不适用';
    audit.blocks[0].notes[id] = '本块没有任何声音，因此不触发声音检查。';
    const result = validateAudit(value, audit, { script: ORIGINAL });
    expectCode(result, 'AUDIT_INVALID_NA');
    assert.ok(result.errors.some(error => error.code === 'AUDIT_INVALID_NA' && error.ruleId === id));
  }
});

test('跨镜 V 声音及多镜画面的 D7/E9/F8 不能以不适用绕过', () => {
  const value = candidate({ voice: true, twoShots: true });
  for (const id of ['D7', 'E9', 'F8']) {
    const audit = auditFor(value);
    audit.blocks[0].checks[id] = '不适用';
    audit.blocks[0].notes[id] = '本块没有跨镜或相邻镜头需要检查。';
    const result = validateAudit(value, audit, { script: ORIGINAL });
    expectCode(result, 'AUDIT_INVALID_NA');
    assert.ok(result.errors.some(error => error.code === 'AUDIT_INVALID_NA' && error.ruleId === id));
  }
});

test('同一原声跨生成块时各块的 D8 必须适用', () => {
  const value = candidate({ voice: true });
  const first = '我会把信送到，';
  const tail = '你在这里等我。';
  const firstShot = value.storyboard.shots[0];
  firstShot.segments[0].visual = firstShot.segments[0].visual.replace(LINE, first);
  const secondShot = clone(firstShot);
  secondShot.no = '02';
  secondShot.segments[0].visual = secondShot.segments[0].visual.replace(first, tail);
  value.storyboard.shots.push(secondShot);
  value.storyboard.voiceFragments[0].text = first;
  value.storyboard.voiceFragments.push({ id: 'F002', sourceId: 'S001', blockNo: '02', segmentIndex: 1, text: tail });
  updatePrompt(value);
  assert.equal(validateCandidate(value, { script: ORIGINAL }).valid, true);
  assert.equal(validateAudit(value, auditFor(value), { script: ORIGINAL }).valid, true);
  for (const index of [0, 1]) {
    const audit = auditFor(value);
    audit.blocks[index].checks.D8 = '不适用';
    audit.blocks[index].notes.D8 = '没有跨块声音。';
    const result = validateAudit(value, audit, { script: ORIGINAL });
    expectCode(result, 'AUDIT_INVALID_NA');
    assert.ok(result.errors.some(error => error.ruleId === 'D8' && error.blockNo === String(index + 1).padStart(2, '0')));
  }
});

test('真实policy集成：shots 对象或 null 项均作为可回炉数据处理，修复后重新独立审核', async () => {
  for (const malformed of [{}, [null]]) {
    const repaired = candidate({ voice: true, twoShots: true });
    const invalid = clone(repaired);
    invalid.storyboard.shots = malformed;
    const malformedAudit = {
      verdict: 'revise', blocks: [], batchChecks: Object.fromEntries(BATCH.map(id => [id, '通过'])),
      batchNotes: {}, issues: [{ ruleId: 'G7', message: 'shots 结构无效，需要恢复完整生成块对象。' }], blockers: [], acceptedBlockNos: [],
    };
    const api = workflowTransport([invalid, malformedAudit, repaired, auditFor(repaired)]);
    const result = await createWorkflowRunner({ request: api.request })(ORIGINAL);
    assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit', 'repair', 'audit']);
    assert.equal(result.data.storyboard.verification.repairCount, 1);
    assert.equal(result.data.storyboard.verification.requestCount, 4);
    assert.equal(result.data.storyboard.shots[0].no, '01');
    assert.equal(validateAudit(result.data, result.data.storyboard.auditRecord, { script: ORIGINAL }).valid, true);
  }
});

const USER_SKILLS = { storyboard: { name: '30秒分镜.txt', content: '允许将故事压缩改编为30秒、六镜。使用字幕、BGM和油画风，自由格式。' }, assets: { name: '线稿.md', content: '所有参考图使用黑白线稿。' } };

function customCandidate() {
  const value = candidate({ voice: true, duration: 30 });
  const shot = value.storyboard.shots[0];
  shot.segments = Array.from({ length: 6 }, (_, index) => ({ time: `${index * 5}-${(index + 1) * 5}秒`, visual: `第${index + 1}镜：阿青在书房中作出决定。` }));
  shot.prompt = '30秒六镜，油画风。配乐与字幕。压缩改编对白，采用用户自由格式。';
  value.storyboard.voiceSources[0].text = '允许改编后的压缩表达。';
  value.storyboard.voiceFragments[0].text = '允许改编后的压缩表达。';
  return value;
}

function customAudit(value, { verdict = 'pass', status = '通过' } = {}) {
  return {
    verdict, blocks: value.storyboard.shots.map(shot => ({ no: shot.no, checks: [
      { rule: '用户要求30秒六镜、压缩改编及油画风', status, note: status === '通过' ? '本块共30秒、6个时间片，正文使用油画、字幕与BGM并采用授权压缩表达。' : '正文没有采用用户要求的油画风，需要修正。' },
    ] })), batchChecks: [{ rule: '全批范围、素材身份与资产线稿规范', status: '通过', note: '本次仅指定书房事件，保留阿青和书房的准确身份，素材按黑白线稿设计。' }],
    issues: [], blockers: [], acceptedBlockNos: status === '通过' ? value.storyboard.shots.map(shot => shot.no) : [],
  };
}

test('用户分镜Skill替换旧时长镜数模板风格与锁稿默认值，独立按用户条款审核', () => {
  const value = customCandidate();
  const context = { stageSkills: USER_SKILLS };
  assert.equal(validateCandidate(value, { script: ORIGINAL }).valid, false);
  assert.deepEqual(validateCandidate(value, { script: ORIGINAL, context }).errors, []);
  const audit = customAudit(value);
  assert.equal(validateAudit(value, audit, { script: ORIGINAL, context }).valid, true);
  const summary = buildAuditSummary(value, audit, { context });
  assert.equal(summary.auditBasis, '用户 Skill');
  assert.equal(summary.skillName, USER_SKILLS.storyboard.name);
  assert.equal(summary.finalStatus, '全部通过');
  assert.equal(summary.scope, '用户 Skill · 文本与计划');
  assert.ok(summary.rows.every(row => row.status === '通过'));
  assert.equal(summary.rows.some(row => /≤15秒|≤5镜|60项/.test(row.label)), false);
});

test('用户Skill仍保持JSON可展示结构、精确素材身份与真实阻塞边界', () => {
  const context = { stageSkills: USER_SKILLS };
  const wrongIdentity = customCandidate(); wrongIdentity.storyboard.shots[0].uploads[0].asset = '另一个未登记人物';
  expectCode(validateCandidate(wrongIdentity, { context }), 'CUSTOM_REFERENCE_IDENTITY');
  assert.equal(canPublishIgnoredCandidate(wrongIdentity, { context }), false);
  assert.throws(() => buildIgnoredAuditSummary(wrongIdentity, customAudit(wrongIdentity), { context, repairCount: 1 }), /素材身份/);
  const missingPrompt = customCandidate(); missingPrompt.storyboard.shots[0].prompt = '';
  expectCode(validateCandidate(missingPrompt, { context }), 'CUSTOM_CANDIDATE_SHAPE');
  const blocked = customCandidate(); blocked.storyboard.blockers = [blocker('01')];
  assert.equal(hasGenuineBlockers(blocked), true);
  assert.throws(() => buildIgnoredAuditSummary(blocked, customAudit(blocked), { context }), /真实剧情阻塞/);
});

test('用户Skill新契约无需故事分析，但大纲必须逐块带有场景和剧情镜头摘要', () => {
  const value = customCandidate();
  const context = { stageSkills: USER_SKILLS };
  assert.equal(Object.hasOwn(value, 'analysis'), false);
  assert.equal(validateCandidate(value, { script: ORIGINAL, context }).valid, true);
  assert.equal(canPublishIgnoredCandidate(value, { context }), true);
  for (const key of ['scene', 'outline']) {
    const missing = clone(value); missing.storyboard.shots[0][key] = '';
    expectCode(validateCandidate(missing, { script: ORIGINAL, context }), 'OUTLINE_BLOCK_FIELDS');
  }
});

test('用户Skill使用具名引用无需旧Image编号，并拒绝别名或多ref重复同一资产', () => {
  const context = { stageSkills: USER_SKILLS };
  const value = customCandidate();
  const shot = value.storyboard.shots[0];
  shot.uploads = shot.uploads.map(upload => ({ ...upload, ref: `@${upload.asset}` }));
  shot.prompt += '\n人物：@阿青；场景：@书房。';
  assert.deepEqual(validateCandidate(value, { context }).errors, []);
  assert.equal(canPublishIgnoredCandidate(value, { context }), true);
  assert.equal(validateAudit(value, customAudit(value), { context }).valid, true);
  const alias = structuredClone(value);
  alias.storyboard.shots[0].uploads[0].ref = '@阿青别名';
  expectCode(validateCandidate(alias, { context }), 'CUSTOM_REFERENCE_IDENTITY');
  assert.equal(canPublishIgnoredCandidate(alias, { context }), false);
  const duplicate = structuredClone(value);
  duplicate.storyboard.shots[0].uploads.push({ ref: '@Image7', asset: '阿青', purpose: '重复身份' });
  expectCode(validateCandidate(duplicate, { context }), 'CUSTOM_REFERENCE_IDENTITY');
});

test('用户Skill审核拒绝漏块、空检查、缺依据和自报通过，忽略后保持真实未通过状态', () => {
  const context = { stageSkills: USER_SKILLS };
  const value = customCandidate();
  for (const mutate of [
    audit => { audit.blocks = []; },
    audit => { audit.blocks[0].checks = []; },
    audit => { audit.batchChecks = []; },
    audit => { audit.blocks[0].checks[0].note = '已检查'; },
    audit => { audit.blocks[0].checks[0].status = '失败'; },
  ]) {
    const audit = customAudit(value); mutate(audit);
    const gate = validateAudit(value, audit, { context });
    assert.equal(gate.valid, false);
    assert.throws(() => buildAuditSummary(value, audit, { context }), /有效通过/);
    const summary = buildIgnoredAuditSummary(value, audit, { context, repairCount: 1, issues: gate.errors });
    assert.equal(summary.finalStatus, '审计未通过（已忽略）');
    assert.equal(summary.auditBasis, '用户 Skill');
    assert.ok(summary.issues.length);
  }
});

test('真实policy集成：上传Skill在生成审核回炉中保持同一全文，输出追踪文件名hash而非内置通过', async () => {
  const value = customCandidate();
  const audit = customAudit(value, { verdict: 'revise', status: '失败' });
  const api = workflowTransport([value, audit, value, audit]);
  const result = await createWorkflowRunner({ request: api.request })(ORIGINAL, { stageSkills: USER_SKILLS });
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit', 'repair', 'audit']);
  for (const call of api.calls) {
    assert.ok(call.messages[0].content.includes(USER_SKILLS.storyboard.content));
    assert.ok(call.messages[0].content.includes(USER_SKILLS.assets.content));
    const input = JSON.parse(call.messages[1].content.slice(call.messages[1].content.lastIndexOf('\n\n') + 2));
    assert.equal(input.originalScript, ORIGINAL);
    assert.equal(input.context.stageSkills.storyboard.name, USER_SKILLS.storyboard.name);
  }
  const board = result.data.storyboard;
  assert.equal(board.auditSummary.auditBasis, '用户 Skill');
  assert.equal(board.auditSummary.finalStatus, '审计未通过（已忽略）');
  assert.equal(board.verification.auditPassed, false);
  assert.equal(board.verification.builtinSkillApplied, false);
  assert.equal(board.verification.skillSha256, createHash('sha256').update(USER_SKILLS.storyboard.content).digest('hex'));
  assert.deepEqual(Object.keys(board.verification.stageSkills.storyboard), ['name', 'sha256']);
  assert.equal(board.verification.requestCount, 4);
  assert.deepEqual(board.auditRecord, audit);
  assert.deepEqual(board.shots, value.storyboard.shots);
  assert.equal(result.progress.prompt.skillChars, USER_SKILLS.storyboard.content.length + USER_SKILLS.assets.content.length);
});

test('真实policy集成：用户Skill首次审核通过无需为旧15秒模板进行无用回炉', async () => {
  const value = customCandidate();
  const api = workflowTransport([value, customAudit(value)]);
  const result = await createWorkflowRunner({ request: api.request })(ORIGINAL, { stageSkills: USER_SKILLS });
  assert.deepEqual(api.calls.map(call => call.options.phase), ['candidate', 'audit']);
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '全部通过');
  assert.equal(result.data.storyboard.auditSummary.auditBasis, '用户 Skill');
  assert.equal(result.data.storyboard.verification.builtinSkillApplied, false);
  assert.equal(result.data.storyboard.verification.auditPassed, true);
  assert.equal(result.data.storyboard.verification.repairCount, 0);
});

test('资产Skill单独上传仅改变资产指令，不解除分镜内置规范', async () => {
  const value = candidate();
  const api = workflowTransport([value, auditFor(value)]);
  const result = await createWorkflowRunner({ request: api.request })(ORIGINAL, { stageSkills: { assets: USER_SKILLS.assets } });
  assert.equal(result.data.storyboard.verification.builtinSkillApplied, true);
  assert.equal(result.data.storyboard.verification.stageSkills.storyboard, null);
  assert.equal(result.data.storyboard.verification.stageSkills.assets.name, USER_SKILLS.assets.name);
  assert.ok(api.calls.every(call => call.messages[0].content.includes(USER_SKILLS.assets.content)));
  assert.ok(api.calls.every(call => call.messages[0].content.includes('完整分镜规范开始')));
});
