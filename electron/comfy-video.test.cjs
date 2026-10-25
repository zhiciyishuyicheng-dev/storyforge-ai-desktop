const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DEFAULTS, REQUIRED_NODES, normalizeSettings, endpoint, resolveModels, frameCount, buildWorkflow, createService } = require('./comfy-video.cjs');

const models = { model: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', clipModel: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', videoVae: 'minimax_h3_video_vae_fp16.safetensors', audioVae: 'minimax_h3_audio_vae_fp32.safetensors' };
function nodeInfo() {
  const info = Object.fromEntries(REQUIRED_NODES.map(name => [name, { input: { required: {} } }]));
  info.UNETLoader.input.required.unet_name = [[models.model, 'minimax_h3_fl2va.safetensors']];
  info.CLIPLoader.input.required.clip_name = [[models.clipModel]];
  info.VAELoader.input.required.vae_name = [[models.videoVae, models.audioVae]];
  return info;
}

test('H3 workflow uses Ref2VA and ordered dynamic references, with no director example state', () => {
  const settings = { ...DEFAULTS, ...models, baseUrl: 'http://localhost:8188' };
  const built = buildWorkflow({ settings, prompt: '<Picture 2> holds a cup beside <Picture 1>.', images: ['a.png', 'b.png'], duration: 5, seed: 42 });
  assert.equal(built.graph['1'].inputs.unet_name, models.model);
  assert.deepEqual(built.graph['5'].inputs['ref_images.ref_image_0'], ['100', 0]);
  assert.deepEqual(built.graph['5'].inputs['ref_images.ref_image_1'], ['101', 0]);
  assert.equal(built.graph['100'].inputs.image, 'a.png');
  assert.equal(built.graph['101'].inputs.image, 'b.png');
  assert.deepEqual([built.width, built.height, built.frames], [864, 480, 124]);
  assert.equal(built.actualDuration, 124 / 24);
  assert.equal(frameCount(15), 362);
  assert.throws(() => frameCount(16), /4 至 15/);
  assert.throws(() => buildWorkflow({ settings, prompt: '<Picture 3>', images: ['a.png'], duration: 5 }), /编号/);
  const silent = buildWorkflow({ settings: { ...settings, generateAudio: false }, prompt: '<Picture 1>', images: ['a.png'], duration: 5 });
  assert.equal(silent.graph['12'], undefined);
  assert.equal(silent.graph['13'].inputs.audio, undefined);
  assert.ok(!JSON.stringify(built.graph).includes('Director'));
});

test('connection preserves gateway prefix and query credentials; FL2VA cannot pass preflight', () => {
  const settings = normalizeSettings({ baseUrl: 'https://gpu.example/comfy/?token=private#canvas' });
  const url = endpoint(settings, 'history?max_items=200');
  assert.equal(url.pathname, '/comfy/history');
  assert.equal(url.searchParams.get('token'), 'private');
  assert.equal(url.searchParams.get('max_items'), '200');
  assert.throws(() => normalizeSettings({ baseUrl: 'https://gpu.example', model: 'fl2va.safetensors' }), /Ref2VA/);
  const info = nodeInfo(); info.UNETLoader.input.required.unet_name = [['fl2va.safetensors']];
  assert.throws(() => resolveModels(settings, info), /缺少可用/);
});

async function serverHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyforge-h3-test-'));
  const image = path.join(dir, 'reference.png'); fs.writeFileSync(image, Buffer.from('image fixture'));
  let uploaded = 0, submitted = 0, graph, extra, complete = false, loseResponse = false, fail = false;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); requests.push({ method: req.method, path: url.pathname });
    assert.equal(url.searchParams.get('token'), 'gateway-key');
    assert.equal(req.headers.authorization, 'Bearer access-token');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    const send = data => res.end(JSON.stringify(data));
    const entry = () => ({ prompt: [0, 'remote-1', graph, extra], status: fail ? { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } : { completed: complete }, outputs: complete ? { '14': { images: [{ filename: 'result.mp4', subfolder: 'video', type: 'output' }] } } : {} });
    if (url.pathname === '/comfy/system_stats') return send({ devices: [] });
    if (url.pathname === '/comfy/object_info') return send(nodeInfo());
    if (url.pathname === '/comfy/upload/image') { assert.match(req.headers['content-type'], /multipart/); return send({ name: `ref-${++uploaded}.png`, subfolder: 'refs', type: 'input' }); }
    if (url.pathname === '/comfy/prompt') {
      submitted += 1; const data = JSON.parse(body); graph = data.prompt; extra = { ...data.extra_data, client_id: data.client_id };
      if (loseResponse) return req.socket.destroy();
      return send({ prompt_id: 'remote-1', number: 0 });
    }
    if (url.pathname === '/comfy/queue') return send({ queue_running: submitted && !complete && !fail ? [[0, 'remote-1', graph, extra]] : [], queue_pending: [] });
    if (url.pathname === '/comfy/history') return send(complete || fail ? { 'remote-1': entry() } : {});
    if (url.pathname === '/comfy/history/remote-1') return send(complete || fail ? { 'remote-1': entry() } : {});
    if (url.pathname === '/comfy/view') {
      assert.equal(url.searchParams.get('filename'), 'result.mp4');
      res.setHeader('Content-Type', 'video/mp4'); return res.end(Buffer.from('mp4 fixture'));
    }
    res.statusCode = 404; send({ error: 'Not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  let settings = { ...DEFAULTS, baseUrl: `http://127.0.0.1:${server.address().port}/comfy?token=gateway-key`, token: 'access-token' };
  const options = { readSettings: () => settings, jobsPath: path.join(dir, 'jobs.json'), outputRoot: dir, assertImagePath: value => { assert.equal(value, image); return value; } };
  const service = createService(options);
  return { service, options, requests, task: { prompt: '<Picture 1> turns her head.', duration: 5, ratio: '16:9', resolution: '480p', generateAudio: true, imageInputs: [{ localPath: image, referenceNumber: 1 }] }, count: () => submitted, graph: () => graph, complete: () => { complete = true; }, fail: () => { fail = true; }, lose: () => { loseResponse = true; }, changeEndpoint: () => { settings = { ...settings, baseUrl: 'http://different.example' }; } };
}

test('test connection is read-only; submit, restore durable task, poll, and versioned download use authenticated API', async t => {
  const h = await serverHarness(t);
  assert.equal((await h.service.test()).model, models.model);
  assert.ok(h.requests.every(r => r.method === 'GET'));
  const created = await h.service.createTask(h.task);
  assert.equal(h.count(), 1);
  assert.equal(h.graph()['100'].inputs.image, 'refs/ref-1.png');
  assert.equal((await createService(h.options).getTask(created.id)).status, 'running');
  h.complete();
  const done = await h.service.getTask(created.id);
  assert.equal(done.status, 'succeeded');
  assert.ok(!done.videoUrl.includes('gateway-key'));
  const request = { taskId: created.id, projectId: 'test', projectTitle: 'H3', fileName: 'shot.mp4' };
  const first = await h.service.download(request);
  const second = await h.service.download(request);
  assert.notEqual(first.localPath, second.localPath);
  assert.equal(fs.readFileSync(first.localPath, 'utf8'), 'mp4 fixture');
  h.changeEndpoint();
  await assert.rejects(() => h.service.getTask(created.id), /另一台实例/);
});

test('lost submit response recovers the original queued job without submitting it twice', async t => {
  const h = await serverHarness(t); h.lose();
  const created = await h.service.createTask(h.task);
  assert.equal(created.submissionUncertain, true);
  assert.equal((await h.service.getTask(created.id)).status, 'running');
  assert.equal(h.count(), 1);
});

test('remote execution errors are reported instead of waiting for a nonexistent download', async t => {
  const h = await serverHarness(t);
  const created = await h.service.createTask(h.task); h.fail();
  const result = await h.service.getTask(created.id);
  assert.equal(result.status, 'failed'); assert.match(result.error, /CUDA out of memory/);
});
