const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { normalizeSkillDocument, normalizeStageSkills } = require('./stage-skills.cjs');

test('preload exposes payload-only progress, exact unsubscribe and bounded run metadata', async () => {
  let bridge;
  const renderer = new EventEmitter();
  const calls = [];
  renderer.invoke = async (...args) => { calls.push(args); };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } }, ipcRenderer: renderer }),
  });
  const received = [];
  const off = bridge.onWorkflowProgress((...args) => received.push(args));
  const payload = { runId: 'run-1', projectId: 'project-1', phase: 'audit' };
  renderer.emit('deepseek:workflow-progress', { privateEvent: true }, payload);
  assert.equal(received.length, 1);
  assert.equal(received[0].length, 1);
  assert.equal(received[0][0], payload);
  off(); off(); renderer.emit('deepseek:workflow-progress', {}, payload);
  assert.equal(received.length, 1);
  await bridge.generateWorkflow('原始输入', { runId: 'run-1', projectId: 'project-1', provider: 'codex-subscription', model: 'catalog-model', reasoningEffort: 'low', apiKey: 'must-not-pass' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['deepseek:generate-workflow', '原始输入', { runId: 'run-1', projectId: 'project-1', provider: 'codex-subscription', model: 'catalog-model', reasoningEffort: 'low' }]);
  const stageSkills = { storyboard: { name: '分镜.md', content: '根据场景节拍安排时长。' }, assets: { name: '素材.txt', content: '使用水彩画风。' } };
  await bridge.generateWorkflow('原文', { stageSkills, apiKey: 'not-allowed' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), ['deepseek:generate-workflow', '原文', { stageSkills }]);
  await bridge.importSkillDocument({ stage: 'assets', path: 'C:/unselected.txt' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), ['skills:import-document', { stage: 'assets' }]);
  for (const autoRunToVideo of [true, false]) {
    await bridge.generateWorkflow('自动模式原文', { runId: 'auto-run', autoRunToVideo, videoReady: 'must-not-pass-directly' });
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['deepseek:generate-workflow', '自动模式原文', { runId: 'auto-run', autoRunToVideo }]);
  }
});

function mainHandler() {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const begin = source.indexOf("ipcMain.handle('deepseek:generate-workflow'");
  const end = source.indexOf("ipcMain.handle('seedream:get-status'", begin);
  let handler;
  const hooks = {};
  vm.runInNewContext(source.slice(begin, end), {
    __dirname, path, pathToFileURL, randomUUID: () => 'generated-id', MODEL: 'deepseek-flash', workflowOwners: new Map(),
    ipcMain: { handle: (name, callback) => { if (name === 'deepseek:generate-workflow') handler = callback; } },
    readStoredKey: () => 'offline-test-key', readSeedanceSettings: () => ({ ratio: '9:16' }),
    callDeepSeek: async () => ({}),
    normalizeStageSkills,
    createWorkflowRunner: options => async (script, context) => {
      hooks.context = context;
      hooks.publish = options.onProgress;
      options.onProgress({ phase: 'candidate', requests: [], sequence: 1 });
      return { data: {}, progress: { phase: 'completed', sequence: 2 } };
    },
  });
  const sent = [];
  const frame = { url: pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href, send: (...args) => sent.push(args) };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  return { handler, hooks, sent, frame, sender, event: { senderFrame: frame, sender } };
}

test('progress goes only to the initiating local main frame and retains run/project identities', async () => {
  const { handler, hooks, sent, frame, event } = mainHandler();
  const result = await handler(event, '原文', { runId: 'run-1', projectId: 'project-1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'deepseek:workflow-progress');
  assert.equal(sent[0][1].runId, 'run-1');
  assert.equal(sent[0][1].projectId, 'project-1');
  assert.equal(result.progress.runId, 'run-1');
  frame.url = 'https://example.invalid';
  hooks.publish({ phase: 'audit' });
  assert.equal(sent.length, 1);
});

test('remote pages, subframes and oversized run ids cannot start a workflow', async () => {
  const { handler, frame, sender, event } = mainHandler();
  await assert.rejects(handler({ senderFrame: { ...frame }, sender }, '原文'), /主窗口/);
  await assert.rejects(handler(event, '原文', { runId: 'x'.repeat(129) }), /标识无效/);
  frame.url = 'https://example.invalid';
  await assert.rejects(handler(event, '原文'), /主窗口/);
});

test('stage Skill documents reach the real workflow options, with untrusted metadata stripped', async () => {
  const { handler, hooks, event } = mainHandler();
  await handler(event, '原文', { stageSkills: { storyboard: { name: '导演.md', content: '按动作自然分镜。', path: 'C:/private', sha256: 'forged' }, assets: { name: '美术.md', content: '水彩画风。' } } });
  assert.equal(hooks.context.ratio, '9:16');
  assert.equal(hooks.context.stageSkills.storyboard.content, '按动作自然分镜。');
  assert.equal(hooks.context.stageSkills.assets.content, '水彩画风。');
  assert.equal(hooks.context.stageSkills.storyboard.path, undefined);
  assert.match(hooks.context.stageSkills.storyboard.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(handler(event, '原文', { stageSkills: { storyboard: { name: '空.txt', content: '' } } }), /Skill/);
});

test('only the boolean automatic-run flag enables videoReady; false/default omit it and malformed flags fail before generation', async () => {
  for (const run of [{ autoRunToVideo: true }, { autoRunToVideo: false }, {}, { autoRunToVideo: undefined }]) {
    const { handler, hooks, event } = mainHandler();
    await handler(event, '原文', run);
    assert.equal(Object.hasOwn(hooks.context, 'videoReady'), run.autoRunToVideo === true);
    if (run.autoRunToVideo === true) assert.equal(hooks.context.videoReady, true);
    assert.equal(hooks.context.ratio, '9:16');
  }
  for (const autoRunToVideo of ['true', 'false', 1, 0, null, [], {}]) {
    const { handler, hooks, event, sent } = mainHandler();
    await assert.rejects(handler(event, '原文', { autoRunToVideo }), /自动生成开关无效/);
    assert.equal(hooks.context, undefined);
    assert.equal(sent.length, 0);
  }
});

function documentImportHandler({ canceled = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const begin = source.indexOf("ipcMain.handle('skills:import-document'");
  const end = source.indexOf("ipcMain.handle('deepseek:get-status'", begin);
  let handler;
  const calls = [];
  vm.runInNewContext(source.slice(begin, end), {
    __dirname, path, pathToFileURL, normalizeSkillDocument,
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    dialog: { showOpenDialog: async options => { calls.push({ options }); return { canceled, filePaths: canceled ? [] : ['C:/chosen.md'] }; } },
    importSkillDocument: async filePath => { calls.push({ filePath }); return { name: 'chosen.md', content: '用户上传的正式生成规范' }; },
  });
  const frame = { url: pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href };
  const sender = { mainFrame: frame };
  return { handler, calls, frame, sender, event: { senderFrame: frame, sender } };
}

test('Skill import reads only the native picker selection and supports cancellation', async () => {
  const { handler, calls, event } = documentImportHandler();
  const document = await handler(event, { stage: 'storyboard', path: 'C:/unselected.txt' });
  assert.equal(document.content, '用户上传的正式生成规范');
  assert.equal(calls[1].filePath, 'C:/chosen.md');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options.properties)), ['openFile']);
  const canceled = documentImportHandler({ canceled: true });
  assert.equal(await canceled.handler(canceled.event, { stage: 'assets' }), null);
  assert.equal(canceled.calls.length, 1);
});

test('Skill import rejects remote/subframe callers and invalid stages before showing a picker', async () => {
  const { handler, calls, event, frame, sender } = documentImportHandler();
  await assert.rejects(handler(event, { stage: 'video' }), /阶段/);
  await assert.rejects(handler({ senderFrame: { ...frame }, sender }, { stage: 'assets' }), /主窗口/);
  frame.url = 'https://example.invalid';
  await assert.rejects(handler(event, { stage: 'assets' }), /主窗口/);
  assert.equal(calls.length, 0);
});
