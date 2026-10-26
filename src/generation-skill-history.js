const STAGES = new Set(['storyboard', 'assets']);
const MAX_CONTENT_LENGTH = 200000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const EPOCH = '1970-01-01T00:00:00.000Z';

function document(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 260
    || typeof value.content !== 'string' || !value.content.trim() || value.content.length > MAX_CONTENT_LENGTH
    || (Number.isSafeInteger(value.size) && value.size > MAX_FILE_SIZE)) return null;
  return {
    name: value.name.trim(),
    content: value.content,
    ...(typeof value.format === 'string' && value.format.trim() && value.format.length <= 40 ? { format: value.format.trim().toLowerCase() } : {}),
    ...(Number.isSafeInteger(value.size) && value.size >= 0 ? { size: value.size } : {}),
    ...(typeof value.importedAt === 'string' && Number.isFinite(Date.parse(value.importedAt)) ? { importedAt: value.importedAt } : {}),
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
  };
}

function timestamp(value, fallback = EPOCH) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

function identifier(stage, content) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < content.length; index += 1) {
    const unit = content.charCodeAt(index);
    first = Math.imul(first ^ unit, 0x01000193);
    second = Math.imul(second ^ unit, 0x85ebca6b);
  }
  return `skill-${stage}-${content.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

function uniqueId(preferred, entries) {
  let id = preferred;
  let suffix = 2;
  while (entries.some(entry => entry.id === id)) id = `${preferred}-${suffix++}`;
  return id;
}

/** Return independent, valid documents, newest first; never truncate Skill text. */
export function normalizeSkillHistory(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const item of value) {
    if (!item || !STAGES.has(item.stage)) continue;
    const doc = document(item.doc);
    if (!doc) continue;
    const usedAt = timestamp(item.usedAt, timestamp(doc.importedAt));
    const existing = entries.find(entry => entry.stage === item.stage && entry.doc.content === doc.content);
    if (existing) {
      if (usedAt > existing.usedAt) Object.assign(existing, { doc, usedAt });
      continue;
    }
    const preferred = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(item.id) ? item.id : identifier(item.stage, doc.content);
    entries.push({ id: uniqueId(preferred, entries), stage: item.stage, doc, usedAt });
  }
  return entries.sort((a, b) => b.usedAt.localeCompare(a.usedAt));
}

/** Remember actual selection/import. Exact contents dedupe within their stage. */
export function rememberSkill(history, stage, value, usedAt = new Date().toISOString()) {
  const entries = normalizeSkillHistory(history);
  const doc = document(value);
  if (!STAGES.has(stage) || !doc) return entries;
  const existing = entries.find(entry => entry.stage === stage && entry.doc.content === doc.content);
  const entry = {
    id: existing?.id || uniqueId(identifier(stage, doc.content), entries),
    stage,
    doc,
    usedAt: timestamp(usedAt, timestamp(doc.importedAt)),
  };
  return [entry, ...entries.filter(item => item !== existing)].sort((a, b) => b.usedAt.localeCompare(a.usedAt));
}

/** Migrate existing projects without making every save look like a new use. */
export function seedSkillHistory(history, projects) {
  let entries = normalizeSkillHistory(history);
  const add = (stage, value, fallbackDate) => {
    const doc = document(value);
    if (!doc || entries.some(entry => entry.stage === stage && entry.doc.content === doc.content)) return;
    entries = rememberSkill(entries, stage, doc, timestamp(doc.importedAt, timestamp(fallbackDate)));
  };
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || typeof project !== 'object') continue;
    const date = project.updatedAt || project.createdAt;
    add('storyboard', project.generationSkills?.storyboard, date);
    add('assets', project.generationSkills?.assets, date);
    // Current image provenance only saves a name/hash. Such metadata is not a
    // reusable document; only an older full-content snapshot can be migrated.
    for (const item of Array.isArray(project.assetGeneration?.items) ? project.assetGeneration.items : []) {
      for (const file of Array.isArray(item?.files) ? item.files : []) add('assets', file?.generationSkill, file?.generatedAt || date);
    }
  }
  return entries;
}
