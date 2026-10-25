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
  // Named references are identities, not positions. Old numbering repair must not
  // erase them or move a saved image to a different character.
  if ((Array.isArray(uploads) ? uploads : []).some((upload) => text(upload?.ref) && !imageReferenceNumber(upload.ref))
    || /@(?!Image\d+|Video\d+|Audio\d+)/i.test(text(prompt))) {
    return { prompt: text(prompt), uploads: Array.isArray(uploads) ? uploads : [], bindings: bindings || {}, changed: false };
  }
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
  const nextReference = tail.indexOf('@', 1);
  const ownTail = nextReference >= 0 ? tail.slice(0, nextReference) : tail;
  const context = ownTail.split(/[；;。\n]/).filter(Boolean)[0] || ownTail;
  const assetNames = assetItems.map((item) => text(item?.name)).filter((name) => name && name !== '@' && name.length > 1).sort((left, right) => right.length - left.length);
  const assetName = assetNames.find((name) => context.includes(name)) || '';
  const purpose = context
    .replace(marker, '')
    .replace(/^(?:用于|作为|作|是|：|:|，|、|\s)+/, '')
    .trim() || `为图片${number}选择对应的人物、场景或道具素材`;
  return { ref: `@Image${number}`, number, assetName, purpose, uploadIndex: number - 1, legacy: true };
}

export function namedReferenceKey(assetName) {
  return `asset:${text(assetName)}`;
}

// Match known names before looking for punctuation: names may themselves contain
// spaces or brackets, and a longer scene/character name must win over its prefix.
export function extractAssetReferences(prompt, assetItems = []) {
  const source = text(prompt);
  const names = [...new Set(assetItems.map((asset) => text(asset?.name)).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  const references = [];
  for (let start = source.indexOf('@'); start >= 0; start = source.indexOf('@', start + 1)) {
    const tail = source.slice(start + 1);
    const assetName = names.find((name) => tail.startsWith(name)
      && !/^[（(]/u.test(tail.slice(name.length))
      && (!/[\p{L}\p{N}_]$/u.test(name) || !/^[A-Za-z0-9_]/.test(tail.slice(name.length))));
    if (assetName) {
      references.push({ ref: `@${assetName}`, assetName, kind: 'named', start, end: start + assetName.length + 1 });
      start += assetName.length;
      continue;
    }
    const numbered = tail.match(/^Image(\d+)(?![A-Za-z0-9_])/i);
    if (numbered) {
      references.push({ ref: `@Image${Number(numbered[1])}`, sourceNumber: Number(numbered[1]), kind: 'legacy', start, end: start + numbered[0].length + 1 });
      start += numbered[0].length;
      continue;
    }
    const ignored = tail.match(/^(?:Video|Audio)\d+/i);
    if (ignored) {
      start += ignored[0].length;
      continue;
    }
    const unknown = tail.match(/^[^\s@，,。；;：:！!？?、\n\r“”"「」《》]+/u)?.[0] || '';
    if (unknown) references.push({ ref: `@${unknown}`, assetName: unknown, kind: 'unknown', start, end: start + unknown.length + 1 });
  }
  return references;
}

export function replaceReferenceOccurrences(prompt, references, replacement) {
  let result = text(prompt);
  for (const reference of [...references].reverse()) {
    const value = replacement(reference);
    if (value !== undefined) result = result.slice(0, reference.start) + value + result.slice(reference.end);
  }
  return result;
}

export function resolveStrictReferencePlan({ prompt, shot, assetItems = [], savedBindings = {} }) {
  const errors = [];
  const uploads = Array.isArray(shot?.uploads) ? shot.uploads : [];
  const availableFiles = listUploadedReferenceFiles(assetItems);
  const names = assetItems.map((item) => text(item?.name)).filter(Boolean);
  const duplicateAssetNames = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  if (duplicateAssetNames.length) errors.push(`视觉素材存在同名素材：${duplicateAssetNames.join('、')}。请保留唯一名称。`);
  const references = extractAssetReferences(prompt, assetItems);
  const uniqueReferences = references.filter((reference, index) => references.findIndex((item) => item.ref === reference.ref) === index);
  const unknown = uniqueReferences.filter((reference) => reference.kind === 'unknown');
  unknown.forEach((reference) => errors.push(`分镜引用 ${reference.ref} 在第三步中没有同名素材，请使用准确的素材名称。`));
  const usedReferences = uniqueReferences.filter((reference) => reference.kind !== 'unknown');
  if (usedReferences.length > 9) errors.push('单个镜头最多只能绑定 9 张参考图。');
  const definitions = usedReferences.map((reference, index) => {
    const uploadIndex = reference.kind === 'named'
      ? uploads.findIndex((upload) => text(upload?.asset) === reference.assetName || text(upload?.ref) === reference.ref)
      : uploads.findIndex((upload) => imageReferenceNumber(upload?.ref) === reference.sourceNumber);
    const upload = uploads[uploadIndex];
    const restored = reference.kind === 'legacy' && !upload
      ? legacyReferenceDefinition(prompt, reference.sourceNumber, assetItems)
      : null;
    const assetName = reference.kind === 'named' ? reference.assetName : text(upload?.asset) || restored?.assetName || '';
    const number = index + 1;
    const sourceNumber = reference.sourceNumber || imageReferenceNumber(upload?.ref) || 0;
    const purpose = text(upload?.purpose) || restored?.purpose || `${assetName}的外观与视觉特征参考`;
    const oldSlot = savedBindings?.[`image:${sourceNumber}`] || savedBindings?.[reference.ref] || savedBindings?.[String(sourceNumber)];
    const countName = assetName || availableFiles.find((file) => bindingMatchesFile(oldSlot, file))?.assetName || '';
    return { reference, uploadIndex, upload, assetName, number, sourceNumber, purpose, countName };
  });
  const bindings = definitions.map(({ reference, uploadIndex, upload, assetName, number, sourceNumber, purpose, countName }) => {
    const legacySeparate = reference.kind === 'legacy' && (Boolean(upload?.legacySeparate)
      || Boolean(countName && definitions.filter((definition) => definition.countName === countName).length > 1));
    const key = assetName && !legacySeparate ? namedReferenceKey(assetName) : `image:${sourceNumber}`;
    const exactCandidates = availableFiles.filter((file) => file.assetName === assetName);
    const candidates = assetName ? exactCandidates : availableFiles;
    const numberedSaved = savedBindings?.[String(sourceNumber || number)];
    const numberedSavedFile = availableFiles.find((file) => bindingMatchesFile(numberedSaved, file));
    // A newly inserted named reference must not inherit a former character's
    // numeric slot. Only an explicit old upload mapping may claim that slot.
    const compatibleNumberedSaved = reference.kind === 'legacy' || sourceNumber
      || (numberedSaved && (text(numberedSaved.assetName) === assetName || numberedSavedFile?.assetName === assetName))
      ? numberedSaved : null;
    const saved = savedBindings?.[key] || savedBindings?.[reference.ref] || compatibleNumberedSaved;
    const savedFile = availableFiles.find((file) => bindingMatchesFile(saved, file));
    let selected = savedFile || exactCandidates[0] || null;
    if (assetName && saved && ((text(saved.assetName) && text(saved.assetName) !== assetName)
      || (savedFile && savedFile.assetName !== assetName))) {
      errors.push(`${reference.ref} 必须绑定同名素材“${assetName}”，已保存的选图属于其他素材，请重新选择。`);
      selected = null;
    }
    if (assetName && !names.includes(assetName)) {
      errors.push(`${reference.ref} 指定的素材“${assetName}”在视觉素材中不存在。`);
    } else if (assetName && !exactCandidates.length) {
      errors.push(`${reference.ref} 指定的素材“${assetName}”尚未上传参考图。`);
    } else if (!assetName && !selected) {
      errors.push(`${reference.ref} 尚未绑定视觉素材中的具体参考图。`);
    }
    return {
      ref: reference.ref, number, key, sourceNumber, assetName, purpose, uploadIndex,
      legacy: reference.kind === 'legacy' && !upload,
      named: reference.kind === 'named', legacySeparate,
      addedInVideoStep: Boolean(upload?.addedInVideoStep),
      restoredFromLegacy: Boolean(upload?.restoredFromLegacy),
      candidates, exactCandidates, selected, savedBinding: saved || null,
    };
  });
  return {
    valid: errors.length === 0 && bindings.every((binding) => binding.selected),
    errors, bindings, availableFiles, references,
    legacyMode: bindings.some((binding) => binding.legacy),
    namedMode: bindings.some((binding) => binding.named),
  };
}

// Pure migration: callers may persist these fields together. Stable name keys
// preserve a user's chosen variant even when reference order changes later.
export function migrateNamedReferencePlan({ prompt, shot, assetItems = [], savedBindings = {} }) {
  const plan = resolveStrictReferencePlan({ prompt, shot, assetItems, savedBindings });
  const byRef = new Map(plan.bindings.map((binding) => [binding.ref, binding]));
  const migratedPrompt = replaceReferenceOccurrences(prompt, plan.references, (reference) => {
    const binding = byRef.get(reference.ref);
    const assetName = binding?.assetName || binding?.selected?.assetName;
    return assetName && !binding.legacySeparate ? `@${assetName}` : undefined;
  });
  const uploads = plan.bindings.map((binding) => ({
    ...(shot?.uploads?.[binding.uploadIndex] || {}),
    ref: !binding.legacySeparate && (binding.assetName || binding.selected?.assetName) ? `@${binding.assetName || binding.selected.assetName}` : binding.ref,
    asset: binding.assetName || binding.selected?.assetName || '',
    purpose: binding.purpose,
    ...(binding.legacySeparate ? { legacySeparate: true } : {}),
    ...(binding.legacy ? { restoredFromLegacy: true } : {}),
  }));
  const bindings = { ...savedBindings };
  plan.bindings.forEach((binding) => {
    const old = binding.savedBinding;
    const resolvedName = binding.assetName || binding.selected?.assetName;
    if (old) bindings[resolvedName && !binding.legacySeparate ? namedReferenceKey(resolvedName) : binding.key] = { ...old };
  });
  return {
    prompt: migratedPrompt, uploads, bindings, plan,
    changed: migratedPrompt !== text(prompt) || JSON.stringify(uploads) !== JSON.stringify(shot?.uploads || [])
      || JSON.stringify(bindings) !== JSON.stringify(savedBindings),
  };
}

export function buildSeedanceReferenceRequest({ prompt, shot, assetItems = [], savedBindings = {}, unifiedSuffix = '' }) {
  const plan = resolveStrictReferencePlan({ prompt, shot, assetItems, savedBindings });
  if (!plan.valid) throw new Error(plan.errors[0] || '当前镜头的参考图绑定不完整。');
  const mappingLines = plan.bindings.map((binding) => {
    const type = binding.selected.assetType || '参考图';
    const assetName = binding.selected.assetName || binding.assetName;
    return `图片${binding.number}：${type}“${assetName}”，唯一用途：${binding.purpose}。`;
  });
  const byRef = new Map(plan.bindings.map((binding) => [binding.ref, binding]));
  const promptText = replaceReferenceOccurrences(prompt, plan.references, (reference) => {
    const binding = byRef.get(reference.ref);
    return binding ? `图片${binding.number}` : undefined;
  })
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
