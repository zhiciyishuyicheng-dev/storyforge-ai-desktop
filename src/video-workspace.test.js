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
  const storage = new Map(), calls = [];
  const context = vm.createContext({
    ...durations, ...references, ...generation, ...workflowProgress, structuredClone,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { storyforgeAI: {
      showSeedanceVideo: async filePath => { calls.push(['show', filePath]); return { ok: true }; },
      ...api,
    }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(renderer, context);
  vm.runInContext('render = () => {}; renderWithoutMovingPage = () => {}; showToast = message => { globalThis.lastToast = message; };', context);
  return { context, calls, storage, run: code => vm.runInContext(code, context), snapshot: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)) };
}

function version(number, index = 0) {
  return { id: `shot-${index + 1}-version-${number}`, number, fileName: `镜头-${String(index + 1).padStart(2, '0')}-v${number}.mp4`, localPath: `C:/videos/shot-${index + 1}-v${number}.mp4`, videoFileUrl: `file:///C:/videos/shot-${index + 1}-v${number}.mp4`, duration: 5, generatedAt: `2026-10-21T08:0${number}:00.000Z` };
}

function load(h, { count = 8, storyboard = true } = {}) {
  const prompts = Array.from({ length: count }, (_, index) => `镜头 ${index + 1}：书桌上的信封，5秒。`);
  const first = version(1), second = version(2);
  h.context.fixture = { count, prompts, first, second, storyboard };
  h.run(`
    project.title = '视频工作区验证'; project.script = '书桌上的信封。'; project.activeStep = 'video';
    project.outputs = { analysis: { title:'原故事分析', body:'保留分析' }, assets:{title:'原视觉素材',promptItems:[]}, video: { title:'Seedance 分镜视频',subtitle:'验证视频工作区',body:''} };
    if (fixture.storyboard) project.outputs.storyboard = {title:'原分镜',body:'保留分镜',prompts:fixture.prompts,durations:fixture.prompts.map(()=>5),shots:fixture.prompts.map((prompt,index)=>({no:String(index+1).padStart(2,'0'),prompt,duration:5,uploads:[]}))};
    project.completed = ['analysis','storyboard','assets'];
    project.videoGeneration = { ...defaultProject.videoGeneration, status:'pending', generatedCount:1, totalCount:fixture.count, items:fixture.prompts.map((_prompt,index)=>({status:'pending',fileName:'镜头-'+String(index+1).padStart(2,'0')+'.mp4'})) };
    project.videoGeneration.items[0] = normalizeVideoItemVersions({...fixture.first,status:'success',versions:[fixture.first,fixture.second],selectedVersionId:fixture.first.id});
    project.running = false; seedanceStatus.configured = true; saveProject();
  `);
}

test('旧版平铺视频迁移为第 1 版，重复路径不增加历史版本且选择可持久保存', () => {
  const h = harness(); load(h);
  h.context.oldItem = { status: 'success', fileName: '旧分镜.mp4', localPath: 'C:/videos/legacy.mp4', videoFileUrl: 'file:///C:/videos/legacy.mp4', taskId: 'old-task', duration: 5 };
  const legacy = h.snapshot('normalizeVideoItemVersions(oldItem)');
  assert.equal(legacy.versions.length, 1); assert.equal(legacy.versions[0].number, 1);
  assert.equal(legacy.versions[0].localPath, h.context.oldItem.localPath);
  h.context.legacy = legacy;
  assert.equal(h.run('getSelectedVideoVersion(legacy).localPath'), h.context.oldItem.localPath);
  h.run('project.videoGeneration.items[0] = legacy; project = normalizeProject(JSON.parse(JSON.stringify(project)));');
  assert.equal(h.run('project.videoGeneration.items[0].versions.length'), 1);
  assert.equal(h.run('getSelectedVideoVersion(project.videoGeneration.items[0]).localPath'), h.context.oldItem.localPath);
  h.context.duplicate = { ...legacy, versions: [...legacy.versions, { ...legacy.versions[0], id: 'duplicate', localPath: 'c:/VIDEOS/LEGACY.mp4' }] };
  assert.equal(h.run('normalizeVideoItemVersions(duplicate).versions.length'), 1);
});

test('第四步底部只显示实际视频分镜导航，前两步仍显示原执行进度', () => {
  const h = harness(); load(h);
  const videoFooter = h.run('generationProgressTemplate()');
  assert.equal((videoFooter.match(/data-video-nav-index=/g) || []).length, 8);
  assert.doesNotMatch(videoFooter, /提示词准备|独立审计|正文前思考/);
  h.run('project.activeStep = "analysis"');
  const analysisFooter = h.run('generationProgressTemplate()');
  assert.doesNotMatch(analysisFooter, /data-video-nav-index=/);
});

test('视频导航只给当前生成镜头加载角标，已保存显示勾，未生成无角标', () => {
  const h = harness(); load(h);
  h.run(`project.running=true; project.videoGeneration.status='running'; project.videoGeneration.items[5].status='creating';`);
  const html = h.run('videoNavigationTemplate()');
  const buttons = Array.from(html.matchAll(/<button\b[^>]*data-video-nav-index="(\d+)"[^>]*>([\s\S]*?)<\/button>/g));
  assert.equal(buttons.length, 8);
  assert.match(buttons[0][2], /√/); assert.doesNotMatch(buttons[0][2], /spinner/);
  assert.match(buttons[5][2], /spinner/); assert.doesNotMatch(buttons[5][2], /√/);
  assert.doesNotMatch(buttons[7][2], /√|spinner/);
  h.run(`codexImageRun={ownerProject:project}; project.videoGeneration.items[5].status='pending';`);
  assert.doesNotMatch(h.run('videoNavigationTemplate()'), /class="video-nav-spinner"/);
});

test('后台生成中可切换旧版本，播放器和文件夹定位使用所选版，任务参数保持不变', async () => {
  const h = harness(); load(h);
  h.run(`project.running = true; project.videoGeneration.status='running'; Object.assign(project.videoGeneration.items[0],{status:'running',taskId:'active-new-task',error:'',duration:9});`);
  const before = h.snapshot('project.videoGeneration.items[0]');
  h.run('selectVideoVersion(0,fixture.second.id)');
  const after = h.snapshot('project.videoGeneration.items[0]');
  assert.equal(after.selectedVersionId, version(2).id);
  assert.equal(after.status, 'running'); assert.equal(after.taskId, 'active-new-task'); assert.equal(after.duration, 9);
  assert.deepEqual(after.versions, before.versions);
  assert.equal(h.run('project.running'), true);
  const html = h.run('videoGenerationTemplate()');
  assert.match(html, /file:\/\/\/C:\/videos\/shot-1-v2\.mp4/);
  assert.match(html, /data-show-video-index="0"/);
  assert.doesNotMatch(html, /data-download-video-index|downloadAllVideos/);
  await h.run('showGeneratedVideo(0)');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], ['show', version(2).localPath]);
  assert.equal(h.run('project.videoGeneration.items[0].status'), 'running');
  const persisted = JSON.parse(h.storage.get('storyforge-project-library-v1')).projects[0];
  assert.equal(persisted.videoGeneration.items[0].selectedVersionId, version(2).id);
});

test('分镜已清空时历史视频仍提供分镜导航、版本切换和所选版文件夹定位', async () => {
  const h = harness(); load(h, { count: 2, storyboard: false });
  const footer = h.run('generationProgressTemplate()');
  assert.equal((footer.match(/data-video-nav-index=/g) || []).length, 2);
  assert.doesNotMatch(footer, /提示词准备|独立审计/);
  h.run('selectVideoVersion(0, fixture.second.id)');
  const html = h.run('videoGenerationTemplate()');
  assert.match(html, /保留的视频结果/); assert.match(html, /data-show-video-index="0"/);
  assert.match(html, /data-select-video-version-index="0"/);
  assert.match(html, /file:\/\/\/C:\/videos\/shot-1-v2\.mp4/);
  assert.doesNotMatch(html, /data-download-video-index|downloadAllVideos/);
  await h.run('showGeneratedVideo(0)');
  assert.equal(h.calls[0][1], version(2).localPath);
});

test('版本切换保存失败回滚，非法版本和生成中重做不更改项目或取消任务', () => {
  const h = harness(); load(h);
  const before = h.snapshot('project');
  h.run('localStorage.setItem=()=>{throw new Error("存储已满")};');
  assert.equal(h.run('selectVideoVersion(0, fixture.second.id)'), false);
  assert.deepEqual(h.snapshot('project'), before);
  assert.match(h.run('lastToast'), /保留|失败|未能/);
  assert.equal(h.run('selectVideoVersion(0, "missing-version")'), false);
  assert.deepEqual(h.snapshot('project'), before);
  h.run('project.running=true; project.videoGeneration.status="running"; project.videoGeneration.items[5].status="creating";');
  const busy = h.snapshot('project'), token = h.run('generationRun');
  h.run('regenerateVideoShot(0)');
  assert.equal(h.run('generationRun'), token);
  assert.deepEqual(h.snapshot('project'), busy); assert.deepEqual(h.calls, []);
  assert.match(h.run('lastToast'), /完成|停止|正在生成/);
});

test('视频步骤二次确认清空全部关联版本，取消保留并且其他步骤保持完整', () => {
  const h = harness(); load(h);
  const before = h.snapshot('project');
  h.run('requestClearCurrentResult(); closeClearResultDialog()');
  assert.deepEqual(h.snapshot('project'), before);
  h.run('requestClearCurrentResult(); confirmClearCurrentResult()');
  assert.deepEqual(h.snapshot('project.videoGeneration.items'), []);
  assert.equal(h.run('project.outputs.video'), undefined);
  for (const step of ['analysis', 'storyboard', 'assets']) assert.deepEqual(h.snapshot(`project.outputs.${step}`), before.outputs[step]);
});
