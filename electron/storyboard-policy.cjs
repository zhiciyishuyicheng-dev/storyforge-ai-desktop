'use strict';

// Deterministic checks complement the independent editorial audit. They do not
// claim to prove story meaning, voice performance, or rendered video continuity.
const { VERSION, AUDIT_RULE_IDS } = require('./storyboard-skill.cjs');
const { normalizeStageSkills, stageSkillReferences } = require('./stage-skills.cjs');

const BATCH_RULE_IDS = ['A1', 'A2', 'A3', 'A4', 'H1', 'H2', 'H3', 'H4', 'H5'];
const STATUSES = new Set(['通过', '不适用', '本次被覆盖', '失败', '阻塞']);
const ALWAYS_APPLICABLE = new Set(['A1', 'A4', 'B1', 'B2', 'B3', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'E1', 'E3', 'E10', 'E11', 'E12', 'G1', 'G2', 'G4', 'G5', 'G6', 'G7']);
const VOICE_TYPES = new Set(['对白', '心声', '旁白', '系统音', '电话音', '画外音', '场景内播放音']);
const ASSET_KINDS = ['characters', 'scenes', 'groups', 'props'];
const clean = value => typeof value === 'string' ? value.trim() : '';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blockNo = value => /^\d+$/.test(String(value ?? '')) ? String(Number(value)).padStart(2, '0') : String(value ?? '');
const textEqual = (a, b) => String(a ?? '').trim().replace(/\r\n/g, '\n') === String(b ?? '').trim().replace(/\r\n/g, '\n');
const rules = Array.isArray(AUDIT_RULE_IDS) ? AUDIT_RULE_IDS : Object.values(AUDIT_RULE_IDS).flat();

function contextOf(context = {}) {
  return { mode: 'locked', scope: '全文', startBlock: 1, ratio: '9:16', maxDuration: 15, maxShots: 5, precision: 'integer', ...context };
}

function boardOf(candidate) {
  return candidate?.storyboard ?? candidate;
}

function error(code, message, no, ruleId) {
  return { code, ...(no ? { blockNo: no } : {}), ...(ruleId ? { ruleId } : {}), message };
}

function timeRange(time) {
  const match = clean(time).match(/^\[?(\d+(?:\.\d+)?)\s*[-—–至]\s*(\d+(?:\.\d+)?)\s*秒\]?$/u);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function promptSegments(prompt) {
  const expression = /^\s*\[(\d+(?:\.\d+)?\s*[-—–至]\s*\d+(?:\.\d+)?\s*秒)\]\s*/gmu;
  const matches = [...prompt.matchAll(expression)];
  return matches.map((match, index) => ({
    time: timeRange(match[1]),
    visual: prompt.slice(match.index + match[0].length, matches[index + 1]?.index ?? prompt.length).trim(),
    index: match.index,
  }));
}

function spokenFields(visual) {
  return [...String(visual).matchAll(/【配音(?:（([^）]+)）)?[：:]([^；】]+)；([^】]*?)台词[：:]\s*“([\s\S]*?)”\s*】/gu)].map(match => ({
    type: match[1] || '对白', speaker: match[2].trim(), detail: match[3], text: match[4], field: match[0],
  }));
}

function genuineBlocker(blocker) {
  if (!blocker || !clean(blocker.id) || !clean(blocker.reason) || !clean(blocker.question) || !clean(blocker.missingInformation)) return false;
  if (!Array.isArray(blocker.affectedBlockNos) || !blocker.affectedBlockNos.length || blocker.affectedBlockNos.some(no => !/^\d+$/.test(String(no)))) return false;
  // A service or formatting failure cannot be reclassified as missing story facts.
  return !/(?:JSON.{0,20}(?:截断|解析)|(?:技术|请求|网络|接口|API).{0,20}(?:失败|超时)|(?:重试|回炉).{0,20}(?:耗尽|上限|次数)|(?:tokens?|令牌).{0,20}(?:不足|上限))/iu.test(`${blocker.reason} ${blocker.missingInformation}`);
}

function hasGenuineBlockers(candidate, audit) {
  return [boardOf(candidate)?.blockers, audit?.blockers].some(items => Array.isArray(items) && items.some(genuineBlocker));
}

function customStoryboardSkill(context) {
  return normalizeStageSkills(context?.stageSkills).storyboard;
}

function validAssetReference(upload) {
  if (!isObject(upload) || !clean(upload.asset) || upload.asset !== upload.asset.trim() || /[@\r\n\x00-\x1f]/u.test(upload.asset)) return false;
  // Imported projects may still carry platform-style image markers. New
  // generations use the full asset name, while either form keeps one identity.
  return upload.ref === `@${upload.asset}` || /^@Image[1-9]\d*$/u.test(upload.ref ?? '');
}

function referenceOccurrences(text, uploads) {
  const known = [...new Set(uploads.map(upload => upload?.ref).filter(ref => typeof ref === 'string' && ref.startsWith('@')))].sort((a, b) => b.length - a.length);
  const markers = [...text.matchAll(/@/gu)].map(match => {
    const rest = text.slice(match.index);
    const ref = known.find(value => rest.startsWith(value) && !/^[\p{L}\p{N}_·-]/u.test(rest.slice(value.length)))
      ?? rest.match(/^@[^\s@，。；、：:（）()[\]{}!?！？“”"‘’<>,;]+/u)?.[0] ?? '@';
    return { ref, index: match.index };
  });
  return markers.map((marker, index) => ({ ref: marker.ref, text: text.slice(marker.index + marker.ref.length, markers[index + 1]?.index ?? text.length) }));
}

function customIdentityErrors(candidate) {
  const assets = ASSET_KINDS.flatMap(kind => Array.isArray(candidate?.assets?.[kind]) ? candidate.assets[kind] : []);
  const names = assets.map(item => item?.name);
  const errors = [];
  if (new Set(names).size !== names.length) errors.push(error('CUSTOM_ASSET_IDENTITY', '用户 Skill 不能把不同素材映射为同名身份。', null, '身份'));
  for (const shot of candidate?.storyboard?.shots ?? []) {
    const references = new Set();
    const usedAssets = new Set();
    for (const upload of Array.isArray(shot?.uploads) ? shot.uploads : []) {
      if (!validAssetReference(upload) || !names.includes(upload.asset) || references.has(upload.ref) || usedAssets.has(upload.asset)) {
        errors.push(error('CUSTOM_REFERENCE_IDENTITY', '素材引用须为唯一的@准确素材名，并与素材清单中的身份逐字对应；旧项目编号也必须唯一绑定真实素材。', blockNo(shot?.no), '身份'));
      }
      references.add(upload?.ref);
      usedAssets.add(upload?.asset);
    }
  }
  return errors;
}

function videoDurationErrors(candidate, context) {
  if (context?.videoReady !== true) return [];
  const shots = Array.isArray(boardOf(candidate)?.shots) ? boardOf(candidate).shots : [];
  return shots.flatMap(shot => Number.isInteger(shot?.duration) && shot.duration >= 4 && shot.duration <= 15 ? [] : [
    error('VIDEO_DURATION', 'Seedance 批量生成要求每块原始 duration 为4—15秒整数；请在自然声画边界合并短块或拆分长块，不得只改秒数、取整、静默拉伸或补空镜凑时。', blockNo(shot?.no), '视频平台'),
  ]);
}

// Audit warnings may be bypassed after repair; unreadable data cannot. Keep this
// delivery-shape check separate from story, timing, voice and reference rules.
function outlineErrors(candidate) {
  // Old saved responses used analysis; those display from their final shots.
  // New responses must supply a compact outline on each corresponding block.
  if (!Object.hasOwn(candidate ?? {}, 'outline') && isObject(candidate?.analysis)) return [];
  if (!isObject(candidate?.outline)) return [error('OUTLINE_SHAPE', '缺少分镜大纲对象。', null, 'G7')];
  const errors = [];
  if (!clean(candidate.outline.title)) errors.push(error('OUTLINE_TITLE', '分镜大纲缺少标题。', null, 'G7'));
  for (const shot of Array.isArray(candidate?.storyboard?.shots) ? candidate.storyboard.shots : []) {
    if (!clean(shot?.outline) || !clean(shot?.scene)) errors.push(error('OUTLINE_BLOCK_FIELDS', '每个生成块须包含场景 scene 及剧情内容与镜头重点 outline，与本块实际内容一致。', blockNo(shot?.no), 'G7'));
  }
  return errors;
}

function canPublishIgnoredCandidate(candidate, { context } = {}) {
  if (!isObject(candidate) || (!isObject(candidate.outline) && !isObject(candidate.analysis)) || !isObject(candidate.assets) || !isObject(candidate.storyboard)) return false;
  const { assets, storyboard: board } = candidate;
  if (![...ASSET_KINDS, 'characterChecklist', 'characterDifferenceMatrix'].every(key => Array.isArray(assets[key]) && assets[key].every(isObject))) return false;
  if (ASSET_KINDS.some(key => assets[key].some(item => !clean(item.name) || !clean(item.fileName) || (context?.stage !== 'storyboard' && !clean(item.prompt))))) return false;
  if (!Array.isArray(board.shots) || !board.shots.length || hasGenuineBlockers(candidate)) return false;
  const readable = board.shots.every(shot => isObject(shot) && ['string', 'number'].includes(typeof shot.no) && clean(String(shot.no)) && clean(shot.prompt)
    && typeof shot.duration === 'number' && Number.isFinite(shot.duration) && shot.duration > 0
    && Array.isArray(shot.segments) && shot.segments.every(item => isObject(item) && clean(item.visual))
    && Array.isArray(shot.uploads) && shot.uploads.every(isObject));
  return readable && (!customStoryboardSkill(context) || customIdentityErrors(candidate).length === 0);
}

function validateCandidate(candidate, { script, context } = {}) {
  if (customStoryboardSkill(context)) {
    const shots = candidate?.storyboard?.shots;
    const errors = !Array.isArray(shots) || !shots.length
      ? [error('NO_BLOCKS', '没有可交付生成块；缺材料时须明确报告阻塞。')]
      : !canPublishIgnoredCandidate({ ...candidate, storyboard: { ...candidate.storyboard, blockers: [] } }, { context: { stage: context?.stage } }) ? [error('CUSTOM_CANDIDATE_SHAPE', '用户 Skill 结果缺少可展示的完整分镜大纲、分镜或素材结构。')]
        : [...outlineErrors(candidate), ...customIdentityErrors(candidate)];
    errors.push(...videoDurationErrors(candidate, context));
    return { valid: errors.length === 0, errors, blockNos: Array.isArray(shots) ? shots.map(shot => blockNo(shot?.no)) : [], scope: '用户 Skill · 文本与计划' };
  }
  const config = contextOf(context);
  const board = boardOf(candidate);
  const errors = videoDurationErrors(candidate, context);
  const add = (code, message, no, ruleId) => errors.push(error(code, message, no, ruleId));
  if (!board || typeof board !== 'object') return { valid: false, errors: [error('CANDIDATE_SHAPE', '缺少分镜对象。')] };
  if (board.skillVersion !== VERSION) add('SKILL_VERSION', `分镜必须采用 Skill v${VERSION}。`, null, 'G7');
  if (typeof board.unifiedSuffix !== 'string' || board.unifiedSuffix !== '') add('UNIFIED_SUFFIX', '每块应自带一次风格段，统一附加词必须为空。', null, 'G7');
  const shots = Array.isArray(board.shots) ? board.shots : [];
  if (!shots.length) add('NO_BLOCKS', '没有可交付生成块；缺材料时须明确报告阻塞。', null, 'A1');
  errors.push(...outlineErrors(candidate));
  const assets = candidate?.assets;
  if (!isObject(assets) || [...ASSET_KINDS, 'characterChecklist', 'characterDifferenceMatrix'].some(key => !Array.isArray(assets[key]))) add('ASSETS_SHAPE', '参考素材须包含四类素材数组、人物清单与差异矩阵；不需要人物图时相关数组可为空。', null, 'G1');
  const assetItems = ASSET_KINDS.flatMap(kind => Array.isArray(assets?.[kind]) ? assets[kind] : []);
  const assetNames = new Set();
  const fileNames = new Set();
  assetItems.forEach(asset => {
    if (!isObject(asset) || !clean(asset.name) || asset.name !== asset.name.trim() || !clean(asset.fileName) || (context?.stage !== 'storyboard' && !clean(asset.prompt))) { add('ASSET_FIELDS', context?.stage === 'storyboard' ? '每个参考素材身份须有准确名称和独立文件名。' : '每个实际参考图素材须有准确名称、独立文件名和完整生图提示词。', null, 'G1'); return; }
    if (assetNames.has(asset.name)) add('ASSET_NAME_DUPLICATE', '所有参考素材的 name 必须全局唯一，避免引用绑定歧义。', null, 'G1');
    assetNames.add(asset.name);
    if (!/^[^<>:"/\\|?*\x00-\x1f]+\.(?:png|jpe?g|webp|bmp)$/iu.test(asset.fileName) || asset.fileName !== asset.fileName.trim()) add('ASSET_FILENAME', '参考素材文件名须为有效的独立图片文件名，不能包含目录或非法字符。', null, 'G1');
    const fileKey = asset.fileName.toLocaleLowerCase('en-US');
    if (fileNames.has(fileKey)) add('ASSET_FILENAME_DUPLICATE', '参考素材文件名必须全局唯一。', null, 'G1');
    fileNames.add(fileKey);
  });
  const imageCharacterNames = new Set((Array.isArray(assets?.characters) ? assets.characters : []).map(item => item?.name));
  const checklistNames = new Set();
  for (const item of Array.isArray(assets?.characterChecklist) ? assets.characterChecklist : []) {
    if (!isObject(item) || !clean(item.name) || typeof item.requiresReferenceImage !== 'boolean') { add('CHARACTER_CHECKLIST', '人物清单必须给出名称及是否需要独立参考图。', null, 'G1'); continue; }
    if (checklistNames.has(item.name)) add('CHARACTER_CHECKLIST_DUPLICATE', '人物清单不得重复登记同一人物。', null, 'G1');
    checklistNames.add(item.name);
    if (item.requiresReferenceImage && !imageCharacterNames.has(item.name)) add('REQUIRED_CHARACTER_IMAGE', `人物“${item.name}”需要参考图但没有准确对应的人物素材。`, null, 'G1');
  }
  if ((Array.isArray(assets?.characterDifferenceMatrix) ? assets.characterDifferenceMatrix : []).some(item => !isObject(item) || !clean(item.name))) add('CHARACTER_MATRIX', '人物差异矩阵项目必须具有准确人物名称。', null, 'G1');
  const sourceArrays = ['voiceSources', 'voiceFragments', 'deferredVoices', 'blockers'];
  for (const key of sourceArrays) if (!Array.isArray(board[key])) add('RECORD_ARRAY', `${key} 必须是数组，无内容时使用空数组。`, null, 'G7');
  const recordArrays = [shots, ...sourceArrays.map(key => Array.isArray(board[key]) ? board[key] : [])];
  if (recordArrays.some(items => items.some(item => !item || typeof item !== 'object' || Array.isArray(item)))) {
    add('RECORD_SHAPE', '生成块、声音与阻塞记录中的每一项都必须是对象。', null, 'G7');
    return { valid: false, errors, blockNos: [], scope: '文本与计划' };
  }
  const blockers = Array.isArray(board.blockers) ? board.blockers : [];
  for (const blocker of blockers) if (!genuineBlocker(blocker)) add('INVALID_BLOCKER', '阻塞必须说明真实缺失信息、最小问题和受影响块号；技术失败不能伪装成剧情阻塞。');
  const names = assetNames;
  const noSet = new Set();
  const shotMap = new Map();
  const parsed = new Map();
  shots.forEach((shot, index) => {
    const no = blockNo(shot?.no);
    const expected = blockNo(Number(config.startBlock) + index);
    if (!shot || typeof shot !== 'object') { add('BLOCK_SHAPE', '生成块必须是对象。', expected, 'G7'); return; }
    if (shot.no !== expected || noSet.has(no)) add('BLOCK_NUMBER', `生成块应按顺序编号为 ${expected}，不得漏号或重复。`, no || expected, 'A4');
    noSet.add(no);
    shotMap.set(no, shot);
    if (!clean(shot.title)) add('BLOCK_TITLE', '缺少生成块标题。', no, 'G7');
    if (!clean(shot.sceneId)) add('SCENE_ID', '缺少内部叙事场景标识。', no, 'B1');
    if (!clean(shot.startState) || !clean(shot.endState)) add('BLOCK_STATE', '必须记录具体块头、块尾状态。', no, 'B5');
    if (typeof shot.duration !== 'number' || !Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > config.maxDuration) add('BLOCK_DURATION', `块时长必须大于 0 且不超过 ${config.maxDuration} 秒。`, no, 'C1');
    if (config.precision === 'integer' && !Number.isInteger(shot.duration)) add('TIME_PRECISION', '默认块总时长必须采用整数秒。', no, 'C5');
    const segments = Array.isArray(shot.segments) ? shot.segments : [];
    if (!segments.length || segments.length > config.maxShots) add('SHOT_COUNT', `每块必须有 1 至 ${config.maxShots} 个实际镜头。`, no, 'C2');
    let previous = 0;
    segments.forEach((segment, segmentIndex) => {
      const range = timeRange(segment?.time);
      if (!range || range[0] !== previous || range[1] <= range[0]) add('TIMELINE', `第 ${segmentIndex + 1} 镜时间码必须连续、从 0 开始且没有重叠或空档。`, no, 'C5');
      if (range && config.precision === 'integer' && range.some(value => !Number.isInteger(value))) add('TIME_PRECISION', '默认镜头切点必须采用整数秒。', no, 'C5');
      if (range) previous = range[1];
      if (!clean(segment?.visual)) add('SEGMENT_TEXT', `第 ${segmentIndex + 1} 镜缺少正文。`, no, 'G7');
      if (String(segment?.visual ?? '').includes('@')) add('INLINE_REFERENCE', '@ 只能写在开头资产声明，不得出现在时间片正文。', no, 'G4');
    });
    if (segments.length && previous !== shot.duration) add('TIMELINE_END', '末镜结束点必须等于块总时长。', no, 'C5');
    const prompt = typeof shot.prompt === 'string' ? shot.prompt : '';
    const body = promptSegments(prompt);
    parsed.set(no, body);
    if (body.length !== segments.length || body.some((item, itemIndex) => {
      const range = timeRange(segments[itemIndex]?.time);
      return !range || item.time?.[0] !== range[0] || item.time?.[1] !== range[1] || !textEqual(item.visual, segments[itemIndex]?.visual);
    })) add('PROMPT_TIMELINE_MISMATCH', '复制正文与结构化镜头的时间码及完整正文必须一致。', no, 'G7');
    const header = prompt.match(/^🎬\s*生成块\s*(\d+)\s*[（(]时长[：:]\s*(\d+(?:\.\d+)?)\s*秒[）)]\s*$/mu);
    if (!header || blockNo(header[1]) !== no || Number(header[2]) !== shot.duration || [...prompt.matchAll(/^🎬\s*生成块/gmu)].length !== 1) add('PROMPT_HEADER', '正文必须采用第十四节标题，块号与时长须一致。', no, 'G7');
    const total = [...prompt.matchAll(/^本段总时长[：:]\s*(\d+(?:\.\d+)?)\s*秒\s*$/gmu)];
    if (total.length !== 1 || Number(total[0][1]) !== shot.duration) add('PROMPT_TOTAL', '正文须有一次与块时长一致的“本段总时长”。', no, 'G7');
    const preface = prompt.slice(0, body[0]?.index ?? prompt.length);
    const styleLines = prompt.split(/\r?\n/u).filter(line => /^（.+）$/u.test(line.trim()));
    if (styleLines.length !== 1 || !preface.includes(styleLines[0])) add('STYLE_COUNT', '每块正文开头须有且仅有一次独立风格段。', no, 'G7');
    if (!config.overrides?.G6 && (!styleLines[0]?.includes('无对白字幕') || !styleLines[0]?.includes('无BGM'))) add('DEFAULT_STYLE', '默认风格段须明确无对白字幕、无BGM。', no, 'G6');
    if ([...preface.matchAll(/^场景[：:]/gmu)].length !== 1) add('SCENE_DECLARATION', '每块须在开头声明一次主要场景。', no, 'G7');
    if (!/^空间与位置保持稳定[：:]\s*\S/mu.test(preface)) add('SPATIAL_PREFACE', '每块正文须独立写清具体空间关系。', no, 'B2');
    const uploads = Array.isArray(shot.uploads) ? shot.uploads : [];
    if (!uploads.length || uploads.length > 9) add('UPLOAD_COUNT', '每块须声明实际使用的参考素材，最多九项。', no, 'G1');
    const usedNames = new Set();
    const usedRefs = new Set();
    uploads.forEach(upload => {
      if (!validAssetReference(upload) || usedRefs.has(upload?.ref)) add('UPLOAD_REF', '引用须为唯一的@准确素材名并逐字匹配素材身份；兼容旧编号但不要求连续编号。', no, 'G1');
      usedRefs.add(upload?.ref);
      if (!names.has(upload?.asset)) add('UPLOAD_ASSET', `素材“${upload?.asset ?? ''}”未与素材清单中的 name 逐字对应。`, no, 'G1');
      if (usedNames.has(upload?.asset)) add('DUPLICATE_ASSET', '同一素材在一块内只能使用一个引用名称。', no, 'G1');
      usedNames.add(upload?.asset);
      if (!clean(upload?.purpose)) add('UPLOAD_PURPOSE', '每项素材须声明本块用途。', no, 'G1');
      const ref = upload?.ref;
      const declarationLines = preface.split(/\r?\n/u).filter(line => /^(?:人物|场景|道具|群像)[：:]/u.test(line));
      const occurrences = declarationLines.flatMap(line => referenceOccurrences(line, uploads));
      const matches = occurrences.filter(item => item.ref === ref);
      const named = validAssetReference(upload) && ref === `@${upload.asset}`;
      if (matches.length !== 1 || (!named && !matches[0]?.text.includes(String(upload?.asset)))) add('UPLOAD_DECLARATION', `正文开头必须把 ${ref ?? '@准确素材名'} 与准确素材名称唯一对应。`, no, 'G1');
    });
    const declaredRefs = new Set(uploads.map(upload => upload?.ref));
    for (const line of prompt.split(/\r?\n/u)) {
      if (!line.includes('@')) continue;
      const refs = referenceOccurrences(line, uploads).map(item => item.ref);
      const assetLine = /^(?:人物|场景|道具|群像)[：:]/u.test(line) && prompt.indexOf(line) < (body[0]?.index ?? prompt.length);
      if (!assetLine || refs.some(ref => !declaredRefs.has(ref))) add('REFERENCE_LOCATION', '@ 只能出现在开头的有效素材声明中，且须与 uploads 一致。', no, 'G4');
    }
  });

  const sources = Array.isArray(board.voiceSources) ? board.voiceSources : [];
  const fragments = Array.isArray(board.voiceFragments) ? board.voiceFragments : [];
  const deferred = Array.isArray(board.deferredVoices) ? board.deferredVoices : [];
  const sourceMap = new Map();
  let previousSourceEnd = 0;
  sources.forEach((source, index) => {
    if (!/^S\d{3,}$/u.test(source?.id ?? '') || sourceMap.has(source?.id)) add('VOICE_SOURCE_ID', '声音来源须采用唯一 S 编号。', null, 'D1');
    sourceMap.set(source?.id, { ...source, order: index });
    if (!clean(source?.speaker) || !VOICE_TYPES.has(source?.type) || !clean(source?.text)) add('VOICE_SOURCE', '声音来源须包含说话者、有效声音类型和准确原文。', null, 'D1');
    if (config.mode !== 'adaptation') {
      const origin = typeof script === 'string' ? script : '';
      const position = clean(source?.text) ? origin.indexOf(source.text, previousSourceEnd) : -1;
      if (position < 0) add('VOICE_NOT_IN_ORIGINAL', '锁稿声音必须按顺序逐字回查用户原始输入，不能只核对模型内部表格。', null, 'D1');
      else previousSourceEnd = position + source.text.length;
    }
  });
  const fragmentIds = new Set();
  const bySource = new Map(sources.map(source => [source.id, []]));
  const bySegment = new Map();
  const voiceIds = new Map();
  let previousPlacement = [-1, -1];
  let previousSourceOrder = -1;
  fragments.forEach(fragment => {
    const no = blockNo(fragment?.blockNo);
    const shot = shotMap.get(no);
    const source = sourceMap.get(fragment?.sourceId);
    if (!/^F\d{3,}$/u.test(fragment?.id ?? '') || fragmentIds.has(fragment?.id)) add('VOICE_FRAGMENT_ID', '声音片段须采用唯一 F 编号。', no, 'D1');
    fragmentIds.add(fragment?.id);
    if (!source) add('VOICE_SOURCE_REFERENCE', '声音片段引用了不存在的来源。', no, 'D1');
    if (!shot || !Number.isInteger(fragment?.segmentIndex) || fragment.segmentIndex < 1 || fragment.segmentIndex > (shot?.segments?.length ?? 0)) add('VOICE_PLACEMENT', '每个声音片段必须定位到实际生成块与镜头。', no, 'D7');
    if (!clean(fragment?.text)) add('VOICE_FRAGMENT_TEXT', '声音片段不得为空。', no, 'D1');
    const placement = [shots.indexOf(shot), fragment?.segmentIndex];
    if (placement[0] < previousPlacement[0] || (placement[0] === previousPlacement[0] && placement[1] < previousPlacement[1]) || (source && source.order < previousSourceOrder)) add('VOICE_ORDER', '声音片段必须采用原声顺序和实际时间线顺序。', no, 'H2');
    previousPlacement = placement;
    if (source) previousSourceOrder = source.order;
    bySource.get(fragment?.sourceId)?.push(fragment);
    const key = `${no}:${fragment?.segmentIndex}`;
    if (!bySegment.has(key)) bySegment.set(key, []);
    bySegment.get(key).push(fragment);
    if (fragment?.voiceId !== undefined || fragment?.covers !== undefined) {
      const covers = fragment?.covers;
      if (!/^V\d{2,}$/u.test(fragment?.voiceId ?? '') || !Array.isArray(covers) || covers.length < 2 || covers[0] !== fragment.segmentIndex || covers.some((value, index) => !Number.isInteger(value) || value !== covers[0] + index || value > (shot?.segments?.length ?? 0))) add('VOICE_COVERAGE', '跨镜声音须有本块唯一 V 编号，并连续覆盖从首次发声镜头开始的至少两镜。', no, 'D7');
      const voiceKey = `${no}:${fragment?.voiceId}`;
      if (voiceIds.has(voiceKey)) add('DUPLICATE_VOICE_ID', 'V 编号在同一生成块内不得重复定义。', no, 'D7');
      voiceIds.set(voiceKey, fragment);
    }
  });
  const deferredMap = new Map();
  deferred.forEach(item => {
    if (!sourceMap.has(item?.sourceId) || !clean(item?.text) || !clean(item?.reason) || deferredMap.has(item?.sourceId)) add('DEFERRED_VOICE', '每条顺延必须指向有效来源的唯一准确尾段，并说明原因。', null, 'H2');
    if (!blockers.some(genuineBlocker)) add('DEFERRED_WITHOUT_BLOCKER', '全文生成仅能因真实阻塞顺延尾段，不能用顺延掩盖漏词。', null, 'H2');
    deferredMap.set(item?.sourceId, item);
  });
  let sawDeferred = false;
  sources.forEach(source => {
    const presented = bySource.get(source.id) ?? [];
    if (sawDeferred && presented.length) add('DEFERRED_ORDER', '锁稿顺延必须是有序尾段，不能跳过未完成声音提前呈现后文。', null, 'H2');
    const tail = deferredMap.get(source.id)?.text ?? '';
    if (presented.map(fragment => fragment.text).join('') + tail !== source.text) add('VOICE_COVERAGE_TEXT', '声音片段与合法顺延尾段逐字拼接后必须等于有效原声，不能漏词、改写或重叠。', null, 'D1');
    if (tail) sawDeferred = true;
  });
  shots.forEach(shot => {
    const no = blockNo(shot.no);
    (Array.isArray(shot.segments) ? shot.segments : []).forEach((segment, index) => {
      if (!segment || typeof segment !== 'object') { add('SEGMENT_SHAPE', '每个镜头必须是对象。', no, 'G7'); return; }
      const fields = spokenFields(segment.visual);
      const assigned = bySegment.get(`${no}:${index + 1}`) ?? [];
      if (fields.length !== assigned.length || fields.some((field, fieldIndex) => field.text !== assigned[fieldIndex]?.text)) add('SPOKEN_TEXT_MISMATCH', `第 ${index + 1} 镜实际配音与声音片段记录不一致。`, no, 'D1');
      fields.forEach((field, fieldIndex) => {
        const fragment = assigned[fieldIndex];
        const source = sourceMap.get(fragment?.sourceId);
        if (!/声音表现[：:]\s*[^；】]/u.test(field.detail) || (['对白', '心声'].includes(field.type) && !/状态[：:]\s*[^；】]/u.test(field.detail))) add('VOICE_FIELD_FORMAT', '配音字段须含本次声音表现；对白与心声还须标明当前状态。', no, 'G7');
        if (source && (field.speaker !== source.speaker || field.type !== source.type)) add('SPEAKER_TYPE_MISMATCH', '正文中的说话者与声音类型必须和原声记录一致。', no, 'D9');
        if (fragment?.voiceId) {
          const covers = fragment.covers ?? [];
          const declaration = new RegExp(`语段${fragment.voiceId}连续覆盖第${covers[0]}[—–-]${covers[covers.length - 1]}镜`, 'u');
          if (!declaration.test(field.detail)) add('VOICE_DECLARATION', '跨镜完整台词须仅在首次镜头声明正确 V 编号与覆盖区间。', no, 'D7');
        } else if (/语段V\d+/u.test(field.detail)) add('UNTRACKED_VOICE_ID', '正文中的跨镜语段缺少一致的声音覆盖记录。', no, 'D7');
      });
      const continuations = [...String(segment.visual).matchAll(/【续音[：:]([^】]+)】/gu)];
      const expected = [...voiceIds.entries()].filter(([key, fragment]) => key.startsWith(`${no}:`) && Array.isArray(fragment.covers) && fragment.covers.includes(index + 1) && fragment.segmentIndex !== index + 1).map(([, fragment]) => `${fragment.voiceId}连续承接，不重新起声`);
      if (continuations.length !== expected.length || continuations.some((match, continuationIndex) => match[1] !== expected[continuationIndex])) add('VOICE_CONTINUATION', '覆盖区间的后续镜头须只写对应 V 编号续音，不得漏接、重播或引用其他语段。', no, 'D7');
      // Any malformed voice field would otherwise evade exact text matching.
      if ([...String(segment.visual).matchAll(/【配音/gu)].length !== fields.length) add('VOICE_FIELD_FORMAT', '配音字段必须采用第十四节的明确来源、声音表现与原文台词格式。', no, 'G7');
    });
  });
  return { valid: errors.length === 0, errors, blockNos: shots.map(shot => blockNo(shot?.no)), scope: '文本与计划' };
}

function validateAudit(candidate, audit, { script, context, localErrors } = {}) {
  if (customStoryboardSkill(context)) return validateUserSkillAudit(candidate, audit, { script, context, localErrors });
  const board = boardOf(candidate);
  const config = contextOf(context);
  const checked = validateCandidate(candidate, { script, context: config });
  const errors = [...checked.errors];
  for (const issue of localErrors ?? []) if (!errors.some(existing => JSON.stringify(existing) === JSON.stringify(issue))) errors.push(issue);
  const add = (code, message, no, ruleId) => errors.push(error(code, message, no, ruleId));
  const shots = Array.isArray(board?.shots) ? board.shots.filter(shot => shot && typeof shot === 'object' && !Array.isArray(shot)) : [];
  const expectedNos = shots.map(shot => blockNo(shot.no));
  const auditBlocks = Array.isArray(audit?.blocks) ? audit.blocks : [];
  const listed = Array.isArray(audit?.acceptedBlockNos) ? audit.acceptedBlockNos.map(blockNo) : [];
  const blockers = [...(Array.isArray(board?.blockers) ? board.blockers : []), ...(Array.isArray(audit?.blockers) ? audit.blockers : [])].filter((item, index, all) => all.findIndex(other => other?.id === item?.id) === index);
  const blockedNos = new Set(blockers.flatMap(item => Array.isArray(item?.affectedBlockNos) ? item.affectedBlockNos.map(blockNo) : []));
  if (!['pass', 'revise', 'blocked'].includes(audit?.verdict)) add('AUDIT_VERDICT', '独立审核必须明确给出 pass、revise 或 blocked。');
  for (const blocker of blockers) if (!genuineBlocker(blocker)) add('INVALID_AUDIT_BLOCKER', '独立审核中的阻塞缺少真实材料、受影响范围或最小问题。');
  if (!Array.isArray(audit?.issues) || !Array.isArray(audit?.blockers) || !Array.isArray(audit?.acceptedBlockNos)) add('AUDIT_ARRAYS', '独立审核必须明确返回问题、阻塞和已通过块号数组。');
  if (new Set(listed).size !== listed.length || listed.some(no => !expectedNos.includes(no))) add('AUDIT_ACCEPTED_RANGE', '已通过块号不得重复或超出候选范围。');
  if (auditBlocks.length !== shots.length || new Set(auditBlocks.map(item => blockNo(item?.no))).size !== shots.length || auditBlocks.some(item => !expectedNos.includes(blockNo(item?.no)))) add('AUDIT_BLOCK_COVERAGE', '独立审核必须逐一覆盖每个候选生成块，不能漏块、重块或审错版本。');

  function inspect(checks, notes, ids, no, batch = false, required = new Set()) {
    if (!checks || typeof checks !== 'object' || Array.isArray(checks)) { add('AUDIT_CHECKS', '缺少逐项审核结果。', no); return; }
    for (const id of ids) {
      const status = checks[id];
      const note = clean(notes?.[id]);
      if (!STATUSES.has(status)) { add('AUDIT_MISSING_CHECK', `独立审核缺少有效 ${id} 检查结果。`, no, id); continue; }
      if (status === '失败') add('AUDIT_FAILED_CHECK', `${id} 尚未通过，必须回炉后重新审核。`, no, id);
      if (status === '阻塞' && (audit?.verdict !== 'blocked' || !blockers.some(genuineBlocker) || (no && !blockedNos.has(no)))) add('AUDIT_FALSE_BLOCKED', `${id} 的阻塞没有真实受影响范围支持。`, no, id);
      if (status === '不适用' && ((!batch && (ALWAYS_APPLICABLE.has(id) || required.has(id))) || (batch && ['A1', 'A4'].includes(id)))) add('AUDIT_INVALID_NA', `${id} 是本次必须适用的检查，不能以不适用跳过。`, no, id);
      if (status === '本次被覆盖' && !clean(config.overrides?.[id])) add('AUDIT_UNAUTHORIZED_OVERRIDE', `${id} 没有用户明确覆盖授权。`, no, id);
      if (status !== '通过' && !note) add('AUDIT_NOTE_REQUIRED', `${id} 的非通过状态必须说明具体依据。`, no, id);
    }
  }
  auditBlocks.forEach(item => {
    const no = blockNo(item?.no);
    const shot = shots.find(value => blockNo(value.no) === no);
    const voiceFragments = Array.isArray(board?.voiceFragments) ? board.voiceFragments.filter(isObject) : [];
    const blockVoices = voiceFragments.filter(fragment => blockNo(fragment.blockNo) === no);
    const required = new Set();
    if (blockVoices.length) {
      ['D4', 'D9', 'D10'].forEach(id => required.add(id));
      if (config.mode !== 'adaptation') required.add('D1');
    }
    if (blockVoices.some(fragment => clean(fragment.voiceId))) required.add('D7');
    if (blockVoices.some(fragment => new Set(voiceFragments.filter(other => other.sourceId === fragment.sourceId).map(other => blockNo(other.blockNo))).size > 1)) required.add('D8');
    if ((shot?.segments?.length ?? 0) > 1) ['E9', 'F8'].forEach(id => required.add(id));
    inspect(item?.checks, item?.notes, rules, no, false, required);
    const evidenceRules = ['C6', 'C7', 'C9', 'D6', 'E9', 'E10', 'F8'];
    if (shot?.duration < config.maxDuration) {
      if (item?.checks?.C9 === '不适用') add('AUDIT_SHORT_BLOCK_NA', '存在短块时必须实际进行后续接入复核。', no, 'C9');
    }
    for (const id of evidenceRules) if (!clean(item?.notes?.[id]) || /^(?:通过|已检查|已复核|无问题|符合要求)[。！!]?$/u.test(clean(item.notes[id]))) add('AUDIT_EVIDENCE_REQUIRED', `${id} 须说明实际复核事实，不能只声称检查过。`, no, id);
    const statuses = rules.map(id => item?.checks?.[id]);
    const blockPassed = statuses.every(status => ['通过', '不适用', '本次被覆盖'].includes(status));
    if (listed.includes(no) && (!blockPassed || blockedNos.has(no))) add('AUDIT_FALSE_ACCEPTANCE', '受阻或尚有未通过项的块不能列为正式交付。', no);
    if (blockPassed && !blockedNos.has(no) && !listed.includes(no)) add('AUDIT_OMITTED_ACCEPTANCE', '独立通过且不依赖阻塞的候选块必须明确列入通过范围。', no);
  });
  inspect(audit?.batchChecks, audit?.batchNotes, BATCH_RULE_IDS, null, true);
  for (const issue of Array.isArray(audit?.issues) ? audit.issues : []) {
    const no = issue?.blockNo ? blockNo(issue.blockNo) : undefined;
    if (!issue || !clean(issue.ruleId) || !clean(issue.message)) add('AUDIT_ISSUE_FORMAT', '审核问题必须明确规则与具体问题。', no);
    else if (listed.includes(no) || !no || !blockedNos.has(no)) add('AUDIT_UNRESOLVED_ISSUE', issue.message, no, issue.ruleId);
  }
  // Optional explicit dependency metadata can strengthen, never relax, exclusion.
  for (const shot of shots) {
    const no = blockNo(shot.no);
    const dependencies = shot.dependsOn ?? config.blockDependencies?.[no] ?? [];
    if (listed.includes(no) && Array.isArray(dependencies) && dependencies.map(blockNo).some(dependency => blockedNos.has(dependency) || !listed.includes(dependency))) add('AUDIT_BLOCKED_DEPENDENCY', '通过块仍依赖未通过或受阻内容，不能独立交付。', no, 'H1');
  }
  if (audit?.verdict === 'revise') add('AUDIT_REVISION_REQUIRED', '独立审核要求修正，候选内容不可交付。');
  if (audit?.verdict === 'pass' && (blockers.length || listed.length !== shots.length || (audit?.issues?.length ?? 0))) add('AUDIT_FALSE_PASS', '全部通过不得遗留阻塞、问题或未通过的候选块。');
  if (audit?.verdict === 'blocked' && (!blockers.some(genuineBlocker) || listed.length !== shots.length)) add('AUDIT_NO_DELIVERABLE_PART', '部分交付须具有真实阻塞，所有留下的候选块都必须独立通过；受阻内容只能保留在阻塞与顺延记录中。');
  const blocked = shots.length === 0 && audit?.verdict === 'blocked' && blockers.some(genuineBlocker) && listed.length === 0 && errors.length > 0 && errors.every(item => item.code === 'NO_BLOCKS');
  const valid = errors.length === 0;
  return { valid, errors, acceptedBlockNos: valid ? listed : [], partial: valid && audit.verdict === 'blocked', blocked, blockers, scope: '文本与计划' };
}

function buildAuditSummary(candidate, audit, { repairCount = 0, context } = {}) {
  if (customStoryboardSkill(context)) return buildUserSkillSummary(candidate, audit, { repairCount, context });
  const board = boardOf(candidate);
  const config = contextOf(context);
  const accepted = (audit?.acceptedBlockNos ?? []).map(blockNo);
  const blocks = (audit?.blocks ?? []).filter(item => accepted.includes(blockNo(item.no)));
  // Never create a green UI summary from a model's unsupported verdict alone.
  if (!accepted.length || !['pass', 'blocked'].includes(audit?.verdict) || blocks.length !== accepted.length || blocks.some(item => rules.some(id => !['通过', '不适用', '本次被覆盖'].includes(item?.checks?.[id]))) || BATCH_RULE_IDS.some(id => !STATUSES.has(audit?.batchChecks?.[id]) || audit.batchChecks[id] === '失败')) throw new Error('尚未取得完整通过的独立审计，不能生成正式审计摘要。');
  const aggregate = ids => {
    const values = blocks.flatMap(item => ids.map(id => item.checks[id]));
    if (values.some(value => value === '阻塞')) return '阻塞';
    return values.every(value => value === '不适用') ? '不适用' : '通过';
  };
  const blockers = [...(board?.blockers ?? []), ...(audit?.blockers ?? [])].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const sorted = [...accepted].sort((a, b) => Number(a) - Number(b));
  const rows = [
    { label: '块数与范围', status: audit.verdict === 'blocked' ? '阻塞' : '通过' },
    { label: `单块≤${config.maxDuration}秒`, status: aggregate(['C1']) },
    { label: `单块≤${config.maxShots}镜`, status: aggregate(['C2']) },
    { label: '一时间片一实际镜头', status: aggregate(['C3', 'C4']) },
    { label: '独立场景边界', status: aggregate(['B1']) },
    { label: '独立可执行性', status: aggregate(['B2', 'B3', 'B4', 'B5']) },
    { label: '台词与声音完整性', status: aggregate(['D1', 'D2', 'D3', 'D7', 'D8', 'D9', 'D10', 'H2']) },
    { label: '自然发声与长声音承载', status: aggregate(['D4', 'D5', 'D6']) },
    { label: '运镜表达与连续变镜', status: aggregate(['E9', 'E10', 'E11', 'E12', 'F8']) },
    { label: '短块后续接入复核', status: aggregate(['C9']) },
    { label: '空间与道具连续性', status: aggregate(['F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8']) },
    { label: '认知与动作因果', status: aggregate(['F5', 'E7']) },
    { label: '总时长/总块数预算', status: audit.batchChecks.H5 === '不适用' ? '未锁定' : audit.batchChecks.H5 },
    { label: '资产与格式', status: aggregate(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']) },
  ];
  return { version: VERSION, finalStatus: audit.verdict === 'blocked' ? '部分通过（存在阻塞）' : '全部通过', repairCount: Math.max(0, Number.isInteger(repairCount) ? repairCount : 0), range: `生成块${sorted[0]}—${sorted[sorted.length - 1]}`, rows, blockers, scope: '文本与计划' };
}

// Explicit user override: after one real repair, editorial audit failures may be
// retained as warnings. The candidate must remain structurally usable by the UI.
// This summary deliberately never labels that result as an approved audit.
function buildIgnoredAuditSummary(candidate, audit, { repairCount = 1, context, issues = [] } = {}) {
  if (customStoryboardSkill(context)) return buildUserSkillSummary(candidate, audit, { repairCount, context, issues, ignored: true });
  const board = boardOf(candidate);
  const config = contextOf(context);
  const shots = Array.isArray(board?.shots) ? board.shots : [];
  if (!Number.isInteger(repairCount) || repairCount < 1) throw new Error('至少完成一次实际回炉后才能忽略审计问题。');
  if (hasGenuineBlockers(candidate, audit)) throw new Error('存在真实剧情阻塞，不能将缺失材料当作审计问题忽略。');
  if (!canPublishIgnoredCandidate(candidate, { context })) throw new Error('没有完整可用的生成块和基础数据，不能忽略审计后继续。');

  const acceptedIssues = [];
  const append = value => {
    const item = typeof value === 'string' ? { message: value } : value;
    if (!isObject(item) || !clean(item.message)) return;
    const normalized = {
      ...(clean(item.code) ? { code: clean(item.code).slice(0, 80) } : {}),
      ...(item.blockNo !== undefined && clean(String(item.blockNo)) ? { blockNo: blockNo(item.blockNo) } : {}),
      ...(clean(item.ruleId) ? { ruleId: clean(item.ruleId).slice(0, 12) } : {}),
      message: clean(item.message).replace(/\s+/gu, ' ').slice(0, 360),
    };
    if (!acceptedIssues.some(existing => JSON.stringify(existing) === JSON.stringify(normalized))) acceptedIssues.push(normalized);
  };
  for (const item of Array.isArray(issues) ? issues : []) append(item);
  for (const item of Array.isArray(audit?.issues) ? audit.issues : []) append(item);
  const auditBlocks = Array.isArray(audit?.blocks) ? audit.blocks : [];
  const evidenceRules = ['C6', 'C7', 'C9', 'D6', 'E9', 'E10', 'F8'];
  const fail = (code, message, no, ruleId) => append(error(code, message, no, ruleId));
  const inspect = (checks, notes, ids, no, requiredEvidence = []) => {
    for (const id of ids) {
      const status = checks?.[id];
      const note = clean(notes?.[id]);
      if (!STATUSES.has(status)) fail('AUDIT_MISSING_CHECK', `${id} 未返回有效审计结论。`, no, id);
      else if (status === '失败' || status === '阻塞') fail('AUDIT_FAILED_CHECK', note || `${id} 审计尚未通过。`, no, id);
      else if (status === '本次被覆盖' && !clean(config.overrides?.[id])) fail('AUDIT_UNAUTHORIZED_OVERRIDE', `${id} 缺少明确覆盖依据。`, no, id);
      if (STATUSES.has(status) && status !== '通过' && !note) fail('AUDIT_NOTE_REQUIRED', `${id} 的结论缺少具体依据。`, no, id);
      if (requiredEvidence.includes(id) && (!note || /^(?:通过|已检查|已复核|无问题|符合要求)[。！!]?$/u.test(note))) fail('AUDIT_EVIDENCE_REQUIRED', `${id} 缺少实际复核事实。`, no, id);
    }
  };
  if (!isObject(audit)) fail('AUDIT_INVALID_RESULT', '独立审计未返回可解析的完整结果。');
  else if (!['pass', 'revise', 'blocked'].includes(audit.verdict)) fail('AUDIT_VERDICT', '独立审计未返回有效的整体结论。');
  else if (audit.verdict === 'revise') fail('AUDIT_REVISION_REQUIRED', '独立审计仍要求修正，本次按用户设置忽略。');
  for (const shot of shots) {
    const no = blockNo(shot.no);
    const matches = auditBlocks.filter(item => blockNo(item?.no) === no);
    if (matches.length !== 1) fail('AUDIT_BLOCK_COVERAGE', `生成块 ${no} 缺少唯一完整的独立审计。`, no);
    inspect(matches.length === 1 ? matches[0]?.checks : null, matches.length === 1 ? matches[0]?.notes : null, rules, no, evidenceRules);
  }
  inspect(audit?.batchChecks, audit?.batchNotes, BATCH_RULE_IDS);
  if (!acceptedIssues.length) fail('AUDIT_NOT_APPROVED', '独立审计尚未获得完整有效的通过确认，本次按用户设置继续。');

  const aggregate = (ids, batchOnly = false) => {
    const rows = batchOnly ? [{ checks: audit?.batchChecks }] : shots.map(shot => {
      const matches = auditBlocks.filter(item => blockNo(item?.no) === blockNo(shot.no));
      return matches.length === 1 ? matches[0] : null;
    });
    const values = rows.flatMap(row => ids.map(id => row?.checks?.[id]));
    const relevantIssues = acceptedIssues.filter(item => ids.includes(item.ruleId));
    if (relevantIssues.length || values.some(value => value === '失败' || value === '阻塞')) return '未通过';
    if (!values.length || values.some(value => !STATUSES.has(value))) return '未核实';
    return values.every(value => value === '不适用') ? '不适用' : '通过';
  };
  const rows = [
    { label: '块数与范围', status: aggregate(['A1', 'A2', 'A3', 'A4'], true) },
    { label: `单块≤${config.maxDuration}秒`, status: aggregate(['C1']) },
    { label: `单块≤${config.maxShots}镜`, status: aggregate(['C2']) },
    { label: '一时间片一实际镜头', status: aggregate(['C3', 'C4']) },
    { label: '独立场景边界', status: aggregate(['B1']) },
    { label: '独立可执行性', status: aggregate(['B2', 'B3', 'B4', 'B5']) },
    { label: '台词与声音完整性', status: aggregate(['D1', 'D2', 'D3', 'D7', 'D8', 'D9', 'D10', 'H2']) },
    { label: '自然发声与长声音承载', status: aggregate(['D4', 'D5', 'D6']) },
    { label: '运镜表达与连续变镜', status: aggregate(['E9', 'E10', 'E11', 'E12', 'F8']) },
    { label: '短块后续接入复核', status: aggregate(['C9']) },
    { label: '空间与道具连续性', status: aggregate(['F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8']) },
    { label: '认知与动作因果', status: aggregate(['F5', 'E7']) },
    { label: '总时长/总块数预算', status: aggregate(['H5'], true) },
    { label: '资产与格式', status: aggregate(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']) },
  ];
  // Timing-fit evidence C6/C7 is kept visible even though the compact approved
  // table historically did not allocate a dedicated row for these two checks.
  if (acceptedIssues.some(item => ['C5', 'C6', 'C7', 'C8'].includes(item.ruleId))) rows.splice(3, 0, { label: '节拍与动作耗时复核', status: aggregate(['C5', 'C6', 'C7', 'C8']) });
  const sorted = shots.map(shot => blockNo(shot.no)).sort((a, b) => Number(a) - Number(b));
  return { version: VERSION, finalStatus: '审计未通过（已忽略）', repairCount, range: `生成块${sorted[0]}—${sorted[sorted.length - 1]}`, rows, issues: acceptedIssues, blockers: [], scope: '文本与计划' };
}

function validateUserSkillAudit(candidate, audit, { context, localErrors = [] } = {}) {
  const checked = validateCandidate(candidate, { context });
  const errors = [...checked.errors];
  for (const item of localErrors) if (!errors.some(existing => JSON.stringify(existing) === JSON.stringify(item))) errors.push(item);
  const add = (code, message, no) => errors.push(error(code, message, no));
  const shots = Array.isArray(candidate?.storyboard?.shots) ? candidate.storyboard.shots : [];
  const expected = shots.map(shot => blockNo(shot?.no));
  const blocks = Array.isArray(audit?.blocks) ? audit.blocks : [];
  const listed = Array.isArray(audit?.acceptedBlockNos) ? audit.acceptedBlockNos.map(blockNo) : [];
  const blockers = [...(Array.isArray(candidate?.storyboard?.blockers) ? candidate.storyboard.blockers : []), ...(Array.isArray(audit?.blockers) ? audit.blockers : [])]
    .filter((item, index, all) => all.findIndex(other => other?.id === item?.id) === index);
  const blockedNos = new Set(blockers.flatMap(item => Array.isArray(item?.affectedBlockNos) ? item.affectedBlockNos.map(blockNo) : []));
  if (!isObject(audit) || !['pass', 'revise', 'blocked'].includes(audit.verdict)) add('CUSTOM_AUDIT_VERDICT', '用户 Skill 独立审计缺少有效结论。');
  if (!Array.isArray(audit?.issues) || !Array.isArray(audit?.blockers) || !Array.isArray(audit?.acceptedBlockNos)) add('CUSTOM_AUDIT_ARRAYS', '用户 Skill 审计必须明确返回问题、阻塞与通过范围。');
  if (blocks.length !== shots.length || new Set(blocks.map(item => blockNo(item?.no))).size !== shots.length || blocks.some(item => !expected.includes(blockNo(item?.no)))) add('CUSTOM_AUDIT_COVERAGE', '用户 Skill 审计须逐一唯一覆盖实际生成块。');
  if (new Set(listed).size !== listed.length || listed.some(no => !expected.includes(no))) add('CUSTOM_AUDIT_ACCEPTED', '用户 Skill 已通过范围不得重号或超出候选。');
  for (const blocker of blockers) if (!genuineBlocker(blocker)) add('CUSTOM_INVALID_BLOCKER', '用户 Skill 审计的阻塞须对应真实缺失材料。');
  const inspect = (checks, no) => {
    if (!Array.isArray(checks) || !checks.length) { add('CUSTOM_AUDIT_CHECKS', '用户 Skill 审计必须列出实际条款检查，不得用空结论替代。', no); return false; }
    let passed = true;
    for (const item of checks) {
      if (!isObject(item) || !clean(item.rule) || !['通过', '不适用', '失败', '阻塞'].includes(item.status) || !clean(item.note)
        || /^(?:通过|已检查|已复核|无问题|符合要求)[。！!]?$/u.test(clean(item.note))) {
        add('CUSTOM_AUDIT_CHECK_FORMAT', '用户 Skill 每项检查须有条款、状态和具体事实依据。', no); passed = false;
      } else if (item.status === '失败') { add('CUSTOM_AUDIT_FAILED', `${item.rule}：${item.note}`, no); passed = false; }
      else if (item.status === '阻塞') {
        if (!blockers.some(genuineBlocker) || (no && !blockedNos.has(no))) add('CUSTOM_AUDIT_FALSE_BLOCKER', `${item.rule} 缺少真实阻塞依据。`, no);
        passed = false;
      }
    }
    return passed;
  };
  for (const block of blocks) {
    const no = blockNo(block?.no);
    const passed = inspect(block?.checks, no);
    if (listed.includes(no) && (!passed || blockedNos.has(no))) add('CUSTOM_AUDIT_FALSE_ACCEPTANCE', '未通过或受阻生成块不能冒充用户 Skill 审计通过。', no);
    if (passed && !blockedNos.has(no) && !listed.includes(no)) add('CUSTOM_AUDIT_MISSING_ACCEPTANCE', '独立通过的块必须列入用户 Skill 通过范围。', no);
  }
  inspect(audit?.batchChecks);
  for (const issue of Array.isArray(audit?.issues) ? audit.issues : []) {
    const no = issue?.blockNo ? blockNo(issue.blockNo) : null;
    if (!isObject(issue) || !clean(issue.message)) add('CUSTOM_AUDIT_ISSUE', '用户 Skill 审计问题缺少具体说明。', no);
    else if (!no || !blockedNos.has(no) || expected.includes(no)) add('CUSTOM_AUDIT_UNRESOLVED', issue.message, no);
  }
  if (audit?.verdict === 'revise') add('CUSTOM_AUDIT_REVISION', '用户 Skill 独立审计仍要求修正。');
  if (audit?.verdict === 'pass' && (blockers.length || listed.length !== shots.length || audit?.issues?.length)) add('CUSTOM_AUDIT_FALSE_PASS', '用户 Skill 全部通过不得遗留阻塞、问题或未通过块。');
  if (audit?.verdict === 'blocked' && (!blockers.some(genuineBlocker) || listed.length !== shots.length)) add('CUSTOM_AUDIT_PARTIAL', '部分交付须有真实阻塞且所有留下的块独立通过。');
  const blocked = shots.length === 0 && audit?.verdict === 'blocked' && blockers.some(genuineBlocker) && !listed.length && errors.length > 0 && errors.every(item => item.code === 'NO_BLOCKS');
  const valid = errors.length === 0;
  return { valid, errors, acceptedBlockNos: valid ? listed : [], partial: valid && audit.verdict === 'blocked', blocked, blockers, scope: '用户 Skill · 文本与计划' };
}

function buildUserSkillSummary(candidate, audit, { repairCount = 0, context, issues = [], ignored = false } = {}) {
  const document = customStoryboardSkill(context);
  if (!document) throw new Error('缺少本次用户分镜 Skill。');
  const gate = validateUserSkillAudit(candidate, audit, { context });
  if (!ignored && !gate.valid) throw new Error('尚未取得用户 Skill 独立审计的有效通过结果。');
  if (ignored && hasGenuineBlockers(candidate, audit)) throw new Error('存在真实剧情阻塞，不能忽略用户 Skill 审计后继续。');
  if (ignored && (repairCount < 1 || !canPublishIgnoredCandidate(candidate, { context }))) throw new Error('只有回炉一次且结构与素材身份有效时才能忽略用户 Skill 审计。');
  const messages = [...issues, ...gate.errors, ...(Array.isArray(audit?.issues) ? audit.issues : [])];
  const normalizedIssues = [];
  for (const value of messages) {
    const item = typeof value === 'string' ? { message: value } : value;
    if (!isObject(item) || !clean(item.message)) continue;
    const normalized = { ...(clean(item.code) ? { code: clean(item.code).slice(0, 80) } : {}), ...(item.blockNo ? { blockNo: blockNo(item.blockNo) } : {}), ...(clean(item.ruleId) ? { ruleId: clean(item.ruleId).slice(0, 80) } : {}), message: clean(item.message).slice(0, 360) };
    if (!normalizedIssues.some(existing => JSON.stringify(existing) === JSON.stringify(normalized))) normalizedIssues.push(normalized);
  }
  const shots = candidate.storyboard.shots;
  const blocks = Array.isArray(audit?.blocks) ? audit.blocks : [];
  const statusFor = checks => Array.isArray(checks) && checks.length && checks.every(item => isObject(item) && ['通过', '不适用'].includes(item.status) && clean(item.rule) && clean(item.note)
    && !/^(?:通过|已检查|已复核|无问题|符合要求)[。！!]?$/u.test(clean(item.note))) ? '通过' : '未通过';
  const sorted = shots.map(shot => blockNo(shot.no));
  return {
    version: VERSION, finalStatus: ignored ? '审计未通过（已忽略）' : audit.verdict === 'blocked' ? '部分通过（存在阻塞）' : '全部通过',
    repairCount, range: `生成块${sorted[0]}—${sorted[sorted.length - 1]}`, auditBasis: '用户 Skill', skillName: document.name, skillSha256: document.sha256,
    stageSkills: stageSkillReferences(context.stageSkills), scope: '用户 Skill · 文本与计划',
    rows: [{ label: `用户分镜 Skill：${document.name}`, status: ignored ? '未通过' : '通过' }, ...shots.map(shot => {
      const no = blockNo(shot.no); const matches = blocks.filter(item => blockNo(item?.no) === no);
      return { label: `生成块 ${no} · 用户规范`, status: matches.length === 1 && !normalizedIssues.some(item => item.blockNo === no) ? statusFor(matches[0].checks) : '未通过' };
    }), { label: '全批范围与用户要求', status: statusFor(audit?.batchChecks) }],
    blockers: ignored ? [] : gate.blockers, ...(ignored || normalizedIssues.length ? { issues: normalizedIssues } : {}),
  };
}

module.exports = { validateCandidate, validateAudit, buildAuditSummary, buildIgnoredAuditSummary, hasGenuineBlockers, canPublishIgnoredCandidate };
