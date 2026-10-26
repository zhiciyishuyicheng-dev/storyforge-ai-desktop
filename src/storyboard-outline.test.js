import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryboardOutline, serializeStoryboardOutline, storyboardOutlineTemplate } from './storyboard-outline.js';

test('大纲行只取最终分镜，保持修复后的顺序、编号和原始时长', () => {
  const outline = buildStoryboardOutline({
    outline: { rows: [{ no: '99', duration: 12, scene: '旧场景', content: '过期大纲' }] },
    durations: [15, 15, 15],
    shots: [
      { no: '03', duration: 2, scene: '走廊', outline: '转身离开。' },
      { no: '01', duration: 13, scene: '会议室', outline: '成果被冒领。' },
      { no: '05', duration: '4秒', scene: '办公室', outline: '停笔。' },
    ],
  });
  assert.deepEqual(outline.rows.map(({ no, duration, scene, content }) => ({ no, duration, scene, content })), [
    { no: '03', duration: 2, scene: '走廊', content: '转身离开。' },
    { no: '01', duration: 13, scene: '会议室', content: '成果被冒领。' },
    { no: '05', duration: 4, scene: '办公室', content: '停笔。' },
  ]);
  assert.equal(outline.count, 3);
  assert.equal(outline.totalDuration, 19);
  assert.equal(outline.unknownDurationCount, 0);
  assert.doesNotMatch(storyboardOutlineTemplate(outline), /旧场景|过期大纲/);
});

test('新生成摘要完整展示，安全转换粗体和换行', () => {
  const content = `**成果被冒领。**\n${'周成海当面质问方案归属。'.repeat(100)}`;
  const outline = buildStoryboardOutline({ shots: [{ no: '01', duration: 13, scene: '会议室', outline: content }] });
  assert.equal(outline.rows[0].content, content);
  assert.equal(outline.rows[0].details, undefined);
  const html = storyboardOutlineTemplate(outline);
  assert.match(html, /<strong>成果被冒领。<\/strong><br>/);
  assert.doesNotMatch(html, /\*\*|<details/);
  assert.equal((html.match(/<th scope="col">/g) || []).length, 4);
  assert.match(html, /生成块<\/th><th scope="col">预计时长<\/th><th scope="col">场景<\/th><th scope="col">剧情内容与镜头重点/);
});

test('旧分镜从标题和镜头还原可读内容，不需要故事分析字段', () => {
  const outline = buildStoryboardOutline({ shots: [
    { title: '停笔与署名', duration: 4, sceneId: 'SC01_上线前碰头会', segments: [{ time: '0-2秒', visual: '周成海停住手中的笔。' }, { time: '2-4秒', visual: '镜头移向投影上的署名。' }] },
    { no: '02', title: '离开', duration: 2, startState: '站在桌边。', endState: '走出会议室。' },
  ] });
  assert.equal(outline.rows[0].no, '01');
  assert.equal(outline.rows[0].scene, '上线前碰头会');
  assert.equal(outline.rows[0].content, '停笔与署名\n0-2秒：周成海停住手中的笔。\n2-4秒：镜头移向投影上的署名。');
  assert.equal(outline.rows[1].content, '离开\n站在桌边。\n走出会议室。');
});

test('极长的旧镜头显示代表性内容，并保留完整内容供展开和复制', () => {
  const full = '桌面高度的侧面中近景。'.repeat(110);
  const outline = buildStoryboardOutline({ shots: [{ title: '停笔', segments: [{ visual: full }] }] });
  const row = outline.rows[0];
  assert.match(row.content, /^停笔\n桌面高度/);
  assert.ok(row.content.length < 450);
  assert.equal(row.details, `停笔\n${full}`);
  const html = storyboardOutlineTemplate(outline);
  assert.match(html, /<details class="storyboard-outline-details">/);
  assert.ok(html.includes(full));
  assert.ok(serializeStoryboardOutline(outline).includes(full));
});

test('场景依次从分镜、素材编号、上传素材、可读场景编号解析', () => {
  const assets = { scenes: [{ id: 'SC01', name: '会议室' }, { id: 'SC02', name: '楼梯间' }] };
  const outline = buildStoryboardOutline({ shots: [
    { scene: '上线前碰头会·会议室', sceneId: 'SC01' },
    { sceneId: 'SC01' },
    { sceneId: 'SC99', uploads: [{ ref: '@周成海', asset: '周成海' }, { ref: '@楼梯间', asset: '楼梯间' }] },
    { sceneId: 'SC03_办公区' },
    { uploads: [{ asset: '公园', purpose: '场景参考' }] },
  ] }, assets);
  assert.deepEqual(outline.rows.map((row) => row.scene), ['上线前碰头会·会议室', '会议室', '楼梯间', '办公区', '公园']);
  assert.equal(buildStoryboardOutline({ shots: [{ sceneId: 'SC07' }] }, { scenes: { SC07: { name: '屋顶' } } }).rows[0].scene, '屋顶');
  assert.equal(buildStoryboardOutline({ shots: [{ uploads: [{ ref: '@车库' }] }] }, { promptItems: [{ type: '场景参考图', name: '车库' }] }).rows[0].scene, '车库');
  assert.equal(buildStoryboardOutline({ shots: [{ sceneName: '会议室' }, { location: '车库' }] }).rows[1].scene, '车库');
  assert.equal(buildStoryboardOutline({ shots: [{ uploads: [{ ref: '@会议室' }, { ref: '@楼梯间' }] }] }, assets).rows[0].scene, '场景待定');
});

test('未知场景、时长和内容明确显示待定，不从提示词或旧数组编造值', () => {
  const outline = buildStoryboardOutline({ durations: [5, 5, 5], shots: [
    { sceneId: 'SC01', prompt: '总时长12秒' },
    { duration: '待定' },
    { duration: 0 },
    { duration: '十三秒' },
    { duration: 2.5 },
  ] });
  assert.deepEqual(outline.rows.map((row) => row.duration), [null, null, null, 13, 2.5]);
  assert.equal(outline.totalDuration, 15.5);
  assert.equal(outline.unknownDurationCount, 3);
  assert.equal(outline.rows[0].scene, '场景待定');
  assert.equal(outline.rows[0].content, '旧版提示词原文：\n总时长12秒');
  assert.equal(outline.rows[1].content, '剧情内容待补充');
  assert.match(storyboardOutlineTemplate(outline), />待定<\/td>/);
  assert.equal(buildStoryboardOutline(null, null).count, 0);
});

test('表格和复制文本处理所有模型字段，HTML和属性无法注入', () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const outline = buildStoryboardOutline({ shots: [{ no: malicious, scene: malicious, outline: `**${malicious}**\n<script>alert(2)</script>` }] });
  const html = storyboardOutlineTemplate(outline);
  assert.doesNotMatch(html, /<img|<script|onerror="/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<strong>&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  const markdown = serializeStoryboardOutline(outline);
  assert.doesNotMatch(markdown, /<img|<script|\*\*/);
});

test('复制大纲保留四列、行顺序和换行内容，转义表格分隔符', () => {
  const outline = buildStoryboardOutline({ shots: [{ no: '02', duration: 12, scene: '会议室', outline: '**质问。**陈浩 | 周成海\n门口特写。' }, { no: '01' }] });
  assert.equal(serializeStoryboardOutline(outline), [
    '| 生成块 | 预计时长 | 场景 | 剧情内容与镜头重点 |',
    '| --- | ---: | --- | --- |',
    '| 02 | 12秒 | 会议室 | 质问。陈浩 \\| 周成海<br>门口特写。 |',
    '| 01 | 待定 | 场景待定 | 剧情内容待补充 |',
  ].join('\n'));
});

test('空分镜仍显示四列表头和明确的空状态', () => {
  const outline = buildStoryboardOutline({ outline: { rows: [{ no: '01' }] } });
  assert.equal(outline.count, 0);
  assert.equal(outline.totalDuration, 0);
  assert.match(storyboardOutlineTemplate(outline), /colspan="4">暂无分镜大纲/);
});

test('仅存提示词的旧项目提取声明场景、时长和时间轴画面，不生成新剧情', () => {
  const prompt = '🎬 生成块 01（时长：4秒）\n本段总时长：4秒\n人物：@阿宁\n场景：书房（白天）\n\n（无对白字幕，无BGM，CG写实）\n\n空间与位置保持稳定：阿宁站在书桌前。\n\n[0-2秒] 近景，阿宁看着手中的信纸。\n[2-4秒] 镜头移向信纸上的字。\n声音：纸张摩擦声。';
  const outline = buildStoryboardOutline({ shots: [{ no: '01', prompt }] });
  assert.equal(outline.rows[0].scene, '书房（白天）');
  assert.equal(outline.rows[0].duration, 4);
  assert.equal(outline.rows[0].content, '旧版提示词提取：\n[0-2秒] 近景，阿宁看着手中的信纸。\n[2-4秒] 镜头移向信纸上的字。');
  assert.doesNotMatch(outline.rows[0].content, /人物：|空间与位置|声音：|BGM/);
  assert.equal(prompt.endsWith('声音：纸张摩擦声。'), true);
});

test('旧提示词画面标题和多行时间段可识别，嵌入的原有声音文字保持原样', () => {
  const outline = buildStoryboardOutline({ shots: [
    { prompt: '**场景：**@会议室\n**时长：**十三秒\n## 画面内容：\n周成海停住手中的笔。\n【音效：笔帽轻响。】\n统一附加词：写实。' },
    { prompt: '场景：走廊\n镜头1（00:00—00:02）：\n角色推开门。\n镜头2（00:02—00:04）：角色离开。' },
  ] });
  assert.equal(outline.rows[0].duration, 13);
  assert.equal(outline.rows[0].scene, '会议室');
  assert.equal(outline.rows[0].content, '旧版提示词提取：\n## 画面内容：\n周成海停住手中的笔。\n【音效：笔帽轻响。】');
  assert.match(outline.rows[1].content, /镜头1（00:00—00:02）：\n角色推开门。\n镜头2（00:02—00:04）：角色离开。/);
  assert.equal(outline.rows[1].duration, null);
});

test('无法识别画面段落时完整保留旧提示词原文并标明来源，转义后安全显示和复制', () => {
  const prompt = `<img src=x onerror="alert(1)">\n${'角色站在门前。'.repeat(160)}`;
  const outline = buildStoryboardOutline({ shots: [{ prompt }] });
  assert.equal(outline.rows[0].content, `旧版提示词原文：\n${prompt}`);
  assert.equal(outline.rows[0].details, undefined);
  assert.doesNotMatch(storyboardOutlineTemplate(outline), /<img/);
  assert.match(storyboardOutlineTemplate(outline), /&lt;img src=x/);
  assert.ok(serializeStoryboardOutline(outline).includes('角色站在门前。'.repeat(160)));
});

test('旧提示词只补缺失字段，绝不覆盖最终分镜或把无声明时间轴当成总时长', () => {
  const prompt = '场景：旧场景\n本段总时长：15秒\n[0-15秒] 旧画面。';
  const outline = buildStoryboardOutline({ shots: [
    { scene: '最终场景', duration: 2, outline: '最终剧情。', prompt },
    { duration: '待定', prompt },
    { prompt: '角色说：“时长：12秒。”\n[0-12秒] 门口静止。' },
  ] });
  assert.equal(outline.rows[0].scene, '最终场景');
  assert.equal(outline.rows[0].duration, 2);
  assert.equal(outline.rows[0].content, '最终剧情。');
  assert.equal(outline.rows[1].duration, null);
  assert.equal(outline.rows[2].duration, null);
  assert.equal(outline.rows[2].scene, '场景待定');
});
