const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeepSeekClient } = require('./deepseek-client.cjs');

const messages = [{ role: 'user', content: '只返回 JSON。' }];
const completion = (content = '{"ok":true}', finish = 'stop') => ({
  model: 'deepseek-flash', choices: [{ message: { content }, finish_reason: finish }],
});
const event = (delta, finish = null) => `data: ${JSON.stringify({
  model: 'deepseek-flash', choices: [{ delta, finish_reason: finish }],
})}\r\n\r\n`;
const finalUsage = { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 };
const usageEvent = (usage = finalUsage) => `data: ${JSON.stringify({ choices: [], usage })}\r\n\r\n`;

function jsonClient(payload = completion(), overrides = {}) {
  const calls = [];
  const client = createDeepSeekClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true, status: 200,
        headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
        text: async () => JSON.stringify(payload),
      };
    }, ...overrides,
  });
  return { client, calls };
}

// Pull based reads make timestamps independent of ReadableStream prefetch.
function streamClient(chunks, times = [], { headerAt = 5, readErrorAt = -1 } = {}) {
  let clock = 0;
  let index = 0;
  let cancelled = 0;
  let released = 0;
  const calls = [];
  const client = createDeepSeekClient({
    now: () => clock,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      clock = headerAt;
      return {
        ok: true, status: 200,
        headers: { get: (name) => ({ 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'request-test' })[name] },
        body: { getReader: () => ({
          read: async () => {
            if (index === readErrorAt) throw new Error('private source and key must never be exposed');
            clock = times[index] ?? clock + 10;
            if (index >= chunks.length) return { done: true };
            return { done: false, value: Buffer.from(chunks[index++]) };
          },
          cancel: () => { cancelled += 1; return Promise.resolve(); },
          releaseLock: () => { released += 1; },
        }) },
      };
    },
  });
  return { client, calls, cleanup: () => ({ cancelled, released }) };
}

test('workflow requests retain provider output budget and explicitly select high thinking', async () => {
  const { client, calls } = jsonClient();
  const result = await client('offline-test-key', messages, undefined, () => {});
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(Object.hasOwn(calls[0].body, 'max_tokens'), false);
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal(result.data.ok, true);
  assert.equal(result.truncated, false);
});

test('connection probe retains 64-token limit and disables thinking', async () => {
  const { client, calls } = jsonClient();
  const result = await client('offline-test-key', messages, 64);
  assert.equal(calls[0].body.max_tokens, 64);
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(calls[0].body, 'reasoning_effort'), false);
  assert.equal(result.data.ok, true);
});

test('SSE reports observed waiting, thinking and output windows without exposing thoughts', async () => {
  const privateThought = '私有推理文字';
  const chunks = [
    ': keepalive\r\n\r\n',
    event({ reasoning_content: privateThought }),
    event({ reasoning_content: '继续' }),
    event({ content: '{"ok":' }),
    event({ content: 'true}' }, 'stop'),
    usageEvent(), 'data: [DONE]\r\n\r\n',
  ];
  const { client, cleanup } = streamClient(chunks, [50, 100, 250, 450, 700, 720, 750]);
  const progress = [];
  const result = await client('offline-test-key', messages, undefined, (item) => progress.push(item));
  assert.deepEqual(result.data, { ok: true });
  assert.deepEqual(result.usage, finalUsage);
  assert.equal(result.timing.firstResponseMs, 5);
  assert.equal(result.timing.firstReasoningMs, 100);
  assert.equal(result.timing.firstContentMs, 450);
  assert.equal(result.timing.waitingMs, 100);
  assert.equal(result.timing.thinkingMs, 350);
  assert.equal(result.timing.outputMs, 300);
  assert.equal(result.timing.elapsedMs, 750);
  assert.equal(result.timing.reasoningChars, privateThought.length + 2);
  assert.equal(result.timing.outputChars, '{"ok":true}'.length);
  assert.equal(result.timing.streamed, true);
  assert.equal(result.timing.requestId, 'request-test');
  assert.deepEqual(progress.map((item) => item.phase), ['waiting', 'waiting', 'thinking', 'generating', 'generating', 'completed']);
  assert.equal(JSON.stringify(progress).includes(privateThought), false);
  assert.equal(JSON.stringify(progress).includes('{"ok"'), false);
  assert.deepEqual(cleanup(), { cancelled: 1, released: 1 });
});

test('SSE accepts split UTF-8, split CRLF, comments and multiline data fields', async () => {
  const text = ': heartbeat\r\n\r\ndata: {"choices": [\r\ndata: {"delta":{"content":"{\\"字\\":\\"蓝杯\\"}"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = Buffer.from(text);
  const { client } = streamClient(Array.from(bytes, (byte) => Buffer.from([byte])));
  const result = await client('offline-test-key', messages, undefined, () => {});
  assert.deepEqual(result.data, { 字: '蓝杯' });
  assert.equal(result.timing.thinkingMs, null);
  assert.equal(result.timing.reasoningChars, 0);
});

test('server truncation remains distinguishable from a broken stream', async () => {
  const { client } = streamClient([event({ content: '{"storyboard":' }, 'length'), 'data: [DONE]\n\n']);
  const result = await client('offline-test-key', messages, undefined, () => {});
  assert.equal(result.truncated, true);
  assert.equal(result.data, null);
  assert.equal(result.rawContent, '{"storyboard":');
});

test('stream EOF without DONE or a valid finish reason cannot be delivered', async (t) => {
  const cases = [
    ['missing DONE', [event({ content: '{"ok":true}' }, 'stop')]],
    ['missing finish', [event({ content: '{"ok":true}' }), 'data: [DONE]\n\n']],
    ['filtered', [event({ content: '{"ok":true}' }, 'content_filter'), 'data: [DONE]\n\n']],
  ];
  for (const [label, chunks] of cases) {
    await t.test(label, async () => {
      const { client, cleanup } = streamClient(chunks);
      const progress = [];
      await assert.rejects(client('offline-test-key', messages, undefined, (item) => progress.push(item)), { code: 'DEEPSEEK_STREAM_INCOMPLETE' });
      assert.equal(progress.at(-1).phase, 'failed');
      assert.equal(progress.at(-1).lastPhase, 'generating');
      assert.equal(progress.some((item) => item.phase === 'completed'), false);
      assert.deepEqual(cleanup(), { cancelled: 1, released: 1 });
    });
  }
});

test('malformed stream events and interrupted reads fail safely', async () => {
  for (const chunks of [
    ['data: definitely-not-json\n\n'],
    ['data: {"error":{"message":"offline-test-key private source"}}\n\n'],
    ['data: {"choices":[{"delta":{"content":42},"finish_reason":"stop"}]}\n\n'],
  ]) {
    const { client } = streamClient(chunks);
    await assert.rejects(client('offline-test-key', messages, undefined, () => {}), (error) => {
      assert.equal(error.code, 'DEEPSEEK_STREAM_INVALID');
      assert.equal(error.message.includes('offline-test-key'), false);
      return true;
    });
  }
  const { client } = streamClient([], [], { readErrorAt: 0 });
  await assert.rejects(client('offline-test-key', messages, undefined, () => {}), (error) => {
    assert.equal(error.code, 'DEEPSEEK_CONNECTION');
    assert.equal(error.message.includes('private source'), false);
    return true;
  });
});

test('nonstream fallback does not invent reasoning or output timing', async () => {
  const progress = [];
  let clock = 0;
  const payload = completion();
  payload.choices[0].message.reasoning_content = 'never forward this';
  payload.usage = finalUsage;
  const { client } = jsonClient(payload, {
    now: () => clock,
    fetchImpl: async () => {
      clock = 30;
      return {
        ok: true, status: 200,
        text: async () => { clock = 100; return JSON.stringify(payload); },
      };
    },
  });
  const result = await client('offline-test-key', messages, undefined, (item) => progress.push(item));
  assert.equal(result.timing.streamed, false);
  assert.equal(result.timing.elapsedMs, 100);
  assert.equal(result.timing.firstResponseMs, 30);
  assert.equal(result.timing.firstReasoningMs, null);
  assert.equal(result.timing.firstContentMs, null);
  assert.equal(result.timing.thinkingMs, null);
  assert.equal(result.timing.outputMs, null);
  assert.equal(JSON.stringify(progress).includes('never forward this'), false);
  assert.equal(progress.at(-1).phase, 'completed');
});

test('nonstream truncation preserves invalid content for the existing repair path', async () => {
  const { client } = jsonClient(completion('{"storyboard":', 'length'));
  const result = await client('offline-test-key', messages);
  assert.equal(result.truncated, true);
  assert.equal(result.data, null);
  assert.equal(result.rawContent, '{"storyboard":');
});

test('short timeout aborts pending reads and preserves the last observed phase', async () => {
  let requestSignal;
  const progress = [];
  let cancelled = false;
  const client = createDeepSeekClient({
    timeoutMs: 15,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      let first = true;
      return {
        ok: true, status: 200,
        headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({
          read: () => {
            if (first) { first = false; return Promise.resolve({ value: Buffer.from(event({ reasoning_content: 'private thought' })), done: false }); }
            return new Promise(() => {});
          },
          cancel: () => { cancelled = true; }, releaseLock: () => {},
        }) },
      };
    },
  });
  await assert.rejects(client('offline-test-key', messages, undefined, (item) => progress.push(item)), (error) => {
    assert.equal(error.code, 'DEEPSEEK_TIMEOUT');
    assert.match(error.message, /超时上限/);
    assert.equal(error.timing.lastPhase, 'thinking');
    return true;
  });
  assert.equal(requestSignal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(progress.at(-1).lastPhase, 'thinking');
  assert.equal(progress.some((item) => item.phase === 'completed'), false);
});

test('HTTP failures do not expose provider messages or credentials', async () => {
  const client = createDeepSeekClient({
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'offline-test-key original text' }),
  });
  await assert.rejects(client('offline-test-key', messages, undefined, () => {}), (error) => {
    assert.equal(error.code, 'DEEPSEEK_HTTP');
    assert.match(error.message, /401/);
    assert.equal(error.message.includes('offline-test-key'), false);
    return true;
  });
});

test('progress listener errors cannot interrupt a successful stream', async () => {
  const { client } = streamClient([event({ content: '{"ok":true}' }, 'stop'), 'data: [DONE]\n\n']);
  const result = await client('offline-test-key', messages, undefined, () => { throw new Error('window closed'); });
  assert.equal(result.data.ok, true);
});

test('interleaved late reasoning does not mislabel its observed window as total thinking time', async () => {
  const { client } = streamClient([
    event({ reasoning_content: 'first' }), event({ content: '{"ok":' }),
    event({ reasoning_content: 'later' }), event({ content: 'true}' }, 'stop'),
    'data: [DONE]\n\n',
  ], [100, 200, 300, 400, 500]);
  const result = await client('offline-test-key', messages, undefined, () => {});
  assert.equal(result.timing.thinkingMs, 100);
  assert.equal(result.timing.reasoningChars, 10);
  assert.equal(result.timing.outputMs, 300);
});

test('progress only forwards numeric usage fields and a bounded request identifier', async () => {
  const { client } = streamClient([
    event({ content: '{"ok":true}' }, 'stop'),
    usageEvent({ ...finalUsage, privateText: 'private raw thought', prompt_tokens_details: { privateText: 'private raw thought' } }),
    'data: [DONE]\n\n',
  ]);
  const progress = [];
  const result = await client('offline-test-key', messages, undefined, (item) => progress.push(item));
  assert.deepEqual(result.usage, finalUsage);
  assert.equal(JSON.stringify(progress).includes('private raw thought'), false);
  assert.equal(JSON.stringify(result.timing).includes('private raw thought'), false);
});
