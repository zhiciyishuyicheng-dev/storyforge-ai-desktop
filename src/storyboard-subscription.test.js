import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as durations from './seedance-duration.js';
import * as references from './seedance-references.js';
import * as generation from './seedance-generation.js';
import * as workflowProgress from './workflow-progress.js';

const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const renderer = source.slice(0, source.lastIndexOf('\nrender();')).replace(/^import .*;\r?\n/gm, '');
const models = [
  { id: 'model-a', model: 'test-gpt-a', displayName: 'Test GPT A', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) },
  { id: 'model-b', model: 'test-gpt-b', displayName: 'Test GPT B', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }] },
];
const ready = () => ({ available: true, authenticated: true, configured: true, imageGeneration: false, models: structuredClone(models) });
const data = () => ({ analysis: { characters: [{ name: '阿宁' }], coreConflict: '阿宁读信' }, storyboard: { shots: [{ no: '01', duration: 5, prompt: '@阿宁 坐在书桌前读信。' }] }, assets: { characters: [{ name: '阿宁', prompt: '阿宁人物参考图' }] } });

function harness(api = {}) {
  const storage = new Map();
  const intervals = new Map();
  const context = vm.createContext({
    ...durations, ...references, ...generation, ...workflowProgress,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { storyforgeAI: api, setTimeout: () => 1, setInterval: callback => { const id = Symbol(); intervals.set(id, callback); return id; }, clearInterval: id => intervals.delete(id) },
    document: { querySelector: () => null, querySelectorAll: () => [] }, structuredClone,
  });
  vm.runInContext(renderer, context);
  vm.runInContext(`render = () => {}; showToast = message => { globalThis.lastToast = message; }; openModelSettings = () => { globalThis.deepseekSettingsOpened = true; }; openCodexTextSettings = () => { globalThis.textSettingsOpened = true; }; project.script = '阿宁在书桌前读信。'; deepseekStatus.configured = false;`, context);
  return { context, storage, intervals, run: code => vm.runInContext(code, context), snapshot: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)) };
}

function selectSubscription(h, effort = 'low', model = 'test-gpt-a') {
  h.context.selected = { provider: 'codex-subscription', model, reasoningEffort: effort };
  h.context.status = ready();
  h.run('project.storyboardGeneration = selected; codexTextStatus = { ...status, checking: false };');
}

test('旧项目继续默认 DeepSeek，GPT 模型与强度按项目保存和导入，互不共享', () => {
  const h = harness();
  assert.deepEqual(h.snapshot('normalizeProject({}).storyboardGeneration'), { provider: 'deepseek', model: '', reasoningEffort: '' });
  selectSubscription(h, 'xhigh');
  assert.equal(h.run('setStoryboardGeneration(selected)'), true);
  const saved = JSON.parse(h.storage.get('storyforge-project-library-v1'));
  assert.deepEqual(saved.projects[0].storyboardGeneration, { provider: 'codex-subscription', model: 'test-gpt-a', reasoningEffort: 'xhigh' });
  h.run('globalThis.imported = normalizeProject(JSON.parse(JSON.stringify(project))); globalThis.other = createProject(); imported.storyboardGeneration.reasoningEffort = "low"');
  assert.equal(h.run('project.storyboardGeneration.reasoningEffort'), 'xhigh');
  assert.equal(h.run('other.storyboardGeneration.provider'), 'deepseek');
  assert.equal(h.run('normalizeStoryboardGeneration({provider: "unknown"}).provider'), 'deepseek');
});

test('分镜设置保存失败回滚，生成时设置锁定而模块仍可浏览', () => {
  const h = harness();
  selectSubscription(h);
  h.run('globalThis.before = JSON.stringify(project.storyboardGeneration); globalThis.previousDate = project.updatedAt; localStorage.setItem = () => { throw new Error("磁盘已满"); };');
  assert.equal(h.run('setStoryboardGeneration({provider:"deepseek"})'), false);
  assert.equal(h.run('JSON.stringify(project.storyboardGeneration)'), h.run('before'));
  assert.equal(h.run('project.updatedAt'), h.run('previousDate'));
  h.run('project.running = true');
  assert.equal(h.run('setStoryboardGeneration({provider:"deepseek"})'), false);
  assert.match(h.run('storyboardGenerationTemplate()'), /id="storyboardProvider"[^>]*disabled/);
  assert.match(h.run('storyboardGenerationTemplate()'), /id="storyboardModel"[^>]*disabled/);
  assert.match(h.run('storyboardGenerationTemplate()'), /id="storyboardReasoningEffort"[^>]*disabled/);
  assert.doesNotMatch(h.run('steps.map(stepTemplate).join("")'), /disabled/);
});

test('可用模型及思考强度来自账号，切换模型展示其真实支持范围且名称转义', () => {
  const h = harness();
  selectSubscription(h);
  let html = h.run('storyboardGenerationTemplate()');
  assert.match(html, /test-gpt-a/);
  assert.match(html, /test-gpt-b/);
  assert.match(html, /value="xhigh"/);
  assert.doesNotMatch(html, /value="ultra"/);
  h.run('project.storyboardGeneration = {provider:"codex-subscription",model:"test-gpt-b",reasoningEffort:"low"}; codexTextStatus.models[1].displayName = "<img src=x>"');
  html = h.run('storyboardGenerationTemplate()');
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /value="xhigh"|<img src=x>/);
  h.run('project.activeStep = "storyboard"');
  assert.match(h.run('storyboardGenerationTemplate()'), /GPT 思考强度/);
  h.run('project.activeStep = "assets"');
  assert.equal(h.run('storyboardGenerationTemplate()'), '');
});

test('GPT 分析分镜不要求 DeepSeek 密钥或订阅生图能力，锁定 Skill 和思考强度', async () => {
  let sent;
  const h = harness({ getCodexTextStatus: async () => ready(), generateWorkflow: async (_script, options) => { sent = structuredClone(options); return { data: data(), model: options.model, reasoningEffort: options.reasoningEffort }; } });
  selectSubscription(h, 'xhigh');
  h.run('project.generationSkills.storyboard = {name:"镜头.md",content:"每块15秒"};');
  await h.run('startGeneration()');
  assert.equal(sent.provider, 'codex-subscription');
  assert.equal(sent.model, 'test-gpt-a');
  assert.equal(sent.reasoningEffort, 'xhigh');
  assert.equal(sent.stageSkills.storyboard.content, '每块15秒');
  assert.equal(h.run('project.activeStep'), 'assets');
  assert.equal(h.run('project.aiGeneration.provider'), 'codex-subscription');
  assert.equal(h.run('project.aiGeneration.reasoningEffort'), 'xhigh');
  assert.equal(h.run('Boolean(globalThis.deepseekSettingsOpened)'), false);
  assert.match(h.run('project.outputs.analysis.body'), /GPT 订阅 · test-gpt-a/);
  assert.doesNotMatch(h.run('project.outputs.analysis.body'), /DeepSeek/);
  assert.match(h.run('workflowProgressTemplate()'), /GPT 订阅 · test-gpt-a · 已启用 · xhigh/);
});

test('未指定 GPT 模型时使用账号默认模型与默认强度，并保留在项目中', async () => {
  let sent;
  const h = harness({ getCodexTextStatus: async () => ready(), generateWorkflow: async (_script, options) => { sent = options; return { data: data(), model: options.model }; } });
  h.run('project.storyboardGeneration = {provider:"codex-subscription",model:"",reasoningEffort:""};');
  await h.run('startGeneration()');
  assert.equal(sent.model, 'test-gpt-a');
  assert.equal(sent.reasoningEffort, 'medium');
  assert.deepEqual(h.snapshot('project.storyboardGeneration'), { provider: 'codex-subscription', model: 'test-gpt-a', reasoningEffort: 'medium' });
});

test('模型或思考强度下线时明确提示并保留旧成果，不自动换模型或降档', async () => {
  for (const [model, effort, expected] of [['missing-gpt', 'low', /当前不可用/], ['test-gpt-b', 'xhigh', /不支持思考强度 xhigh/]]) {
    let calls = 0;
    const h = harness({ getCodexTextStatus: async () => ready(), generateWorkflow: async () => { calls += 1; throw new Error('不应调用'); } });
    selectSubscription(h, effort, model);
    h.run('project.outputs = {analysis:{body:"旧分析"},storyboard:{body:"旧分镜"}}; project.activeStep = "storyboard";');
    assert.match(h.run('storyboardGenerationTemplate()'), /当前不可用|当前不支持/);
    await h.run('startGeneration()');
    assert.equal(calls, 0);
    assert.match(h.run('project.workflowError'), expected);
    assert.equal(h.run('project.outputs.storyboard.body'), '旧分镜');
    assert.equal(h.run('project.storyboardGeneration.model'), model);
    assert.equal(h.run('project.storyboardGeneration.reasoningEffort'), effort);
    assert.equal(h.run('project.activeStep'), 'storyboard');
    assert.equal(h.run('Boolean(globalThis.textSettingsOpened)'), true);
    assert.equal(h.run('Boolean(globalThis.deepseekSettingsOpened)'), false);
  }
});

test('GPT 等待期间浏览其他步骤不会改写运行快照或抢回页面，停止会取消对应任务', async () => {
  let finish, started;
  const reached = new Promise(resolve => { started = resolve; });
  const cancelled = [];
  let sent;
  const h = harness({ getCodexTextStatus: async () => ready(), cancelWorkflow: async owner => { cancelled.push(structuredClone(owner)); }, generateWorkflow: async (_script, options) => { sent = structuredClone(options); started(); return new Promise(resolve => { finish = resolve; }); } });
  selectSubscription(h, 'high');
  h.run('project.outputs = {assets:{promptItems:[],body:"旧素材"},storyboard:{body:"旧分镜"}};');
  const run = h.run('startGeneration()');
  await reached;
  h.run('selectWorkflowStep("assets")');
  assert.equal(h.run('project.activeStep'), 'assets');
  assert.equal(h.run('project.running'), true);
  assert.equal(h.run('setStoryboardGeneration({provider:"deepseek"})'), false);
  assert.equal(h.run('workflowRun.generation.reasoningEffort'), 'high');
  h.run('stopCurrentGeneration()');
  assert.deepEqual(cancelled, [{ runId: sent.runId, projectId: sent.projectId }]);
  finish({ data: data(), model: 'test-gpt-a' });
  await run;
  assert.equal(h.run('project.activeStep'), 'assets');
  assert.equal(h.run('project.outputs.storyboard.body'), '旧分镜');
  assert.equal(h.run('project.workflowProgress.status'), 'stopped');
  assert.equal(h.intervals.size, 0);
});

test('GPT 订阅限额错误保留旧成果并说明真实渠道，不打开 DeepSeek 设置', async () => {
  const h = harness({ getCodexTextStatus: async () => ready(), generateWorkflow: async () => { throw new Error("Error invoking remote method 'deepseek:generate-workflow': Error: GPT 订阅限额已用完，请稍后重试。"); } });
  selectSubscription(h);
  h.run('project.outputs = {storyboard:{body:"旧分镜"}};');
  await h.run('startGeneration()');
  assert.equal(h.run('project.workflowError'), 'GPT 订阅限额已用完，请稍后重试。');
  assert.equal(h.run('project.outputs.storyboard.body'), '旧分镜');
  assert.equal(h.run('Boolean(globalThis.deepseekSettingsOpened)'), false);
  assert.match(h.run('workflowProgressTemplate()'), /GPT 订阅 · test-gpt-a · 已启用 · low/);
});

test('GPT 全流程保留本次模型强度和两份 Skill 快照，自动生成全部参考图与批量视频', async () => {
  const calls = { workflows: [], images: [], creates: [], polls: [], downloads: [] };
  const output = data();
  const names = ['阿宁', '阿岚'];
  output.analysis.characters = names.map(name => ({ name }));
  output.storyboard.shots = names.map((name, index) => ({ no: String(index + 1).padStart(2, '0'), duration: 6, prompt: `@${name} 坐在书桌前读信。` }));
  output.assets.characters = names.map(name => ({ name, prompt: `${name} 人物参考图` }));
  const skills = { storyboard: { name: '本次分镜.md', content: '每块6秒，按原文顺序设计。' }, assets: { name: '本次资产.md', content: '启动时锁定的电影素材要求。' } };
  const h = harness({
    getCodexTextStatus: async () => ready(),
    getCodexImageStatus: async () => ({ available: true, authenticated: true, imageGeneration: true }),
    generateWorkflow: async (script, options) => {
      calls.workflows.push({ script, options: structuredClone(options) });
      // External state changes must not alter any already-started stage's settings.
      h.run('project.generationSkills.storyboard.content = "迟到的分镜要求"; project.generationSkills.assets.content = "迟到的资产要求"; project.storyboardGeneration.reasoningEffort = "low";');
      return { data: structuredClone(output), model: options.model, reasoningEffort: options.reasoningEffort };
    },
    generateCodexImage: async options => { calls.images.push(structuredClone(options)); return { files: [{ localPath: `C:/subscription-${options.assetName}.png` }] }; },
    createSeedanceTask: async options => { calls.creates.push(structuredClone(options)); return { id: `subscription-task-${calls.creates.length}`, status: 'running' }; },
    getSeedanceTask: async id => { calls.polls.push(id); return { status: 'succeeded', videoUrl: `https://offline.invalid/${id}.mp4` }; },
    downloadSeedanceVideo: async options => { calls.downloads.push(structuredClone(options)); return { localPath: `C:/subscription-video-${options.index}.mp4` }; },
  });
  selectSubscription(h, 'xhigh');
  h.context.skills = structuredClone(skills);
  h.run('project.generationSkills = normalizeGenerationSkills(skills); project.autoRunToVideo = true; seedanceStatus.configured = true; seedanceStatus.generationMode = "confirm";');
  await h.run('startGeneration()');
  assert.equal(calls.workflows.length, 1);
  const options = calls.workflows[0].options;
  assert.equal(options.provider, 'codex-subscription');
  assert.equal(options.model, 'test-gpt-a');
  assert.equal(options.reasoningEffort, 'xhigh');
  assert.equal(options.autoRunToVideo, true);
  assert.deepEqual(options.stageSkills, skills);
  assert.equal(calls.images.length, 2);
  assert.deepEqual(calls.images.map(item => item.assetName), names);
  for (const image of calls.images) assert.deepEqual(image.assetSkill, skills.assets);
  assert.equal(calls.creates.length, 2);
  assert.equal(calls.polls.length, 2);
  assert.equal(calls.downloads.length, 2);
  assert.deepEqual(calls.creates.map(item => item.imagePaths), [['C:/subscription-阿宁.png'], ['C:/subscription-阿岚.png']]);
  assert.equal(h.run('project.aiGeneration.reasoningEffort'), 'xhigh');
  assert.equal(h.run('seedanceStatus.generationMode'), 'confirm');
  assert.equal(h.run('project.videoGeneration.generationMode'), 'batch');
  assert.equal(h.run('project.autoPipeline.status'), 'completed');
  assert.equal(h.run('project.activeStep'), 'video');
  assert.equal(h.run('project.running'), false);
  assert.deepEqual(h.snapshot('project.completed'), ['analysis', 'storyboard', 'assets', 'video']);
  assert.deepEqual(h.snapshot('project.videoGeneration.items.map(item => item.localPath)'), ['C:/subscription-video-0.mp4', 'C:/subscription-video-1.mp4']);
  assert.equal(h.run('Boolean(globalThis.deepseekSettingsOpened)'), false);
});

test('停止或切换项目会丢弃 GPT 登录检测的迟到结果，不改写新项目或发送生成请求', async () => {
  for (const operation of ['stop', 'switch']) {
    let finish, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const calls = { workflows: 0, cancellations: [] };
    const h = harness({
      getCodexTextStatus: () => { entered(); return new Promise(resolve => { finish = resolve; }); },
      cancelWorkflow: async owner => { calls.cancellations.push(structuredClone(owner)); },
      generateWorkflow: async () => { calls.workflows += 1; return { data: data() }; },
    });
    h.run('project.storyboardGeneration = {provider:"codex-subscription",model:"",reasoningEffort:""}; projectLibrary.projects.push(createProject({id:"other-gpt-preflight",script:"另一篇小说"})); globalThis.owner = project;');
    const run = h.run('startGeneration()');
    await reached;
    const ids = h.snapshot('({runId:workflowRun.runId,projectId:workflowRun.projectId})');
    h.run(operation === 'switch' ? 'switchProject("other-gpt-preflight")' : 'stopCurrentGeneration()');
    const before = h.snapshot('({id:project.id,settings:project.storyboardGeneration,outputs:project.outputs,completed:project.completed})');
    finish(ready());
    await run;
    assert.deepEqual(calls.cancellations, [ids]);
    assert.equal(calls.workflows, 0);
    assert.deepEqual(h.snapshot('({id:project.id,settings:project.storyboardGeneration,outputs:project.outputs,completed:project.completed})'), before);
    assert.equal(h.run('owner.workflowProgress.status'), 'stopped');
    assert.equal(h.run('owner.storyboardGeneration.model'), '');
    assert.equal(h.run('owner.storyboardGeneration.reasoningEffort'), '');
    assert.equal(h.run('project.running'), false);
  }
});

test('等待 GPT 检测时仍可切换生成方式，只有模型与强度显示等待原因', () => {
  const h = harness();
  selectSubscription(h);
  h.run('codexTextStatus.checking = true');
  const html = h.run('storyboardGenerationTemplate()');
  assert.doesNotMatch(html, /id="storyboardProvider"[^>]*disabled/);
  assert.doesNotMatch(html, /data-storyboard-control="storyboardProvider"/);
  assert.match(html, /id="storyboardModel"[^>]*disabled/);
  assert.match(html, /data-storyboard-control="storyboardModel"[^>]*data-blocked-reason="正在检测 GPT 订阅/);
  assert.match(html, /id="storyboardReasoningEffort"[^>]*disabled/);
  assert.equal(h.run('setStoryboardGeneration({provider:"deepseek"})'), true);
  assert.equal(h.run('project.storyboardGeneration.provider'), 'deepseek');
});

test('禁用选择框有可聚焦提示按钮，点击后显示原因且不修改项目设置', () => {
  const h = harness();
  selectSubscription(h);
  h.run('project.running = true');
  const html = h.run('storyboardGenerationTemplate()');
  assert.equal((html.match(/class="storyboard-control-feedback"/g) || []).length, 3);
  assert.match(html, /<button type="button" class="storyboard-control-feedback"[^>]*aria-label="生成方式暂不可修改：/);
  assert.doesNotMatch(html, /<button[^>]*class="storyboard-control-feedback"[^>]*\sdisabled/);
  const reason = '当前任务正在生成，请完成或停止后切换。';
  const overlay = { dataset: { blockedReason: reason } };
  h.context.document.querySelectorAll = selector => selector === '[data-storyboard-control]' ? [overlay] : [];
  h.run('bindStoryboardGenerationEvents()');
  let prevented = false, stopped = false;
  overlay.onclick({ preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(h.run('lastToast'), reason);
  assert.equal(prevented && stopped, true);
  assert.equal(h.run('project.storyboardGeneration.provider'), 'codex-subscription');
  assert.equal(h.run('project.storyboardGeneration.reasoningEffort'), 'low');
});

test('未登录或模型未就绪时点击模型与强度可得具体提示', () => {
  const h = harness();
  selectSubscription(h);
  h.run('codexTextStatus = {available:true,authenticated:false,checking:false,models:[]}');
  const html = h.run('storyboardGenerationTemplate()');
  assert.match(html, /data-storyboard-control="storyboardModel"[^>]*data-blocked-reason="尚未连接 GPT 订阅/);
  assert.match(html, /data-storyboard-control="storyboardReasoningEffort"[^>]*data-blocked-reason="尚未连接 GPT 订阅/);
  assert.doesNotMatch(html, /id="storyboardProvider"[^>]*disabled/);
});

test('生成中的 change 防御分支提示原因，重复绑定不重复注册事件', () => {
  const h = harness();
  selectSubscription(h);
  h.run('project.running = true');
  const provider = {}, model = {}, effort = {};
  const controls = { '#storyboardProvider': provider, '#storyboardModel': model, '#storyboardReasoningEffort': effort };
  h.context.document.querySelector = selector => controls[selector] || null;
  h.run('bindStoryboardGenerationEvents(); bindStoryboardGenerationEvents()');
  provider.onchange({ target: { value: 'deepseek' } });
  assert.match(h.run('lastToast'), /完成或停止后可调整/);
  assert.equal(h.run('project.storyboardGeneration.provider'), 'codex-subscription');
  model.onchange({ target: { value: 'test-gpt-b' } });
  assert.match(h.run('lastToast'), /停止当前任务/);
  effort.onchange({ target: { value: 'xhigh' } });
  assert.match(h.run('lastToast'), /修改思考强度/);
  assert.equal(h.run('project.storyboardGeneration.reasoningEffort'), 'low');
});
