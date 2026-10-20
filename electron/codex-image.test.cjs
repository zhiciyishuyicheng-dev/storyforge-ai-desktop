const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { cancel, cancelAll, _test } = require('./codex-image.cjs');
const { AppServer, readAccountStatus, waitForImageTurn, detectImageFormat, safeSegment, createGenerateAndSave } = _test;
const { normalizeSkillDocument } = require('./stage-skills.cjs');

// A complete 1x1 RGB PNG, not a generated network asset.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64');

function mockProcess(onRequest) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    for (const line of chunk.toString().trim().split('\n')) onRequest(JSON.parse(line), child);
    callback();
  } });
  return child;
}

function fakeClient({ accountType = 'chatgpt', imageGeneration = true, onTurn, thread = {} } = {}) {
  const client = new EventEmitter();
  client.calls = [];
  client.initialize = async () => { client.calls.push(['initialize']); };
  client.request = async (method, params) => {
    client.calls.push([method, params]);
    if (method === 'account/read') return { account: { type: accountType, email: 'private@example.invalid', planType: 'pro' } };
    if (method === 'modelProvider/capabilities/read') return { imageGeneration, webSearch: true };
    if (method === 'thread/start') return { thread: { id: 'thread-1' }, modelProvider: 'openai', sandbox: { type: 'readOnly' }, approvalPolicy: 'never', ...thread };
    if (method === 'turn/start') {
      if (onTurn) onTurn(client);
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    }
    throw new Error(`Unexpected method ${method}`);
  };
  client.close = () => { client.closed = true; };
  client.fail = error => { client.close(); client.emit('failure', error); };
  return client;
}

function emitImage(client, savedPath, patch = {}) {
  client.emit('notification', 'item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'imageGeneration', id: 'image-1', status: 'completed', savedPath, result: '', ...patch } });
}

function emitComplete(client, patch = {}) {
  client.emit('notification', 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, ...patch } });
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'storyforge-codex-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('status handshake reads only official account/capabilities and strips account identity', async () => {
  const methods = [];
  const child = mockProcess((request, proc) => {
    methods.push(request.method);
    if (!request.id) return;
    const result = request.method === 'account/read'
      ? { account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'pro' } }
      : request.method === 'modelProvider/capabilities/read' ? { imageGeneration: true, webSearch: false } : {};
    // Split a response to exercise streaming JSONL handling.
    const response = `${JSON.stringify({ id: request.id, result })}\n`;
    proc.stdout.write(response.slice(0, 8));
    proc.stdout.write(response.slice(8));
  });
  const client = new AppServer('official-codex.exe', { spawnProcess(cli, args, options) {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.CODEX_API_KEY, undefined);
    assert.ok(args.includes('forced_login_method="chatgpt"'));
    return child;
  } });
  const result = await readAccountStatus(client);
  assert.deepEqual(result, { authenticated: true, imageGeneration: true, planType: 'pro' });
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/read', 'modelProvider/capabilities/read']);
  assert.ok(!JSON.stringify(result).includes('private@example'));
  client.close();
  assert.equal(child.killed, true);
});

test('API Key login is refused before any capabilities or inference request', async () => {
  const client = fakeClient({ accountType: 'apiKey' });
  const result = await readAccountStatus(client);
  assert.equal(result.authenticated, false);
  assert.equal(result.imageGeneration, false);
  assert.deepEqual(client.calls.map(call => call[0]), ['initialize', 'account/read']);
});

test('protocol timeout kills process and rejects pending requests', async () => {
  const child = mockProcess(() => {});
  const client = new AppServer('codex.exe', { spawnProcess: () => child, rpcTimeoutMs: 15 });
  await assert.rejects(client.request('initialize'), { code: 'CODEX_TIMEOUT' });
  assert.equal(child.killed, true);
  assert.equal(client.pending.size, 0);
});

test('server permission/token requests fail closed without exposing their content', async () => {
  const child = mockProcess((request, proc) => {
    if (request.method === 'initialize') proc.stdout.write(`${JSON.stringify({ id: 'server-request', method: 'item/commandExecution/requestApproval', params: { secret: 'sensitive-value' } })}\n`);
  });
  const client = new AppServer('codex.exe', { spawnProcess: () => child });
  await assert.rejects(client.request('initialize'), error => error.code === 'CODEX_INTERACTION_REQUIRED' && !error.message.includes('sensitive-value'));
  assert.equal(child.killed, true);
});

test('malformed JSONL values and child launch errors reject safely', async () => {
  for (const invalidMessage of ['null', '{invalid-json']) {
    const child = mockProcess((request, proc) => { proc.stdout.write(`${invalidMessage}\n`); });
    const client = new AppServer('codex.exe', { spawnProcess: () => child });
    await assert.rejects(client.request('initialize'), { code: 'CODEX_PROTOCOL_ERROR' });
    assert.equal(child.killed, true);
  }
  const child = mockProcess(() => {});
  const client = new AppServer('codex.exe', { spawnProcess: () => child });
  const promise = client.request('initialize');
  child.emit('error', new Error('sensitive diagnostics'));
  await assert.rejects(promise, error => error.code === 'CODEX_START_FAILED' && !error.message.includes('sensitive'));
});

test('PNG content validation rejects truncation, checksum corruption and disguised text', () => {
  assert.equal(detectImageFormat(PNG), 'png');
  assert.throws(() => detectImageFormat(PNG.subarray(0, -1)), { code: 'CODEX_INVALID_IMAGE' });
  const corrupted = Buffer.from(PNG);
  corrupted[45] ^= 1;
  assert.throws(() => detectImageFormat(corrupted), { code: 'CODEX_INVALID_IMAGE' });
  assert.throws(() => detectImageFormat(Buffer.from('This is plain text with a .png filename')), { code: 'CODEX_INVALID_IMAGE' });
  assert.equal(safeSegment('../CON'), '.._CON');
  assert.equal(safeSegment('CON.txt'), '_CON.txt');
  assert.equal(safeSegment('..', 'fallback'), 'fallback');
});

test('native image item is insufficient until the matching turn completes', async () => {
  const client = fakeClient();
  let finished = false;
  const result = waitForImageTurn(client, 'thread-1', async () => ({ turn: { id: 'turn-1' } }), 1000).then(value => { finished = true; return value; });
  emitImage(client, path.join(os.tmpdir(), 'native.png'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  client.emit('notification', 'turn/completed', { threadId: 'other-thread', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(finished, false);
  emitComplete(client);
  assert.equal((await result).type, 'imageGeneration');
  assert.equal(client.listenerCount('notification'), 0);
});

test('completed prose, failed turn, failed image and missing savedPath never become success', async () => {
  for (const scenario of ['prose', 'turn-failed', 'image-failed', 'missing-file']) {
    const client = fakeClient();
    const promise = waitForImageTurn(client, 'thread-1', async () => {
      if (scenario === 'prose') {
        client.emit('notification', 'item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'Image saved to C:/image.png' } });
      } else emitImage(client, scenario === 'missing-file' ? null : path.join(os.tmpdir(), 'native.png'), scenario === 'image-failed' ? { status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'codex' } } : {});
      emitComplete(client, scenario === 'turn-failed' ? { status: 'failed' } : {});
      return { turn: { id: 'turn-1' } };
    });
    await assert.rejects(promise, { code: scenario === 'prose' ? 'CODEX_NO_IMAGE' : scenario === 'turn-failed' ? 'CODEX_TURN_FAILED' : scenario === 'image-failed' ? 'CODEX_USAGE_LIMIT' : 'CODEX_NO_IMAGE_FILE' });
  }
});

test('generation copies validated native file into project folder and versions repeated names', async t => {
  const root = await temporaryDirectory(t);
  const sourcePath = path.join(root, 'native.png');
  await fs.writeFile(sourcePath, PNG);
  const clients = [];
  const generate = createGenerateAndSave({ resolveCli: async () => 'codex.exe', createClient: () => {
    const client = fakeClient({ onTurn(instance) { emitImage(instance, sourcePath); emitComplete(instance); } });
    clients.push(client); return client;
  } });
  const options = { outputRoot: root, prompt: 'A red apple', projectTitle: 'Demo/Project', projectId: '../project', fileName: '角色.jpg', index: 0 };
  const first = await generate({ ...options, jobId: 'version-1' });
  const second = await generate({ ...options, jobId: 'version-2' });
  assert.equal(first.outputDirectory, path.join(root, 'StoryForge', 'Demo_Project', '.._project', '视觉素材', 'GPT订阅'));
  assert.equal(first.files[0].fileName, '角色.png');
  assert.equal(second.files[0].fileName, '角色-v2.png');
  assert.equal(first.files[0].provider, 'codex-subscription');
  assert.ok(first.files[0].imageUrl.startsWith('file:///'));
  assert.deepEqual(await fs.readFile(first.files[0].localPath), PNG);
  assert.deepEqual(await fs.readFile(second.files[0].localPath), PNG);
  assert.deepEqual(await fs.readFile(sourcePath), PNG);
  assert.equal(clients.every(client => client.closed), true);
  const threadParams = clients[0].calls.find(call => call[0] === 'thread/start')[1];
  assert.equal(threadParams.ephemeral, true);
  assert.equal(threadParams.sandbox, 'read-only');
  assert.equal(threadParams.approvalPolicy, 'never');
});

test('具名素材按真实名称保存而非旧编号文件名，安全处理路径并保留身份及重生成版本', async t => {
  const root = await temporaryDirectory(t);
  const sourcePath = path.join(root, 'native.png');
  await fs.writeFile(sourcePath, PNG);
  const generate = createGenerateAndSave({ resolveCli: async () => 'codex.exe', createClient: () => fakeClient({ onTurn(instance) { emitImage(instance, sourcePath); emitComplete(instance); } }) });
  const options = { outputRoot: root, projectId: 'named-project', prompt: '周成海独立人物参考图', assetName: '周.成海', fileName: 'Image1.jpg', index: 8 };
  const first = await generate({ ...options, jobId: 'named-1' });
  const second = await generate({ ...options, jobId: 'named-2' });
  assert.equal(first.files[0].fileName, '周.成海.png');
  assert.equal(second.files[0].fileName, '周.成海-v2.png');
  assert.equal(first.files[0].assetName, '周.成海');
  assert.equal(second.files[0].assetName, '周.成海');
  assert.deepEqual(await fs.readFile(first.files[0].localPath), PNG);
  const unsafe = await generate({ ...options, assetName: '../../办公室:夜景', jobId: 'named-safe' });
  assert.equal(path.dirname(unsafe.files[0].localPath), unsafe.outputDirectory);
  assert.equal(unsafe.files[0].fileName, '.._.._办公室_夜景.png');
  assert.equal(unsafe.files[0].assetName, '../../办公室:夜景');
  assert.deepEqual(await fs.readFile(sourcePath), PNG);
});

test('missing native file and policy mismatch fail with no saved image', async t => {
  const root = await temporaryDirectory(t);
  for (const invalidPolicy of [false, true]) {
    const client = fakeClient({ thread: invalidPolicy ? { sandbox: { type: 'dangerFullAccess' } } : {}, onTurn(instance) { emitImage(instance, path.join(root, 'missing.png')); emitComplete(instance); } });
    const generate = createGenerateAndSave({ resolveCli: async () => 'codex.exe', createClient: () => client });
    await assert.rejects(generate({ outputRoot: root, prompt: 'A tree', jobId: `invalid-${invalidPolicy}` }), { code: invalidPolicy ? 'CODEX_POLICY_MISMATCH' : 'CODEX_NO_IMAGE_FILE' });
    if (invalidPolicy) assert.equal(client.calls.some(call => call[0] === 'turn/start'), false);
    assert.equal(client.closed, true);
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test('cancel affects the selected job; cancelAll closes remaining jobs', async t => {
  const root = await temporaryDirectory(t);
  const clients = [];
  const generate = createGenerateAndSave({ resolveCli: async () => 'codex.exe', createClient: () => { const client = fakeClient(); clients.push(client); return client; } });
  const first = generate({ outputRoot: root, prompt: 'First', jobId: 'cancel-one' });
  const second = generate({ outputRoot: root, prompt: 'Second', jobId: 'cancel-two' });
  const firstRejected = assert.rejects(first, { code: 'CODEX_CANCELLED' });
  const secondRejected = assert.rejects(second, { code: 'CODEX_CANCELLED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancel('cancel-one'), true);
  await firstRejected;
  assert.equal(clients[0].closed, true);
  assert.equal(clients[1].closed, undefined);
  cancelAll();
  await secondRejected;
  assert.equal(clients[1].closed, true);
  assert.equal(cancel('cancel-one'), false);
});

test('generation timeout and child disconnect reject and clean up listeners', async t => {
  const root = await temporaryDirectory(t);
  for (const disconnected of [false, true]) {
    const client = fakeClient();
    const generate = createGenerateAndSave({ resolveCli: async () => 'codex.exe', createClient: () => client, timeoutMs: 20 });
    const promise = generate({ outputRoot: root, prompt: 'A tree', jobId: `end-${disconnected}` });
    const rejected = assert.rejects(promise, { code: disconnected ? 'CODEX_DISCONNECTED' : 'CODEX_TIMEOUT' });
    if (disconnected) {
      await new Promise(resolve => setImmediate(resolve));
      client.fail(Object.assign(new Error('Disconnected'), { code: 'CODEX_DISCONNECTED' }));
    }
    await rejected;
    assert.equal(client.closed, true);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.listenerCount('failure'), 0);
  }
});

test('the selected asset Skill is included in the actual subscription image request and recorded by digest', async t => {
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'native.png');
  await fs.writeFile(source, PNG);
  const client = fakeClient({ onTurn(client) { queueMicrotask(() => { emitImage(client, source); emitComplete(client); }); } });
  const generate = createGenerateAndSave({ resolveCli: async () => 'codex.exe', createClient: () => client });
  const assetSkill = { name: '美术规范.md', content: '生成水彩单人人物参考图，留白背景。' };
  const result = await generate({ outputRoot: root, projectId: 'p', prompt: '角色：阿青，蓝色长衣。', assetSkill, jobId: 'with-asset-skill' });
  const text = client.calls.find(([method]) => method === 'turn/start')[1].input[0].text;
  assert.ok(text.includes(assetSkill.content));
  assert.ok(text.includes(assetSkill.name));
  assert.ok(text.includes('角色：阿青，蓝色长衣。'));
  assert.ok(text.includes('不得索取或暴露密钥'));
  assert.deepEqual(result.files[0].generationSkill, { name: assetSkill.name, sha256: normalizeSkillDocument(assetSkill).sha256 });
  assert.equal(JSON.stringify(result).includes(assetSkill.content), false, 'Persist provenance without duplicating the full document in each image');
});

test('an invalid asset Skill cannot start an image generation job', async t => {
  const root = await temporaryDirectory(t);
  let launched = false;
  const generate = createGenerateAndSave({ resolveCli: async () => { launched = true; return 'codex.exe'; } });
  await assert.rejects(generate({ outputRoot: root, prompt: '角色', assetSkill: { name: 'bad.txt', content: '' } }), /Skill/);
  assert.equal(launched, false);
});
