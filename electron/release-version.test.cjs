'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { installShortReleaseVersionCompatibility, runDesktopPack } = require('../scripts/desktop-pack.cjs');
const metadata = require('app-builder-lib/out/util/packageMetadata');
const normalizer = require('app-builder-lib/out/util/normalizePackageData');
const { createTransformer } = require('app-builder-lib/out/fileTransformer');
const { AppInfo } = require('app-builder-lib/out/appInfo');
const { expandMacro } = require('app-builder-lib/out/util/macroExpander');

async function fixture(t, version = '1.0') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storyforge-release-version-'));
  const rootPath = path.resolve(root);
  const temporaryPrefix = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(rootPath.startsWith(temporaryPrefix) && path.basename(rootPath).startsWith('storyforge-release-version-'));
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const jsonPath = path.join(rootPath, 'package.json');
  const lockPath = path.join(rootPath, 'package-lock.json');
  await fs.writeFile(jsonPath, JSON.stringify({ name: 'story-to-screen-studio', version, scripts: { build: 'vite build' } }, null, 2));
  await fs.writeFile(lockPath, JSON.stringify({ name: 'story-to-screen-studio', version, lockfileVersion: 3, packages: { '': { name: 'story-to-screen-studio', version } } }, null, 2));
  return { root: rootPath, jsonPath, lockPath };
}

test('字面1.0仅适配根包内存校验，源文件/lock/打包元数据/安装包名保持1.0且依赖仍拒绝无效版本', async t => {
  const project = await fixture(t);
  const dependency = path.join(project.root, 'node_modules', 'same-name');
  await fs.mkdir(dependency, { recursive: true });
  const dependencyFile = path.join(dependency, 'package.json');
  await fs.writeFile(dependencyFile, JSON.stringify({ name: 'story-to-screen-studio', version: '1.0' }));
  const beforePackage = await fs.readFile(project.jsonPath);
  const beforeLock = await fs.readFile(project.lockPath);
  const restore = installShortReleaseVersionCompatibility(project.root);
  try {
    const [rootResult, dependencyResult] = await Promise.allSettled([metadata.readPackageJson(project.jsonPath), metadata.readPackageJson(dependencyFile)]);
    assert.equal(rootResult.status, 'fulfilled');
    assert.equal(rootResult.value.version, '1.0');
    assert.equal(dependencyResult.status, 'rejected');
    assert.match(dependencyResult.reason.message, /Invalid version: "1\.0"/);
    const packed = JSON.parse(await createTransformer(project.root, {}, null, null)(project.jsonPath));
    assert.equal(packed.version, '1.0');
    assert.equal(packed.scripts, undefined);
    const info = new AppInfo({ metadata: rootResult.value, config: {}, devMetadata: rootResult.value });
    assert.equal(info.version, '1.0');
    assert.equal(info.buildVersion, '1.0');
    assert.equal(expandMacro('StoryForge-Setup-${version}-${arch}.${ext}', 'x64', info, { ext: 'exe' }), 'StoryForge-Setup-1.0-x64.exe');
    assert.equal(info.getVersionInWeirdWindowsForm(), '1.0.0.0', 'Only Windows fixed numeric fields require four components');
    assert.deepEqual(await fs.readFile(project.jsonPath), beforePackage);
    assert.deepEqual(await fs.readFile(project.lockPath), beforeLock);
  } finally { restore(); }
  await assert.rejects(metadata.readPackageJson(project.jsonPath), /Invalid version: "1\.0"/);
});

test('适配不放宽其他版本或其余元数据校验，卸载后完整恢复原函数', async t => {
  const project = await fixture(t, '1.0-invalid');
  const readBefore = metadata.readPackageJson;
  const normalizeBefore = normalizer.normalizePackageData;
  const restore = installShortReleaseVersionCompatibility(project.root);
  try {
    await assert.rejects(metadata.readPackageJson(project.jsonPath), /Invalid version/);
    await fs.writeFile(project.jsonPath, JSON.stringify({ name: 123, version: '1.0' }));
    await assert.rejects(metadata.readPackageJson(project.jsonPath), /name field must be a string/);
    assert.throws(() => normalizer.normalizePackageData({ name: 'outside-project', version: '1.0' }), /Invalid version/);
  } finally { restore(); }
  assert.equal(metadata.readPackageJson, readBefore);
  assert.equal(normalizer.normalizePackageData, normalizeBefore);
});

test('官方CLI解析兼容win/nsis/x64/config，等待任务完成并在失败时恢复校验函数', async t => {
  const project = await fixture(t);
  const readBefore = metadata.readPackageJson;
  const normalizeBefore = normalizer.normalizePackageData;
  let finished = false;
  await runDesktopPack(['--win', 'nsis', '--x64', '--config.electronDist=node_modules/electron/dist'], {
    projectDir: project.root,
    wrapTask: task => task,
    buildTask: async args => {
      assert.deepEqual(args.win, ['nsis']);
      assert.equal(args.x64, true);
      assert.equal(args.config.electronDist, 'node_modules/electron/dist');
      assert.equal((await metadata.readPackageJson(project.jsonPath)).version, '1.0');
      await new Promise(resolve => setImmediate(resolve));
      finished = true;
    },
  });
  assert.equal(finished, true);
  assert.equal(metadata.readPackageJson, readBefore);
  assert.equal(normalizer.normalizePackageData, normalizeBefore);
  await assert.rejects(runDesktopPack(['--win', 'nsis'], { projectDir: project.root, wrapTask: task => task, buildTask: async () => { throw new Error('offline-build-task-failed'); } }), /offline-build-task-failed/);
  assert.equal(metadata.readPackageJson, readBefore);
  assert.equal(normalizer.normalizePackageData, normalizeBefore);
});
