const HEADERS = ['生成块', '预计时长', '场景', '剧情概述'];
const UNKNOWN_SCENE = '场景待定';
const UNKNOWN_CONTENT = '剧情内容待补充';

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function plainText(value) {
  return text(value).replace(/\*\*/g, '');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

// Only bold emphasis is supported. Model HTML always remains escaped text.
function contentHtml(value) {
  return escapeHtml(text(value))
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*\*/g, '')
    .replace(/\r?\n/g, '<br>');
}

function durationSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const source = text(value);
  const number = source.match(/^(\d+(?:\.\d+)?)\s*(?:秒|s|sec(?:onds?)?)?$/i);
  if (number) return Number(number[1]) > 0 ? Number(number[1]) : null;
  const chinese = source.match(/^([一二两三四五六七八九十]{1,3})\s*秒$/);
  if (!chinese) return null;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const [tens, units] = chinese[1].split('十');
  const result = chinese[1].includes('十')
    ? (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0)
    : digits[chinese[1]];
  return Number.isFinite(result) && result > 0 ? result : null;
}

function sceneAssets(assets) {
  const scenes = Array.isArray(assets?.scenes) ? assets.scenes : Object.entries(assets?.scenes || {}).map(([id, value]) => (
    typeof value === 'string' ? { id, name: value } : { ...value, id: value?.id || id }
  ));
  const prompts = Array.isArray(assets?.promptItems) ? assets.promptItems.filter((item) => /场景|scene|location/i.test(text(item?.type || item?.kind || item?.category))) : [];
  return [...scenes, ...prompts].filter((item) => item && typeof item === 'object');
}

function referenceName(value) {
  return plainText(value).replace(/^@/, '');
}

function humanizeSceneId(value) {
  const id = plainText(value);
  if (!id || /^(?:sc(?:ene)?)[\s_-]*\d+$/i.test(id)) return '';
  return id.replace(/^(?:sc(?:ene)?)[\s_-]*\d+[\s_·:：-]+/i, '').trim();
}

function promptLines(value) {
  return text(value).split(/\r?\n/).map((line) => ({
    original: line.trim(),
    label: plainText(line).replace(/^#{1,6}\s*/, '').trim(),
  }));
}

function promptScene(value) {
  for (const { label } of promptLines(value)) {
    const match = label.match(/^场景(?:名称)?\s*[：:]\s*(.+)$/);
    if (match) return referenceName(match[1]);
  }
  return '';
}

function promptDuration(value) {
  for (const { label } of promptLines(value)) {
    const match = label.match(/^(?:本段总时长|总时长|视频时长|时长)\s*[：:]\s*((?:\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(?:秒|s|sec(?:onds?)?))(?=$|\s|[，。；（(])/i);
    if (match) return durationSeconds(match[1]);
  }
  return null;
}

function legacyPromptContent(value) {
  const source = text(value);
  const lines = promptLines(source);
  const visualHeading = /^(?:画面(?:内容|描述)?|视觉(?:内容|描述)?|镜头(?:内容|描述|画面|设计)|分镜(?:内容|画面))(?:\s*[：:]\s*.*)?$/;
  const timecode = /^(?:镜头\s*\d+\s*[：:、]?\s*)?[\[【（(]?\s*(?:\d{1,2}:)?\d{1,2}(?:\.\d+)?\s*(?:秒|s)?\s*[-—–~～至到]\s*(?:\d{1,2}:)?\d{1,2}(?:\.\d+)?\s*(?:秒|s)?\s*[\]】）)]?(?:\s|[：:]|$)/i;
  const otherHeading = /^(?:人物|角色|场景(?:名称)?|道具|声音|音效|音乐|配音|对白|旁白|负面提示词|统一附加词|全局(?:设定|约束)|参考(?:图|素材))\s*[：:]/;
  const visual = [];
  let active = false;
  for (const line of lines) {
    if (visualHeading.test(line.label) || timecode.test(line.label)) active = true;
    else if (otherHeading.test(line.label)) active = false;
    if (active) visual.push(line.original);
  }
  const extracted = visual.join('\n').trim();
  // These labels make it clear that an old prompt is being displayed verbatim,
  // rather than presenting it as a newly generated plot summary.
  return extracted
    ? { content: `旧版提示词提取：\n${extracted}` }
    : { content: `旧版提示词原文：\n${source}` };
}

function resolveScene(shot, scenes) {
  const explicit = text(shot.scene) || text(shot.sceneName) || text(shot.location);
  if (explicit) return plainText(explicit);
  const id = text(shot.sceneId);
  const match = scenes.find((scene) => [scene.id, scene.sceneId, scene.name].some((value) => text(value) && text(value) === id));
  if (match && text(match.name || match.label || match.title)) return plainText(match.name || match.label || match.title);

  const uploads = Array.isArray(shot.uploads) ? shot.uploads : [];
  const uploadedNames = new Set();
  for (const upload of uploads) {
    const names = [upload?.asset, upload?.ref, upload?.name].map(referenceName).filter(Boolean);
    const uploadedScene = scenes.find((scene) => [scene.id, scene.sceneId, scene.name].map(referenceName).some((name) => name && names.includes(name)));
    if (uploadedScene && text(uploadedScene.name || uploadedScene.label || uploadedScene.title)) uploadedNames.add(plainText(uploadedScene.name || uploadedScene.label || uploadedScene.title));
    else if (/场景|scene|location/i.test(text(upload?.type || upload?.kind || upload?.purpose)) && names.length) uploadedNames.add(names[0]);
  }
  if (uploadedNames.size === 1) return [...uploadedNames][0];
  return promptScene(shot.prompt) || humanizeSceneId(id) || UNKNOWN_SCENE;
}

function legacyContent(shot) {
  const title = plainText(shot.title);
  const segments = (Array.isArray(shot.segments) ? shot.segments : []).map((segment) => {
    if (typeof segment === 'string') return text(segment);
    const visual = text(segment?.visual || segment?.content || segment?.description);
    return visual ? [text(segment.time), visual].filter(Boolean).join('：') : '';
  }).filter(Boolean);
  const states = [text(shot.startState), text(shot.endState)].filter(Boolean);
  if (!segments.length && !states.length && text(shot.prompt)) {
    const fallback = legacyPromptContent(shot.prompt);
    return { content: [title, fallback.content].filter(Boolean).join('\n') };
  }
  const body = segments.length ? segments.join('\n') : states.join('\n');
  const full = [title, body].filter(Boolean).join('\n') || UNKNOWN_CONTENT;
  // Old projects can contain entire production prompts in each visual segment.
  // Keep ordinary rows intact, and retain unusually long source text in a disclosure.
  if (full.length <= 900) return { content: full };
  const focus = states.length ? states.join('；') : segments[0] || body;
  const brief = focus.length > 420 ? `${focus.slice(0, 420)}…` : focus;
  return { content: [title, brief].filter(Boolean).join('\n'), details: full };
}

/** Build rows from the final shots, so repairs cannot leave a stale outline behind. */
export function buildStoryboardOutline(storyboard = {}, assets = {}) {
  const scenes = sceneAssets(assets);
  const rows = (Array.isArray(storyboard?.shots) ? storyboard.shots : []).map((value, index) => {
    const shot = value && typeof value === 'object' ? value : {};
    const no = text(shot.no) || String(index + 1).padStart(2, '0');
    const content = text(shot.outline) ? { content: text(shot.outline) } : legacyContent(shot);
    return {
      no: /^\d$/.test(no) ? no.padStart(2, '0') : no,
      duration: text(shot.duration) ? durationSeconds(shot.duration) : promptDuration(shot.prompt),
      scene: resolveScene(shot, scenes),
      title: plainText(shot.title),
      ...content,
    };
  });
  return {
    rows,
    count: rows.length,
    totalDuration: Number(rows.reduce((total, row) => total + (row.duration ?? 0), 0).toFixed(3)),
    unknownDurationCount: rows.filter((row) => row.duration === null).length,
  };
}

function durationLabel(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? `${value}秒` : '待定';
}

// Display and copy a brief outline without changing the confirmed source rows.
// Older projects can still store complete production prompts in their outline.
export function briefOutlineContent(row = {}) {
  const source = plainText(row.content || row.details);
  const timeSlice = /(?<!\d)(?:镜头\s*\d+\s*[（(]?\s*)?[\[【（(]?\s*(?:\d{1,2}:\d{1,2}(?:\.\d+)?\s*[-—–~～至到]\s*\d{1,2}:\d{1,2}(?:\.\d+)?|\d{1,2}(?:\.\d+)?\s*(?:秒|s)?\s*[-—–~～至到]\s*\d{1,2}(?:\.\d+)?(?!\d)\s*(?:秒|s\b))\s*[\]】）)]?\s*[：:]?/gi;
  const prefixTimeSlice = /^(?:镜头\s*\d+\s*[：:]?\s*)?(?:[\[【（(]\s*\d{1,2}(?:\.\d+)?\s*[-—–~～至到]\s*\d{1,2}(?:\.\d+)?\s*[\]】）)]|\d{1,2}(?:\.\d+)?\s*[-—–~～至到]\s*\d{1,2}(?:\.\d+)?\s*[：:])\s*[：:]?\s*/i;
  const lines = source.replace(/^旧版提示词(?:提取|原文)[：:]\s*/u, '').split(/\r?\n/).map(line => line.replace(/^#{1,6}\s*/, '').trim()).filter(Boolean);
  const sliced = timeSlice.test(source) || lines.some(line => prefixTimeSlice.test(line));
  timeSlice.lastIndex = 0;
  const metadata = /^(?:人物|角色|场景|道具|本段总时长|总时长|视频时长|时长|声音|音效|配音|旁白|对白|字幕|BGM|统一附加词|参考素材)\s*[：:]/i;
  const first = lines[0] || '';
  const title = plainText(row.title) || (sliced && first.length <= 40 && !metadata.test(first) && !/\d\s*[-—–~～至到]/.test(first) ? first : '');
  // Existing timed scripts often start with a useful block title. Reuse it
  // rather than inventing a plot summary or exposing the detailed prompt.
  const content = lines.filter(line => !metadata.test(line)).map(line => line.replace(prefixTimeSlice, '')).join(' ')
    .replace(timeSlice, '')
    .replace(/【(?:配音|音效|声音|旁白|对白|字幕|BGM)[：:][\s\S]*?】/gi, '')
    .replace(/^(?:画面(?:内容|描述)?|视觉(?:内容|描述)?|镜头(?:内容|描述|画面|设计))\s*[：:]\s*/u, '')
    .replace(/\s+/g, ' ').trim();
  let brief = content.length > 160 && title ? title : content;
  brief = (brief.match(/[^。！？!?]+[。！？!?]?/gu) || []).slice(0, 2).join('').trim();
  if (Array.from(brief).length > 160) brief = Array.from(brief).slice(0, 159).join('').replace(/[，,；;：:\s]+$/u, '') + '…';
  return brief || UNKNOWN_CONTENT;
}

/** The first workflow step is a plain, accessible four-column outline table. */
export function storyboardOutlineTemplate(outline = {}) {
  const rows = Array.isArray(outline.rows) ? outline.rows : [];
  return `<div class="storyboard-outline"><div class="storyboard-outline-scroll" tabindex="0" role="region" aria-label="分镜大纲表格"><table class="storyboard-outline-table"><caption class="storyboard-outline-caption">分镜大纲</caption><colgroup><col class="outline-no"><col class="outline-duration"><col class="outline-scene"><col class="outline-content"></colgroup><thead><tr>${HEADERS.map((header) => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><th scope="row">${escapeHtml(plainText(row.no))}</th><td class="outline-duration-cell">${escapeHtml(durationLabel(row.duration))}</td><td>${contentHtml(row.scene || UNKNOWN_SCENE)}</td><td class="outline-content-cell"><div>${contentHtml(briefOutlineContent(row))}</div></td></tr>`).join('') : '<tr><td class="storyboard-outline-empty" colspan="4">暂无分镜大纲，请先生成分镜。</td></tr>'}</tbody></table></div></div>`;
}

/** Markdown copies the same brief four-column outline shown on screen. */
export function serializeStoryboardOutline(outline = {}) {
  const cell = (value) => plainText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const rows = Array.isArray(outline.rows) ? outline.rows : [];
  return [
    `| ${HEADERS.join(' | ')} |`,
    '| --- | ---: | --- | --- |',
    ...rows.map((row) => `| ${[row.no, durationLabel(row.duration), row.scene || UNKNOWN_SCENE, briefOutlineContent(row)].map(cell).join(' | ')} |`),
  ].join('\n');
}
