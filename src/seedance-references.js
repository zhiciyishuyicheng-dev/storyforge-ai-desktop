function text(value) {
  return String(value ?? '').trim();
}

export function imageReferenceNumber(value) {
  const match = text(value).match(/^@Image(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

export function extractImageReferenceNumbers(prompt) {
  return [...text(prompt).matchAll(/@Image(\d+)/gi)]
    .map((match) => Number(match[1]))
    .filter((number, index, values) => number > 0 && values.indexOf(number) === index)
    .sort((left, right) => left - right);
}

export function ensureStoryboardShot(storyboard, shotIndex, prompt, duration) {
  if (!storyboard || !Number.isInteger(shotIndex) || shotIndex < 0) return null;
  if (!Array.isArray(storyboard.shots)) storyboard.shots = [];
  if (!storyboard.shots[shotIndex]) {
    storyboard.shots[shotIndex] = {
      no: String(shotIndex + 1).padStart(2, '0'),
      title: `镜头 ${String(shotIndex + 1).padStart(2, '0')}`,
      duration,
      uploads: [],
      segments: [],
      sound: '',
      prompt: text(prompt),
      restoredFromLegacy: true,
    };
  }
  if (!Array.isArray(storyboard.shots[shotIndex].uploads)) storyboard.shots[shotIndex].uploads = [];
  return storyboard.shots[shotIndex];
}

export function removeAndRenumberImageReference(prompt, removedNumber, replacement = '', removeWholeLine = false) {
  const number = Number(removedNumber);
  if (!Number.isInteger(number) || number < 1) return text(prompt);
  const marker = new RegExp(`@Image${number}(?!\\d)`, 'i');
  let nextPrompt = text(prompt);
  if (removeWholeLine) {
    nextPrompt = nextPrompt.split('\n').filter((line) => !marker.test(line)).join('\n');
  } else {
    nextPrompt = nextPrompt.replace(new RegExp(`@Image${number}(?!\\d)`, 'gi'), text(replacement));
  }
  return nextPrompt
    .replace(/@Image(\d+)/gi, (_match, value) => Number(value) > number ? `@Image${Number(value) - 1}` : `@Image${Number(value)}`)
    .trim();
}

export function normalizeImageReferenceSequence(prompt, uploads = [], bindings = {}) {
  const normalizedUploads = [];
  const oldToNew = new Map();
  for (const upload of Array.isArray(uploads) ? uploads : []) {
    const oldNumber = imageReferenceNumber(upload?.ref);
    if (!oldNumber || oldToNew.has(oldNumber)) continue;
    const newNumber = normalizedUploads.length + 1;
    oldToNew.set(oldNumber, newNumber);
    normalizedUploads.push({ ...upload, ref: `@Image${newNumber}` });
  }
  const placeholders = new Map();
  let normalizedPrompt = text(prompt).replace(/@Image(\d+)/gi, (_match, value) => {
    const newNumber = oldToNew.get(Number(value));
    if (!newNumber) return '';
    const placeholder = `__故事工坊图片引用${newNumber}__`;
    placeholders.set(placeholder, `@Image${newNumber}`);
    return placeholder;
  });
  placeholders.forEach((reference, placeholder) => {
    normalizedPrompt = normalizedPrompt.split(placeholder).join(reference);
  });
  normalizedPrompt = normalizedPrompt
    .replace(/[，、]\s*[，、]/g, '，')
    .replace(/[:：]\s*[；;]/g, '：')
    .trim();
  const normalizedBindings = {};
  Object.entries(bindings || {}).forEach(([key, value]) => {
    const newNumber = oldToNew.get(Number(key));
    if (newNumber) normalizedBindings[String(newNumber)] = value;
  });
  const changed = normalizedPrompt !== text(prompt)
    || normalizedUploads.some((upload, index) => text(upload?.ref) !== text(uploads?.[index]?.ref))
    || normalizedUploads.length !== (Array.isArray(uploads) ? uploads.length : 0)
    || JSON.stringify(normalizedBindings) !== JSON.stringify(bindings || {});
  return { prompt: normalizedPrompt, uploads: normalizedUploads, bindings: normalizedBindings, changed };
}

export function listUploadedReferenceFiles(assetItems = []) {
  return assetItems.flatMap((asset, assetItemIndex) => {
    const files = Array.isArray(asset?.files) && asset.files.length
      ? asset.files
      : asset?.localPath ? [{ localPath: asset.localPath, imageUrl: asset.imageUrl }] : [];
    return files
      .map((file, fileIndex) => ({
        assetName: text(asset?.name),
        assetType: text(asset?.type) || '参考图',
        assetItemIndex,
        fileIndex,
        localPath: text(file?.localPath),
        imageUrl: text(file?.imageUrl),
        sourceName: text(file?.sourceName || file?.fileName) || `图片${fileIndex + 1}`,
        trustedAssetId: text(file?.trustedAssetId).replace(/^asset:\/\//i, ''),
      }))
      .filter((file) => file.localPath || file.trustedAssetId);
  });
}

function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function bindingMatchesFile(binding, file) {
  if (!binding || !file) return false;
  const bindingAssetId = text(binding.trustedAssetId).replace(/^asset:\/\//i, '');
  if (bindingAssetId && file.trustedAssetId) return bindingAssetId === file.trustedAssetId;
  return Boolean(text(binding.localPath)) && text(binding.localPath) === file.localPath;
}

function legacyReferenceDefinition(prompt, number, assetItems) {
  const marker = new RegExp(`@Image${number}(?!\\d)`, 'i');
  const markerMatch = marker.exec(text(prompt));
  const tail = markerMatch ? text(prompt).slice(markerMatch.index, markerMatch.index + markerMatch[0].length + 100) : '';
  const context = tail.split(/[；;。\n]/).filter(Boolean)[0] || tail;
  const assetNames = assetItems.map((item) => text(item?.name)).filter((name) => name && name !== '@' && name.length > 1).sort((left, right) => right.length - left.length);
  const assetName = assetNames.find((name) => context.includes(name)) || '';
  const purpose = context
    .replace(marker, '')
    .replace(/^(?:用于|作为|作|是|：|:|，|、|\s)+/, '')
    .trim() || `为图片${number}选择对应的人物、场景或道具素材`;
  return { ref: `@Image${number}`, number, assetName, purpose, uploadIndex: number - 1, legacy: true };
}

export function resolveStrictReferencePlan({ prompt, shot, assetItems = [], savedBindings = {} }) {
  const errors = [];
  const uploads = Array.isArray(shot?.uploads) ? shot.uploads : [];
  const structuredDefinitions = uploads.map((upload, uploadIndex) => ({
    ref: text(upload?.ref),
    number: imageReferenceNumber(upload?.ref),
    assetName: text(upload?.asset),
    purpose: text(upload?.purpose),
    uploadIndex,
    addedInVideoStep: Boolean(upload?.addedInVideoStep),
    restoredFromLegacy: Boolean(upload?.restoredFromLegacy),
  }));
  const promptNumbers = extractImageReferenceNumbers(prompt);
  const legacyMode = structuredDefinitions.length === 0 && promptNumbers.length > 0;
  const definitions = legacyMode
    ? promptNumbers.map((number) => legacyReferenceDefinition(prompt, number, assetItems))
    : structuredDefinitions;
  const invalidUpload = definitions.find((item) => !item.number || (!item.legacy && (!item.assetName || !item.purpose)));
  if (invalidUpload) errors.push(`上传计划第 ${invalidUpload.uploadIndex + 1} 项缺少有效的 @Image 编号、素材名称或用途。`);
  const validDefinitions = definitions.filter((item) => item.number).sort((left, right) => left.number - right.number);
  const definitionNumbers = validDefinitions.map((item) => item.number);
  if (new Set(definitionNumbers).size !== definitionNumbers.length) errors.push('上传计划存在重复的 @Image 编号。');
  if (validDefinitions.length > 9) errors.push('单个镜头最多只能绑定 9 张参考图。');
  const expectedNumbers = Array.from({ length: validDefinitions.length }, (_value, index) => index + 1);
  if (!sameNumbers(definitionNumbers, expectedNumbers)) errors.push('上传计划必须从 @Image1 开始连续编号，不能跳号。');

  if (!sameNumbers(promptNumbers, definitionNumbers)) {
    const expected = definitionNumbers.map((number) => `@Image${number}`).join('、') || '无';
    const actual = promptNumbers.map((number) => `@Image${number}`).join('、') || '无';
    errors.push(`提示词引用与上传计划不一致：应为 ${expected}，当前为 ${actual}。`);
  }

  const availableFiles = listUploadedReferenceFiles(assetItems);
  const duplicateAssetNames = [...new Set(assetItems.map((item) => text(item?.name)).filter(Boolean)
    .filter((name, index, values) => values.indexOf(name) !== index))];
  if (duplicateAssetNames.length) errors.push(`第五步存在同名素材：${duplicateAssetNames.join('、')}。请保留唯一名称。`);

  const bindings = validDefinitions.map((definition) => {
    const exactCandidates = availableFiles.filter((file) => file.assetName === definition.assetName);
    const saved = savedBindings?.[String(definition.number)] || savedBindings?.[definition.number];
    const selected = availableFiles.find((file) => bindingMatchesFile(saved, file)) || exactCandidates[0] || null;
    if (definition.legacy) {
      if (!selected) errors.push(`${definition.ref} 尚未绑定第五步的具体参考图。`);
    } else if (!assetItems.some((asset) => text(asset?.name) === definition.assetName)) {
      errors.push(`${definition.ref} 指定的素材“${definition.assetName}”在第五步不存在。`);
    } else if (!exactCandidates.length) {
      errors.push(`${definition.ref} 指定的素材“${definition.assetName}”尚未上传参考图。`);
    } else if (selected && selected.assetName !== definition.assetName) {
      errors.push(`${definition.ref} 必须绑定“${definition.assetName}”，当前选择的是“${selected.assetName}”。`);
    }
    return { ...definition, candidates: availableFiles, exactCandidates, selected };
  });

  return { valid: errors.length === 0 && bindings.every((binding) => binding.selected), errors, bindings, availableFiles, legacyMode };
}

export function buildSeedanceReferenceRequest({ prompt, shot, assetItems = [], savedBindings = {}, unifiedSuffix = '' }) {
  const plan = resolveStrictReferencePlan({ prompt, shot, assetItems, savedBindings });
  if (!plan.valid) throw new Error(plan.errors[0] || '当前镜头的参考图绑定不完整。');
  const mappingLines = plan.bindings.map((binding) => {
    const type = binding.selected.assetType || '参考图';
    const assetName = binding.selected.assetName || binding.assetName;
    return `图片${binding.number}：${type}“${assetName}”，唯一用途：${binding.purpose}。`;
  });
  const promptText = text(prompt)
    .replace(/@Image(\d+)/gi, (_match, number) => `图片${Number(number)}`)
    .replace(/@(Video|Audio)\d+/gi, '')
    .replace(/[，、]\s*[，、]/g, '，')
    .trim();
  const guard = '必须严格按上述图片编号匹配人物、场景、群像和道具，禁止互换编号，禁止把某张人物图用于其他角色，禁止用人物图背景替代指定场景；人物外貌、服装、发型与对应图片保持一致，场景结构、材质和陈设与对应场景图片保持一致。';
  const suffix = text(unifiedSuffix);
  const requestPrompt = `素材对应关系（必须严格遵守）：\n${mappingLines.join('\n')}\n${guard}\n\n${promptText}${suffix ? `\n\n统一视觉要求：${suffix}` : ''}`;
  const imageInputs = plan.bindings.map((binding) => ({
    localPath: binding.selected.localPath,
    assetId: binding.selected.trustedAssetId,
    assetItemIndex: binding.selected.assetItemIndex,
    fileIndex: binding.selected.fileIndex,
    assetName: binding.selected.assetName || binding.assetName,
    assetType: binding.selected.assetType,
    purpose: binding.purpose,
    sourceName: binding.selected.sourceName,
    referenceNumber: binding.number,
  }));
  return { prompt: requestPrompt, imageInputs, imagePaths: imageInputs.map((item) => item.localPath).filter(Boolean), plan };
}
