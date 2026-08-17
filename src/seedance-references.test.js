import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedanceReferenceRequest, ensureStoryboardShot, normalizeImageReferenceSequence, removeAndRenumberImageReference, resolveStrictReferencePlan } from './seedance-references.js';

const shot = {
  uploads: [
    { ref: '@Image1', asset: '林晚星', purpose: '林晚星的外貌、发型和白裙' },
    { ref: '@Image2', asset: '酒店宴会厅', purpose: '订婚宴唯一场景' },
  ],
};
const assetItems = [
  { name: '酒店宴会厅', type: '场景参考图', files: [{ localPath: 'C:/scene.png', sourceName: 'scene.png' }] },
  { name: '林晚星', type: '人物参考图', files: [{ localPath: 'C:/person-a.png', sourceName: 'person-a.png' }, { localPath: 'C:/person-b.png', sourceName: 'person-b.png' }] },
];

test('严格按 @Image 编号和素材精确名称绑定，不受第五步列表顺序影响', () => {
  const result = buildSeedanceReferenceRequest({ prompt: '@Image1作林晚星，@Image2作宴会厅。', shot, assetItems });
  assert.deepEqual(result.imageInputs.map((item) => item.localPath), ['C:/person-a.png', 'C:/scene.png']);
  assert.match(result.prompt, /图片1：人物参考图“林晚星”/);
  assert.match(result.prompt, /图片2：场景参考图“酒店宴会厅”/);
});

test('允许用户为某个编号明确选择同一素材下的另一张图片', () => {
  const result = buildSeedanceReferenceRequest({
    prompt: '@Image1作林晚星，@Image2作宴会厅。',
    shot,
    assetItems,
    savedBindings: { 1: { assetName: '林晚星', localPath: 'C:/person-b.png' } },
  });
  assert.equal(result.imageInputs[0].localPath, 'C:/person-b.png');
});

test('提示词编号与上传计划不一致时阻止请求', () => {
  const plan = resolveStrictReferencePlan({ prompt: '@Image1作林晚星。', shot, assetItems });
  assert.equal(plan.valid, false);
  assert.match(plan.errors[0], /提示词引用与上传计划不一致/);
});

test('素材名称只做精确匹配，不使用场景或位置兜底', () => {
  const plan = resolveStrictReferencePlan({
    prompt: '@Image1作林晚星，@Image2作宴会厅。',
    shot: { ...shot, uploads: [shot.uploads[0], { ...shot.uploads[1], asset: '不存在的宴会厅' }] },
    assetItems,
  });
  assert.equal(plan.valid, false);
  assert.ok(plan.errors.some((error) => error.includes('在第五步不存在')));
});

test('旧项目没有 uploads 时从提示词恢复编号和准确素材名称', () => {
  const plan = resolveStrictReferencePlan({
    prompt: '素材引用：@Image1用于林晚星的外貌；@Image2用于酒店宴会厅的场景。',
    shot: { uploads: [] },
    assetItems,
  });
  assert.equal(plan.legacyMode, true);
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.bindings.map((binding) => binding.selected.assetName), ['林晚星', '酒店宴会厅']);
});

test('旧项目无法识别名称时允许用户通过下拉框明确绑定', () => {
  const plan = resolveStrictReferencePlan({
    prompt: '@Image1用于女主角外观。',
    shot: { uploads: [] },
    assetItems,
    savedBindings: { 1: { localPath: 'C:/person-b.png' } },
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.bindings[0].selected.localPath, 'C:/person-b.png');
  assert.equal(plan.bindings[0].candidates.length, 3);
});

test('旧项目完全没有 shots 数组时可创建当前镜头后继续添加素材', () => {
  const storyboard = { prompts: ['@Image1用于林晚星外观。'] };
  const restored = ensureStoryboardShot(storyboard, 0, storyboard.prompts[0], 9);
  assert.equal(restored.no, '01');
  assert.equal(restored.restoredFromLegacy, true);
  assert.deepEqual(restored.uploads, []);
  assert.equal(storyboard.shots[0], restored);
});

test('删除任意原始节点后保留中文语义并连续整理后续编号', () => {
  const prompt = '@Image1作林晚星，@Image2作宴会厅，@Image3作宾客群像，@Image4作旧戒指，@Image5作陆景行。';
  const result = removeAndRenumberImageReference(prompt, 3, '宴会宾客与主持人');
  assert.equal(result, '@Image1作林晚星，@Image2作宴会厅，宴会宾客与主持人作宾客群像，@Image3作旧戒指，@Image4作陆景行。');
});

test('自动修复旧错误数据中的跳号和提示词残留引用', () => {
  const uploads = [1, 2, 3, 4, 5, 7].map((number) => ({ ref: `@Image${number}`, asset: `素材${number}`, purpose: `用途${number}` }));
  const prompt = '@Image1，@Image2，@Image3，@Image4，@Image5，@Image6，@Image7。';
  const result = normalizeImageReferenceSequence(prompt, uploads, { 1: { localPath: '1' }, 7: { localPath: '7' } });
  assert.deepEqual(result.uploads.map((upload) => upload.ref), ['@Image1', '@Image2', '@Image3', '@Image4', '@Image5', '@Image6']);
  assert.equal(result.prompt, '@Image1，@Image2，@Image3，@Image4，@Image5，@Image6。');
  assert.deepEqual(Object.keys(result.bindings), ['1', '6']);
  assert.equal(result.changed, true);
});
