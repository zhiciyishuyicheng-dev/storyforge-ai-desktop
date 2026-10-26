import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as skillHistory from './generation-skill-history.js';
import * as outlineUI from './storyboard-outline.js';
import * as durations from './seedance-duration.js';
import * as references from './seedance-references.js';
import * as generation from './seedance-generation.js';
import * as workflowProgress from './workflow-progress.js';
import * as comfyUI from './comfy-video-ui.js';
import * as h3 from './h3-references.js';

const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const renderer = source.slice(0, source.lastIndexOf('\nrender();')).replace(/^import .*;\r?\n/gm, '');
const STORAGE_KEY = 'storyforge-project-library-v1';
const doc = (name = '分镜要求.md', content = '保留原文顺序。\n人物动作以原文为准。') => ({
  name, content, format: 'md', size: 200, importedAt: '2026-10-20T12:00:00.000Z', sha256: 'a'.repeat(64),
});

function harness({ api = {}, storage = new Map() } = {}) {
  const context = vm.createContext({
    ...skillHistory, ...outlineUI, ...durations, ...references, ...generation, ...workflowProgress, ...comfyUI, ...h3,
    structuredClone,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { storyforgeAI: api, confirm: () => true, setTimeout: () => 1, setInterval: () => 1, clearInterval() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(renderer, context);
  vm.runInContext('render = () => {}; showToast = message => { globalThis.lastToast = message; }; deepseekStatus.configured = true;', context);
  return { context, storage, run: code => vm.runInContext(code, context), snapshot: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)) };
}

function remember(h, stage, value) {
  h.context.stage = stage; h.context.doc = value;
  h.run('projectLibrary.skillHistory = rememberSkill(projectLibrary.skillHistory, stage, doc);');
  return h.run('projectLibrary.skillHistory.find(item => item.stage === stage && item.doc.content === doc.content).id');
}

function select(h, stage, id) {
  h.context.stage = stage; h.context.selectedId = id;
  h.run('openGenerationSkillHistory(stage); selectGenerationSkillHistory(selectedId);');
}

test('旧项目的两个 Skill 自动进入历史，重启后可在新项目分别复用', () => {
  const skills = { storyboard: doc(), assets: doc('资产规范.md', '纯白背景，人物单独出图。') };
  const storage = new Map([[STORAGE_KEY, JSON.stringify({ activeProjectId: 'old', projects: [{ id: 'old', title: '旧项目', script: '', generationSkills: skills }] })]]);
  const first = harness({ storage });
  assert.deepEqual(first.snapshot('projectLibrary.skillHistory.map(item => item.stage).sort()'), ['assets', 'storyboard']);
  first.run('saveProject(); createNewProject();');
  const second = harness({ storage });
  assert.equal(second.run('project.generationSkills.storyboard'), null);
  const storyboardId = second.run('projectLibrary.skillHistory.find(item => item.stage === "storyboard").id');
  const assetId = second.run('projectLibrary.skillHistory.find(item => item.stage === "assets").id');
  select(second, 'storyboard', storyboardId); second.run('applyGenerationSkillHistory();');
  assert.deepEqual(second.snapshot('project.generationSkills.storyboard'), skills.storyboard);
  assert.equal(second.run('project.generationSkills.assets'), null);
  select(second, 'assets', assetId); second.run('applyGenerationSkillHistory();');
  assert.deepEqual(second.snapshot('project.generationSkills.assets'), skills.assets);
  const third = harness({ storage });
  assert.deepEqual(third.snapshot('project.generationSkills'), skills);
});

test('上传和替换保留同名不同正文，移除当前 Skill 不删除历史', async () => {
  let returned = doc('同名.md', '第一版\n原文。');
  const h = harness({ api: { importSkillDocument: async () => returned } });
  await h.run('importGenerationSkill("storyboard")');
  returned = doc('同名.md', '第二版\n新的要求。');
  await h.run('importGenerationSkill("storyboard")');
  h.run('removeGenerationSkill("storyboard");');
  assert.equal(h.run('project.generationSkills.storyboard'), null);
  assert.deepEqual(h.snapshot('projectLibrary.skillHistory.filter(item => item.stage === "storyboard").map(item => item.doc.content).sort()'), ['第一版\n原文。', '第二版\n新的要求。']);
  const id = h.run('projectLibrary.skillHistory.find(item => item.doc.content.startsWith("第一版")).id');
  select(h, 'storyboard', id); h.run('applyGenerationSkillHistory();');
  assert.equal(h.run('project.generationSkills.storyboard.content'), '第一版\n原文。');
});

test('历史选择按阶段隔离，不能把资产 Skill 通过旧选择注入分镜', () => {
  const h = harness();
  const storyboardId = remember(h, 'storyboard', doc('分镜专用.md'));
  const assetId = remember(h, 'assets', doc('资产专用.md', '人物单独出图。'));
  select(h, 'storyboard', storyboardId);
  const html = h.run('generationSkillHistoryTemplate()');
  assert.match(html, /分镜专用\.md/);
  assert.doesNotMatch(html, /资产专用\.md/);
  h.context.assetId = assetId;
  h.run('selectGenerationSkillHistory(assetId); applyGenerationSkillHistory();');
  assert.notEqual(h.run('project.generationSkills.storyboard?.name'), '资产专用.md');
  assert.equal(h.run('project.generationSkills.assets'), null);
});

test('复用复制完整正文和元信息，不改历史条目、其他项目或已有成果', () => {
  const h = harness();
  const original = doc('逐块要求.md', '\n保留空行。\n\n**指定格式** <原文>\n');
  const id = remember(h, 'storyboard', original);
  h.run('project.outputs = {analysis:{body:"原大纲"},storyboard:{body:"原分镜"},assets:{promptItems:[]}}; projectLibrary.projects.push(createProject({id:"other"}));');
  const before = h.snapshot('project.outputs');
  select(h, 'storyboard', id); h.run('applyGenerationSkillHistory();');
  assert.deepEqual(h.snapshot('project.generationSkills.storyboard'), original);
  assert.deepEqual(h.snapshot('project.outputs'), before);
  h.run('project.generationSkills.storyboard.content = "仅修改当前副本";');
  assert.equal(h.run('projectLibrary.skillHistory.find(item => item.id === selectedId).doc.content'), original.content);
  assert.equal(h.run('projectLibrary.projects.find(item => item.id === "other").generationSkills.storyboard'), null);
});

test('删除来源项目后仍可复用独立保存的历史 Skill', () => {
  const h = harness();
  h.context.doc = doc();
  h.run('saveGenerationSkill("storyboard", doc); globalThis.sourceId = project.id; createNewProject(); deleteProject(sourceId);');
  assert.equal(h.run('projectLibrary.projects.length'), 1);
  assert.equal(h.run('projectLibrary.skillHistory.length'), 1);
  const id = h.run('projectLibrary.skillHistory[0].id');
  select(h, 'storyboard', id); h.run('applyGenerationSkillHistory();');
  assert.deepEqual(h.snapshot('project.generationSkills.storyboard'), doc());
});

test('导入项目中的 Skill 进入历史，原文件无需再次上传', () => {
  const h = harness();
  h.context.FileReader = class { readAsText(file) { this.result = file.content; this.onload(); } };
  const value = doc('迁移资产规范.txt', '场景图只包含固定地点。');
  h.context.event = { target: { files: [{ content: JSON.stringify({ title: '导入项目', script: '原文', generationSkills: { assets: value } }) }], value: 'project.json' } };
  h.run('importProject(event); createNewProject();');
  const id = h.run('projectLibrary.skillHistory.find(item => item.stage === "assets").id');
  select(h, 'assets', id); h.run('applyGenerationSkillHistory();');
  assert.deepEqual(h.snapshot('project.generationSkills.assets'), value);
});

test('空历史和损坏的历史数据可以打开选择器，文件名和正文均安全转义', () => {
  const storage = new Map([[STORAGE_KEY, JSON.stringify({ activeProjectId: 'p', projects: [{ id: 'p', script: '' }], skillHistory: { damaged: true } })]]);
  const h = harness({ storage });
  h.run('openGenerationSkillHistory("storyboard");');
  assert.match(h.run('generationSkillHistoryTemplate()'), /暂无|没有/);
  h.run('applyGenerationSkillHistory();');
  assert.equal(h.run('project.generationSkills.storyboard'), null);
  const id = remember(h, 'storyboard', doc('<文件>.md', '<script>alert("x")</script>'));
  select(h, 'storyboard', id);
  const html = h.run('generationSkillHistoryTemplate()');
  assert.match(html, /&lt;文件&gt;\.md/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<文件>/);
});

test('生成中或切换项目后的旧选择不能修改当前 Skill', () => {
  const h = harness();
  const id = remember(h, 'storyboard', doc());
  select(h, 'storyboard', id); h.run('project.running = true; applyGenerationSkillHistory();');
  assert.equal(h.run('project.generationSkills.storyboard'), null);
  h.run('project.running = false;');
  select(h, 'storyboard', id);
  h.run('project = createProject({id:"new-target"}); projectLibrary.projects.push(project); applyGenerationSkillHistory();');
  assert.equal(h.run('project.generationSkills.storyboard'), null);
});

test('待处理上传期间不能复用，迟到响应不覆盖已经确认的历史复用', async () => {
  let resolve;
  const h = harness({ api: { importSkillDocument: () => new Promise(done => { resolve = done; }) } });
  const value = doc('历史规范.md', '历史要求。');
  const id = remember(h, 'storyboard', value);
  const importing = h.run('importGenerationSkill("storyboard")');
  select(h, 'storyboard', id); h.run('applyGenerationSkillHistory();');
  assert.equal(h.run('project.generationSkills.storyboard'), null);
  h.run('removeGenerationSkill("storyboard");');
  select(h, 'storyboard', id); h.run('applyGenerationSkillHistory();');
  resolve(doc('迟到上传.md', '不应覆盖。'));
  await importing;
  assert.deepEqual(h.snapshot('project.generationSkills.storyboard'), value);
});

test('复用保存失败恢复当前 Skill、历史记录和修改时间', () => {
  const h = harness();
  h.context.original = doc('当前规范.md', '原设置。');
  h.run('saveGenerationSkill("storyboard", original);');
  const id = remember(h, 'storyboard', doc('另一个规范.md', '待复用设置。'));
  select(h, 'storyboard', id);
  const before = h.snapshot('projectLibrary.skillHistory');
  h.run('project.updatedAt = "原修改时间"; localStorage.setItem = () => { throw new Error("存储空间不足"); }; applyGenerationSkillHistory();');
  assert.deepEqual(h.snapshot('project.generationSkills.storyboard'), h.context.original);
  assert.deepEqual(h.snapshot('projectLibrary.skillHistory'), before);
  assert.equal(h.run('project.updatedAt'), '原修改时间');
  assert.match(h.context.lastToast, /保存 Skill 失败|存储空间不足/);
});

test('分镜和资产页面都提供历史复用入口，生成时入口禁用', () => {
  const h = harness();
  for (const [step, stage] of [['analysis', 'storyboard'], ['storyboard', 'storyboard'], ['assets', 'assets']]) {
    h.context.step = step;
    h.run('project.activeStep = step; project.running = false;');
    assert.match(h.run('generationSkillTemplate()'), new RegExp(`data-reuse-generation-skill="${stage}"`));
    h.run('project.running = true;');
    assert.match(h.run('generationSkillTemplate()'), new RegExp(`data-reuse-generation-skill="${stage}" disabled`));
  }
});

test('复用的两个 Skill 原样进入下次分镜请求并锁定，运行中保留既有分镜', async () => {
  let captured, resolve;
  const h = harness({ api: { generateWorkflow: (_script, options) => { captured = options; return new Promise(done => { resolve = done; }); } } });
  const storyboardDoc = doc('复用分镜.md', '每块按剧情自然分配。');
  const assetDoc = doc('复用资产.md', '人物与场景分别出图。');
  const storyId = remember(h, 'storyboard', storyboardDoc);
  const assetId = remember(h, 'assets', assetDoc);
  select(h, 'storyboard', storyId); h.run('applyGenerationSkillHistory();');
  select(h, 'assets', assetId); h.run('applyGenerationSkillHistory();');
  h.run('project.script = "锁定原文"; project.activeStep = "storyboard"; project.outputs.storyboard = {body:"已确认的旧分镜"}; project.outputs.analysis = {outline:{rows:[{no:"01",duration:5,scene:"书房",content:"读信。"}],count:1,totalDuration:5,unknownDurationCount:0}};');
  const running = h.run('startGeneration()');
  assert.equal(captured.stage, "storyboard");
  assert.deepEqual(captured.stageSkills, { storyboard: storyboardDoc, assets: assetDoc });
  assert.equal(h.run('project.outputs.storyboard.body'), '已确认的旧分镜');
  h.run('project.generationSkills.storyboard.content = "仅改变外部副本";');
  assert.equal(captured.stageSkills.storyboard.content, storyboardDoc.content);
  resolve({ data: { outline: { title: '分镜大纲' }, storyboard: { shots: [{ no: '01', duration: 5, scene: '书房', outline: '读信。', prompt: '@阿宁 看信。' }] }, assets: { characters: [{ name: '阿宁', prompt: '人物参考图' }] } } });
  await running;
});
