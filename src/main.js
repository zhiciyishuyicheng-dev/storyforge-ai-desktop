import './style.css';
import { buildH3ReferenceRequest } from './h3-references.js';
import { comfyVideoSettingsTemplate, readComfyVideoSettings } from './comfy-video-ui.js';
import { normalizeSeedanceDuration, resolveSeedanceDuration, resolveStoryboardDuration } from './seedance-duration.js';
import { normalizeSeedanceGenerationMode, selectSeedanceGenerationIndexes } from './seedance-generation.js';
import { buildSeedanceReferenceRequest, ensureStoryboardShot, extractAssetReferences, migrateNamedReferencePlan, namedReferenceKey, resolveStrictReferencePlan } from './seedance-references.js';
import { createInitialWorkflowProgress, finishWorkflowProgress, formatProgressDuration, normalizeWorkflowProgress, summarizeWorkflowProgress } from './workflow-progress.js';

const LEGACY_STORAGE_KEY = 'storyforge-project-v1';
const LIBRARY_STORAGE_KEY = 'storyforge-project-library-v1';
const IMAGE_PROVIDER_STORAGE_KEY = 'storyforge-image-provider-v1';
const LIBRARY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 5;
// 保持付费 API 生图关闭；视觉素材可使用本机 Codex 的 ChatGPT 订阅或上传参考图。
const IMAGE_MODEL_GENERATION_ENABLED = false;
const SEEDREAM_DEFAULT_MODEL = 'doubao-seedream-5-0-lite-260128';
const SEEDREAM_DEFAULT_SIZE = '2K';
const SEEDREAM_MODELS = [
  { id: 'doubao-seedream-5-0-lite-260128', label: 'Seedream 5.0 Lite', pricePerImage: 0.22 },
  { id: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0 正式版', pricePerImage: null },
];
const OPENAI_IMAGE_MODEL = 'gpt-image-2';
const OPENAI_IMAGE_DEFAULT_SIZE = '1536x1024';
const OPENAI_IMAGE_DEFAULT_QUALITY = 'medium';
const OPENAI_IMAGE_SIZES = [
  { id: '1536x1024', label: '1536 x 1024（横版推荐）' },
  { id: '1024x1536', label: '1024 x 1536（竖版）' },
  { id: '1024x1024', label: '1024 x 1024（方形）' },
  { id: '2048x1152', label: '2048 x 1152（2K 横版）' },
  { id: '2160x3840', label: '2160 x 3840（4K 竖版，实验性）' },
];
const OPENAI_IMAGE_QUALITIES = [
  { id: 'low', label: '低（快速草稿）' },
  { id: 'medium', label: '中（推荐）' },
  { id: 'high', label: '高（最终素材）' },
];
const SEEDANCE_DEFAULT_MODEL = 'doubao-seedance-2-0-260128';
const SEEDANCE_DEFAULT_RATIO = '9:16';
const SEEDANCE_DEFAULT_RESOLUTION = '720p';
const SEEDANCE_DEFAULT_DURATION = 5;
const SEEDANCE_DEFAULT_GENERATION_MODE = 'batch';
const SEEDANCE_MODELS = [
  { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0' },
  { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast' },
];
const SEEDANCE_RATIOS = ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9', 'adaptive'];
const SEEDANCE_RESOLUTIONS = ['480p', '720p'];
const SEEDANCE_DURATIONS = Array.from({ length: 12 }, (_value, index) => index + 4);

const steps = [
  { id: 'analysis', no: '01', label: '故事分析', icon: '⌘', sub: '主线与人物' },
  { id: 'storyboard', no: '02', label: '分镜脚本', icon: '▦', sub: '镜头与动作' },
  { id: 'assets', no: '03', label: '视觉素材', icon: '✦', sub: '角色与场景' },
  { id: 'video', no: '04', label: '视频生成', icon: '▶', sub: '分镜视频' },
];

const demoScript = `第1集 失控的婚礼\n\n苏晚在婚礼现场等了两个小时，新郎陆沉却迟迟没有出现。所有人都在窃窃私语，只有她知道，陆沉昨晚发来的最后一条消息是：别相信你身边的人。\n\n就在她准备独自完成仪式时，大门被推开。一个和陆沉长得一模一样的男人走了进来。他当众叫出了她只有在梦里听过的小名。\n\n苏晚：你到底是谁？\n男人：我来接你回家。\n\n灯光熄灭，宾客的手机同时收到一张照片——照片里，苏晚已经死了三年。`;

const defaultProject = {
  schemaVersion: SCHEMA_VERSION,
  id: '',
  title: '未命名短剧项目',
  script: '',
  activeStep: 'analysis',
  completed: [],
  outputs: {},
  generationSkills: { storyboard: null, assets: null },
  storyboardGeneration: { provider: 'deepseek', model: '', reasoningEffort: '' },
  autoPipeline: null,
  autoRunToVideo: false,
  seedanceMaterials: { images: 3, videos: 0, audios: 0 },
  assetGeneration: { status: 'idle', provider: 'local', model: '', size: '', quality: '', items: [], outputDirectory: '', generatedCount: 0, totalCount: 0 },
  videoGeneration: { status: 'idle', model: SEEDANCE_DEFAULT_MODEL, ratio: SEEDANCE_DEFAULT_RATIO, resolution: SEEDANCE_DEFAULT_RESOLUTION, duration: SEEDANCE_DEFAULT_DURATION, generationMode: SEEDANCE_DEFAULT_GENERATION_MODE, generateAudio: true, items: [], outputDirectory: '', generatedCount: 0, totalCount: 0, lastError: '', pendingCertification: null },
  running: false,
  createdAt: null,
  updatedAt: null,
};

let projectLibrary = loadProjectLibrary();
let project = getActiveProject();
let toastTimer;
let generationRun = 0;
let viewNavigationSequence = 0;
let deepseekStatus = { configured: false, model: 'deepseek-flash', checking: true };
let codexTextStatus = { available: false, authenticated: false, configured: false, models: [], checking: true };
let codexTextSettingsOpen = false;
let codexTextStatusRequest = 0;
let seedreamStatus = { configured: false, model: SEEDREAM_DEFAULT_MODEL, size: SEEDREAM_DEFAULT_SIZE, models: SEEDREAM_MODELS, checking: true };
let openAIImageStatus = { configured: false, model: OPENAI_IMAGE_MODEL, size: OPENAI_IMAGE_DEFAULT_SIZE, quality: OPENAI_IMAGE_DEFAULT_QUALITY, sizes: OPENAI_IMAGE_SIZES, qualities: OPENAI_IMAGE_QUALITIES, checking: true };
let seedanceStatus = { configured: false, model: SEEDANCE_DEFAULT_MODEL, ratio: SEEDANCE_DEFAULT_RATIO, resolution: SEEDANCE_DEFAULT_RESOLUTION, duration: SEEDANCE_DEFAULT_DURATION, generationMode: SEEDANCE_DEFAULT_GENERATION_MODE, generateAudio: true, models: SEEDANCE_MODELS, ratios: SEEDANCE_RATIOS, resolutions: SEEDANCE_RESOLUTIONS, durations: SEEDANCE_DURATIONS, checking: true };
let imageProvider = loadImageProvider();
let imageProviderDraft = imageProvider;
let comfyVideoStatus = { configured: false, baseUrl: '', tokenConfigured: false, model: '', clipModel: '', videoVae: '', audioVae: '', ratio: '16:9', resolution: '480p', duration: 5, steps: 20, generationMode: 'confirm', generateAudio: true };
let seedanceGenerationModeDraft = SEEDANCE_DEFAULT_GENERATION_MODE;
let customAssetTargetShotIndex = null;
let codexImageStatus = { available: false, authenticated: false, imageGeneration: false, model: OPENAI_IMAGE_MODEL, checking: true };
let codexImageRun = null;
let codexImageSettingsOpen = false;
let workflowRun = null;
let autoPipelineRun = null;
let generationSkillImport = null;
let generationSkillImportSequence = 0;
let generationSkillPreview = null;
let clearResultRequest = null;

function normalizeGenerationSkillDocument(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 260
    || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 200000) return null;
  return {
    name: value.name.trim(),
    content: value.content,
    ...(typeof value.format === 'string' && value.format.trim() && value.format.length <= 40 ? { format: value.format.trim().toLowerCase() } : {}),
    ...(Number.isSafeInteger(value.size) && value.size >= 0 ? { size: value.size } : {}),
    ...(typeof value.importedAt === 'string' && Number.isFinite(Date.parse(value.importedAt)) ? { importedAt: value.importedAt } : {}),
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
  };
}

function normalizeGenerationSkills(value) {
  return {
    storyboard: normalizeGenerationSkillDocument(value?.storyboard),
    assets: normalizeGenerationSkillDocument(value?.assets),
  };
}

function normalizeStoryboardGeneration(value) {
  if (value?.provider !== 'codex-subscription') return { provider: 'deepseek', model: '', reasoningEffort: '' };
  return {
    provider: 'codex-subscription',
    model: typeof value.model === 'string' && value.model.trim().length <= 200 ? value.model.trim() : '',
    reasoningEffort: typeof value.reasoningEffort === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value.reasoningEffort.trim()) ? value.reasoningEffort.trim() : '',
  };
}

function codexTextModels() {
  return (Array.isArray(codexTextStatus.models) ? codexTextStatus.models : []).filter((item) => item && typeof item.model === 'string' && item.model && Array.isArray(item.supportedReasoningEfforts));
}

function resolveStoryboardGeneration(value = project.storyboardGeneration) {
  const settings = normalizeStoryboardGeneration(value);
  if (settings.provider === 'deepseek') return { ...settings, model: 'deepseek-flash', reasoningEffort: 'high', error: '' };
  const models = codexTextModels();
  const selected = settings.model ? models.find((item) => item.model === settings.model) : models.find((item) => item.isDefault) || models[0];
  if (!selected) return { ...settings, error: settings.model ? `模型 ${settings.model} 当前不可用，请重新选择模型。` : '未读取到可用 GPT 模型，请先检测 Codex 登录。' };
  const effort = settings.reasoningEffort || selected.defaultReasoningEffort || '';
  const supported = selected.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort);
  return { provider: settings.provider, model: selected.model, reasoningEffort: effort, error: supported ? '' : `模型 ${selected.displayName || selected.model} 不支持思考强度 ${effort || '默认值'}，请重新选择。` };
}

function reasoningEffortLabel(value) {
  return ({ none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极高' })[value] || value;
}

function storyboardProviderLabel(value = project.storyboardGeneration) {
  return value?.provider === 'codex-subscription' ? 'GPT 订阅' : 'DeepSeek V4.1 Flash';
}

function storyboardConnectionText() {
  if (project.storyboardGeneration?.provider !== 'codex-subscription') return deepseekStatus.checking ? '正在检查模型' : deepseekStatus.configured ? 'DeepSeek 已连接' : '配置 DeepSeek';
  if (codexTextStatus.checking) return '正在检测 GPT 订阅…';
  return codexTextStatus.available && codexTextStatus.authenticated ? 'GPT 订阅已连接' : '检查 GPT 订阅登录';
}

function isStoryboardProviderReady() {
  return project.storyboardGeneration?.provider === 'codex-subscription' ? Boolean(codexTextStatus.available && codexTextStatus.authenticated && !codexTextStatus.checking) : deepseekStatus.configured;
}

function normalizeAutoPipeline(value) {
  if (!value || !['running', 'completed', 'failed', 'stopped'].includes(value.status)) return null;
  const interrupted = value.status === 'running';
  return {
    status: interrupted ? 'stopped' : value.status,
    phase: ['checking', 'storyboard', 'assets', 'video'].includes(value.phase) ? value.phase : 'storyboard',
    error: interrupted ? '上次全流程已中断，已完成的成果仍保留。' : typeof value.error === 'string' ? value.error : '',
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : null,
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : null,
  };
}

function createProject(overrides = {}) {
  const now = new Date().toISOString();
  return {
    ...defaultProject,
    seedanceMaterials: { ...defaultProject.seedanceMaterials },
    assetGeneration: { ...defaultProject.assetGeneration, items: [] },
    videoGeneration: { ...defaultProject.videoGeneration, items: [] },
    ...overrides,
    generationSkills: normalizeGenerationSkills(overrides.generationSkills),
    storyboardGeneration: normalizeStoryboardGeneration(overrides.storyboardGeneration),
    autoPipeline: normalizeAutoPipeline(overrides.autoPipeline),
    autoRunToVideo: overrides.autoRunToVideo === true,
    id: overrides.id || createProjectId(),
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || null,
    running: false,
  };
}

function createProjectId() {
  return globalThis.crypto?.randomUUID?.() || `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeProject(saved) {
  const migrated = createProject(saved && typeof saved === 'object' ? saved : {});
  migrated.completed = Array.isArray(saved?.completed) ? [...new Set(saved.completed.filter((id) => steps.some((step) => step.id === id)))] : [];
  migrated.outputs = saved?.outputs && typeof saved.outputs === 'object'
    ? Object.fromEntries(Object.entries(saved.outputs).filter(([id, output]) => steps.some((step) => step.id === id) && output && typeof output === 'object'))
    : {};
  if (!steps.some((step) => step.id === migrated.activeStep)) {
    migrated.activeStep = migrated.outputs.storyboard ? 'storyboard' : 'analysis';
  }
  migrated.seedanceMaterials = { ...defaultProject.seedanceMaterials, ...(saved?.seedanceMaterials || {}) };
  migrated.assetGeneration = {
    ...defaultProject.assetGeneration,
    ...(saved?.assetGeneration || {}),
    items: Array.isArray(saved?.assetGeneration?.items) ? saved.assetGeneration.items : [],
  };
  migrated.assetGeneration.provider = 'local';
  migrated.assetGeneration.items = migrated.assetGeneration.items.map((item) => {
    const files = Array.isArray(item?.files) ? item.files.filter((file) => file?.localPath) : [];
    if (!files.length && item?.localPath) {
      files.push({
        localPath: item.localPath,
        imageUrl: item.imageUrl || '',
        fileName: item.fileName || '',
        sourceName: item.fileName || '',
      });
    }
    return {
      ...item,
      files,
      status: files.length ? 'success' : 'pending',
      localPath: files[0]?.localPath || '',
      imageUrl: files[0]?.imageUrl || '',
      error: '',
    };
  });
  migrated.videoGeneration = {
    ...defaultProject.videoGeneration,
    ...(saved?.videoGeneration || {}),
    items: Array.isArray(saved?.videoGeneration?.items) ? saved.videoGeneration.items.map((savedItem) => {
      const item = normalizeVideoItemVersions(savedItem);
      if (['creating', 'queued', 'running', 'downloading'].includes(item.status)) {
        const resumable = item.taskProvider === 'comfy' && item.taskId;
        item.status = resumable ? 'pending' : getSelectedVideoVersion(item) ? 'success' : 'pending';
        if (!resumable) item.taskId = '';
      }
      return item;
    }) : [],
  };
  migrated.videoGeneration.generatedCount = migrated.videoGeneration.items.filter((item) => getSelectedVideoVersion(item)).length;
  if (migrated.videoGeneration.status === 'running') {
    migrated.videoGeneration.status = migrated.videoGeneration.items.length > 0
      && migrated.videoGeneration.generatedCount === migrated.videoGeneration.items.length ? 'complete' : 'pending';
  }
  if (migrated.outputs.video?.body?.includes('video-preview')) {
    migrated.outputs.video = { title: 'Seedance 分镜视频', subtitle: '按第二步分镜逐条生成并保存 MP4', time: '数分钟 / 镜头', body: '' };
  }
  const promptItems = migrated.outputs?.assets?.promptItems;
  if (Array.isArray(promptItems)) {
    const filteredPrompts = promptItems.filter((item) => !isDeprecatedOverviewItem(item));
    if (filteredPrompts.length !== promptItems.length) {
      migrated.outputs.assets.promptItems = filteredPrompts;
      migrated.outputs.assets.subtitle = `${filteredPrompts.length} 张 · 人物三视图、场景多视角、群像与道具`;
      const validFiles = new Set(filteredPrompts.map((item) => String(item.fileName || '')).filter(Boolean));
      migrated.assetGeneration.items = migrated.assetGeneration.items.filter((item) => {
        const fileName = String(item?.fileName || '');
        return !isDeprecatedOverviewItem(item) && (!fileName || validFiles.has(fileName));
      });
      migrated.assetGeneration.totalCount = filteredPrompts.length;
      migrated.assetGeneration.generatedCount = migrated.assetGeneration.items.filter((item) => item.status === 'success').length;
    }
  }
  // Removing intermediate steps must preserve confirmed storyboards and local image/video files.
  migrated.schemaVersion = SCHEMA_VERSION;
  migrated.running = false;
  migrated.workflowProgress = normalizeWorkflowProgress(saved?.workflowProgress);
  if (migrated.workflowProgress?.status === 'running') {
    migrated.workflowProgress = finishWorkflowProgress(migrated.workflowProgress, 'stopped', '上次生成已中断', migrated.workflowProgress.updatedAt);
  }
  if (Array.isArray(migrated.outputs.assets?.promptItems)) {
    const prompts = migrated.outputs.assets.promptItems;
    alignAssetGenerationItems(prompts, migrated);
    migrated.outputs.assets.promptItems = prompts.map((item, index) => ({ ...item, fileName: assetImageFileName(item.name, index) }));
    migrated.assetGeneration.items.forEach((item, index) => { item.fileName = migrated.outputs.assets.promptItems[index].fileName; });
  }
  return migrated;
}

function loadProjectLibrary() {
  try {
    const savedLibrary = JSON.parse(localStorage.getItem(LIBRARY_STORAGE_KEY));
    if (savedLibrary && Array.isArray(savedLibrary.projects) && savedLibrary.projects.length) {
      const projects = savedLibrary.projects.map(normalizeProject);
      const activeProjectId = projects.some((item) => item.id === savedLibrary.activeProjectId)
        ? savedLibrary.activeProjectId
        : projects[0].id;
      return { schemaVersion: LIBRARY_SCHEMA_VERSION, activeProjectId, projects };
    }
  }
  catch { /* Try the legacy single-project storage below. */ }

  let firstProject;
  try {
    const legacyProject = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
    firstProject = normalizeProject(legacyProject);
  } catch { firstProject = createProject(); }
  const library = { schemaVersion: LIBRARY_SCHEMA_VERSION, activeProjectId: firstProject.id, projects: [firstProject] };
  localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(library));
  return library;
}

function getActiveProject() {
  return projectLibrary.projects.find((item) => item.id === projectLibrary.activeProjectId) || projectLibrary.projects[0];
}

function saveProjectLibrary() {
  localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(projectLibrary));
}

function saveProject() {
  project.updatedAt = new Date().toISOString();
  const index = projectLibrary.projects.findIndex((item) => item.id === project.id);
  if (index >= 0) projectLibrary.projects[index] = project;
  else projectLibrary.projects.push(project);
  projectLibrary.activeProjectId = project.id;
  saveProjectLibrary();
}

function esc(value = '') {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function isDeprecatedOverviewItem(item) {
  const identity = [item?.type, item?.name, item?.fileName].map((value) => String(value || '')).join(' ');
  return item?.type === '总览参考板' || /九宫格制作参考板|制作参考板.*九宫格/.test(identity);
}

function cleanRemoteError(error, fallback = '操作失败') {
  const message = String(error?.message || error || fallback);
  const cleaned = message
    .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
  if (/has not activated the model|model service.*not activated|not activated.*model/i.test(cleaned)) {
    const model = cleaned.match(/doubao-seedream-[a-z0-9-]+/i)?.[0] || '';
    const label = model.includes('-lite-') ? 'Seedream 5.0 Lite' : 'Seedream 5.0 正式版';
    return `当前火山方舟账号尚未开通 ${label}${model ? `（${model}）` : ''}。充值不会自动开通模型，请到火山方舟“开通管理”启用，或在模型设置中切换到已开通的版本。`;
  }
  return cleaned;
}

function loadImageProvider() {
  const saved = localStorage.getItem(IMAGE_PROVIDER_STORAGE_KEY);
  return saved === 'openai' ? 'openai' : 'seedream';
}

function saveImageProvider(provider) {
  imageProvider = provider === 'openai' ? 'openai' : 'seedream';
  localStorage.setItem(IMAGE_PROVIDER_STORAGE_KEY, imageProvider);
}

function seedreamModelLabel(modelId) {
  return SEEDREAM_MODELS.find((item) => item.id === modelId)?.label || 'Seedream 5.0';
}

function activeImageStatus(provider = imageProvider) {
  return provider === 'openai' ? openAIImageStatus : seedreamStatus;
}

function imageProviderLabel(provider = imageProvider) {
  return provider === 'openai' ? 'GPT Image 2' : seedreamModelLabel(seedreamStatus.model);
}

function imageSizeLabel(provider = imageProvider, status = activeImageStatus(provider)) {
  if (provider === 'openai') return OPENAI_IMAGE_SIZES.find((item) => item.id === status.size)?.label || status.size;
  return status.size;
}

function imageQualityLabel(value) {
  return OPENAI_IMAGE_QUALITIES.find((item) => item.id === value)?.label || value;
}

function seedanceModelLabel(modelId = currentVideoSettings().model) {
  if (/ref2va/i.test(modelId) || (activeVideoProvider() === 'comfy' && !modelId)) return 'MiniMax H3 · Ref2VA';
  return SEEDANCE_MODELS.find((item) => item.id === modelId)?.label || 'Seedance 2.0';
}

function activeVideoProvider() { return project.videoGeneration?.provider === 'comfy' ? 'comfy' : 'seedance'; }
function currentVideoSettings() { return activeVideoProvider() === 'comfy' ? comfyVideoStatus : seedanceStatus; }

function currentIndex() { return steps.findIndex((step) => step.id === project.activeStep); }

function projectListTemplate() {
  return [...projectLibrary.projects]
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .map((item) => {
      const selected = item.id === project.id;
      return `<div class="project-row ${selected ? 'selected' : ''}"><button class="project-item ${selected ? 'selected' : ''}" data-project-id="${esc(item.id)}" title="切换到 ${esc(item.title)}"><span class="project-dot"></span><span class="project-name">${esc(item.title)}</span></button>${projectLibrary.projects.length > 1 ? `<button class="delete-project" data-delete-project-id="${esc(item.id)}" title="删除 ${esc(item.title)}" aria-label="删除 ${esc(item.title)}">×</button>` : ''}</div>`;
    })
    .join('');
}

function portraitCertificationModalTemplate() {
  const pending = project.videoGeneration?.pendingCertification;
  const blockedInputs = Array.isArray(pending?.blockedInputs) ? pending.blockedInputs : [];
  const fields = blockedInputs.map((input, index) => {
    const savedId = project.assetGeneration?.items?.[input.assetItemIndex]?.files?.[input.fileIndex]?.trustedAssetId || '';
    return `<label class="key-field portrait-asset-field"><span>${esc(String(input.assetName || `参考图${index + 1}`))}</span><small>${esc(String(input.sourceName || '本地参考图'))} · 请求位置 content[${Number(input.contentIndex) || index + 1}]</small><input data-portrait-asset-id-index="${index}" type="text" value="${esc(String(savedId))}" placeholder="asset-2026..." autocomplete="off"></label>`;
  }).join('');
  return `<div class="modal-backdrop" id="portraitCertificationModal" hidden><div class="settings-modal portrait-certification-modal"><div class="modal-head"><div><span class="section-kicker">TRUSTED PORTRAIT ASSETS</span><h2>真人素材认证</h2></div><button id="closePortraitCertification">×</button></div><div class="model-lock portrait-certification-lock"><span>Seedance 可信素材库</span><b>认证后自动继续镜头 ${String((pending?.shotIndex || 0) + 1).padStart(2, '0')}</b><small>火山方舟拦截了以下可能包含真人的参考图。请由演员本人在方舟完成认证与授权，然后把每张素材详情中的 Asset ID 填入下方；软件会改用 asset:// 可信素材并自动重试。</small></div><div class="portrait-certification-notice">演员扫码、人脸核验和授权必须由本人完成，软件不会绕过肖像权认证。</div><div class="portrait-asset-fields">${fields || '<p>没有识别到具体拦截图片，请关闭窗口后重试镜头。</p>'}</div><div class="key-links"><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/experience" target="_blank">前往方舟体验中心认证真人素材 ↗</a><a class="key-help" href="https://www.volcengine.com/docs/82379/2315856?lang=zh" target="_blank">查看官方认证说明 ↗</a></div><div class="modal-message" id="portraitCertificationMessage"></div><div class="modal-actions"><button class="outline-button" id="cancelPortraitCertification">稍后处理</button><button class="primary-button" id="savePortraitCertification" ${fields ? '' : 'disabled'}>保存并自动继续生成</button></div></div></div>`;
}

function isCodexImageReady() {
  return Boolean(!codexImageStatus.checking && codexImageStatus.available && codexImageStatus.authenticated && codexImageStatus.imageGeneration === true);
}

function codexImageStatusText() {
  if (codexImageStatus.checking) return '正在检测本机 Codex…';
  if (!codexImageStatus.available) return codexImageStatus.cliPath ? '本机 Codex 当前不可用' : '未找到本机 Codex';
  if (!codexImageStatus.authenticated) return 'Codex 尚未通过 ChatGPT 登录';
  if (!codexImageStatus.imageGeneration) return '当前 Codex 不支持订阅生图';
  return 'Codex 已登录 · 生图可用';
}

function codexImageSettingsDetails() {
  const plans = { prolite: 'ChatGPT Pro', pro: 'ChatGPT Pro', plus: 'ChatGPT Plus', team: 'ChatGPT Business', business: 'ChatGPT Business', enterprise: 'ChatGPT Enterprise', free: 'ChatGPT Free', edu: 'ChatGPT Edu' };
  const planLabel = plans[String(codexImageStatus.planType || '').toLowerCase()] || codexImageStatus.planType || '未检测到';
  return `<div class="codex-image-status-detail"><div><span>本机状态</span><b class="${isCodexImageReady() ? 'available' : ''}">${esc(codexImageStatusText())}</b></div><div><span>生图模型</span><b>GPT Image 2 · gpt-image-2</b></div><div><span>订阅计划</span><b>${esc(String(planLabel))}</b></div><div class="codex-program-path"><span>Codex 程序</span><code>${esc(String(codexImageStatus.cliPath || '自动检测本机已安装的程序'))}</code></div></div>${codexImageStatus.error ? `<p class="seedream-global-error">${esc(cleanRemoteError(codexImageStatus.error, '检测失败'))}</p>` : ''}<p class="codex-image-settings-help">请先在本机安装 Codex，并使用有权限的 ChatGPT 账号登录。生成使用 Codex 订阅限额，无需填写 OpenAI API Key。此处只检查程序、登录和功能状态，实际可用额度以生成结果为准。</p>`;
}

function codexImageSettingsTemplate() {
  return `<div class="modal-backdrop" id="codexImageSettingsModal" ${codexImageSettingsOpen ? '' : 'hidden'}><div class="settings-modal codex-image-settings-modal"><div class="modal-head"><div><span class="section-kicker">GPT SUBSCRIPTION IMAGES</span><h2>GPT 订阅生图设置</h2></div><button id="closeCodexImageSettings" aria-label="关闭 GPT 订阅生图设置">×</button></div><div class="model-lock openai-image-lock"><span>本机 Codex · ChatGPT 登录</span><b>GPT Image 2</b><small>用第三步的参考图提示词生成图片，自动保存到当前项目的视觉素材目录。</small></div><div id="codexImageSettingsDetails">${codexImageSettingsDetails()}</div><div class="modal-actions"><button class="outline-button" id="chooseCodexImageCli" ${codexImageStatus.checking || project.running ? 'disabled' : ''}>选择 Codex 程序</button><button class="primary-button" id="refreshCodexImageStatus" ${codexImageStatus.checking ? 'disabled' : ''}>${codexImageStatus.checking ? '正在检测…' : '重新检测'}</button></div></div></div>`;
}

function updateCodexImageStatusView() {
  document.querySelectorAll('[data-codex-image-status]').forEach((node) => { node.textContent = codexImageStatusText(); });
  const pill = document.querySelector('#heroCodexImageStatus');
  pill?.classList.toggle('connected', isCodexImageReady());
  pill?.classList.toggle('disconnected', !isCodexImageReady());
  const details = document.querySelector('#codexImageSettingsDetails');
  if (details) details.innerHTML = codexImageSettingsDetails();
  const refreshButton = document.querySelector('#refreshCodexImageStatus');
  if (refreshButton) {
    refreshButton.disabled = codexImageStatus.checking;
    refreshButton.textContent = codexImageStatus.checking ? '正在检测…' : '重新检测';
  }
  const chooseButton = document.querySelector('#chooseCodexImageCli');
  if (chooseButton) chooseButton.disabled = codexImageStatus.checking || project.running;
}

async function refreshCodexImageStatus({ choose = false } = {}) {
  codexImageStatus = { ...codexImageStatus, checking: true, error: '' };
  updateCodexImageStatusView();
  try {
    const method = choose ? window.storyforgeAI?.chooseCodexImageCli : window.storyforgeAI?.getCodexImageStatus;
    if (!method) throw new Error('当前环境无法检测本机 Codex，请使用更新后的桌面版。');
    codexImageStatus = { ...(await method()), model: OPENAI_IMAGE_MODEL, checking: false };
  } catch (error) {
    codexImageStatus = { ...codexImageStatus, available: false, authenticated: false, imageGeneration: false, checking: false, error: cleanRemoteError(error, '检测本机 Codex 失败') };
  }
  updateCodexImageStatusView();
  return codexImageStatus;
}

function openCodexImageSettings() {
  codexImageSettingsOpen = true;
  const modal = document.querySelector('#codexImageSettingsModal');
  if (modal) modal.hidden = false;
  if (!codexImageStatus.checking) refreshCodexImageStatus();
}

function closeCodexImageSettings() {
  codexImageSettingsOpen = false;
  const modal = document.querySelector('#codexImageSettingsModal');
  if (modal) modal.hidden = true;
}

function storyboardGenerationControlsTemplate() {
  const settings = normalizeStoryboardGeneration(project.storyboardGeneration);
  const subscription = settings.provider === 'codex-subscription';
  const resolved = resolveStoryboardGeneration(settings);
  const models = codexTextModels();
  const selected = models.find((item) => item.model === resolved.model);
  const efforts = selected?.supportedReasoningEfforts || [];
  const busyReason = project.running ? '当前任务正在生成，生成方式、模型和思考强度已锁定。请等待完成，或先点击“停止当前任务”。' : '';
  const detectionReason = codexTextStatus.checking ? '正在检测 GPT 订阅并读取可用模型，请稍候；也可以先切回 DeepSeek。' : !codexTextStatus.authenticated ? '尚未连接 GPT 订阅，请点击“订阅设置 / 检测”，使用 ChatGPT 登录本机 Codex 后重新检测。' : '暂未读取到可用模型，请点击“订阅设置 / 检测”查看原因并重新检测。';
  const control = (id, label, options, reason = '', className = '') => `<div class="storyboard-generation-field ${className}" data-storyboard-part="${id}"><label for="${id}">${label}</label><span class="storyboard-control-wrap${reason ? ' locked' : ''}"><select id="${id}" aria-label="${label === '生成方式' ? '分镜生成方式' : label === '模型' ? 'GPT 分镜模型' : 'GPT 思考强度'}" ${reason ? 'disabled' : ''}>${options}</select>${reason ? `<button type="button" class="storyboard-control-feedback" data-storyboard-control="${id}" data-blocked-reason="${esc(reason)}" aria-label="${label}暂不可修改：${esc(reason)}" title="${esc(reason)}"></button>` : ''}</span></div>`;
  const modelOptions = `${settings.model && !selected ? `<option value="${esc(settings.model)}" selected>${esc(settings.model)}（当前不可用）</option>` : ''}${models.map((item) => `<option value="${esc(item.model)}" ${item.model === resolved.model ? 'selected' : ''}>${esc(item.displayName || item.model)}</option>`).join('')}`;
  const effortOptions = `${settings.reasoningEffort && !efforts.some((item) => item.reasoningEffort === resolved.reasoningEffort) ? `<option value="${esc(settings.reasoningEffort)}" selected>${esc(reasoningEffortLabel(settings.reasoningEffort))}（当前不支持）</option>` : ''}${efforts.map((item) => `<option value="${esc(item.reasoningEffort)}" title="${esc(item.description || '')}" ${item.reasoningEffort === resolved.reasoningEffort ? 'selected' : ''}>${esc(reasoningEffortLabel(item.reasoningEffort))} · ${esc(item.reasoningEffort)}</option>`).join('')}`;
  const help = subscription ? codexTextStatus.checking ? '正在读取本机 Codex 可用模型…' : codexTextStatus.error || (!codexTextStatus.authenticated ? '请使用 ChatGPT 账号登录本机 Codex，再检测连接。' : resolved.error || '使用 ChatGPT / Codex 订阅限额；本次分析、审计和回炉使用相同模型与思考强度。') : '前两步一并生成；沿用当前 Skill、独立审计与最多一次回炉。';
  return `${control('storyboardProvider', '生成方式', `<option value="deepseek" ${subscription ? '' : 'selected'}>DeepSeek</option><option value="codex-subscription" ${subscription ? 'selected' : ''}>GPT 订阅</option>`, busyReason)}${subscription ? `${control('storyboardModel', '模型', modelOptions || '<option value="">请先检测连接</option>', busyReason || (codexTextStatus.checking || !models.length ? detectionReason : ''), 'storyboard-model-field')}${control('storyboardReasoningEffort', '思考强度', effortOptions || '<option value="">请先选择模型</option>', busyReason || (codexTextStatus.checking || !models.length ? detectionReason : !selected || !efforts.length ? '当前模型没有可选择的思考强度，请先选择可用模型，或在“订阅设置 / 检测”中重新检测。' : ''))}<button class="outline-button" id="openCodexTextSettings" data-storyboard-part="settings">订阅设置 / 检测</button>` : `<span class="storyboard-fixed-model" data-storyboard-part="fixed-model">DeepSeek V4.1 Flash · 思考 high</span>`}<small data-storyboard-part="help" class="storyboard-generation-help${subscription && !codexTextStatus.checking && (codexTextStatus.error || resolved.error) ? ' error' : ''}" title="${esc(help)}">${esc(help)}</small>`;
}

function storyboardGenerationTemplate() {
  return ['analysis', 'storyboard'].includes(project.activeStep) ? `<section class="storyboard-generation-controls" id="storyboardGenerationControls" aria-label="故事分析与分镜生成设置">${storyboardGenerationControlsTemplate()}</section>` : '';
}

function codexTextSettingsDetails() {
  const count = codexTextModels().length;
  const state = codexTextStatus.checking ? '正在检测本机 Codex…' : !codexTextStatus.available ? '本机 Codex 不可用' : !codexTextStatus.authenticated ? '尚未使用 ChatGPT 登录' : `ChatGPT 已登录 · ${count} 个可用模型`;
  return `<div class="codex-image-status-detail"><div><span>订阅状态</span><b>${esc(state)}</b></div><div class="codex-program-path"><span>Codex 程序</span><code>${esc(String(codexTextStatus.cliPath || '自动检测本机已安装的程序'))}</code></div></div>${codexTextStatus.error ? `<p class="seedream-global-error">${esc(cleanRemoteError(codexTextStatus.error, '检测失败'))}</p>` : ''}<p class="codex-image-settings-help">使用本机 Codex 的 ChatGPT 登录和订阅限额，无需 OpenAI API Key。可用模型和思考强度由当前账号提供；在生成结果上方选择后，下次分析、分镜、独立审计和回炉均按本次选择执行。此处检测不会生成内容。</p>`;
}

function codexTextSettingsTemplate() {
  return `<div class="modal-backdrop" id="codexTextSettingsModal" ${codexTextSettingsOpen ? '' : 'hidden'}><div class="settings-modal"><div class="modal-head"><div><span class="section-kicker">GPT SUBSCRIPTION STORYBOARDS</span><h2>GPT 订阅分镜设置</h2></div><button id="closeCodexTextSettings" aria-label="关闭 GPT 订阅分镜设置">×</button></div><div id="codexTextSettingsDetails">${codexTextSettingsDetails()}</div><div class="modal-actions"><button class="outline-button" id="chooseCodexTextCli" ${project.running || codexTextStatus.checking ? 'disabled' : ''}>选择 Codex 程序</button><button class="primary-button" id="refreshCodexTextStatus" ${project.running || codexTextStatus.checking ? 'disabled' : ''}>${codexTextStatus.checking ? '正在检测…' : '重新检测'}</button></div></div></div>`;
}

function bindStoryboardGenerationEvents() {
  document.querySelectorAll('[data-storyboard-control]').forEach((button) => { button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); showToast(button.dataset.blockedReason); }; });
  const provider = document.querySelector('#storyboardProvider');
  if (provider) provider.onchange = (event) => {
    if (!setStoryboardGeneration({ provider: event.target.value })) return;
    if (project.storyboardGeneration.provider === 'codex-subscription' && !codexTextStatus.checking) refreshCodexTextStatus();
  };
  const modelControl = document.querySelector('#storyboardModel');
  if (modelControl) modelControl.onchange = (event) => {
    if (project.running) return showToast('当前任务正在生成，请等待完成，或先点击“停止当前任务”后修改模型。');
    if (codexTextStatus.checking) return showToast('正在检测 GPT 订阅并读取可用模型，请稍候。');
    const model = codexTextModels().find((item) => item.model === event.target.value);
    if (!model) return showToast('当前模型不可用，请在“订阅设置 / 检测”中重新检测。');
    setStoryboardGeneration({ provider: 'codex-subscription', model: model.model, reasoningEffort: model.defaultReasoningEffort || '' });
  };
  const effortControl = document.querySelector('#storyboardReasoningEffort');
  if (effortControl) effortControl.onchange = (event) => {
    if (project.running) return showToast('当前任务正在生成，请等待完成，或先点击“停止当前任务”后修改思考强度。');
    if (codexTextStatus.checking) return showToast('正在检测 GPT 订阅并读取可用模型，请稍候。');
    const selected = resolveStoryboardGeneration();
    const model = codexTextModels().find((item) => item.model === selected.model);
    if (!model?.supportedReasoningEfforts.some((item) => item.reasoningEffort === event.target.value)) return showToast('当前模型不支持这个思考强度，请选择可用选项。');
    if (setStoryboardGeneration({ provider: 'codex-subscription', model: selected.model, reasoningEffort: event.target.value })) updateWorkflowProgressPanel();
  };
  const settings = document.querySelector('#openCodexTextSettings');
  if (settings) settings.onclick = openCodexTextSettings;
}

function setStoryboardGeneration(value) {
  if (project.running) { showToast('生成进行中，完成或停止后可调整模型与思考强度'); return false; }
  const previous = project.storyboardGeneration;
  const previousUpdatedAt = project.updatedAt;
  project.storyboardGeneration = normalizeStoryboardGeneration(value);
  try { saveProject(); }
  catch (error) {
    project.storyboardGeneration = previous;
    project.updatedAt = previousUpdatedAt;
    renderWithoutMovingPage();
    showToast(`保存分镜生成设置失败，已保留原设置：${cleanRemoteError(error, '本地存储不可用')}`);
    return false;
  }
  renderWithoutMovingPage();
  return true;
}

function updateCodexTextStatusView() {
  const panel = document.querySelector('#storyboardGenerationControls');
  if (panel) {
    // Keep unchanged selects mounted: a late status response must not close an open provider menu.
    const template = document.createElement('template');
    template.innerHTML = storyboardGenerationControlsTemplate();
    const previous = new Map(Array.from(panel.children, (node) => [node.dataset.storyboardPart, node]));
    Array.from(template.content.children).forEach((next, index) => {
      const key = next.dataset.storyboardPart;
      const current = previous.get(key);
      const node = current?.outerHTML === next.outerHTML ? current : next;
      if (current && node !== current) current.replaceWith(node);
      if (panel.children[index] !== node) panel.insertBefore(node, panel.children[index] || null);
      previous.delete(key);
    });
    previous.forEach((node) => node.remove());
    bindStoryboardGenerationEvents();
  }
  const details = document.querySelector('#codexTextSettingsDetails');
  if (details) details.innerHTML = codexTextSettingsDetails();
  const refresh = document.querySelector('#refreshCodexTextStatus');
  if (refresh) { refresh.disabled = project.running || codexTextStatus.checking; refresh.textContent = codexTextStatus.checking ? '正在检测…' : '重新检测'; }
  const choose = document.querySelector('#chooseCodexTextCli');
  if (choose) choose.disabled = project.running || codexTextStatus.checking;
  if (project.storyboardGeneration?.provider === 'codex-subscription') {
    const hero = document.querySelector('#heroModelStatus');
    if (hero) { hero.innerHTML = `<i></i> ${esc(storyboardConnectionText())}`; hero.classList.toggle('connected', isStoryboardProviderReady()); hero.classList.toggle('disconnected', !isStoryboardProviderReady()); }
    const account = document.querySelector('#openSettings small');
    if (account) account.textContent = storyboardConnectionText();
  }
}

async function refreshCodexTextStatus({ choose = false } = {}) {
  const request = ++codexTextStatusRequest;
  codexTextStatus = { ...codexTextStatus, checking: true, error: '' };
  updateCodexTextStatusView();
  try {
    const method = choose ? window.storyforgeAI?.chooseCodexTextCli : window.storyforgeAI?.getCodexTextStatus;
    if (!method) throw new Error('当前环境无法使用 GPT 订阅分镜，请安装更新后的桌面版。');
    const status = await method();
    if (request !== codexTextStatusRequest) return codexTextStatus;
    codexTextStatus = { ...status, models: Array.isArray(status?.models) ? status.models : [], checking: false };
  } catch (error) {
    if (request !== codexTextStatusRequest) return codexTextStatus;
    codexTextStatus = { ...codexTextStatus, available: false, authenticated: false, configured: false, models: [], checking: false, error: cleanRemoteError(error, '检测 GPT 订阅失败') };
  }
  updateCodexTextStatusView();
  return codexTextStatus;
}

function openCodexTextSettings() {
  codexTextSettingsOpen = true;
  const modal = document.querySelector('#codexTextSettingsModal');
  if (modal) modal.hidden = false;
  if (!project.running && !codexTextStatus.checking) refreshCodexTextStatus();
}

function closeCodexTextSettings() {
  codexTextSettingsOpen = false;
  const modal = document.querySelector('#codexTextSettingsModal');
  if (modal) modal.hidden = true;
}

function openStoryboardSettings() {
  return project.storyboardGeneration?.provider === 'codex-subscription' ? openCodexTextSettings() : openModelSettings();
}

function generationSkillTemplate() {
  const stage = ['analysis', 'storyboard'].includes(project.activeStep) ? 'storyboard' : project.activeStep === 'assets' ? 'assets' : null;
  if (!stage) return '';
  const doc = project.generationSkills?.[stage];
  const importing = generationSkillImport?.ownerProject === project && generationSkillImport.stage === stage;
  const label = stage === 'storyboard' ? '分镜 Skill' : '资产 Skill';
  const help = stage === 'assets' ? '上传后，下次实际 GPT 生图立即采用，已有提示词和图片会保留。' : '替换或移除只影响下次生成，已有分镜和图片会保留。';
  return `<section class="generation-skill-card" aria-label="${label}" title="${help}"><div class="generation-skill-copy"><div><b>${label}</b><span class="generation-skill-state ${doc ? 'enabled' : ''}">${importing ? '正在读取文件…' : doc ? '已启用' : '未上传'}</span></div><p title="${doc ? esc(`${doc.name} · 正文 ${doc.content.length.toLocaleString()} 字符`) : help}">${doc ? `${esc(doc.name)} · 正文 ${doc.content.length.toLocaleString()} 字符` : stage === 'storyboard' ? '默认使用内置 v2.1' : '可上传本阶段生成要求'}</p></div><div class="generation-skill-actions"><button class="outline-button" data-import-generation-skill="${stage}" ${project.running || importing ? 'disabled' : ''}>${importing ? '正在读取…' : doc ? '替换 Skill' : '上传 Skill'}</button>${doc ? `<button class="outline-button" data-preview-generation-skill="${stage}" ${project.running ? 'disabled' : ''}>预览</button><button class="outline-button" data-remove-generation-skill="${stage}" ${project.running ? 'disabled' : ''}>移除</button>` : ''}</div></section>`;
}

function generationSkillPreviewTemplate() {
  const preview = generationSkillPreview?.ownerProject === project ? generationSkillPreview : null;
  if (!preview) return '';
  return `<div class="modal-backdrop" id="generationSkillPreviewModal"><div class="settings-modal generation-skill-preview-modal"><div class="modal-head"><div><span class="section-kicker">SKILL PREVIEW</span><h2>${preview.stage === 'storyboard' ? '分镜 Skill' : '资产 Skill'}</h2></div><button id="closeGenerationSkillPreview" aria-label="关闭 Skill 预览">×</button></div><p>${esc(preview.doc.name)} · 正文 ${preview.doc.content.length.toLocaleString()} 字符</p><pre>${esc(preview.doc.content)}</pre><small>文件内容作为本项目对应阶段的生成要求使用。</small></div></div>`;
}

function saveGenerationSkill(stage, doc, ownerProject = project) {
  if (!['storyboard', 'assets'].includes(stage) || ownerProject !== project || ownerProject.running) return false;
  const previous = ownerProject.generationSkills;
  const previousUpdatedAt = ownerProject.updatedAt;
  ownerProject.generationSkills = { ...normalizeGenerationSkills(previous), [stage]: doc };
  try { saveProject(); return true; }
  catch (error) {
    ownerProject.generationSkills = previous;
    ownerProject.updatedAt = previousUpdatedAt;
    showToast(`保存 Skill 失败，已保留原设置：${cleanRemoteError(error, '本地存储不可用')}`);
    return false;
  }
}

async function importGenerationSkill(stage) {
  if (!['storyboard', 'assets'].includes(stage)) return;
  if (project.running) return showToast('生成进行中，完成后可替换 Skill');
  if (!window.storyforgeAI?.importSkillDocument) return showToast('请使用支持 Skill 上传的桌面版');
  const ownerProject = project;
  const operation = { ownerProject, stage, sequence: ++generationSkillImportSequence };
  generationSkillImport = operation;
  renderWithoutMovingPage();
  try {
    const imported = await window.storyforgeAI.importSkillDocument({ stage });
    if (generationSkillImport !== operation || ownerProject !== project || ownerProject.running) return;
    if (!imported) return;
    const doc = normalizeGenerationSkillDocument(imported);
    if (!doc) throw new Error('Skill 文件没有可用正文');
    if (saveGenerationSkill(stage, doc, ownerProject)) showToast(`${stage === 'storyboard' ? '分镜' : '资产'} Skill 已启用，下次生成生效`);
  } catch (error) {
    if (generationSkillImport === operation && ownerProject === project && !ownerProject.running) showToast(cleanRemoteError(error, '读取 Skill 失败，原设置已保留'));
  } finally {
    if (generationSkillImport === operation) {
      generationSkillImport = null;
      if (ownerProject === project) renderWithoutMovingPage();
    }
  }
}

function previewGenerationSkill(stage) {
  if (project.running) return;
  const doc = normalizeGenerationSkillDocument(project.generationSkills?.[stage]);
  if (!doc) return;
  generationSkillPreview = { ownerProject: project, stage, doc };
  renderWithoutMovingPage();
}

function removeGenerationSkill(stage) {
  if (project.running || !['storyboard', 'assets'].includes(stage)) return;
  generationSkillImportSequence += 1;
  generationSkillImport = null;
  generationSkillPreview = null;
  const saved = saveGenerationSkill(stage, null);
  renderWithoutMovingPage();
  if (saved) showToast(`${stage === 'storyboard' ? '分镜' : '资产'} Skill 已移除，下次生成生效`);
}

function hasStageResult(stepId = project.activeStep) {
  if (!steps.some(step => step.id === stepId)) return false;
  if (project.completed.includes(stepId)) return true;
  if (stepId === 'assets') return Boolean(project.assetGeneration?.items?.some(item => item.files?.length || item.localPath || item.error || item.status === 'failed')
    || project.assetGeneration?.outputDirectory || project.assetGeneration?.lastError);
  if (stepId === 'video') return Boolean(project.outputs.video || project.videoGeneration?.items?.length || project.videoGeneration?.lastError);
  return Boolean(project.outputs[stepId]);
}

function clearResultDialogTemplate() {
  const request = clearResultRequest;
  if (!request || request.ownerProject !== project || request.stepId !== project.activeStep) return '';
  const step = steps.find(item => item.id === request.stepId);
  const descriptions = {
    analysis: '将清空本步骤的故事分析，保留分镜、参考图和视频。',
    storyboard: '将清空本步骤的分镜正文和审计记录，保留故事分析、参考图和已生成的视频。重新生成视频前需要先准备分镜。',
    assets: '将清空本步骤的图片关联和生成状态，保留素材名称与生图提示词，方便重新生成或上传图片。已生成的视频会保留。',
    video: '将清空本步骤的视频关联和生成状态，保留故事分析、分镜和参考图。',
  };
  return `<div class="modal-backdrop" id="clearResultModal"><div class="settings-modal clear-result-modal" role="alertdialog" aria-modal="true" aria-labelledby="clearResultTitle" aria-describedby="clearResultDescription"><div class="modal-head"><div><span class="section-kicker">CLEAR CURRENT STEP</span><h2 id="clearResultTitle">清空“${step.no} ${step.label}”的结果？</h2></div><button id="closeClearResult" aria-label="取消清空">×</button></div><p id="clearResultDescription">${descriptions[request.stepId]}</p><p>原文、Skill 和模型设置会保留。其他步骤的结果不会清空，磁盘中的图片和视频也不会删除。</p><p class="clear-result-warning">此操作无法撤销。需要留档时，请先导出项目备份。</p><div class="modal-actions"><button class="outline-button" id="exportBeforeClear">导出项目备份</button><button class="outline-button" id="cancelClearResult">取消</button><button class="primary-button clear-result-confirm" id="confirmClearResult">确认清空当前步骤</button></div></div></div>`;
}

function stageResultFingerprint(stepId) {
  return JSON.stringify({ output: project.outputs[stepId], completed: project.completed.includes(stepId),
    state: stepId === 'assets' ? project.assetGeneration : stepId === 'video' ? project.videoGeneration : null });
}

function requestClearCurrentResult() {
  if (project.running) { showToast('当前正在生成，请先停止任务，再清空当前步骤；已有成果会保留。'); return false; }
  if (!hasStageResult()) { showToast('当前步骤还没有可清空的结果。'); return false; }
  clearResultRequest = { ownerProject: project, stepId: project.activeStep, runToken: generationRun,
    output: project.outputs[project.activeStep],
    state: project.activeStep === 'assets' ? project.assetGeneration : project.activeStep === 'video' ? project.videoGeneration : null };
  renderWithoutMovingPage();
  clearResultRequest.fingerprint = stageResultFingerprint(clearResultRequest.stepId);
  document.querySelector('#cancelClearResult')?.focus();
  return true;
}

function closeClearResultDialog() {
  clearResultRequest = null;
  renderWithoutMovingPage();
  document.querySelector('#clearOutput')?.focus();
}

function confirmClearCurrentResult() {
  const request = clearResultRequest;
  clearResultRequest = null;
  if (!request) return false;
  const state = request.stepId === 'assets' ? project.assetGeneration : request.stepId === 'video' ? project.videoGeneration : null;
  if (request.ownerProject !== project || request.stepId !== project.activeStep || request.runToken !== generationRun
    || request.output !== project.outputs[request.stepId] || request.state !== state || project.running
    || request.fingerprint !== stageResultFingerprint(request.stepId)) {
    renderWithoutMovingPage(); showToast('项目、步骤或任务状态已变化，本次未清空任何结果。'); return false;
  }
  const previous = { outputs: project.outputs, completed: project.completed, assetGeneration: project.assetGeneration,
    videoGeneration: project.videoGeneration, updatedAt: project.updatedAt };
  const nextOutputs = { ...project.outputs };
  // Asset prompts are upstream requirements. Clear generated images without
  // forcing the user to regenerate the analysis and storyboard to obtain them.
  if (request.stepId !== 'assets') delete nextOutputs[request.stepId];
  project.outputs = nextOutputs;
  project.completed = project.completed.filter(id => id !== request.stepId);
  if (request.stepId === 'assets') project.assetGeneration = createAssetGenerationState(project.outputs.assets?.promptItems || []);
  if (request.stepId === 'video') project.videoGeneration = { ...defaultProject.videoGeneration, items: [] };
  try { saveProject(); }
  catch (error) {
    Object.assign(project, previous);
    renderWithoutMovingPage(); showToast(`清空未能保存，原结果已保留：${cleanRemoteError(error, '本地存储不可用')}`); return false;
  }
  // Ignore local uploads or other delayed callbacks started before the clear.
  generationRun += 1;
  renderWithoutMovingPage();
  document.querySelector('#clearOutput')?.focus();
  showToast(`已清空${steps.find(step => step.id === request.stepId).label}的结果，其他步骤和磁盘文件已保留。`);
  return true;
}

function appTemplate() {
  const progress = Math.round((project.completed.length / steps.length) * 100);
  const imageStatus = activeImageStatus();
  const imageConfigured = Boolean(imageStatus.configured);
  const imageName = imageProviderLabel();
  const imageDetail = imageProvider === 'openai'
    ? `${imageSizeLabel()} · ${imageQualityLabel(imageStatus.quality)}`
    : `${imageStatus.size} 生图`;
  const videoModelName = seedanceModelLabel();
  const generateLabel = project.running
    ? (workflowRun?.ownerProject === project ? '生成 / 审计与自动修正中…' : runningGenerationStep() === 'assets' ? '正在生成参考图…' : '正在生成视频…')
    : project.autoRunToVideo === true ? '一键生成到视频' : project.activeStep === 'video'
      ? (project.outputs.video ? '重新生成视频' : '开始生成视频')
      : project.activeStep === 'assets' ? '生成缺少的参考图' : (project.completed.length ? '重新生成分析与分镜' : '开始生成分镜');
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">✦</span><span>story<span class="brand-accent">forge</span></span></div>
        <button class="new-project" id="newProject"><span>＋</span> 新建项目 <kbd>Ctrl N</kbd></button>
        <div class="side-label">我的项目 <span>${projectLibrary.projects.length}</span></div>
        <div class="project-list">
          ${projectListTemplate()}
        </div>
        <nav class="sidebar-workflow" aria-label="制作流程">
          <div class="sidebar-workflow-head"><span>制作流程</span><b>${progress}%</b></div>
          <div class="sidebar-progress"><i style="width:${Math.max(4, progress)}%"></i></div>
          <div class="steps">${steps.map(stepTemplate).join('')}</div>
        </nav>
        <section class="sidebar-editor" aria-label="剧本入口">
          <div class="sidebar-editor-head"><div><span class="section-kicker">INPUT</span><h2>剧本入口</h2></div><span class="format-label">TXT · MD</span></div>
          <div class="script-input-wrap ${project.script ? 'has-content' : ''}"><textarea id="scriptInput" ${project.running ? 'disabled' : ''} placeholder="把小说改编后的剧本粘贴到这里...\n\n建议包含：集数、场景、人物和对白。${project.script ? '' : '\n\n还没有剧本？试试下方示例。'}">${esc(project.script)}</textarea><div class="textarea-footer"><span>${project.script.length ? `${project.script.length} 字` : '0 字'}</span><label class="upload-link" for="fileInput">↑ 导入文件</label><input type="file" id="fileInput" accept=".txt,.md" ${project.running ? 'disabled' : ''} hidden /></div></div>
          <div class="sidebar-input-actions"><button class="sample-link" id="useDemo" ${project.running ? 'disabled' : ''}>加载示例 <span>↗</span></button><button class="primary-button" id="startGenerate" ${project.running ? 'disabled' : ''}><span class="sparkle">✦</span> ${generateLabel} <span>→</span></button></div>
          <label class="auto-pipeline-switch"><input id="autoRunToVideo" type="checkbox" role="switch" ${project.autoRunToVideo === true ? 'checked' : ''} ${project.running ? 'disabled' : ''}><span><b>一键跑完全流程</b><small>从故事分析自动完成参考图，再批量生成全部视频</small></span></label>
          <p class="auto-flow-note">先分析故事并生成分镜，第三步用 GPT 订阅生图或上传参考图，第四步由 Seedance 生成视频</p>
        </section>
        <div class="sidebar-bottom">
          <button class="account" id="openSettings"><div class="avatar">${project.storyboardGeneration?.provider === 'codex-subscription' ? 'G' : '深'}</div><div><b>${esc(storyboardProviderLabel())}</b><small>${esc(storyboardConnectionText())}</small></div><span class="settings">⚙</span></button>
          <button class="account seedream-account" id="openCodexImageSettings"><div class="avatar seedream-avatar">图</div><div><b>GPT 订阅生图</b><small data-codex-image-status>${esc(codexImageStatusText())}</small></div><span class="settings">⚙</span></button>
          <button class="account seedance-account" id="openSeedanceSettings"><div class="avatar seedance-video-avatar">视</div><div><b>${esc(videoModelName)}</b><small>${currentVideoSettings().configured ? `${esc(currentVideoSettings().ratio)} · ${esc(currentVideoSettings().resolution)} · ${currentVideoSettings().generationMode === 'confirm' ? '逐镜确认' : '批量连续'}` : (activeVideoProvider() === 'comfy' ? '需要配置 ComfyUI 地址' : '需要配置火山方舟 API Key')}</small></div><span class="settings">⚙</span></button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar"><div class="breadcrumbs"><span>工作台</span><i>/</i><b>${esc(project.title)}</b></div><div class="top-actions"><span class="saved"><span class="saved-dot"></span> 已自动保存</span><button class="icon-button" title="字体缩放：Ctrl + / Ctrl - / Ctrl 0">A</button><button class="transfer-button" id="importProject">导入项目</button><button class="export-button" id="exportProject">导出项目 <span>↓</span></button><input type="file" id="projectFileInput" accept=".json,application/json" hidden /></div></header>
        <section class="hero"><div><div class="eyebrow">AI STORYTELLING STUDIO</div><h1>让想象，成为可见的世界。</h1><p>从文字出发，让角色走进画面，让故事拥有声音与生命。</p></div><div class="hero-meta"><button class="status-pill model-status ${isStoryboardProviderReady() ? 'connected' : 'disconnected'}" id="heroModelStatus"><i></i> ${esc(storyboardConnectionText())}</button><button class="status-pill model-status ${isCodexImageReady() ? 'connected' : 'disconnected'}" id="heroCodexImageStatus"><i></i> <span data-codex-image-status>${esc(codexImageStatusText())}</span></button><button class="status-pill model-status ${currentVideoSettings().configured ? 'connected' : 'disconnected'}" id="heroSeedanceStatus"><i></i> ${currentVideoSettings().checking ? '正在检查视频模型' : currentVideoSettings().configured ? `${esc(videoModelName)} 已配置` : '配置视频服务'}</button><span class="updated">${project.updatedAt ? '本机已保存' : '等待输入'}</span></div></section>
        <section class="output-card card"><div class="card-head output-head"><div><span class="section-kicker">OUTPUT</span><h2>生成结果</h2></div><div class="output-tools"><button class="small-button" id="clearOutput">清空当前步骤</button><button class="small-button" id="copyOutput">复制当前结果</button></div></div>${storyboardGenerationTemplate()}${generationSkillTemplate()}<div id="outputArea">${outputTemplate()}</div></section>
        <section class="workflow-progress-panel${project.activeStep === 'video' ? ' video-progress-panel' : ''}" id="workflowProgressPanel" aria-label="${project.activeStep === 'video' ? '视频分镜进度' : '分镜执行进度'}">${generationProgressTemplate()}</section>
      </main>
      <div class="modal-backdrop" id="settingsModal" hidden><div class="settings-modal"><div class="modal-head"><div><span class="section-kicker">MODEL SETTINGS</span><h2>DeepSeek 模型设置</h2></div><button id="closeSettings">×</button></div><div class="model-lock"><span>固定模型</span><b>DeepSeek V4.1 Flash</b><small>选择 DeepSeek 方式时，用于故事分析、分镜和视觉素材提示词；也可在结果区上方切换 GPT 订阅。</small></div><label class="key-field"><span>DeepSeek API Key</span><input id="deepseekKey" type="password" placeholder="sk-..." autocomplete="off"><small>密钥使用 Windows 本机加密保存，不会写入项目或安装包。</small></label><div class="modal-message" id="modelMessage"></div><div class="modal-actions"><button class="outline-button" id="testDeepSeek">测试连接</button><button class="primary-button" id="saveDeepSeek">保存设置</button></div><a class="key-help" href="https://platform.deepseek.com/api_keys" target="_blank">前往 DeepSeek 平台创建 API Key ↗</a></div></div>
      <div class="modal-backdrop" id="imageSettingsModal" hidden><div class="settings-modal image-settings-modal"><div class="modal-head"><div><span class="section-kicker">IMAGE MODEL SETTINGS</span><h2>第三步生图设置</h2></div><button id="closeImageSettings">×</button></div><div class="image-provider-switch" role="tablist" aria-label="生图渠道"><button class="${imageProviderDraft === 'seedream' ? 'active' : ''}" data-image-provider="seedream" role="tab" aria-selected="${imageProviderDraft === 'seedream'}">Seedream 5.0</button><button class="${imageProviderDraft === 'openai' ? 'active' : ''}" data-image-provider="openai" role="tab" aria-selected="${imageProviderDraft === 'openai'}">GPT Image 2</button></div><div class="provider-panel" data-provider-panel="seedream" ${imageProviderDraft === 'seedream' ? '' : 'hidden'}><div class="model-lock seedream-lock"><span>火山方舟生图</span><b>Seedream 5.0</b><small>逐张生成角色、场景和道具参考图，并保存到“文档/StoryForge/项目名/项目编号/视觉素材”。</small></div><label class="key-field"><span>火山方舟 API Key</span><input id="seedreamKey" type="password" placeholder="输入 ARK_API_KEY" autocomplete="off"><small>${seedreamStatus.configured ? '密钥已加密保存；留空可只修改模型和尺寸。' : '密钥使用 Windows 本机加密保存，不会写入项目或安装包。'}</small></label><label class="key-field"><span>图片模型</span><select id="seedreamModel">${SEEDREAM_MODELS.map((item) => `<option value="${item.id}" ${item.id === seedreamStatus.model ? 'selected' : ''}>${item.label}${item.pricePerImage ? ` · ¥${item.pricePerImage.toFixed(2)}/张` : ' · 需账号单独开通'}</option>`).join('')}</select><small>正式版和 Lite 都需要在火山方舟单独开通。</small></label><label class="key-field"><span>输出尺寸</span><select id="seedreamSize"><option value="2K" ${seedreamStatus.size === '2K' ? 'selected' : ''}>2K（推荐）</option><option value="4K" ${seedreamStatus.size === '4K' ? 'selected' : ''}>4K</option></select></label><div class="key-links"><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">开通 Seedream 模型服务 ↗</a><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?projectName=default" target="_blank">管理 API Key ↗</a></div></div><div class="provider-panel" data-provider-panel="openai" ${imageProviderDraft === 'openai' ? '' : 'hidden'}><div class="model-lock openai-image-lock"><span>OpenAI 生图</span><b>GPT Image 2</b><small>按参考图提示词生成 PNG 图片。复杂提示词最多可能需要约两分钟。</small></div><label class="key-field"><span>OpenAI API Key</span><input id="openAIImageKey" type="password" placeholder="sk-..." autocomplete="off"><small>${openAIImageStatus.configured ? '密钥已加密保存；留空可只修改尺寸和质量。' : '密钥使用 Windows 本机加密保存，不会写入项目或安装包。'}</small></label><label class="key-field"><span>输出尺寸</span><select id="openAIImageSize">${OPENAI_IMAGE_SIZES.map((item) => `<option value="${item.id}" ${item.id === openAIImageStatus.size ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label><label class="key-field"><span>图片质量</span><select id="openAIImageQuality">${OPENAI_IMAGE_QUALITIES.map((item) => `<option value="${item.id}" ${item.id === openAIImageStatus.quality ? 'selected' : ''}>${item.label}</option>`).join('')}</select><small>高质量耗时和费用更高；费用以 OpenAI 控制台为准。</small></label><div class="key-links"><a class="key-help" href="https://platform.openai.com/api-keys" target="_blank">创建 OpenAI API Key ↗</a><a class="key-help" href="https://platform.openai.com/settings/organization/general" target="_blank">组织与验证设置 ↗</a></div></div><div class="modal-message" id="imageMessage"></div><div class="modal-actions"><button class="outline-button" id="testImageProvider">测试连接（不生图）</button><button class="primary-button" id="saveImageProvider">保存并使用</button></div></div></div>
      <div class="modal-backdrop" id="seedanceSettingsModal" hidden><div class="settings-modal seedance-settings-modal"><div class="modal-head"><div><span class="section-kicker">VIDEO MODEL SETTINGS</span><h2>第四步视频设置</h2></div><button id="closeSeedanceSettings">×</button></div><label class="key-field"><span>视频生成服务</span><select id="seedanceVideoProvider"><option value="seedance">火山方舟 · Seedance 2.0</option><option value="comfy">仙宫云 GPU · H3 Ref2VA</option></select></label><div class="model-lock seedance-video-lock"><span>火山方舟视频生成</span><b>Seedance 2.0</b><small>每个镜头使用第二步分镜中的时长，生成 4 至 15 秒视频；按 @人物名、@场景名、@道具名自动匹配第三步同名图片。</small></div><label class="key-field"><span>火山方舟 API Key</span><input id="seedanceKey" type="password" placeholder="输入 ARK_API_KEY" autocomplete="off"><small>${seedanceStatus.configured ? (seedanceStatus.inheritedKey ? '当前复用 Seedream 的火山方舟密钥；留空即可继续使用。' : '密钥已加密保存；留空可只修改视频参数。') : '可复用 Seedream 的同一个火山方舟 API Key。'}</small></label><div class="seedance-setting-grid"><label class="key-field"><span>视频模型</span><select id="seedanceModel">${SEEDANCE_MODELS.map((item) => `<option value="${item.id}" ${item.id === seedanceStatus.model ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label><label class="key-field"><span>画面比例</span><select id="seedanceRatio">${SEEDANCE_RATIOS.map((item) => `<option value="${item}" ${item === seedanceStatus.ratio ? 'selected' : ''}>${item}${item === '9:16' ? '（竖屏推荐）' : ''}</option>`).join('')}</select></label><label class="key-field"><span>分辨率</span><select id="seedanceResolution">${SEEDANCE_RESOLUTIONS.map((item) => `<option value="${item}" ${item === seedanceStatus.resolution ? 'selected' : ''}>${item}</option>`).join('')}</select></label><label class="key-field"><span>缺省时长</span><select id="seedanceDuration">${SEEDANCE_DURATIONS.map((item) => `<option value="${item}" ${item === seedanceStatus.duration ? 'selected' : ''}>${item} 秒</option>`).join('')}</select><small>仅在分镜没有有效时长时使用。</small></label></div><div class="video-generation-mode-field"><span>生成方式</span><div class="video-generation-mode" role="tablist" aria-label="视频生成方式"><button class="${seedanceStatus.generationMode === 'confirm' ? '' : 'active'}" data-seedance-generation-mode="batch" role="tab" aria-selected="${seedanceStatus.generationMode !== 'confirm'}"><b>批量连续</b><small>一次确认，按顺序生成全部镜头</small></button><button class="${seedanceStatus.generationMode === 'confirm' ? 'active' : ''}" data-seedance-generation-mode="confirm" role="tab" aria-selected="${seedanceStatus.generationMode === 'confirm'}"><b>逐镜确认</b><small>每个镜头完成后暂停，确认后再生成下一个</small></button></div></div><label class="toggle-field"><input id="seedanceGenerateAudio" type="checkbox" ${seedanceStatus.generateAudio ? 'checked' : ''}><span><b>生成同步音频</b><small>让 Seedance 同时生成对白、人声、环境音和配乐。</small></span></label><div class="key-links"><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">开通 Seedance 模型服务 ↗</a><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?projectName=default" target="_blank">管理 API Key ↗</a></div><div class="modal-message" id="seedanceMessage"></div><div class="modal-actions"><button class="outline-button" id="testSeedance">测试连接（不生视频）</button><button class="primary-button" id="saveSeedance">保存设置</button></div></div></div>
      <div class="modal-backdrop" id="customAssetModal" hidden><div class="settings-modal custom-asset-modal"><div class="modal-head"><div><span class="section-kicker">CUSTOM REFERENCE</span><h2>${Number.isInteger(customAssetTargetShotIndex) ? `为镜头 ${String(customAssetTargetShotIndex + 1).padStart(2, '0')} 添加参考图` : '添加遗漏资源'}</h2></div><button id="closeCustomAsset">×</button></div><div class="model-lock local-custom-lock"><span>${Number.isInteger(customAssetTargetShotIndex) ? '第四步镜头素材' : '第三步本地素材'}</span><b>创建自定义上传项</b><small>${Number.isInteger(customAssetTargetShotIndex) ? '填写名称并选择图片后，会以 @素材名称添加到当前镜头并自动绑定。' : '适合补充主持人、医生、秘书、额外场景或遗漏道具。创建后立即选择本地参考图片。'}</small></div><label class="key-field"><span>资源名称</span><input id="customAssetName" type="text" placeholder="例如：主持人" autocomplete="off"></label><label class="key-field"><span>资源类型</span><select id="customAssetType"><option value="人物参考图">人物</option><option value="场景参考图">场景</option><option value="群像参考图">群像</option><option value="道具参考图">道具</option><option value="其他参考图">其他</option></select></label><div class="modal-message" id="customAssetMessage"></div><div class="modal-actions"><button class="outline-button" id="cancelCustomAsset">取消</button><button class="primary-button" id="createCustomAsset">创建并上传图片</button></div></div></div>
      ${comfyVideoSettingsTemplate(comfyVideoStatus)}${portraitCertificationModalTemplate()}
      ${codexImageSettingsTemplate()}${codexTextSettingsTemplate()}
      ${generationSkillPreviewTemplate()}
      ${clearResultDialogTemplate()}
      <div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>`;
}

function stepTemplate(step) {
  const idx = steps.findIndex((item) => item.id === step.id);
  const done = project.completed.includes(step.id);
  const active = project.activeStep === step.id;
  const running = runningGenerationStep() === step.id;
  return `<button class="step ${active ? 'active' : ''} ${done ? 'done' : ''} ${running ? 'running' : ''}" data-step="${step.id}"><span class="step-icon">${done ? '✓' : step.icon}</span><span class="step-copy"><b>${step.no}　${step.label}</b><small>${step.sub}</small></span>${running ? '<span class="loader"></span>' : done ? '<span class="done-mark">完成</span>' : '<span class="step-arrow">›</span>'}</button>`;
}

function runningGenerationStep(ownerProject = project) {
  if (!ownerProject.running) return null;
  if (codexImageRun?.ownerProject === ownerProject) return 'assets';
  if (workflowRun?.ownerProject === ownerProject) return 'analysis';
  if (autoPipelineRun?.ownerProject === ownerProject) return ({ checking: 'analysis', storyboard: 'analysis', assets: 'assets', video: 'video' })[ownerProject.autoPipeline?.phase] || null;
  if (ownerProject.videoGeneration?.status === 'running') return 'video';
  return null;
}

function selectWorkflowStep(stepId) {
  if (!steps.some(step => step.id === stepId)) return false;
  clearResultRequest = null;
  viewNavigationSequence += 1;
  project.activeStep = stepId;
  saveProject(); render();
  return true;
}

function focusGenerationStep(stepId, run) {
  if (run?.ownerProject === project && (run.viewSequence === undefined || run.viewSequence === viewNavigationSequence)) project.activeStep = stepId;
}

function runningTaskNoticeTemplate() {
  const stage = runningGenerationStep();
  if (!stage || autoPipelineRun?.ownerProject === project) return '';
  const label = stage === 'assets' ? '参考图生成' : stage === 'video' ? '视频生成' : '故事分析与分镜生成';
  return `<section class="running-task-notice" role="status"><div><b>${label}正在后台进行</b><span>可以查看、复制其他步骤的结果；生成任务会继续。</span></div><div>${project.activeStep !== stage ? '<button class="outline-button" id="returnToRunningStage">返回生成页面</button>' : ''}<button class="outline-button" id="stopRunningTask">停止当前任务</button></div></section>`;
}

function assetGenerationTemplate(output) {
  const prompts = Array.isArray(output?.promptItems) ? output.promptItems : [];
  const state = alignAssetGenerationItems(prompts);
  const items = Array.isArray(state.items) ? state.items : [];
  const completed = items.filter((item) => Array.isArray(item.files) && item.files.length).length;
  const missing = Math.max(0, prompts.length - completed);
  const progress = prompts.length ? Math.round((completed / prompts.length) * 100) : 0;
  const activeRun = codexImageRun?.ownerProject === project ? codexImageRun : null;
  const statusText = activeRun
    ? (activeRun.activeIndex === null ? '正在检查 GPT 订阅生图环境…' : `正在生成第 ${activeRun.activeIndex + 1} 项 · 已准备 ${completed} / ${prompts.length} 项`)
    : missing ? `已准备 ${completed} / ${prompts.length} 项，还缺 ${missing} 项` : `全部 ${completed} 项参考图已准备完成`;
  const generatableMissing = prompts.filter((prompt, index) => !items[index]?.files?.length && String(prompt.prompt || '').trim()).length;
  const cards = prompts.map((prompt, index) => {
    const result = items[index] || { status: 'pending', files: [] };
    const files = Array.isArray(result.files) ? result.files : [];
    const trustedCount = files.filter((file) => file.trustedAssetId).length;
    const statusLabel = result.status === 'generating' ? 'GPT 正在生图…' : result.error ? `生图失败${files.length ? ` · 已有 ${files.length} 张` : ''}` : files.length ? `已准备 ${files.length} 张${trustedCount ? ` · 已认证 ${trustedCount} 张` : ''}` : '等待参考图';
    const previews = files.length
      ? `<div class="local-asset-previews">${files.map((file, fileIndex) => `<div class="local-asset-thumb ${file.trustedAssetId ? 'trusted' : ''}"><button data-show-local-asset-index="${index}" data-show-local-file-index="${fileIndex}" title="在文件夹中查看"><img src="${esc(String(file.imageUrl || ''))}" alt="${esc(String(prompt.name || '参考图'))}">${file.trustedAssetId ? '<i>已认证</i>' : ''}</button><span>${file.provider === 'codex-subscription' ? 'GPT · ' : ''}${esc(String(file.sourceName || file.fileName || `图片${fileIndex + 1}`))}</span></div>`).join('')}</div>`
      : `<div class="asset-image-placeholder ${result.status === 'generating' ? 'generating' : result.error ? 'failed' : 'pending'}"><span>${result.status === 'generating' ? '✦' : '＋'}</span><small>${result.status === 'generating' ? 'GPT 正在生成，请稍候' : `生成或上传${esc(String(prompt.name || '参考图'))}`}</small></div>`;
    return `<article class="generated-asset-card local-upload-card"><div>${previews}</div><div class="generated-asset-copy"><div><span>${esc(String(prompt.type || '参考图'))}${prompt.customAsset ? ' · 自定义' : ''}</span><h4>${esc(String(prompt.name || `参考图${index + 1}`))}</h4><code>${esc(String(prompt.fileName || ''))}</code></div><b class="asset-result-status ${result.status === 'generating' ? 'generating' : result.error ? 'failed' : files.length ? 'success' : 'pending'}">${esc(statusLabel)}</b><p class="local-upload-help">每次 GPT 生图追加一张，保留已有参考图；同一项最多 9 张。${String(prompt.prompt || '').trim() ? '' : '此自定义项没有生图提示词，请上传图片。'}</p>${result.error ? `<p class="codex-image-item-error">${esc(cleanRemoteError(result.error, 'GPT 生图失败'))}</p>` : ''}<div class="local-upload-actions"><button class="primary-button generate-codex-asset" data-generate-codex-asset-index="${index}" ${project.running || files.length >= 9 || !String(prompt.prompt || '').trim() ? 'disabled' : ''}>${result.status === 'generating' ? 'GPT 正在生图…' : result.error ? '重试 GPT 订阅生图' : 'GPT 订阅生图'}</button><button class="outline-button upload-local-asset" data-upload-local-asset-index="${index}" ${project.running || files.length >= 9 ? 'disabled' : ''}>${files.length ? '追加参考图' : '上传参考图'}</button>${files.length ? `<button class="outline-button clear-local-asset" data-clear-local-asset-index="${index}" ${project.running ? 'disabled' : ''}>清空本项</button>` : ''}${prompt.customAsset ? `<button class="outline-button remove-custom-asset" data-remove-custom-asset-index="${index}" ${project.running ? 'disabled' : ''}>删除此项</button>` : ''}</div></div></article>`;
  }).join('');
  const customCard = `<button class="generated-asset-card add-custom-asset-card" id="addCustomAsset" ${project.running ? 'disabled' : ''}><span>＋</span><b>添加遗漏资源</b><small>自定义人物、场景、群像或道具，并上传对应参考图</small></button>`;
  return `<section class="seedream-generator local-assets-uploader codex-assets-generator"><div class="seedream-generator-head"><div><span class="section-kicker">GPT SUBSCRIPTION & LOCAL IMAGES</span><h4>第三步 · 生成或上传参考图</h4><p>GPT Image 2 通过本机 Codex 的 ChatGPT 登录使用订阅限额，无需 API Key；也可上传本地图片。</p></div><div class="seedream-actions"><button class="outline-button" id="configureCodexImages">GPT 订阅设置 / 检查连接</button>${state.outputDirectory ? '<button class="outline-button" id="openAssetFolder">打开素材文件夹</button>' : ''}${activeRun ? '<button class="outline-button stop-codex-images" id="stopCodexImages">停止生图</button>' : `<button class="primary-button" id="generateMissingCodexAssets" ${project.running || !generatableMissing ? 'disabled' : ''}>生成缺少的参考图${generatableMissing ? `（${generatableMissing} 项）` : ''}</button>`}<button class="outline-button" id="confirmLocalAssets" ${project.running || !prompts.length || missing ? 'disabled' : ''}>进入第四步生成视频</button></div></div><div class="seedream-progress"><div><b>${esc(statusText)}</b><span>${progress}%</span></div><i><em style="width:${progress}%"></em></i><small>批量只生成缺图的素材项。图片按素材准确名称保存，全部齐备后自动标记第三步完成，可直接进入视频步骤。</small>${state.lastError ? `<p class="seedream-global-error">${esc(cleanRemoteError(state.lastError, 'GPT 生图失败'))}</p>` : ''}</div><div class="generated-assets-grid">${cards}${customCard}</div></section>`;
}

function effectiveVideoPrompt(index, originalPrompt, state = project.videoGeneration) {
  const override = state?.items?.[index]?.promptOverride;
  return typeof override === 'string' ? override : String(originalPrompt || '');
}

function videoPromptIsEdited(index, originalPrompt, state = project.videoGeneration) {
  return effectiveVideoPrompt(index, originalPrompt, state) !== String(originalPrompt || '');
}

function repairVideoReferenceSequence(index, prompt, item, state) {
  if (project.running || !item) return String(prompt || '');
  const shot = ensureStoryboardShot(project.outputs.storyboard, index, prompt, storyboardShotDuration(index, prompt, seedanceStatus.duration));
  if (!shot) return String(prompt || '');
  const normalized = migrateNamedReferencePlan({ prompt, shot, assetItems: project.assetGeneration?.items || [], savedBindings: item.referenceBindings || {} });
  if (!normalized.changed) return String(prompt || '');
  if (!Array.isArray(item.originalReferenceUploads)) item.originalReferenceUploads = structuredClone(shot.uploads || []);
  shot.uploads = normalized.uploads;
  item.referenceBindings = normalized.bindings;
  if (normalized.prompt !== String(prompt || '').trim()) item.promptOverride = normalized.prompt;
  item.referenceFormat = 'asset-name';
  saveProject();
  return normalized.prompt;
}

function videoReferenceBindingTemplate(index, prompt, item) {
  const shot = project.outputs.storyboard?.shots?.[index] || {};
  const assets = project.assetGeneration?.items || [];
  const plan = resolveStrictReferencePlan({ prompt, shot, assetItems: assets, savedBindings: item?.referenceBindings || {} });
  const rows = plan.bindings.map((binding) => {
    const selected = binding.selected;
    const displayName = binding.legacy
      ? selected?.assetName || binding.assetName || '尚未指定素材'
      : binding.assetName || selected?.assetName || '尚未指定素材';
    const options = binding.candidates.map((candidate) => {
      const value = `${candidate.assetItemIndex}:${candidate.fileIndex}`;
      const isSelected = selected && candidate.assetItemIndex === selected.assetItemIndex && candidate.fileIndex === selected.fileIndex;
      return `<option value="${value}" ${isSelected ? 'selected' : ''}>${esc(candidate.assetName)}｜${esc(candidate.sourceName)}${candidate.trustedAssetId ? '（已认证）' : ''}</option>`;
    }).join('');
    const removeButton = `<button class="remove-video-reference" data-remove-video-reference-shot="${index}" data-remove-video-reference-number="${binding.number}" ${project.running ? 'disabled' : ''}>删除引用</button>`;
    return `<div class="video-reference-row ${selected ? 'bound' : 'missing'}"><div class="video-reference-number"><code>${esc(binding.ref)}</code><span>请求中的图片${binding.number}</span>${removeButton}</div><div class="video-reference-identity"><b>${esc(displayName)}</b><small>${esc(binding.purpose)}</small></div><div class="video-reference-picker">${selected?.imageUrl ? `<img src="${esc(selected.imageUrl)}" alt="${esc(displayName)}">` : '<span class="video-reference-empty">缺图</span>'}<label><span>绑定到第三步图片</span><select data-video-reference-shot="${index}" data-video-reference-number="${binding.number}" ${binding.candidates.length && !project.running ? '' : 'disabled'}><option value="">${binding.candidates.length ? '点击选择人物、场景或道具图片' : '第三步还没有参考图'}</option>${options}</select></label></div></div>`;
  }).join('');
  const errors = plan.errors.length ? `<div class="video-reference-errors">${plan.errors.map((error) => `<p>${esc(error)}</p>`).join('')}</div>` : '';
  const help = '按 @人物名、@场景名、@道具名自动匹配第三步同名图片，无需编号；可在同一素材的多张图中选择。';
  const addDisabled = project.running || plan.bindings.length >= 9;
  const availableAssets = assets.map((asset, assetIndex) => ({ asset, assetIndex })).filter(({ asset }) => asset.files?.length && !plan.bindings.some(binding => binding.assetName === asset.name));
  const assetOptions = availableAssets.map(({ asset, assetIndex }) => `<option value="${assetIndex}">@${esc(asset.name)}</option>`).join('');
  return `<section class="video-reference-bindings"><div class="video-reference-head"><div><b>本镜头素材名称匹配</b><small>${esc(help)}</small></div><span class="${plan.valid ? 'ready' : 'blocked'}">${plan.valid ? `已核对 ${plan.bindings.length} 项` : '生成前需修正'}</span></div>${rows || '<div class="video-reference-empty-plan">当前镜头没有图片引用，将按纯文本生成。</div>'}${errors}<div class="video-reference-add-actions"><select data-new-reference-asset="${index}" aria-label="选择要引用的素材" ${addDisabled || !availableAssets.length ? 'disabled' : ''}>${assetOptions || '<option>没有未引用的现有素材</option>'}</select><button data-add-existing-video-reference="${index}" ${addDisabled || !availableAssets.length ? 'disabled' : ''}>＋ 引用所选素材</button><button data-upload-video-reference="${index}" ${addDisabled ? 'disabled' : ''}>＋ 上传并添加新图</button><small>${plan.bindings.length} / 9 张；新增后会自动写入当前镜头提示词</small></div></section>`;
}

function videoVersionControlsTemplate(index, item, { allowGenerate = true, needsCertification = false } = {}) {
  const normalized = normalizeVideoItemVersions(item);
  const selected = getSelectedVideoVersion(normalized);
  const versions = normalized.versions;
  const buttons = versions.map(version => `<button type="button" class="video-version-button${version.id === selected?.id ? ' selected' : ''}" data-select-video-version-index="${index}" data-video-version-id="${esc(version.id)}" aria-pressed="${version.id === selected?.id ? 'true' : 'false'}" title="切换到第 ${version.number} 版${version.generatedAt ? ` · ${esc(String(version.generatedAt))}` : ''}">第 ${version.number} 版</button>`).join('');
  return `<div class="video-clip-toolbar"><div class="video-version-heading"><b>镜头 ${String(index + 1).padStart(2, '0')}</b><span>共 ${versions.length} 版</span>${selected ? `<small>当前：第 ${selected.number} 版${selected.duration ? ` · ${esc(String(selected.duration))} 秒` : ''}</small>` : '<small>尚未生成视频</small>'}</div><div class="video-clip-actions"><button class="outline-button generate-one-video" data-generate-video-index="${index}" ${project.running || !allowGenerate ? 'disabled' : ''} ${!allowGenerate ? 'title="请先准备分镜后再生成"' : ''}>${selected ? '重新生成此镜头' : item.status === 'failed' ? '重试此镜头' : '生成此镜头'}</button>${needsCertification ? `<button class="outline-button" data-open-portrait-certification="${index}" ${project.running ? 'disabled' : ''}>完成认证并继续</button>` : ''}</div>${buttons ? `<div class="video-version-switch" role="group" aria-label="镜头 ${index + 1} 的历史版本">${buttons}</div>` : ''}</div>`;
}

function videoPreviewTemplate(index, item, label = '待生成') {
  const selected = getSelectedVideoVersion(item);
  if (selected?.videoFileUrl) return `<div class="video-clip-preview"><video src="${esc(String(selected.videoFileUrl))}" controls preload="metadata"></video><button data-show-video-index="${index}">在文件夹中查看</button></div>`;
  return `<div class="video-clip-placeholder ${esc(String(item.status || 'pending'))}"><span>${['creating', 'queued', 'running', 'downloading'].includes(item.status) && project.running ? '▶' : ['failed', 'certification'].includes(item.status) ? '!' : String(index + 1).padStart(2, '0')}</span><b>${esc(selected ? '已保留本地视频' : label)}</b>${selected?.localPath ? `<button class="outline-button" data-show-video-index="${index}">在文件夹中查看</button>` : item.taskId ? `<small>${esc(String(item.taskId))}</small>` : ''}</div>`;
}

function savedVideoResultsTemplate(state) {
  const cards = state.items.map((item, index) => {
    const selected = getSelectedVideoVersion(item);
    return `<article class="video-clip-card" id="video-shot-${index + 1}" data-video-shot-index="${index}">${videoVersionControlsTemplate(index, item, { allowGenerate: false })}${videoPreviewTemplate(index, item, '已保留视频记录')}<div class="video-clip-copy"><h4>${esc(String(selected?.fileName || item.fileName || `镜头-${index + 1}`))}</h4>${!selected ? '<p>此镜头尚未保存本地视频。</p>' : ''}</div></article>`;
  }).join('');
  return `<section class="seedance-generator"><div class="seedance-generator-head"><div><span class="section-kicker">SAVED VIDEOS</span><h4>保留的视频结果</h4><p>分镜结果已清空，已有视频和任务记录仍保留。重新生成视频前，请先准备分镜。</p></div>${state.outputDirectory ? '<div class="seedance-actions"><button class="outline-button" id="openVideoFolder">打开视频文件夹</button></div>' : ''}</div><div class="video-clips-grid">${cards}</div></section>`;
}

function videoGenerationTemplate() {
  const prompts = project.outputs.storyboard?.prompts || [];
  const state = project.videoGeneration || defaultProject.videoGeneration;
  const items = Array.isArray(state.items) ? state.items : [];
  if (!prompts.length && items.length) return savedVideoResultsTemplate(state);
  reconcilePortraitCertification(state);
  const generationMode = effectiveVideoGenerationMode(state);
  const confirmMode = generationMode === 'confirm';
  const durationText = videoDurationSummary(prompts, items, state.duration || seedanceStatus.duration);
  const completed = items.filter((item) => getSelectedVideoVersion(item)).length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const active = items.filter((item) => ['creating', 'queued', 'running', 'downloading'].includes(item.status)).length;
  const certificationPending = Boolean(state.pendingCertification);
  const nextIndex = prompts.findIndex((_prompt, index) => items[index]?.status !== 'success');
  const nextItem = nextIndex >= 0 ? items[nextIndex] : null;
  const allComplete = prompts.length > 0 && nextIndex < 0;
  const progress = prompts.length ? Math.round((completed / prompts.length) * 100) : 0;
  const statusText = project.running && active
    ? `正在生成镜头 ${Math.max(0, items.findIndex(item => ['creating', 'queued', 'running', 'downloading'].includes(item.status))) + 1} / ${prompts.length}`
    : allComplete
      ? `已完成 ${completed} / ${prompts.length}`
      : certificationPending
        ? `镜头 ${String(Number(state.pendingCertification.shotIndex) + 1).padStart(2, '0')} 等待真人素材认证`
      : confirmMode && nextItem?.status === 'failed'
        ? `镜头 ${String(nextIndex + 1).padStart(2, '0')} 生成失败，等待重试`
        : confirmMode && completed
          ? `已保存 ${completed} 个镜头，等待确认下一个`
      : failed
        ? `已完成 ${completed} 个，失败 ${failed} 个`
        : completed ? `已保存 ${completed} / ${prompts.length}，可继续生成剩余镜头` : `等待生成 ${prompts.length} 个镜头`;
  const statusLabels = {
    pending: '待生成', creating: '提交中', queued: '排队中', running: '生成中', downloading: '下载中', success: '已保存', failed: '生成失败', certification: '等待真人认证',
  };
  const cards = prompts.map((prompt, index) => {
    const item = items[index] || { status: 'pending' };
    const editablePrompt = repairVideoReferenceSequence(index, effectiveVideoPrompt(index, prompt, state), item, state);
    const promptEdited = editablePrompt !== String(prompt || '');
    const needsCertification = state.pendingCertification?.shotIndex === index;
    const duration = videoItemDuration(index, prompt, item, state.duration);
    const label = statusLabels[item.status] || '待生成';
    const selected = getSelectedVideoVersion(item);
    return `<article class="video-clip-card" id="video-shot-${index + 1}" data-video-shot-index="${index}">${videoVersionControlsTemplate(index, item, { needsCertification })}${videoPreviewTemplate(index, item, label)}<div class="video-clip-copy"><div><span>镜头 ${String(index + 1).padStart(2, '0')} · 下次生成 ${duration} 秒</span><h4>${esc(String(selected?.fileName || item.fileName || `镜头-${String(index + 1).padStart(2, '0')}.mp4`))}</h4><div class="video-prompt-editor-head"><b>视频生成提示词</b><span class="${promptEdited ? 'edited' : ''}" data-video-prompt-status="${index}">${promptEdited ? '已修改 · 自动保存' : '原始提示词 · 自动保存'}</span><button class="reset-video-prompt" data-reset-video-prompt-index="${index}" ${project.running || !promptEdited ? 'disabled' : ''}>恢复原始提示词</button></div><textarea class="video-prompt-editor" data-video-prompt-index="${index}" aria-label="镜头 ${String(index + 1).padStart(2, '0')} 视频生成提示词" ${project.running ? 'disabled' : ''}>${esc(editablePrompt)}</textarea>${videoReferenceBindingTemplate(index, editablePrompt, item)}</div><b class="video-task-status ${esc(String(item.status || 'pending'))}">${esc(label)}</b>${item.error ? `<div class="video-task-error">${esc(cleanRemoteError(item.error, '生成失败'))}</div>` : ''}</div></article>`;
  }).join('');
  const nextButtonText = allComplete
    ? '全部视频已完成'
    : nextItem?.status === 'failed'
      ? `重试镜头 ${String(nextIndex + 1).padStart(2, '0')}`
      : `生成下一个镜头 ${String(nextIndex + 1).padStart(2, '0')}`;
  const batchButtonText = failed ? '批量重试失败镜头' : completed ? '批量继续生成' : '批量生成全部视频';
  const progressHelp = activeVideoProvider() === 'comfy'
    ? (comfyVideoStatus.configured ? '仙宫云实例需保持运行；停止提交后，已提交任务可继续查询。' : '请先在视频设置中配置仙宫云 ComfyUI 地址。')
    : !seedanceStatus.configured
    ? '尚未配置火山方舟 API Key，配置后即可调用 Seedance 2.0。'
    : certificationPending
      ? '完成方舟真人认证并填写 Asset ID 后，程序会自动重试当前镜头，并继续原来的批量任务。'
    : '可以“生成下一个镜头”，也可以“一键批量生成”；每张镜头卡仍可单独生成或重试。';
  return `<section class="seedance-generator"><div class="seedance-generator-head"><div><span class="section-kicker">AI VIDEO GENERATION</span><h4>第四步 · ${activeVideoProvider() === 'comfy' ? '仙宫云 H3' : 'Seedance'} 分镜视频</h4><p>${esc(seedanceModelLabel(state.model || seedanceStatus.model))} · ${esc(state.ratio || seedanceStatus.ratio)} · ${esc(state.resolution || seedanceStatus.resolution)} · 支持逐镜与批量 · 按分镜 ${esc(durationText)}${state.generateAudio === false ? ' · 无声' : ' · 同步音频'}</p></div><div class="seedance-actions"><button class="outline-button" id="configureSeedance">视频设置</button>${state.outputDirectory ? '<button class="outline-button" id="openVideoFolder">打开视频文件夹</button>' : ''}<button class="outline-button" id="generateNextVideo" ${project.running || !prompts.length || allComplete ? 'disabled' : ''}>${esc(nextButtonText)}</button><button class="primary-button" id="generateAllVideos" ${project.running || !prompts.length || allComplete ? 'disabled' : ''}>${esc(batchButtonText)}</button></div></div><div class="seedance-video-progress"><div><b>${esc(statusText)}</b><span>${progress}%</span></div><i><em style="width:${progress}%"></em></i><small>${esc(progressHelp)}</small>${state.lastError ? `<p class="seedream-global-error">${esc(cleanRemoteError(state.lastError, '生成失败'))}</p>` : ''}</div><div class="video-clips-grid">${cards}</div></section>`;
}

function storyboardShotDuration(index, prompt, fallback = seedanceStatus.duration) {
  const explicitDuration = project.outputs.storyboard?.durations?.[index];
  const resolve = storyboardUsesSkill21() ? resolveStoryboardDuration : resolveSeedanceDuration;
  return resolve(explicitDuration, prompt, fallback);
}

function storyboardUsesSkill21(storyboard = project.outputs.storyboard) {
  return String(storyboard?.skillVersion || '') === '2.1';
}

function storyboardUsesCustomSkill(storyboard = project.outputs.storyboard) {
  return storyboard?.auditSummary?.auditBasis === '用户 Skill';
}

function videoItemDuration(index, prompt, item, fallback = seedanceStatus.duration) {
  const duration = storyboardShotDuration(index, prompt, fallback);
  return storyboardUsesSkill21() ? duration : normalizeSeedanceDuration(item?.duration, duration);
}

function effectiveVideoGenerationMode(state = project.videoGeneration || defaultProject.videoGeneration) {
  const items = Array.isArray(state.items) ? state.items : [];
  const hasGenerationHistory = items.some((item) => item.status && item.status !== 'pending');
  return normalizeSeedanceGenerationMode(project.running || hasGenerationHistory ? state.generationMode : currentVideoSettings().generationMode);
}

function videoDurationSummary(prompts, items = [], fallback = seedanceStatus.duration) {
  const durations = prompts.map((prompt, index) => videoItemDuration(index, prompt, items[index], fallback));
  if (!durations.length) return `${normalizeSeedanceDuration(fallback)} 秒`;
  const minimum = Math.min(...durations);
  const maximum = Math.max(...durations);
  return minimum === maximum ? `${minimum} 秒` : `${minimum}-${maximum} 秒`;
}

function outputTemplate() {
  const errorNotice = project.workflowError ? `<div class="workflow-audit-error" role="alert"><b>本次分镜未交付</b><p>${esc(String(project.workflowError))}</p><small>上次已确认的成果仍然保留。</small></div>` : '';
  const ignoredNotice = project.activeStep !== 'storyboard' && project.outputs.storyboard?.auditSummary?.finalStatus === '审计未通过（已忽略）' ? storyboardIgnoredNotice() : '';
  return `${autoPipelineNoticeTemplate()}${runningTaskNoticeTemplate()}${errorNotice}${ignoredNotice}${outputContentTemplate()}`;
}

function autoPipelineNoticeTemplate() {
  const state = project.autoPipeline;
  if (!state) return '';
  const phases = { checking: '检查生成配置', storyboard: '故事分析与分镜', assets: '生成参考图', video: '批量生成视频' };
  const labels = { running: '全流程进行中', completed: '全流程已完成', failed: '全流程已暂停', stopped: '全流程已停止' };
  return `<section class="auto-pipeline-notice ${state.status}" role="status"><div><b>${labels[state.status] || '全流程状态'} · ${phases[state.phase] || ''}</b><span>${esc(state.error || (state.status === 'completed' ? '全部视频镜头已生成并保存。' : '自动衔接下一阶段，视频按批量连续生成；可自由查看其他步骤。'))}</span></div>${state.status === 'running' ? `<div class="running-task-actions">${runningGenerationStep() !== project.activeStep ? '<button class="outline-button" id="returnToRunningStage">返回生成页面</button>' : ''}<button class="outline-button" id="stopAutoPipeline">停止全流程</button></div>` : ''}</section>`;
}

function outputContentTemplate() {
  const output = project.outputs[project.activeStep] || (project.activeStep === 'video' && (project.videoGeneration?.items?.length || project.outputs.storyboard?.prompts?.length)
    ? { title: 'Seedance 分镜视频', subtitle: steps.filter(step => step.id !== 'video').every(step => project.completed.includes(step.id)) ? '本地参考图和分镜已经准备完成' : '逐镜生成、查看和切换视频版本', time: '按镜头生成', body: '' } : null);
  if (project.activeStep === 'assets' && output) alignAssetGenerationItems(output.promptItems || []);
  const runningStep = runningGenerationStep();
  const workflowPending = project.running && workflowRun?.ownerProject === project && ['analysis', 'storyboard'].includes(project.activeStep);
  const viewingRunningStage = runningStep === project.activeStep || workflowPending;
  if (viewingRunningStage && !output) return `<div class="generating"><div class="generating-orb">✦</div><h3>${workflowPending ? '生成 / 审计与自动修正中…' : `正在生成${steps[currentIndex()].label}…`}</h3><p>${workflowPending ? '审计未通过时最多自动回炉一次；回炉后仍未通过将保留警告并继续下一步。' : runningStep === 'assets' ? '正在生成并保存参考图' : '正在生成并下载视频镜头'}</p><div class="generating-track"><i></i></div><small>请保持程序开启</small></div>`;
  if (project.activeStep === 'video' && !output && steps.filter((step) => step.id !== 'video').every((step) => project.completed.includes(step.id))) return `<div class="video-ready"><div class="video-ready-icon">▶</div><span class="section-kicker">READY FOR SEEDANCE</span><h3>本地参考图和分镜已经准备完成</h3><p>Seedance 支持单独生成一个镜头或批量生成全部镜头，并将完成的视频保存到本机。</p><div class="video-ready-actions"><button class="outline-button" id="configureSeedance">视频设置</button><button class="next-button" id="generateVideo" ${project.running ? 'disabled' : ''}>进入视频生成 <span>→</span></button></div></div>`;
  if (!output && project.running) return '<div class="empty-output"><div class="empty-icon">✧</div><h3>此步骤暂时没有生成结果</h3><p>后台任务仍在进行，可以查看其他步骤或返回生成页面。</p></div>';
  if (!output) return `<div class="empty-output"><div class="empty-icon">✧</div><h3>准备好开始创作了吗？</h3><p>输入一段剧本，点击“开始生成”，你的短剧工作流会从这里展开。</p><button class="outline-button" id="emptyStart">使用示例开始 <span>→</span></button></div>`;
  const isAssets = project.activeStep === 'assets';
  const isVideo = project.activeStep === 'video';
  const stageComplete = project.completed.includes(project.activeStep);
  const partial = project.outputs.storyboard?.auditSummary?.finalStatus === '部分通过（存在阻塞）';
  const auditIgnored = project.outputs.storyboard?.auditSummary?.finalStatus === '审计未通过（已忽略）';
  const stageStatus = workflowPending ? '生成 / 审计与自动修正中' : viewingRunningStage ? '生成中' : partial && project.activeStep === 'storyboard' ? '部分通过 · 存在阻塞' : auditIgnored && project.activeStep === 'storyboard' ? '已继续 · 审计未通过' : stageComplete ? '已完成' : '待生成';
  const videoDurationText = isVideo ? videoDurationSummary(project.outputs.storyboard?.prompts || [], project.videoGeneration?.items || [], project.videoGeneration?.duration) : '';
  const videoGenerationModeText = effectiveVideoGenerationMode() === 'confirm' ? '逐镜确认' : '批量连续';
  const pendingNotice = workflowPending ? '<div class="workflow-audit-progress" role="status"><b>生成 / 审计与自动修正中…</b><span>下方保留上次成果，新结果完成审计与最多一次修正后一次替换。</span></div>' : '';
  const partialNotice = partial && project.activeStep !== 'storyboard' ? '<div class="storyboard-partial-notice">本项目分镜仅部分通过，受阻内容尚未交付。请在第二步查看具体范围与缺少的信息；当前可用素材和视频仅对应已通过的独立生成块。</div>' : '';
  const body = `${pendingNotice}${partialNotice}${isAssets ? assetGenerationTemplate(output) : ''}${isVideo ? videoGenerationTemplate() : ''}${output.body || ''}`;
  return `<div class="result-layout ${project.activeStep === 'storyboard' ? 'seedance-layout' : ''} ${isAssets ? 'assets-layout' : ''} ${isVideo ? 'video-generation-layout' : ''}${auditIgnored && project.activeStep === 'storyboard' ? ' audit-ignored-result' : ''}"><div class="result-main"><div class="result-title"><span class="result-badge">${steps.find((s) => s.id === project.activeStep).no}</span><div><h3>${esc(output.title)}</h3><p>${esc(output.subtitle)}</p></div><span class="result-time">刚刚生成</span></div><div class="result-body">${body}</div></div><div class="result-side"><div class="side-stat"><span>阶段状态</span><b><i></i> ${stageStatus}</b></div><div class="side-stat"><span>${isVideo ? '镜头时长' : '预计耗时'}</span><b>${isVideo ? esc(videoDurationText) : output.time || '12 秒'}</b></div>${project.activeStep === 'storyboard' ? `<div class="side-stat vertical"><span>分镜规范</span><b>${storyboardUsesCustomSkill() ? '用户 Skill' : storyboardUsesSkill21() ? 'Skill v2.1' : '即梦二点零'}</b><small>${storyboardUsesCustomSkill() ? esc(String(project.outputs.storyboard.auditSummary.skillName || '上传规范')) + '<br>按本次上传规范执行' : storyboardUsesSkill21() ? '每块≤15秒、最多5镜<br>审计结果与正文分开' : '按剧情动态分配<br>素材引用已分配'}</small></div>` : ''}${isAssets ? '<div class="side-stat vertical"><span>素材方式</span><b>GPT 订阅 / 本地上传</b><small>GPT Image 2 · 本机 Codex<br>图片齐全后可进入视频步骤</small></div>' : ''}${isVideo ? `<div class="side-stat vertical"><span>视频模型</span><b>${esc(seedanceModelLabel(project.videoGeneration?.model))}</b><small>${esc(project.videoGeneration?.ratio || seedanceStatus.ratio)} · ${esc(project.videoGeneration?.resolution || seedanceStatus.resolution)}<br>逐镜或批量 · 保存 MP4</small></div>` : ''}<button class="outline-button full" id="rerunStep" ${project.running ? 'disabled' : ''}>${isAssets ? '重新生成参考图' : isVideo ? '重新生成全部视频' : '重新生成分析与分镜'} <span>↻</span></button>${isVideo ? '<div class="auto-note">成功镜头已保存到本机，可逐个生成或批量继续。</div>' : stageComplete ? `<div class="auto-note"><i>${auditIgnored && project.activeStep === 'storyboard' ? '!' : '✓'}</i> ${isAssets ? '参考图已全部完成' : project.activeStep === 'storyboard' && storyboardUsesSkill21() ? auditIgnored ? '审计未通过，已忽略并继续' : storyboardUsesCustomSkill() ? '按用户 Skill 完成文本审计' : '分镜文本审计通过' : '当前阶段已完成'}</div>` : '<div class="auto-note">当前阶段尚未完成</div>'}</div></div>`;
}

function makeOutput(id) {
  const title = project.title === '未命名短剧项目' ? deriveTitle(project.script) : project.title;
  const story = getStoryUnits(project.script);
  const characters = story.characters.length ? story.characters : ['未识别人物'];
  const type = getMetadataValue(project.script, ['类型', '题材']) || '短剧';
  const sellingPoints = getMetadataValue(project.script, ['核心卖点', '卖点']) || story.units.slice(0, 2).map((unit) => unit.text).join('，');
  const firstAction = story.units.find((unit) => unit.type === 'action')?.text || story.units[0]?.text || '剧情开始';
  const firstDialogue = story.units.find((unit) => unit.type === 'dialogue');
  if (id === 'analysis') return { title: '故事结构分析', subtitle: `已从剧本中识别 ${characters.length} 名人物`, time: '8 秒', body: `<div class="analysis-grid"><div><label>故事定位</label><strong>${esc(type)}</strong><p>${esc(sellingPoints.slice(0, 100))}</p></div><div><label>主要人物</label><strong>${esc(characters.join('、'))}</strong><p>后续分镜和素材均使用这些人物姓名。</p></div><div><label>开场事件</label><strong>${esc(firstAction.slice(0, 30))}</strong><p>${firstDialogue ? `${esc(firstDialogue.speaker)}的首句对白：“${esc(firstDialogue.text)}”` : '剧本暂未识别到独立对白。'}</p></div><div><label>解析状态</label><div class="tags"><span>已排除标题</span><span>已排除规格</span><span>已识别对白</span><span>已提取姓名</span></div></div></div><div class="callout"><b>人物校验</b><span>当前识别人物：${esc(characters.join('、'))}。若姓名不完整，请在原剧本中增加“人物：姓名一、姓名二”或使用“姓名：对白”的格式。</span></div>` };
  if (id === 'storyboard') return makeSeedanceStoryboard(project.script);
  if (id === 'assets') {
    const characterCards = characters.slice(0, 3).map((name, index) => `<div class="asset-card asset-character ${index % 2 ? 'dark' : ''}"><span class="asset-type">角色</span><strong>${esc(name)}</strong><small>外貌、发型、服装和表情参考图</small><em>对应 @${esc(name)}</em></div>`).join('');
    const sceneNo = Math.min(characters.length, 3) + 1;
    return { title: '视觉素材清单', subtitle: `角色 ${characters.length} 名 · 场景与道具参考`, time: '22 秒', body: `<div class="asset-grid">${characterCards}<div class="asset-card asset-scene"><span class="asset-type">场景</span><strong>主场景参考</strong><small>根据原剧本中的地点、构图和光线制作</small><em>对应 @主场景</em></div><div class="asset-card asset-scene blue"><span class="asset-type">道具</span><strong>关键道具参考</strong><small>根据剧情中的证据、手机、文件或物件制作</small><em>对应 @关键道具</em></div></div>` };
  }
  return { title: 'Seedance 分镜视频', subtitle: '按第二步分镜逐条生成并保存 MP4', time: '数分钟 / 镜头', body: '' };
}

function getMetadataValue(script, labels) {
  const lines = script.split(/\r?\n/).map(cleanScriptLine);
  for (const label of labels) {
    const match = lines.map((line) => line.match(new RegExp(`^${label}\\s*[：:]\\s*(.+)$`))).find(Boolean);
    if (match) return match[1].trim();
  }
  return '';
}

const metadataLabels = ['类型', '题材', '规格', '核心卖点', '卖点', '风格', '集数', '时长', '受众', '平台', '简介', '梗概', '标签', '备注', '创作说明', '建议', '基调'];
const nonCharacterLabels = new Set([...metadataLabels, '人物', '角色', '主要人物', '出场人物', '场景', '地点', '时间', '道具', '服装', '声音', '音乐', '画面', '镜头', '内景', '外景']);

function cleanScriptLine(line) {
  return line.trim().replace(/^#{1,6}\s*/, '').replace(/^[-*]\s+/, '').trim();
}

function isMetadataLine(line) {
  if (!line) return true;
  if (/^《[^》]+》.*(?:剧本|第[一二三四五六七八九十\d]+卷)/.test(line)) return true;
  if (/^第\s*[一二三四五六七八九十百\d]+\s*(?:集|卷)(?:\s|$|[：:])/.test(line)) return true;
  if (/^(?:第\s*[一二三四五六七八九十百\d]+\s*[场幕])(?:\s|$|[：:])/.test(line)) return true;
  if (/^(?:\d+[-－.]\d+|场景|地点|时间|内景|外景)(?:\s|$|[：:])/.test(line)) return true;
  return metadataLabels.some((label) => new RegExp(`^${label}\\s*[：:]`).test(line));
}

function isCharacterName(value) {
  const name = value.replace(/[（(].*?[）)]/g, '').trim();
  if (!/^[\u4e00-\u9fff·]{1,8}$/.test(name)) return false;
  if (nonCharacterLabels.has(name)) return false;
  if (/^(?:第.+[集卷场幕]|旁白|画外音|系统音|字幕|全体|众人)$/.test(name)) return false;
  return true;
}

function parseDialogue(line) {
  const match = line.match(/^([\u4e00-\u9fff·]{1,8})(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/);
  if (!match || !isCharacterName(match[1])) return null;
  return { speaker: match[1].trim(), direction: (match[2] || '').trim(), text: match[3].trim() };
}

function uniqueNames(names) {
  return [...new Set(names.filter(Boolean))];
}

function getStoryUnits(script) {
  const lines = script.split(/\r?\n/).map(cleanScriptLine).filter(Boolean);
  const declaredNames = [];
  const dialogueNames = [];

  lines.forEach((line) => {
    const cast = line.match(/^(?:人物|角色|主要人物|出场人物)\s*[：:]\s*(.+)$/);
    if (cast) {
      cast[1].split(/[、，,；;\/]/).map((item) => item.replace(/[（(].*?[）)]/g, '').trim()).filter(isCharacterName).forEach((name) => declaredNames.push(name));
    }
    const dialogue = parseDialogue(line);
    if (dialogue) dialogueNames.push(dialogue.speaker);
  });

  let characters = uniqueNames([...declaredNames, ...dialogueNames]);
  if (!characters.length) {
    const inferred = [];
    lines.filter((line) => !isMetadataLine(line)).forEach((line) => {
      const matches = line.matchAll(/([\u4e00-\u9fff]{2,4})(?=抬眼|转身|走进|走出|开口|冷声|皱眉|看向|盯着|拿起|推开|站在|坐在|冲向|跪下|笑了|哭了)/g);
      for (const match of matches) if (isCharacterName(match[1])) inferred.push(match[1]);
    });
    characters = uniqueNames(inferred).slice(0, 4);
  }

  const units = [];
  lines.forEach((line) => {
    if (isMetadataLine(line) || /^(?:人物|角色|主要人物|出场人物)\s*[：:]/.test(line)) return;
    const dialogue = parseDialogue(line);
    if (dialogue) {
      units.push({ type: 'dialogue', ...dialogue, characters: [dialogue.speaker] });
      return;
    }
    line.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean).forEach((text) => {
      if (isMetadataLine(text)) return;
      const present = characters.filter((name) => text.includes(name));
      units.push({ type: 'action', text, characters: present });
    });
  });

  const fallbackName = characters[0] || '女主角';
  if (!units.length) units.push({ type: 'action', text: `${fallbackName}走进场景，察觉到气氛异常。`, characters: characters.slice(0, 1) });
  return { units, characters };
}

function makeSeedanceStoryboard(script) {
  const story = getStoryUnits(script);
  const characterNames = story.characters.length ? story.characters : ['女主角'];
  const referencedCharacters = characterNames.slice(0, 3);
  const characterRefs = new Map(referencedCharacters.map((name, index) => [name, `@${name}`]));
  const sceneImageNo = referencedCharacters.length + 1;
  const propImageNo = sceneImageNo + 1;
  const requiredImages = propImageNo;
  const configured = { images: requiredImages, videos: 0, audios: 0, ...(project.seedanceMaterials || {}) };
  const materials = { ...configured, images: Math.max(requiredImages, Number(configured.images) || 0) };
  const totalFiles = Number(materials.images) + Number(materials.videos) + Number(materials.audios);
  const materialValid = materials.images <= 9 && materials.videos <= 3 && materials.audios <= 3 && totalFiles <= 12;

  const baseReferences = referencedCharacters.map((name, index) => ({ ref: `@${name}`, role: `${name}角色设定图`, use: `作为${name}的外貌、发型和服装参考` }));
  baseReferences.push({ ref: '@主场景', role: '场景设定图', use: '作为环境、构图和光线参考' });
  baseReferences.push({ ref: '@关键道具', role: '关键道具图', use: '作为证据、手机、照片或其他关键物件参考' });

  const extraReferences = [];
  for (let imageNo = requiredImages + 1; imageNo <= materials.images; imageNo += 1) extraReferences.push({ ref: `@补充视觉参考${imageNo - requiredImages}`, role: `补充视觉参考${imageNo - requiredImages}`, use: imageNo % 2 === 0 ? '作为服装与造型细节参考' : '作为场景光线与构图参考' });
  const videoRoles = ['作为运镜与镜头节奏参考', '作为动作编排参考', '作为转场与视觉效果参考'];
  for (let videoNo = 1; videoNo <= materials.videos; videoNo += 1) extraReferences.push({ ref: `@Video${videoNo}`, role: `视频参考${videoNo}`, use: videoRoles[videoNo - 1] });
  const audioRoles = ['作为背景音乐与节奏参考', '作为环境音与音效参考', '作为对白语气与音色参考'];
  for (let audioNo = 1; audioNo <= materials.audios; audioNo += 1) extraReferences.push({ ref: `@Audio${audioNo}`, role: `音频参考${audioNo}`, use: audioRoles[audioNo - 1] });
  const promptReferenceText = extraReferences.length ? `\n补充素材用途：${extraReferences.map((item) => `${item.ref}${item.use}`).join('；')}。` : '';

  const primaryName = characterNames[0];
  const fallback = [
    `${primaryName}握紧手中的关键物件，指尖轻微颤抖。`,
    `${primaryName}站在人群中央，周围人的目光逐渐聚拢。`,
    `${primaryName}抬眼看向声源，神情由克制转为警觉。`,
    `${primaryName}拿起手机，屏幕上的关键信息突然亮起。`,
    `${primaryName}转身望向入口，紧闭的大门缓慢打开。`,
    `${primaryName}与来人对视，脸上的情绪瞬间凝固。`,
  ];
  const designs = [
    { frame: '极近特写', camera: '镜头缓慢推近', sound: '低沉心跳、轻微布料摩擦、远处环境底噪', mood: '压抑、不安' },
    { frame: '环境全景', camera: '镜头缓慢向右摇动', sound: '空间环境声、压低的交谈声', mood: '表面平静、暗藏异常' },
    { frame: '中近景', camera: '镜头跟随人物视线轻微移动', sound: '清晰呼吸声、低频持续音乐', mood: '警觉、疑惑' },
    { frame: '近景特写', camera: '固定机位后轻微推近', sound: '清晰提示音、环境声瞬间压低', mood: '信息冲击、紧张升级' },
    { frame: '低角度全景', camera: '镜头朝入口缓慢推进', sound: '门轴声、脚步声，音乐在第四秒短暂停顿', mood: '未知逼近、悬疑' },
    { frame: '中近景', camera: '使用希区柯克变焦制造眩晕感', sound: '短促吸气声、低频冲击音、结尾保留半秒静默', mood: '震惊、反转' },
  ];

  const shots = designs.map((design, index) => {
    const unit = story.units[index] || { type: 'action', text: fallback[index], characters: [primaryName] };
    const namesInShot = uniqueNames(unit.characters?.length ? unit.characters : [primaryName]);
    const roleReferences = namesInShot.map((name) => characterRefs.has(name) ? `${characterRefs.get(name)}作为${name}的外貌和服装参考` : '').filter(Boolean);
    if (!roleReferences.length && characterRefs.has(primaryName)) roleReferences.push(`${characterRefs.get(primaryName)}作为${primaryName}的外貌和服装参考`);
    const subjectLine = `${roleReferences.join('；')}；@主场景 作为场景、构图和光线参考`;
    const needsProp = /手机|照片|戒指|文件|证据|信件|钥匙|捧花|礼物|道具|退婚书|合同|银行卡|药瓶/.test(unit.text);
    const propLine = needsProp ? `；@关键道具 作为关键道具外观参考` : '';
    const cleanUnitText = unit.text.replace(/[。！？!?，,；;：:]$/, '');
    const content = unit.type === 'dialogue'
      ? `${unit.speaker}${unit.direction ? `先${unit.direction}，` : ''}面向对方自然表演，以${design.mood}的情绪说：“${unit.text}”`
      : `${namesInShot.length ? `画面主体为${namesInShot.join('与')}。` : ''}${cleanUnitText}`;
    const prompt = `生成一条精准五秒的竖屏短剧视频。${subjectLine}${propLine}。${promptReferenceText}\n零至二秒：采用${design.frame}，${content}，动作自然连续，不停顿、不冻结。\n二至五秒：${design.camera}，让人物情绪推进到“${design.mood}”，画面在明确的动作或表情上收束。\n声音：${design.sound}${unit.type === 'dialogue' ? '；对白口型与语音准确同步' : ''}。\n画面风格：电影质感、浅景深、每秒二十四帧、九比十六竖屏、冷暖对比，突出${design.mood}的氛围。不添加剧本外人物，不切换场景，不使用相互冲突的运镜。`;
    return {
      no: String(index + 1).padStart(2, '0'),
      title: unit.type === 'dialogue' ? `${unit.speaker}说出关键对白` : (unit.text.slice(0, 18).replace(/[。！？!?]$/, '') || `镜头${index + 1}`),
      duration: '五秒', frame: design.frame, camera: design.camera, prompt,
    };
  });

  const referenceCards = [...baseReferences, ...extraReferences].map((item) => `<div><code>${item.ref}</code><b>${esc(item.role)}</b><small>${esc(item.use)}</small></div>`).join('');
  const characterSummary = characterNames.length ? characterNames.join('、') : '未识别到姓名';
  const materialPlan = `<div class="seedance-plan"><div class="plan-head"><div><span class="seedance-logo">梦</span><div><b>即梦二点零素材引用方案</b><small>已识别人物：${esc(characterSummary)}；除平台引用标记外，提示词全部使用中文</small></div></div><span class="plan-count ${materialValid ? '' : 'invalid'}">${totalFiles} / 12 个文件</span></div><div class="material-counters"><label>图片<input class="material-count" data-material="images" data-min="${requiredImages}" type="number" min="${requiredImages}" max="9" value="${materials.images}"><small>最少${requiredImages}张、最多9张</small></label><label>视频<input class="material-count" data-material="videos" data-min="0" type="number" min="0" max="3" value="${materials.videos}"><small>最多3个，每个2至5秒</small></label><label>音频<input class="material-count" data-material="audios" data-min="0" type="number" min="0" max="3" value="${materials.audios}"><small>最多3个，总长不超过15秒</small></label></div><div class="reference-grid">${referenceCards}</div><div class="constraint-row"><span>✓ 已排除标题与类型等元数据</span><span>✓ 已写入真实人物姓名</span><span class="${materials.images <= 9 ? '' : 'invalid'}">${materials.images <= 9 ? '✓' : '✕'} 图片${materials.images}张，不超过9张</span><span class="${totalFiles <= 12 ? '' : 'invalid'}">${totalFiles <= 12 ? '✓' : '✕'} 总文件${totalFiles}个，不超过12个</span><span>✓ 单镜头五秒</span><span>⚠ 引用图不得含真实人脸</span></div></div>`;
  const cards = shots.map((shot, index) => `<article class="seedance-shot"><div class="shot-card-head"><div><span class="shot-number">${shot.no}</span><div><h4>${esc(shot.title)}</h4><p>${esc(shot.frame)} · ${esc(shot.camera)}</p></div></div><div class="shot-actions"><span>${shot.duration}</span><button class="copy-shot" data-shot-index="${index}">复制提示词</button></div></div><pre>${esc(shot.prompt)}</pre></article>`).join('');
  const body = `${materialPlan}<div class="prompt-toolbar"><div><b>逐镜头即梦提示词</b><span>每个镜头独立生成，角色姓名和素材用途均已明确</span></div><button id="copyAllSeedance">复制全部提示词</button></div><div class="seedance-shots">${cards}</div><div class="skill-check"><b>生成前检查</b><span>请确认各角色参考图顺序正确、均无真实人脸；每条提示词单独选择五秒生成，不要把多个镜头塞进一次生成任务。</span></div>`;
  return { title: '第1集 · 即梦二点零分镜提示词', subtitle: `${shots.length}个独立镜头 · 每镜五秒 · 已识别人物：${characterSummary}`, time: '18秒', prompts: shots.map((shot) => shot.prompt), durations: shots.map((shot) => resolveSeedanceDuration(shot.duration, shot.prompt, SEEDANCE_DEFAULT_DURATION)), characters: characterNames, body };
}

function deriveTitle(script) {
  const first = script.split(/\n+/).find((line) => line.trim() && !/^第\s*\d+\s*集/.test(line.trim())) || '未命名短剧项目';
  return first.replace(/^第\s*\d+\s*集\s*/, '').slice(0, 18) || '未命名短剧项目';
}

function render() {
  document.querySelector('#app').innerHTML = appTemplate();
  bindEvents();
  if (clearResultRequest?.ownerProject === project && clearResultRequest.stepId === project.activeStep) document.querySelector('#cancelClearResult')?.focus();
}

function workflowProgressTemplate() {
  const progress = summarizeWorkflowProgress(project.workflowProgress);
  const current = progress?.current;
  const identity = progress?.prompt?.provider ? progress.prompt : workflowRun?.ownerProject === project ? resolveStoryboardGeneration(workflowRun.generation) : resolveStoryboardGeneration(project.storyboardGeneration);
  const thinkingLabel = `${identity.provider === 'codex-subscription' ? `GPT 订阅 · ${identity.model || '待选择模型'} · ` : ''}${identity.reasoningEffort === 'none' ? '思考已关闭 · none' : `${progress ? '已启用' : '启用思考'} · ${identity.reasoningEffort || '待选择'}`}`;
  const customAudit = workflowRun?.ownerProject === project ? Boolean(workflowRun.stageSkills?.storyboard) : storyboardUsesCustomSkill();
  const auditIgnored = progress?.status === 'completed' && (progress.auditIgnored || project.outputs.storyboard?.auditSummary?.finalStatus === '审计未通过（已忽略）');
  const statusLabels = { running: '正在执行', completed: '已完成', failed: '执行失败', stopped: '已停止' };
  const phaseLabels = { preparing: '准备提示词', candidate: '分析故事并生成分镜', audit: '独立审计 60 项规则', repair: '修正分镜并准备重新审计', validating: '校验分镜数据', completed: '分镜流程已完成', failed: '分镜流程未完成', stopped: '本次分镜生成已停止' };
  const requestLabels = { candidate: '分析 / 分镜生成', repair: '自动修正', audit: '独立审计' };
  const receiveLabels = { waiting: '等待首段响应', thinking: '接收模型思考', generating: '接收生成内容', completed: '响应已完成', failed: '请求失败', stopped: '已停止接收' };
  const previousPhaseLabels = { waiting: '等待首段', thinking: '模型思考', generating: '接收正文' };
  const previousPhase = ['failed', 'stopped'].includes(current?.status) && previousPhaseLabels[current.lastPhase]
    ? ` · ${current.status === 'failed' ? '失败' : '停止'}前：${previousPhaseLabels[current.lastPhase]}` : '';
  const duration = formatProgressDuration;
  const preparing = progress && progress.preparationMs !== null;
  const promptInfo = preparing ? `系统 ${progress.prompt.systemChars.toLocaleString()} 字符 · Skill ${progress.prompt.skillChars.toLocaleString()} 字符 · 原文 ${progress.prompt.inputChars.toLocaleString()} 字符` : '开始后显示系统提示词、Skill 与原文字数';
  const firstSegments = current ? [current.firstReasoningMs, current.firstContentMs].filter((value) => value !== null) : [];
  const firstResponse = current ? (firstSegments.length ? `首段等待 ${duration(Math.min(...firstSegments))}` : `首段尚未到达 · 已等待 ${duration(current.waitingMs)}`) : '单次请求开始后显示首段等待';
  const phaseText = auditIgnored ? '分镜流程已完成 · 审计失败已忽略' : customAudit && progress?.phase === 'audit' ? '独立审计用户 Skill' : phaseLabels[progress?.phase] || '等待开始生成分镜';
  const compactPhaseText = progress?.status === 'running' && current ? `${phaseText} · ${receiveLabels[current.phase] || ''}` : phaseText;
  const detailsOpen = document.querySelector('#workflowProgressDetails')?.open === true;
  return `<details id="workflowProgressDetails"${detailsOpen ? ' open' : ''}><summary class="workflow-progress-heading"><div><span class="workflow-progress-dot ${progress?.status || 'idle'}${auditIgnored ? ' warning' : ''}"></span><b>执行进度</b><span class="workflow-progress-status">${auditIgnored ? '已完成 · 审计已忽略' : statusLabels[progress?.status] || '待开始'}</span><span class="workflow-progress-phase" title="${compactPhaseText}">${compactPhaseText}</span></div><div class="workflow-progress-summary-end"><span class="workflow-progress-total">总耗时 <strong>${progress ? duration(progress.elapsedMs) : '—'}</strong></span><span class="workflow-progress-toggle">耗时详情 <i>⌄</i></span></div></summary><div class="workflow-progress-details">
    <div class="workflow-progress-current${auditIgnored ? ' warning' : ''}" role="status"><b>${auditIgnored ? '分镜流程已完成 · 审计失败已忽略' : customAudit && progress?.phase === 'audit' ? '独立审计用户 Skill' : phaseLabels[progress?.phase] || '等待开始生成分镜'}</b><span>${current ? `第 ${current.id} 次请求 · ${requestLabels[current.kind]} · ${receiveLabels[current.phase]}${previousPhase} · 单次 ${duration(current.elapsedMs)}` : progress?.status === 'running' ? '正在本地准备请求' : '开始后实时显示当前阶段与各部分耗时'}</span></div>
    <div class="workflow-progress-grid">
      <div class="workflow-progress-metric ${progress?.phase === 'preparing' ? 'active' : ''}"><div><b>01 提示词准备</b><strong>${preparing ? duration(progress.preparationMs) : '—'}</strong></div><small>${promptInfo}</small></div>
      <div class="workflow-progress-metric ${['candidate', 'repair'].includes(progress?.phase) ? 'active' : ''}"><div><b>02 分析 / 分镜生成</b><strong>${progress?.generationCount ? duration(progress.generationMs) : '—'}</strong></div><small>生成与修正累计 ${progress?.generationCount || 0} 次请求</small></div>
      <div class="workflow-progress-metric ${current?.phase === 'thinking' && progress?.status === 'running' ? 'active' : ''}"><div><b>03 模型思考</b><strong>${duration(progress?.thinkingMs)}</strong></div><small>${esc(thinkingLabel)} · ${progress?.thinkingMs !== null && progress?.thinkingMs !== undefined ? '正文前思考接收窗口' : '尚未观测到思考片段'}</small></div>
      <div class="workflow-progress-metric ${progress?.phase === 'audit' ? 'active' : ''}"><div><b>04 独立审计 · ${customAudit ? '用户 Skill' : '60 项'}</b><strong>${progress?.auditCount ? duration(progress.auditMs) : '—'}</strong></div><small>审计 ${progress?.auditCount || 0} 次 · 自动回炉 ${progress?.repairCount || 0} / ${progress?.maxRepairs ?? 1} 次${auditIgnored ? ' · 失败已忽略' : ''}</small></div>
    </div>
    <div class="workflow-progress-foot"><span>${firstResponse}${current ? ` · 已收思考 ${current.reasoningChars.toLocaleString()} / 正文 ${current.outputChars.toLocaleString()} 字符` : ''}</span><span>思考耗时已包含在生成 / 审计中；提示词准备仅统计本地组装。</span></div></div></details>`;
}

function videoNavigationTemplate() {
  const state = project.videoGeneration || defaultProject.videoGeneration;
  const prompts = project.outputs.storyboard?.prompts || [];
  const count = prompts.length || state.items?.length || 0;
  const items = Array.from({ length: count }, (_value, index) => state.items?.[index] || {});
  const completed = items.filter(item => getSelectedVideoVersion(item)).length;
  const generating = runningGenerationStep() === 'video';
  const active = generating ? items.findIndex(item => ['creating', 'queued', 'running', 'downloading'].includes(item.status)) : -1;
  const selected = Number.isInteger(state.navigationShotIndex) && state.navigationShotIndex >= 0 && state.navigationShotIndex < count ? state.navigationShotIndex : Math.max(0, active);
  const buttons = items.map((item, index) => {
    const busy = generating && ['creating', 'queued', 'running', 'downloading'].includes(item.status);
    const version = getSelectedVideoVersion(item);
    const status = busy ? '正在生成' : item.status === 'failed' ? version ? '重新生成失败，已有版本保留' : '生成失败' : version ? '已完成' : item.status === 'certification' ? '等待真人认证' : '未生成';
    return `<button type="button" class="video-nav-shot${selected === index ? ' selected' : ''}${busy ? ' is-generating' : version ? ' complete' : ''}${item.status === 'failed' ? ' failed' : ''}" data-video-nav-index="${index}" aria-current="${selected === index ? 'true' : 'false'}" aria-label="镜头 ${index + 1}，${status}，点击定位" title="镜头 ${index + 1} · ${status}"><span>${index + 1}</span>${busy ? '<i class="video-nav-spinner" aria-hidden="true"></i>' : version ? '<i class="video-nav-check" aria-hidden="true">√</i>' : ''}</button>`;
  }).join('');
  return `<div class="video-navigation-panel" id="videoNavigator"><div class="video-navigation-heading"><b>视频分镜进度</b><span role="status">${active >= 0 ? `正在生成镜头 ${active + 1} / ${count}` : count ? completed === count ? '全部镜头已有视频' : '点击编号定位对应镜头' : '生成分镜后显示镜头列表'}</span><strong>已完成 ${completed} / ${count}</strong></div><nav class="video-navigation-shots" aria-label="定位视频镜头">${buttons || '<span class="video-navigation-empty">暂无分镜</span>'}</nav></div>`;
}

function generationProgressTemplate() {
  return project.activeStep === 'video' ? videoNavigationTemplate() : workflowProgressTemplate();
}

function bindVideoNavigationEvents() {
  document.querySelectorAll('[data-video-nav-index]').forEach(button => { button.onclick = () => navigateToVideoShot(Number(button.dataset.videoNavIndex)); });
}

function navigateToVideoShot(index) {
  const count = project.outputs.storyboard?.prompts?.length || project.videoGeneration?.items?.length || 0;
  if (!Number.isInteger(index) || index < 0 || index >= count) return false;
  if (project.activeStep !== 'video') return false;
  const previous = project.videoGeneration.navigationShotIndex;
  project.videoGeneration.navigationShotIndex = index;
  try { saveProject(); }
  catch (error) { project.videoGeneration.navigationShotIndex = previous; showToast(cleanRemoteError(error, '无法保存定位')); return false; }
  updateWorkflowProgressPanel();
  const card = document.querySelector(`#video-shot-${index + 1}`);
  const output = document.querySelector('#outputArea');
  if (!card || !output) return false;
  // Scroll only the result region; keep the fixed navigator and page in place.
  const top = output.scrollTop + card.getBoundingClientRect().top - output.getBoundingClientRect().top - 10;
  output.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  return true;
}

function selectVideoVersion(index, versionId) {
  const state = project.videoGeneration;
  const previous = state?.items?.[index];
  if (!previous || typeof versionId !== 'string') return false;
  const normalized = normalizeVideoItemVersions(previous);
  if (!normalized.versions.some(version => version.id === versionId)) return false;
  const previousUpdatedAt = project.updatedAt;
  state.items[index] = { ...normalized, selectedVersionId: versionId };
  try { saveProject(); }
  catch (error) {
    state.items[index] = previous; project.updatedAt = previousUpdatedAt;
    showToast(`切换视频版本未能保存，原选择已保留：${cleanRemoteError(error, '本地存储不可用')}`); return false;
  }
  renderWithoutMovingPage();
  return true;
}

function regenerateVideoShot(index) {
  if (project.running) return showToast('当前任务正在生成，请先完成或停止，再重新生成此镜头。');
  const prompts = project.outputs.storyboard?.prompts || [];
  if (!Number.isInteger(index) || !prompts[index]) return showToast('请先准备此镜头的分镜，再重新生成视频。');
  return generateSeedanceVideos({ token: ++generationRun, indexes: [index], mode: 'confirm' });
}

function updateWorkflowProgressPanel() {
  const panel = document.querySelector('#workflowProgressPanel');
  if (panel) {
    panel.innerHTML = generationProgressTemplate();
    panel.classList?.toggle('video-progress-panel', project.activeStep === 'video');
    panel.setAttribute?.('aria-label', project.activeStep === 'video' ? '视频分镜进度' : '分镜执行进度');
    bindVideoNavigationEvents();
  }
}

function releaseWorkflowProgress(run) {
  run?.unsubscribe?.();
  if (run?.timer !== undefined) window.clearInterval?.(run.timer);
  if (run) { run.unsubscribe = null; run.timer = undefined; }
}

function persistWorkflowProgress(ownerProject) {
  const index = projectLibrary.projects.findIndex((item) => item.id === ownerProject.id);
  if (index >= 0) projectLibrary.projects[index] = ownerProject;
  saveProjectLibrary();
}

function capturePageScrollPositions() {
  return ['.main', '#outputArea', '.sidebar', '.project-list'].map((selector) => {
    const element = document.querySelector(selector);
    return { selector, top: element?.scrollTop || 0, left: element?.scrollLeft || 0 };
  });
}

function renderWithoutMovingPage(positions = capturePageScrollPositions()) {
  render();
  positions.forEach(({ selector, top, left }) => {
    const element = document.querySelector(selector);
    if (!element) return;
    element.scrollTop = top;
    element.scrollLeft = left;
  });
}

function setAutoRunToVideo(enabled) {
  if (project.running) { showToast('生成进行中，完成后可切换全流程设置'); return false; }
  const previous = project.autoRunToVideo;
  const previousUpdatedAt = project.updatedAt;
  project.autoRunToVideo = enabled === true;
  try { saveProject(); }
  catch (error) {
    project.autoRunToVideo = previous;
    project.updatedAt = previousUpdatedAt;
    renderWithoutMovingPage();
    showToast(`保存全流程设置失败，已保留原设置：${cleanRemoteError(error, '本地存储不可用')}`);
    return false;
  }
  renderWithoutMovingPage();
  return true;
}

function bindEvents() {
  configureAutomaticSeedanceDurationField();
  document.querySelector('#autoRunToVideo')?.addEventListener('change', (event) => setAutoRunToVideo(event.target.checked));
  document.querySelector('#stopAutoPipeline')?.addEventListener('click', () => { stopCurrentGeneration(); render(); showToast('全流程已停止，已完成的成果仍保留'); });
  document.querySelectorAll('[data-import-generation-skill]').forEach((button) => button.addEventListener('click', () => importGenerationSkill(button.dataset.importGenerationSkill)));
  document.querySelectorAll('[data-preview-generation-skill]').forEach((button) => button.addEventListener('click', () => previewGenerationSkill(button.dataset.previewGenerationSkill)));
  document.querySelectorAll('[data-remove-generation-skill]').forEach((button) => button.addEventListener('click', () => removeGenerationSkill(button.dataset.removeGenerationSkill)));
  document.querySelector('#closeGenerationSkillPreview')?.addEventListener('click', () => { generationSkillPreview = null; renderWithoutMovingPage(); });
  document.querySelector('#generationSkillPreviewModal')?.addEventListener('click', (event) => { if (event.target.id === 'generationSkillPreviewModal') { generationSkillPreview = null; renderWithoutMovingPage(); } });
  document.querySelector('#scriptInput').addEventListener('input', (event) => {
    project.script = event.target.value;
    project.title = project.title === '未命名短剧项目' && project.script ? deriveTitle(project.script) : project.title;
    saveProject();
    const count = document.querySelector('.textarea-footer span');
    if (count) count.textContent = `${project.script.length} 字`;
  });
  document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => selectWorkflowStep(button.dataset.step)));
  document.querySelector('#returnToRunningStage')?.addEventListener('click', () => { const stage = runningGenerationStep(); if (stage) selectWorkflowStep(stage); });
  document.querySelector('#stopRunningTask')?.addEventListener('click', () => { stopCurrentGeneration(); renderWithoutMovingPage(); showToast('已停止当前任务，已完成的成果仍保留'); });
  document.querySelector('#startGenerate').addEventListener('click', () => startGeneration());
  document.querySelector('#emptyStart')?.addEventListener('click', () => { if (project.running) return; project.script = demoScript; saveProject(); render(); startGeneration(); });
  document.querySelector('#useDemo').addEventListener('click', () => { if (project.running) return; project.script = demoScript; project.title = '失控的婚礼'; saveProject(); render(); showToast('示例剧本已载入'); });
  document.querySelector('#fileInput').addEventListener('change', readFile);
  document.querySelector('#newProject').addEventListener('click', createNewProject);
  document.querySelectorAll('[data-project-id]').forEach((button) => button.addEventListener('click', () => switchProject(button.dataset.projectId)));
  document.querySelectorAll('[data-delete-project-id]').forEach((button) => button.addEventListener('click', () => deleteProject(button.dataset.deleteProjectId)));
  document.querySelector('#exportProject').addEventListener('click', exportProject);
  document.querySelector('#importProject').addEventListener('click', () => document.querySelector('#projectFileInput').click());
  document.querySelector('#projectFileInput').addEventListener('change', importProject);
  document.querySelector('#clearOutput').addEventListener('click', requestClearCurrentResult);
  document.querySelector('#confirmClearResult')?.addEventListener('click', confirmClearCurrentResult);
  document.querySelector('#cancelClearResult')?.addEventListener('click', closeClearResultDialog);
  document.querySelector('#closeClearResult')?.addEventListener('click', closeClearResultDialog);
  document.querySelector('#exportBeforeClear')?.addEventListener('click', exportProject);
  document.querySelector('#clearResultModal')?.addEventListener('click', (event) => { if (event.target.id === 'clearResultModal') closeClearResultDialog(); });
  document.querySelector('#clearResultModal')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeClearResultDialog(); }
    if (event.key === 'Tab') {
      const buttons = [...event.currentTarget.querySelectorAll('button')];
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    }
  });
  document.querySelector('#copyOutput').addEventListener('click', copyOutput);
  document.querySelector('#rerunStep')?.addEventListener('click', rerunCurrentStage);
  document.querySelector('#generateVideo')?.addEventListener('click', () => { if (!project.running) generateVideoStage(++generationRun); });
  document.querySelector('#openSettings').addEventListener('click', openStoryboardSettings);
  document.querySelector('#openImageSettings')?.addEventListener('click', openImageSettings);
  document.querySelector('#openSeedanceSettings').addEventListener('click', openSeedanceSettings);
  document.querySelector('#heroModelStatus').addEventListener('click', openStoryboardSettings);
  document.querySelector('#heroImageStatus')?.addEventListener('click', openImageSettings);
  document.querySelector('#openCodexImageSettings')?.addEventListener('click', openCodexImageSettings);
  document.querySelector('#heroCodexImageStatus')?.addEventListener('click', openCodexImageSettings);
  document.querySelector('#configureCodexImages')?.addEventListener('click', openCodexImageSettings);
  document.querySelector('#closeCodexImageSettings')?.addEventListener('click', closeCodexImageSettings);
  document.querySelector('#codexImageSettingsModal')?.addEventListener('click', (event) => { if (event.target.id === 'codexImageSettingsModal') closeCodexImageSettings(); });
  bindStoryboardGenerationEvents();
  document.querySelector('#closeCodexTextSettings')?.addEventListener('click', closeCodexTextSettings);
  document.querySelector('#codexTextSettingsModal')?.addEventListener('click', (event) => { if (event.target.id === 'codexTextSettingsModal') closeCodexTextSettings(); });
  document.querySelector('#refreshCodexTextStatus')?.addEventListener('click', () => refreshCodexTextStatus());
  document.querySelector('#chooseCodexTextCli')?.addEventListener('click', () => refreshCodexTextStatus({ choose: true }));
  document.querySelector('#refreshCodexImageStatus')?.addEventListener('click', () => refreshCodexImageStatus());
  document.querySelector('#chooseCodexImageCli')?.addEventListener('click', () => refreshCodexImageStatus({ choose: true }));
  document.querySelector('#generateMissingCodexAssets')?.addEventListener('click', () => generateCodexImageAssets());
  document.querySelector('#stopCodexImages')?.addEventListener('click', () => { stopCurrentGeneration(); renderWithoutMovingPage(); showToast('已停止生图，已保存的参考图仍然保留'); });
  document.querySelectorAll('[data-generate-codex-asset-index]').forEach((button) => button.addEventListener('click', () => generateCodexImageAssets([Number(button.dataset.generateCodexAssetIndex)])));
  document.querySelector('#heroSeedanceStatus').addEventListener('click', openSeedanceSettings);
  document.querySelector('#closeSettings').addEventListener('click', closeModelSettings);
  document.querySelector('#settingsModal').addEventListener('click', (event) => { if (event.target.id === 'settingsModal') closeModelSettings(); });
  document.querySelector('#saveDeepSeek').addEventListener('click', saveDeepSeekSettings);
  document.querySelector('#testDeepSeek').addEventListener('click', testDeepSeekConnection);
  document.querySelector('#closeImageSettings')?.addEventListener('click', closeImageSettings);
  document.querySelector('#imageSettingsModal')?.addEventListener('click', (event) => { if (event.target.id === 'imageSettingsModal') closeImageSettings(); });
  document.querySelectorAll('[data-image-provider]').forEach((button) => button.addEventListener('click', () => selectImageProviderDraft(button.dataset.imageProvider)));
  document.querySelector('#saveImageProvider')?.addEventListener('click', saveImageSettings);
  document.querySelector('#testImageProvider')?.addEventListener('click', testImageConnection);
  document.querySelector('#closeSeedanceSettings').addEventListener('click', closeSeedanceSettings);
  document.querySelector('#seedanceSettingsModal').addEventListener('click', (event) => { if (event.target.id === 'seedanceSettingsModal') closeSeedanceSettings(); });
  document.querySelector('#saveSeedance').addEventListener('click', saveSeedanceSettings);
  document.querySelector('#testSeedance').addEventListener('click', testSeedanceConnection);
  document.querySelector('#seedanceVideoProvider').addEventListener('change', (event) => { if (event.target.value === 'comfy') { closeSeedanceSettings(); openComfyVideoSettings(); } });
  document.querySelector('#comfyVideoProvider').addEventListener('change', (event) => { if (event.target.value === 'seedance') { closeComfyVideoSettings(); openSeedanceSettings(true); } });
  document.querySelector('#closeComfyVideoSettings').addEventListener('click', closeComfyVideoSettings);
  document.querySelector('#comfyVideoSettingsModal').addEventListener('click', event => { if (event.target.id === 'comfyVideoSettingsModal') closeComfyVideoSettings(); });
  document.querySelector('#saveComfyVideo').addEventListener('click', saveComfyVideoSettings);
  document.querySelector('#testComfyVideo').addEventListener('click', testComfyVideoConnection);
  document.querySelectorAll('[data-seedance-generation-mode]').forEach((button) => button.addEventListener('click', () => selectSeedanceGenerationModeDraft(button.dataset.seedanceGenerationMode)));
  document.querySelector('#configureSeedance')?.addEventListener('click', openSeedanceSettings);
  document.querySelector('#confirmLocalAssets')?.addEventListener('click', confirmLocalAssets);
  document.querySelector('#addCustomAsset')?.addEventListener('click', () => openCustomAssetModal(null));
  document.querySelector('#closeCustomAsset')?.addEventListener('click', closeCustomAssetModal);
  document.querySelector('#cancelCustomAsset')?.addEventListener('click', closeCustomAssetModal);
  document.querySelector('#customAssetModal')?.addEventListener('click', (event) => { if (event.target.id === 'customAssetModal') closeCustomAssetModal(); });
  document.querySelector('#createCustomAsset')?.addEventListener('click', createCustomAsset);
  document.querySelector('#closePortraitCertification')?.addEventListener('click', closePortraitCertificationModal);
  document.querySelector('#cancelPortraitCertification')?.addEventListener('click', closePortraitCertificationModal);
  document.querySelector('#portraitCertificationModal')?.addEventListener('click', (event) => { if (event.target.id === 'portraitCertificationModal') closePortraitCertificationModal(); });
  document.querySelector('#savePortraitCertification')?.addEventListener('click', savePortraitCertificationAndResume);
  document.querySelectorAll('[data-open-portrait-certification]').forEach((button) => button.addEventListener('click', openPortraitCertificationModal));
  document.querySelector('#openAssetFolder')?.addEventListener('click', openAssetOutputFolder);
  document.querySelectorAll('[data-upload-local-asset-index]').forEach((button) => button.addEventListener('click', () => selectLocalAssetImages(Number(button.dataset.uploadLocalAssetIndex))));
  document.querySelectorAll('[data-clear-local-asset-index]').forEach((button) => button.addEventListener('click', () => clearLocalAssetImages(Number(button.dataset.clearLocalAssetIndex))));
  document.querySelectorAll('[data-remove-custom-asset-index]').forEach((button) => button.addEventListener('click', () => removeCustomAsset(Number(button.dataset.removeCustomAssetIndex))));
  document.querySelectorAll('[data-show-local-asset-index]').forEach((button) => button.addEventListener('click', () => showLocalAssetImage(Number(button.dataset.showLocalAssetIndex), Number(button.dataset.showLocalFileIndex))));
  document.querySelector('#generateNextVideo')?.addEventListener('click', () => {
    const prompts = project.outputs.storyboard?.prompts || [];
    const state = alignVideoGenerationItems(prompts);
    const nextIndex = state.items.findIndex((item) => item.status !== 'success');
    if (nextIndex >= 0) generateSeedanceVideos({ token: ++generationRun, indexes: [nextIndex], mode: 'confirm' });
  });
  document.querySelector('#generateAllVideos')?.addEventListener('click', () => generateSeedanceVideos({ token: ++generationRun, mode: 'batch' }));
  document.querySelector('#openVideoFolder')?.addEventListener('click', openVideoOutputFolder);
  document.querySelectorAll('[data-show-video-index]').forEach((button) => button.addEventListener('click', () => showGeneratedVideo(Number(button.dataset.showVideoIndex))));
  document.querySelectorAll('[data-generate-video-index]').forEach((button) => button.addEventListener('click', () => regenerateVideoShot(Number(button.dataset.generateVideoIndex))));
  document.querySelectorAll('[data-select-video-version-index]').forEach((button) => button.addEventListener('click', () => selectVideoVersion(Number(button.dataset.selectVideoVersionIndex), button.dataset.videoVersionId)));
  bindVideoNavigationEvents();
  document.querySelectorAll('[data-add-existing-video-reference]').forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.dataset.addExistingVideoReference);
    const value = document.querySelector(`[data-new-reference-asset="${index}"]`)?.value;
    if (value !== undefined && value !== '') addVideoReference(index, Number(value));
  }));
  document.querySelectorAll('[data-upload-video-reference]').forEach((button) => button.addEventListener('click', () => openCustomAssetModal(Number(button.dataset.uploadVideoReference))));
  document.querySelectorAll('[data-remove-video-reference-shot]').forEach((button) => button.addEventListener('click', () => removeVideoReference(Number(button.dataset.removeVideoReferenceShot), Number(button.dataset.removeVideoReferenceNumber))));
  document.querySelectorAll('[data-video-prompt-index]').forEach((textarea) => {
    const index = Number(textarea.dataset.videoPromptIndex);
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(190, textarea.scrollHeight)}px`;
    };
    resize();
    textarea.addEventListener('input', () => {
      const prompts = project.outputs.storyboard?.prompts || [];
      const state = alignVideoGenerationItems(prompts);
      const item = state.items[index];
      if (!item || !prompts[index]) return;
      const originalPrompt = String(prompts[index]);
      const edited = textarea.value !== originalPrompt;
      if (edited) {
        item.promptOverride = textarea.value;
        item.promptEditedAt = new Date().toISOString();
      } else {
        delete item.promptOverride;
        delete item.promptEditedAt;
      }
      if (!['creating', 'queued', 'running', 'downloading'].includes(item.status)) {
        item.status = 'pending';
        item.taskId = '';
        item.error = '';
      }
      state.status = 'pending';
      state.generatedCount = state.items.filter((videoItem) => getSelectedVideoVersion(videoItem)).length;
      project.completed = project.completed.filter((id) => id !== 'video');
      saveProject();
      const status = document.querySelector(`[data-video-prompt-status="${index}"]`);
      if (status) {
        status.textContent = edited ? '已修改 · 自动保存' : '原始提示词 · 自动保存';
        status.classList.toggle('edited', edited);
      }
      const resetButton = document.querySelector(`[data-reset-video-prompt-index="${index}"]`);
      if (resetButton) resetButton.disabled = !edited;
      const card = textarea.closest('.video-clip-card');
      const taskStatus = card?.querySelector('.video-task-status');
      if (taskStatus) {
        taskStatus.textContent = '待生成';
        taskStatus.className = 'video-task-status pending';
      }
      card?.querySelector('.video-task-error')?.remove();
      const placeholder = card?.querySelector('.video-clip-placeholder');
      if (placeholder) {
        placeholder.className = 'video-clip-placeholder pending';
        const placeholderLabel = placeholder.querySelector('b');
        if (placeholderLabel) placeholderLabel.textContent = '待生成';
      }
      const generateButton = card?.querySelector('[data-generate-video-index]');
      if (generateButton) generateButton.textContent = '生成此镜头';
      const nextIndex = state.items.findIndex((videoItem) => videoItem.status !== 'success');
      const nextButton = document.querySelector('#generateNextVideo');
      if (nextButton && nextIndex >= 0) {
        nextButton.disabled = false;
        nextButton.textContent = `生成下一个镜头 ${String(nextIndex + 1).padStart(2, '0')}`;
      }
      const batchButton = document.querySelector('#generateAllVideos');
      if (batchButton) {
        batchButton.disabled = false;
        batchButton.textContent = state.generatedCount ? '批量继续生成' : '批量生成全部视频';
      }
      resize();
    });
    textarea.addEventListener('change', () => {
      const scrollPositions = capturePageScrollPositions();
      renderWithoutMovingPage(scrollPositions);
    });
  });
  document.querySelectorAll('[data-video-reference-shot]').forEach(select => select.addEventListener('change', () => {
    const [assetItemIndex, fileIndex] = String(select.value || '').split(':').map(Number);
    selectVideoReference(Number(select.dataset.videoReferenceShot), Number(select.dataset.videoReferenceNumber), assetItemIndex, fileIndex);
  }));
  document.querySelectorAll('[data-reset-video-prompt-index]').forEach((button) => button.addEventListener('click', () => {
    const scrollPositions = capturePageScrollPositions();
    const index = Number(button.dataset.resetVideoPromptIndex);
    const prompts = project.outputs.storyboard?.prompts || [];
    const state = alignVideoGenerationItems(prompts);
    const item = state.items[index];
    const textarea = document.querySelector(`[data-video-prompt-index="${index}"]`);
    if (!item || !textarea || !prompts[index]) return;
    const shot = project.outputs.storyboard?.shots?.[index];
    const addedNames = new Set((Array.isArray(shot?.uploads) ? shot.uploads : [])
      .filter((upload) => upload?.addedInVideoStep)
      .map((upload) => String(upload?.asset || '')));
    if (shot) shot.uploads = Array.isArray(item.originalReferenceUploads) ? structuredClone(item.originalReferenceUploads) : (shot.uploads || []).filter(upload => !upload?.addedInVideoStep);
    if (addedNames.size) {
      item.referenceBindings = Object.fromEntries(Object.entries(item.referenceBindings || {}).filter(([key, binding]) => !addedNames.has(binding?.assetName) && !addedNames.has(key.replace(/^asset:/, ''))));
    }
    delete item.promptOverride;
    delete item.promptEditedAt;
    item.status = 'pending';
    item.taskId = '';
    item.error = '';
    state.status = 'pending';
    state.generatedCount = state.items.filter((videoItem) => getSelectedVideoVersion(videoItem)).length;
    project.completed = project.completed.filter((id) => id !== 'video');
    saveProject();
    renderWithoutMovingPage(scrollPositions);
    showToast(`镜头 ${String(index + 1).padStart(2, '0')} 已恢复原始提示词`);
  }));
  document.querySelectorAll('.copy-shot').forEach((button) => button.addEventListener('click', () => {
    const prompt = project.outputs.storyboard?.prompts?.[Number(button.dataset.shotIndex)];
    const suffix = project.outputs.storyboard?.unifiedSuffix || '';
    if (prompt) copyText(`${prompt}${suffix ? `\n\n统一附加词：\n${suffix}` : ''}`, `镜头 ${Number(button.dataset.shotIndex) + 1} 提示词已复制`);
  }));
  document.querySelector('#copyAllSeedance')?.addEventListener('click', () => {
    const prompts = project.outputs.storyboard?.prompts || [];
    const suffix = project.outputs.storyboard?.unifiedSuffix || '';
    if (prompts.length) copyText(storyboardUsesSkill21() ? prompts.join('\n\n') : `${suffix ? `【统一附加词】\n${suffix}\n\n` : ''}${prompts.map((prompt, index) => `【镜头${String(index + 1).padStart(2, '0')}】\n${prompt}`).join('\n\n')}`, '全部分镜提示词已复制');
  });
  document.querySelector('#copyUnifiedSuffix')?.addEventListener('click', () => {
    const suffix = project.outputs.storyboard?.unifiedSuffix;
    if (suffix) copyText(suffix, '统一附加词已复制');
  });
  document.querySelectorAll('.copy-asset-prompt').forEach((button) => button.addEventListener('click', () => {
    const item = project.outputs.assets?.promptItems?.[Number(button.dataset.assetPromptIndex)];
    if (item?.prompt) copyText(item.prompt, `${item.name || '参考图'}提示词已复制`);
  }));
  document.querySelector('#copyAllAssetPrompts')?.addEventListener('click', () => {
    const items = project.outputs.assets?.promptItems || [];
    if (!items.length) return showToast('当前没有可复制的参考图提示词');
    copyText(items.map((item) => `【${item.type}｜${item.name}】\n文件名：${item.fileName}\n${item.prompt}`).join('\n\n'), '全部参考图提示词已复制');
  });
  document.querySelectorAll('.material-count').forEach((input) => {
    input.disabled = project.running;
    const updateMaterials = () => {
    if (project.running) return;
    const maxes = { images: 9, videos: 3, audios: 3 };
    const min = Number(input.dataset.min || input.min || 0);
    const max = maxes[input.dataset.material];
    const value = Math.max(min, Math.min(max, Number(input.value) || 0));
    project.seedanceMaterials = { images: min, videos: 0, audios: 0, ...(project.seedanceMaterials || {}), [input.dataset.material]: value };
    project.outputs.storyboard = makeSeedanceStoryboard(project.script);
    saveProject(); render();
    };
    input.addEventListener('change', updateMaterials);
    input.addEventListener('input', () => {
      window.clearTimeout(input._materialTimer);
      input._materialTimer = window.setTimeout(updateMaterials, 250);
    });
  });
}

function stopCurrentGeneration() {
  generationSkillImportSequence += 1;
  generationSkillImport = null;
  generationSkillPreview = null;
  generationRun += 1;
  const stoppedPipeline = autoPipelineRun;
  if (stoppedPipeline) {
    stoppedPipeline.ownerProject.autoPipeline = { ...stoppedPipeline.ownerProject.autoPipeline, status: 'stopped', error: '已停止后续生成，已完成的成果仍保留。', finishedAt: Date.now() };
    stoppedPipeline.ownerProject.running = false;
    autoPipelineRun = null;
  }
  const stoppedWorkflow = workflowRun;
  if (workflowRun) {
    if (workflowRun.generation?.provider === 'codex-subscription' && window.storyforgeAI?.cancelWorkflow) {
      Promise.resolve(window.storyforgeAI.cancelWorkflow({ runId: workflowRun.runId, projectId: workflowRun.projectId })).catch(() => { /* Run guards also reject any late response. */ });
    }
    workflowRun.ownerProject.running = false;
    workflowRun.ownerProject.workflowProgress = finishWorkflowProgress(workflowRun.ownerProject.workflowProgress, 'stopped');
    releaseWorkflowProgress(workflowRun);
    persistWorkflowProgress(workflowRun.ownerProject);
    workflowRun = null;
  }
  const run = codexImageRun;
  if (run) {
    codexImageRun = null;
    if (run.jobId && window.storyforgeAI?.cancelCodexImage) {
      Promise.resolve(window.storyforgeAI.cancelCodexImage(run.jobId)).catch(() => { /* Late results are also rejected by the run guard. */ });
    }
    const state = run.ownerProject.assetGeneration;
    state?.items?.forEach((item) => {
      if (item.status === 'generating') item.status = item.files?.length ? 'success' : 'pending';
    });
    run.ownerProject.running = false;
  }
  const videoState = project.videoGeneration;
  if (videoState?.status === 'running') {
    videoState.items = (videoState.items || []).map((savedItem) => {
      const item = normalizeVideoItemVersions(savedItem);
      if (['creating', 'queued', 'running', 'downloading'].includes(item.status)) {
        const resumable = item.taskProvider === 'comfy' && item.taskId;
        item.status = resumable ? 'pending' : getSelectedVideoVersion(item) ? 'success' : 'pending';
        if (!resumable) item.taskId = '';
      }
      return item;
    });
    videoState.generatedCount = videoState.items.filter((item) => getSelectedVideoVersion(item)).length;
    const allSaved = videoState.items.length > 0 && videoState.generatedCount === videoState.items.length && videoState.items.every(item => item.status === 'success');
    videoState.status = allSaved ? 'complete' : 'pending';
    if (allSaved && !project.completed.includes('video')) project.completed.push('video');
  }
  if (!project.running && !run && !stoppedWorkflow && !stoppedPipeline) return;
  project.running = false;
  saveProject();
}

function createNewProject() {
  clearResultRequest = null;
  stopCurrentGeneration();
  const newProject = createProject();
  projectLibrary.projects.push(newProject);
  projectLibrary.activeProjectId = newProject.id;
  project = newProject;
  saveProjectLibrary();
  render();
  showToast('已新建项目，之前的项目仍保留在左侧');
}

function switchProject(projectId) {
  if (!projectId || projectId === project.id) return;
  clearResultRequest = null;
  stopCurrentGeneration();
  const nextProject = projectLibrary.projects.find((item) => item.id === projectId);
  if (!nextProject) return showToast('没有找到这个项目');
  projectLibrary.activeProjectId = nextProject.id;
  project = nextProject;
  saveProjectLibrary();
  render();
  showToast(`已切换到：${project.title}`);
}

function deleteProject(projectId) {
  const target = projectLibrary.projects.find((item) => item.id === projectId);
  if (!target || projectLibrary.projects.length <= 1) return;
  if (!window.confirm(`确定删除“${target.title}”吗？此操作无法撤销。`)) return;
  if (target.id === project.id) stopCurrentGeneration();
  projectLibrary.projects = projectLibrary.projects.filter((item) => item.id !== projectId);
  if (target.id === project.id) {
    project = projectLibrary.projects[0];
    projectLibrary.activeProjectId = project.id;
  }
  saveProjectLibrary();
  render();
  showToast(`已删除项目：${target.title}`);
}

function openModelSettings() { document.querySelector('#settingsModal').hidden = false; document.querySelector('#deepseekKey').focus(); }
function closeModelSettings() { document.querySelector('#settingsModal').hidden = true; }
function openImageSettings() {
  if (!IMAGE_MODEL_GENERATION_ENABLED) return openCodexImageSettings();
  imageProviderDraft = imageProvider;
  const modal = document.querySelector('#imageSettingsModal');
  modal.hidden = false;
  selectImageProviderDraft(imageProviderDraft);
}

function configureAutomaticSeedanceDurationField() {
  const select = document.querySelector('#seedanceDuration');
  const field = select?.closest('.key-field');
  if (!select || !field) return;
  const title = field.querySelector(':scope > span');
  const help = field.querySelector(':scope > small');
  if (title) title.textContent = '镜头时长';
  if (help) help.textContent = '自动读取第二步每个分镜的时长；无有效标注时内部使用 5 秒。';
  const display = document.createElement('div');
  display.className = 'automatic-duration-display';
  display.innerHTML = '<b>按分镜自动</b><span>4-15 秒</span>';
  select.replaceWith(display);
}
function closeImageSettings() { document.querySelector('#imageSettingsModal').hidden = true; }
function openSeedanceSettings(forceSeedance = false) {
  if (project.running) return showToast('请先停止提交或等待当前任务结束后再修改连接。');
  if (forceSeedance !== true && activeVideoProvider() === 'comfy') return openComfyVideoSettings();
  seedanceGenerationModeDraft = normalizeSeedanceGenerationMode(seedanceStatus.generationMode);
  const modal = document.querySelector('#seedanceSettingsModal');
  modal.hidden = false;
  selectSeedanceGenerationModeDraft(seedanceGenerationModeDraft);
  document.querySelector('#seedanceVideoProvider').value = 'seedance';
  document.querySelector('#seedanceKey')?.focus();
}
function closeSeedanceSettings() { document.querySelector('#seedanceSettingsModal').hidden = true; }

function selectSeedanceGenerationModeDraft(mode) {
  seedanceGenerationModeDraft = normalizeSeedanceGenerationMode(mode);
  document.querySelectorAll('[data-seedance-generation-mode]').forEach((button) => {
    const active = button.dataset.seedanceGenerationMode === seedanceGenerationModeDraft;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  setSeedanceMessage('');
}

function selectImageProviderDraft(provider) {
  imageProviderDraft = provider === 'openai' ? 'openai' : 'seedream';
  document.querySelectorAll('[data-image-provider]').forEach((button) => {
    const active = button.dataset.imageProvider === imageProviderDraft;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-provider-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.providerPanel !== imageProviderDraft;
  });
  setImageMessage('');
  document.querySelector(imageProviderDraft === 'openai' ? '#openAIImageKey' : '#seedreamKey')?.focus();
}

function setModelMessage(message, type = '') {
  const node = document.querySelector('#modelMessage');
  node.textContent = message; node.className = `modal-message ${type}`;
}

async function saveDeepSeekSettings() {
  const apiKey = document.querySelector('#deepseekKey').value.trim();
  if (!apiKey) return setModelMessage('请输入 DeepSeek API Key。', 'error');
  setModelMessage('正在安全保存…');
  try {
    const status = await window.storyforgeAI.saveKey(apiKey);
    deepseekStatus = { ...status, checking: false };
    setModelMessage('已使用 Windows 加密保存。', 'success');
    window.setTimeout(() => { closeModelSettings(); render(); showToast('DeepSeek V4.1 Flash 已配置'); }, 500);
  } catch (error) { setModelMessage(error.message || '保存失败。', 'error'); }
}

async function testDeepSeekConnection() {
  const apiKey = document.querySelector('#deepseekKey').value.trim();
  setModelMessage('正在连接 DeepSeek V4.1 Flash…');
  try {
    await window.storyforgeAI.testConnection(apiKey);
    setModelMessage('连接成功，DeepSeek V4.1 Flash 可用。', 'success');
  } catch (error) { setModelMessage(error.message || '连接失败。', 'error'); }
}

async function refreshDeepSeekStatus() {
  if (!window.storyforgeAI) {
    deepseekStatus = { configured: false, model: 'deepseek-flash', checking: false };
    render(); return;
  }
  try { deepseekStatus = { ...(await window.storyforgeAI.getStatus()), checking: false }; }
  catch { deepseekStatus = { configured: false, model: 'deepseek-flash', checking: false }; }
  render();
}

function setImageMessage(message, type = '') {
  const node = document.querySelector('#imageMessage');
  if (!node) return;
  node.textContent = message;
  node.className = `modal-message ${type}`;
}

async function saveImageSettings() {
  if (!IMAGE_MODEL_GENERATION_ENABLED) return setImageMessage('第三步模型生图已暂停，请直接上传本地参考图。', 'error');
  const provider = imageProviderDraft;
  setImageMessage('正在使用 Windows 安全保存…');
  try {
    if (provider === 'openai') {
      const apiKey = document.querySelector('#openAIImageKey').value.trim();
      const size = document.querySelector('#openAIImageSize').value;
      const quality = document.querySelector('#openAIImageQuality').value;
      if (!apiKey && !openAIImageStatus.configured) return setImageMessage('请输入 OpenAI API Key。', 'error');
      const status = await window.storyforgeAI.saveOpenAIImageSettings({ apiKey, size, quality });
      openAIImageStatus = { ...openAIImageStatus, ...status, checking: false };
    } else {
      const apiKey = document.querySelector('#seedreamKey').value.trim();
      const model = document.querySelector('#seedreamModel').value;
      const size = document.querySelector('#seedreamSize').value;
      if (!apiKey && !seedreamStatus.configured) return setImageMessage('请输入火山方舟 API Key。', 'error');
      const status = await window.storyforgeAI.saveSeedreamSettings({ apiKey, model, size });
      seedreamStatus = { ...seedreamStatus, ...status, checking: false };
    }
    saveImageProvider(provider);
    setImageMessage(`${imageProviderLabel(provider)} 设置已安全保存。`, 'success');
    const shouldResume = project.activeStep === 'assets'
      && project.outputs.assets?.promptItems?.length
      && !project.completed.includes('assets')
      && !project.running;
    window.setTimeout(() => {
      closeImageSettings();
      render();
      showToast(`${imageProviderLabel(provider)} 已配置为第三步生图模型`);
      if (shouldResume) generateImageAssets({ token: ++generationRun, autoAdvance: true });
    }, 450);
  } catch (error) { setImageMessage(cleanRemoteError(error, '保存失败。'), 'error'); }
}

async function testImageConnection() {
  if (!IMAGE_MODEL_GENERATION_ENABLED) return setImageMessage('第三步模型生图已暂停。', 'error');
  const provider = imageProviderDraft;
  const apiKey = document.querySelector(provider === 'openai' ? '#openAIImageKey' : '#seedreamKey').value.trim();
  setImageMessage(`正在验证${provider === 'openai' ? ' OpenAI' : '火山方舟'} API Key，不会生成图片或产生生图费用…`);
  try {
    if (provider === 'openai') await window.storyforgeAI.testOpenAIImageConnection(apiKey);
    else await window.storyforgeAI.testSeedreamConnection(apiKey);
    setImageMessage(provider === 'openai' ? '连接成功，GPT Image 2 可用。' : 'API Key 有效。所选 Seedream 模型会在首次生图时验证。', 'success');
  } catch (error) { setImageMessage(cleanRemoteError(error, '连接失败。'), 'error'); }
}

async function refreshSeedreamStatus() {
  if (!window.storyforgeAI) {
    seedreamStatus = { configured: false, model: SEEDREAM_DEFAULT_MODEL, size: SEEDREAM_DEFAULT_SIZE, models: SEEDREAM_MODELS, checking: false };
    render(); return;
  }
  try { seedreamStatus = { ...seedreamStatus, ...(await window.storyforgeAI.getSeedreamStatus()), checking: false }; }
  catch { seedreamStatus = { configured: false, model: SEEDREAM_DEFAULT_MODEL, size: SEEDREAM_DEFAULT_SIZE, models: SEEDREAM_MODELS, checking: false }; }
  render();
}

async function refreshOpenAIImageStatus() {
  if (!window.storyforgeAI) {
    openAIImageStatus = { configured: false, model: OPENAI_IMAGE_MODEL, size: OPENAI_IMAGE_DEFAULT_SIZE, quality: OPENAI_IMAGE_DEFAULT_QUALITY, sizes: OPENAI_IMAGE_SIZES, qualities: OPENAI_IMAGE_QUALITIES, checking: false };
    render(); return;
  }
  try { openAIImageStatus = { ...openAIImageStatus, ...(await window.storyforgeAI.getOpenAIImageStatus()), checking: false }; }
  catch { openAIImageStatus = { configured: false, model: OPENAI_IMAGE_MODEL, size: OPENAI_IMAGE_DEFAULT_SIZE, quality: OPENAI_IMAGE_DEFAULT_QUALITY, sizes: OPENAI_IMAGE_SIZES, qualities: OPENAI_IMAGE_QUALITIES, checking: false }; }
  render();
}

function setSeedanceMessage(message, type = '') {
  const node = document.querySelector('#seedanceMessage');
  if (!node) return;
  node.textContent = message;
  node.className = `modal-message ${type}`;
}

function openComfyVideoSettings() {
  if (project.running) return showToast('请先停止提交或等待当前任务结束。');
  document.querySelector('#comfyVideoSettingsModal').hidden = false;
  document.querySelector('#comfyVideoProvider').value = 'comfy';
}
function closeComfyVideoSettings() { document.querySelector('#comfyVideoSettingsModal').hidden = true; }
function setComfyVideoMessage(text, type = '') {
  const node = document.querySelector('#comfyVideoMessage');
  node.textContent = text; node.className = `modal-message ${type}`;
}
async function testComfyVideoConnection() {
  setComfyVideoMessage('正在检查 ComfyUI 节点和 H3 模型文件，不会提交生成任务…');
  try {
    const result = await window.storyforgeAI.testComfyVideoConnection(readComfyVideoSettings(document));
    for (const key of ['model', 'clipModel', 'videoVae', 'audioVae']) document.querySelector(`#comfy-${key}`).value = result[key];
    setComfyVideoMessage('连接正常，Ref2VA、文本编码器和音视频 VAE 已找到。', 'success');
  } catch (error) { setComfyVideoMessage(cleanRemoteError(error, '连接失败。'), 'error'); }
}
async function saveComfyVideoSettings() {
  if (project.running) return;
  const owner = project;
  try {
    const settings = readComfyVideoSettings(document);
    comfyVideoStatus = { ...comfyVideoStatus, ...(await window.storyforgeAI.saveComfyVideoSettings(settings)) };
    if (project !== owner) return;
    Object.assign(project.videoGeneration, { provider: 'comfy', model: comfyVideoStatus.model || 'MiniMax-H3-Base-Ref2VA', ratio: comfyVideoStatus.ratio, resolution: comfyVideoStatus.resolution, duration: 5, generationMode: comfyVideoStatus.generationMode, generateAudio: comfyVideoStatus.generateAudio, pendingCertification: null });
    saveProject(); closeComfyVideoSettings(); render(); showToast('视频生成已切换为仙宫云 H3');
  } catch (error) { setComfyVideoMessage(cleanRemoteError(error, '保存失败。'), 'error'); }
}
async function refreshComfyVideoStatus() {
  if (!window.storyforgeAI?.getComfyVideoStatus) return;
  try { comfyVideoStatus = { ...comfyVideoStatus, ...(await window.storyforgeAI.getComfyVideoStatus()) }; }
  catch { comfyVideoStatus.configured = false; }
  render();
}

async function saveSeedanceSettings() {
  const apiKey = document.querySelector('#seedanceKey').value.trim();
  const settings = {
    apiKey,
    model: document.querySelector('#seedanceModel').value,
    ratio: document.querySelector('#seedanceRatio').value,
    resolution: document.querySelector('#seedanceResolution').value,
    duration: Number(seedanceStatus.duration || SEEDANCE_DEFAULT_DURATION),
    generationMode: seedanceGenerationModeDraft,
    generateAudio: document.querySelector('#seedanceGenerateAudio').checked,
  };
  if (!apiKey && !seedanceStatus.configured) return setSeedanceMessage('请输入火山方舟 API Key。', 'error');
  setSeedanceMessage('正在使用 Windows 安全保存…');
  try {
    seedanceStatus = { ...seedanceStatus, ...(await window.storyforgeAI.saveSeedanceSettings(settings)), checking: false };
    Object.assign(project.videoGeneration, { provider: 'seedance', model: seedanceStatus.model, ratio: seedanceStatus.ratio, resolution: seedanceStatus.resolution, generationMode: seedanceStatus.generationMode });
    saveProject();
    setSeedanceMessage('Seedance 设置已安全保存。', 'success');
    window.setTimeout(() => {
      closeSeedanceSettings();
      render();
      showToast(`${seedanceModelLabel()} 已配置为第四步视频模型`);
    }, 450);
  } catch (error) { setSeedanceMessage(cleanRemoteError(error, '保存失败。'), 'error'); }
}

async function testSeedanceConnection() {
  const apiKey = document.querySelector('#seedanceKey').value.trim();
  setSeedanceMessage('正在验证火山方舟 API Key，不会创建视频任务或产生视频费用…');
  try {
    await window.storyforgeAI.testSeedanceConnection(apiKey);
    setSeedanceMessage('API Key 有效。所选 Seedance 模型会在首次生成时验证权限。', 'success');
  } catch (error) { setSeedanceMessage(cleanRemoteError(error, '连接失败。'), 'error'); }
}

async function refreshSeedanceStatus() {
  if (!window.storyforgeAI) {
    seedanceStatus = { ...seedanceStatus, configured: false, checking: false };
    render(); return;
  }
  try { seedanceStatus = { ...seedanceStatus, ...(await window.storyforgeAI.getSeedanceStatus()), checking: false }; }
  catch { seedanceStatus = { ...seedanceStatus, configured: false, checking: false }; }
  render();
}

function storyboardIgnoredNotice() {
  return '<div class="storyboard-ignored-notice" role="status"><b>审计未通过，已按设置忽略并继续</b><span>已自动回炉一次，仍未通过的审计项已保留。可继续生成参考图和视频；具体问题见第二步下方的审计结果。</span></div>';
}

function storyboardAuditTemplate(summary) {
  if (!summary) return '';
  const partial = summary.finalStatus === '部分通过（存在阻塞）';
  const ignored = summary.finalStatus === '审计未通过（已忽略）';
  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  const blockers = Array.isArray(summary.blockers) ? summary.blockers : [];
  const issues = Array.isArray(summary.issues) ? summary.issues : [];
  const basis = summary.auditBasis === '用户 Skill' ? `审计依据：用户 Skill · ${esc(String(summary.skillName || '上传规范'))}` : `审计版本：v${esc(String(summary.version || '2.1'))}`;
  const repairCount = Number.isInteger(summary.repairCount) && summary.repairCount >= 0 ? summary.repairCount : 0;
  const blockerBody = blockers.length ? blockers.map((blocker) => {
    const blockNos = Array.isArray(blocker.affectedBlockNos) ? blocker.affectedBlockNos.join('、') : String(blocker.affectedBlockNos || '');
    const missing = Array.isArray(blocker.missingInformation) ? blocker.missingInformation.join('；') : String(blocker.missingInformation || '');
    return `<div class="storyboard-audit-blocker"><b>${esc(String(blocker.id || '阻塞'))}${blockNos ? ` · 受阻生成块 ${esc(blockNos)}` : ''}</b><p>${esc(String(blocker.reason || ''))}</p>${missing ? `<p>缺少信息：${esc(missing)}</p>` : ''}${blocker.question ? `<p>需要确认：${esc(String(blocker.question))}</p>` : ''}</div>`;
  }).join('') : '<p class="storyboard-audit-no-blockers">需要用户处理的阻塞：无</p>';
  const issueBody = issues.length ? `<details class="storyboard-audit-issues"><summary>${ignored ? '已忽略的审计问题' : '审计问题'}（${issues.length} 项）</summary><ul>${issues.map((issue) => `<li>${issue.blockNo ? `<b>生成块 ${esc(String(issue.blockNo))}</b> · ` : ''}${issue.ruleId || issue.code ? `<code>${esc(String(issue.ruleId || issue.code))}</code> · ` : ''}${esc(String(issue.message || '审计项未通过'))}</li>`).join('')}</ul></details>` : '';
  return `<section class="storyboard-audit ${ignored ? 'ignored' : partial ? 'partial' : 'passed'}" aria-label="审计结果"><div class="storyboard-audit-head"><h4>审计结果</h4><b>${esc(String(summary.finalStatus || '未通过'))}</b></div><div class="storyboard-audit-meta"><span>${basis}</span><span>本次范围：${esc(String(summary.range || ''))}</span><span>自动回炉：${repairCount} 次</span></div><div class="storyboard-audit-rows">${rows.map((row) => `<div><span>${esc(String(row.label || ''))}</span><b class="${row.status === '通过' ? 'passed' : row.status === '阻塞' || row.status === '失败' || row.status === '未通过' ? 'blocked' : ''}">${esc(String(row.status || ''))}</b></div>`).join('')}</div>${issueBody}${blockerBody}<small>审计范围：文本与计划。视频生成、配音执行和成片效果尚未经实际验证。</small></section>`;
}

function renderAIWorkflow(data, usage, model, generation = {}) {
  const provider = generation.provider || (String(model || 'deepseek-flash').startsWith('deepseek') ? 'deepseek' : 'codex-subscription');
  const modelLabel = provider === 'codex-subscription' ? `GPT 订阅 · ${model || generation.model || 'GPT'}` : 'DeepSeek V4.1 Flash';
  if (!data || typeof data !== 'object' || !data.analysis || !data.storyboard || !data.assets) throw new Error(`${modelLabel} 返回的数据不完整，请重新生成。`);
  const analysis = data.analysis || {};
  const characters = Array.isArray(analysis.characters) ? analysis.characters : [];
  const sellingPoints = Array.isArray(analysis.sellingPoints) ? analysis.sellingPoints : [];
  const visualKeywords = Array.isArray(analysis.visualKeywords) ? analysis.visualKeywords : [];
  const storyboard = data.storyboard || {};
  const shots = Array.isArray(storyboard.shots) ? storyboard.shots.map((shot) => ({ ...shot })) : [];
  const skill21 = storyboardUsesSkill21(storyboard);
  const auditSummary = storyboard.auditSummary || null;
  const customSkill = storyboardUsesCustomSkill(storyboard);
  const partial = skill21 && auditSummary?.finalStatus === '部分通过（存在阻塞）';
  const auditIgnored = skill21 && auditSummary?.finalStatus === '审计未通过（已忽略）';
  const assets = data.assets || {};
  if ((!skill21 && !characters.length) || (!shots.length && !partial)) throw new Error(`${modelLabel} 返回的数据不完整，请重新生成。`);
  if (skill21 && (!auditSummary || !['全部通过', '部分通过（存在阻塞）', '审计未通过（已忽略）'].includes(auditSummary.finalStatus)
    || !Number.isInteger(auditSummary.repairCount) || auditSummary.repairCount < 0
    || !Array.isArray(auditSummary.rows) || !auditSummary.rows.length
    || (!auditIgnored && auditSummary.rows.some((row) => row.status === '失败' || row.status === '未通过'))
    || (partial && !auditSummary.blockers?.length))) {
    throw new Error(customSkill ? '分镜尚未通过用户 Skill 审计，已保留上次成果。' : '分镜尚未通过 Skill v2.1 审计，已保留上次成果。');
  }

  const analysisBody = `<div class="analysis-grid"><div><label>故事定位</label><strong>${esc(String(analysis.positioning || ''))}</strong><p>${esc(String(analysis.coreConflict || ''))}</p></div><div><label>主要人物</label><strong>${esc(characters.map((item) => item.name).join('、'))}</strong><p>${esc(characters.map((item) => `${item.name}：${item.identity || item.traits || ''}`).join('；'))}</p></div><div><label>核心卖点</label><div class="tags">${sellingPoints.map((item) => `<span>${esc(String(item))}</span>`).join('')}</div></div><div><label>视觉关键词</label><div class="tags">${visualKeywords.map((item) => `<span>${esc(String(item))}</span>`).join('')}</div></div></div><div class="callout"><b>${esc(modelLabel)}</b><span>${esc(String(analysis.coreConflict || '已完成故事结构分析。'))}</span></div>`;
  const unifiedSuffix = skill21 ? '' : String(storyboard.unifiedSuffix || '');
  const shotCards = shots.map((shot, index) => {
    const uploads = Array.isArray(shot.uploads) ? shot.uploads : [];
    const segments = Array.isArray(shot.segments) ? shot.segments : [];
    if (skill21 && !String(shot.prompt || '').trim()) throw new Error('审计后的生成块缺少正式提示词，已保留上次成果。');
    const prompt = String(shot.prompt || buildPromptFromShot(shot));
    shot.prompt = prompt;
    const durationText = formatDuration(shot.duration);
    return `<article class="seedance-shot ai-shot"><div class="shot-card-head"><div><span class="shot-number">${esc(String(shot.no || String(index + 1).padStart(2, '0')))}</span><div><h4>${esc(String(shot.title || `${skill21 ? '生成块' : '镜头'}${index + 1}`))}</h4><p>${esc(durationText)} · ${segments.length} 个实际镜头 · ${uploads.length}项上传素材</p></div></div><div class="shot-actions"><span>${esc(durationText)}</span><button class="copy-shot" data-shot-index="${index}">复制提示词</button></div></div>${uploads.length ? `<div class="upload-plan"><b>参考图：</b>${uploads.map((upload) => `<span><code>${esc(String(upload.ref || ''))}</code>${esc(String(upload.asset || ''))}：${esc(String(upload.purpose || ''))}</span>`).join('')}</div>` : ''}<div class="segment-list">${segments.map((segment) => `<div><b>${esc(String(segment.time || ''))}</b><span>${esc(String(segment.visual || ''))}</span></div>`).join('')}</div>${shot.sound ? `<div class="sound-line"><b>声音：</b>${esc(String(shot.sound))}</div>` : ''}<pre>${esc(prompt)}</pre></article>`;
  }).join('');
  const actualShotCount = shots.reduce((count, shot) => count + (Array.isArray(shot.segments) ? shot.segments.length : 0), 0);
  const storyboardBody = `${unifiedSuffix ? `<div class="unified-suffix"><div><b>统一附加词</b><span>复制镜头提示词时一并添加</span></div><p>${esc(unifiedSuffix)}</p><button id="copyUnifiedSuffix">复制统一附加词</button></div>` : ''}${auditIgnored ? storyboardIgnoredNotice() : ''}${partial ? '<div class="storyboard-partial-notice">仅交付已独立通过审计的生成块。受阻内容及依赖部分尚未交付，具体范围与缺少的信息见下方审计结果。</div>' : ''}<div class="prompt-toolbar"><div><b>${shots.length} 个${skill21 ? '生成块' : '镜头提示词'}${skill21 ? ` · ${actualShotCount} 个实际镜头` : ''}</b><span>${skill21 ? customSkill ? `用户 Skill · ${esc(String(auditSummary.skillName || '上传规范'))}${auditIgnored ? ' · 审计失败已忽略' : ' · 按本次上传规范执行'}` : auditIgnored ? 'Skill v2.1 · 审计未通过，已按设置继续' : 'Skill v2.1 · 每块不超过15秒、最多5镜 · 依自然节拍分块' : `由 ${esc(modelLabel)} 按剧情节拍、对白量和动作量设计`}</span></div><button id="copyAllSeedance" ${shots.length ? '' : 'disabled'}>复制全部提示词</button></div><div class="seedance-shots">${shotCards}</div>${skill21 ? storyboardAuditTemplate(auditSummary) : ''}`;
  const checklist = Array.isArray(assets.characterChecklist) ? assets.characterChecklist : [];
  const differenceMatrix = Array.isArray(assets.characterDifferenceMatrix) ? assets.characterDifferenceMatrix : [];
  const promptItems = [
    ...(Array.isArray(assets.characters) ? assets.characters.map((item) => ({ ...item, type: '人物参考图' })) : []),
    ...(Array.isArray(assets.scenes) ? assets.scenes.map((item) => ({ ...item, type: '场景参考图' })) : []),
    ...(Array.isArray(assets.groups) ? assets.groups.map((item) => ({ ...item, type: '群像参考图' })) : []),
    ...(Array.isArray(assets.props) ? assets.props.map((item) => ({ ...item, type: '道具参考图' })) : []),
  ].map((item, index) => ({ ...item, fileName: assetImageFileName(item.name, index), prompt: String(item.prompt || item.description || '') }));
  const checklistBody = checklist.length ? `<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">CAST CHECKLIST</span><h4>人物参考图清单</h4></div><span>${checklist.filter((item) => item.requiresReferenceImage ?? item.requiresTurnaround).length} 人需要独立参考图</span></div><div class="asset-checklist">${checklist.map((item) => { const required = item.requiresReferenceImage ?? item.requiresTurnaround; return `<div><b>${esc(String(item.name || ''))}</b><span>${esc(String(item.roleType || '人物'))}</span><div class="asset-flags"><i class="${item.speaks ? 'yes' : ''}">对白</i><i class="${item.drivesPlot ? 'yes' : ''}">推动剧情</i><i class="${item.recurring ? 'yes' : ''}">反复出现</i><i class="${item.needsCloseUp ? 'yes' : ''}">特写</i></div><em class="${required ? 'required' : ''}">${required ? '上传单人参考图' : '归入功能人物'}</em><small>${esc(String(item.reason || ''))}</small></div>`; }).join('')}</div></section>` : '';
  const matrixBody = differenceMatrix.length ? `<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">FACE DIFFERENCE MATRIX</span><h4>人物差异化视觉锚点</h4></div><span>防止角色同脸</span></div><div class="asset-matrix"><div class="asset-matrix-row header"><b>角色 / 脸谱</b><b>面部锚点</b><b>发型 / 体态</b><b>服装 / 排除项</b></div>${differenceMatrix.map((item) => `<div class="asset-matrix-row"><b>${esc(String(item.name || ''))}<small>${esc(String(item.faceCode || ''))} · ${esc(String(item.ageRange || item.ageImpression || ''))}</small></b><span>${esc([item.faceShape, item.eyeShape, item.brows, item.noseLips, item.jawCheekbones].filter(Boolean).join('；'))}</span><span>${esc([item.hair, item.bodyType].filter(Boolean).join('；'))}</span><span>${esc([item.clothingSilhouette, item.signatureAccessory, item.differentFrom].filter(Boolean).join('；'))}</span></div>`).join('')}</div></section>` : '';
  const promptCards = promptItems.map((item, index) => `<article class="asset-prompt-card"><div class="asset-prompt-head"><div><span>${esc(String(item.type))}</span><h4>${esc(String(item.name || '参考图'))}</h4><code>${esc(String(item.fileName || ''))}</code></div><button class="copy-asset-prompt" data-asset-prompt-index="${index}">复制提示词</button></div>${item.description ? `<p>${esc(String(item.description))}</p>` : ''}${Array.isArray(item.exclusions) && item.exclusions.length ? `<div class="asset-exclusions"><b>排除：</b>${item.exclusions.map((value) => `<span>${esc(String(value))}</span>`).join('')}</div>` : ''}${Array.isArray(item.spatialAnchors) && item.spatialAnchors.length ? `<div class="asset-exclusions anchors"><b>空间锚点：</b>${item.spatialAnchors.map((value) => `<span>${esc(String(value))}</span>`).join('')}</div>` : ''}<pre>${esc(item.prompt)}</pre></article>`).join('');
  const assetsBody = `${checklistBody}${matrixBody}<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">REFERENCE IMAGE PROMPTS</span><h4>参考图生成提示词</h4></div><button id="copyAllAssetPrompts">复制全部提示词</button></div><div class="asset-prompt-list">${promptCards}</div></section>`;
  const usageText = usage ? `输入 ${usage.prompt_tokens || 0} · 输出 ${usage.completion_tokens || 0} tokens${provider === 'codex-subscription' ? ' · 使用订阅限额' : ''}` : provider === 'codex-subscription' ? '使用 ChatGPT / Codex 订阅限额' : '用量由 DeepSeek 账户结算';
  const storyboardRecords = skill21 ? Object.fromEntries(
    ['voiceSources', 'voiceFragments', 'deferredVoices', 'blockers', 'auditRecord', 'verification']
      .filter((key) => Object.hasOwn(storyboard, key))
      .map((key) => [key, structuredClone(storyboard[key])]),
  ) : {};
  const analysisTitle = typeof analysis.title === 'string' && analysis.title.trim() ? analysis.title : '故事结构分析';
  const storyboardTitle = typeof storyboard.title === 'string' && storyboard.title.trim() ? storyboard.title : (customSkill ? '用户 Skill 分镜提示词' : skill21 ? 'Skill v2.1 分镜提示词' : '即梦二点零分镜提示词');

  return {
    analysis: { title: analysisTitle, subtitle: `模型：${model || generation.model || 'deepseek-flash'}${provider === 'codex-subscription' ? ` · 思考 ${generation.reasoningEffort || '默认'}` : ''} · ${usageText}`, time: 'AI 生成', body: analysisBody },
    storyboard: { title: storyboardTitle, subtitle: `${shots.length} 个${skill21 ? `生成块 · ${actualShotCount} 个实际镜头` : '镜头'} · ${partial ? '部分通过，受阻范围见审计结果' : auditIgnored ? '审计未通过，已忽略并继续' : '时长由剧情动态分配'}`, time: 'AI 生成', prompts: shots.map((shot) => String(shot.prompt || '')), durations: shots.map((shot) => (skill21 ? resolveStoryboardDuration : resolveSeedanceDuration)(shot.duration, shot.prompt, SEEDANCE_DEFAULT_DURATION)), shots, unifiedSuffix, ...(skill21 ? { skillVersion: '2.1', auditSummary, ...storyboardRecords } : {}), body: storyboardBody },
    assets: { title: '视觉参考图素材', subtitle: `${promptItems.length} 项 · GPT 订阅生图或本地上传`, time: '按项生成', promptItems, body: assetsBody },
  };
}

function formatDuration(value) {
  const text = String(value ?? '').trim();
  if (!text) return '时长待定';
  return /秒$/.test(text) ? text : `${text}秒`;
}

function buildPromptFromShot(shot) {
  const uploads = Array.isArray(shot.uploads) ? shot.uploads : [];
  const segments = Array.isArray(shot.segments) ? shot.segments : [];
  return `生成${formatDuration(shot.duration)}竖屏短剧。${uploads.map((item) => `${item.ref}作${item.purpose}`).join('，')}。\n${segments.map((item) => `${item.time}：${item.visual}`).join('\n')}\n声音：${shot.sound || ''}`;
}

function createAssetGenerationState(promptItems) {
  return {
    status: 'pending',
    provider: 'local',
    model: '',
    size: '',
    quality: '',
    outputDirectory: '',
    generatedCount: 0,
    totalCount: promptItems.length,
    items: promptItems.map((item) => ({
      name: String(item.name || ''),
      type: String(item.type || ''),
      fileName: String(item.fileName || ''),
      status: 'pending',
      files: [],
      localPath: '',
      imageUrl: '',
      error: '',
    })),
  };
}

function assetImageFileName(name, index = 0) {
  let base = String(name || '').trim().replace(/^@/u, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/u, '').slice(0, 160);
  if (!base) base = `参考图-${index + 1}`;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(base)) base = `_${base}`;
  return `${base}.png`;
}

function alignAssetGenerationItems(prompts, ownerProject = project) {
  const state = ownerProject.assetGeneration || {};
  const current = Array.isArray(state.items) ? state.items : [];
  const identity = (item) => JSON.stringify([String(item?.name || ''), String(item?.type || ''), String(item?.fileName || '')]);
  const namedIdentity = (item) => item?.name ? JSON.stringify([String(item.name), String(item.type || '')]) : '';
  const fileName = (item) => String(item?.fileName || '');
  const uniqueIndex = (keyOf, prompt, used) => {
    const key = keyOf(prompt);
    if (!key || prompts.filter((item) => keyOf(item) === key).length !== 1) return -1;
    const indexes = current.map((item, index) => item && keyOf(item) === key ? index : -1).filter((index) => index >= 0);
    return indexes.length === 1 && !used.has(indexes[0]) ? indexes[0] : -1;
  };
  const used = new Set();
  state.items = prompts.map((prompt, index) => {
    let savedIndex = current[index] && !used.has(index) && identity(current[index]) === identity(prompt) ? index : -1;
    if (savedIndex < 0) savedIndex = uniqueIndex(identity, prompt, used);
    if (savedIndex < 0) savedIndex = uniqueIndex(namedIdentity, prompt, used);
    // Legacy filename recovery is safe only when the filename is unique on both sides.
    if (savedIndex < 0) {
      const legacyIndex = uniqueIndex(fileName, prompt, used);
      const legacy = current[legacyIndex];
      if (legacyIndex >= 0 && (!legacy.name || legacy.name === prompt.name) && (!legacy.type || !prompt.type || legacy.type === prompt.type)) savedIndex = legacyIndex;
    }
    if (savedIndex >= 0) used.add(savedIndex);
    const saved = savedIndex >= 0 ? current[savedIndex] : {};
    const files = Array.isArray(saved.files) ? saved.files.filter((file) => file?.localPath) : [];
    if (!files.length && saved.localPath) files.push({ localPath: saved.localPath, imageUrl: saved.imageUrl || '', fileName: saved.fileName || '', sourceName: saved.fileName || '' });
    return {
      ...saved,
      name: String(prompt.name || ''),
      type: String(prompt.type || ''),
      fileName: String(prompt.fileName || saved.fileName || ''),
      status: saved.status === 'generating' && codexImageRun?.ownerProject === ownerProject ? 'generating' : saved.error ? 'failed' : files.length ? 'success' : 'pending',
      files,
      localPath: files[0]?.localPath || '',
      imageUrl: files[0]?.imageUrl || '',
      error: saved.error || '',
      generatedAt: saved.generatedAt || '',
    };
  });
  const hasCodexImages = state.items.some((item) => item.files.some((file) => file.provider === 'codex-subscription'));
  state.provider = hasCodexImages ? 'mixed' : 'local';
  state.model = hasCodexImages ? OPENAI_IMAGE_MODEL : '';
  state.size = '';
  state.quality = '';
  state.totalCount = prompts.length;
  state.generatedCount = state.items.filter((item) => item.files.length).length;
  state.status = state.generatedCount === prompts.length && prompts.length ? 'complete' : 'pending';
  ownerProject.completed = Array.isArray(ownerProject.completed) ? ownerProject.completed : [];
  if (state.status === 'complete') {
    if (!ownerProject.completed.includes('assets')) ownerProject.completed.push('assets');
  } else ownerProject.completed = ownerProject.completed.filter(id => id !== 'assets');
  ownerProject.assetGeneration = state;
  return state;
}

function videoReferencePurpose(asset) {
  const name = String(asset?.name || '补充参考图');
  const type = String(asset?.type || '参考图');
  if (/人物/.test(type)) return `${name}的唯一人物外貌、发型、服装和体态参考`;
  if (/场景/.test(type)) return `${name}的唯一场景结构、灯光、材质和陈设参考`;
  if (/群像/.test(type)) return `${name}的背景人物服装、站位和氛围参考`;
  if (/道具/.test(type)) return `${name}的材质、颜色、比例和细节参考`;
  return `${name}在当前镜头中的补充视觉参考`;
}

function videoReferencePromptLine(number, asset = null) {
  const name = String(asset?.name || '待选择素材');
  return `@${name} 作为${name}的补充参考图，严格保持该素材对应的人物、场景或道具一致。`;
}

function insertSkillReferenceDeclaration(prompt, number, asset = null) {
  const name = String(asset?.name || '待选择素材');
  const type = String(asset?.type || '');
  const label = /人物|群像/.test(type) ? '人物' : /场景/.test(type) ? '场景' : '道具';
  const declaration = `${label}：@${name} （${asset ? videoReferencePurpose(asset) : '用户补充参考图'}）`;
  const lines = String(prompt || '').trim().split('\n');
  const firstTimeline = lines.findIndex((line) => /^\s*[\[【]\s*\d/.test(line));
  const headerEnd = firstTimeline < 0 ? lines.length : firstTimeline;
  const lastAssetLine = lines.slice(0, headerEnd).reduce((last, line, index) => /^(?:人物|场景|道具|声音)[：:]/.test(line.trim()) ? index : last, -1);
  const durationLine = lines.slice(0, headerEnd).findIndex((line) => /^\s*本段总时长[：:]/.test(line));
  lines.splice(lastAssetLine >= 0 ? lastAssetLine + 1 : durationLine >= 0 ? durationLine + 1 : Math.min(1, headerEnd), 0, declaration);
  return lines.join('\n');
}

function selectVideoReference(shotIndex, referenceNumber, assetItemIndex, fileIndex) {
  if (project.running) return false;
  const scrollPositions = capturePageScrollPositions();
  const prompts = project.outputs.storyboard?.prompts || [];
  const state = alignVideoGenerationItems(prompts);
  const item = state.items[shotIndex];
  const asset = project.assetGeneration?.items?.[assetItemIndex];
  const file = asset?.files?.[fileIndex];
  if (!item || !asset || !file) return false;
  const currentPrompt = effectiveVideoPrompt(shotIndex, prompts[shotIndex], state);
  const shot = project.outputs.storyboard?.shots?.[shotIndex] || {};
  const plan = resolveStrictReferencePlan({ prompt: currentPrompt, shot, assetItems: project.assetGeneration?.items || [], savedBindings: item.referenceBindings || {} });
  const binding = plan.bindings.find(entry => entry.number === referenceNumber);
  if (!binding) return false;
  if (binding.assetName && binding.assetName !== asset.name) { showToast('只能选择 @' + binding.assetName + ' 的同名图片'); return false; }
  item.referenceBindings = { ...(item.referenceBindings || {}), [binding.key]: { assetName: asset.name, localPath: String(file.localPath || ''), trustedAssetId: normalizeTrustedAssetId(file.trustedAssetId), sourceName: String(file.sourceName || file.fileName || '') } };
  repairVideoReferenceSequence(shotIndex, currentPrompt, item, state);
  resetVideoItemAfterReferenceChange(item, state);
  saveProject(); renderWithoutMovingPage(scrollPositions);
  showToast('@' + asset.name + ' 已切换为所选图片');
  return true;
}

function resetVideoItemAfterReferenceChange(item, state) {
  if (!item || !state) return;
  if (!['creating', 'queued', 'running', 'downloading'].includes(item.status)) {
    item.status = 'pending';
    item.taskId = '';
    item.error = '';
  }
  state.status = 'pending';
  state.lastError = '';
  state.generatedCount = state.items.filter((videoItem) => getSelectedVideoVersion(videoItem)).length;
  project.completed = project.completed.filter((id) => id !== 'video');
  reconcilePortraitCertification(state);
}

function samePortraitReference(input, file) {
  if (!file || (input.assetName && input.assetName !== file.assetName)) return false;
  const rejectedId = normalizeTrustedAssetId(input.assetId);
  const selectedId = normalizeTrustedAssetId(file.trustedAssetId);
  if (rejectedId || selectedId) return rejectedId === selectedId;
  if (input.localPath) return input.localPath === file.localPath;
  return input.assetItemIndex === file.assetItemIndex && input.fileIndex === file.fileIndex;
}

function reconcilePortraitCertification(state) {
  const pending = state?.pendingCertification;
  if (!pending?.blockedInputs?.length) return false;
  const index = Number(pending.shotIndex);
  const item = state.items?.[index];
  const plan = resolveStrictReferencePlan({
    prompt: effectiveVideoPrompt(index, project.outputs.storyboard?.prompts?.[index], state),
    shot: project.outputs.storyboard?.shots?.[index] || {},
    assetItems: project.assetGeneration?.items || [],
    savedBindings: item?.referenceBindings || {},
  });
  // A platform rejection belongs to the submitted files, not their list slots.
  const blockedInputs = pending.blockedInputs.flatMap(input => {
    const binding = plan.bindings.find(binding => samePortraitReference(input, binding.selected));
    return binding ? [{ ...input, assetItemIndex: binding.selected.assetItemIndex, fileIndex: binding.selected.fileIndex, contentIndex: binding.number, referenceNumber: binding.number }] : [];
  });
  state.pendingCertification = blockedInputs.length ? { ...pending, blockedInputs } : null;
  const changed = blockedInputs.length !== pending.blockedInputs.length;
  if (changed && !blockedInputs.length) resetVideoItemAfterReferenceChange(item, state);
  return changed;
}

function replaceBlockedPortraitReference(assetItemIndex, file) {
  const state = project.videoGeneration;
  const pending = state?.pendingCertification;
  if (!pending?.blockedInputs?.length || !file) return;
  const shotIndex = Number(pending.shotIndex);
  const item = state.items?.[shotIndex];
  if (!item) return;
  const plan = resolveStrictReferencePlan({
    prompt: effectiveVideoPrompt(shotIndex, project.outputs.storyboard?.prompts?.[shotIndex], state),
    shot: project.outputs.storyboard?.shots?.[shotIndex] || {},
    assetItems: project.assetGeneration?.items || [],
    savedBindings: item.referenceBindings || {},
  });
  let changed = false;
  for (const binding of plan.bindings) {
    if (binding.selected?.assetItemIndex !== assetItemIndex
      || !pending.blockedInputs.some(input => samePortraitReference(input, binding.selected))) continue;
    item.referenceBindings = { ...item.referenceBindings, [binding.key]: {
      assetName: binding.selected.assetName, localPath: file.localPath,
      trustedAssetId: normalizeTrustedAssetId(file.trustedAssetId), sourceName: String(file.sourceName || file.fileName || ''),
    } };
    changed = true;
  }
  if (changed) resetVideoItemAfterReferenceChange(item, state);
}

function materializeLegacyVideoUploads(shotIndex, prompt, item) {
  const storyboard = project.outputs.storyboard;
  if (!storyboard) return null;
  const shot = ensureStoryboardShot(storyboard, shotIndex, prompt, storyboardShotDuration(shotIndex, prompt, seedanceStatus.duration));
  const migrated = migrateNamedReferencePlan({ prompt, shot, assetItems: project.assetGeneration?.items || [], savedBindings: item?.referenceBindings || {} });
  shot.uploads = migrated.uploads;
  if (item) item.referenceBindings = migrated.bindings;
  return shot;
}

function addVideoReference(shotIndex, assetItemIndex = null) {
  if (project.running) return;
  const scrollPositions = capturePageScrollPositions();
  const prompts = project.outputs.storyboard?.prompts || [];
  const state = alignVideoGenerationItems(prompts);
  const item = state.items?.[shotIndex];
  const currentPrompt = repairVideoReferenceSequence(shotIndex, effectiveVideoPrompt(shotIndex, prompts[shotIndex], state), item, state);
  const shot = materializeLegacyVideoUploads(shotIndex, currentPrompt, item);
  if (!shot || !item) return showToast('当前镜头无法添加参考图');
  const assets = project.assetGeneration?.items || [];
  const plan = resolveStrictReferencePlan({ prompt: currentPrompt, shot, assetItems: assets, savedBindings: item.referenceBindings || {} });
  if (plan.bindings.length >= 9) return showToast('单个镜头最多只能添加 9 张参考图');
  const asset = Number.isInteger(assetItemIndex) ? assets[assetItemIndex] : assets.find(candidate => candidate.files?.length && !plan.bindings.some(binding => binding.assetName === candidate.name));
  if (!asset) return showToast('请先在第三步准备需要引用的素材图片');
  if (plan.bindings.some(binding => binding.assetName === asset.name)) return showToast('当前镜头已引用同名素材，无需重复添加');
  const ref = '@' + asset.name;
  const file = asset.files?.[0];
  shot.uploads.push({ ref, asset: asset.name, purpose: videoReferencePurpose(asset), addedInVideoStep: true });
  item.promptOverride = storyboardUsesSkill21() ? insertSkillReferenceDeclaration(currentPrompt, 0, asset) : (currentPrompt.trim() + '\n' + videoReferencePromptLine(0, asset));
  item.promptEditedAt = new Date().toISOString();
  if (file) item.referenceBindings = { ...(item.referenceBindings || {}), [namedReferenceKey(asset.name)]: { assetName: asset.name, localPath: String(file.localPath || ''), trustedAssetId: normalizeTrustedAssetId(file.trustedAssetId), sourceName: String(file.sourceName || file.fileName || '') } };
  resetVideoItemAfterReferenceChange(item, state);
  saveProject(); renderWithoutMovingPage(scrollPositions);
  showToast('已添加 ' + ref + ' 并按名称绑定参考图');
}

function removeVideoReference(shotIndex, number) {
  if (project.running) return;
  const scrollPositions = capturePageScrollPositions();
  const prompts = project.outputs.storyboard?.prompts || [];
  const state = alignVideoGenerationItems(prompts);
  const item = state.items?.[shotIndex];
  const currentPrompt = repairVideoReferenceSequence(shotIndex, effectiveVideoPrompt(shotIndex, prompts[shotIndex], state), item, state);
  const shot = materializeLegacyVideoUploads(shotIndex, currentPrompt, item);
  const plan = resolveStrictReferencePlan({ prompt: currentPrompt, shot, assetItems: project.assetGeneration?.items || [], savedBindings: item?.referenceBindings || {} });
  const target = plan.bindings.find(binding => binding.number === number);
  if (!item || !target) return showToast('没有找到要删除的素材引用');
  let promptWithoutTarget = currentPrompt;
  const occurrences = plan.references.filter(reference => reference.ref === target.ref);
  for (const occurrence of [...occurrences].reverse()) promptWithoutTarget = promptWithoutTarget.slice(0, occurrence.start) + target.assetName + promptWithoutTarget.slice(occurrence.end);
  shot.uploads = shot.uploads.filter(upload => target.legacySeparate ? upload.ref !== target.ref : upload.asset !== target.assetName);
  item.referenceBindings = Object.fromEntries(Object.entries(item.referenceBindings || {}).filter(([key, binding]) => target.legacySeparate
    ? key !== target.key && key !== target.ref && key !== String(target.sourceNumber)
    : key !== target.key && binding?.assetName !== target.assetName));
  item.promptOverride = promptWithoutTarget;
  item.promptEditedAt = new Date().toISOString();
  if (state.pendingCertification?.shotIndex === shotIndex) state.pendingCertification = null;
  resetVideoItemAfterReferenceChange(item, state);
  saveProject(); renderWithoutMovingPage(scrollPositions);
  showToast('已删除 ' + target.ref + ' 的图片引用，其他素材名称保持不变');
}

function openCustomAssetModal(targetShotIndex = null) {
  customAssetTargetShotIndex = Number.isInteger(targetShotIndex) ? targetShotIndex : null;
  const modal = document.querySelector('#customAssetModal');
  if (!modal) return;
  modal.hidden = false;
  const title = modal.querySelector('.modal-head h2');
  const lockLabel = modal.querySelector('.local-custom-lock span');
  const lockHelp = modal.querySelector('.local-custom-lock small');
  if (title) title.textContent = Number.isInteger(customAssetTargetShotIndex) ? `为镜头 ${String(customAssetTargetShotIndex + 1).padStart(2, '0')} 添加参考图` : '添加遗漏资源';
  if (lockLabel) lockLabel.textContent = Number.isInteger(customAssetTargetShotIndex) ? '第四步镜头素材' : '第三步本地素材';
  if (lockHelp) lockHelp.textContent = Number.isInteger(customAssetTargetShotIndex) ? '填写名称并选择图片后，会以 @素材名称添加到当前镜头并自动绑定。' : '适合补充主持人、医生、秘书、额外场景或遗漏道具。创建后立即选择本地参考图片。';
  const nameInput = document.querySelector('#customAssetName');
  if (nameInput) nameInput.value = '';
  const typeInput = document.querySelector('#customAssetType');
  if (typeInput) typeInput.value = '人物参考图';
  setCustomAssetMessage('');
  nameInput?.focus();
}

function closeCustomAssetModal() {
  const modal = document.querySelector('#customAssetModal');
  if (modal) modal.hidden = true;
  customAssetTargetShotIndex = null;
}

function openPortraitCertificationModal() {
  const modal = document.querySelector('#portraitCertificationModal');
  if (!modal || !project.videoGeneration?.pendingCertification) return;
  modal.hidden = false;
  setPortraitCertificationMessage('');
  document.querySelector('[data-portrait-asset-id-index]')?.focus();
}

function closePortraitCertificationModal() {
  const modal = document.querySelector('#portraitCertificationModal');
  if (modal) modal.hidden = true;
}

function setPortraitCertificationMessage(message, type = '') {
  const node = document.querySelector('#portraitCertificationMessage');
  if (!node) return;
  node.textContent = message;
  node.className = `modal-message ${type}`;
}

function normalizeTrustedAssetId(value) {
  return String(value || '').trim().replace(/^asset:\/\//i, '');
}

function isValidTrustedAssetId(value) {
  return /^asset-[a-z0-9-]+$/i.test(normalizeTrustedAssetId(value));
}

function savePortraitCertificationAndResume() {
  const ownerProject = project;
  const state = project.videoGeneration;
  if (reconcilePortraitCertification(state)) {
    saveProject(); renderWithoutMovingPage();
    return showToast('参考图已更换，请使用当前参考图重新生成视频');
  }
  const pending = state?.pendingCertification;
  const blockedInputs = Array.isArray(pending?.blockedInputs) ? pending.blockedInputs : [];
  if (!blockedInputs.length) return setPortraitCertificationMessage('没有找到需要认证的参考图，请关闭窗口后重新生成镜头。', 'error');
  const assetIds = blockedInputs.map((_input, index) => normalizeTrustedAssetId(document.querySelector(`[data-portrait-asset-id-index="${index}"]`)?.value));
  const invalidIndex = assetIds.findIndex((assetId) => !isValidTrustedAssetId(assetId));
  if (invalidIndex >= 0) return setPortraitCertificationMessage(`请为“${blockedInputs[invalidIndex].assetName || `参考图${invalidIndex + 1}`}”填写有效的 Asset ID。`, 'error');
  blockedInputs.forEach((input, index) => {
    const file = project.assetGeneration?.items?.[input.assetItemIndex]?.files?.[input.fileIndex];
    if (file) file.trustedAssetId = assetIds[index];
  });
  const shotIndex = Number(pending.shotIndex);
  const resumeIndexes = Array.isArray(pending.resumeIndexes) && pending.resumeIndexes.length ? pending.resumeIndexes : [shotIndex];
  const mode = normalizeSeedanceGenerationMode(pending.mode);
  const resumeAuto = ownerProject.autoRunToVideo === true && ownerProject.autoPipeline?.phase === 'video' && ownerProject.autoPipeline?.status === 'failed';
  if (state.items?.[shotIndex]) state.items[shotIndex] = { ...state.items[shotIndex], status: 'pending', taskId: '', error: '' };
  state.pendingCertification = null;
  state.lastError = '';
  const scrollPositions = capturePageScrollPositions();
  closePortraitCertificationModal();
  saveProject();
  renderWithoutMovingPage(scrollPositions);
  showToast('可信素材已绑定，正在自动继续生成');
  const resumeToken = generationRun;
  const resumeViewSequence = viewNavigationSequence;
  window.setTimeout(() => {
    if (generationRun !== resumeToken || project !== ownerProject || ownerProject.videoGeneration !== state || ownerProject.running) return;
    if (resumeAuto) {
      const run = { ownerProject, projectId: ownerProject.id, inputScript: ownerProject.script, stageSkills: structuredClone(normalizeGenerationSkills(ownerProject.generationSkills)), viewSequence: resumeViewSequence };
      autoPipelineRun = run;
      generateAutoPipelineVideos(run, resumeIndexes).catch(error => finishAutoPipeline(run, 'failed', cleanRemoteError(error, '全流程生成失败，已保留完成的成果')));
    } else generateSeedanceVideos({ token: ++generationRun, indexes: resumeIndexes, mode, viewSequence: resumeViewSequence });
  }, 0);
}

function setCustomAssetMessage(message, type = '') {
  const node = document.querySelector('#customAssetMessage');
  if (!node) return;
  node.textContent = message;
  node.className = `modal-message ${type}`;
}

function customAssetFileName(type, name) {
  const cleanName = String(name || '遗漏资源').replace(/[<>:"/\\|?*]/g, '_').trim();
  const prefix = /人物/.test(type) ? '人物' : /场景/.test(type) ? '场景' : /群像/.test(type) ? '群像' : /道具/.test(type) ? '道具' : '自定义';
  return `${prefix}-${cleanName}-参考图.png`;
}

async function createCustomAsset() {
  const scrollPositions = capturePageScrollPositions();
  const targetShotIndex = customAssetTargetShotIndex;
  const name = String(document.querySelector('#customAssetName')?.value || '').trim();
  const type = String(document.querySelector('#customAssetType')?.value || '其他参考图');
  if (!name) return setCustomAssetMessage('请输入资源名称，例如“主持人”。', 'error');
  const prompts = project.outputs.assets?.promptItems || [];
  if (prompts.some((item) => String(item.name || '').trim() === name)) return setCustomAssetMessage('已有同名资源，请直接在对应卡片上传图片。', 'error');
  const customItem = {
    name,
    type,
    fileName: customAssetFileName(type, name),
    description: `用户补充的遗漏资源：${name}`,
    prompt: '',
    customAsset: true,
  };
  prompts.push(customItem);
  project.outputs.assets.promptItems = prompts;
  project.outputs.assets.subtitle = `${prompts.length} 项 · 包含用户补充的本地参考资源`;
  project.completed = project.completed.filter((id) => id !== 'assets');
  alignAssetGenerationItems(prompts);
  closeCustomAssetModal();
  saveProject(); renderWithoutMovingPage(scrollPositions);
  const uploaded = await selectLocalAssetImages(prompts.length - 1);
  if (Number.isInteger(targetShotIndex) && uploaded?.files?.length) addVideoReference(targetShotIndex, prompts.length - 1);
}

function removeCustomAsset(index) {
  const prompts = project.outputs.assets?.promptItems || [];
  if (!prompts[index]?.customAsset) return;
  const removedName = prompts[index].name || '自定义资源';
  prompts.splice(index, 1);
  project.outputs.assets.promptItems = prompts;
  project.outputs.assets.subtitle = `${prompts.length} 项 · 人物、场景、群像、道具与自定义资源`;
  if (Array.isArray(project.assetGeneration?.items)) project.assetGeneration.items.splice(index, 1);
  project.completed = project.completed.filter((id) => id !== 'assets');
  alignAssetGenerationItems(prompts);
  saveProject(); render();
  showToast(`已删除自定义资源“${removedName}”，磁盘中的图片仍然保留`);
}

async function selectLocalAssetImages(index) {
  const prompts = project.outputs.assets?.promptItems || [];
  const prompt = prompts[index];
  if (!prompt || !window.storyforgeAI?.selectLocalAssetImages) return showToast('当前素材项无法上传图片');
  if (project.running) return;
  const ownerProject = project;
  const token = generationRun;
  const scrollPositions = capturePageScrollPositions();
  try {
    const result = await window.storyforgeAI.selectLocalAssetImages({
      projectId: project.id,
      projectTitle: project.title,
      index,
      assetName: String(prompt.name || `素材${index + 1}`),
      assetType: String(prompt.type || '参考图'),
    });
    if (project !== ownerProject || generationRun !== token || project.running) return;
    if (result?.canceled || !result?.files?.length) return;
    const state = alignAssetGenerationItems(prompts);
    const existing = Array.isArray(state.items[index].files) ? state.items[index].files : [];
    const merged = [...existing, ...result.files]
      .filter((file, fileIndex, files) => file?.localPath && files.findIndex((candidate) => candidate.localPath === file.localPath) === fileIndex)
      .slice(0, 9);
    state.items[index] = {
      ...state.items[index],
      files: merged,
      status: merged.length ? 'success' : 'pending',
      localPath: merged[0]?.localPath || '',
      imageUrl: merged[0]?.imageUrl || '',
      error: '',
      generatedAt: new Date().toISOString(),
    };
    state.outputDirectory = result.outputDirectory || state.outputDirectory;
    state.generatedCount = state.items.filter((item) => item.files.length).length;
    state.status = state.generatedCount === prompts.length ? 'complete' : 'pending';
    alignAssetGenerationItems(prompts);
    const replacement = merged.find(file => result.files.some(uploaded => uploaded.localPath === file.localPath)
      && !existing.some(previous => previous.localPath === file.localPath));
    replaceBlockedPortraitReference(index, replacement);
    saveProject(); renderWithoutMovingPage(scrollPositions);
    showToast(`${prompt.name || '当前素材'}已上传 ${result.files.length} 张参考图`);
    return result;
  } catch (error) {
    showToast(cleanRemoteError(error, '上传参考图失败'));
    return null;
  }
}

function clearLocalAssetImages(index) {
  const prompts = project.outputs.assets?.promptItems || [];
  const state = alignAssetGenerationItems(prompts);
  if (!state.items[index]) return;
  state.items[index] = { ...state.items[index], files: [], status: 'pending', localPath: '', imageUrl: '', error: '' };
  state.generatedCount = state.items.filter((item) => item.files.length).length;
  state.status = 'pending';
  project.completed = project.completed.filter((id) => id !== 'assets');
  reconcilePortraitCertification(project.videoGeneration);
  saveProject(); render();
  showToast('已清空此项的参考图关联，磁盘中的原文件仍然保留');
}

async function showLocalAssetImage(itemIndex, fileIndex) {
  const filePath = project.assetGeneration?.items?.[itemIndex]?.files?.[fileIndex]?.localPath;
  try { await window.storyforgeAI.showLocalAssetImage(filePath); }
  catch (error) { showToast(cleanRemoteError(error, '无法找到这张参考图')); }
}

function isCurrentCodexImageRun(run) {
  return codexImageRun === run && run.token === generationRun && project === run.ownerProject && project.id === run.projectId;
}

async function generateCodexImageAssets(indexes = null, { pipelineRun = null } = {}) {
  if ((project.running && !isCurrentAutoPipelineRun(pipelineRun)) || codexImageRun) return showToast('当前生成任务进行中，请稍候或先停止');
  const ownerProject = project;
  const prompts = ownerProject.outputs.assets?.promptItems || [];
  if (!prompts.length) return showToast('第三步还没有可生成的参考图提示词');
  if (!window.storyforgeAI?.generateCodexImage) return showToast('当前环境无法调用本机 Codex，请使用更新后的桌面版');
  const state = alignAssetGenerationItems(prompts, ownerProject);
  const requested = Array.isArray(indexes)
    ? [...new Set(indexes)].filter((index) => Number.isInteger(index) && prompts[index] && state.items[index].files.length < 9)
    : prompts.map((_prompt, index) => index).filter((index) => !state.items[index].files.length);
  const validIndexes = requested.filter((index) => String(prompts[index].prompt || '').trim());
  if (!validIndexes.length) return showToast('没有可生成的缺图项；自定义资源没有提示词时请上传图片，每项最多 9 张');

  const run = { ownerProject, projectId: ownerProject.id, token: ++generationRun, viewSequence: pipelineRun?.viewSequence ?? viewNavigationSequence, activeIndex: null, jobId: null, assetSkill: structuredClone(pipelineRun ? pipelineRun.stageSkills.assets : normalizeGenerationSkills(ownerProject.generationSkills).assets) };
  codexImageRun = run;
  ownerProject.running = true;
  if (!pipelineRun) ownerProject.autoPipeline = null;
  focusGenerationStep('assets', run);
  state.lastError = '';
  let generatedCount = 0;
  let failedCount = 0;
  let needsSettings = false;
  saveProject(); renderWithoutMovingPage();
  try {
    await refreshCodexImageStatus();
    if (!isCurrentCodexImageRun(run)) return;
    if (!isCodexImageReady()) {
      needsSettings = true;
      throw new Error(codexImageStatus.error || `${codexImageStatusText()}。请先检查本机 Codex 的安装和 ChatGPT 登录状态。`);
    }
    closeCodexImageSettings();
    for (const index of validIndexes) {
      if (!isCurrentCodexImageRun(run)) return;
      const prompt = prompts[index];
      run.activeIndex = index;
      run.jobId = `codex-image-${createProjectId()}`;
      state.items[index] = { ...state.items[index], status: 'generating', error: '' };
      ownerProject.completed = ownerProject.completed.filter((id) => id !== 'assets');
      saveProject(); renderWithoutMovingPage();
      try {
        const result = await window.storyforgeAI.generateCodexImage({
          projectId: run.projectId,
          projectTitle: ownerProject.title,
          index,
          prompt: String(prompt.prompt),
          fileName: assetImageFileName(prompt.name, index),
          assetName: String(prompt.name || ''),
          jobId: run.jobId,
          assetSkill: structuredClone(run.assetSkill),
        });
        if (!isCurrentCodexImageRun(run)) return;
        const returnedFiles = Array.isArray(result?.files)
          ? result.files.filter((file) => file?.localPath).slice(0, 1).map((file) => ({ ...file, provider: 'codex-subscription' }))
          : [];
        if (!returnedFiles.length) throw new Error('Codex 没有返回可保存的图片，请检查订阅额度后重试。');
        const existing = state.items[index].files;
        const merged = [...existing, ...returnedFiles]
          .filter((file, fileIndex, files) => files.findIndex((candidate) => candidate.localPath === file.localPath) === fileIndex)
          .slice(0, 9);
        if (merged.length <= existing.length) throw new Error('Codex 没有返回新的参考图，已有图片已保留，请重试。');
        state.items[index] = {
          ...state.items[index],
          files: merged,
          localPath: merged[0]?.localPath || '',
          imageUrl: merged[0]?.imageUrl || '',
          status: 'success',
          error: '',
          generatedAt: new Date().toISOString(),
        };
        state.outputDirectory = result.outputDirectory || state.outputDirectory;
        generatedCount += 1;
      } catch (error) {
        if (!isCurrentCodexImageRun(run)) return;
        const message = cleanRemoteError(error, 'GPT 订阅生图失败');
        state.items[index] = { ...state.items[index], status: 'failed', error: message };
        state.lastError = message;
        failedCount += 1;
        if (pipelineRun || /额度|限额|登录|不支持|未找到|版本|权限|quota|rate.?limit|unauth/i.test(message)) break;
      }
      run.jobId = null;
      state.generatedCount = state.items.filter((item) => item.files.length).length;
      saveProject(); renderWithoutMovingPage();
    }
  } catch (error) {
    if (!isCurrentCodexImageRun(run)) return;
    state.lastError = cleanRemoteError(error, 'GPT 订阅生图失败');
  } finally {
    if (isCurrentCodexImageRun(run)) {
      codexImageRun = null;
      ownerProject.running = isCurrentAutoPipelineRun(pipelineRun);
      alignAssetGenerationItems(prompts, ownerProject);
      saveProject(); renderWithoutMovingPage();
      showToast(state.lastError || `GPT 已生成并保存 ${generatedCount} 张参考图${failedCount ? `，${failedCount} 项失败，可单项重试` : state.status === 'complete' ? '，第三步已完成' : ''}`);
      if (needsSettings) {
        codexImageSettingsOpen = true;
        const modal = document.querySelector('#codexImageSettingsModal');
        if (modal) modal.hidden = false;
      }
    }
  }
}

function confirmLocalAssets({ automatic = false, pipelineRun = null } = {}) {
  const prompts = project.outputs.assets?.promptItems || [];
  const state = alignAssetGenerationItems(prompts);
  const missing = state.items.filter((item) => !item.files.length);
  if (!prompts.length && !automatic) return showToast('第三步没有可确认的素材清单');
  if (missing.length) return showToast(`还有 ${missing.length} 项没有参考图，请先生成或上传`);
  state.status = 'complete';
  state.generatedCount = state.items.length;
  if (!project.completed.includes('assets')) project.completed.push('assets');
  if (automatic) focusGenerationStep('video', pipelineRun);
  else selectWorkflowStep('video');
  if (!project.outputs.video) project.outputs.video = makeOutput('video');
  alignVideoGenerationItems(project.outputs.storyboard?.prompts || []);
  saveProject(); renderWithoutMovingPage();
  if (!automatic) showToast('参考图已确认，可以逐个或批量生成视频');
  return true;
}

async function generateImageAssets({ token, indexes = null, autoAdvance = true }) {
  const imageFocus = { ownerProject: project, viewSequence: viewNavigationSequence };
  if (!IMAGE_MODEL_GENERATION_ENABLED) return showToast('第三步模型生图已暂停，请为每项上传本地参考图');
  const prompts = project.outputs.assets?.promptItems || [];
  if (!prompts.length) return showToast('第三步还没有可生成的参考图提示词');
  const provider = imageProvider;
  const providerStatus = activeImageStatus(provider);
  if (!window.storyforgeAI || !providerStatus.configured) {
    project.running = false;
    focusGenerationStep('assets', imageFocus);
    saveProject(); renderWithoutMovingPage();
    openImageSettings();
    setImageMessage(`请先配置${provider === 'openai' ? ' OpenAI' : '火山方舟'} API Key。保存后会自动继续第三步。`, 'error');
    return;
  }

  const state = alignAssetGenerationItems(prompts);
  const providerChanged = (state.provider || 'seedream') !== provider
    || state.model !== providerStatus.model
    || state.size !== providerStatus.size
    || (provider === 'openai' && state.quality !== providerStatus.quality);
  state.provider = provider;
  state.model = providerStatus.model;
  state.size = providerStatus.size;
  state.quality = provider === 'openai' ? providerStatus.quality : '';
  state.lastError = '';
  if (providerChanged && !Array.isArray(indexes)) {
    state.items = state.items.map((item) => ({ ...item, status: 'pending', error: '' }));
    state.generatedCount = 0;
  }
  const requested = Array.isArray(indexes)
    ? indexes.filter((index) => Number.isInteger(index) && index >= 0 && index < prompts.length)
    : prompts.map((_, index) => index).filter((index) => providerChanged || state.items[index].status !== 'success');
  if (!requested.length) {
    if (autoAdvance) {
      if (!project.completed.includes('assets')) project.completed.push('assets');
      focusGenerationStep('video', imageFocus);
      saveProject(); renderWithoutMovingPage();
    } else showToast('所有参考图都已经生成');
    return;
  }

  project.completed = project.completed.filter((id) => id !== 'assets');
  focusGenerationStep('assets', imageFocus);
  project.running = true;
  state.status = 'running';
  saveProject(); renderWithoutMovingPage();

  for (const index of requested) {
    if (token !== generationRun) return;
    const prompt = prompts[index];
    state.items[index] = { ...state.items[index], status: 'generating', error: '' };
    state.generatedCount = state.items.filter((item) => item.status === 'success').length;
    saveProject(); renderWithoutMovingPage();
    try {
      const task = {
        projectId: project.id,
        projectTitle: project.title,
        index,
        prompt: prompt.prompt,
        fileName: prompt.fileName,
        size: state.size,
        quality: state.quality,
      };
      const result = provider === 'openai'
        ? await window.storyforgeAI.generateOpenAIImage(task)
        : await window.storyforgeAI.generateSeedreamImage({ ...task, model: state.model });
      if (token !== generationRun) return;
      state.items[index] = {
        ...state.items[index],
        ...result,
        status: 'success',
        error: '',
        generatedAt: new Date().toISOString(),
      };
      state.outputDirectory = result.outputDirectory || state.outputDirectory;
    } catch (error) {
      if (token !== generationRun) return;
      const message = cleanRemoteError(error, '生成失败');
      state.items[index] = { ...state.items[index], status: 'failed', error: message };
      if (/尚未开通|API Key 无效|没有.*权限|额度不足|余额不足|组织验证/.test(message)) state.lastError = message;
    }
    state.generatedCount = state.items.filter((item) => item.status === 'success').length;
    saveProject(); renderWithoutMovingPage();
    if (state.lastError) break;
  }

  if (token !== generationRun) return;
  const failed = state.items.filter((item) => item.status === 'failed').length;
  const allComplete = state.items.length === prompts.length && state.items.every((item) => item.status === 'success');
  state.status = allComplete ? 'complete' : failed ? 'partial' : 'pending';
  state.generatedCount = state.items.filter((item) => item.status === 'success').length;
  project.running = false;
  if (allComplete) {
    if (!project.completed.includes('assets')) project.completed.push('assets');
    if (autoAdvance) focusGenerationStep('video', imageFocus);
    saveProject(); renderWithoutMovingPage();
    showToast(`${imageProviderLabel(provider)} 已生成并保存 ${state.generatedCount} 张参考图`);
  } else {
    saveProject(); renderWithoutMovingPage();
    showToast(state.lastError || `已生成 ${state.generatedCount} 张，${failed} 张失败，可单独重试`);
  }
}

async function openAssetOutputFolder() {
  try { await window.storyforgeAI.openLocalAssetOutput(project.assetGeneration?.outputDirectory); }
  catch (error) { showToast(cleanRemoteError(error, '无法打开图片文件夹')); }
}

function isCurrentAutoPipelineRun(run) {
  return Boolean(run && autoPipelineRun === run && project === run.ownerProject && project.id === run.projectId);
}

function updateAutoPipelinePhase(run, phase) {
  if (!isCurrentAutoPipelineRun(run)) return false;
  if (run.ownerProject.script !== run.inputScript) throw new Error('全流程已暂停：剧本文本发生更改，请根据最新剧本重新开始。');
  project.autoPipeline = { ...project.autoPipeline, status: 'running', phase, error: '' };
  project.running = true;
  saveProject(); renderWithoutMovingPage();
  return true;
}

function finishAutoPipeline(run, status, message = '') {
  if (!isCurrentAutoPipelineRun(run)) return;
  project.autoPipeline = { ...project.autoPipeline, status, error: message, finishedAt: Date.now() };
  project.running = false;
  autoPipelineRun = null;
  saveProject(); renderWithoutMovingPage();
  if (message) showToast(message);
}

function validateAutoVideoPlan() {
  const storyboard = project.outputs.storyboard;
  if (storyboard?.auditSummary?.finalStatus === '部分通过（存在阻塞）') throw new Error('分镜仍有未交付的阻塞内容，全流程已暂停。请先补充第二步所列信息。');
  const prompts = storyboard?.prompts || [];
  if (!prompts.length) throw new Error('没有可用于视频生成的分镜。');
  const assets = project.outputs.assets?.promptItems || [];
  for (let index = 0; index < prompts.length; index += 1) {
    const shot = storyboard.shots?.[index];
    const duration = shot?.duration ?? storyboard.durations?.[index];
    if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error(`生成块 ${shot?.no || index + 1} 的原始时长不符合视频接口的 4–15 秒整数范围，请调整 Skill 或分块后重新生成。`);
    if (!String(prompts[index] || '').trim()) throw new Error(`生成块 ${shot?.no || index + 1} 缺少视频提示词。`);
    const references = extractAssetReferences(prompts[index], assets);
    const unknown = references.find(reference => reference.kind === 'unknown');
    if (unknown) throw new Error(`生成块 ${shot?.no || index + 1} 引用的素材“${unknown.ref}”不在素材清单中。`);
    if (new Set(references.map(reference => reference.ref)).size > 9) throw new Error(`生成块 ${shot?.no || index + 1} 超过单镜头最多 9 张参考图的范围。`);
    for (const reference of references.filter(item => item.kind === 'legacy')) {
      const upload = shot?.uploads?.find(item => item.ref?.toLowerCase() === reference.ref.toLowerCase());
      if (!upload || !assets.some(asset => asset.name === upload.asset)) throw new Error(`生成块 ${shot?.no || index + 1} 的旧引用“${reference.ref}”没有准确的素材名称，请使用 @素材名。`);
    }
  }
  const missingPrompt = assets.find(asset => !String(asset.prompt || '').trim());
  if (missingPrompt) throw new Error(`素材“${missingPrompt.name || '未命名'}”没有生图提示词，请补充提示词或上传参考图。`);
}

async function continueAutoPipeline(run) {
  try {
    if (!isCurrentAutoPipelineRun(run)) return;
    validateAutoVideoPlan();
    if (!updateAutoPipelinePhase(run, 'assets')) return;
    const prompts = project.outputs.assets?.promptItems || [];
    if (prompts.length) await generateCodexImageAssets(null, { pipelineRun: run });
    if (!isCurrentAutoPipelineRun(run)) return;
    if (project.script !== run.inputScript) throw new Error('剧本文本已更改，全流程已暂停。');
    const assets = alignAssetGenerationItems(prompts);
    if (assets.lastError || assets.items.some(item => !item.files?.length || item.status === 'failed')) throw new Error(assets.lastError || '参考图尚未全部生成，全流程已暂停；已生成图片仍保留。');
    if (!confirmLocalAssets({ automatic: true, pipelineRun: run })) throw new Error('参考图尚未准备完成，无法自动进入视频生成。');
    await generateAutoPipelineVideos(run);
  } catch (error) {
    finishAutoPipeline(run, 'failed', cleanRemoteError(error, '全流程生成失败，已保留完成的成果'));
  }
}

async function generateAutoPipelineVideos(run, indexes = null) {
  if (!updateAutoPipelinePhase(run, 'video')) return;
  await generateSeedanceVideos({ token: ++generationRun, indexes, mode: 'batch', stopOnFailure: true, pipelineRun: run });
  if (!isCurrentAutoPipelineRun(run)) return;
  const state = project.videoGeneration;
  if (state.pendingCertification) throw new Error('视频平台要求完成真人素材认证，已暂停全流程；请在当前镜头完成认证后继续批量生成。');
  if (!state.items?.length || state.items.some(item => item.status !== 'success') || !project.completed.includes('video')) throw new Error(state.lastError || state.items.find(item => item.error)?.error || '部分视频尚未完成，已暂停全流程，已完成的视频仍保留。');
  finishAutoPipeline(run, 'completed', '全部视频镜头已批量生成并保存。');
}

async function rerunCurrentStage() {
  if (project.running) return showToast('当前生成任务进行中，请先完成或停止后再重新生成');
  if (project.activeStep === 'assets') return generateCodexImageAssets((project.outputs.assets?.promptItems || []).map((_item, index) => index));
  if (project.activeStep === 'video') return generateSeedanceVideos({ token: ++generationRun, force: true, mode: 'batch' });
  return startGeneration(true, { fullAuto: false });
}

async function startGeneration(retry = false, { fullAuto = project.autoRunToVideo === true } = {}) {
  if (project.running) return showToast('当前生成任务进行中，请稍候或先停止');
  if (project.activeStep === 'assets' && !fullAuto) return generateCodexImageAssets();
  if (project.activeStep === 'video' && !fullAuto) return generateVideoStage(++generationRun, retry === 'force-video');
  if (!project.script.trim()) { showToast('请先输入或导入一段剧本'); document.querySelector('#scriptInput')?.focus(); return; }
  const storyboardSettings = structuredClone(normalizeStoryboardGeneration(project.storyboardGeneration));
  if (!window.storyforgeAI && storyboardSettings.provider === 'codex-subscription') { openCodexTextSettings(); showToast('GPT 订阅生成需要更新后的桌面版。'); return; }
  if (!window.storyforgeAI || (storyboardSettings.provider === 'deepseek' && !deepseekStatus.configured)) { openModelSettings(); setModelMessage('请先配置 DeepSeek API Key，再开始生成。', 'error'); return; }
  if (fullAuto && !currentVideoSettings().configured) { openSeedanceSettings(); setSeedanceMessage('一键全流程需要先配置视频生成服务。', 'error'); return; }

  const token = ++generationRun;
  const ownerProject = project;
  const inputScript = ownerProject.script;
  const stageSkills = structuredClone(normalizeGenerationSkills(ownerProject.generationSkills));
  const pipeline = fullAuto ? { ownerProject, projectId: ownerProject.id, inputScript, stageSkills, viewSequence: viewNavigationSequence } : null;
  autoPipelineRun = pipeline;
  ownerProject.autoPipeline = pipeline ? { status: 'running', phase: 'checking', startedAt: Date.now(), finishedAt: null, error: '' } : null;
  const previousActiveStep = ownerProject.activeStep;
  const isCurrentRun = () => token === generationRun && ownerProject === project;
  const run = { ownerProject, token, runId: createProjectId(), projectId: ownerProject.id, stageSkills, generation: storyboardSettings, viewSequence: viewNavigationSequence, lastSequence: -1, lastSavedAt: Date.now(), lastPaintAt: 0, lastPhase: '' };
  workflowRun = run;
  ownerProject.workflowProgress = createInitialWorkflowProgress({ runId: run.runId, projectId: run.projectId, inputChars: inputScript.length, ...resolveStoryboardGeneration(storyboardSettings) });
  project.activeStep = 'analysis';
  project.running = true;
  project.workflowError = '';
  saveProject(); renderWithoutMovingPage();
  try {
    if (storyboardSettings.provider === 'codex-subscription') {
      await refreshCodexTextStatus();
      if (!isCurrentRun() || workflowRun !== run) return;
      if (!codexTextStatus.available || !codexTextStatus.authenticated) throw Object.assign(new Error(codexTextStatus.error || '请先在本机 Codex 中使用 ChatGPT 账号登录，再使用 GPT 订阅生成分镜。'), { autoConfig: 'storyboard' });
      const selected = resolveStoryboardGeneration(storyboardSettings);
      if (selected.error) throw Object.assign(new Error(selected.error), { autoConfig: 'storyboard' });
      run.generation = { provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort };
      ownerProject.storyboardGeneration = { ...run.generation };
      ownerProject.workflowProgress = createInitialWorkflowProgress({ runId: run.runId, projectId: run.projectId, inputChars: inputScript.length, ...run.generation });
      persistWorkflowProgress(ownerProject); updateWorkflowProgressPanel(); updateCodexTextStatusView();
    }
    if (pipeline) {
      await refreshCodexImageStatus();
      if (!isCurrentRun() || !isCurrentAutoPipelineRun(pipeline)) return;
      if (!isCodexImageReady()) throw Object.assign(new Error(codexImageStatus.error || '一键全流程需要可用的 GPT 订阅生图，请先检查 Codex 安装和 ChatGPT 登录。'), { autoConfig: 'images' });
      if (!updateAutoPipelinePhase(pipeline, 'storyboard')) return;
    }
    run.unsubscribe = window.storyforgeAI.onWorkflowProgress?.((value) => {
      if (!isCurrentRun() || workflowRun !== run) return;
      const progress = normalizeWorkflowProgress(value);
      if (!progress || progress.runId !== run.runId || progress.projectId !== run.projectId || progress.sequence <= run.lastSequence) return;
      run.lastSequence = progress.sequence;
      ownerProject.workflowProgress = progress;
      const now = Date.now();
      const signature = `${progress.status}:${progress.phase}:${progress.requests.at(-1)?.phase || ''}`;
      if (signature !== run.lastPhase || now - run.lastPaintAt >= 1000) {
        updateWorkflowProgressPanel();
        run.lastPaintAt = now;
        run.lastPhase = signature;
      }
      if (progress.status !== 'running' || now - run.lastSavedAt >= 5000) {
        persistWorkflowProgress(ownerProject);
        run.lastSavedAt = now;
      }
    });
    run.timer = window.setInterval?.(() => {
      if (isCurrentRun() && workflowRun === run) updateWorkflowProgressPanel();
    }, 1000);
    const response = await window.storyforgeAI.generateWorkflow(inputScript, { runId: run.runId, projectId: run.projectId, stageSkills, ...(run.generation.provider === 'codex-subscription' ? run.generation : {}), ...(pipeline ? { autoRunToVideo: true } : {}) });
    if (!isCurrentRun()) return;
    const returnedProgress = normalizeWorkflowProgress(response.progress);
    if (returnedProgress && (!returnedProgress.runId || returnedProgress.runId === run.runId) && (!returnedProgress.projectId || returnedProgress.projectId === run.projectId)
      && returnedProgress.sequence >= run.lastSequence) ownerProject.workflowProgress = { ...returnedProgress, runId: run.runId, projectId: run.projectId };
    if (ownerProject.script !== inputScript) throw new Error('生成期间剧本文本已更改，请根据最新剧本重新生成。');
    const outputs = renderAIWorkflow(response.data, response.usage, response.model, run.generation);
    const partial = outputs.storyboard.auditSummary?.finalStatus === '部分通过（存在阻塞）';
    const auditIgnored = outputs.storyboard.auditSummary?.finalStatus === '审计未通过（已忽略）';
    const assetGeneration = createAssetGenerationState(outputs.assets.promptItems || []);
    const videoGeneration = { ...defaultProject.videoGeneration, items: [] };
    const aiGeneration = { provider: run.generation.provider, model: response.model || run.generation.model || 'deepseek-flash', reasoningEffort: response.reasoningEffort || run.generation.reasoningEffort || 'high', usage: response.usage || null, generatedAt: new Date().toISOString() };
    // Replace confirmed state only once every output has been prepared successfully.
    Object.assign(ownerProject, {
      outputs,
      completed: partial ? ['analysis'] : ['analysis', 'storyboard'],
      assetGeneration,
      videoGeneration,
      aiGeneration,
      activeStep: run.viewSequence === viewNavigationSequence ? partial ? 'storyboard' : 'assets' : ownerProject.activeStep,
      running: false,
      workflowError: '',
    });
    if (ownerProject.workflowProgress?.status === 'running') ownerProject.workflowProgress = finishWorkflowProgress(ownerProject.workflowProgress, 'completed');
    if (auditIgnored && ownerProject.workflowProgress) ownerProject.workflowProgress = normalizeWorkflowProgress({ ...ownerProject.workflowProgress, auditIgnored: true, repairCount: outputs.storyboard.auditSummary.repairCount });
    workflowRun = null;
    saveProject(); renderWithoutMovingPage();
    if (pipeline) {
      releaseWorkflowProgress(run);
      await continueAutoPipeline(pipeline);
    } else showToast(partial ? '已交付独立通过审计的生成块；受阻范围与所缺信息见第二步审计结果' : auditIgnored ? '已自动回炉一次，审计未通过已忽略；请在第三步生成或上传参考图' : storyboardUsesCustomSkill(outputs.storyboard) ? '分镜已按用户 Skill 完成文本审计，请在第三步生成或上传参考图' : '分镜已通过 Skill v2.1 文本审计，请在第三步生成或上传参考图');
  } catch (error) {
    if (!isCurrentRun()) return;
    const message = cleanRemoteError(error, `${storyboardProviderLabel(run.generation)} 生成失败`);
    ownerProject.running = false;
    if (run.viewSequence === viewNavigationSequence) ownerProject.activeStep = previousActiveStep;
    ownerProject.workflowError = message;
    ownerProject.workflowProgress = finishWorkflowProgress(ownerProject.workflowProgress, 'failed', message);
    workflowRun = null;
    if (pipeline && isCurrentAutoPipelineRun(pipeline)) {
      ownerProject.autoPipeline = { ...ownerProject.autoPipeline, status: 'failed', error: message, finishedAt: Date.now() };
      autoPipelineRun = null;
    }
    saveProject(); renderWithoutMovingPage();
    showToast(message);
    if (error.autoConfig === 'images') openCodexImageSettings();
    else if (error.autoConfig === 'storyboard') openCodexTextSettings();
    else if (run.generation.provider === 'codex-subscription' && /登录|身份验证|鉴权|authentication|unauthorized|\b401\b/i.test(message)) openCodexTextSettings();
    else if (run.generation.provider !== 'codex-subscription' && /API Key|密钥|身份验证|鉴权|authentication|unauthorized|\b401\b/i.test(message)) {
      window.setTimeout(() => {
        if (ownerProject === project && token === generationRun) { openModelSettings(); setModelMessage(message, 'error'); }
      }, 100);
    }
  } finally {
    releaseWorkflowProgress(run);
  }
}

function legacyVideoVersion(item) {
  if (!item || typeof item.localPath !== 'string' || !item.localPath.trim()) return null;
  return {
    id: 'video-legacy-1', number: 1,
    localPath: item.localPath, videoFileUrl: item.videoFileUrl || '',
    fileName: item.fileName || '', remoteVideoUrl: item.remoteVideoUrl || '',
    taskId: item.taskId || '', generatedAt: item.generatedAt || '',
    duration: item.duration, usage: item.usage || null,
    model: item.model || '', ratio: item.ratio || '', resolution: item.resolution || '',
    generateAudio: item.generateAudio, prompt: item.prompt || '',
  };
}

function getSelectedVideoVersion(item) {
  const versions = Array.isArray(item?.versions) ? item.versions.filter((version) => typeof version?.localPath === 'string' && version.localPath.trim()) : [];
  return versions.find((version) => version.id === item.selectedVersionId) || versions[versions.length - 1] || legacyVideoVersion(item);
}

function normalizeVideoItemVersions(savedItem) {
  const item = savedItem && typeof savedItem === 'object' ? savedItem : {};
  const versions = [];
  const paths = new Set();
  const ids = new Set();
  const source = Array.isArray(item.versions) ? item.versions : [];
  for (const candidate of source) {
    if (typeof candidate?.localPath !== 'string' || !candidate.localPath.trim()) continue;
    const pathKey = candidate.localPath.replaceAll('\\', '/').toLowerCase();
    if (paths.has(pathKey)) continue;
    const number = versions.length + 1;
    let id = typeof candidate.id === 'string' && candidate.id ? candidate.id : `video-version-${number}`;
    if (ids.has(id)) id = `${id}-${number}`;
    paths.add(pathKey); ids.add(id);
    versions.push({ ...candidate, id, number, localPath: candidate.localPath });
  }
  const legacy = legacyVideoVersion(item);
  if (legacy && !paths.has(legacy.localPath.replaceAll('\\', '/').toLowerCase())) {
    const number = versions.length + 1;
    let id = versions.length ? `video-legacy-${number}` : legacy.id;
    if (ids.has(id)) id = `${id}-${number}`;
    versions.push({ ...legacy, id, number });
  }
  const latest = versions[versions.length - 1];
  return {
    ...item,
    versions,
    selectedVersionId: versions.some((version) => version.id === item.selectedVersionId) ? item.selectedVersionId : latest?.id || '',
    localPath: item.localPath || latest?.localPath || '',
    videoFileUrl: item.videoFileUrl || (item.localPath && item.localPath !== latest?.localPath ? '' : latest?.videoFileUrl) || '',
  };
}

function appendVideoVersion(savedItem, saved, metadata = {}) {
  if (typeof saved?.localPath !== 'string' || !saved.localPath.trim()) throw new Error('视频未保存到本机，本次生成未计入版本。');
  const item = normalizeVideoItemVersions(savedItem);
  const pathKey = saved.localPath.replaceAll('\\', '/').toLowerCase();
  const existing = item.versions.find((version) => version.localPath.replaceAll('\\', '/').toLowerCase() === pathKey
    || (metadata.taskId && version.taskId === metadata.taskId));
  if (existing) return { ...item, status: 'success', error: '', selectedVersionId: existing.id };
  const number = item.versions.length + 1;
  const idBase = metadata.taskId ? `video-task-${metadata.taskId}` : `video-version-${number}`;
  const id = item.versions.some((version) => version.id === idBase) ? `${idBase}-${number}` : idBase;
  const version = {
    id, number,
    localPath: saved.localPath, videoFileUrl: saved.videoFileUrl || '',
    fileName: saved.fileName || item.fileName || '',
    remoteVideoUrl: saved.remoteVideoUrl || metadata.remoteVideoUrl || '',
    taskId: metadata.taskId || saved.taskId || '',
    generatedAt: metadata.generatedAt || new Date().toISOString(),
    provider: metadata.provider || 'seedance', actualDuration: metadata.actualDuration,
    duration: metadata.duration, usage: metadata.usage || null,
    model: metadata.model || '', ratio: metadata.ratio || '', resolution: metadata.resolution || '',
    generateAudio: metadata.generateAudio, prompt: metadata.prompt || '',
  };
  const { id: versionId, number: versionNumber, ...latestFields } = version;
  return {
    ...item, ...saved, ...latestFields,
    versions: [...item.versions, version], selectedVersionId: id,
    status: 'success', error: '',
  };
}

function initializeVideoGeneration(prompts) {
  project.videoGeneration = {
    status: 'pending',
    provider: activeVideoProvider(),
    model: currentVideoSettings().model,
    ratio: currentVideoSettings().ratio,
    resolution: currentVideoSettings().resolution,
    duration: currentVideoSettings().duration,
    generationMode: normalizeSeedanceGenerationMode(currentVideoSettings().generationMode),
    generateAudio: currentVideoSettings().generateAudio,
    outputDirectory: '',
    generatedCount: 0,
    totalCount: prompts.length,
    lastError: '',
    pendingCertification: null,
    items: prompts.map((prompt, index) => ({
      fileName: `镜头-${String(index + 1).padStart(2, '0')}.mp4`,
      duration: storyboardShotDuration(index, prompt, currentVideoSettings().duration),
      status: 'pending',
      taskId: '',
      localPath: '',
      videoFileUrl: '',
      remoteVideoUrl: '',
      error: '',
      versions: [],
      selectedVersionId: '',
    })),
  };
  return project.videoGeneration;
}

function alignVideoGenerationItems(prompts) {
  const state = project.videoGeneration || initializeVideoGeneration(prompts);
  const current = Array.isArray(state.items) ? state.items : [];
  state.items = prompts.map((prompt, index) => normalizeVideoItemVersions({
    fileName: current[index]?.fileName || `镜头-${String(index + 1).padStart(2, '0')}.mp4`,
    duration: videoItemDuration(index, prompt, current[index], current[index]?.status === 'success' ? state.duration : state.duration || seedanceStatus.duration),
    status: current[index]?.status || 'pending',
    taskId: current[index]?.taskId || '',
    taskProvider: current[index]?.taskProvider || '',
    taskMetadata: current[index]?.taskMetadata || null,
    localPath: current[index]?.localPath || '',
    videoFileUrl: current[index]?.videoFileUrl || '',
    remoteVideoUrl: current[index]?.remoteVideoUrl || '',
    error: current[index]?.error || '',
    generatedAt: current[index]?.generatedAt || '',
    usage: current[index]?.usage || null,
    versions: Array.isArray(current[index]?.versions) ? current[index].versions : [],
    selectedVersionId: current[index]?.selectedVersionId || '',
    referenceBindings: current[index]?.referenceBindings && typeof current[index].referenceBindings === 'object' ? current[index].referenceBindings : {},
    ...(Array.isArray(current[index]?.originalReferenceUploads) ? { originalReferenceUploads: current[index].originalReferenceUploads } : {}),
    ...(current[index]?.referenceFormat ? { referenceFormat: current[index].referenceFormat } : {}),
    ...(typeof current[index]?.promptOverride === 'string' ? { promptOverride: current[index].promptOverride } : {}),
    ...(current[index]?.promptEditedAt ? { promptEditedAt: current[index].promptEditedAt } : {}),
  }));
  state.totalCount = prompts.length;
  state.generatedCount = state.items.filter((item) => getSelectedVideoVersion(item)).length;
  project.videoGeneration = state;
  reconcilePortraitCertification(state);
  return state;
}

function prepareSeedancePrompt(prompt, shotIndex) {
  const shot = project.outputs.storyboard?.shots?.[shotIndex] || {};
  const item = project.videoGeneration?.items?.[shotIndex] || {};
  const build = activeVideoProvider() === 'comfy' ? buildH3ReferenceRequest : buildSeedanceReferenceRequest;
  return build({
    prompt,
    shot,
    assetItems: project.assetGeneration?.items || [],
    savedBindings: item.referenceBindings || {},
    unifiedSuffix: project.outputs.storyboard?.unifiedSuffix || '',
  });
}

function isPortraitSafetyError(message) {
  return /may contain (?:a )?real person|input image.*real person|真人(?:素材|人像|肖像)|肖像.*(?:认证|授权|拦截)/i.test(String(message || ''));
}

function blockedPortraitInputs(message, prepared) {
  const indexes = [...String(message || '').matchAll(/content\[(\d+)\]/gi)]
    .map((match) => Number(match[1]))
    .filter((value, index, list) => value > 0 && list.indexOf(value) === index);
  const contentIndexes = indexes.length ? indexes : prepared.imageInputs.map((_input, index) => index + 1);
  return contentIndexes
    .map((contentIndex) => {
      const input = prepared.imageInputs[contentIndex - 1];
      return input ? { ...input, contentIndex } : null;
    })
    .filter(Boolean);
}

async function pollSeedanceTask(taskId, token, state, index, ownerProject = project) {
  const isCurrent = () => token === generationRun && project === ownerProject && ownerProject.videoGeneration === state;
  let transientFailures = 0;
  const comfy = state.provider === 'comfy';
  for (let attempt = 0; attempt < (comfy ? 720 : 180); attempt += 1) {
    if (!isCurrent()) return null;
    if (attempt > 0) await wait(10000);
    if (!isCurrent()) return null;
    try {
      const task = await (comfy ? window.storyforgeAI.getComfyVideoTask(taskId) : window.storyforgeAI.getSeedanceTask(taskId));
      if (!isCurrent()) return null;
      transientFailures = 0;
      const remoteStatus = task.status === 'pending' ? 'queued' : task.status;
      const displayStatus = ['succeeded', 'success'].includes(remoteStatus) ? 'downloading' : remoteStatus;
      state.items[index] = { ...state.items[index], status: displayStatus, remoteVideoUrl: task.videoUrl || '', usage: task.usage || null };
      saveProject(); renderWithoutMovingPage();
      if (remoteStatus === 'succeeded' || (remoteStatus === 'success' && task.videoUrl)) return task;
      if (remoteStatus === 'failed') { const error = new Error(task.error || '视频任务失败。'); error.terminal = true; throw error; }
    } catch (error) {
      if (!isCurrent()) return null;
      transientFailures += 1;
      if (error.terminal || transientFailures >= 3 || /任务失败|无效|权限|额度|余额|尚未开通/.test(String(error?.message || ''))) throw error;
    }
  }
  throw new Error(comfy ? 'H3 等待超过2小时，任务编号已保留，可稍后继续查询。' : 'Seedance 视频任务等待超过 30 分钟，请稍后重试或到火山方舟控制台查看。');
}

async function generateSeedanceVideos({ token, indexes = null, force = false, mode = null, stopOnFailure = false, pipelineRun = null, viewSequence = viewNavigationSequence }) {
  const ownerProject = project;
  const videoFocus = pipelineRun || { ownerProject: project, viewSequence };
  const prompts = project.outputs.storyboard?.prompts || [];
  if (!prompts.length) return showToast('第二步还没有可生成的视频分镜');
  const provider = activeVideoProvider();
  const settings = { ...currentVideoSettings() };
  const comfy = provider === 'comfy';
  if (!window.storyforgeAI || !settings.configured || (comfy && !window.storyforgeAI.createComfyVideoTask)) {
    project.running = false;
    focusGenerationStep('video', videoFocus);
    saveProject(); renderWithoutMovingPage();
    openSeedanceSettings();
    if (comfy) setComfyVideoMessage('请先配置仙宫云 ComfyUI 访问地址。', 'error');
    else setSeedanceMessage('请先配置火山方舟 API Key。保存后即可开始第四步。', 'error');
    return;
  }
  if (!project.outputs.video) project.outputs.video = makeOutput('video');
  const state = alignVideoGenerationItems(prompts);
  const isCurrent = () => token === generationRun && project === ownerProject && ownerProject.videoGeneration === state;
  state.provider = provider;
  state.model = settings.model || (comfy ? 'MiniMax-H3-Base-Ref2VA' : SEEDANCE_DEFAULT_MODEL);
  state.ratio = settings.ratio;
  state.resolution = settings.resolution;
  state.duration = settings.duration;
  state.generationMode = normalizeSeedanceGenerationMode(mode || settings.generationMode);
  state.generateAudio = settings.generateAudio;
  state.lastError = '';
  const selection = selectSeedanceGenerationIndexes(state.items, { indexes, force, mode: state.generationMode });
  if (!selection.candidates.length) return showToast('所有分镜视频都已经生成');
  const emptyPromptIndex = selection.requested.find((index) => !effectiveVideoPrompt(index, prompts[index], state).trim());
  if (Number.isInteger(emptyPromptIndex)) return showToast(`镜头 ${String(emptyPromptIndex + 1).padStart(2, '0')} 的视频生成提示词不能为空`);
  const shortBlockIndexes = storyboardUsesSkill21() ? selection.requested.filter((index) => storyboardShotDuration(index, prompts[index], state.duration) < 4) : [];
  if (shortBlockIndexes.length) {
    project.running = false;
    focusGenerationStep('video', videoFocus);
    state.lastError = `生成块 ${shortBlockIndexes.map((index) => String(project.outputs.storyboard.shots?.[index]?.no || index + 1).padStart(2, '0')).join('、')} 的自然时长不足4秒。Seedance 当前仅接受4—15秒，请按 Skill 合理重分块并重新审计后再生成；程序不会自动补空镜、加速或拉长。`;
    saveProject(); renderWithoutMovingPage();
    return showToast(state.lastError);
  }
  for (const index of selection.requested) {
    const prompt = effectiveVideoPrompt(index, prompts[index], state);
    const plan = resolveStrictReferencePlan({
      prompt,
      shot: project.outputs.storyboard?.shots?.[index] || {},
      assetItems: project.assetGeneration?.items || [],
      savedBindings: state.items[index]?.referenceBindings || {},
    });
    if (!plan.valid) {
      project.running = false;
      focusGenerationStep('video', videoFocus);
      state.lastError = `镜头 ${String(index + 1).padStart(2, '0')}：${plan.errors[0] || '参考图绑定不完整。'}`;
      saveProject(); renderWithoutMovingPage();
      showToast(state.lastError);
      return;
    }
  }
  if (state.pendingCertification && selection.requested.includes(Number(state.pendingCertification.shotIndex))) {
    const rejectedItem = state.items[Number(state.pendingCertification.shotIndex)];
    state.pendingCertification = null;
    resetVideoItemAfterReferenceChange(rejectedItem, state);
  }
  if (force) {
    for (const index of selection.reset) state.items[index] = { ...state.items[index], status: 'pending', taskId: '', error: '' };
  }
  const requested = selection.requested;
  if (!state.items.length || state.items.some((item) => !getSelectedVideoVersion(item))) project.completed = project.completed.filter((id) => id !== 'video');
  focusGenerationStep('video', videoFocus);
  project.running = true;
  state.status = 'running';
  if (!pipelineRun) project.autoPipeline = null;
  saveProject(); renderWithoutMovingPage();

  let certificationTriggered = false;
  for (let requestPosition = 0; requestPosition < requested.length; requestPosition += 1) {
    const index = requested[requestPosition];
    if (!isCurrent()) return;
    const promptForGeneration = effectiveVideoPrompt(index, prompts[index], state);
    let prepared;
    const duration = storyboardShotDuration(index, prompts[index], state.duration);
    try {
      prepared = prepareSeedancePrompt(promptForGeneration, index);
      const requestMetadata = {
        provider, model: state.model, ratio: state.ratio, resolution: state.resolution,
        generateAudio: state.generateAudio, duration, prompt: prepared.prompt,
      };
      const previousTask = state.items[index];
      const resume = comfy && previousTask.taskProvider === 'comfy' && previousTask.taskId;
      const handle = resume || (comfy ? `comfy-${globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); })}` : '');
      // Save a known handle before crossing IPC. A stopped/reloaded UI must not
      // submit a second task just because the first submission response is late.
      state.items[index] = { ...previousTask, duration, status: 'creating', taskId: handle, taskProvider: provider, taskMetadata: comfy ? (resume ? previousTask.taskMetadata : requestMetadata) : null, error: '' };
      saveProject(); renderWithoutMovingPage();
      const create = comfy ? window.storyforgeAI.createComfyVideoTask : window.storyforgeAI.createSeedanceTask;
      const created = resume ? { id: previousTask.taskId, status: 'queued' } : await create({
        ...(comfy ? { taskId: handle } : {}),
        model: state.model,
        prompt: prepared.prompt,
        imageInputs: prepared.imageInputs,
        imagePaths: prepared.imagePaths,
        ratio: state.ratio,
        resolution: state.resolution,
        duration,
        generateAudio: state.generateAudio,
      });
      if (comfy && state.items[index]?.taskId === handle) {
        state.items[index] = { ...state.items[index], taskId: created.id, taskProvider: 'comfy', taskMetadata: resume ? previousTask.taskMetadata : { ...requestMetadata, model: created.model || requestMetadata.model, actualDuration: created.actualDuration } };
        saveProjectLibrary();
      }
      if (!isCurrent()) return;
      state.items[index] = { ...state.items[index], status: created.status === 'running' ? 'running' : 'queued', taskId: created.id };
      saveProject(); renderWithoutMovingPage();
      const task = await pollSeedanceTask(created.id, token, state, index, ownerProject);
      if (!task || !isCurrent()) return;
      state.items[index] = { ...state.items[index], status: 'downloading', remoteVideoUrl: task.videoUrl };
      saveProject(); renderWithoutMovingPage();
      const download = comfy ? window.storyforgeAI.downloadComfyVideo : window.storyforgeAI.downloadSeedanceVideo;
      const saved = await download({
        taskId: created.id,
        projectId: ownerProject.id,
        projectTitle: ownerProject.title,
        fileName: `镜头-${String(index + 1).padStart(2, '0')}.mp4`,
        index,
      });
      if (!isCurrent()) return;
      state.items[index] = appendVideoVersion(state.items[index], saved, {
        ...(comfy ? state.items[index].taskMetadata || requestMetadata : requestMetadata), taskId: created.id, remoteVideoUrl: task.videoUrl,
        ...(comfy ? { model: task.model || state.items[index].taskMetadata?.model || state.model, actualDuration: task.actualDuration || state.items[index].taskMetadata?.actualDuration } : {}),
        usage: task.usage || state.items[index].usage || null,
        generatedAt: new Date().toISOString(),
      });
      state.outputDirectory = saved.outputDirectory || state.outputDirectory;
    } catch (error) {
      if (!isCurrent()) return;
      const message = cleanRemoteError(error, 'Seedance 视频生成失败');
      const blockedInputs = !comfy && isPortraitSafetyError(message) && prepared ? blockedPortraitInputs(message, prepared) : [];
      if (blockedInputs.length) {
        state.items[index] = { ...state.items[index], status: 'certification', error: '参考图可能包含真人，请完成方舟真人素材认证；保存 Asset ID 后将自动继续生成。' };
        state.pendingCertification = {
          shotIndex: index,
          blockedInputs,
          resumeIndexes: requested.slice(requestPosition),
          mode: state.generationMode,
          detectedAt: new Date().toISOString(),
        };
        certificationTriggered = true;
      } else {
        state.items[index] = { ...state.items[index], status: 'failed', error: message };
        if (/尚未开通|API Key 无效|没有.*权限|额度不足|余额不足/.test(message)) state.lastError = message;
      }
    }
    state.generatedCount = state.items.filter((item) => getSelectedVideoVersion(item)).length;
    saveProject(); renderWithoutMovingPage();
    if (state.lastError || certificationTriggered || (stopOnFailure && state.items[index]?.status === 'failed')) break;
  }

  if (!isCurrent()) return;
  const failed = state.items.filter((item) => item.status === 'failed').length;
  const allComplete = state.items.length === prompts.length && state.items.every((item) => getSelectedVideoVersion(item));
  state.status = certificationTriggered ? 'awaiting-certification' : failed ? 'partial' : allComplete ? 'complete' : state.generationMode === 'confirm' ? 'awaiting-confirmation' : 'pending';
  state.generatedCount = state.items.filter((item) => getSelectedVideoVersion(item)).length;
  project.running = false;
  if (allComplete && !project.completed.includes('video')) project.completed.push('video');
  saveProject(); renderWithoutMovingPage();
  const generatedIndex = requested[requested.length - 1];
  const nextIndex = state.items.findIndex((item) => item.status !== 'success');
  const resultMessage = allComplete && !failed && !certificationTriggered
    ? `${comfy ? '仙宫云 H3' : 'Seedance'} 已生成并保存 ${state.generatedCount} 个视频镜头`
    : certificationTriggered
      ? `镜头 ${String(Number(state.pendingCertification?.shotIndex || 0) + 1).padStart(2, '0')} 需要真人素材认证，完成后会自动继续`
    : state.lastError
      || (state.generationMode === 'confirm' && state.items[generatedIndex]?.status === 'success'
        ? `镜头 ${String(generatedIndex + 1).padStart(2, '0')} 已保存，请确认后生成镜头 ${String(nextIndex + 1).padStart(2, '0')}`
        : `已生成 ${state.generatedCount} 个，${failed} 个失败，可单独重试`);
  showToast(resultMessage);
  if (certificationTriggered && project.activeStep === 'video') openPortraitCertificationModal();
}

async function generateVideoStage(token, force = false) {
  return generateSeedanceVideos({ token, force, mode: 'batch' });
}

async function openVideoOutputFolder() {
  try { await window.storyforgeAI.openSeedanceOutput(project.videoGeneration?.outputDirectory); }
  catch (error) { showToast(cleanRemoteError(error, '无法打开视频文件夹')); }
}

async function showGeneratedVideo(index) {
  const filePath = getSelectedVideoVersion(project.videoGeneration?.items?.[index])?.localPath;
  try { await window.storyforgeAI.showSeedanceVideo(filePath); }
  catch (error) { showToast(cleanRemoteError(error, '无法找到这个视频')); }
}

function wait(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

function readFile(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader(); reader.onload = () => { project.script = reader.result; project.title = deriveTitle(project.script); saveProject(); render(); showToast(`已导入 ${file.name}`); }; reader.readAsText(file);
}

function copyOutput() {
  const output = project.outputs[project.activeStep];
  if (!output) return showToast('当前还没有生成结果');
  if (project.activeStep === 'storyboard' && storyboardUsesSkill21()) {
    const prompts = output.prompts || [];
    if (!prompts.length) return showToast('当前没有可复制的分镜正文');
    return copyText(prompts.join('\n\n'), output.auditSummary?.finalStatus === '审计未通过（已忽略）' ? '已复制分镜正文；审计失败已忽略' : storyboardUsesCustomSkill(output) ? '已复制用户 Skill 分镜正文' : '已复制通过审计的分镜正文');
  }
  const plain = `${output.title}\n${output.subtitle}\n\n${document.querySelector('.result-body')?.innerText || ''}`;
  copyText(plain, '当前结果已复制');
}

function copyText(value, message) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(() => showToast(message)).catch(() => fallbackCopy(value, message));
    return;
  }
  fallbackCopy(value, message);
}

function fallbackCopy(value, message) {
  const area = document.createElement('textarea');
  area.value = value; area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); showToast(message);
}

function exportProject() {
  const payload = JSON.stringify({ ...project, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${project.title || 'storyforge-project'}.json`; link.click(); URL.revokeObjectURL(link.href); showToast('项目包已导出');
}

function importProject(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!incoming || typeof incoming !== 'object' || typeof incoming.script !== 'string') throw new Error('invalid project');
      stopCurrentGeneration();
      project = normalizeProject({
        ...incoming,
        id: createProjectId(),
        createdAt: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
        running: false,
        completed: Array.isArray(incoming.completed) ? incoming.completed.filter((id) => steps.some((step) => step.id === id)) : [],
        outputs: incoming.outputs && typeof incoming.outputs === 'object' ? incoming.outputs : {},
      });
      projectLibrary.projects.push(project);
      projectLibrary.activeProjectId = project.id;
      saveProject(); render(); showToast(`已导入项目：${project.title}`);
    } catch { showToast('项目文件格式不正确'); }
    event.target.value = '';
  };
  reader.readAsText(file);
}

function showToast(message) {
  const node = document.querySelector('#toast'); if (!node) return;
  node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
}

render();
refreshDeepSeekStatus();
refreshCodexTextStatus();
refreshSeedreamStatus();
refreshOpenAIImageStatus();
refreshSeedanceStatus();
refreshComfyVideoStatus();
refreshCodexImageStatus();
