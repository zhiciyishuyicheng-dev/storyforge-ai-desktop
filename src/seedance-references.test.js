import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedanceReferenceRequest, ensureStoryboardShot, extractAssetReferences, migrateNamedReferencePlan, namedReferenceKey, normalizeImageReferenceSequence, removeAndRenumberImageReference, resolveStrictReferencePlan } from './seedance-references.js';

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

test('严格按 @Image 编号和素材精确名称绑定，不受视觉素材列表顺序影响', () => {
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

test('只绑定正文实际使用的参考图，忽略旧上传计划中多余素材', () => {
  const plan = resolveStrictReferencePlan({ prompt: '@Image1作林晚星。', shot, assetItems });
  assert.equal(plan.valid, true);
  assert.equal(plan.bindings.length, 1);
  assert.equal(plan.bindings[0].assetName, '林晚星');
});

test('素材名称只做精确匹配，不使用场景或位置兜底', () => {
  const plan = resolveStrictReferencePlan({
    prompt: '@Image1作林晚星，@Image2作宴会厅。',
    shot: { ...shot, uploads: [shot.uploads[0], { ...shot.uploads[1], asset: '不存在的宴会厅' }] },
    assetItems,
  });
  assert.equal(plan.valid, false);
  assert.ok(plan.errors.some((error) => error.includes('在视觉素材中不存在')));
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

test('具名分镜可直接绑定图片，旧的七项编号上传计划不会强塞未用图片', () => {
  const result = buildSeedanceReferenceRequest({
    prompt: '@林晚星站在@酒店宴会厅，@林晚星回头。', shot,
    assetItems: [...assetItems, { name: '未出镜道具', files: [{ localPath: 'C:/unused.png' }] }],
  });
  assert.deepEqual(result.imagePaths, ['C:/person-a.png', 'C:/scene.png']);
  assert.match(result.prompt, /图片1站在图片2，图片1回头/);
  assert.ok(!result.prompt.includes('@林晚星'));
  assert.deepEqual(result.plan.bindings.map((binding) => [binding.ref, binding.key, binding.number]), [
    ['@林晚星', namedReferenceKey('林晚星'), 1], ['@酒店宴会厅', namedReferenceKey('酒店宴会厅'), 2],
  ]);
});

test('中文括号和空格属于名称，重叠名称按最长精确匹配', () => {
  const items = [
    { name: '周成海', files: [{ localPath: 'C:/person.png' }] },
    { name: '周成海（青年）', files: [{ localPath: 'C:/young.png' }] },
    { name: '办公室', files: [{ localPath: 'C:/office.png' }] },
    { name: '办公室（白天）', files: [{ localPath: 'C:/day.png' }] },
    { name: '会议室 (夜景)', files: [{ localPath: 'C:/meeting.png' }] },
  ];
  const result = buildSeedanceReferenceRequest({
    prompt: '@周成海（青年）进入@办公室（白天），@周成海看向@会议室 (夜景)。', assetItems: items,
  });
  assert.deepEqual(result.imagePaths, ['C:/young.png', 'C:/day.png', 'C:/person.png', 'C:/meeting.png']);
  assert.match(result.prompt, /图片1进入图片2，图片3看向图片4/);
});

test('未知括号限定名称不能降级绑定短前缀，完整已知名仍可使用', () => {
  const items = [
    { name: '办公室', files: [{ localPath: 'C:/office.png' }] },
    { name: '办公室（白天）', files: [{ localPath: 'C:/office-day.png' }] },
    { name: '周成海', files: [{ localPath: 'C:/person.png' }] },
    { name: '周成海(青年)', files: [{ localPath: 'C:/young.png' }] },
  ];
  for (const prompt of ['@办公室（夜晚）。', '@周成海(老年)。']) {
    const plan = resolveStrictReferencePlan({ prompt, assetItems: items });
    assert.equal(plan.valid, false);
    assert.equal(plan.bindings.length, 0);
    assert.ok(plan.errors.some((error) => error.includes('同名素材')));
    assert.throws(() => buildSeedanceReferenceRequest({ prompt, assetItems: items }), /同名素材/);
  }
  const result = buildSeedanceReferenceRequest({ prompt: '@周成海(青年)进入@办公室（白天）。', assetItems: items });
  assert.deepEqual(result.imagePaths, ['C:/young.png', 'C:/office-day.png']);
});

test('名称后用空格或冒号隔开用途括号时保持正常具名绑定', () => {
  const result = buildSeedanceReferenceRequest({
    prompt: '@林晚星 （外貌、服装参考），@酒店宴会厅：（空间参考）。', assetItems,
  });
  assert.deepEqual(result.imagePaths, ['C:/person-a.png', 'C:/scene.png']);
  assert.match(result.prompt, /图片1 （外貌、服装参考）/);
  assert.match(result.prompt, /图片2：（空间参考）/);
});

test('未知名称和缺图分别给出可操作错误，不按位置猜图', () => {
  const plan = resolveStrictReferencePlan({
    prompt: '@林晚星与@陌生角色在@空场景。',
    assetItems: [...assetItems, { name: '空场景', files: [] }],
  });
  assert.equal(plan.valid, false);
  assert.ok(plan.errors.some((error) => error.includes('@陌生角色') && error.includes('同名素材')));
  assert.ok(plan.errors.some((error) => error.includes('空场景') && error.includes('尚未上传')));
  assert.throws(() => buildSeedanceReferenceRequest({ prompt: '@陌生角色。', assetItems }), /陌生角色/);
});

test('英文名称只允许完整标识符，不把未知长名称识别成前缀', () => {
  const references = extractAssetReferences('@Ann看向@Anna，@Annabelle独自离开。', [{ name: 'Ann' }, { name: 'Anna' }]);
  assert.deepEqual(references.map((reference) => [reference.ref, reference.kind]), [
    ['@Ann', 'named'], ['@Anna', 'named'], ['@Annabelle独自离开', 'unknown'],
  ]);
});

test('同名素材不能自动猜选，即使都有本地图片', () => {
  const plan = resolveStrictReferencePlan({ prompt: '@林晚星。', assetItems: [...assetItems, { name: '林晚星', files: [{ localPath: 'C:/other.png' }] }] });
  assert.equal(plan.valid, false);
  assert.ok(plan.errors.some((error) => error.includes('同名素材')));
});

test('显式选择其他素材时拒绝绑定，不允许用场景替代人物', () => {
  for (const savedBindings of [
    { [namedReferenceKey('林晚星')]: { assetName: '酒店宴会厅', localPath: 'C:/scene.png' } },
    { '@林晚星': { localPath: 'C:/scene.png' } },
  ]) {
    const plan = resolveStrictReferencePlan({ prompt: '@林晚星。', assetItems, savedBindings });
    assert.equal(plan.valid, false);
    assert.equal(plan.bindings[0].selected, null);
    assert.equal(plan.bindings[0].candidates.length, 2);
    assert.ok(plan.bindings[0].candidates.every((candidate) => candidate.assetName === '林晚星'));
    assert.ok(plan.errors.some((error) => error.includes('必须绑定同名素材')));
  }
});

test('新增具名引用不会继承旧数字位置中另一素材的图片', () => {
  const savedBindings = { 1: { assetName: '酒店宴会厅', localPath: 'C:/scene.png' } };
  const migrated = migrateNamedReferencePlan({ prompt: '@林晚星。', assetItems, savedBindings });
  assert.equal(migrated.plan.valid, true);
  assert.equal(migrated.plan.bindings[0].selected.localPath, 'C:/person-a.png');
  assert.equal(migrated.bindings[namedReferenceKey('林晚星')], undefined);
  assert.equal(migrated.bindings[1].localPath, 'C:/scene.png');
});

test('旧选图按上传计划中的素材身份迁移，正文换序后不丢所选版本', () => {
  const savedBindings = { 1: { assetName: '林晚星', localPath: 'C:/person-b.png' }, 2: { assetName: '酒店宴会厅', localPath: 'C:/scene.png' } };
  const migrated = migrateNamedReferencePlan({ prompt: '@酒店宴会厅中，@林晚星回头。', shot, assetItems, savedBindings });
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.uploads.map((upload) => upload.ref), ['@酒店宴会厅', '@林晚星']);
  assert.equal(migrated.bindings[namedReferenceKey('林晚星')].localPath, 'C:/person-b.png');
  const result = buildSeedanceReferenceRequest({
    prompt: '@林晚星离开@酒店宴会厅。', shot: { uploads: migrated.uploads }, assetItems, savedBindings: migrated.bindings,
  });
  assert.deepEqual(result.imagePaths, ['C:/person-b.png', 'C:/scene.png']);
  assert.deepEqual(savedBindings[1], { assetName: '林晚星', localPath: 'C:/person-b.png' });
});

test('有跳号的旧编号仍可执行并迁成具名正文，不要求用户重新编号', () => {
  const legacyShot = { uploads: [{ ref: '@Image7', asset: '林晚星', purpose: '角色' }, { ref: '@Image3', asset: '酒店宴会厅', purpose: '场景' }] };
  const savedBindings = { 7: { assetName: '林晚星', localPath: 'C:/person-b.png' } };
  const request = buildSeedanceReferenceRequest({ prompt: '@Image7进入@Image3。', shot: legacyShot, assetItems, savedBindings });
  assert.deepEqual(request.imagePaths, ['C:/person-b.png', 'C:/scene.png']);
  assert.match(request.prompt, /图片1进入图片2/);
  const migrated = migrateNamedReferencePlan({ prompt: '@Image7进入@Image3。', shot: legacyShot, assetItems, savedBindings });
  assert.equal(migrated.prompt, '@林晚星进入@酒店宴会厅。');
  assert.equal(migrated.bindings[namedReferenceKey('林晚星')].localPath, 'C:/person-b.png');
});

test('没有结构化旧计划时也通过已选图片恢复准确名称', () => {
  const migrated = migrateNamedReferencePlan({
    prompt: '@Image1用于女主角外观。', assetItems,
    savedBindings: { 1: { localPath: 'C:/person-b.png' } },
  });
  assert.equal(migrated.prompt, '@林晚星用于女主角外观。');
  assert.equal(migrated.uploads[0].ref, '@林晚星');
  assert.equal(migrated.bindings[namedReferenceKey('林晚星')].localPath, 'C:/person-b.png');
});

test('旧计划同素材两个独立槽位保留两张选图，忽略通用名称键', () => {
  const legacyShot = { uploads: [
    { ref: '@Image2', asset: '林晚星', purpose: '人物正面' },
    { ref: '@Image7', asset: '林晚星', purpose: '人物背面' },
  ] };
  const savedBindings = {
    2: { assetName: '林晚星', localPath: 'C:/person-a.png' },
    7: { assetName: '林晚星', localPath: 'C:/person-b.png' },
    [namedReferenceKey('林晚星')]: { assetName: '林晚星', localPath: 'C:/person-b.png' },
  };
  const prompt = '@Image2用于林晚星正面；@Image7用于林晚星背面。';
  const migrated = migrateNamedReferencePlan({ prompt, shot: legacyShot, assetItems, savedBindings });
  assert.equal(migrated.prompt, prompt);
  assert.deepEqual(migrated.uploads.map(upload => [upload.ref, upload.legacySeparate]), [['@Image2', true], ['@Image7', true]]);
  assert.deepEqual(migrated.plan.bindings.map(binding => [binding.key, binding.legacySeparate, binding.sourceNumber]), [['image:2', true, 2], ['image:7', true, 7]]);
  assert.equal(migrated.bindings['image:2'].localPath, 'C:/person-a.png');
  assert.equal(migrated.bindings['image:7'].localPath, 'C:/person-b.png');
  const result = buildSeedanceReferenceRequest({ prompt: migrated.prompt, shot: { uploads: migrated.uploads }, assetItems, savedBindings: migrated.bindings });
  assert.deepEqual(result.imagePaths, ['C:/person-a.png', 'C:/person-b.png']);
  assert.match(result.prompt, /图片1用于林晚星正面；图片2用于林晚星背面/);
});

test('旧多槽迁移后改变顺序或删除一槽，剩余槽位不丢选图', () => {
  const migrated = migrateNamedReferencePlan({
    prompt: '@Image2正面；@Image7背面。',
    shot: { uploads: [{ref:'@Image2',asset:'林晚星',purpose:'正面'}, {ref:'@Image7',asset:'林晚星',purpose:'背面'}] },
    assetItems,
    savedBindings: { 2:{assetName:'林晚星',localPath:'C:/person-a.png'},7:{assetName:'林晚星',localPath:'C:/person-b.png'} },
  });
  migrated.bindings['image:7'] = {assetName:'林晚星',localPath:'C:/person-a.png'};
  const reordered = buildSeedanceReferenceRequest({ prompt: '@Image7背面；@Image2正面。', shot: {uploads:migrated.uploads}, assetItems, savedBindings:migrated.bindings });
  assert.deepEqual(reordered.plan.bindings.map(binding => binding.key), ['image:7', 'image:2']);
  assert.deepEqual(reordered.imagePaths, ['C:/person-a.png', 'C:/person-a.png']);
  const remaining = migrateNamedReferencePlan({
    prompt: '@Image7背面。', shot: {uploads:migrated.uploads.filter(upload=>upload.ref==='@Image7')}, assetItems, savedBindings:migrated.bindings,
  });
  assert.equal(remaining.prompt, '@Image7背面。');
  assert.equal(remaining.plan.bindings[0].key, 'image:7');
  assert.equal(remaining.plan.bindings[0].selected.localPath, 'C:/person-a.png');
});

test('无结构化上传的旧手选多图也保持独立槽位', () => {
  const migrated = migrateNamedReferencePlan({
    prompt:'@Image1正面；@Image3背面。', assetItems,
    savedBindings: {1:{localPath:'C:/person-a.png'},3:{localPath:'C:/person-b.png'}},
  });
  assert.equal(migrated.prompt, '@Image1正面；@Image3背面。');
  assert.deepEqual(migrated.plan.bindings.map(binding=>binding.legacySeparate), [true,true]);
  const result = buildSeedanceReferenceRequest({prompt:migrated.prompt,shot:{uploads:migrated.uploads},assetItems,savedBindings:migrated.bindings});
  assert.deepEqual(result.imagePaths,['C:/person-a.png','C:/person-b.png']);
});

test('具名正文和上传不会被旧编号修复误删或错绑', () => {
  const uploads = [{ ref: '@林晚星', asset: '林晚星', purpose: '人物' }];
  const bindings = { [namedReferenceKey('林晚星')]: { localPath: 'C:/person-b.png' } };
  const result = normalizeImageReferenceSequence('@林晚星回头。', uploads, bindings);
  assert.equal(result.changed, false);
  assert.equal(result.prompt, '@林晚星回头。');
  assert.deepEqual(result.uploads, uploads);
  assert.deepEqual(result.bindings, bindings);
});

test('每镜最多九张且重复使用同一具名素材只计一张', () => {
  const items = Array.from({ length: 10 }, (_value, index) => ({ name: `角色${index + 1}`, files: [{ localPath: `C:/${index + 1}.png` }] }));
  const ten = resolveStrictReferencePlan({ prompt: items.map((asset) => `@${asset.name}`).join('，'), assetItems: items });
  assert.equal(ten.valid, false);
  assert.ok(ten.errors.some((error) => error.includes('最多只能绑定 9')));
  const nine = resolveStrictReferencePlan({ prompt: `${items.slice(0, 9).map((asset) => `@${asset.name}`).join('，')}，@角色1。`, assetItems: items });
  assert.equal(nine.valid, true);
  assert.equal(nine.bindings.length, 9);
});

test('已认证素材通过 assetId 绑定，内部序号与上传顺序一致', () => {
  const result = buildSeedanceReferenceRequest({
    prompt: '@林晚星。', assetItems: [{ name: '林晚星', type: '人物', files: [{ trustedAssetId: 'asset://trusted-123' }] }],
  });
  assert.equal(result.imageInputs[0].assetId, 'trusted-123');
  assert.equal(result.imageInputs[0].referenceNumber, 1);
  assert.deepEqual(result.imagePaths, []);
  assert.match(result.prompt, /图片1。/);
});
