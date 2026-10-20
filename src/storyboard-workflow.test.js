import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as durations from './seedance-duration.js';
import * as references from './seedance-references.js';
import * as generation from './seedance-generation.js';
import * as workflowProgress from './workflow-progress.js';

const mainSource = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const rendererSource = mainSource.slice(0, mainSource.lastIndexOf('\nrender();')).replace(/^import .*;\r?\n/gm, '');

function harness(api = {}) {
  const storage = new Map();
  const intervals = new Map();
  const context = vm.createContext({
    ...durations,
    ...references,
    ...generation,
    ...workflowProgress,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { storyforgeAI: api, setTimeout: () => 1, setInterval: (callback) => { const id = Symbol('timer'); intervals.set(id, callback); return id; }, clearInterval: (id) => intervals.delete(id) },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    structuredClone,
  });
  vm.runInContext(rendererSource, context);
  vm.runInContext(`render = () => {}; showToast = (message) => { globalThis.lastToast = message; }; openModelSettings = () => { globalThis.settingsOpened = true; }; deepseekStatus.configured = true; seedanceStatus.configured = true;`, context);
  return {
    context,
    intervals,
    run: (source) => vm.runInContext(source, context),
    snapshot: (source) => JSON.parse(vm.runInContext(`JSON.stringify(${source})`, context)),
  };
}

function fixture({ partial = false, ignored = false, duration = 3 } = {}) {
  return {
    analysis: { characters: [{ name: '阿宁' }] },
    storyboard: {
      skillVersion: '2.1',
      unifiedSuffix: '',
      shots: [{
        no: '01', title: '阿宁看信', duration,
        uploads: [{ ref: '@Image1', asset: '阿宁', purpose: '人物参考' }],
        segments: [{ time: `[0-${duration}秒]`, visual: '阿宁看着手中的信纸。' }],
        prompt: `🎬 生成块 01（时长：${duration}秒）\n本段总时长：${duration}秒\n人物：@Image1 是阿宁\n场景：书房（白天）\n\n（无对白字幕，无BGM，CG写实）\n\n空间与位置保持稳定：阿宁站在书桌前。\n\n[0-${duration}秒] 近景，阿宁看着手中的信纸。`,
      }],
      auditSummary: {
        version: '2.1', scope: '文本与计划', repairCount: ignored ? 1 : 2,
        finalStatus: ignored ? '审计未通过（已忽略）' : partial ? '部分通过（存在阻塞）' : '全部通过',
        range: partial ? '生成块01—02（02阻塞）' : '生成块01—01',
        rows: [{ label: '单块≤15秒', status: ignored ? '失败' : '通过' }, { label: '块数与范围', status: partial ? '阻塞' : '通过' }],
        issues: ignored ? [{ code: 'AUDIT_EVIDENCE', ruleId: 'C6', blockNo: '01', message: '缺少原文复核事实' }] : [],
        blockers: partial ? [{ id: 'B01', affectedBlockNos: ['02'], reason: '缺少锁定原文', missingInformation: '阿宁的台词原文', question: '请补充第02块的台词。' }] : [],
      },
    },
    assets: { characters: [{ name: '阿宁', fileName: 'aning.png', prompt: '阿宁人物参考图' }] },
  };
}

function loadConfirmedProject(h) {
  h.run(`project.script = '锁定的原文'; project.activeStep = 'storyboard'; project.outputs = { storyboard: { prompts: ['旧分镜'], body: '旧分镜' }, assets: { promptItems: [] } }; project.completed = ['analysis', 'storyboard', 'assets']; project.assetGeneration.items = [{ name: '旧素材', files: [{ localPath: 'C:/old.png' }] }]; project.videoGeneration.items = [{ status: 'success', localPath: 'C:/old.mp4' }];`);
}

function skillDocument(name = '分镜要求.md', content = '请按原文顺序生成分镜。') {
  return { name, content, format: 'md', size: 200, importedAt: '2026-10-20T12:00:00.000Z', sha256: 'a'.repeat(64) };
}

async function waitForMockRequest(reached, running) {
  let timeout;
  try {
    await Promise.race([
      reached,
      running.then(() => { throw new Error('生成流程在进入预期模拟接口前已经结束'); }),
      new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('模拟接口未被调用')), 3000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

test('项目级两个 Skill 独立归一化深拷贝，旧项目默认均为空', () => {
  const h = harness();
  h.context.skills = { storyboard: skillDocument(), assets: skillDocument('资产.txt', '真实材质与单一机位。') };
  h.run('globalThis.first = createProject({ generationSkills: skills }); globalThis.second = normalizeProject({ generationSkills: skills })');
  assert.deepEqual(h.snapshot('first.generationSkills'), h.context.skills);
  assert.deepEqual(h.snapshot('second.generationSkills'), h.context.skills);
  h.run('first.generationSkills.storyboard.name = "单独修改"; second.generationSkills.assets.content = "单独修改"');
  assert.equal(h.context.skills.storyboard.name, '分镜要求.md');
  assert.equal(h.context.skills.assets.content, '真实材质与单一机位。');
  assert.deepEqual(h.snapshot('normalizeProject({}).generationSkills'), { storyboard: null, assets: null });
  h.context.invalid = { storyboard: { name: '空.txt', content: '  ' }, assets: { name: 123, content: '原文' } };
  assert.deepEqual(h.snapshot('normalizeGenerationSkills(invalid)'), { storyboard: null, assets: null });
  assert.equal(h.run('normalizeGenerationSkillDocument({ name: "too-long.md", content: "x".repeat(200001) })'), null);
  assert.equal(h.run('normalizeGenerationSkillDocument({ name: "x".repeat(261), content: "正文" })'), null);
  assert.deepEqual(h.snapshot('normalizeGenerationSkillDocument({ name: "有效.md", content: "正文", size: 1.5, importedAt: "bad-date", format: "" })'), { name: '有效.md', content: '正文' });
});

test('分镜上传入口首次生成前可用，两个阶段相同位置且预览内容转义', () => {
  const h = harness();
  assert.match(h.run('appTemplate()'), /data-import-generation-skill="storyboard"/);
  h.context.doc = skillDocument('<文件>.md', '<script>原样展示，不执行</script>');
  h.run('project.generationSkills.storyboard = doc; project.activeStep = "storyboard"');
  assert.match(h.run('generationSkillTemplate()'), /&lt;文件&gt;\.md/);
  assert.match(h.run('generationSkillTemplate()'), /正文 29 字符|正文 \d+ 字符/);
  assert.match(h.run('generationSkillTemplate()'), /已启用|替换 Skill/);
  h.run('previewGenerationSkill("storyboard")');
  const preview = h.run('generationSkillPreviewTemplate()');
  assert.match(preview, /&lt;script&gt;原样展示，不执行&lt;\/script&gt;/);
  assert.doesNotMatch(preview, /<script>/);
  h.run('project.activeStep = "assets"');
  assert.match(h.run('generationSkillTemplate()'), /data-import-generation-skill="assets"/);
  assert.match(h.run('generationSkillTemplate()'), /下次实际 GPT 生图立即采用/);
  h.run('project.running = true; project.generationSkills.assets = doc');
  const disabled = h.run('generationSkillTemplate()');
  for (const action of ['import', 'preview', 'remove']) assert.match(disabled, new RegExp(`data-${action}-generation-skill="assets" disabled`));
});

test('本地 Skill 上传、替换和移除持久化且不破坏既有成果，取消和失败保留原设置', async () => {
  let returned = skillDocument(), fail = false, calls = 0;
  const h = harness({ importSkillDocument: async ({ stage }) => { calls += 1; assert.equal(stage, 'storyboard'); if (fail) throw new Error('文件无法读取'); return returned; } });
  loadConfirmedProject(h);
  const outputs = h.snapshot('project.outputs');
  await h.run('importGenerationSkill("storyboard")');
  assert.deepEqual(h.snapshot('project.generationSkills.storyboard'), returned);
  returned.name = '调用后改变';
  assert.equal(h.run('project.generationSkills.storyboard.name'), '分镜要求.md');
  assert.deepEqual(h.snapshot('project.outputs'), outputs);
  returned = null;
  await h.run('importGenerationSkill("storyboard")');
  assert.equal(h.run('project.generationSkills.storyboard.name'), '分镜要求.md');
  fail = true;
  await h.run('importGenerationSkill("storyboard")');
  assert.equal(h.run('project.generationSkills.storyboard.name'), '分镜要求.md');
  assert.match(h.context.lastToast, /文件无法读取/);
  fail = false; returned = skillDocument('替换.md', '更新后的规范');
  await h.run('importGenerationSkill("storyboard")');
  assert.equal(h.run('project.generationSkills.storyboard.name'), '替换.md');
  h.run('removeGenerationSkill("storyboard")');
  assert.equal(h.run('project.generationSkills.storyboard'), null);
  assert.deepEqual(h.snapshot('project.outputs'), outputs);
  h.run('project.running = true');
  await h.run('importGenerationSkill("storyboard")');
  assert.equal(calls, 4);
});

test('Skill 保存失败回滚内存与修改时间，移除失败也不伪报成功', async () => {
  const h = harness({ importSkillDocument: async () => skillDocument('替换.md') });
  h.context.original = skillDocument('原要求.md');
  h.run('project.generationSkills.storyboard = original; project.updatedAt = "之前的时间"; localStorage.setItem = () => { throw new Error("存储空间不足"); }');
  await h.run('importGenerationSkill("storyboard")');
  assert.deepEqual(h.snapshot('project.generationSkills.storyboard'), h.context.original);
  assert.equal(h.run('project.updatedAt'), '之前的时间');
  assert.match(h.context.lastToast, /保存 Skill 失败，已保留原设置/);
  h.run('removeGenerationSkill("storyboard")');
  assert.deepEqual(h.snapshot('project.generationSkills.storyboard'), h.context.original);
  assert.match(h.context.lastToast, /保存 Skill 失败/);
});

test('切换项目与并发替换会丢弃旧上传响应，移除也会取消待处理替换', async () => {
  const requests = [];
  const h = harness({ importSkillDocument: () => new Promise((resolve) => requests.push(resolve)) });
  h.run('projectLibrary.projects.push(createProject({ id: "other" }))');
  const firstProjectId = h.run('project.id');
  const first = h.run('importGenerationSkill("storyboard")');
  h.run('switchProject("other")');
  h.context.firstProjectId = firstProjectId;
  h.run('switchProject(firstProjectId)');
  requests[0](skillDocument('迟到.md'));
  await first;
  assert.equal(h.run('project.generationSkills.storyboard'), null);
  const older = h.run('importGenerationSkill("storyboard")');
  const latest = h.run('importGenerationSkill("storyboard")');
  requests[2](skillDocument('最新.md'));
  await latest;
  requests[1](skillDocument('较旧.md'));
  await older;
  assert.equal(h.run('project.generationSkills.storyboard.name'), '最新.md');
  const pending = h.run('importGenerationSkill("storyboard")');
  h.run('removeGenerationSkill("storyboard")');
  requests[3](skillDocument('已取消.md'));
  await pending;
  assert.equal(h.run('project.generationSkills.storyboard'), null);
});

test('项目 JSON 导入导出保留两个 Skill 正文和元信息', () => {
  const h = harness();
  h.context.skills = { storyboard: skillDocument(), assets: skillDocument('资产.txt', '白色背景。') };
  let exported;
  h.context.Blob = class { constructor(parts) { exported = parts.join(''); } };
  h.context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
  h.context.document.createElement = () => ({ click() {} });
  h.run('project.generationSkills = normalizeGenerationSkills(skills); exportProject()');
  assert.deepEqual(JSON.parse(exported).generationSkills, h.context.skills);
  h.context.FileReader = class { readAsText(file) { this.result = file.content; this.onload(); } };
  h.context.event = { target: { files: [{ content: exported }], value: 'project.json' } };
  h.run('importProject(event)');
  assert.deepEqual(h.snapshot('project.generationSkills'), h.context.skills);
  assert.equal(h.context.event.target.value, '');
});

test('分镜请求携带锁定的两个 Skill，历史输出规范来自审计记录而非当前上传文件', async () => {
  let options, resolve;
  const h = harness({ generateWorkflow: (_script, value) => { options = value; return new Promise((done) => { resolve = done; }); } });
  loadConfirmedProject(h);
  h.context.skills = { storyboard: skillDocument('此次分镜.md'), assets: skillDocument('此次资产.md') };
  h.run('project.generationSkills = normalizeGenerationSkills(skills)');
  const running = h.run('startGeneration()');
  assert.deepEqual(options.stageSkills, h.context.skills);
  h.run('project.generationSkills.storyboard.name = "后来替换.md"');
  assert.equal(options.stageSkills.storyboard.name, '此次分镜.md');
  const data = fixture();
  Object.assign(data.storyboard.auditSummary, { auditBasis: '用户 Skill', skillName: '此次分镜.md', skillSha256: 'a'.repeat(64) });
  resolve({ data });
  await running;
  h.run('project.activeStep = "storyboard"');
  const output = h.run('outputTemplate()');
  assert.match(output, /用户 Skill|此次分镜\.md/);
  assert.doesNotMatch(output, /Skill v2\.1|每块≤15秒|最多5镜|后来替换\.md/);
  assert.match(h.run('workflowProgressTemplate()'), /04 独立审计 · 用户 Skill/);
});

test('单张和批量实际 GPT 生图使用运行开始锁定的资产 Skill，无需重跑分镜', async () => {
  for (const indexes of [[0], null]) {
    const requests = [];
    let workflowCalls = 0;
    const h = harness({
      getCodexImageStatus: async () => ({ available: true, authenticated: true, imageGeneration: true }),
      generateWorkflow: async () => { workflowCalls += 1; },
      generateCodexImage: async (options) => {
        requests.push(options);
        h.run('project.generationSkills.assets.content = "期间改变的规范"');
        return { files: [{ localPath: `C:/image-${options.index}.png` }] };
      },
    });
    h.context.doc = skillDocument('资产 Skill.md', '用于本次实际生图的规范');
    h.context.document.querySelectorAll = () => [];
    h.context.data = fixture();
    h.context.indexes = indexes;
    h.run('project.outputs = renderAIWorkflow(data); project.outputs.assets.promptItems.push({ name: "书房", fileName: "study.png", prompt: "书房", type: "场景参考图" }); project.generationSkills.assets = normalizeGenerationSkillDocument(doc)');
    await h.run('generateCodexImageAssets(indexes)');
    assert.equal(requests.length, indexes ? 1 : 2);
    for (const request of requests) assert.deepEqual(request.assetSkill, h.context.doc);
    assert.equal(workflowCalls, 0);
    assert.equal(h.run('project.assetGeneration.generatedCount'), requests.length);
  }
});

test('制作流程仅保留四步，编号、按钮与进度一致', () => {
  const h = harness();
  assert.deepEqual(h.snapshot('steps.map(({ id, no }) => ({ id, no }))'), [
    { id: 'analysis', no: '01' }, { id: 'storyboard', no: '02' },
    { id: 'assets', no: '03' }, { id: 'video', no: '04' },
  ]);
  const empty = h.run('appTemplate()');
  assert.match(empty, /开始生成分镜/);
  assert.doesNotMatch(empty, /分集大纲|短剧剧本|前四步|第五步|第六步|data-step="episodes"|data-step="script"/);
  h.run('project.completed = ["analysis", "storyboard"]');
  assert.match(h.run('appTemplate()'), /制作流程<\/span><b>50%<\/b>/);
});

test('生成响应只需故事分析、分镜与素材，不再生成两个已删除的结果', () => {
  const h = harness();
  h.context.data = fixture();
  assert.deepEqual(h.snapshot('Object.keys(renderAIWorkflow(data))'), ['analysis', 'storyboard', 'assets']);
});

test('旧项目移除两个步骤并迁移选中项，保留已确认分镜和本地图片视频', () => {
  for (const schemaVersion of [4, 5]) {
    for (const activeStep of ['episodes', 'script', 'video']) {
      const h = harness();
      h.context.saved = {
        schemaVersion, id: 'saved-project', script: '原文', activeStep,
        completed: ['analysis', 'episodes', 'script', 'storyboard', 'assets', 'video', 'video'],
        outputs: {
          analysis: { body: '原分析' }, episodes: { body: '旧大纲' }, script: { body: '旧剧本' },
          storyboard: { prompts: ['已确认分镜'], body: '原分镜' },
          assets: { promptItems: [{ name: '原人物', fileName: 'original.png' }] },
          video: { body: '', title: '原视频' },
        },
        assetGeneration: { items: [{ name: '原人物', files: [{ localPath: 'C:/original.png' }] }] },
        videoGeneration: { items: [{ status: 'success', localPath: 'C:/original.mp4' }] },
      };
      h.run('globalThis.migrated = normalizeProject(saved)');
      assert.deepEqual(h.snapshot('Object.keys(migrated.outputs)'), ['analysis', 'storyboard', 'assets', 'video']);
      assert.deepEqual(h.snapshot('migrated.completed'), ['analysis', 'storyboard', 'assets', 'video']);
      assert.equal(h.run('migrated.activeStep'), activeStep === 'video' ? 'video' : 'storyboard');
      assert.equal(h.run('migrated.outputs.storyboard.prompts[0]'), '已确认分镜');
      assert.equal(h.run('migrated.assetGeneration.items[0].files[0].localPath'), 'C:/original.png');
      assert.equal(h.run('migrated.videoGeneration.items[0].localPath'), 'C:/original.mp4');
      h.run('project = migrated');
      assert.match(h.run('appTemplate()'), /制作流程<\/span><b>100%<\/b>/);
    }
  }
});

test('旧项目尚无分镜时回到故事分析，导入项目也执行相同迁移', () => {
  const h = harness();
  const incoming = { schemaVersion: 5, title: '旧项目', script: '锁定原文', activeStep: 'script', completed: ['analysis', 'episodes'], outputs: { analysis: { body: '原分析' }, episodes: { body: '旧大纲' }, script: { body: '旧剧本' } } };
  h.context.incoming = incoming;
  assert.equal(h.run('normalizeProject(incoming).activeStep'), 'analysis');
  h.context.FileReader = class {
    readAsText(file) { this.result = file.content; this.onload(); }
  };
  h.context.importEvent = { target: { files: [{ content: JSON.stringify(incoming) }], value: 'old-project.json' } };
  h.run('importProject(importEvent)');
  assert.equal(h.run('project.activeStep'), 'analysis');
  assert.deepEqual(h.snapshot('project.completed'), ['analysis']);
  assert.deepEqual(h.snapshot('Object.keys(project.outputs)'), ['analysis']);
  assert.equal(h.run('project.script'), '锁定原文');
  assert.equal(h.context.importEvent.target.value, '');
});

test('视频入口只要求前三步完成，重新生成视频不会重跑 DeepSeek', async () => {
  let deepseekCalls = 0;
  const h = harness({ generateWorkflow: async () => { deepseekCalls += 1; return { data: fixture() }; } });
  h.run('project.script = "原文"; project.activeStep = "video"; project.completed = ["analysis", "storyboard", "assets"]');
  assert.match(h.run('outputTemplate()'), /本地参考图和分镜已经准备完成/);
  h.run('globalThis.videoCalls = []; generateVideoStage = async (...args) => { videoCalls.push(args); };');
  await h.run('startGeneration("force-video")');
  assert.equal(deepseekCalls, 0);
  assert.equal(h.run('videoCalls.length'), 1);
  assert.equal(h.run('videoCalls[0][1]'), true);
  h.run('project.completed = ["analysis", "storyboard"]');
  assert.doesNotMatch(h.run('outputTemplate()'), /本地参考图和分镜已经准备完成/);
});

test('Skill 自然短块保持1—3秒，旧项目维持 Seedance 最短4秒规则', () => {
  for (const duration of [1, 2, 3]) {
    assert.equal(durations.resolveStoryboardDuration(duration, ''), duration);
    assert.equal(durations.resolveStoryboardDuration(null, `本段总时长：${duration}秒`), duration);
    assert.equal(durations.resolveSeedanceDuration(duration, ''), 4);
  }
});

test('已审计输出保存版本与真实回炉次数，正文不混入审计，卡片显示实际镜数', () => {
  const h = harness();
  h.context.data = fixture();
  const output = h.run('renderAIWorkflow(data, null, "deepseek-flash").storyboard');
  assert.equal(output.skillVersion, '2.1');
  assert.equal(output.auditSummary.repairCount, 2);
  assert.equal(output.durations[0], 3);
  assert.match(output.body, /1 个实际镜头/);
  assert.match(output.body, /自动回炉：2 次/);
  assert.match(output.body, /视频生成、配音执行和成片效果尚未经实际验证/);
  assert.doesNotMatch(output.prompts[0], /审计结果|自动回炉/);
  assert.doesNotMatch(output.body, /第一集|统一附加词/);
});

test('Skill 无人物的空镜按实际资产呈现，旧项目仍要求人物结构', () => {
  const h = harness();
  const data = fixture();
  data.analysis.characters = [];
  data.storyboard.shots[0] = { no: '01', title: '山谷晨雾', duration: 3, uploads: [], segments: [{ time: '[0-3秒]', visual: '清晨云雾流经山谷。' }], prompt: '🎬 生成块 01（时长：3秒）\n本段总时长：3秒\n场景：山谷（清晨）\n\n（无对白字幕，无BGM，CG写实）\n\n空间与位置保持稳定：峡谷两壁夹住河流。\n\n[0-3秒] 远景固定机位，云雾缓慢流经山谷。' };
  data.assets = { scenes: [{ name: '山谷', fileName: 'valley.png', prompt: '清晨山谷场景参考' }] };
  h.context.data = data;
  const output = h.run('renderAIWorkflow(data)');
  assert.equal(output.assets.promptItems.length, 1);
  assert.equal(output.assets.promptItems[0].type, '场景参考图');
  assert.equal(output.storyboard.shots[0].uploads.length, 0);
  assert.doesNotMatch(output.storyboard.prompts[0], /人物[：:]/);
  delete data.storyboard.skillVersion;
  assert.throws(() => h.run('renderAIWorkflow(data)'), /数据不完整/);
});

test('内部声音来源、覆盖与承接记录保存独立副本且不进入正式正文', () => {
  const h = harness();
  const data = fixture();
  const records = {
    voiceSources: [{ id: 'S001', text: '内部来源记录' }],
    voiceFragments: [{ sourceId: 'S001', blockNo: '01', text: '内部覆盖记录' }],
    deferredVoices: [{ sourceId: 'S001', text: '内部顺延记录' }],
    blockers: [],
    auditRecord: { checks: [{ id: 'D01', status: '通过' }] },
    verification: { scope: '文本与计划', runtimeVideoVerified: false },
  };
  Object.assign(data.storyboard, records);
  h.context.data = data;
  h.run('globalThis.output = renderAIWorkflow(data).storyboard');
  for (const [key, value] of Object.entries(records)) assert.deepEqual(h.snapshot(`output.${key}`), value);
  assert.doesNotMatch(h.run('output.body'), /内部来源记录|内部覆盖记录|内部顺延记录/);
  assert.doesNotMatch(h.run('output.prompts.join("\\n")'), /内部来源记录|内部覆盖记录|内部顺延记录/);
  data.storyboard.voiceSources[0].text = '随后改变的来源';
  assert.equal(h.run('output.voiceSources[0].text'), '内部来源记录');
});

test('部分通过明确显示真实阻塞范围与所缺信息', () => {
  const h = harness();
  h.context.data = fixture({ partial: true });
  const output = h.run('renderAIWorkflow(data).storyboard');
  assert.match(output.subtitle, /部分通过/);
  assert.match(output.body, /受阻生成块 02/);
  assert.match(output.body, /阿宁的台词原文/);
  assert.equal(output.prompts.length, 1);
});

test('部分交付停在审计结果且不将整篇分镜标为完成', async () => {
  const h = harness({ generateWorkflow: async () => ({ data: fixture({ partial: true }) }) });
  loadConfirmedProject(h);
  await h.run('startGeneration()');
  assert.equal(h.run('project.activeStep'), 'storyboard');
  assert.equal(h.run('project.completed.includes("storyboard")'), false);
  assert.deepEqual(h.snapshot('project.completed'), ['analysis']);
  assert.equal(h.run('project.outputs.storyboard.prompts.length'), 1);
  assert.match(h.run('outputTemplate()'), /部分通过 · 存在阻塞/);
  h.run('project.activeStep = "assets"');
  assert.match(h.run('outputTemplate()'), /当前可用素材和视频仅对应已通过的独立生成块/);
  assert.equal(h.run('project.outputs.assets.promptItems[0].name'), '阿宁');
});

test('请求和审计期间保留全部已确认成果，成功后一次替换', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const h = harness({ generateWorkflow: () => pending });
  loadConfirmedProject(h);
  const previous = h.snapshot('[project.outputs, project.completed, project.assetGeneration, project.videoGeneration]');
  const run = h.run('startGeneration()');
  assert.deepEqual(h.snapshot('[project.outputs, project.completed, project.assetGeneration, project.videoGeneration]'), previous);
  assert.match(h.run('outputTemplate()'), /生成 \/ 审计与自动修正中/);
  resolve({ data: fixture(), model: 'deepseek-flash' });
  await run;
  assert.equal(h.run('project.outputs.storyboard.skillVersion'), '2.1');
  assert.equal(h.run('project.activeStep'), 'assets');
  assert.equal(h.run('project.assetGeneration.items[0].name'), '阿宁');
  assert.equal(h.run('project.videoGeneration.items.length'), 0);
  assert.deepEqual(h.snapshot('project.completed'), ['analysis', 'storyboard']);
});

test('审计或缺失信息失败持久展示说明，保留旧成果且不打开密钥设置', async () => {
  for (const message of ['分镜审计未通过：自然发声时长不足', '分镜需要补充信息：缺少锁定台词']) {
    const h = harness({ generateWorkflow: async () => { throw new Error(message); } });
    loadConfirmedProject(h);
    const previous = h.snapshot('[project.outputs, project.completed, project.assetGeneration, project.videoGeneration]');
    await h.run('startGeneration()');
    assert.deepEqual(h.snapshot('[project.outputs, project.completed, project.assetGeneration, project.videoGeneration]'), previous);
    assert.equal(h.run('project.activeStep'), 'storyboard');
    assert.equal(h.run('project.workflowError'), message);
    assert.match(h.run('outputTemplate()'), /本次分镜未交付/);
    assert.equal(h.context.settingsOpened, undefined);
  }
});

test('失败审计候选不能替换已确认成果', async () => {
  const data = fixture();
  data.storyboard.auditSummary.rows[0].status = '失败';
  const h = harness({ generateWorkflow: async () => ({ data }) });
  loadConfirmedProject(h);
  await h.run('startGeneration()');
  assert.equal(h.run('project.outputs.storyboard.prompts[0]'), '旧分镜');
  assert.match(h.run('project.workflowError'), /尚未通过 Skill v2.1 审计/);
});

test('明确忽略的审计结果允许失败行，保留一次回炉及可展开的问题记录', () => {
  const h = harness();
  const data = fixture({ ignored: true });
  data.storyboard.auditSummary.issues.push({ ruleId: 'C7', message: '<script>不应执行</script>' });
  h.context.data = data;
  const output = h.run('renderAIWorkflow(data).storyboard');
  assert.equal(output.auditSummary.finalStatus, '审计未通过（已忽略）');
  assert.equal(output.auditSummary.rows[0].status, '失败');
  assert.equal(output.auditSummary.repairCount, 1);
  assert.match(output.subtitle, /审计未通过，已忽略并继续/);
  assert.match(output.body, /storyboard-audit ignored/);
  assert.match(output.body, /<details class="storyboard-audit-issues">/);
  assert.match(output.body, /已忽略的审计问题（2 项）/);
  assert.match(output.body, /生成块 01/);
  assert.match(output.body, /缺少原文复核事实/);
  assert.match(output.body, /&lt;script&gt;不应执行&lt;\/script&gt;/);
  assert.doesNotMatch(output.body, /<script>|全部通过|分镜文本审计通过/);
});

test('忽略审计的对象、数字或空标题使用默认值，各阶段输出可完整渲染', () => {
  const h = harness();
  for (const title of [42, { text: '模型返回对象' }, ['数组标题'], true, null, '', '   ']) {
    const data = fixture({ ignored: true });
    data.analysis.title = title;
    data.storyboard.title = title;
    // These display fields are generated by the renderer, not copied from the candidate.
    data.analysis.subtitle = data.storyboard.subtitle = { unexpected: true };
    data.analysis.time = data.storyboard.time = 500;
    h.context.data = data;
    h.run('project.outputs = renderAIWorkflow(data)');
    assert.equal(h.run('project.outputs.analysis.title'), '故事结构分析');
    assert.equal(h.run('project.outputs.storyboard.title'), 'Skill v2.1 分镜提示词');
    for (const step of ['analysis', 'storyboard', 'assets']) {
      h.context.step = step;
      h.run('project.activeStep = step');
      for (const field of ['title', 'subtitle', 'time']) assert.equal(h.run(`typeof project.outputs[step].${field}`), 'string');
      assert.match(h.run('outputTemplate()'), /审计未通过/);
    }
  }
  const valid = fixture({ ignored: true });
  valid.analysis.title = '用户故事分析';
  valid.storyboard.title = '用户分镜标题';
  h.context.data = valid;
  assert.equal(h.run('renderAIWorkflow(data).analysis.title'), '用户故事分析');
  assert.equal(h.run('renderAIWorkflow(data).storyboard.title'), '用户分镜标题');
});

test('一次回炉后忽略审计失败进入视觉素材，并在素材与视频保留警告', async () => {
  const h = harness({ generateWorkflow: async () => ({ data: fixture({ ignored: true }) }) });
  loadConfirmedProject(h);
  await h.run('startGeneration()');
  assert.equal(h.run('project.activeStep'), 'assets');
  assert.deepEqual(h.snapshot('project.completed'), ['analysis', 'storyboard']);
  assert.equal(h.run('project.workflowError'), '');
  assert.equal(h.run('project.assetGeneration.items[0].name'), '阿宁');
  assert.match(h.context.lastToast, /自动回炉一次，审计未通过已忽略/);
  assert.match(h.run('outputTemplate()'), /审计未通过，已按设置忽略并继续/);
  h.run('project.activeStep = "storyboard"');
  const storyboard = h.run('outputTemplate()');
  assert.match(storyboard, /已继续 · 审计未通过/);
  assert.match(storyboard, /audit-ignored-result/);
  assert.match(storyboard, /auto-note"><i>!<\/i>/);
  assert.doesNotMatch(storyboard, /分镜文本审计通过|全部通过/);
  h.run('project.activeStep = "video"; project.completed.push("assets")');
  const video = h.run('outputTemplate()');
  assert.match(video, /本地参考图和分镜已经准备完成/);
  assert.match(video, /审计未通过，已按设置忽略并继续/);
  assert.equal(h.context.settingsOpened, undefined);
});

test('审计忽略后的执行进度完成并冻结计时，重载后保留琥珀状态', async () => {
  const h = harness({ generateWorkflow: async () => ({ data: fixture({ ignored: true }) }) });
  loadConfirmedProject(h);
  await h.run('startGeneration()');
  assert.equal(h.run('project.workflowProgress.status'), 'completed');
  assert.equal(h.run('project.workflowProgress.phase'), 'completed');
  assert.equal(h.run('project.workflowProgress.auditIgnored'), true);
  assert.equal(h.run('project.workflowProgress.repairCount'), 1);
  const elapsed = h.run('project.workflowProgress.elapsedMs');
  assert.equal(h.run('summarizeWorkflowProgress(project.workflowProgress, Date.now() + 900000).elapsedMs'), elapsed);
  h.run('project = normalizeProject(JSON.parse(JSON.stringify(project)))');
  assert.equal(h.run('project.workflowProgress.auditIgnored'), true);
  const panel = h.run('workflowProgressTemplate()');
  assert.match(panel, /workflow-progress-dot completed warning/);
  assert.match(panel, /分镜流程已完成 · 审计失败已忽略/);
  assert.match(panel, /自动回炉 1 \/ 1 次/);
  assert.doesNotMatch(panel, /执行失败|分镜流程未完成/);
});

test('忽略审计后复制正文不包含失败问题与审计附件', () => {
  let copied = '';
  const h = harness();
  const data = fixture({ ignored: true });
  h.context.data = data;
  h.context.captureCopy = (value) => { copied = value; };
  h.run('project.outputs = renderAIWorkflow(data); project.activeStep = "storyboard"; copyText = captureCopy; copyOutput()');
  assert.equal(copied, data.storyboard.shots[0].prompt);
  assert.doesNotMatch(copied, /审计|回炉|缺少原文复核事实|C6/);
});

test('同文件名不同素材生成一张后反复对齐不丢失，也不会共享到另一项', () => {
  const h = harness();
  h.context.prompts = [
    { name: '阿宁', type: '人物参考图', fileName: 'reference.png', prompt: '阿宁' },
    { name: '书房', type: '场景参考图', fileName: 'reference.png', prompt: '书房' },
  ];
  h.run('project.assetGeneration = createAssetGenerationState(prompts); alignAssetGenerationItems(prompts)');
  h.run('project.assetGeneration.items[0].files = [{ localPath: "C:/aning.png", imageUrl: "local:aning", provider: "codex-subscription" }]; alignAssetGenerationItems(prompts); alignAssetGenerationItems(prompts)');
  assert.equal(h.run('project.assetGeneration.items[0].files[0].localPath'), 'C:/aning.png');
  assert.equal(h.run('project.assetGeneration.items[1].files.length'), 0);
  assert.equal(h.run('project.assetGeneration.generatedCount'), 1);
  h.run('project.assetGeneration.items[1].files = [{ localPath: "C:/study.png" }]; alignAssetGenerationItems(prompts)');
  assert.equal(h.run('project.assetGeneration.items[0].files[0].localPath'), 'C:/aning.png');
  assert.equal(h.run('project.assetGeneration.items[1].files[0].localPath'), 'C:/study.png');
  h.run('prompts.reverse(); alignAssetGenerationItems(prompts)');
  assert.equal(h.run('project.assetGeneration.items[0].name'), '书房');
  assert.equal(h.run('project.assetGeneration.items[0].files[0].localPath'), 'C:/study.png');
  assert.equal(h.run('project.assetGeneration.items[1].files[0].localPath'), 'C:/aning.png');
});

test('唯一文件名重排继续恢复旧图，新增同名身份不会重复复用原图', () => {
  const h = harness();
  h.context.prompts = [
    { name: '阿宁', type: '人物参考图', fileName: 'aning.png' },
    { name: '书房', type: '场景参考图', fileName: 'study.png' },
  ];
  h.run('project.assetGeneration = createAssetGenerationState(prompts); project.assetGeneration.items[0].localPath = "C:/aning.png"; project.assetGeneration.items[1].files = [{ localPath: "C:/study.png" }]; prompts.reverse(); alignAssetGenerationItems(prompts)');
  assert.equal(h.run('project.assetGeneration.items[0].files[0].localPath'), 'C:/study.png');
  assert.equal(h.run('project.assetGeneration.items[1].files[0].localPath'), 'C:/aning.png');
  h.run('prompts.push({ ...prompts[1] }); alignAssetGenerationItems(prompts)');
  assert.equal(h.run('project.assetGeneration.items[1].files[0].localPath'), 'C:/aning.png');
  assert.equal(h.run('project.assetGeneration.items[2].files.length'), 0);
  // Old projects may have only filenames; unique filename recovery remains supported.
  h.run('prompts = [{ name: "书房", type: "场景参考图", fileName: "study.png" }, { name: "阿宁", type: "人物参考图", fileName: "aning.png" }]; project.assetGeneration.items = [{ fileName: "aning.png", localPath: "C:/legacy-aning.png" }, { fileName: "study.png", localPath: "C:/legacy-study.png" }]; alignAssetGenerationItems(prompts)');
  assert.equal(h.run('project.assetGeneration.items[0].files[0].localPath'), 'C:/legacy-study.png');
  assert.equal(h.run('project.assetGeneration.items[1].files[0].localPath'), 'C:/legacy-aning.png');
});

test('生成等待提示只承诺回炉一次并说明失败继续，初始进度上限为一次', () => {
  const h = harness();
  h.run('project.running = true; workflowRun = { ownerProject: project }');
  assert.match(h.run('outputTemplate()'), /最多自动回炉一次/);
  assert.match(h.run('outputTemplate()'), /回炉后仍未通过将保留警告并继续下一步/);
  assert.match(h.run('workflowProgressTemplate()'), /自动回炉 0 \/ 1 次/);
});

test('切换项目后拒绝迟到的生成结果', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const h = harness({ generateWorkflow: () => pending });
  loadConfirmedProject(h);
  h.run(`projectLibrary.projects.push(createProject({ id: 'other', script: '另一个项目' }));`);
  const run = h.run('startGeneration()');
  h.run(`switchProject('other')`);
  resolve({ data: fixture() });
  await run;
  assert.equal(h.run('project.id'), 'other');
  assert.deepEqual(h.snapshot('project.outputs'), {});
  assert.equal(h.run('projectLibrary.projects[0].outputs.storyboard.prompts[0]'), '旧分镜');
});

test('Skill 短块在视频初始化和对齐后仍为3秒，提交前阻止实际请求', async () => {
  let called = 0;
  const h = harness({ createSeedanceTask: async () => { called += 1; } });
  h.context.data = fixture();
  h.run(`project.outputs = renderAIWorkflow(data); initializeVideoGeneration(project.outputs.storyboard.prompts); alignVideoGenerationItems(project.outputs.storyboard.prompts);`);
  assert.equal(h.run('project.videoGeneration.items[0].duration'), 3);
  assert.equal(h.run('videoDurationSummary(project.outputs.storyboard.prompts, project.videoGeneration.items)'), '3 秒');
  await h.run('generateSeedanceVideos({ token: generationRun })');
  assert.equal(called, 0);
  assert.equal(h.run('project.videoGeneration.items[0].duration'), 3);
  assert.match(h.run('project.videoGeneration.lastError'), /Seedance 当前仅接受4—15秒/);
  assert.match(h.run('project.videoGeneration.lastError'), /不会自动补空镜、加速或拉长/);
});

test('新增参考图按具名声明位于块头，删除不破坏时间片', () => {
  const h = harness();
  const data = fixture();
  h.context.prompt = data.storyboard.shots[0].prompt;
  const updated = h.run(`insertSkillReferenceDeclaration(prompt, 2, { name: '信纸', type: '道具参考图' })`);
  assert.ok(updated.indexOf('@信纸') < updated.indexOf('[0-3秒]'));
  assert.match(updated, /道具：@信纸/);
  assert.doesNotMatch(updated, /@Image2/);
  h.context.updated = updated;
  const removed = h.run(String.raw`normalizeImageReferenceSequence(updated.split('\n').filter((line) => !line.includes('@信纸')).join('\n'), [{ ref: '@Image1', asset: '阿宁' }]).prompt`);
  assert.equal(removed, data.storyboard.shots[0].prompt);
});

test('复制当前分镜仅包含已通过正文，不包含审计附件', () => {
  let copied = '';
  const h = harness();
  h.context.data = fixture();
  h.context.captureCopy = (value) => { copied = value; };
  h.run(`project.outputs = renderAIWorkflow(data); project.activeStep = 'storyboard'; copyText = captureCopy; copyOutput();`);
  assert.equal(copied, fixture().storyboard.shots[0].prompt);
  assert.doesNotMatch(copied, /审计结果|自动回炉/);
});

function progressFixture(options, sequence = 1, overrides = {}) {
  const now = Date.now();
  return { schemaVersion: 1, ...options, sequence, status: 'running', phase: 'candidate', startedAt: now - 5000, updatedAt: now, elapsedMs: 5000,
    preparationMs: 5, prompt: { systemChars: 44000, skillChars: 43000, inputChars: 400, thinkingMode: 'enabled', reasoningEffort: 'high' }, repairCount: 0, maxRepairs: 3,
    requests: [{ id: 1, kind: 'candidate', status: 'running', phase: 'thinking', elapsedMs: 4995, waitingMs: 800, thinkingMs: 4195,
      firstResponseMs: 20, firstReasoningMs: 800, firstContentMs: null, streamed: true }], ...overrides };
}

test('结果下方常驻四项进度面板，空闲时也可见且不显示旧流程', () => {
  const h = harness();
  const html = h.run('appTemplate()');
  assert.ok(html.indexOf('id="workflowProgressPanel"') > html.indexOf('id="outputArea"'));
  assert.match(html, /01 提示词准备/);
  assert.match(html, /02 分析 \/ 分镜生成/);
  assert.match(html, /03 模型思考/);
  assert.match(html, /04 独立审计 · 60 项/);
  assert.match(html, /等待开始生成分镜/);
  assert.doesNotMatch(html, /分集大纲|短剧剧本/);
});

test('进度事件只更新面板，过滤错项目、错任务与过期序号，结束后释放订阅与计时', async () => {
  let listener, options, resolve, unsubscribed = 0;
  const h = harness({
    onWorkflowProgress: (callback) => { listener = callback; return () => { unsubscribed += 1; }; },
    generateWorkflow: (_script, opts) => { options = opts; return new Promise((done) => { resolve = done; }); },
  });
  loadConfirmedProject(h);
  h.run('globalThis.renderCalls = 0; render = () => { renderCalls += 1; };');
  const running = h.run('startGeneration()');
  assert.equal(h.intervals.size, 1);
  listener(progressFixture({ ...options, projectId: 'wrong-project' }));
  assert.equal(h.run('project.workflowProgress.sequence'), 0);
  listener(progressFixture({ ...options, runId: 'wrong-run' }));
  assert.equal(h.run('project.workflowProgress.sequence'), 0);
  listener(progressFixture(options, 2));
  listener(progressFixture(options, 1, { phase: 'audit' }));
  assert.equal(h.run('project.workflowProgress.sequence'), 2);
  assert.equal(h.run('renderCalls'), 1);
  assert.match(h.run('workflowProgressTemplate()'), /首段等待 800 毫秒/);
  assert.doesNotMatch(h.run('workflowProgressTemplate()'), /首段等待 20 毫秒/);
  resolve({ data: fixture() });
  await running;
  assert.equal(unsubscribed, 1);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.run('project.workflowProgress.status'), 'completed');
});

test('失败后保留耗时，重启恢复中断状态且不持续增长', async () => {
  let listener, options;
  const h = harness({ onWorkflowProgress: (callback) => { listener = callback; return () => {}; }, generateWorkflow: async (_script, opts) => {
    options = opts; listener(progressFixture(options)); throw new Error('DeepSeek 请求超时');
  } });
  loadConfirmedProject(h);
  await h.run('startGeneration()');
  assert.equal(h.run('project.workflowProgress.status'), 'failed');
  assert.ok(h.run('project.workflowProgress.elapsedMs') >= 5000);
  assert.match(h.run('workflowProgressTemplate()'), /失败前：模型思考/);
  assert.equal(h.intervals.size, 0);
  h.context.savedProgress = progressFixture(options);
  h.run(`globalThis.restored = normalizeProject({ id: 'restored', workflowProgress: savedProgress })`);
  assert.equal(h.run('restored.workflowProgress.status'), 'stopped');
  assert.equal(h.run('restored.workflowProgress.elapsedMs'), 5000);
});

test('切换项目冻结旧进度并解绑；旧任务finally不清理新任务定时器', async () => {
  const listeners = [], requests = [];
  let unsubscribed = 0;
  const h = harness({ onWorkflowProgress: (callback) => { listeners.push(callback); return () => { unsubscribed += 1; }; }, generateWorkflow: (_script, options) => new Promise((resolve) => requests.push({ options, resolve })) });
  loadConfirmedProject(h);
  h.run(`projectLibrary.projects.push(createProject({ id: 'other', script: '另一段原文' }));`);
  const first = h.run('startGeneration()');
  listeners[0](progressFixture(requests[0].options));
  h.run(`switchProject('other')`);
  assert.equal(h.run('projectLibrary.projects[0].workflowProgress.status'), 'stopped');
  assert.equal(h.intervals.size, 0);
  assert.equal(unsubscribed, 1);
  const second = h.run('startGeneration()');
  listeners[0](progressFixture(requests[0].options, 5, { status: 'completed', phase: 'completed' }));
  assert.equal(h.run('project.workflowProgress.sequence'), 0);
  requests[0].resolve({ data: fixture() });
  await first;
  assert.equal(h.intervals.size, 1);
  assert.equal(unsubscribed, 1);
  requests[1].resolve({ data: fixture() });
  await second;
  assert.equal(h.intervals.size, 0);
  assert.equal(unsubscribed, 2);
});

test('一键全流程默认关闭且仅接受布尔 true，开关和主按钮保持对应', () => {
  const h = harness();
  for (const value of [undefined, null, false, 1, 'true', {}, []]) {
    h.context.option = value;
    assert.equal(h.run('createProject({autoRunToVideo:option}).autoRunToVideo'), false);
    assert.equal(h.run('normalizeProject({autoRunToVideo:option}).autoRunToVideo'), false);
  }
  assert.equal(h.run('normalizeProject({autoRunToVideo:true}).autoRunToVideo'), true);
  assert.match(h.run('appTemplate()'), /一键跑完全流程/);
  assert.match(h.run('appTemplate()'), /从故事分析自动完成参考图，再批量生成全部视频/);
  assert.doesNotMatch(h.run('appTemplate()'), /id="autoRunToVideo"[^>]*checked/);
  h.run('project.autoRunToVideo = true');
  for (const step of ['analysis', 'storyboard', 'assets', 'video']) {
    h.context.step = step;
    h.run('project.activeStep = step');
    assert.match(h.run('appTemplate()'), /id="startGenerate"[^>]*>[\s\S]*?一键生成到视频/);
  }
  h.run('project.running = true');
  assert.match(h.run('appTemplate()'), /id="autoRunToVideo"[^>]*checked[^>]*disabled/);
});

test('一键全流程开关按项目持久化、JSON导入导出保留，保存失败回滚', () => {
  const h = harness();
  assert.equal(h.run('setAutoRunToVideo(true)'), true);
  assert.equal(h.run('project.autoRunToVideo'), true);
  assert.equal(h.run('JSON.parse(localStorage.getItem(LIBRARY_STORAGE_KEY)).projects[0].autoRunToVideo'), true);
  let exported;
  h.context.Blob = class { constructor(parts) { exported = parts.join(''); } };
  h.context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
  h.context.document.createElement = () => ({ click() {} });
  h.run('exportProject()');
  assert.equal(JSON.parse(exported).autoRunToVideo, true);
  h.context.FileReader = class { readAsText(file) { this.result = file.content; this.onload(); } };
  h.context.event = { target: { files: [{ content: exported }], value: 'project.json' } };
  h.run('importProject(event)');
  assert.equal(h.run('project.autoRunToVideo'), true);
  h.run('project.running = true');
  assert.equal(h.run('setAutoRunToVideo(false)'), false);
  assert.equal(h.run('project.autoRunToVideo'), true);
  h.run('project.running = false; project.updatedAt = "旧时间"; localStorage.setItem = () => { throw new Error("存储已满"); }');
  assert.equal(h.run('setAutoRunToVideo(false)'), false);
  assert.equal(h.run('project.autoRunToVideo'), true);
  assert.equal(h.run('project.updatedAt'), '旧时间');
  assert.match(h.context.lastToast, /保存全流程设置失败，已保留原设置/);
});

function autoPipelineFixture({ count = 2, duration = 6, partial = false } = {}) {
  const data = fixture({ duration, partial });
  const first = data.storyboard.shots[0];
  const names = ['阿宁', '阿岚', '阿远'];
  data.storyboard.shots = Array.from({ length: count }, (_value, index) => {
    const name = names[index];
    const no = String(index + 1).padStart(2, '0');
    return { ...structuredClone(first), no, title: `${name}看信`, uploads: [{ ref: '@Image1', asset: name, purpose: '人物参考' }], prompt: first.prompt.replaceAll('阿宁', name).replace('生成块 01', `生成块 ${no}`) };
  });
  data.assets.characters = names.slice(0, count).map((name, index) => ({ name, fileName: `character-${index}.png`, prompt: `${name}的单人参考图` }));
  return data;
}

function prepareNamedReferenceProject(h) {
  const data = fixture({ duration: 6 });
  const names = ['阿宁', '书房（白天）', '阿岚', '信纸', '书桌', '庭院', '阿远'];
  data.storyboard.shots[0].uploads = names.map((name, index) => ({ ref: `@Image${index + 1}`, asset: name, purpose: `${name}视觉参考` }));
  data.storyboard.shots[0].prompt = '🎬 生成块 01（时长：6秒）\n本段总时长：6秒\n人物：@阿宁\n场景：@书房（白天）\n\n[0-6秒] @阿宁看信，镜头转向@书房（白天）。';
  data.assets.characters = names.map((name) => ({ name, prompt: `${name}参考图`, fileName: `old-${name}.png` }));
  h.context.data = data;
  h.run(`
    project.outputs = renderAIWorkflow(data);
    project.outputs.video = makeOutput('video');
    project.completed = ['analysis', 'storyboard'];
    project.activeStep = 'video';
    project.assetGeneration = createAssetGenerationState(project.outputs.assets.promptItems);
    project.assetGeneration.items.forEach((item, index) => { item.files = [{localPath:'C:/reference-' + index + '.png', imageUrl:'local:' + index}]; });
    project.assetGeneration.items[0].files.push({localPath:'C:/aning-variant.png', imageUrl:'local:aning-variant'});
    alignAssetGenerationItems(project.outputs.assets.promptItems);
    initializeVideoGeneration(project.outputs.storyboard.prompts);
  `);
  return data;
}

test('已有全部本地图片对齐后自动完成第三步，清空任一素材后立即恢复待完成', () => {
  const h = harness();
  prepareNamedReferenceProject(h);
  assert.equal(h.run('project.assetGeneration.status'), 'complete');
  assert.equal(h.run('project.assetGeneration.generatedCount'), 7);
  assert.equal(h.run('project.completed.includes("assets")'), true);
  h.run('project.activeStep = "assets"');
  assert.match(h.run('outputContentTemplate()'), /阶段状态<\/span><b><i><\/i> 已完成/);
  assert.match(h.run('outputContentTemplate()'), /参考图已全部完成/);
  h.run('clearLocalAssetImages(2)');
  assert.equal(h.run('project.assetGeneration.status'), 'pending');
  assert.equal(h.run('project.assetGeneration.generatedCount'), 6);
  assert.equal(h.run('project.completed.includes("assets")'), false);
  assert.match(h.run('outputContentTemplate()'), /阶段状态<\/span><b><i><\/i> 待生成/);
  assert.equal(h.run('project.assetGeneration.items[0].files[1].localPath'), 'C:/aning-variant.png');
});

test('本地上传最后一张参考图后完成第三步，无需手动确认才能刷新状态', async () => {
  const h = harness({ selectLocalAssetImages: async () => ({ files: [{ localPath: 'C:/uploaded-last.png' }] }) });
  prepareNamedReferenceProject(h);
  h.run('project.activeStep = "assets"; clearLocalAssetImages(6)');
  assert.equal(h.run('project.completed.includes("assets")'), false);
  await h.run('selectLocalAssetImages(6)');
  assert.equal(h.run('project.assetGeneration.status'), 'complete');
  assert.equal(h.run('project.assetGeneration.generatedCount'), 7);
  assert.equal(h.run('project.completed.includes("assets")'), true);
  assert.match(h.run('outputContentTemplate()'), /阶段状态<\/span><b><i><\/i> 已完成/);
});

test('GPT 生图传准确素材名称与名称文件名，全部完成后自动标记第三步完成', async () => {
  const requests = [];
  const h = harness({
    getCodexImageStatus: async () => ({ available: true, authenticated: true, imageGeneration: true }),
    generateCodexImage: async options => { requests.push(options); return { files: [{localPath:`C:/${options.assetName}.png`}] }; },
  });
  h.context.data = fixture({ duration: 6 });
  h.context.data.assets.characters[0].name = '周成海（青年）';
  h.context.document.querySelectorAll = () => [];
  h.run('project.outputs = renderAIWorkflow(data); project.completed = ["analysis", "storyboard"]; project.activeStep = "assets"');
  await h.run('generateCodexImageAssets()');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].assetName, '周成海（青年）');
  assert.equal(requests[0].fileName, '周成海（青年）.png');
  assert.equal(h.run('project.outputs.assets.promptItems[0].fileName'), '周成海（青年）.png');
  assert.equal(h.run('project.assetGeneration.status'), 'complete');
  assert.equal(h.run('project.completed.includes("assets")'), true);
  assert.match(h.run('outputContentTemplate()'), /阶段状态<\/span><b><i><\/i> 已完成/);
});

test('切换到名称文件名按唯一姓名和类型保留旧图，不向其他人继承图', () => {
  const h = harness();
  h.context.prompts = [{ name: '阿宁', type: '人物参考图', fileName: 'old-a.png' }, { name: '阿岚', type: '人物参考图', fileName: 'old-b.png' }];
  h.run('project.assetGeneration = createAssetGenerationState(prompts); project.assetGeneration.items[0].files = [{localPath:"C:/aning-old.png"}]; project.assetGeneration.items[1].files = [{localPath:"C:/alan-old.png"}]; prompts = [{name:"阿岚",type:"人物参考图",fileName:"阿岚.png"},{name:"阿宁",type:"人物参考图",fileName:"阿宁.png"}]; alignAssetGenerationItems(prompts)');
  assert.deepEqual(h.snapshot('project.assetGeneration.items.map(item=>item.files[0].localPath)'), ['C:/alan-old.png', 'C:/aning-old.png']);
  h.run('prompts[1] = {name:"另一个人",type:"人物参考图",fileName:"阿宁.png"}; alignAssetGenerationItems(prompts)');
  assert.equal(h.run('project.assetGeneration.items[1].files.length'), 0);
  assert.equal(h.run('project.assetGeneration.items[0].files[0].localPath'), 'C:/alan-old.png');
});

test('七项旧上传计划配两项具名正文时只请求两张图并正确转换平台映射', () => {
  const h = harness();
  prepareNamedReferenceProject(h);
  assert.equal(h.run('project.outputs.storyboard.shots[0].uploads.length'), 7);
  const request = h.snapshot('prepareSeedancePrompt(project.outputs.storyboard.prompts[0], 0)');
  assert.deepEqual(request.imageInputs.map(item => item.assetName), ['阿宁', '书房（白天）']);
  assert.deepEqual(request.imagePaths, ['C:/reference-0.png', 'C:/reference-1.png']);
  assert.match(request.prompt, /人物：图片1\n场景：图片2/);
  assert.match(request.prompt, /图片1看信，镜头转向图片2/);
  assert.doesNotMatch(request.prompt, /@Image|@阿宁|@书房/);
});

test('未知具名引用在提交视频之前清晰报错，不发送收费请求', async () => {
  let calls = 0;
  const h = harness({ createSeedanceTask: async () => { calls += 1; throw new Error('不应发送'); } });
  prepareNamedReferenceProject(h);
  h.run('project.videoGeneration.items[0].promptOverride = project.outputs.storyboard.prompts[0] + "\\n@不存在的角色。"');
  await h.run('generateSeedanceVideos({token:generationRun,mode:"batch"})');
  assert.equal(calls, 0);
  assert.match(h.run('project.videoGeneration.lastError'), /不存在的角色.*同名素材/);
  assert.equal(h.run('project.running'), false);
});

test('旧引用迁移保留成功视频、认证与已选图片版本，重复渲染不重置成片', () => {
  const h = harness();
  prepareNamedReferenceProject(h);
  h.run('project.videoGeneration.items[0] = {...project.videoGeneration.items[0],status:"success",taskId:"saved-task",localPath:"C:/saved.mp4",referenceBindings:{1:{assetName:"阿宁",localPath:"C:/aning-variant.png"}}}; project.videoGeneration.status = "complete"; project.videoGeneration.generatedCount = 1; project.videoGeneration.pendingCertification = {shotIndex:0,retain:true}; project.completed.push("video")');
  const prompt = h.run('repairVideoReferenceSequence(0,project.outputs.storyboard.prompts[0],project.videoGeneration.items[0],project.videoGeneration)');
  assert.equal(prompt, h.run('project.outputs.storyboard.prompts[0]'));
  assert.equal(h.run('project.videoGeneration.items[0].referenceBindings["asset:阿宁"].localPath'), 'C:/aning-variant.png');
  assert.equal(h.run('project.outputs.storyboard.shots[0].uploads.length'), 2);
  h.run('repairVideoReferenceSequence(0,effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0]),project.videoGeneration.items[0],project.videoGeneration)');
  assert.equal(h.run('project.videoGeneration.items[0].status'), 'success');
  assert.equal(h.run('project.videoGeneration.items[0].taskId'), 'saved-task');
  assert.equal(h.run('project.videoGeneration.items[0].localPath'), 'C:/saved.mp4');
  assert.equal(h.run('project.videoGeneration.status'), 'complete');
  assert.equal(h.run('project.videoGeneration.pendingCertification.retain'), true);
  assert.equal(h.run('project.completed.includes("video")'), true);
  assert.equal(h.run('prepareSeedancePrompt(effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0]),0).imagePaths[0]'), 'C:/aning-variant.png');
});

test('旧同角色正反两槽迁移、删除和切换后保留各自版本，不污染其他素材', () => {
  const h = harness();
  prepareNamedReferenceProject(h);
  h.run(`
    project.outputs.storyboard.prompts[0] = '本段总时长：6秒\\n@Image1用于阿宁正面；@Image2用于阿宁背面；@Image3用于书房（白天）。';
    project.outputs.storyboard.shots[0].uploads = [
      {ref:'@Image1',asset:'阿宁',purpose:'正面'},
      {ref:'@Image2',asset:'阿宁',purpose:'背面'},
      {ref:'@Image3',asset:'书房（白天）',purpose:'场景'},
    ];
    initializeVideoGeneration(project.outputs.storyboard.prompts);
    project.videoGeneration.items[0].referenceBindings = {
      1:{assetName:'阿宁',localPath:'C:/reference-0.png'},
      2:{assetName:'阿宁',localPath:'C:/aning-variant.png'},
      3:{assetName:'书房（白天）',localPath:'C:/reference-1.png'},
    };
    repairVideoReferenceSequence(0,project.outputs.storyboard.prompts[0],project.videoGeneration.items[0],project.videoGeneration);
  `);
  const before = h.snapshot('prepareSeedancePrompt(effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0]),0)');
  assert.deepEqual(before.imagePaths, ['C:/reference-0.png', 'C:/aning-variant.png', 'C:/reference-1.png']);
  assert.deepEqual(before.plan.bindings.map(binding=>binding.key), ['image:1', 'image:2', 'asset:书房（白天）']);
  assert.deepEqual(h.snapshot('project.outputs.storyboard.shots[0].uploads.slice(0,2).map(upload=>upload.legacySeparate)'), [true,true]);
  h.run('removeVideoReference(0,1)');
  const remaining = h.snapshot('prepareSeedancePrompt(effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0]),0)');
  assert.deepEqual(remaining.imagePaths, ['C:/aning-variant.png', 'C:/reference-1.png']);
  assert.equal(remaining.plan.bindings[0].key, 'image:2');
  assert.equal(h.run('project.outputs.storyboard.shots[0].uploads.some(upload=>upload.ref === "@Image1")'), false);
  assert.equal(h.run('project.outputs.storyboard.shots[0].uploads.some(upload=>upload.ref === "@Image2")'), true);
  assert.equal(h.run('selectVideoReference(0,1,0,0)'), true);
  const changed = h.snapshot('prepareSeedancePrompt(effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0]),0)');
  assert.deepEqual(changed.imagePaths, ['C:/reference-0.png', 'C:/reference-1.png']);
  assert.equal(h.run('project.videoGeneration.items[0].referenceBindings["image:2"].localPath'), 'C:/reference-0.png');
  assert.equal(h.run('project.videoGeneration.items[0].referenceBindings["asset:书房（白天）"].localPath'), 'C:/reference-1.png');
});

test('具名素材添加和删除保持正文动作、其他姓名与已有选图稳定', () => {
  const h = harness();
  prepareNamedReferenceProject(h);
  h.run('addVideoReference(0,2)');
  const added = h.run('effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0])');
  assert.match(added, /@阿岚/);
  assert.match(added, /@阿宁看信，镜头转向@书房（白天）/);
  assert.doesNotMatch(added, /@Image/);
  assert.equal(h.run('project.videoGeneration.items[0].referenceBindings["asset:阿岚"].localPath'), 'C:/reference-2.png');
  h.run('removeVideoReference(0,1)');
  const removed = h.run('effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0])');
  assert.doesNotMatch(removed, /@阿宁/);
  assert.match(removed, /阿宁看信，镜头转向@书房（白天）/);
  assert.match(removed, /@阿岚/);
  assert.equal(h.run('project.outputs.storyboard.shots[0].uploads.some(upload => upload.asset === "阿宁")'), false);
  const request = h.snapshot('prepareSeedancePrompt(effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0]),0)');
  assert.deepEqual(request.imageInputs.map(item=>item.assetName), ['书房（白天）', '阿岚']);
});

test('引用选择只切换同名图片版本并保存稳定名称键，跨人物选择被拒绝', () => {
  const h = harness();
  prepareNamedReferenceProject(h);
  assert.equal(h.run('selectVideoReference(0,1,0,1)'), true);
  assert.equal(h.run('project.videoGeneration.items[0].referenceBindings["asset:阿宁"].localPath'), 'C:/aning-variant.png');
  const selected = h.snapshot('project.videoGeneration.items[0].referenceBindings');
  assert.equal(h.run('selectVideoReference(0,1,2,0)'), false);
  assert.match(h.context.lastToast, /只能选择 @阿宁 的同名图片/);
  assert.deepEqual(h.snapshot('project.videoGeneration.items[0].referenceBindings'), selected);
  assert.equal(h.run('prepareSeedancePrompt(effectiveVideoPrompt(0,project.outputs.storyboard.prompts[0]),0).imagePaths[0]'), 'C:/aning-variant.png');
});

test('耗时详情默认折叠，进度刷新与页面模板重绘沿用当前展开状态', () => {
  const h = harness();
  assert.match(h.run('workflowProgressTemplate()'), /<details id="workflowProgressDetails">/);
  assert.doesNotMatch(h.run('workflowProgressTemplate()'), /<details id="workflowProgressDetails" open/);
  const details = { open: true };
  let updated = '';
  const panel = { set innerHTML(value) { updated = value; details.open = /<details id="workflowProgressDetails" open/.test(value); } };
  h.context.document.querySelector = selector => selector === '#workflowProgressDetails' ? details : selector === '#workflowProgressPanel' ? panel : null;
  h.run('updateWorkflowProgressPanel()');
  assert.match(updated, /<details id="workflowProgressDetails" open>/);
  assert.match(h.run('appTemplate()'), /<details id="workflowProgressDetails" open>/);
  details.open = false;
  h.run('updateWorkflowProgressPanel()');
  assert.doesNotMatch(updated, /<details id="workflowProgressDetails" open/);
  assert.doesNotMatch(h.run('appTemplate()'), /<details id="workflowProgressDetails" open/);
});

test('后台生图时切换模块只浏览，真实生图页保持运行并继续保存新版本', async () => {
  let resolveImage, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const calls = { images: 0, cancels: 0, workflow: 0 };
  const h = harness({
    getCodexImageStatus: async () => ({available:true,authenticated:true,imageGeneration:true}),
    generateCodexImage: () => { calls.images += 1; entered(); return new Promise(resolve => { resolveImage = resolve; }); },
    cancelCodexImage: async () => { calls.cancels += 1; },
    generateWorkflow: async () => { calls.workflow += 1; },
  });
  prepareNamedReferenceProject(h);
  const storyboard = h.snapshot('project.outputs.storyboard');
  const oldVideo = h.snapshot('project.videoGeneration');
  const running = h.run('generateCodexImageAssets([0])');
  await waitForMockRequest(reached, running);
  const token = h.run('generationRun');
  h.run('selectWorkflowStep("storyboard")');
  assert.equal(h.run('project.activeStep'), 'storyboard');
  assert.equal(h.run('project.running'), true);
  assert.equal(h.run('generationRun'), token);
  assert.equal(h.run('runningGenerationStep(project)'), 'assets');
  assert.match(h.run('stepTemplate(steps[2])'), /class="step [^"]*running/);
  assert.doesNotMatch(h.run('stepTemplate(steps[1])'), /class="step [^"]*running/);
  assert.match(h.run('outputContentTemplate()'), /阶段状态<\/span><b><i><\/i> 已完成/);
  assert.match(h.run('outputTemplate()'), /running-task-notice/);
  assert.doesNotMatch(h.run('outputContentTemplate()'), /生成 \/ 审计与自动修正中/);
  assert.match(h.run('outputContentTemplate()'), /id="rerunStep"[^>]*disabled/);
  await h.run('rerunCurrentStage()');
  assert.equal(calls.workflow, 0);
  assert.equal(calls.images, 1);
  assert.equal(h.run('generationRun'), token);
  h.run('selectWorkflowStep("invalid-step"); selectWorkflowStep("analysis")');
  assert.equal(h.run('project.activeStep'), 'analysis');
  assert.equal(h.run('generationRun'), token);
  assert.equal(calls.cancels, 0);
  h.run('selectWorkflowStep("assets")');
  assert.equal(h.run('project.activeStep'), 'assets');
  assert.equal(h.run('project.assetGeneration.items[0].status'), 'generating');
  h.run('selectWorkflowStep("storyboard")');
  resolveImage({files:[{localPath:'C:/new-background-variant.png'}]});
  await running;
  assert.deepEqual(h.snapshot('project.assetGeneration.items[0].files.map(file=>file.localPath)'), ['C:/reference-0.png','C:/aning-variant.png','C:/new-background-variant.png']);
  assert.equal(h.run('project.running'), false);
  assert.equal(h.run('project.activeStep'), 'storyboard');
  assert.deepEqual(h.snapshot('project.outputs.storyboard'), storyboard);
  assert.deepEqual(h.snapshot('project.videoGeneration'), oldVideo);
  assert.equal(calls.cancels, 0);
});

test('后台生成分镜时可查看既有素材，等待提示与转圈只属于真实任务模块', async () => {
  let resolveWorkflow;
  const h = harness({generateWorkflow: () => new Promise(resolve => {resolveWorkflow = resolve;})});
  prepareNamedReferenceProject(h);
  h.run('project.script = "锁定的小说原文"; project.activeStep = "storyboard"');
  const running = h.run('startGeneration()');
  const token = h.run('generationRun');
  h.run('selectWorkflowStep("assets")');
  assert.equal(h.run('project.activeStep'), 'assets');
  assert.equal(h.run('generationRun'), token);
  assert.equal(h.run('project.running'), true);
  assert.equal(h.run('runningGenerationStep(project)'), 'analysis');
  assert.match(h.run('stepTemplate(steps[0])'), /class="step [^"]*running/);
  assert.doesNotMatch(h.run('stepTemplate(steps[2])'), /class="step [^"]*running/);
  assert.match(h.run('outputContentTemplate()'), /阶段状态<\/span><b><i><\/i> 已完成/);
  assert.doesNotMatch(h.run('outputContentTemplate()'), /workflow-audit-progress|正在生成并下载视频镜头/);
  assert.match(h.run('outputTemplate()'), /running-task-notice/);
  resolveWorkflow({data:fixture({duration:6})});
  await running;
  assert.equal(h.run('project.running'), false);
});

test('后台生成视频时可查看分析，切换不会停止任务或把分析标为生成中', async () => {
  let resolveTask, entered;
  const reached = new Promise(resolve => {entered = resolve;});
  const h = harness({
    createSeedanceTask: () => {entered(); return new Promise(resolve => {resolveTask = resolve;});},
    getSeedanceTask: async () => ({status:'succeeded',videoUrl:'https://offline.invalid/saved.mp4'}),
    downloadSeedanceVideo: async () => ({localPath:'C:/background-video.mp4'}),
  });
  prepareNamedReferenceProject(h);
  const running = h.run('generateSeedanceVideos({token:generationRun,mode:"batch"})');
  await waitForMockRequest(reached, running);
  const token = h.run('generationRun');
  h.run('selectWorkflowStep("analysis")');
  assert.equal(h.run('project.activeStep'), 'analysis');
  assert.equal(h.run('generationRun'), token);
  assert.equal(h.run('runningGenerationStep(project)'), 'video');
  assert.match(h.run('stepTemplate(steps[3])'), /class="step [^"]*running/);
  assert.doesNotMatch(h.run('stepTemplate(steps[0])'), /class="step [^"]*running/);
  assert.match(h.run('outputContentTemplate()'), /阶段状态<\/span><b><i><\/i> 已完成/);
  resolveTask({id:'background-video',status:'running'});
  await running;
  assert.equal(h.run('project.videoGeneration.items[0].localPath'), 'C:/background-video.mp4');
  assert.equal(h.run('project.running'), false);
  assert.equal(h.run('project.activeStep'), 'analysis');
});

test('第三步重新生成仅追加全部参考图版本，即使自动开关打开且无原文或DeepSeek配置', async () => {
  const requests = [];
  let workflowCalls = 0, videoCalls = 0;
  const h = harness({
    getCodexImageStatus: async () => ({available:true,authenticated:true,imageGeneration:true}),
    generateCodexImage: async options => {requests.push(options);return {files:[{localPath:`C:/rerun-${options.index}.png`}]};},
    generateWorkflow: async () => {workflowCalls += 1; throw new Error('不应重新分析');},
    createSeedanceTask: async () => {videoCalls += 1; throw new Error('不应生成视频');},
  });
  prepareNamedReferenceProject(h);
  h.run('project.activeStep = "assets"; project.autoRunToVideo = true; project.script = ""; deepseekStatus.configured = false; project.videoGeneration.items[0] = {...project.videoGeneration.items[0],status:"success",taskId:"previous-task",localPath:"C:/previous-video.mp4"}; project.videoGeneration.status = "complete"; project.completed.push("video")');
  const storyboard = h.snapshot('project.outputs.storyboard');
  const video = h.snapshot('project.videoGeneration');
  await h.run('rerunCurrentStage()');
  assert.equal(requests.length, 7);
  assert.equal(workflowCalls, 0);
  assert.equal(videoCalls, 0);
  assert.equal(h.context.settingsOpened, undefined);
  assert.equal(h.run('project.autoRunToVideo'), true);
  assert.equal(h.run('project.assetGeneration.status'), 'complete');
  assert.deepEqual(h.snapshot('project.assetGeneration.items.map(item=>item.files.length)'), [3,2,2,2,2,2,2]);
  assert.deepEqual(h.snapshot('project.assetGeneration.items[0].files.map(file=>file.localPath)'), ['C:/reference-0.png','C:/aning-variant.png','C:/rerun-0.png']);
  assert.deepEqual(h.snapshot('project.outputs.storyboard'), storyboard);
  assert.deepEqual(h.snapshot('project.videoGeneration'), video);
  assert.equal(h.run('project.completed.includes("video")'), true);
});

test('关闭自动开关时第三步主按钮只补缺图，不进入故事分析', async () => {
  let workflowCalls = 0;
  const requests = [];
  const h = harness({
    getCodexImageStatus: async () => ({available:true,authenticated:true,imageGeneration:true}),
    generateCodexImage: async options => {requests.push(options);return {files:[{localPath:'C:/filled-last.png'}]};},
    generateWorkflow: async () => {workflowCalls += 1;},
  });
  prepareNamedReferenceProject(h);
  h.run('project.activeStep = "assets"; project.autoRunToVideo = false; project.script = ""; deepseekStatus.configured = false; clearLocalAssetImages(6)');
  const storyboard = h.snapshot('project.outputs.storyboard');
  await h.run('startGeneration()');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].index, 6);
  assert.equal(workflowCalls, 0);
  assert.equal(h.context.settingsOpened, undefined);
  assert.equal(h.run('project.assetGeneration.status'), 'complete');
  assert.deepEqual(h.snapshot('project.outputs.storyboard'), storyboard);
});

test('第四步重新生成始终批量重做视频，即使自动开关打开也不重跑上游', async () => {
  const {h,calls} = autoPipelineHarness();
  prepareNamedReferenceProject(h);
  h.run('project.activeStep = "video"; project.autoRunToVideo = true; project.videoGeneration.items[0].status = "success"; project.videoGeneration.items[0].localPath = "C:/old-complete.mp4"; project.completed.push("video")');
  const storyboard = h.snapshot('project.outputs.storyboard');
  const assets = h.snapshot('project.assetGeneration.items');
  await h.run('rerunCurrentStage()');
  assert.equal(calls.workflows.length, 0);
  assert.equal(calls.images.length, 0);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.downloads.length, 1);
  assert.equal(h.run('project.videoGeneration.generationMode'), 'batch');
  assert.equal(h.run('seedanceStatus.generationMode'), 'confirm');
  assert.equal(h.run('project.videoGeneration.items[0].localPath'), 'C:/mock-video-0.mp4');
  assert.deepEqual(h.snapshot('project.outputs.storyboard'), storyboard);
  assert.deepEqual(h.snapshot('project.assetGeneration.items'), assets);
});

test('前两步阶段重跑只请求分镜流程，自动开关不触发后续图片视频', async () => {
  for (const activeStep of ['analysis','storyboard']) {
    const {h,calls} = autoPipelineHarness();
    prepareNamedReferenceProject(h);
    h.context.selectedStep = activeStep;
    h.run('project.activeStep = selectedStep; project.autoRunToVideo = true');
    await h.run('rerunCurrentStage()');
    assert.equal(calls.workflows.length, 1);
    assert.equal(calls.workflows[0].options.autoRunToVideo === true, false);
    assert.equal(calls.images.length, 0);
    assert.equal(calls.creates.length, 0);
    assert.equal(h.run('project.autoRunToVideo'), true);
  }
});

function autoPipelineHarness({ data = autoPipelineFixture(), imageFailure = -1, videoFailure = -1, ready = true } = {}) {
  const calls = { workflows: [], images: [], creates: [], polls: [], downloads: [], cancels: [] };
  const h = harness({
    getCodexImageStatus: async () => ({ available: ready, authenticated: ready, imageGeneration: ready }),
    generateWorkflow: async (script, options) => { calls.workflows.push({ script, options }); return { data: structuredClone(data) }; },
    generateCodexImage: async options => {
      calls.images.push(options);
      if (options.index === imageFailure) throw new Error('模拟第二张参考图失败');
      return { files: [{ localPath: `C:/mock-reference-${options.index}.png`, imageUrl: `file:///C:/mock-reference-${options.index}.png` }] };
    },
    cancelCodexImage: async jobId => { calls.cancels.push(jobId); return { canceled: true }; },
    createSeedanceTask: async options => {
      const index = calls.creates.length;
      calls.creates.push(options);
      if (index === videoFailure) throw new Error('模拟第二个视频创建失败');
      return { id: `task-${index}`, status: 'running' };
    },
    getSeedanceTask: async id => { calls.polls.push(id); return { status: 'succeeded', videoUrl: `https://offline.invalid/${id}.mp4` }; },
    downloadSeedanceVideo: async options => { calls.downloads.push(options); return { localPath: `C:/mock-video-${options.index}.mp4`, videoFileUrl: `file:///C:/mock-video-${options.index}.mp4` }; },
  });
  h.context.document.querySelectorAll = () => [];
  h.run('project.script = "锁定的小说原文"; project.autoRunToVideo = true; seedanceStatus.generationMode = "confirm"; openSeedanceSettings = () => { globalThis.videoSettingsOpened = true; }; setSeedanceMessage = (message) => { globalThis.videoSettingsMessage = message; }; openCodexImageSettings = () => { globalThis.imageSettingsOpened = true; };');
  return { h, calls, data };
}

async function flushAutoPipelineUntil(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('自动全流程未在离线异步调用结束后收敛');
}

test('自动主链从故事完成两素材两镜头并下载全部视频，批量覆盖只作用于当前项目', async () => {
  const { h, calls } = autoPipelineHarness();
  await h.run('startGeneration()');
  assert.equal(calls.workflows.length, 1);
  assert.equal(calls.workflows[0].options.autoRunToVideo, true);
  assert.equal(calls.images.length, 2);
  assert.equal(calls.creates.length, 2);
  assert.equal(calls.polls.length, 2);
  assert.equal(calls.downloads.length, 2);
  assert.equal(h.run('seedanceStatus.generationMode'), 'confirm');
  assert.equal(h.run('project.videoGeneration.generationMode'), 'batch');
  assert.equal(h.run('project.autoPipeline.status'), 'completed');
  assert.equal(h.run('project.activeStep'), 'video');
  assert.deepEqual(h.snapshot('project.completed'), ['analysis', 'storyboard', 'assets', 'video']);
  assert.deepEqual(h.snapshot('project.videoGeneration.items.map(item => item.localPath)'), ['C:/mock-video-0.mp4', 'C:/mock-video-1.mp4']);
  assert.equal(h.run('project.running'), false);
  assert.equal(h.run('autoPipelineRun'), null);
});

test('一键全流程在生图或视频轮询时查看分镜，后续全部完成仍保持当前查看页', async () => {
  for (const stage of ['assets', 'poll']) {
    const { h, calls } = autoPipelineHarness();
    let resolvePending, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { resolvePending = resolve; });
    const api = h.context.window.storyforgeAI;
    if (stage === 'assets') api.generateCodexImage = async options => {
      calls.images.push(options);
      if (options.index === 0) { entered(); return pending; }
      return { files: [{ localPath: `C:/mock-reference-${options.index}.png` }] };
    };
    if (stage === 'poll') api.getSeedanceTask = async id => {
      calls.polls.push(id);
      if (calls.polls.length === 1) { entered(); return pending; }
      return { status: 'succeeded', videoUrl: `https://offline.invalid/${id}.mp4` };
    };
    const running = h.run('startGeneration()');
    await waitForMockRequest(reached, running);
    assert.equal(h.run('project.running'), true);
    assert.equal(h.run('runningGenerationStep(project)'), stage === 'assets' ? 'assets' : 'video');
    const token = h.run('generationRun');
    h.run('selectWorkflowStep("storyboard")');
    assert.equal(h.run('project.activeStep'), 'storyboard');
    assert.equal(h.run('generationRun'), token);
    resolvePending(stage === 'assets'
      ? { files: [{ localPath: 'C:/mock-reference-0.png' }] }
      : { status: 'succeeded', videoUrl: 'https://offline.invalid/task-0.mp4' });
    await running;
    assert.equal(calls.workflows.length, 1, stage);
    assert.equal(calls.images.length, 2, stage);
    assert.equal(calls.creates.length, 2, stage);
    assert.equal(calls.polls.length, 2, stage);
    assert.equal(calls.downloads.length, 2, stage);
    assert.equal(h.run('project.autoPipeline.status'), 'completed', stage);
    assert.deepEqual(h.snapshot('project.completed'), ['analysis', 'storyboard', 'assets', 'video'], stage);
    assert.equal(h.run('project.activeStep'), 'storyboard', stage);
    assert.equal(h.run('project.running'), false, stage);
    assert.equal(h.run('autoPipelineRun'), null, stage);
  }
});

test('自动主链第二张图片失败保留第一张，并停止后续图片和所有视频', async () => {
  const { h, calls } = autoPipelineHarness({ data: autoPipelineFixture({ count: 3 }), imageFailure: 1 });
  await h.run('startGeneration()');
  assert.equal(calls.images.length, 2);
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.downloads.length, 0);
  assert.equal(h.run('project.autoPipeline.status'), 'failed');
  assert.equal(h.run('project.autoPipeline.phase'), 'assets');
  assert.equal(h.run('project.assetGeneration.items[0].files[0].localPath'), 'C:/mock-reference-0.png');
  assert.equal(h.run('project.assetGeneration.items[1].status'), 'failed');
  assert.equal(h.run('project.assetGeneration.items[2].files.length'), 0);
  assert.equal(h.run('project.completed.includes("assets")'), false);
});

test('自动主链第二个视频失败保留首个成片，第三个视频不提交', async () => {
  const { h, calls } = autoPipelineHarness({ data: autoPipelineFixture({ count: 3 }), videoFailure: 1 });
  await h.run('startGeneration()');
  assert.equal(calls.images.length, 3);
  assert.equal(calls.creates.length, 2);
  assert.equal(calls.downloads.length, 1);
  assert.equal(h.run('project.autoPipeline.status'), 'failed');
  assert.equal(h.run('project.autoPipeline.phase'), 'video');
  assert.equal(h.run('project.videoGeneration.items[0].localPath'), 'C:/mock-video-0.mp4');
  assert.equal(h.run('project.videoGeneration.items[0].status'), 'success');
  assert.equal(h.run('project.videoGeneration.items[1].status'), 'failed');
  assert.equal(h.run('project.videoGeneration.items[2].status'), 'pending');
  assert.equal(h.run('project.completed.includes("video")'), false);
});

test('自动主链在生图前检查原始三秒或三十秒时长，不能用归一后的时长绕过', async () => {
  for (const duration of [3, 30]) {
    const { h, calls } = autoPipelineHarness({ data: autoPipelineFixture({ duration }) });
    await h.run('startGeneration()');
    assert.equal(calls.workflows.length, 1);
    assert.equal(calls.images.length, 0);
    assert.equal(calls.creates.length, 0);
    assert.equal(h.run('project.autoPipeline.status'), 'failed');
    assert.equal(h.run('project.outputs.storyboard.shots[0].duration'), duration);
    assert.match(h.run('project.autoPipeline.error'), /原始时长.*4–15/);
  }
});

test('自动主链真实部分交付阻塞暂停在分镜，未生成图片或视频', async () => {
  const { h, calls } = autoPipelineHarness({ data: autoPipelineFixture({ partial: true }) });
  await h.run('startGeneration()');
  assert.equal(h.run('project.activeStep'), 'storyboard');
  assert.equal(h.run('project.autoPipeline.status'), 'failed');
  assert.match(h.run('project.autoPipeline.error'), /阻塞内容/);
  assert.equal(calls.images.length, 0);
  assert.equal(calls.creates.length, 0);
});

test('自动主链缺视频配置或Codex未就绪时不启动DeepSeek生成', async () => {
  const noVideo = autoPipelineHarness();
  noVideo.h.run('seedanceStatus.configured = false');
  await noVideo.h.run('startGeneration()');
  assert.equal(noVideo.calls.workflows.length, 0);
  assert.equal(noVideo.calls.images.length, 0);
  assert.equal(noVideo.h.context.videoSettingsOpened, true);
  const noImages = autoPipelineHarness({ ready: false });
  await noImages.h.run('startGeneration()');
  assert.equal(noImages.calls.workflows.length, 0);
  assert.equal(noImages.calls.images.length, 0);
  assert.equal(noImages.h.run('project.autoPipeline.status'), 'failed');
  assert.equal(noImages.h.context.imageSettingsOpened, true);
});

test('自动主链分镜和实际图片使用同一次启动锁定的两个Skill快照', async () => {
  const { h, calls, data } = autoPipelineHarness();
  const skills = { storyboard: skillDocument('本次分镜.md'), assets: skillDocument('本次资产.md', '启动时锁定的资产要求') };
  h.context.skills = skills;
  h.run('project.generationSkills = normalizeGenerationSkills(skills)');
  h.context.window.storyforgeAI.generateWorkflow = async (script, options) => {
    calls.workflows.push({ script, options });
    h.run('project.generationSkills.assets.content = "生成期间修改的要求"');
    return { data: structuredClone(data) };
  };
  await h.run('startGeneration()');
  assert.deepEqual(calls.workflows[0].options.stageSkills, skills);
  assert.equal(calls.images.length, 2);
  for (const request of calls.images) assert.deepEqual(request.assetSkill, skills.assets);
});

test('自动主链停止或切换时丢弃各阶段迟到响应，轮询结果不会写入新项目', async () => {
  for (const stage of ['storyboard', 'assets', 'poll', 'download']) {
    for (const operation of ['stop', 'switch']) {
      const { h, calls, data } = autoPipelineHarness();
      let resolvePending, entered;
      const reached = new Promise(resolve => { entered = resolve; });
      const pending = new Promise(resolve => { resolvePending = resolve; });
      const api = h.context.window.storyforgeAI;
      if (stage === 'storyboard') api.generateWorkflow = async (script, options) => { calls.workflows.push({ script, options }); entered(); return pending; };
      if (stage === 'assets') api.generateCodexImage = async options => { calls.images.push(options); entered(); return pending; };
      if (stage === 'poll') api.getSeedanceTask = async id => { calls.polls.push(id); entered(); return pending; };
      if (stage === 'download') api.downloadSeedanceVideo = async options => { calls.downloads.push(options); entered(); return pending; };
      h.run('projectLibrary.projects.push(createProject({ id:"other-auto", script:"另一个项目" }))');
      const running = h.run('startGeneration()');
      await reached;
      const before = { images: calls.images.length, creates: calls.creates.length, downloads: calls.downloads.length };
      h.run(operation === 'switch' ? 'switchProject("other-auto")' : 'stopCurrentGeneration()');
      const currentBeforeLateResponse = h.snapshot('[project.id, project.outputs, project.completed, project.videoGeneration]');
      resolvePending(stage === 'storyboard' ? { data } : stage === 'assets' ? { files: [{ localPath: 'C:/late-image.png' }] } : stage === 'poll' ? { status: 'succeeded', videoUrl: 'https://offline.invalid/late.mp4' } : { localPath: 'C:/late-video.mp4' });
      await running;
      assert.deepEqual({ images: calls.images.length, creates: calls.creates.length, downloads: calls.downloads.length }, before, `${stage}/${operation} launched a later stage`);
      assert.deepEqual(h.snapshot('[project.id, project.outputs, project.completed, project.videoGeneration]'), currentBeforeLateResponse, `${stage}/${operation} wrote a late response`);
      assert.equal(h.run('projectLibrary.projects[0].autoPipeline.status'), 'stopped');
      assert.equal(h.run('autoPipelineRun'), null);
    }
  }
});

test('重启恢复运行中的自动主链为已停止，完成成果保留且不自动发起接口', () => {
  const { h, calls } = autoPipelineHarness();
  h.context.saved = { autoRunToVideo: true, autoPipeline: { status: 'running', phase: 'video', startedAt: 1234 }, outputs: { video: { title: '已保存视频', body: '' } }, videoGeneration: { items: [{ status: 'success', localPath: 'C:/saved.mp4' }] } };
  h.run('project = normalizeProject(saved)');
  assert.equal(h.run('project.autoPipeline.status'), 'stopped');
  assert.match(h.run('project.autoPipeline.error'), /上次全流程已中断/);
  assert.equal(h.run('project.videoGeneration.items[0].localPath'), 'C:/saved.mp4');
  assert.equal(h.run('project.running'), false);
  assert.equal(calls.workflows.length + calls.images.length + calls.creates.length, 0);
});

function prepareAutoPortraitResume(h, data) {
  h.context.data = data;
  h.run('project.outputs = renderAIWorkflow(data); project.completed = ["analysis", "storyboard", "assets"]; project.assetGeneration = createAssetGenerationState(project.outputs.assets.promptItems); project.assetGeneration.items.forEach((item, index) => { item.files = [{ localPath: "C:/ready-" + index + ".png" }]; }); initializeVideoGeneration(project.outputs.storyboard.prompts); project.videoGeneration.pendingCertification = {shotIndex:0,blockedInputs:[{assetItemIndex:0,fileIndex:0,assetName:"阿宁"}],resumeIndexes:[0,1],mode:"confirm"}; project.videoGeneration.items[0].status = "certification"; project.autoPipeline = {status:"failed",phase:"video",error:"需要认证"}; project.activeStep = "video";');
  h.context.document.querySelector = selector => selector.startsWith('[data-portrait-asset-id-index=') ? { value: 'asset-approved-reference' } : null;
}

test('自动主链完成真人认证后批量恢复全部剩余镜头，不重跑故事或图片', async () => {
  const { h, calls, data } = autoPipelineHarness();
  prepareAutoPortraitResume(h, data);
  const callbacks = [];
  h.context.window.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
  h.run('savePortraitCertificationAndResume()');
  assert.equal(callbacks.length, 1);
  callbacks[0]();
  await flushAutoPipelineUntil(() => h.run('project.autoPipeline.status') !== 'running');
  assert.equal(h.run('project.autoPipeline.status'), 'completed');
  assert.equal(h.run('project.videoGeneration.generationMode'), 'batch');
  assert.equal(h.run('seedanceStatus.generationMode'), 'confirm');
  assert.equal(calls.workflows.length, 0);
  assert.equal(calls.images.length, 0);
  assert.equal(calls.creates.length, 2);
  assert.equal(calls.downloads.length, 2);
  assert.equal(calls.creates[0].imageInputs[0].assetId, 'asset-approved-reference');
});

test('真人认证恢复计时器执行前停止或切换项目，不会误启动视频', async () => {
  for (const operation of ['stop', 'switch', 'switch-back']) {
    const { h, calls, data } = autoPipelineHarness();
    prepareAutoPortraitResume(h, data);
    const originalId = h.run('project.id');
    const callbacks = [];
    h.context.window.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
    h.run('savePortraitCertificationAndResume(); projectLibrary.projects.push(createProject({id:"after-certification",script:"新项目"}))');
    if (operation === 'stop') h.run('stopCurrentGeneration()');
    else {
      h.run('switchProject("after-certification")');
      if (operation === 'switch-back') {
        h.context.originalId = originalId;
        h.run('switchProject(originalId)');
      }
    }
    const beforeCallback = h.snapshot('[project.id, project.outputs, project.completed, project.videoGeneration]');
    callbacks[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.run('project.id'), operation === 'switch' ? 'after-certification' : originalId);
    assert.deepEqual(h.snapshot('[project.id, project.outputs, project.completed, project.videoGeneration]'), beforeCallback, operation);
    assert.equal(calls.workflows.length + calls.images.length + calls.creates.length + calls.polls.length + calls.downloads.length, 0, operation);
    assert.equal(h.run('autoPipelineRun'), null, operation);
  }
});
