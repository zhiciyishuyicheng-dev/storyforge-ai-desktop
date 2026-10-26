'use strict';

// Exercise the real main-process routing and the real Skill/audit policy without
// starting Electron, a local Codex process, or a billable provider request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createWorkflowRunner } = require('./deepseek-workflow.cjs');

const localRequire = createRequire(__filename);
const MODEL = 'gpt-offline-fixture';
const SCRIPT = '阿宁在书房里看了一眼信纸。';
const SKILLS = {
  storyboard: { name: '导演要求.md', content: '只生成一个8秒镜头，采用水彩风，保留阿宁看信的动作。' },
  assets: { name: '美术要求.txt', content: '人物和书房参考图统一水彩风。' },
};

function candidate() {
  return {
    outline: { title: '分镜大纲' },
    assets: {
      characters: [{ name: '阿宁', fileName: '阿宁.png', prompt: '阿宁的水彩人物参考图。' }],
      scenes: [{ name: '书房', fileName: '书房.png', prompt: '书房的水彩场景参考图。' }],
      groups: [], props: [], characterChecklist: [{ name: '阿宁', requiresReferenceImage: true }], characterDifferenceMatrix: [{ name: '阿宁', faceCode: 'C01' }],
    },
    storyboard: {
      shots: [{ no: '01', title: '看信', duration: 8, scene: '书房', outline: '看信的悬念。阿宁在书房里看向信纸，镜头观察她的神情。', uploads: [{ ref: '@阿宁', asset: '阿宁' }, { ref: '@书房', asset: '书房' }],
        segments: [{ time: '0-8秒', visual: '阿宁在书房里看信纸。' }],
        prompt: '8秒，水彩风。人物：@阿宁 （外观参考）；场景：@书房 （空间参考）。[0-8秒] 阿宁看信纸。' }],
      blockers: [],
    },
  };
}

function audit({ passing = true } = {}) {
  return {
    verdict: passing ? 'pass' : 'revise',
    blocks: [{ no: '01', checks: [{ rule: '8秒单镜头与水彩风', status: passing ? '通过' : '失败',
      note: passing ? '本块共8秒，仅一个0至8秒时间片，正文明确采用水彩风并展示看信动作。' : '本块画面没有足够的水彩材质描写，需要补充。' }] }],
    batchChecks: [{ rule: '只生成一个镜头', status: '通过', note: '候选只有编号01的一个生成块，故事动作落在该块中。' }],
    issues: [], blockers: [], acceptedBlockNos: passing ? ['01'] : [],
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mainHarness({ key = '', responses = [candidate(), audit()], onRequest, onCreateSession } = {}) {
  const handlers = new Map();
  const calls = { sessions: [], requests: [], deepseek: [], status: [], closed: [], cancelled: [], runnerOptions: [], contexts: [] };
  const events = new Map();
  let serial = 0;
  const app = new EventEmitter();
  app.getPath = (name) => path.join(__dirname, '.offline-fixture', name);
  app.whenReady = () => ({ then() {} });
  const image = { getStatus: async () => { throw new Error('Text generation must not require image capability'); }, cancel() {}, cancelAll() {} };
  const text = {
    getStatus: async options => {
      calls.status.push(options);
      return { available: true, authenticated: true, models: [{ id: MODEL, model: MODEL, isDefault: true,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }] };
    },
    createSession: async options => {
      calls.sessions.push(options);
      const identity = calls.sessions.length;
      const session = {
        model: options.model || MODEL, reasoningEffort: options.reasoningEffort || 'medium',
        request: async (messages, requestOptions = {}) => {
          calls.requests.push({ messages: structuredClone(messages), options: requestOptions, session: identity });
          requestOptions.onProgress?.({ phase: 'generating', elapsedMs: 2, outputChars: 2, firstContentMs: 1 });
          if (onRequest) return onRequest({ messages, options: requestOptions, session, calls });
          const next = responses.shift();
          assert.notEqual(next, undefined, 'Unexpected extra GPT request');
          return { data: structuredClone(next), model: session.model, usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } };
        },
        close() { calls.closed.push(identity); },
      };
      if (onCreateSession) await onCreateSession({ options, session, calls });
      return session;
    },
    cancel: jobId => { calls.cancelled.push(jobId); return true; }, cancelAll() {},
  };
  const fakeFs = {
    ...fs,
    readFileSync(file, ...args) {
      if (path.basename(String(file)) === 'deepseek-settings.json' && key) return JSON.stringify({ encryptedKey: Buffer.from(key).toString('base64') });
      if (path.basename(String(file)) === 'codex-image-settings.json') return JSON.stringify({ cliPath: 'C:/offline-codex.exe' });
      throw Object.assign(new Error('No fixture settings file'), { code: 'ENOENT' });
    },
  };
  const context = vm.createContext({
    __dirname, Buffer, URL, process, console, setTimeout, clearTimeout, structuredClone,
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: {}, shell: {}, dialog: {},
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        safeStorage: { isEncryptionAvailable: () => true, decryptString: data => data.toString('utf8') } };
      if (name === 'fs') return fakeFs;
      if (name === './codex-image.cjs') return image;
      if (name === './codex-text.cjs') return text;
      if (name === './deepseek-client.cjs') return { createDeepSeekClient: () => async (...args) => { calls.deepseek.push(args); throw new Error('Unexpected DeepSeek call'); } };
      if (name === './deepseek-workflow.cjs') return { createWorkflowRunner(options) {
        calls.runnerOptions.push(options);
        const run = createWorkflowRunner(options);
        return (script, configuration) => { calls.contexts.push(configuration); return run(script, configuration); };
      } };
      return localRequire(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), context, { filename: 'main.cjs' });
  function event(senderId = 1) {
    if (events.has(senderId)) return events.get(senderId);
    const sent = [];
    const frame = { url: pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href, send: (...args) => sent.push(args) };
    const sender = { id: senderId, mainFrame: frame, isDestroyed: () => false };
    const value = { senderFrame: frame, sender, sent };
    events.set(senderId, value); return value;
  }
  const run = (metadata = {}, senderId = 1) => handlers.get('deepseek:generate-workflow')(event(senderId), SCRIPT,
    { runId: `run-${++serial}`, projectId: 'project-1', provider: 'codex-subscription', model: MODEL, reasoningEffort: 'low', stageSkills: SKILLS, ...metadata });
  const cancel = (metadata, senderId = 1) => handlers.get('deepseek:cancel-workflow')(event(senderId), metadata);
  return { handlers, calls, event, run, cancel, app };
}

test('GPT status uses the existing local Codex choice without an image-capability prerequisite', async () => {
  const h = mainHarness();
  const status = await h.handlers.get('codex-text:get-status')(h.event());
  assert.equal(status.authenticated, true);
  assert.equal(status.models[0].model, MODEL);
  assert.equal(h.calls.status[0].preferredPath, 'C:/offline-codex.exe');
  assert.equal(h.calls.sessions.length, 0);
  const remote = h.event(2); remote.senderFrame.url = 'https://example.invalid/';
  await assert.rejects(h.handlers.get('codex-text:get-status')(remote), /主窗口/);
});

test('GPT subscription runs outline/storyboards and independent Skill audit with no DeepSeek API key', async () => {
  const h = mainHarness();
  const result = await h.run({ runId: 'gpt-run', autoRunToVideo: true });
  assert.equal(h.calls.deepseek.length, 0);
  assert.equal(h.calls.sessions.length, 1);
  assert.equal(h.calls.sessions[0].model, MODEL);
  assert.equal(h.calls.sessions[0].reasoningEffort, 'low');
  assert.equal(h.calls.requests.length, 2);
  assert.deepEqual(h.calls.requests.map(call => call.options.phase), ['candidate', 'audit']);
  assert.equal(new Set(h.calls.requests.map(call => call.session)).size, 1);
  assert.equal(h.calls.contexts[0].videoReady, true);
  assert.equal(h.calls.contexts[0].stageSkills.storyboard.content, SKILLS.storyboard.content);
  assert.equal(h.calls.contexts[0].stageSkills.assets.content, SKILLS.assets.content);
  for (const call of h.calls.requests) {
    assert.ok(call.messages.some(message => message.content.includes(SKILLS.storyboard.content)));
    assert.ok(call.messages.some(message => message.content.includes(SKILLS.assets.content)));
    assert.equal(Object.hasOwn(call.options, 'maxTokens'), false);
  }
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '全部通过');
  assert.equal(Object.hasOwn(result.data, 'analysis'), false);
  assert.equal(result.data.outline.title, '分镜大纲');
  assert.equal(result.data.storyboard.shots[0].scene, '书房');
  assert.match(result.data.storyboard.shots[0].outline, /看信的悬念/u);
  assert.equal(result.data.storyboard.verification.builtinSkillApplied, false);
  assert.equal(result.data.storyboard.verification.stageSkills.storyboard.name, SKILLS.storyboard.name);
  assert.equal(result.model, MODEL);
  assert.equal(result.provider, 'codex-subscription');
  assert.equal(result.reasoningEffort, 'low');
  assert.deepEqual(result.data.storyboard.verification.generation, { provider: 'codex-subscription', model: MODEL, reasoningEffort: 'low' });
  assert.equal(result.progress.prompt.provider, 'codex-subscription');
  assert.equal(result.progress.prompt.model, MODEL);
  assert.equal(result.progress.prompt.reasoningEffort, 'low');
  assert.equal(result.progress.runId, 'gpt-run');
  assert.equal(result.progress.projectId, 'project-1');
  assert.ok(h.event().sent.every(([channel, progress]) => channel === 'deepseek:workflow-progress' && progress.runId === 'gpt-run' && progress.projectId === 'project-1'));
  assert.deepEqual(h.calls.closed, [1]);
});

test('GPT uses one session and chosen effort for one repair, then publishes the explicit ignored audit warning', async () => {
  const h = mainHarness({ responses: [candidate(), audit({ passing: false }), candidate(), audit({ passing: false })] });
  const result = await h.run({ reasoningEffort: 'high' });
  assert.equal(h.calls.sessions.length, 1);
  assert.equal(h.calls.sessions[0].reasoningEffort, 'high');
  assert.equal(result.data.storyboard.verification.generation.reasoningEffort, 'high');
  assert.deepEqual(h.calls.requests.map(call => call.options.phase), ['candidate', 'audit', 'repair', 'audit']);
  assert.equal(result.data.storyboard.verification.requestCount, 4);
  assert.equal(result.data.storyboard.verification.repairCount, 1);
  assert.equal(result.data.storyboard.verification.auditIgnored, true);
  assert.equal(result.data.storyboard.verification.auditPassed, false);
  assert.equal(result.data.storyboard.auditSummary.finalStatus, '审计未通过（已忽略）');
  assert.equal(result.progress.status, 'completed');
  assert.equal(h.calls.deepseek.length, 0);
  assert.deepEqual(h.calls.closed, [1]);
});

test('invalid providers, run identities, model/effort types and Skill documents fail before either provider starts', async () => {
  const h = mainHarness();
  const malformed = [
    { provider: 'unknown-provider' }, { provider: [] }, { runId: 'x'.repeat(129) },
    { projectId: 2 }, { model: {} }, { reasoningEffort: [] }, { model: 'x'.repeat(1000) },
    { reasoningEffort: 'x'.repeat(1000) }, { autoRunToVideo: 'true' },
    { stageSkills: { storyboard: { name: 'empty.md', content: '' } } },
  ];
  for (const metadata of malformed) await assert.rejects(h.run(metadata), /./);
  assert.equal(h.calls.sessions.length, 0);
  assert.equal(h.calls.deepseek.length, 0);
  const remote = h.event(8); remote.senderFrame.url = 'https://example.invalid/';
  await assert.rejects(h.handlers.get('deepseek:generate-workflow')(remote, SCRIPT, { provider: 'codex-subscription' }), /主窗口/);
});

test('a foreign window cannot cancel the owner’s GPT request; owner stop prevents any audit or publication', async () => {
  const pending = deferred(), entered = deferred();
  const h = mainHarness({ onRequest: async () => { entered.resolve(); return pending.promise; } });
  const running = h.run({ runId: 'owner-run' });
  await entered.promise;
  try { await h.cancel({ runId: 'owner-run', projectId: 'project-1' }, 2); } catch (error) { assert.match(error.message, /任务|窗口|权限|标识/); }
  assert.equal(h.calls.closed.length, 0);
  assert.equal(h.calls.cancelled.length, 0);
  await h.cancel({ runId: 'owner-run', projectId: 'other-project' });
  assert.equal(h.calls.closed.length, 0, 'A wrong project identifier cannot stop a running request');
  await h.cancel({ runId: 'owner-run', projectId: 'project-1' });
  pending.resolve({ data: candidate(), model: MODEL });
  await assert.rejects(running, /停止|取消/);
  assert.equal(h.calls.requests.length, 1, 'Stopped candidate must not start a separate audit');
  assert.ok(h.calls.closed.length > 0);
});

test('duplicate owner run IDs cannot replace active work, and navigation discards the late candidate before audit', async () => {
  const pending = deferred(), entered = deferred();
  const h = mainHarness({ onRequest: async () => { entered.resolve(); return pending.promise; } });
  const running = h.run({ runId: 'held-run' });
  await entered.promise;
  await assert.rejects(h.run({ runId: 'held-run' }), /正在进行/);
  assert.equal(h.calls.sessions.length, 1);
  const published = h.event().sent.length;
  h.event().senderFrame.url = 'https://example.invalid/';
  pending.resolve({ data: candidate(), model: MODEL });
  await assert.rejects(running, /停止|取消/);
  assert.equal(h.calls.requests.length, 1);
  assert.equal(h.event().sent.length, published, 'No progress is forwarded after navigation');
  assert.ok(h.calls.closed.length > 0);
});

test('stopping while the GPT session is initializing closes it before any model request', async () => {
  const entered = deferred(), release = deferred();
  const h = mainHarness({ onCreateSession: async () => { entered.resolve(); await release.promise; } });
  const running = h.run({ runId: 'initializing' });
  await entered.promise;
  await h.cancel({ runId: 'initializing', projectId: 'project-1' });
  release.resolve();
  await assert.rejects(running, /停止|取消/);
  assert.equal(h.calls.requests.length, 0);
  assert.ok(h.calls.closed.length > 0);
});
