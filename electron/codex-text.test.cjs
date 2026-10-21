const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { _test, cancel, cancelAll } = require('./codex-text.cjs');
const { createTextClient, readTextStatus, waitForTextTurn, inspectTextPolicy, TEXT_CONFIG } = _test;

const MODELS = [
  { id: 'model-fast-id', model: 'catalog-fast', displayName: 'Catalog Fast', isDefault: true, hidden: false, inputModalities: ['text'], defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Lower' }, { reasoningEffort: 'medium', description: 'Medium' }, { reasoningEffort: 'ultra', description: 'Catalog-defined effort' }] },
  { id: 'model-long-id', model: 'catalog-long', displayName: 'Catalog Long', hidden: false, inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Higher' }] },
];
function textPolicy(patch = {}) {
  const features = {};
  for (const entry of TEXT_CONFIG) {
    const match = /^features\.([a-z0-9_]+)=(true|false)$/.exec(entry);
    if (match) features[match[1]] = match[2] === 'true';
  }
  return { features, web_search: 'disabled', tools: { view_image: false }, mcp_servers: {}, ...patch };
}
function fakeClient({ accountType = 'chatgpt', models = MODELS, config = textPolicy(), onTurn, onRequest, threadPatch } = {}) {
  const client = new EventEmitter();
  client.calls = [];
  client.threadCounter = 0;
  client.initialize = async () => { client.calls.push(['initialize']); };
  client.request = async (method, params) => {
    client.calls.push([method, params]);
    const override = await onRequest?.(method, params, client);
    if (override !== undefined) return override;
    if (method === 'config/read') return { config };
    if (method === 'account/read') return { account: { type: accountType, email: 'private@example.invalid', planType: 'pro', token: 'not-exposed' } };
    if (method === 'model/list') return { data: models, nextCursor: null };
    if (method === 'thread/start') return { thread: { id: `thread-${++client.threadCounter}` }, model: params.model, modelProvider: 'openai', sandbox: { type: 'readOnly' }, approvalPolicy: 'never', reasoningEffort: params.config.model_reasoning_effort, ...threadPatch };
    if (method === 'turn/start') {
      if (onTurn) await onTurn(client, params);
      return { turn: { id: `${params.threadId}-turn`, status: 'inProgress' } };
    }
    throw new Error(`Unexpected method ${method}`);
  };
  client.close = () => { client.closed = true; };
  client.fail = error => { client.close(); client.emit('failure', error); };
  return client;
}
function emitResult(client, threadId = 'thread-1', text = '{"ok":true}', patch = {}) {
  client.emit('notification', 'item/completed', { threadId, turnId: `${threadId}-turn`, item: { id: `${threadId}-message`, type: 'agentMessage', phase: 'final_answer', text, ...patch } });
}
function emitComplete(client, threadId = 'thread-1', patch = {}) {
  client.emit('notification', 'turn/completed', { threadId, turn: { id: `${threadId}-turn`, status: 'completed', error: null, ...patch } });
}
function clientAPI(client, options = {}) { return createTextClient({ resolveCli: async () => 'official-codex.exe', createClient: () => client, ...options }); }

test('status lists only advertised visible text models and reasoning efforts without image capability or account identity', async () => {
  const client = fakeClient({ models: [...MODELS, { ...MODELS[0], model: 'hidden', hidden: true }, { ...MODELS[0], model: 'audio-only', inputModalities: ['audio'] }] });
  const status = await clientAPI(client).getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.models.length, 2);
  assert.deepEqual(status.models[0].supportedReasoningEfforts.map(item => item.reasoningEffort), ['low', 'medium', 'ultra']);
  assert.deepEqual(client.calls.map(call => call[0]), ['initialize', 'config/read', 'account/read', 'model/list']);
  assert.ok(!JSON.stringify(status).includes('private@example'));
  assert.ok(!JSON.stringify(status).includes('not-exposed'));
  assert.equal(client.closed, true);
});

test('API-key login is rejected before model discovery or inference', async () => {
  const client = fakeClient({ accountType: 'apiKey' });
  const status = await clientAPI(client).getStatus();
  assert.equal(status.configured, false);
  assert.match(status.error, /ChatGPT/);
  assert.ok(!client.calls.some(call => ['model/list', 'thread/start', 'turn/start'].includes(call[0])));
});

test('inherited MCP servers get explicit process-local disables and the effective configuration is rechecked', async () => {
  const clients = [];
  const options = [];
  const api = createTextClient({ resolveCli: async () => 'codex.exe', createClient(cli, option) {
    options.push(option);
    const client = fakeClient({ config: textPolicy({ mcp_servers: { existing_server: { enabled: clients.length > 0 ? false : true, command: 'do-not-execute' } } }) });
    clients.push(client);
    return client;
  } });
  const result = await api.getStatus();
  assert.equal(result.configured, true);
  assert.equal(clients.length, 2);
  assert.deepEqual(options[1].extraConfig, ['mcp_servers.existing_server.enabled=false']);
  assert.ok(clients.every(client => client.closed));
  assert.ok(!clients[0].calls.some(call => call[0] === 'account/read'));
});

test('managed tool-policy mismatch and unclosed inherited MCPs stop before inference', async () => {
  for (const config of [textPolicy({ web_search: 'live' }), textPolicy({ features: { shell_tool: true } }), textPolicy({ mcp_servers: { remains_enabled: {} } }), textPolicy({ mcp_servers: { 'unsupported.name': {} } })]) {
    const clients = [];
    const api = createTextClient({ resolveCli: async () => 'codex.exe', createClient() { const client = fakeClient({ config }); clients.push(client); return client; } });
    await assert.rejects(api.createSession(), { code: 'CODEX_TEXT_POLICY_MISMATCH' });
    assert.ok(clients.every(client => client.closed));
    assert.ok(clients.every(client => !client.calls.some(call => call[0] === 'thread/start')));
  }
});

test('selected model and advertised effort are frozen across independent candidate, audit, and repair threads', async () => {
  const client = fakeClient({ onTurn(instance, params) { emitResult(instance, params.threadId); emitComplete(instance, params.threadId); } });
  const session = await clientAPI(client).createSession({ model: 'model-fast-id', reasoningEffort: 'ultra', jobId: 'independent-text' });
  try {
    assert.equal(session.model, 'catalog-fast');
    assert.equal(session.reasoningEffort, 'ultra');
    for (const phase of ['candidate', 'audit', 'repair']) {
      const result = await session.request([{ role: 'system', content: `Specification ${phase}` }, { role: 'user', content: 'Story input' }], { phase });
      assert.deepEqual(result.data, { ok: true });
      assert.equal(result.model, 'catalog-fast');
      assert.equal(result.truncated, false);
    }
    const threads = client.calls.filter(call => call[0] === 'thread/start').map(call => call[1]);
    assert.equal(threads.length, 3);
    assert.ok(threads.every(params => params.ephemeral && params.sandbox === 'read-only' && params.approvalPolicy === 'never' && params.model === 'catalog-fast'));
    assert.deepEqual(threads.map(params => params.developerInstructions), ['Specification candidate', 'Specification audit', 'Specification repair']);
    const turns = client.calls.filter(call => call[0] === 'turn/start').map(call => call[1]);
    assert.equal(new Set(turns.map(params => params.threadId)).size, 3);
    assert.ok(turns.every(params => params.effort === 'ultra' && params.model === 'catalog-fast' && !Object.hasOwn(params, 'max_tokens')));
  } finally { session.close(); }
  assert.equal(client.closed, true);
});

test('unknown model and unsupported effort never silently downgrade or submit inference', async () => {
  for (const selection of [{ model: 'made-up-model' }, { model: 'catalog-long', reasoningEffort: 'low' }]) {
    const client = fakeClient();
    await assert.rejects(clientAPI(client).createSession(selection), { code: selection.model === 'made-up-model' ? 'CODEX_TEXT_INVALID_MODEL' : 'CODEX_TEXT_INVALID_EFFORT' });
    assert.ok(!client.calls.some(call => call[0] === 'thread/start'));
    assert.equal(client.closed, true);
  }
});

test('effective thread model or reasoning mismatch prevents the turn', async () => {
  for (const threadPatch of [{ model: 'silent-fallback' }, { reasoningEffort: 'low' }, { modelProvider: 'api-provider' }, { approvalPolicy: 'on-request' }]) {
    const client = fakeClient({ threadPatch });
    const session = await clientAPI(client).createSession();
    try { await assert.rejects(session.request([{ role: 'user', content: 'Story' }]), { code: 'CODEX_TEXT_POLICY_MISMATCH' }); }
    finally { session.close(); }
    assert.ok(!client.calls.some(call => call[0] === 'turn/start'));
  }
});

test('final JSON is delivered only after the matching completed turn; stream progress retains counts and no thoughts', async () => {
  const updates = [];
  let task;
  let time = 1000;
  const client = fakeClient({ onTurn(instance, params) {
    const common = { threadId: params.threadId, turnId: `${params.threadId}-turn` };
    instance.emit('notification', 'item/reasoning/textDelta', { ...common, delta: 'PRIVATE_THOUGHT_TEXT' });
    instance.emit('notification', 'item/agentMessage/delta', { ...common, itemId: 'm', delta: '{"ok":' });
    instance.emit('notification', 'thread/tokenUsage/updated', { ...common, tokenUsage: { last: { inputTokens: 40, outputTokens: 15, totalTokens: 55, reasoningOutputTokens: 10 } } });
    emitResult(instance, params.threadId);
    task = { threadId: params.threadId };
  } });
  const session = await clientAPI(client, { now: () => time++ }).createSession();
  let resolved = false;
  const pending = session.request([{ role: 'user', content: 'Story' }], { onProgress: event => { updates.push(event); } }).then(result => { resolved = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  emitComplete(client, 'wrong-thread');
  assert.equal(resolved, false);
  emitComplete(client, task.threadId);
  const result = await pending;
  assert.equal(result.timing.reasoningChars, 'PRIVATE_THOUGHT_TEXT'.length);
  assert.equal(result.timing.outputChars, '{"ok":true}'.length);
  assert.deepEqual(result.usage, { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 });
  assert.ok(!JSON.stringify(updates).includes('PRIVATE_THOUGHT_TEXT'));
  assert.ok(updates.some(event => event.phase === 'thinking'));
  assert.equal(client.listenerCount('notification'), 0);
  session.close();
});

test('failed, interrupted, commentary-only, and partial-only responses never become delivered output', async () => {
  for (const scenario of ['failed', 'interrupted', 'commentary', 'partial_answer', 'delta-only', 'two-final']) {
    const client = fakeClient({ onTurn(instance, params) {
      if (scenario === 'delta-only') instance.emit('notification', 'item/agentMessage/delta', { threadId: params.threadId, turnId: `${params.threadId}-turn`, delta: '{"partial":true}', itemId: 'm' });
      else emitResult(instance, params.threadId, '{"ok":true}', scenario === 'commentary' || scenario === 'partial_answer' ? { phase: scenario } : {});
      if (scenario === 'two-final') emitResult(instance, params.threadId, '{"extra":true}', { id: 'second-message' });
      emitComplete(instance, params.threadId, ['failed', 'interrupted'].includes(scenario) ? { status: scenario } : {});
    } });
    const session = await clientAPI(client).createSession();
    try { await assert.rejects(session.request([{ role: 'user', content: 'Story' }])); }
    finally { session.close(); }
  }
});

test('legacy phase-unknown final is supported, malformed JSON passes to existing repair validation without pretending it parsed', async () => {
  const client = fakeClient({ onTurn(instance, params) { emitResult(instance, params.threadId, '```json\n{"ok":true}\n```', { phase: null }); emitComplete(instance, params.threadId); } });
  const session = await clientAPI(client).createSession();
  const result = await session.request([{ role: 'user', content: 'Story' }]);
  assert.equal(result.data, null);
  assert.match(result.rawContent, /^```json/);
  assert.equal(result.truncated, false);
  session.close();
});

test('usage limits report a safe subscription error without server text or paid fallback', async () => {
  const client = fakeClient({ onTurn(instance, params) { emitComplete(instance, params.threadId, { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded', message: 'PRIVATE_SERVER_DETAILS' } }); } });
  const session = await clientAPI(client).createSession();
  try { await assert.rejects(session.request([{ role: 'user', content: 'Story' }]), error => error.code === 'CODEX_TEXT_USAGE_LIMIT' && !error.message.includes('PRIVATE_SERVER_DETAILS')); }
  finally { session.close(); }
});

test('unexpected tool events stop the private server and cannot turn tool output into a result', async () => {
  const client = fakeClient({ onTurn(instance, params) {
    instance.emit('notification', 'item/started', { threadId: params.threadId, turnId: `${params.threadId}-turn`, item: { type: 'commandExecution', id: 'command', command: 'PRIVATE_COMMAND' } });
    emitResult(instance, params.threadId); emitComplete(instance, params.threadId);
  } });
  const session = await clientAPI(client).createSession();
  try { await assert.rejects(session.request([{ role: 'user', content: 'Story' }]), { code: 'CODEX_TEXT_TOOL_BLOCKED' }); }
  finally { session.close(); }
  assert.equal(client.closed, true);
});

test('default GPT turns remain pending beyond 15 minutes until a matching completed turn arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const client = fakeClient();
  const session = await clientAPI(client).createSession({ jobId: 'text-no-deadline' });
  let outcome;
  const finished = session.request([{ role: 'user', content: 'Story' }]).then(
    result => { outcome = { result }; },
    error => { outcome = { error }; },
  );
  try {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outcome, undefined);
    assert.notEqual(client.closed, true);
    assert.equal(client.listenerCount('notification'), 1);
    emitResult(client);
    emitComplete(client);
    await finished;
    assert.deepEqual(outcome.result.data, { ok: true });
    assert.equal(outcome.result.timing.elapsedMs, 24 * 60 * 60 * 1000);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.listenerCount('failure'), 0);
  } finally {
    session.close();
    await finished;
  }
});

test('injected test timeout, cancellation, closure, and disconnect reject pending work and remove event listeners', async () => {
  for (const action of ['timeout', 'cancel', 'close', 'disconnect']) {
    const client = fakeClient();
    const jobId = `text-${action}`;
    const session = await clientAPI(client, action === 'timeout' ? { timeoutMs: 10 } : {}).createSession({ jobId });
    const pending = session.request([{ role: 'user', content: 'Story' }]);
    await new Promise(resolve => setImmediate(resolve));
    if (action === 'cancel') assert.equal(cancel(jobId), true);
    if (action === 'close') session.close();
    if (action === 'disconnect') client.fail(new Error('PRIVATE_CONNECTION_DETAILS'));
    await assert.rejects(pending, { code: action === 'timeout' ? 'CODEX_TEXT_TIMEOUT' : action === 'disconnect' ? 'CODEX_TEXT_CONNECTION' : 'CODEX_TEXT_CANCELLED' });
    assert.equal(client.closed, true);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.listenerCount('failure'), 0);
    session.close();
    assert.equal(cancel(jobId), false);
  }
  cancelAll();
});

test('cancellation during CLI discovery cannot launch a stale server', async () => {
  let completeDiscovery;
  let launched = 0;
  const api = createTextClient({ resolveCli: () => new Promise(resolve => { completeDiscovery = resolve; }), createClient() { launched += 1; return fakeClient(); } });
  const pending = api.createSession({ jobId: 'cancel-discovery' });
  assert.equal(cancel('cancel-discovery'), true);
  completeDiscovery('codex.exe');
  await assert.rejects(pending, { code: 'CODEX_TEXT_CANCELLED' });
  assert.equal(launched, 0);
});

test('catalog pagination and malformed catalog data fail safely without hardcoded fallback models', async () => {
  const client = fakeClient({ onRequest(method, params) {
    if (method !== 'model/list') return;
    return params.cursor ? { data: [MODELS[1]], nextCursor: null } : { data: [MODELS[0]], nextCursor: 'next-page' };
  } });
  const status = await readTextStatus(client);
  assert.equal(status.models.length, 2);
  assert.equal(client.calls.filter(call => call[0] === 'model/list')[1][1].cursor, 'next-page');
  assert.throws(() => inspectTextPolicy({}), { code: 'CODEX_TEXT_POLICY_MISMATCH' });
});
