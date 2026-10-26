'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureStoryboardOutline, migrateLegacyOutline } = require('./storyboard-outline.cjs');

test('legacy outline migration derives only from final shots and declared scenes', () => {
  const value = {
    analysis: { title: 'old analysis must not become the outline' },
    assets: { scenes: [{ name: '会议室', id: 'S01' }] },
    storyboard: { shots: [
      { no: '08', duration: 12, sceneId: 'S01', title: '署名被换', segments: [{ visual: '周成海看到接口图上的署名，手停住。' }] },
      { no: '09', duration: 7, sceneId: 'SC02', uploads: [{ asset: '会议室' }], title: '当面质问', segments: [{ visual: '周成海看向陈浩，指出方案归属。' }] },
    ] },
  };
  const shots = value.storyboard.shots;
  migrateLegacyOutline(value);
  assert.equal(value.storyboard.shots, shots, 'Keep a single authoritative block array');
  assert.deepEqual(shots.map(({ no, duration, scene }) => ({ no, duration, scene })), [
    { no: '08', duration: 12, scene: '会议室' }, { no: '09', duration: 7, scene: '会议室' },
  ]);
  assert.equal(shots[0].outline, '署名被换。周成海看到接口图上的署名，手停住。');
  assert.equal(JSON.stringify(value.outline).includes('old analysis'), false);
  assert.equal(Object.hasOwn(value.outline, 'rows'), false);
});

test('new candidate metadata remains available for validation instead of silently passing through legacy migration', () => {
  const value = { outline: { title: '分镜大纲' }, storyboard: { shots: [{ no: '01', duration: 13 }] } };
  migrateLegacyOutline(value);
  assert.equal(Object.hasOwn(value.storyboard.shots[0], 'outline'), false);
  assert.equal(Object.hasOwn(value.storyboard.shots[0], 'scene'), false);
});

test('final publication preserves model summaries and does not reuse another block after repair', () => {
  const first = { no: '01', duration: 6, scene: '会议室', outline: '被迫接受。陈浩宣布人力调整，周成海没有鼓掌。' };
  const second = { no: '02', duration: 9, scene: '会议室门口', outline: '离席。周成海收起笔记，走向门口。' };
  const repaired = { outline: { title: '分镜大纲' }, storyboard: { shots: [first, second] } };
  ensureStoryboardOutline(repaired);
  assert.deepEqual(repaired.storyboard.shots.map(shot => [shot.no, shot.duration, shot.scene, shot.outline]), [
    ['01', 6, '会议室', first.outline], ['02', 9, '会议室门口', second.outline],
  ]);
  assert.equal(Object.hasOwn(repaired, 'analysis'), false);
});

test('unknown legacy scene stays unknown and state fallback retains existing facts', () => {
  const value = { analysis: {}, assets: null, storyboard: { shots: [
    { no: '01', duration: 4, sceneId: 'SC001', title: '停笔', startState: '笔帽在右手。', endState: '笔帽仍在右手。' },
    null,
  ] } };
  assert.doesNotThrow(() => migrateLegacyOutline(value));
  assert.equal(value.storyboard.shots[0].scene, '待定');
  assert.equal(value.storyboard.shots[0].outline, '停笔。笔帽在右手。 笔帽仍在右手。');
  assert.equal(value.storyboard.shots[1], null, 'Do not fabricate a block from malformed input');
});
