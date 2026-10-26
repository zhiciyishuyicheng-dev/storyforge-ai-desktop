import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSkillHistory, rememberSkill, seedSkillHistory } from './generation-skill-history.js';

const oldDate = '2026-10-01T08:00:00.000Z';
const newDate = '2026-10-26T08:00:00.000Z';
const doc = { name: ' 分镜规范.md ', format: 'MD', content: '\n **逐字对白**\r\n保留原文。  \n', size: 60, importedAt: oldDate, sha256: 'original-hash' };

test('history survives JSON persistence with complete original Skill text and metadata', () => {
  const stored = JSON.parse(JSON.stringify(rememberSkill([], 'storyboard', doc, newDate)));
  const [entry] = normalizeSkillHistory(stored);
  assert.equal(entry.stage, 'storyboard');
  assert.equal(entry.doc.name, '分镜规范.md');
  assert.equal(entry.doc.content, doc.content);
  assert.equal(entry.doc.format, 'md');
  assert.equal(entry.doc.sha256, doc.sha256);
  assert.equal(entry.doc.size, doc.size);
  assert.equal(entry.usedAt, newDate);
  assert.equal(entry.id, stored[0].id);
});

test('same stage and exact content dedupe on rename, retaining ID and latest name/use', () => {
  const first = rememberSkill([], 'storyboard', doc, oldDate);
  const renamed = rememberSkill(first, 'storyboard', { ...doc, name: '新版文件名.txt' }, newDate);
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].id, first[0].id);
  assert.equal(renamed[0].doc.name, '新版文件名.txt');
  assert.equal(renamed[0].usedAt, newDate);
  assert.equal(first[0].doc.name, '分镜规范.md');
});

test('same name with changed text and same text across stages are separate reusable choices', () => {
  let history = rememberSkill([], 'storyboard', doc, oldDate);
  history = rememberSkill(history, 'storyboard', { ...doc, content: '另一版正文' }, newDate);
  history = rememberSkill(history, 'assets', doc, newDate);
  assert.equal(history.length, 3);
  assert.equal(new Set(history.map(entry => entry.id)).size, 3);
  assert.equal(history.filter(entry => entry.stage === 'storyboard').length, 2);
  assert.equal(history[0].usedAt, newDate);
});

test('history operations return isolated documents and cannot mutate project source or prior history', () => {
  const source = structuredClone(doc);
  const first = rememberSkill([], 'assets', source, oldDate);
  source.content = '外部修改';
  const second = normalizeSkillHistory(first);
  second[0].doc.content = '另一处修改';
  assert.equal(first[0].doc.content, doc.content);
  const seed = seedSkillHistory([], [{ generationSkills: { assets: doc } }]);
  seed[0].doc.name = '变更';
  assert.equal(doc.name, ' 分镜规范.md ');
});

test('corrupt storage and incomplete metadata never become reusable documents', () => {
  for (const value of [null, {}, 'broken', 42]) assert.deepEqual(normalizeSkillHistory(value), []);
  const history = normalizeSkillHistory([
    null, {}, { stage: 'video', doc }, { stage: 'assets', doc: { name: 'hash only', sha256: 'hash' } },
    { stage: 'assets', doc: { name: '空文件', content: '  \n' } },
    { stage: 'assets', doc: { name: '过长', content: '字'.repeat(200001) } },
    { stage: 'assets', doc: { ...doc, size: 10 * 1024 * 1024 + 1 } },
  ]);
  assert.deepEqual(history, []);
  assert.deepEqual(rememberSkill([], 'invalid', doc), []);
});

test('valid maximum-length Skill is kept without arbitrary history or document truncation', () => {
  const content = '字'.repeat(200000);
  const history = rememberSkill([], 'storyboard', { name: '完整.md', content, size: 10 * 1024 * 1024 }, newDate);
  assert.equal(history[0].doc.content, content);
});

test('project seeding finds both Skill stages and preserves history after source removal', () => {
  const projects = [{ updatedAt: newDate, generationSkills: { storyboard: doc, assets: { name: '美术.txt', content: '低饱和写实风格。' } } }];
  const seeded = seedSkillHistory([], projects);
  assert.equal(seeded.length, 2);
  assert.equal(seeded.find(entry => entry.stage === 'storyboard').usedAt, oldDate);
  assert.equal(seeded.find(entry => entry.stage === 'assets').usedAt, newDate);
  assert.deepEqual(seedSkillHistory(seeded, []), seeded);
  assert.deepEqual(seedSkillHistory(seeded, [{ generationSkills: { storyboard: null } }]), seeded);
});

test('project saves do not bump usage dates or overwrite a remembered renamed document', () => {
  const history = rememberSkill([], 'storyboard', { ...doc, name: '最近选择的名字.md' }, oldDate);
  const seeded = seedSkillHistory(history, [{ updatedAt: newDate, generationSkills: { storyboard: doc } }]);
  assert.deepEqual(seeded, history);
});

test('only full image Skill snapshots seed history, not provenance name/hash records', () => {
  const seeded = seedSkillHistory([], [{ updatedAt: newDate, assetGeneration: { items: [{ files: [
    { generationSkill: { name: '不可复用.md', sha256: 'no-content' } },
    { generationSkill: { name: '完整快照.md', content: '完整资产规范' }, generatedAt: oldDate },
  ] }] } }]);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].stage, 'assets');
  assert.equal(seeded[0].doc.content, '完整资产规范');
  assert.equal(seeded[0].usedAt, oldDate);
});

test('normalization repairs duplicate/colliding IDs and retains newest duplicate metadata', () => {
  const history = normalizeSkillHistory([
    { id: 'existing', stage: 'storyboard', doc, usedAt: oldDate },
    { id: 'duplicate', stage: 'storyboard', doc: { ...doc, name: '最近名称.md' }, usedAt: newDate },
    { id: 'existing', stage: 'assets', doc, usedAt: oldDate },
  ]);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, 'existing');
  assert.equal(history[0].doc.name, '最近名称.md');
  assert.equal(new Set(history.map(entry => entry.id)).size, 2);
});
