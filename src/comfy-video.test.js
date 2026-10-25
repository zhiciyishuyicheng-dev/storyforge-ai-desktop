import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as durations from './seedance-duration.js';
import * as references from './seedance-references.js';
import * as generation from './seedance-generation.js';
import * as workflowProgress from './workflow-progress.js';
import * as h3 from './h3-references.js';
import * as comfyUI from './comfy-video-ui.js';

const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const renderer = source.slice(0, source.lastIndexOf('\nrender();')).replace(/^import .*;\r?\n/gm, '');

function harness(api = {}) {
  const storage = new Map(); const calls = { create: [], poll: [], download: [] };
  const context = vm.createContext({
    ...durations, ...references, ...generation, ...workflowProgress, ...h3, ...comfyUI, structuredClone,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { storyforgeAI: {
      createSeedanceTask: () => { throw new Error('Must use H3'); },
      createComfyVideoTask: async task => { calls.create.push(task); return { id: 'comfy-task-1', status: 'queued', model: 'h3-ref2va', actualDuration: 124 / 24 }; },
      getComfyVideoTask: async id => { calls.poll.push(id); return { id, status: 'succeeded', videoUrl: 'comfy-output:task-1' }; },
      downloadComfyVideo: async task => { calls.download.push(task); return { localPath: 'C:/saved/H3.mp4', fileName: 'H3.mp4', videoFileUrl: 'file:///C:/saved/H3.mp4' }; }, ...api,
    }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(renderer, context);
  vm.runInContext(`
    render = () => {}; renderWithoutMovingPage = () => {}; showToast = () => {}; wait = async () => {};
    project.activeStep = 'video';
    project.outputs = { storyboard: { prompts: ['本段总时长：5秒\\n@阿宁 轻轻转头。'], shots: [{ duration: 5, uploads: [{ref: '@阿宁', asset: '阿宁'}] }] }, video: { title: '视频', body: '' } };
    project.assetGeneration.items = [{ name: '阿宁', type: '人物', files: [{ localPath: 'C:/saved/阿宁.png' }] }];
    project.videoGeneration.provider = 'comfy';
    comfyVideoStatus = { ...comfyVideoStatus, configured: true };
    initializeVideoGeneration(project.outputs.storyboard.prompts);
  `, context);
  return { calls, context, run: code => vm.runInContext(code, context), snapshot: code => JSON.parse(vm.runInContext('JSON.stringify('+code+')', context)) };
}

test('H3 adapter uploads ordered references, saves video versions and leaves user storyboard text untouched', async () => {
  const h = harness();
  await h.run('generateSeedanceVideos({token:generationRun})');
  assert.equal(h.calls.create.length, 1);
  assert.match(h.calls.create[0].prompt, /<Picture 1> 轻轻转头/);
  assert.equal(h.calls.create[0].imageInputs[0].localPath, 'C:/saved/阿宁.png');
  const version = h.snapshot('project.videoGeneration.items[0].versions[0]');
  assert.equal(version.provider, 'comfy'); assert.equal(version.model, 'h3-ref2va');
  assert.equal(version.actualDuration, 124 / 24);
  assert.match(h.run('project.outputs.storyboard.prompts[0]'), /@阿宁/);
});

test('pause during submission preserves late H3 task handle and continues querying without duplicate submission', async () => {
  let entered, resolve; const reached = new Promise(done => { entered = done; });
  const pending = new Promise(done => { resolve = done; });
  const h = harness({ createComfyVideoTask: async task => { h.calls.create.push(task); entered(); return pending; } });
  const running = h.run('generateSeedanceVideos({token:generationRun})');
  await reached; h.run('stopCurrentGeneration()');
  resolve({ id: 'comfy-late', status: 'queued', model: 'h3-ref2va' }); await running;
  assert.equal(h.run('project.videoGeneration.items[0].taskId'), 'comfy-late');
  h.run('project = normalizeProject(structuredClone(project))');
  assert.equal(h.run('project.videoGeneration.items[0].taskId'), 'comfy-late');
  await h.run('generateSeedanceVideos({token:generationRun})');
  assert.equal(h.calls.create.length, 1);
  assert.deepEqual(h.calls.poll, ['comfy-late']);
  assert.equal(h.calls.download.length, 1);
});

test('reference mapping matches identities after reordering and preserves exact dialogue', () => {
  const request = h3.buildH3ReferenceRequest({ prompt: '@乙 看着 @甲，说：“别动，我来。” @乙 点头。', shot: {}, assetItems: [{ name: '甲', files: [{ localPath: 'a.png' }] }, { name: '乙', files: [{ localPath: 'b.png' }] }] });
  assert.deepEqual(request.imagePaths, ['b.png', 'a.png']);
  assert.match(request.prompt, /<Picture 1> 看着 <Picture 2>，说：“别动，我来。” <Picture 1> 点头。/);
  assert.throws(() => h3.buildH3ReferenceRequest({ prompt: '@Audio1', shot: {} }), /移除/);
});
