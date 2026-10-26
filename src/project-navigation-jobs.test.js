import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as durations from './seedance-duration.js';
import * as references from './seedance-references.js';
import * as generation from './seedance-generation.js';
import * as progress from './workflow-progress.js';
import * as h3 from './h3-references.js';
import * as comfyUI from './comfy-video-ui.js';
import * as outline from './storyboard-outline.js';
import * as history from './generation-skill-history.js';

const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const renderer = source.slice(0, source.lastIndexOf('\nrender();')).replace(/^import .*;\r?\n/gm, '');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt += 1) await Promise.resolve();
  assert.ok(predicate(), 'expected asynchronous request to start');
}

function harness(api = {}) {
  const storage = new Map();
  const calls = { cancelImage: [], cancelWorkflow: [], downloads: [] };
  const context = vm.createContext({
    ...durations, ...references, ...generation, ...progress, ...h3, ...comfyUI, ...outline, ...history,
    structuredClone,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { confirm: () => true, setTimeout: () => 1, setInterval: () => 1, clearInterval: () => {}, storyforgeAI: {
      cancelCodexImage: async id => { calls.cancelImage.push(id); },
      cancelWorkflow: async value => { calls.cancelWorkflow.push(value); },
      createSeedanceTask: async () => ({ id: 'seedance-task', status: 'queued' }),
      getSeedanceTask: async () => ({ status: 'succeeded', videoUrl: 'https://example.test/video.mp4' }),
      downloadSeedanceVideo: async request => { calls.downloads.push(request); return { localPath: 'C:/saved/owner.mp4', fileName: 'owner.mp4', videoFileUrl: 'file:///C:/saved/owner.mp4' }; },
      ...api,
    } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(renderer, context);
  vm.runInContext(`
    render = () => {}; renderWithoutMovingPage = () => {};
    showToast = message => { globalThis.lastToast = message; };
    openModelSettings = () => {}; setModelMessage = () => {};
    refreshCodexImageStatus = async () => { codexImageStatus = {available:true,authenticated:true,imageGeneration:true,model:'gpt-image-2'}; };
    deepseekStatus.configured = true;
    seedanceStatus = {...seedanceStatus,configured:true,checking:false};
    globalThis.owner = project;
    owner.title = '后台项目 A'; owner.script = '清晨，阳光照进书房。';
    owner.outputs.storyboard = { title:'分镜',prompts:['[0-5秒] 书房窗边的阳光。'],durations:[5],shots:[{no:'01',duration:5,prompt:'[0-5秒] 书房窗边的阳光。'}] };
    owner.outputs.assets = { title:'素材',promptItems:[{name:'书房',type:'场景参考图',fileName:'书房.png',prompt:'书房场景参考图'}] };
    saveProject();
    globalThis.other = createProject({title:'查看项目 B'}); projectLibrary.projects.push(other); saveProjectLibrary();
  `, context);
  return {
    context, storage, calls,
    run: code => vm.runInContext(code, context),
    snapshot: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
    saved: () => JSON.parse(storage.get('storyforge-project-library-v1')),
  };
}

test('生成大纲时切换项目不取消请求，返回结果只写回原项目并保留当前查看位置', async () => {
  const pending = deferred(); let requested = false;
  const h = harness({ generateWorkflow: async () => { requested = true; return pending.promise; } });
  const job = h.run('startGeneration()');
  await until(() => requested);
  const token = h.run('generationRun');
  h.run('switchProject(other.id)');
  assert.equal(h.run('generationRun'), token);
  assert.equal(h.run('owner.running'), true);
  assert.equal(h.run('project === other'), true);
  pending.resolve({ stage: 'outline', model: 'deepseek-flash', data: { outline: { title: '分镜大纲', rows: [{ no: '01', duration: 5, scene: '书房', content: '阳光照进书房，近景呈现窗边光影。' }] } } });
  await job;
  assert.equal(h.run('owner.outputs.analysis.generatedStage'), 'outline');
  assert.equal(h.run('other.outputs.analysis'), undefined);
  assert.equal(h.run('project === other'), true);
  assert.equal(h.run('owner.running'), false);
  assert.equal(h.saved().activeProjectId, h.run('other.id'));
  assert.equal(h.calls.cancelWorkflow.length, 0);
});

test('GPT 生图跨项目继续保存到任务项目，完成后不跳回原项目', async () => {
  const pending = deferred(); const requests = [];
  const h = harness({ generateCodexImage: async request => { requests.push(request); return pending.promise; } });
  const job = h.run('generateCodexImageAssets()');
  await until(() => requests.length === 1);
  h.run('switchProject(other.id)');
  assert.equal(h.run('activeBackgroundProject() === owner'), true);
  pending.resolve({ files: [{ localPath: 'C:/saved/owner.png', imageUrl: 'file:///C:/saved/owner.png', fileName: 'owner.png' }] });
  await job;
  assert.equal(h.run('owner.assetGeneration.items[0].files[0].localPath'), 'C:/saved/owner.png');
  assert.equal(h.run('other.assetGeneration.items.length'), 0);
  assert.equal(h.run('owner.running'), false);
  assert.equal(h.run('project === other'), true);
  assert.equal(h.saved().activeProjectId, h.run('other.id'));
  assert.equal(h.calls.cancelImage.length, 0);
});

test('Seedance 视频跨项目继续轮询和下载，版本与下载参数均属于原项目', async () => {
  const pending = deferred(); let requested = false;
  const h = harness({ createSeedanceTask: async () => { requested = true; return pending.promise; } });
  const job = h.run('generateVideoStage(generateRunToken())');
  await until(() => requested);
  h.run('switchProject(other.id)');
  pending.resolve({ id: 'owner-task', status: 'queued' });
  await job;
  assert.equal(h.calls.downloads.length, 1);
  assert.equal(h.calls.downloads[0].projectId, h.run('owner.id'));
  assert.equal(h.run('owner.videoGeneration.items[0].versions[0].localPath'), 'C:/saved/owner.mp4');
  assert.equal(h.run('other.videoGeneration.items.length'), 0);
  assert.equal(h.run('owner.completed.includes("video")'), true);
  assert.equal(h.run('project === other'), true);
  assert.equal(h.saved().activeProjectId, h.run('other.id'));
});

test('H3 视频创建响应和后续查询跨项目时仍关联原任务，背景查看不丢失任务编号', async () => {
  const pending = deferred(); const downloads = [], requests = []; let requested = false;
  const h = harness({
    createComfyVideoTask: async request => { requests.push(request); requested = true; return requests.length === 1 ? pending.promise : { id: 'h3-owner-task-02', status: 'queued', model: 'minimax-h3', actualDuration: 6 }; },
    getComfyVideoTask: async () => ({ status: 'succeeded', videoUrl: 'https://example.test/h3.mp4', model: 'minimax-h3', actualDuration: 5 }),
    downloadComfyVideo: async request => { downloads.push(request); return { localPath: 'C:/saved/h3-owner.mp4', fileName: 'h3-owner.mp4' }; },
  });
  h.run(`
    owner.videoGeneration.provider = 'comfy'; comfyVideoStatus = {...comfyVideoStatus,configured:true,checking:false};
    owner.outputs.storyboard.prompts = ['@书房 [0-5秒] 书房窗边的阳光。', '@书房 [0-6秒] 书桌上的光影。'];
    owner.outputs.storyboard.shots[0].prompt = owner.outputs.storyboard.prompts[0];
    owner.outputs.storyboard.shots.push({no:'02',duration:6,prompt:owner.outputs.storyboard.prompts[1]});
    owner.outputs.storyboard.durations = [5,6];
    alignAssetGenerationItems(owner.outputs.assets.promptItems);
    owner.assetGeneration.items[0].files = [{localPath:'C:/saved/study.png'}];
  `);
  const job = h.run('generateVideoStage(generateRunToken())');
  await until(() => requested);
  h.run('switchProject(other.id)');
  pending.resolve({ id: 'h3-owner-task', status: 'queued', model: 'minimax-h3', actualDuration: 5 });
  await job;
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every(request => request.projectId === h.run('owner.id')));
  assert.deepEqual(requests.map(request => request.duration), [5, 6]);
  assert.ok(requests.every(request => request.ratio === '16:9' && request.imagePaths[0] === 'C:/saved/study.png'));
  assert.equal(h.run('owner.videoGeneration.items[0].taskId'), 'h3-owner-task');
  assert.equal(h.run('owner.videoGeneration.items[0].versions[0].provider'), 'comfy');
  assert.equal(h.run('other.videoGeneration.items.length'), 0);
  assert.equal(h.run('project === other'), true);
});

test('查看另一个项目时不能启动冲突任务或取消后台项目，只有明确停止任务所属项目才取消', async () => {
  const pending = deferred(); let requests = 0;
  const h = harness({ generateCodexImage: async () => { requests += 1; return pending.promise; } });
  const job = h.run('generateCodexImageAssets()');
  await until(() => requests === 1);
  const token = h.run('generationRun');
  h.run('switchProject(other.id); stopCurrentGeneration()');
  assert.equal(h.run('generationRun'), token);
  assert.equal(h.run('generateRunToken()'), null);
  assert.equal(h.run('generationRun'), token);
  await h.run('startGeneration()');
  assert.equal(h.run('owner.running'), true);
  assert.equal(h.calls.cancelImage.length, 0);
  h.run('stopCurrentGeneration(owner)');
  assert.equal(h.calls.cancelImage.length, 1);
  assert.equal(h.run('owner.running'), false);
  pending.resolve({ files: [{ localPath: 'C:/saved/late.png' }] });
  await job;
  assert.equal(h.run('owner.assetGeneration.items[0].files.length'), 0);
});

test('清空当前查看项目的结果不会使另一个项目的后台任务失效', async () => {
  const pending = deferred(); let requested = false;
  const h = harness({ generateCodexImage: async () => { requested = true; return pending.promise; } });
  const job = h.run('generateCodexImageAssets()');
  await until(() => requested);
  const token = h.run('generationRun');
  h.run(`
    switchProject(other.id); other.activeStep = 'storyboard';
    other.outputs.storyboard = {title:'B的分镜',body:'待清空的B分镜',prompts:['B镜头']};
    requestClearCurrentResult(); confirmClearCurrentResult();
  `);
  assert.equal(h.run('generationRun'), token);
  assert.equal(h.run('other.outputs.storyboard'), undefined);
  pending.resolve({ files: [{ localPath: 'C:/saved/retained.png' }] });
  await job;
  assert.equal(h.run('owner.assetGeneration.items[0].files[0].localPath'), 'C:/saved/retained.png');
  assert.equal(h.run('project === other'), true);
});

test('后台项目的旧真人认证记录失效时只重置该项目的视频完成状态', () => {
  const h = harness();
  h.run(`
    owner.outputs.storyboard.prompts = ['@书房 的窗边阳光'];
    alignAssetGenerationItems(owner.outputs.assets.promptItems);
    owner.assetGeneration.items[0].files = [{localPath:'C:/saved/new-study.png'}];
    initializeVideoGeneration(owner.outputs.storyboard.prompts);
    owner.videoGeneration.items[0].status = 'certification';
    owner.videoGeneration.pendingCertification = {shotIndex:0,blockedInputs:[{assetName:'书房',localPath:'C:/saved/old-study.png'}]};
    owner.completed.push('video'); other.completed.push('video');
    switchProject(other.id);
    reconcilePortraitCertification(owner.videoGeneration, owner);
  `);
  assert.equal(h.run('owner.videoGeneration.pendingCertification'), null);
  assert.equal(h.run('owner.completed.includes("video")'), false);
  assert.equal(h.run('other.completed.includes("video")'), true);
});

test('清空查看项目会丢弃该项目迟到的本地上传，同时不影响其他项目生图', async () => {
  const image = deferred(), upload = deferred(); let imageStarted = false, uploadStarted = false;
  const h = harness({
    generateCodexImage: async () => { imageStarted = true; return image.promise; },
    selectLocalAssetImages: async () => { uploadStarted = true; return upload.promise; },
  });
  const job = h.run('generateCodexImageAssets()');
  await until(() => imageStarted);
  h.run(`
    switchProject(other.id); other.activeStep = 'assets';
    other.outputs.assets = {promptItems:[{name:'B场景',type:'场景参考图',fileName:'B.png',prompt:'B场景'}]};
    alignAssetGenerationItems(other.outputs.assets.promptItems);
    other.assetGeneration.items[0].files = [{localPath:'C:/saved/B-old.png'}];
  `);
  const localUpload = h.run('selectLocalAssetImages(0)');
  await until(() => uploadStarted);
  h.run('requestClearCurrentResult(); confirmClearCurrentResult()');
  upload.resolve({ files: [{localPath:'C:/saved/should-be-discarded.png'}] });
  await localUpload;
  assert.equal(h.run('other.assetGeneration.items[0].files.length'), 0);
  image.resolve({files:[{localPath:'C:/saved/background.png'}]});
  await job;
  assert.equal(h.run('owner.assetGeneration.items[0].files[0].localPath'), 'C:/saved/background.png');
});

test('新建或删除别的项目保留后台任务，删除任务项目后迟到响应不能恢复已删除项目', async () => {
  const pending = deferred(); let requested = false;
  const h = harness({ generateCodexImage: async () => { requested = true; return pending.promise; } });
  const job = h.run('generateCodexImageAssets()');
  await until(() => requested);
  h.run('createNewProject(); globalThis.viewed = project; deleteProject(other.id)');
  assert.equal(h.run('owner.running'), true);
  assert.equal(h.calls.cancelImage.length, 0);
  h.run('deleteProject(owner.id)');
  assert.equal(h.calls.cancelImage.length, 1);
  pending.resolve({ files: [{ localPath: 'C:/saved/deleted.png' }] });
  await job;
  assert.equal(h.run('projectLibrary.projects.some(item => item.id === owner.id)'), false);
  assert.equal(h.run('project === viewed'), true);
  assert.equal(h.saved().projects.some(item => item.id === h.run('owner.id')), false);
});

test('自动流程在跨项目浏览时继续图像和视频阶段，所有成果归原项目', async () => {
  const pending = deferred(); let images = 0;
  const h = harness({ generateCodexImage: async () => { images += 1; return pending.promise; } });
  h.run(`
    globalThis.pipeline = {ownerProject:owner,projectId:owner.id,inputScript:owner.script,stageSkills:{storyboard:null,assets:null},viewSequence:viewNavigationSequence};
    autoPipelineRun = pipeline; owner.autoPipeline = {status:'running',phase:'assets'}; owner.running = true;
  `);
  const job = h.run('continueAutoPipeline(pipeline)');
  await until(() => images === 1);
  h.run('switchProject(other.id)');
  pending.resolve({ files: [{ localPath: 'C:/saved/automatic.png', imageUrl: 'file:///C:/saved/automatic.png' }] });
  await job;
  assert.equal(h.run('owner.autoPipeline.status'), 'completed');
  assert.equal(h.run('owner.videoGeneration.items[0].versions.length'), 1);
  assert.equal(h.run('other.videoGeneration.items.length'), 0);
  assert.equal(h.run('project === other'), true);
  assert.equal(h.saved().activeProjectId, h.run('other.id'));
});

function seedOldVideo(h) {
  h.run(`
    owner.videoGeneration.items = [appendVideoVersion({fileName:'old.mp4'}, {localPath:'C:/saved/old.mp4',fileName:'old.mp4',videoFileUrl:'file:///C:/saved/old.mp4'}, {taskId:'old-task',prompt:'旧分镜',duration:5})];
    owner.videoGeneration.status = 'complete'; owner.videoGeneration.generatedCount = 1;
    owner.completed = ['analysis','storyboard','assets','video'];
  `);
}

test('重新生成分镜后历史成片仍可播放，但旧成功状态不能充当新分镜完成结果', async () => {
  let videos = 0;
  const h = harness({
    generateWorkflow: async () => ({ model: 'deepseek-flash', data: { storyboard: { shots: [{ no: '01', duration: 5, scene: '书房', outline: '新分镜', prompt: '[0-5秒] 新分镜的阳光。' }] }, assets: { scenes: [{ name: '书房', description: '书房场景' }] } } }),
    createSeedanceTask: async () => { videos += 1; return {id:'new-task',status:'queued'}; },
  });
  seedOldVideo(h);
  h.run(`owner.outputs.analysis = makeStoryboardOutlineOutput(buildStoryboardOutline({shots:[{no:'01',duration:5,scene:'书房',outline:'新分镜'}]}), {generatedStage:'outline',revision:'outline-2'});`);
  await h.run('startGeneration(false,{fullAuto:false,stage:"storyboard"})');
  assert.equal(h.run('owner.videoGeneration.items[0].needsGeneration'), true);
  assert.doesNotMatch(h.run('videoNavigationTemplate()'), /video-nav-check/);
  assert.equal(h.run('normalizeProject(owner).videoGeneration.generatedCount'), 0);
  assert.equal(h.run('owner.videoGeneration.items[0].status'), 'pending');
  assert.equal(h.run('getSelectedVideoVersion(owner.videoGeneration.items[0]).localPath'), 'C:/saved/old.mp4');
  assert.equal(h.run('owner.videoGeneration.items[0].versions.length'), 1);
  assert.equal(h.run('owner.videoGeneration.generatedCount'), 0);
  assert.equal(h.run('owner.completed.includes("video")'), false);
  assert.equal(videos, 0);
});

test('自动链使用新分镜时重新生成旧成功镜头，保留旧版本并追加当前版本', async () => {
  let created = 0;
  const h = harness({
    generateCodexImage: async () => ({files:[{localPath:'C:/saved/automatic.png'}]}),
    createSeedanceTask: async () => { created += 1; return {id:'new-task',status:'queued'}; },
  });
  seedOldVideo(h);
  h.run(`
    invalidateVideosForStoryboard(owner);
    globalThis.pipeline = {ownerProject:owner,projectId:owner.id,inputScript:owner.script,stageSkills:{storyboard:null,assets:null},viewSequence:viewNavigationSequence};
    autoPipelineRun = pipeline; owner.autoPipeline = {status:'running',phase:'assets'}; owner.running = true;
  `);
  await h.run('continueAutoPipeline(pipeline)');
  assert.equal(created, 1);
  assert.equal(h.run('owner.autoPipeline.status'), 'completed');
  assert.equal(h.run('owner.videoGeneration.items[0].versions.length'), 2);
  assert.equal(h.run('owner.videoGeneration.items[0].versions[0].localPath'), 'C:/saved/old.mp4');
  assert.equal(h.run('owner.videoGeneration.items[0].needsGeneration'), false);
  assert.equal(h.run('owner.videoGeneration.generatedCount'), 1);
});

test('新分镜视频生成失败时保留历史播放，但不把历史版本计入当前分镜完成数', async () => {
  const h = harness({ createSeedanceTask: async () => { throw new Error('生成失败'); } });
  seedOldVideo(h);
  h.run('invalidateVideosForStoryboard(owner)');
  await h.run('generateVideoStage(generateRunToken())');
  assert.equal(h.run('owner.videoGeneration.items[0].status'), 'failed');
  assert.equal(h.run('owner.videoGeneration.generatedCount'), 0);
  assert.equal(h.run('videoItemIsComplete(owner.videoGeneration.items[0])'), false);
  assert.equal(h.run('getSelectedVideoVersion(owner.videoGeneration.items[0]).localPath'), 'C:/saved/old.mp4');
  assert.equal(h.run('owner.completed.includes("video")'), false);
});
