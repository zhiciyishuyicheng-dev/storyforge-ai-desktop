'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { downloadAndSave } = require('./seedance.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyforge-video-history-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  return { videoUrl: 'https://offline.invalid/fixture', outputRoot: root,
    projectTitle: '版本测试', projectId: 'project', fileName: '镜头-01.mp4', index: 0 };
}

test('Seedance regenerated and concurrent completions retain distinct complete historical files', async t => {
  const options = fixture(t);
  let serial = 0;
  global.fetch = async () => ({ ok: true, body: Readable.from([Buffer.from(`generated-${++serial}`)]) });
  const first = await downloadAndSave(options);
  const results = await Promise.all([downloadAndSave(options), downloadAndSave(options)]);
  assert.equal(first.fileName, '镜头-01.mp4');
  assert.deepEqual(results.map(result => result.fileName).sort(), ['镜头-01-v2.mp4', '镜头-01-v3.mp4']);
  assert.equal(fs.readFileSync(first.localPath, 'utf8'), 'generated-1');
  assert.deepEqual(new Set(results.map(result => fs.readFileSync(result.localPath, 'utf8'))), new Set(['generated-2', 'generated-3']));
  assert.ok(results.every(result => result.videoFileUrl === pathToFileURL(result.localPath).href));
  assert.equal(fs.readdirSync(first.outputDirectory).length, 3);
});

test('failed or empty Seedance autosaves preserve historical files and remove temporary data', async t => {
  const options = fixture(t);
  global.fetch = async () => ({ ok: true, body: Readable.from(['original']) });
  const first = await downloadAndSave(options);
  global.fetch = async () => ({ ok: true, body: Readable.from((async function*() {
    yield Buffer.from('partial'); throw new Error('mock stream interruption');
  })()) });
  await assert.rejects(downloadAndSave(options), /mock stream interruption/);
  global.fetch = async () => ({ ok: true, body: Readable.from([]) });
  await assert.rejects(downloadAndSave(options), /空视频/);
  assert.equal(fs.readFileSync(first.localPath, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(first.outputDirectory), ['镜头-01.mp4']);
});

test('Seedance autosave handles web streams and keeps file URLs for each saved version', async t => {
  const options = fixture(t);
  global.fetch = async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('web-stream-video')); controller.close();
  } }) });
  const result = await downloadAndSave(options);
  assert.equal(fs.readFileSync(result.localPath, 'utf8'), 'web-stream-video');
  assert.equal(result.videoFileUrl, pathToFileURL(result.localPath).href);
  assert.deepEqual(fs.readdirSync(result.outputDirectory), ['镜头-01.mp4']);
});

test('Seedance autosave rejects unsuccessful providers without creating a completed version', async t => {
  const options = fixture(t);
  global.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(downloadAndSave(options), /503/);
  const directory = path.join(options.outputRoot, 'StoryForge', options.projectTitle, options.projectId, '视频片段');
  assert.deepEqual(fs.readdirSync(directory), []);
});
