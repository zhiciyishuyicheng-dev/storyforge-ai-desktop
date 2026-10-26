'use strict';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';

// Outline rows live on the final generation blocks, rather than in a second
// numbered list that can drift when a repair splits, merges or reorders blocks.
function sceneForShot(shot, assets = {}) {
  for (const key of ['scene', 'sceneName', 'location']) if (text(shot?.[key])) return text(shot[key]);
  const scenes = Array.isArray(assets?.scenes) ? assets.scenes : [];
  const sceneNames = new Set(scenes.map(item => text(item?.name)).filter(Boolean));
  const matched = scenes.find(item => text(shot?.sceneId) && [text(item?.id), text(item?.sceneId), text(item?.name)].includes(text(shot.sceneId)));
  if (text(matched?.name)) return text(matched.name);
  const used = [...new Set((Array.isArray(shot?.uploads) ? shot.uploads : []).map(item => text(item?.asset)).filter(name => sceneNames.has(name)))];
  if (used.length) return used.join(' / ');
  // Human scene labels from older projects are useful; opaque IDs are not.
  const sceneId = text(shot?.sceneId);
  return /[\p{Script=Han}]/u.test(sceneId) ? sceneId.replace(/_/gu, '·') : '待定';
}

function contentForShot(shot) {
  if (text(shot?.outline)) return text(shot.outline);
  const title = text(shot?.title);
  const segments = (Array.isArray(shot?.segments) ? shot.segments : []).map(item => text(item?.visual)).filter(Boolean);
  const facts = [...new Set(segments.length ? segments : [text(shot?.startState), text(shot?.endState)].filter(Boolean))].join(' ');
  return [title, facts].filter(Boolean).join(title && facts ? '。' : '') || '待补充分镜内容';
}

function ensureStoryboardOutline(candidate) {
  if (!object(candidate) || !object(candidate.storyboard) || !Array.isArray(candidate.storyboard.shots)) return candidate;
  candidate.outline = { ...(object(candidate.outline) ? candidate.outline : {}), title: '分镜大纲' };
  for (const shot of candidate.storyboard.shots) {
    if (!object(shot)) continue;
    shot.scene = sceneForShot(shot, candidate.assets);
    shot.outline = contentForShot(shot);
  }
  return candidate;
}

function migrateLegacyOutline(candidate) {
  if (object(candidate?.analysis) && !Object.hasOwn(candidate, 'outline')) ensureStoryboardOutline(candidate);
  return candidate;
}

module.exports = { ensureStoryboardOutline, migrateLegacyOutline };
