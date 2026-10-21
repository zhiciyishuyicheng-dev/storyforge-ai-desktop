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

function harness(api = {}) {
  const storage = new Map();
  const apiCalls = [];
  const context = vm.createContext({
    ...durations, ...references, ...generation, ...workflowProgress,
    structuredClone,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: {
      storyforgeAI: {
        cancelWorkflow: (...args) => { apiCalls.push(['cancelWorkflow', ...args]); },
        cancelCodexImage: (...args) => { apiCalls.push(['cancelCodexImage', ...args]); },
        showSeedanceVideo: (...args) => { apiCalls.push(['showSeedanceVideo', ...args]); },
        ...api,
      },
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    },
    document: { querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(renderer, context);
  vm.runInContext('render = () => {}; renderWithoutMovingPage = () => {}; showToast = message => { globalThis.lastToast = message; };', context);
  return { context, storage, apiCalls, run: code => vm.runInContext(code, context), snapshot: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)) };
}

function loadResults(h, stepId = 'storyboard') {
  h.context.initialStep = stepId;
  h.run(`
    project.script = '阿宁在书房里读信。';
    project.title = '保留全部其他步骤';
    project.activeStep = initialStep;
    project.completed = ['analysis', 'storyboard', 'assets', 'video'];
    project.outputs = {
      analysis: { title: '原故事分析', subtitle: '人物', body: '<p>原分析</p>' },
      storyboard: { title: '原分镜', subtitle: '镜头', body: '<p>原分镜</p>', prompts: ['@阿宁 在书房读信，5秒。'], shots: [{ no: '01', duration: 5, uploads: [{ ref: '@阿宁', asset: '阿宁', purpose: '外观' }] }], durations: [5] },
      assets: { title: '原素材', subtitle: '人物', body: '', promptItems: [{ name: '阿宁', type: '人物参考图', fileName: '阿宁.png', prompt: '阿宁参考图' }] },
      video: { title: '原视频', subtitle: '已保存镜头', body: '' },
    };
    project.assetGeneration = { ...defaultProject.assetGeneration, status: 'complete', generatedCount: 1, totalCount: 1, outputDirectory: 'C:/saved/images', items: [{ name: '阿宁', type: '人物参考图', fileName: '阿宁.png', status: 'success', files: [{ localPath: 'C:/saved/images/阿宁.png', imageUrl: 'file:///C:/saved/images/阿宁.png', sourceName: '阿宁.png' }], localPath: 'C:/saved/images/阿宁.png' }] };
    project.videoGeneration = { ...defaultProject.videoGeneration, status: 'complete', generatedCount: 1, totalCount: 1, outputDirectory: 'C:/saved/videos', items: [{ status: 'success', duration: 5, localPath: 'C:/saved/videos/镜头-01.mp4', videoFileUrl: 'file:///C:/saved/videos/镜头-01.mp4', fileName: '镜头-01.mp4' }] };
    project.generationSkills = { storyboard: { name: '导演.md', content: '保留对白' }, assets: { name: '美术.md', content: '水彩' } };
    project.storyboardGeneration = { provider: 'codex-subscription', model: 'saved-gpt', reasoningEffort: 'high' };
    project.workflowError = '上次请求的历史提示';
    saveProject();
  `);
}

test('清空前弹出当前步骤的二次确认，取消不改变任何项目结果', () => {
  const h = harness(); loadResults(h);
  const before = h.snapshot('project');
  h.run('requestClearCurrentResult()');
  assert.equal(h.run('clearResultRequest.ownerProject === project'), true);
  assert.equal(h.run('clearResultRequest.stepId'), 'storyboard');
  const html = h.run('clearResultDialogTemplate()');
  assert.match(html, /分镜脚本/);
  assert.match(html, /取消/);
  assert.match(html, /确认|确定/);
  h.run('closeClearResultDialog()');
  assert.equal(h.run('clearResultRequest'), null);
  assert.deepEqual(h.snapshot('project'), before);
  assert.deepEqual(h.apiCalls, []);
});

for (const stepId of ['analysis', 'storyboard', 'assets', 'video']) {
  test(`只清空 ${stepId}，保留其他步骤、原文、Skill、设置和本地文件`, () => {
    const h = harness(); loadResults(h, stepId);
    const before = h.snapshot('project');
    h.run('requestClearCurrentResult(); confirmClearCurrentResult()');
    const after = h.snapshot('project');
    assert.equal(after.activeStep, stepId);
    if (stepId === 'assets') assert.deepEqual(after.outputs.assets, before.outputs.assets);
    else assert.equal(Object.hasOwn(after.outputs, stepId), false);
    for (const other of ['analysis', 'storyboard', 'assets', 'video'].filter(id => id !== stepId)) {
      assert.deepEqual(after.outputs[other], before.outputs[other]);
      assert.equal(after.completed.includes(other), true);
    }
    assert.equal(after.completed.includes(stepId), false);
    assert.equal(after.script, before.script);
    assert.deepEqual(after.generationSkills, before.generationSkills);
    assert.deepEqual(after.storyboardGeneration, before.storyboardGeneration);
    assert.equal(after.running, false);
    if (stepId === 'assets') {
      assert.equal(after.assetGeneration.items.length, before.outputs.assets.promptItems.length);
      assert.deepEqual(after.assetGeneration.items[0].files, []);
      assert.equal(after.assetGeneration.items[0].status, 'pending');
      assert.equal(after.assetGeneration.generatedCount, 0);
    }
    else assert.deepEqual(after.assetGeneration, before.assetGeneration);
    if (stepId === 'video') assert.deepEqual(after.videoGeneration.items, []);
    else assert.deepEqual(after.videoGeneration, before.videoGeneration);
    assert.equal(h.run('clearResultRequest'), null);
    const saved = JSON.parse(h.storage.get('storyforge-project-library-v1')).projects[0];
    assert.deepEqual(saved.outputs, after.outputs);
    assert.deepEqual(h.apiCalls, []);
  });
}

test('生成时点击清空只提示先停止，不停止后台任务或更改已完成结果', () => {
  const h = harness(); loadResults(h);
  h.run('project.running = true; workflowRun = { ownerProject: project, runId: "still-running", projectId: project.id, generation: {provider:"codex-subscription"} };');
  const before = h.snapshot('project'), token = h.run('generationRun');
  h.run('requestClearCurrentResult()');
  assert.equal(h.run('clearResultRequest'), null);
  assert.match(h.run('lastToast'), /停止|生成/);
  assert.deepEqual(h.snapshot('project'), before);
  assert.equal(h.run('generationRun'), token);
  assert.equal(h.run('workflowRun.runId'), 'still-running');
  assert.deepEqual(h.apiCalls, []);
});

test('没有当前步骤结果时提示，不弹清空确认也不影响其他步骤', () => {
  const h = harness(); loadResults(h, 'analysis');
  h.run('delete project.outputs.analysis; project.completed = project.completed.filter(id => id !== "analysis");');
  const before = h.snapshot('project');
  h.run('requestClearCurrentResult()');
  assert.equal(h.run('clearResultRequest'), null);
  assert.match(h.run('lastToast'), /没有|暂无|无需/);
  assert.deepEqual(h.snapshot('project'), before);
});

for (const [label, mutate] of [
  ['切换步骤', 'project.activeStep = "video"'],
  ['切换项目', 'project = createProject({title:"另一个项目",outputs:{analysis:{title:"新分析",body:"保持"}}})'],
  ['开启新一轮生成', 'generationRun += 1'],
  ['结果已经替换', 'project.outputs.storyboard = {...project.outputs.storyboard,body:"更新分镜"}'],
  ['任务已在进行', 'project.running = true'],
]) {
  test(`清空确认期间${label}，旧确认失效且保留当前成果`, () => {
    const h = harness(); loadResults(h);
    h.run('requestClearCurrentResult()');
    h.run(mutate);
    const before = h.snapshot('project');
    assert.equal(h.run('confirmClearCurrentResult()'), false);
    assert.deepEqual(h.snapshot('project'), before);
    assert.deepEqual(h.apiCalls, []);
  });
}

test('清空确认期间素材状态已被替换，旧确认不会清掉新上传图片', () => {
  const h = harness(); loadResults(h, 'assets');
  h.run('requestClearCurrentResult(); project.assetGeneration = {...project.assetGeneration, outputDirectory:"C:/new-images"};');
  const before = h.snapshot('project');
  assert.equal(h.run('confirmClearCurrentResult()'), false);
  assert.deepEqual(h.snapshot('project'), before);
});

test('确认窗口打开后上传图片写回同一素材对象，旧确认不能删除新增关联', () => {
  const h = harness(); loadResults(h, 'assets');
  h.run('requestClearCurrentResult(); project.assetGeneration.items[0].files.push({localPath:"C:/saved/images/阿宁-v2.png",sourceName:"阿宁-v2.png"});');
  const before = h.snapshot('project');
  assert.equal(h.run('confirmClearCurrentResult()'), false);
  assert.deepEqual(h.snapshot('project'), before);
});

test('清空成功后尚未返回的本地上传不会把图片关联重新写回', async () => {
  let release;
  const h = harness({ selectLocalAssetImages: () => new Promise(resolve => { release = resolve; }) });
  loadResults(h, 'assets');
  const upload = h.run('selectLocalAssetImages(0)');
  assert.equal(typeof release, 'function');
  h.run('requestClearCurrentResult(); confirmClearCurrentResult()');
  const cleared = h.snapshot('project');
  release({ files: [{ localPath: 'C:/late-upload.png', imageUrl: 'file:///C:/late-upload.png', sourceName: 'late-upload.png' }] });
  await upload;
  assert.deepEqual(h.snapshot('project'), cleared);
  assert.equal(h.run('project.completed.includes("assets")'), false);
  assert.deepEqual(h.snapshot('project.assetGeneration.items[0].files'), []);
});

for (const stepId of ['analysis', 'storyboard', 'assets', 'video']) {
  test(`${stepId} 清空保存失败时回滚，不出现界面已清空但未保存的状态`, () => {
    const h = harness(); loadResults(h, stepId);
    const before = h.snapshot('project');
    h.run('requestClearCurrentResult(); localStorage.setItem = () => { throw new Error("本地存储已满"); };');
    assert.equal(h.run('confirmClearCurrentResult()'), false);
    assert.deepEqual(h.snapshot('project'), before);
    assert.match(h.run('lastToast'), /失败|无法|未清空|保留/);
    assert.deepEqual(h.apiCalls, []);
  });
}

test('清空分镜后刷新项目，第四步仍可播放既有本地视频', () => {
  const h = harness(); loadResults(h);
  h.run('requestClearCurrentResult(); confirmClearCurrentResult(); project = normalizeProject(JSON.parse(JSON.stringify(project))); project.activeStep = "video";');
  const html = h.run('outputContentTemplate()');
  assert.match(html, /<video\b/);
  assert.match(html, /file:\/\/\/C:\/saved\/videos\/镜头-01\.mp4/);
  assert.equal(h.run('project.videoGeneration.items[0].status'), 'success');
  assert.equal(h.run('project.outputs.storyboard'), undefined);
  assert.equal(h.run('project.outputs.analysis.title'), '原故事分析');
  assert.equal(h.run('project.assetGeneration.items[0].files[0].localPath'), 'C:/saved/images/阿宁.png');
});

test('清空素材后刷新不会被旧文件关联自动恢复完成状态', () => {
  const h = harness(); loadResults(h, 'assets');
  h.run('requestClearCurrentResult(); confirmClearCurrentResult(); project = normalizeProject(JSON.parse(JSON.stringify(project)));');
  assert.equal(h.run('project.completed.includes("assets")'), false);
  assert.equal(h.run('project.outputs.assets.promptItems[0].name'), '阿宁');
  assert.deepEqual(h.snapshot('project.assetGeneration.items[0].files'), []);
  assert.equal(h.run('project.assetGeneration.items[0].status'), 'pending');
  assert.equal(h.run('project.videoGeneration.items[0].localPath'), 'C:/saved/videos/镜头-01.mp4');
});

test('分镜已清空的历史视频保留原镜头序号，查看文件不会指向其他镜头', async () => {
  const h = harness(); loadResults(h);
  h.run(`project.videoGeneration.items.unshift({status:'failed',fileName:'失败镜头.mp4',error:'旧失败记录'}); project.videoGeneration.items[1].fileName='镜头-02.mp4'; project.videoGeneration.items[1].localPath='C:/saved/videos/镜头-02.mp4'; project.videoGeneration.items[1].videoFileUrl='file:///C:/saved/videos/镜头-02.mp4'; requestClearCurrentResult(); confirmClearCurrentResult(); project.activeStep='video';`);
  const html = h.run('videoGenerationTemplate()');
  assert.match(html, /<video\b/);
  assert.match(html, /data-show-video-index="1"/);
  await h.run('showGeneratedVideo(1)');
  assert.deepEqual(h.apiCalls, [['showSeedanceVideo', 'C:/saved/videos/镜头-02.mp4']]);
});

test('清空分镜后查看视频历史及刷新，不会改写其他步骤待认证的任务记录', () => {
  const h = harness(); loadResults(h);
  h.run(`
    project.videoGeneration.items.push({...project.videoGeneration.items[0],fileName:'镜头-02.mp4',localPath:'C:/saved/videos/镜头-02.mp4',videoFileUrl:'file:///C:/saved/videos/镜头-02.mp4'});
    Object.assign(project.videoGeneration.items[0], {status:'certification',taskId:'rejected-portrait-task',localPath:'',videoFileUrl:'',error:'待真人素材认证'});
    project.videoGeneration.status='awaiting-certification';
    project.videoGeneration.pendingCertification={shotIndex:0,blockedInputs:[{assetItemIndex:0,fileIndex:0,assetName:'阿宁',localPath:'C:/saved/images/阿宁.png',sourceName:'阿宁.png'}],resumeIndexes:[0,1],mode:'batch'};
  `);
  const before = h.snapshot('project.videoGeneration');
  h.run('requestClearCurrentResult(); confirmClearCurrentResult(); project.activeStep="video";');
  assert.match(h.run('appTemplate()'), /保留的视频结果/);
  assert.deepEqual(h.snapshot('project.videoGeneration'), before);
  // Refresh adds the new immutable version association to legacy saved files;
  // task and certification records themselves must remain unchanged.
  h.context.legacyVideoState = before;
  const migratedBefore = h.snapshot('({...legacyVideoState,items:legacyVideoState.items.map(normalizeVideoItemVersions)})');
  h.run('project = normalizeProject(JSON.parse(JSON.stringify(project)));');
  assert.match(h.run('appTemplate()'), /rejected-portrait-task|待真人素材认证|阿宁/);
  assert.deepEqual(h.snapshot('project.videoGeneration'), migratedBefore);
  assert.equal(h.run('project.videoGeneration.items[1].versions.length'), 1);
  assert.equal(h.run('project.videoGeneration.items[0].status'), 'certification');
  assert.equal(h.run('project.videoGeneration.pendingCertification.blockedInputs[0].localPath'), 'C:/saved/images/阿宁.png');
});
