import { resolveStrictReferencePlan, replaceReferenceOccurrences } from './seedance-references.js';

export function buildH3ReferenceRequest({ prompt, shot, assetItems = [], savedBindings = {}, unifiedSuffix = '' }) {
  if (/@(?:Video|Audio)\d+/i.test(prompt)) throw new Error('当前 H3 接入支持图片参考，请先移除视频或音频引用。');
  const plan = resolveStrictReferencePlan({ prompt, shot, assetItems, savedBindings });
  if (!plan.valid) throw new Error(plan.errors[0] || '当前镜头参考图绑定不完整。');
  if (!plan.bindings.length) throw new Error('H3 参考图生成至少需要一张已绑定的图片。');
  const byRef = new Map(plan.bindings.map(binding => [binding.ref, binding]));
  const imageInputs = plan.bindings.map(binding => {
    if (!binding.selected.localPath) throw new Error(`${binding.ref} 缺少本地图片，方舟 Asset ID 不能用于 H3。`);
    return { localPath: binding.selected.localPath, referenceNumber: binding.number, assetName: binding.assetName || binding.selected.assetName };
  });
  const body = replaceReferenceOccurrences(prompt, plan.references, ref => `<Picture ${byRef.get(ref.ref).number}>`);
  const definitions = plan.bindings.map(binding => `<Picture ${binding.number}>: ${binding.selected.assetType || 'Reference'} — ${binding.assetName || binding.selected.assetName}. ${binding.purpose || ''}`);
  // Keep user dialogue and shot timing verbatim. No saved director example is merged.
  return {
    prompt: `Reference definitions:\n${definitions.join('\n')}\n\n${body}${unifiedSuffix.trim() ? `\n\n${unifiedSuffix.trim()}` : ''}`,
    imageInputs, imagePaths: imageInputs.map(input => input.localPath), plan,
  };
}
