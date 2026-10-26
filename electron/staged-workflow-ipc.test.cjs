'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { normalizeStageSkills } = require('./stage-skills.cjs');

const outline = () => ({ title: '分镜大纲', rows: [{ no: '01', duration: 8, scene: '书房', content: '阿宁看向信纸，近景观察神情。' }] });
const confirmed = () => ({ storyboard: { shots: [{ no: '01', duration: 8, scene: '书房', outline: '看信', prompt: '@阿宁 在@书房 看信。' }] }, assets: { characters: [{ name: '阿宁' }], scenes: [{ name: '书房' }] } });
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const begin = source.indexOf("ipcMain.handle('deepseek:generate-workflow'");
  const end = source.indexOf("ipcMain.handle('deepseek:cancel-workflow'", begin);
  let handler;
  let serial = 0;
  const calls = { contexts: [], providers: [], sessions: [], closed: [], requests: [] };
  vm.runInNewContext(source.slice(begin, end), {
    __dirname, path, pathToFileURL, structuredClone,
    randomUUID: () => `generated-${++serial}`, MODEL: 'deepseek-flash', workflowOwners: new Map(),
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    readStoredKey: () => 'offline-test-key', readSeedanceSettings: () => ({ ratio: '16:9' }),
    readCodexImageSettings: () => ({ cliPath: 'C:/offline-codex.exe' }),
    createCodexTextSession: async options => {
      calls.sessions.push(options);
      return { model: options.model || 'fixture-gpt', reasoningEffort: options.reasoningEffort || 'medium',
        request: async (messages, options) => { calls.requests.push({ provider: 'codex-subscription', messages, options }); return { data: {} }; },
        close: () => calls.closed.push(true),
      };
    },
    callDeepSeek: async (_key, messages, _maxTokens, onProgress) => { calls.requests.push({ provider: 'deepseek', messages, onProgress }); return { data: {} }; },
    normalizeStageSkills,
    createWorkflowRunner: configuration => async (script, context) => {
      calls.providers.push(configuration.provider);
      calls.contexts.push(context);
      await configuration.request([{ role: 'user', content: script }], { phase: 'candidate', onProgress() {} });
      return { stage: context.stage, data: {}, progress: { phase: 'completed', status: 'completed' } };
    },
  });
  const frame = { url: pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href, send() {} };
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const event = { senderFrame: frame, sender };
  return { handler, calls, event, frame, run: options => handler(event, '阿宁在书房里看信。', options) };
}

test('preload forwards the selected step and confirmed inputs while retaining the explicit IPC whitelist', async () => {
  let bridge;
  const calls = [];
  const renderer = new EventEmitter();
  renderer.invoke = async (...args) => { calls.push(args); };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } }, ipcRenderer: renderer }),
  });
  for (const stage of ['outline', 'storyboard', 'assets']) {
    const options = { stage, confirmedOutline: outline(), confirmedStoryboard: confirmed(), provider: 'codex-subscription', model: 'chosen-gpt', reasoningEffort: 'high', autoRunToVideo: false, apiKey: 'must-not-forward', arbitrary: true };
    await bridge.generateWorkflow('原文', options);
    assert.deepEqual(plain(calls.at(-1)), ['deepseek:generate-workflow', '原文', {
      stage, confirmedOutline: options.confirmedOutline, confirmedStoryboard: options.confirmedStoryboard,
      provider: 'codex-subscription', model: 'chosen-gpt', reasoningEffort: 'high', autoRunToVideo: false,
    }]);
  }
});

for (const provider of ['deepseek', 'codex-subscription']) {
  test(`${provider} preserves explicit generation stages and clones confirmed inputs through the real IPC handler`, async () => {
    for (const stage of ['outline', 'storyboard', 'assets']) {
      const h = harness();
      const options = { provider, stage, model: provider === 'deepseek' ? 'deepseek-flash' : 'chosen-gpt', reasoningEffort: 'high', confirmedOutline: outline(), confirmedStoryboard: confirmed(),
        stageSkills: { storyboard: { name: '导演.md', content: '保持确认大纲的顺序。' }, assets: { name: '美术.md', content: '水彩风格。' } } };
      const result = await h.run(options);
      const received = h.calls.contexts[0];
      assert.equal(result.stage, stage);
      assert.equal(received.stage, stage);
      assert.deepEqual(plain(received.confirmedOutline), options.confirmedOutline);
      assert.deepEqual(plain(received.confirmedStoryboard), options.confirmedStoryboard);
      assert.notEqual(received.confirmedOutline, options.confirmedOutline);
      assert.notEqual(received.confirmedStoryboard, options.confirmedStoryboard);
      assert.equal(received.stageSkills.storyboard.content, options.stageSkills.storyboard.content);
      assert.equal(received.stageSkills.assets.content, options.stageSkills.assets.content);
      assert.equal(received.ratio, '16:9');
      assert.equal(Object.hasOwn(received, 'videoReady'), false);
      received.confirmedOutline.rows[0].content = '独立副本';
      received.confirmedStoryboard.assets.characters[0].name = '独立副本';
      assert.equal(options.confirmedOutline.rows[0].content, '阿宁看向信纸，近景观察神情。');
      assert.equal(options.confirmedStoryboard.assets.characters[0].name, '阿宁');
      assert.deepEqual(h.calls.providers, [provider]);
      assert.equal(h.calls.requests.length, 1);
      assert.equal(h.calls.requests[0].provider, provider);
      assert.equal(h.calls.sessions.length, provider === 'codex-subscription' ? 1 : 0);
      if (provider === 'codex-subscription') {
        assert.equal(h.calls.sessions[0].model, 'chosen-gpt');
        assert.equal(h.calls.sessions[0].reasoningEffort, 'high');
        assert.equal(h.calls.closed.length, 1);
      }
    }
  });
}

test('automatic mode remains independent of the explicit generation stage and omitted stages retain legacy routing', async () => {
  for (const stage of ['outline', 'storyboard', 'assets', undefined]) {
    const h = harness();
    await h.run({ stage, autoRunToVideo: true });
    assert.equal(h.calls.contexts[0].videoReady, true);
    assert.equal(Object.hasOwn(h.calls.contexts[0], 'stage'), stage !== undefined);
  }
});

test('invalid steps and malformed confirmations fail before contacting either provider', async () => {
  const cases = [
    ...['analysis', 'video', '', null, 1, [], {}].map(stage => ({ stage })),
    ...['confirmedOutline', 'confirmedStoryboard'].flatMap(key => [null, [], '未确认', true, 5].map(value => ({ stage: 'storyboard', [key]: value }))),
  ];
  for (const invalid of cases) {
    const h = harness();
    await assert.rejects(h.run({ provider: 'codex-subscription', ...invalid }), /步骤无效|上一步结果无效/);
    assert.equal(h.calls.contexts.length, 0);
    assert.equal(h.calls.sessions.length, 0);
    assert.equal(h.calls.requests.length, 0);
  }
});

test('explicit stages retain the local-main-frame security boundary', async () => {
  const h = harness();
  h.frame.url = 'https://example.invalid/';
  await assert.rejects(h.run({ stage: 'outline' }), /主窗口/);
  assert.equal(h.calls.contexts.length, 0);
});
