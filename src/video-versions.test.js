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
  const calls = { create: [], poll: [], download: [] };
  let requestNumber = 0;
  const context = vm.createContext({
    ...durations, ...references, ...generation, ...workflowProgress,
    structuredClone,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: {
      storyforgeAI: {
        createSeedanceTask: async (options) => { calls.create.push(options); return { id: `task-${++requestNumber}`, status: 'running' }; },
        getSeedanceTask: async (id) => { calls.poll.push(id); return { status: 'succeeded', videoUrl: `https://offline.invalid/${id}.mp4`, usage: { completion_tokens: 17 } }; },
        downloadSeedanceVideo: async (options) => {
          calls.download.push(options);
          const fileName = `镜头-${String(options.index + 1).padStart(2, '0')}-${options.taskId}.mp4`;
          return { localPath: `C:/saved/${fileName}`, videoFileUrl: `file:///C:/saved/${fileName}`, fileName, outputDirectory: 'C:/saved' };
        },
        ...api,
      },
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    },
    document: { querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(renderer, context);
  vm.runInContext(`
    render = () => {}; renderWithoutMovingPage = () => {};
    showToast = message => { globalThis.lastToast = message; };
    wait = async () => {};
    seedanceStatus = { ...seedanceStatus, configured: true, model: 'seedance-before', ratio: '16:9', resolution: '720p', duration: 6, generateAudio: true, generationMode: 'batch' };
    project.title = '视频版本测试'; project.activeStep = 'video';
    project.completed = ['analysis', 'storyboard', 'assets'];
    project.outputs = {
      storyboard: { prompts: ['本段总时长：6秒\\n@阿宁 在书房里看信。'], shots: [{ no: '01', duration: 6, uploads: [{ ref: '@阿宁', asset: '阿宁', purpose: '人物参考' }] }] },
      video: { title: '分镜视频', body: '' },
    };
    project.assetGeneration.items = [{ name: '阿宁', type: '人物参考图', files: [{ localPath: 'C:/saved/阿宁.png', imageUrl: 'file:///C:/saved/阿宁.png' }] }];
    initializeVideoGeneration(project.outputs.storyboard.prompts);
  `, context);
  return { context, calls, storage, run: (code) => vm.runInContext(code, context), snapshot: (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)) };
}

function holdNextStage(h, stage) {
  let entered, resolve;
  const reached = new Promise((done) => { entered = done; });
  const pending = new Promise((done) => { resolve = done; });
  const method = stage === 'create' ? 'createSeedanceTask' : stage === 'poll' ? 'getSeedanceTask' : 'downloadSeedanceVideo';
  h.context.window.storyforgeAI[method] = () => { entered(); return pending; };
  return { reached, resolve };
}

function completedStageResponse(stage) {
  return stage === 'create' ? { id: 'late-task', status: 'running' }
    : stage === 'poll' ? { status: 'succeeded', videoUrl: 'https://offline.invalid/late.mp4' }
      : { localPath: 'C:/saved/late.mp4', videoFileUrl: 'file:///C:/saved/late.mp4', fileName: 'late.mp4' };
}

async function waitForStage(reached, running) {
  let timer;
  try {
    await Promise.race([
      reached,
      running.then(() => { throw new Error('模拟生成在进入预期阶段前已结束'); }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('未进入预期模拟阶段')), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('同一分镜两次成功保存两个独立版本，新增后自动选中，并持久化真实生成参数', async () => {
  const h = harness();
  await h.run('generateSeedanceVideos({token:generationRun,indexes:[0],force:true,mode:"batch"})');
  const first = h.snapshot('project.videoGeneration.items[0].versions[0]');
  assert.equal(first.number, 1);
  assert.equal(first.model, 'seedance-before');
  assert.equal(first.ratio, '16:9');
  assert.equal(first.resolution, '720p');
  assert.equal(first.generateAudio, true);
  assert.equal(first.duration, 6);
  assert.equal(first.taskId, 'task-1');
  assert.equal(first.remoteVideoUrl, 'https://offline.invalid/task-1.mp4');
  assert.match(first.generatedAt, /^\d{4}-/);
  assert.equal(first.prompt, h.calls.create[0].prompt);
  assert.deepEqual(first.usage, { completion_tokens: 17 });

  h.run('seedanceStatus.model = "seedance-second"; seedanceStatus.ratio = "9:16"; seedanceStatus.generateAudio = false;');
  await h.run('generateSeedanceVideos({token:++generationRun,indexes:[0],force:true,mode:"batch"})');
  const item = h.snapshot('project.videoGeneration.items[0]');
  assert.equal(item.versions.length, 2);
  assert.deepEqual(item.versions[0], first);
  assert.equal(item.versions[1].number, 2);
  assert.equal(item.versions[1].model, 'seedance-second');
  assert.equal(item.versions[1].ratio, '9:16');
  assert.equal(item.versions[1].generateAudio, false);
  assert.notEqual(item.versions[0].localPath, item.versions[1].localPath);
  assert.equal(item.selectedVersionId, item.versions[1].id);
  assert.equal(item.fileName, item.versions[1].fileName);
  assert.equal(item.localPath, item.versions[1].localPath);
  assert.equal(h.run('project.videoGeneration.generatedCount'), 1);
  assert.equal(h.run('project.completed.includes("video")'), true);
  const saved = JSON.parse(h.storage.get('storyforge-project-library-v1')).projects[0];
  assert.deepEqual(saved.videoGeneration.items[0].versions, item.versions);
  h.context.savedProject = saved;
  assert.deepEqual(h.snapshot('normalizeProject(savedProject).videoGeneration.items[0].versions'), item.versions);
});

test('生成参数在提交时锁定，等待期间切换设置不改写历史版本参数', async () => {
  const h = harness();
  const held = holdNextStage(h, 'create');
  const running = h.run('generateSeedanceVideos({token:generationRun,indexes:[0],force:true})');
  await waitForStage(held.reached, running);
  h.run('seedanceStatus.model="after-change"; project.videoGeneration.model="after-change"; project.videoGeneration.ratio="9:16"; project.videoGeneration.generateAudio=false;');
  held.resolve({ id: 'snapshot-task', status: 'running' });
  await running;
  const version = h.snapshot('project.videoGeneration.items[0].versions[0]');
  assert.equal(version.model, 'seedance-before');
  assert.equal(version.ratio, '16:9');
  assert.equal(version.generateAudio, true);
});

for (const stage of ['create', 'poll', 'download']) {
  test(`${stage} 阶段重新生成失败保留旧视频和选中版本，重试成功才增加版本`, async () => {
    const h = harness();
    await h.run('generateSeedanceVideos({token:generationRun,indexes:[0],force:true})');
    const before = h.snapshot('project.videoGeneration.items[0]');
    const method = stage === 'create' ? 'createSeedanceTask' : stage === 'poll' ? 'getSeedanceTask' : 'downloadSeedanceVideo';
    const success = h.context.window.storyforgeAI[method];
    h.context.window.storyforgeAI[method] = async () => { throw new Error('模拟任务失败：请手动重试'); };
    await h.run('generateSeedanceVideos({token:++generationRun,indexes:[0],force:true})');
    const failed = h.snapshot('project.videoGeneration.items[0]');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /模拟任务失败/);
    assert.deepEqual(failed.versions, before.versions);
    assert.equal(failed.selectedVersionId, before.selectedVersionId);
    assert.equal(failed.localPath, before.localPath);
    assert.equal(h.run('getSelectedVideoVersion(project.videoGeneration.items[0]).localPath'), before.localPath);
    assert.equal(h.run('project.videoGeneration.generatedCount'), 1);
    assert.equal(h.run('project.videoGeneration.status'), 'partial');
    assert.equal(h.run('project.completed.includes("video")'), true);
    h.context.window.storyforgeAI[method] = success;
    await h.run('generateSeedanceVideos({token:++generationRun,indexes:[0],force:true})');
    assert.equal(h.run('project.videoGeneration.items[0].versions.length'), 2);
    assert.equal(h.run('project.videoGeneration.items[0].versions[1].number'), 2);
    assert.equal(h.run('project.videoGeneration.status'), 'complete');
  });

  test(`${stage} 阶段停止后保留旧版，迟到响应不会追加版本或恢复转圈`, async () => {
    const h = harness();
    await h.run('generateSeedanceVideos({token:generationRun,indexes:[0],force:true})');
    const before = h.snapshot('project.videoGeneration.items[0]');
    const held = holdNextStage(h, stage);
    const running = h.run('generateSeedanceVideos({token:++generationRun,indexes:[0],force:true})');
    await waitForStage(held.reached, running);
    assert.equal(h.run('getSelectedVideoVersion(project.videoGeneration.items[0]).localPath'), before.localPath);
    h.run('stopCurrentGeneration()');
    const stopped = h.snapshot('project.videoGeneration');
    assert.equal(stopped.status, 'complete');
    assert.equal(stopped.items[0].status, 'success');
    assert.equal(stopped.generatedCount, 1);
    assert.equal(stopped.items[0].selectedVersionId, before.selectedVersionId);
    assert.deepEqual(stopped.items[0].versions, before.versions);
    held.resolve(completedStageResponse(stage));
    await running;
    assert.deepEqual(h.snapshot('project.videoGeneration'), stopped);
    assert.equal(h.run('project.running'), false);
  });

  test(`${stage} 阶段切换项目后迟到响应不污染新项目或旧版本历史`, async () => {
    const h = harness();
    await h.run('generateSeedanceVideos({token:generationRun,indexes:[0],force:true})');
    const before = h.snapshot('project.videoGeneration.items[0].versions');
    const held = holdNextStage(h, stage);
    const running = h.run('generateSeedanceVideos({token:++generationRun,indexes:[0],force:true})');
    await waitForStage(held.reached, running);
    h.run('globalThis.previousProject = project; stopCurrentGeneration(); project = createProject({title:"另一个项目"});');
    const next = h.snapshot('project');
    held.resolve(completedStageResponse(stage));
    await running;
    assert.deepEqual(h.snapshot('project'), next);
    assert.deepEqual(h.snapshot('previousProject.videoGeneration.items[0].versions'), before);
    assert.equal(h.run('previousProject.running'), false);
  });
}

test('首次生成失败不计版本，停止无旧版任务恢复未生成状态', async () => {
  const h = harness({ createSeedanceTask: async () => { throw new Error('模拟任务失败'); } });
  await h.run('generateSeedanceVideos({token:generationRun,indexes:[0]})');
  assert.equal(h.run('project.videoGeneration.items[0].versions.length'), 0);
  assert.equal(h.run('project.videoGeneration.generatedCount'), 0);
  assert.equal(h.run('project.completed.includes("video")'), false);
  const held = holdNextStage(h, 'create');
  const running = h.run('generateSeedanceVideos({token:++generationRun,indexes:[0]})');
  await waitForStage(held.reached, running);
  h.run('stopCurrentGeneration()');
  assert.equal(h.run('project.videoGeneration.items[0].status'), 'pending');
  assert.equal(h.run('project.videoGeneration.status'), 'pending');
  held.resolve(completedStageResponse('create'));
  await running;
  assert.equal(h.run('project.videoGeneration.items[0].versions.length'), 0);
});

test('下载结果缺少本地文件时不计成功版本，不覆盖旧视频', async () => {
  const h = harness();
  await h.run('generateSeedanceVideos({token:generationRun,indexes:[0]})');
  const before = h.snapshot('project.videoGeneration.items[0].versions');
  h.context.window.storyforgeAI.downloadSeedanceVideo = async () => ({ videoFileUrl: 'https://offline.invalid/not-saved.mp4' });
  await h.run('generateSeedanceVideos({token:++generationRun,indexes:[0],force:true})');
  assert.deepEqual(h.snapshot('project.videoGeneration.items[0].versions'), before);
  assert.equal(h.run('project.videoGeneration.items[0].status'), 'failed');
  assert.match(h.run('project.videoGeneration.items[0].error'), /未保存到本机/);
});

for (const savedRunning of [false, true]) {
  for (const interruptedStatus of ['creating', 'queued', 'running', 'downloading']) {
    test(`重启恢复 ${interruptedStatus}（保存的running=${savedRunning}）清除转圈，保留已选历史且不自动请求`, () => {
      const h = harness();
      h.context.interruptedStatus = interruptedStatus;
      h.context.savedRunning = savedRunning;
      h.run(`
        globalThis.saved = structuredClone(project);
        saved.running = savedRunning;
        let item = appendVideoVersion(saved.videoGeneration.items[0], {localPath:'C:/saved/version-one.mp4',videoFileUrl:'file:///C:/saved/version-one.mp4'}, {taskId:'saved-task-one'});
        item = appendVideoVersion(item, {localPath:'C:/saved/version-two.mp4',videoFileUrl:'file:///C:/saved/version-two.mp4'}, {taskId:'saved-task-two'});
        item.selectedVersionId = item.versions[0].id;
        item.status = interruptedStatus;
        item.taskId = 'interrupted-active-task';
        saved.videoGeneration.status = 'running';
        saved.videoGeneration.items = [item, {status:interruptedStatus,taskId:'interrupted-no-saved-video',localPath:'',versions:[],selectedVersionId:''}];
        saved.videoGeneration.totalCount = 2;
        globalThis.beforeRestore = structuredClone(item);
        project = normalizeProject(saved);
      `);
      const state = h.snapshot('project.videoGeneration');
      const before = h.snapshot('beforeRestore');
      assert.equal(h.run('project.running'), false);
      assert.equal(state.status, 'pending');
      assert.equal(state.generatedCount, 1);
      assert.equal(state.items[0].status, 'success');
      assert.equal(state.items[0].taskId, '');
      assert.equal(state.items[1].status, 'pending');
      assert.equal(state.items[1].taskId, '');
      assert.deepEqual(state.items[0].versions, before.versions);
      assert.equal(state.items[0].selectedVersionId, before.selectedVersionId);
      assert.equal(h.run('getSelectedVideoVersion(project.videoGeneration.items[0]).localPath'), 'C:/saved/version-one.mp4');
      assert.equal(h.run('runningGenerationStep(project)'), null);
      assert.deepEqual(h.calls, {create:[],poll:[],download:[]});
    });
  }
}

test('重启时已有所有成片的中断重生成恢复完成，合法待认证记录保持原样', () => {
  const h = harness();
  h.run(`
    globalThis.saved = structuredClone(project);
    saved.running = true; saved.videoGeneration.status = 'running';
    saved.videoGeneration.items[0] = appendVideoVersion(saved.videoGeneration.items[0], {localPath:'C:/saved/retained.mp4'}, {taskId:'saved-task'});
    saved.videoGeneration.items[0].status = 'downloading';
    saved.videoGeneration.items[0].taskId = 'interrupted-task';
    project = normalizeProject(saved);
  `);
  assert.equal(h.run('project.videoGeneration.status'), 'complete');
  assert.equal(h.run('project.videoGeneration.generatedCount'), 1);
  assert.equal(h.run('project.videoGeneration.items[0].status'), 'success');
  h.run(`
    saved = structuredClone(project);
    saved.videoGeneration.status = 'awaiting-certification';
    saved.videoGeneration.items[0].status = 'certification';
    saved.videoGeneration.items[0].taskId = 'legitimate-rejected-task';
    saved.videoGeneration.pendingCertification = {shotIndex:0,blockedInputs:[{assetName:'阿宁',localPath:'C:/saved/阿宁.png'}],resumeIndexes:[0],mode:'batch'};
    globalThis.beforeCertification = structuredClone(saved.videoGeneration);
    project = normalizeProject(saved);
  `);
  assert.deepEqual(h.snapshot('project.videoGeneration'), h.snapshot('beforeCertification'));
  assert.equal(h.run('project.running'), false);
  assert.deepEqual(h.calls, {create:[],poll:[],download:[]});
});
