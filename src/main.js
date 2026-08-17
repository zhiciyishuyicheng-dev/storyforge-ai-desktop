import './style.css';
import { normalizeSeedanceDuration, resolveSeedanceDuration } from './seedance-duration.js';
import { normalizeSeedanceGenerationMode, selectSeedanceGenerationIndexes } from './seedance-generation.js';
import { buildSeedanceReferenceRequest, ensureStoryboardShot, extractImageReferenceNumbers, normalizeImageReferenceSequence, resolveStrictReferencePlan } from './seedance-references.js';

const LEGACY_STORAGE_KEY = 'storyforge-project-v1';
const LIBRARY_STORAGE_KEY = 'storyforge-project-library-v1';
const IMAGE_PROVIDER_STORAGE_KEY = 'storyforge-image-provider-v1';
const LIBRARY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 5;
// 暂时关闭 Seedream / GPT Image 模型生图，第五步统一使用本地参考图上传。
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
  { id: 'episodes', no: '02', label: '分集大纲', icon: '▤', sub: '节奏与悬念' },
  { id: 'script', no: '03', label: '短剧剧本', icon: '✎', sub: '场次与对白' },
  { id: 'storyboard', no: '04', label: '分镜脚本', icon: '▦', sub: '镜头与动作' },
  { id: 'assets', no: '05', label: '视觉素材', icon: '✦', sub: '角色与场景' },
  { id: 'video', no: '06', label: '视频生成', icon: '▶', sub: 'Seedance 镜头' },
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
let deepseekStatus = { configured: false, model: 'deepseek-v4-pro', checking: true };
let seedreamStatus = { configured: false, model: SEEDREAM_DEFAULT_MODEL, size: SEEDREAM_DEFAULT_SIZE, models: SEEDREAM_MODELS, checking: true };
let openAIImageStatus = { configured: false, model: OPENAI_IMAGE_MODEL, size: OPENAI_IMAGE_DEFAULT_SIZE, quality: OPENAI_IMAGE_DEFAULT_QUALITY, sizes: OPENAI_IMAGE_SIZES, qualities: OPENAI_IMAGE_QUALITIES, checking: true };
let seedanceStatus = { configured: false, model: SEEDANCE_DEFAULT_MODEL, ratio: SEEDANCE_DEFAULT_RATIO, resolution: SEEDANCE_DEFAULT_RESOLUTION, duration: SEEDANCE_DEFAULT_DURATION, generationMode: SEEDANCE_DEFAULT_GENERATION_MODE, generateAudio: true, models: SEEDANCE_MODELS, ratios: SEEDANCE_RATIOS, resolutions: SEEDANCE_RESOLUTIONS, durations: SEEDANCE_DURATIONS, checking: true };
let imageProvider = loadImageProvider();
let imageProviderDraft = imageProvider;
let seedanceGenerationModeDraft = SEEDANCE_DEFAULT_GENERATION_MODE;
let customAssetTargetShotIndex = null;

function createProject(overrides = {}) {
  const now = new Date().toISOString();
  return {
    ...defaultProject,
    seedanceMaterials: { ...defaultProject.seedanceMaterials },
    assetGeneration: { ...defaultProject.assetGeneration, items: [] },
    videoGeneration: { ...defaultProject.videoGeneration, items: [] },
    ...overrides,
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
  migrated.completed = Array.isArray(saved?.completed) ? saved.completed.filter((id) => steps.some((step) => step.id === id)) : [];
  migrated.outputs = saved?.outputs && typeof saved.outputs === 'object' ? saved.outputs : {};
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
    items: Array.isArray(saved?.videoGeneration?.items) ? saved.videoGeneration.items : [],
  };
  if (migrated.outputs.video?.body?.includes('video-preview')) {
    migrated.outputs.video = { title: 'Seedance 分镜视频', subtitle: '按第四步分镜逐条生成并保存 MP4', time: '数分钟 / 镜头', body: '' };
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
  if (saved?.schemaVersion !== SCHEMA_VERSION) {
    migrated.outputs = {};
    migrated.completed = [];
    migrated.activeStep = 'analysis';
    delete migrated.aiGeneration;
  }
  migrated.schemaVersion = SCHEMA_VERSION;
  migrated.running = false;
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

function seedanceModelLabel(modelId = seedanceStatus.model) {
  return SEEDANCE_MODELS.find((item) => item.id === modelId)?.label || 'Seedance 2.0';
}

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
    ? '正在自动生成...'
    : project.activeStep === 'video'
      ? (project.outputs.video ? '重新生成视频' : '开始生成视频')
      : (project.completed.length ? '重新生成到参考图' : '开始生成前四步');
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
          <div class="script-input-wrap ${project.script ? 'has-content' : ''}"><textarea id="scriptInput" placeholder="把小说改编后的剧本粘贴到这里...\n\n建议包含：集数、场景、人物和对白。${project.script ? '' : '\n\n还没有剧本？试试下方示例。'}">${esc(project.script)}</textarea><div class="textarea-footer"><span>${project.script.length ? `${project.script.length} 字` : '0 字'}</span><label class="upload-link" for="fileInput">↑ 导入文件</label><input type="file" id="fileInput" accept=".txt,.md" hidden /></div></div>
          <div class="sidebar-input-actions"><button class="sample-link" id="useDemo">加载示例 <span>↗</span></button><button class="primary-button" id="startGenerate" ${project.running ? 'disabled' : ''}><span class="sparkle">✦</span> ${generateLabel} <span>→</span></button></div>
          <p class="auto-flow-note">前四步生成文案与分镜，第五步上传本地参考图，第六步由 Seedance 生成视频</p>
        </section>
        <div class="sidebar-bottom">
          <button class="account" id="openSettings"><div class="avatar">深</div><div><b>DeepSeek V4 Pro</b><small>${deepseekStatus.configured ? '模型已连接' : '需要配置 API Key'}</small></div><span class="settings">⚙</span></button>
          <div class="account seedream-account local-assets-account"><div class="avatar seedream-avatar">图</div><div><b>本地参考图</b><small>第五步按角色和场景上传</small></div><span class="settings">本地</span></div>
          <button class="account seedance-account" id="openSeedanceSettings"><div class="avatar seedance-video-avatar">视</div><div><b>${esc(videoModelName)}</b><small>${seedanceStatus.configured ? `${esc(seedanceStatus.ratio)} · ${esc(seedanceStatus.resolution)} · ${seedanceStatus.generationMode === 'confirm' ? '逐镜确认' : '批量连续'}` : '需要配置火山方舟 API Key'}</small></div><span class="settings">⚙</span></button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar"><div class="breadcrumbs"><span>工作台</span><i>/</i><b>${esc(project.title)}</b></div><div class="top-actions"><span class="saved"><span class="saved-dot"></span> 已自动保存</span><button class="icon-button" title="字体缩放：Ctrl + / Ctrl - / Ctrl 0">A</button><button class="transfer-button" id="importProject">导入项目</button><button class="export-button" id="exportProject">导出项目 <span>↓</span></button><input type="file" id="projectFileInput" accept=".json,application/json" hidden /></div></header>
        <section class="hero"><div><div class="eyebrow">AI SHORT DRAMA STUDIO</div><h1>把故事，变成一部短剧。</h1><p>DeepSeek 生成剧本与分镜，第五步上传本地参考图，Seedance 2.0 支持逐镜或批量生成视频。</p></div><div class="hero-meta"><button class="status-pill model-status ${deepseekStatus.configured ? 'connected' : 'disconnected'}" id="heroModelStatus"><i></i> ${deepseekStatus.checking ? '正在检查模型' : deepseekStatus.configured ? 'DeepSeek 已连接' : '配置 DeepSeek'}</button><span class="status-pill model-status connected"><i></i> 本地参考图模式</span><button class="status-pill model-status ${seedanceStatus.configured ? 'connected' : 'disconnected'}" id="heroSeedanceStatus"><i></i> ${seedanceStatus.checking ? '正在检查视频模型' : seedanceStatus.configured ? `${esc(videoModelName)} 已连接` : '配置 Seedance'}</button><span class="updated">${project.updatedAt ? '本机已保存' : '等待输入'}</span></div></section>
        <section class="output-card card"><div class="card-head output-head"><div><span class="section-kicker">OUTPUT</span><h2>生成结果</h2></div><div class="output-tools"><button class="small-button" id="clearOutput">清空结果</button><button class="small-button" id="copyOutput">复制当前结果</button></div></div><div id="outputArea">${outputTemplate()}</div></section>
      </main>
      <div class="modal-backdrop" id="settingsModal" hidden><div class="settings-modal"><div class="modal-head"><div><span class="section-kicker">MODEL SETTINGS</span><h2>DeepSeek 模型设置</h2></div><button id="closeSettings">×</button></div><div class="model-lock"><span>固定模型</span><b>DeepSeek V4 Pro</b><small>视频生成前的故事分析、分集大纲、剧本、分镜和视觉素材全部使用此模型。</small></div><label class="key-field"><span>DeepSeek API Key</span><input id="deepseekKey" type="password" placeholder="sk-..." autocomplete="off"><small>密钥使用 Windows 本机加密保存，不会写入项目或安装包。</small></label><div class="modal-message" id="modelMessage"></div><div class="modal-actions"><button class="outline-button" id="testDeepSeek">测试连接</button><button class="primary-button" id="saveDeepSeek">保存设置</button></div><a class="key-help" href="https://platform.deepseek.com/api_keys" target="_blank">前往 DeepSeek 平台创建 API Key ↗</a></div></div>
      <div class="modal-backdrop" id="imageSettingsModal" hidden><div class="settings-modal image-settings-modal"><div class="modal-head"><div><span class="section-kicker">IMAGE MODEL SETTINGS</span><h2>第五步生图设置</h2></div><button id="closeImageSettings">×</button></div><div class="image-provider-switch" role="tablist" aria-label="生图渠道"><button class="${imageProviderDraft === 'seedream' ? 'active' : ''}" data-image-provider="seedream" role="tab" aria-selected="${imageProviderDraft === 'seedream'}">Seedream 5.0</button><button class="${imageProviderDraft === 'openai' ? 'active' : ''}" data-image-provider="openai" role="tab" aria-selected="${imageProviderDraft === 'openai'}">GPT Image 2</button></div><div class="provider-panel" data-provider-panel="seedream" ${imageProviderDraft === 'seedream' ? '' : 'hidden'}><div class="model-lock seedream-lock"><span>火山方舟生图</span><b>Seedream 5.0</b><small>逐张生成角色、场景和道具参考图，并保存到“文档/StoryForge/项目名/项目编号/视觉素材”。</small></div><label class="key-field"><span>火山方舟 API Key</span><input id="seedreamKey" type="password" placeholder="输入 ARK_API_KEY" autocomplete="off"><small>${seedreamStatus.configured ? '密钥已加密保存；留空可只修改模型和尺寸。' : '密钥使用 Windows 本机加密保存，不会写入项目或安装包。'}</small></label><label class="key-field"><span>图片模型</span><select id="seedreamModel">${SEEDREAM_MODELS.map((item) => `<option value="${item.id}" ${item.id === seedreamStatus.model ? 'selected' : ''}>${item.label}${item.pricePerImage ? ` · ¥${item.pricePerImage.toFixed(2)}/张` : ' · 需账号单独开通'}</option>`).join('')}</select><small>正式版和 Lite 都需要在火山方舟单独开通。</small></label><label class="key-field"><span>输出尺寸</span><select id="seedreamSize"><option value="2K" ${seedreamStatus.size === '2K' ? 'selected' : ''}>2K（推荐）</option><option value="4K" ${seedreamStatus.size === '4K' ? 'selected' : ''}>4K</option></select></label><div class="key-links"><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">开通 Seedream 模型服务 ↗</a><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?projectName=default" target="_blank">管理 API Key ↗</a></div></div><div class="provider-panel" data-provider-panel="openai" ${imageProviderDraft === 'openai' ? '' : 'hidden'}><div class="model-lock openai-image-lock"><span>OpenAI 生图</span><b>GPT Image 2</b><small>按参考图提示词生成 PNG 图片。复杂提示词最多可能需要约两分钟。</small></div><label class="key-field"><span>OpenAI API Key</span><input id="openAIImageKey" type="password" placeholder="sk-..." autocomplete="off"><small>${openAIImageStatus.configured ? '密钥已加密保存；留空可只修改尺寸和质量。' : '密钥使用 Windows 本机加密保存，不会写入项目或安装包。'}</small></label><label class="key-field"><span>输出尺寸</span><select id="openAIImageSize">${OPENAI_IMAGE_SIZES.map((item) => `<option value="${item.id}" ${item.id === openAIImageStatus.size ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label><label class="key-field"><span>图片质量</span><select id="openAIImageQuality">${OPENAI_IMAGE_QUALITIES.map((item) => `<option value="${item.id}" ${item.id === openAIImageStatus.quality ? 'selected' : ''}>${item.label}</option>`).join('')}</select><small>高质量耗时和费用更高；费用以 OpenAI 控制台为准。</small></label><div class="key-links"><a class="key-help" href="https://platform.openai.com/api-keys" target="_blank">创建 OpenAI API Key ↗</a><a class="key-help" href="https://platform.openai.com/settings/organization/general" target="_blank">组织与验证设置 ↗</a></div></div><div class="modal-message" id="imageMessage"></div><div class="modal-actions"><button class="outline-button" id="testImageProvider">测试连接（不生图）</button><button class="primary-button" id="saveImageProvider">保存并使用</button></div></div></div>
      <div class="modal-backdrop" id="seedanceSettingsModal" hidden><div class="settings-modal seedance-settings-modal"><div class="modal-head"><div><span class="section-kicker">VIDEO MODEL SETTINGS</span><h2>第六步视频设置</h2></div><button id="closeSeedanceSettings">×</button></div><div class="model-lock seedance-video-lock"><span>火山方舟视频生成</span><b>Seedance 2.0</b><small>每个镜头优先使用第四步分镜中的时长，按需生成 4 至 15 秒视频；第五步参考图会按 @Image 编号自动引用。</small></div><label class="key-field"><span>火山方舟 API Key</span><input id="seedanceKey" type="password" placeholder="输入 ARK_API_KEY" autocomplete="off"><small>${seedanceStatus.configured ? (seedanceStatus.inheritedKey ? '当前复用 Seedream 的火山方舟密钥；留空即可继续使用。' : '密钥已加密保存；留空可只修改视频参数。') : '可复用 Seedream 的同一个火山方舟 API Key。'}</small></label><div class="seedance-setting-grid"><label class="key-field"><span>视频模型</span><select id="seedanceModel">${SEEDANCE_MODELS.map((item) => `<option value="${item.id}" ${item.id === seedanceStatus.model ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label><label class="key-field"><span>画面比例</span><select id="seedanceRatio">${SEEDANCE_RATIOS.map((item) => `<option value="${item}" ${item === seedanceStatus.ratio ? 'selected' : ''}>${item}${item === '9:16' ? '（竖屏推荐）' : ''}</option>`).join('')}</select></label><label class="key-field"><span>分辨率</span><select id="seedanceResolution">${SEEDANCE_RESOLUTIONS.map((item) => `<option value="${item}" ${item === seedanceStatus.resolution ? 'selected' : ''}>${item}</option>`).join('')}</select></label><label class="key-field"><span>缺省时长</span><select id="seedanceDuration">${SEEDANCE_DURATIONS.map((item) => `<option value="${item}" ${item === seedanceStatus.duration ? 'selected' : ''}>${item} 秒</option>`).join('')}</select><small>仅在分镜没有有效时长时使用。</small></label></div><div class="video-generation-mode-field"><span>生成方式</span><div class="video-generation-mode" role="tablist" aria-label="视频生成方式"><button class="${seedanceStatus.generationMode === 'confirm' ? '' : 'active'}" data-seedance-generation-mode="batch" role="tab" aria-selected="${seedanceStatus.generationMode !== 'confirm'}"><b>批量连续</b><small>一次确认，按顺序生成全部镜头</small></button><button class="${seedanceStatus.generationMode === 'confirm' ? 'active' : ''}" data-seedance-generation-mode="confirm" role="tab" aria-selected="${seedanceStatus.generationMode === 'confirm'}"><b>逐镜确认</b><small>每个镜头完成后暂停，确认后再生成下一个</small></button></div></div><label class="toggle-field"><input id="seedanceGenerateAudio" type="checkbox" ${seedanceStatus.generateAudio ? 'checked' : ''}><span><b>生成同步音频</b><small>让 Seedance 同时生成对白、人声、环境音和配乐。</small></span></label><div class="key-links"><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">开通 Seedance 模型服务 ↗</a><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?projectName=default" target="_blank">管理 API Key ↗</a></div><div class="modal-message" id="seedanceMessage"></div><div class="modal-actions"><button class="outline-button" id="testSeedance">测试连接（不生视频）</button><button class="primary-button" id="saveSeedance">保存设置</button></div></div></div>
      <div class="modal-backdrop" id="customAssetModal" hidden><div class="settings-modal custom-asset-modal"><div class="modal-head"><div><span class="section-kicker">CUSTOM REFERENCE</span><h2>${Number.isInteger(customAssetTargetShotIndex) ? `为镜头 ${String(customAssetTargetShotIndex + 1).padStart(2, '0')} 添加参考图` : '添加遗漏资源'}</h2></div><button id="closeCustomAsset">×</button></div><div class="model-lock local-custom-lock"><span>${Number.isInteger(customAssetTargetShotIndex) ? '第六步镜头素材' : '第五步本地素材'}</span><b>创建自定义上传项</b><small>${Number.isInteger(customAssetTargetShotIndex) ? '填写名称并选择图片后，会自动创建新的 @Image 编号并绑定到当前镜头。' : '适合补充主持人、医生、秘书、额外场景或遗漏道具。创建后立即选择本地参考图片。'}</small></div><label class="key-field"><span>资源名称</span><input id="customAssetName" type="text" placeholder="例如：主持人" autocomplete="off"></label><label class="key-field"><span>资源类型</span><select id="customAssetType"><option value="人物参考图">人物</option><option value="场景参考图">场景</option><option value="群像参考图">群像</option><option value="道具参考图">道具</option><option value="其他参考图">其他</option></select></label><div class="modal-message" id="customAssetMessage"></div><div class="modal-actions"><button class="outline-button" id="cancelCustomAsset">取消</button><button class="primary-button" id="createCustomAsset">创建并上传图片</button></div></div></div>
      ${portraitCertificationModalTemplate()}
      <div class="toast" id="toast"></div>
    </div>`;
}

function stepTemplate(step) {
  const idx = steps.findIndex((item) => item.id === step.id);
  const done = project.completed.includes(step.id);
  const active = project.activeStep === step.id;
  const running = project.running && idx === currentIndex();
  return `<button class="step ${active ? 'active' : ''} ${done ? 'done' : ''} ${running ? 'running' : ''}" data-step="${step.id}"><span class="step-icon">${done ? '✓' : step.icon}</span><span class="step-copy"><b>${step.no}　${step.label}</b><small>${step.sub}</small></span>${running ? '<span class="loader"></span>' : done ? '<span class="done-mark">完成</span>' : '<span class="step-arrow">›</span>'}</button>`;
}

function assetGenerationTemplate(output) {
  const prompts = Array.isArray(output?.promptItems) ? output.promptItems : [];
  const state = alignAssetGenerationItems(prompts);
  const items = Array.isArray(state.items) ? state.items : [];
  const completed = items.filter((item) => Array.isArray(item.files) && item.files.length).length;
  const missing = Math.max(0, prompts.length - completed);
  const progress = prompts.length ? Math.round((completed / prompts.length) * 100) : 0;
  const statusText = missing ? `已上传 ${completed} / ${prompts.length} 项，还缺 ${missing} 项` : `全部 ${completed} 项参考图已准备完成`;
  const cards = prompts.map((prompt, index) => {
    const result = items[index] || { status: 'pending', files: [] };
    const files = Array.isArray(result.files) ? result.files : [];
    const trustedCount = files.filter((file) => file.trustedAssetId).length;
    const statusLabel = files.length ? `已上传 ${files.length} 张${trustedCount ? ` · 已认证 ${trustedCount} 张` : ''}` : '等待上传';
    const previews = files.length
      ? `<div class="local-asset-previews">${files.map((file, fileIndex) => `<div class="local-asset-thumb ${file.trustedAssetId ? 'trusted' : ''}"><button data-show-local-asset-index="${index}" data-show-local-file-index="${fileIndex}" title="在文件夹中查看"><img src="${esc(String(file.imageUrl || ''))}" alt="${esc(String(prompt.name || '参考图'))}">${file.trustedAssetId ? '<i>已认证</i>' : ''}</button><span>${esc(String(file.sourceName || file.fileName || `图片${fileIndex + 1}`))}</span></div>`).join('')}</div>`
      : `<div class="asset-image-placeholder pending"><span>＋</span><small>请上传${esc(String(prompt.name || '参考图'))}</small></div>`;
    return `<article class="generated-asset-card local-upload-card">${previews}<div class="generated-asset-copy"><div><span>${esc(String(prompt.type || '参考图'))}${prompt.customAsset ? ' · 自定义' : ''}</span><h4>${esc(String(prompt.name || `参考图${index + 1}`))}</h4><code>${esc(String(prompt.fileName || ''))}</code></div><b class="asset-result-status ${files.length ? 'success' : 'pending'}">${esc(statusLabel)}</b><p class="local-upload-help">可上传 PNG、JPG、WEBP 或 BMP；同一角色或场景最多保留 9 张参考图。</p><div class="local-upload-actions"><button class="primary-button upload-local-asset" data-upload-local-asset-index="${index}" ${project.running ? 'disabled' : ''}>${files.length ? '追加参考图' : '上传参考图'}</button>${files.length ? `<button class="outline-button clear-local-asset" data-clear-local-asset-index="${index}" ${project.running ? 'disabled' : ''}>清空本项</button>` : ''}${prompt.customAsset ? `<button class="outline-button remove-custom-asset" data-remove-custom-asset-index="${index}" ${project.running ? 'disabled' : ''}>删除此项</button>` : ''}</div></div></article>`;
  }).join('');
  const customCard = `<button class="generated-asset-card add-custom-asset-card" id="addCustomAsset" ${project.running ? 'disabled' : ''}><span>＋</span><b>添加遗漏资源</b><small>自定义人物、场景、群像或道具，并上传对应参考图</small></button>`;
  return `<section class="seedream-generator local-assets-uploader"><div class="seedream-generator-head"><div><span class="section-kicker">LOCAL REFERENCE IMAGES</span><h4>第五步 · 上传本地参考图</h4><p>模型生图已暂停。请为下方每个人物、场景、群像和道具分别上传对应图片。</p></div><div class="seedream-actions">${state.outputDirectory ? '<button class="outline-button" id="openAssetFolder">打开素材文件夹</button>' : ''}<button class="primary-button" id="confirmLocalAssets" ${project.running || !prompts.length || missing ? 'disabled' : ''}>确认素材并进入第六步</button></div></div><div class="seedream-progress"><div><b>${esc(statusText)}</b><span>${progress}%</span></div><i><em style="width:${progress}%"></em></i><small>上传文件会复制到当前项目的“视觉素材/本地上传”目录，重启软件后仍可继续使用。</small></div><div class="generated-assets-grid">${cards}${customCard}</div></section>`;
}

function effectiveVideoPrompt(index, originalPrompt, state = project.videoGeneration) {
  const override = state?.items?.[index]?.promptOverride;
  return typeof override === 'string' ? override : String(originalPrompt || '');
}

function videoPromptIsEdited(index, originalPrompt, state = project.videoGeneration) {
  return effectiveVideoPrompt(index, originalPrompt, state) !== String(originalPrompt || '');
}

function repairVideoReferenceSequence(index, prompt, item, state) {
  const shot = project.outputs.storyboard?.shots?.[index];
  if (project.running || !shot || !Array.isArray(shot.uploads) || !shot.uploads.length || !item) return String(prompt || '');
  const normalized = normalizeImageReferenceSequence(prompt, shot.uploads, item.referenceBindings || {});
  if (!normalized.changed) return String(prompt || '');
  shot.uploads = normalized.uploads;
  item.referenceBindings = normalized.bindings;
  item.promptOverride = normalized.prompt;
  item.promptEditedAt = new Date().toISOString();
  if (state.pendingCertification?.shotIndex === index) state.pendingCertification = null;
  resetVideoItemAfterReferenceChange(item, state);
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
    return `<div class="video-reference-row ${selected ? 'bound' : 'missing'}"><div class="video-reference-number"><code>${esc(binding.ref)}</code><span>请求中的图片${binding.number}</span>${removeButton}</div><div class="video-reference-identity"><b>${esc(displayName)}</b><small>${esc(binding.purpose)}</small></div><div class="video-reference-picker">${selected?.imageUrl ? `<img src="${esc(selected.imageUrl)}" alt="${esc(displayName)}">` : '<span class="video-reference-empty">缺图</span>'}<label><span>绑定到第五步图片</span><select data-video-reference-shot="${index}" data-video-reference-number="${binding.number}" ${binding.candidates.length && !project.running ? '' : 'disabled'}><option value="">${binding.candidates.length ? '点击选择人物、场景或道具图片' : '第五步还没有已上传图片'}</option>${options}</select></label></div></div>`;
  }).join('');
  const errors = plan.errors.length ? `<div class="video-reference-errors">${plan.errors.map((error) => `<p>${esc(error)}</p>`).join('')}</div>` : '';
  const help = plan.legacyMode
    ? '这是旧项目，已从提示词恢复 @Image 编号。请在每一行右侧下拉框中选择第五步对应图片。'
    : '官方规则：@ImageN 严格对应请求中的第 N 张图片；每个编号只发送下方选中的一张图。';
  const addDisabled = project.running || plan.bindings.length >= 9;
  return `<section class="video-reference-bindings"><div class="video-reference-head"><div><b>本镜头素材硬绑定</b><small>${esc(help)}</small></div><span class="${plan.valid ? 'ready' : 'blocked'}">${plan.valid ? `已核对 ${plan.bindings.length} 项` : '生成前需修正'}</span></div>${rows || '<div class="video-reference-errors"><p>提示词中没有找到 @Image1、@Image2 等图片引用。</p></div>'}${errors}<div class="video-reference-add-actions"><button data-add-existing-video-reference="${index}" ${addDisabled ? 'disabled' : ''}>＋ 引用第五步已有图</button><button data-upload-video-reference="${index}" ${addDisabled ? 'disabled' : ''}>＋ 上传并添加新图</button><small>${plan.bindings.length} / 9 张；新增后会自动写入当前镜头提示词</small></div></section>`;
}

function videoGenerationTemplate() {
  const prompts = project.outputs.storyboard?.prompts || [];
  const state = project.videoGeneration || defaultProject.videoGeneration;
  const items = Array.isArray(state.items) ? state.items : [];
  const generationMode = effectiveVideoGenerationMode(state);
  const confirmMode = generationMode === 'confirm';
  const durationText = videoDurationSummary(prompts, items, state.duration || seedanceStatus.duration);
  const completed = items.filter((item) => item.status === 'success').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const active = items.filter((item) => ['creating', 'queued', 'running', 'downloading'].includes(item.status)).length;
  const certificationPending = Boolean(state.pendingCertification);
  const nextIndex = prompts.findIndex((_prompt, index) => items[index]?.status !== 'success');
  const nextItem = nextIndex >= 0 ? items[nextIndex] : null;
  const allComplete = prompts.length > 0 && nextIndex < 0;
  const progress = prompts.length ? Math.round((completed / prompts.length) * 100) : 0;
  const statusText = project.running && active
    ? `正在生成镜头 ${Math.min(completed + failed + 1, prompts.length)} / ${prompts.length}`
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
        : `等待生成 ${prompts.length} 个镜头`;
  const statusLabels = {
    pending: '待生成', creating: '提交中', queued: '排队中', running: '生成中', downloading: '下载中', success: '已保存', failed: '生成失败', certification: '等待真人认证',
  };
  const cards = prompts.map((prompt, index) => {
    const item = items[index] || { status: 'pending' };
    const editablePrompt = repairVideoReferenceSequence(index, effectiveVideoPrompt(index, prompt, state), item, state);
    const promptEdited = editablePrompt !== String(prompt || '');
    const needsCertification = state.pendingCertification?.shotIndex === index;
    const duration = normalizeSeedanceDuration(item.duration, storyboardShotDuration(index, prompt, state.duration));
    const label = statusLabels[item.status] || '待生成';
    const media = item.status === 'success' && item.videoFileUrl
      ? `<div class="video-clip-preview"><video src="${esc(String(item.videoFileUrl))}" controls preload="metadata"></video><button data-show-video-index="${index}">在文件夹中查看</button></div>`
      : `<div class="video-clip-placeholder ${esc(String(item.status || 'pending'))}"><span>${['creating', 'queued', 'running', 'downloading'].includes(item.status) ? '▶' : ['failed', 'certification'].includes(item.status) ? '!' : String(index + 1).padStart(2, '0')}</span><b>${esc(label)}</b>${item.taskId ? `<small>${esc(String(item.taskId))}</small>` : ''}</div>`;
    const action = needsCertification
      ? `<button class="primary-button generate-one-video" data-open-portrait-certification="${index}" ${project.running ? 'disabled' : ''}>完成认证并继续</button>`
      : `<button class="outline-button generate-one-video" data-generate-video-index="${index}" ${project.running ? 'disabled' : ''}>${item.status === 'success' ? '重新生成此镜头' : item.status === 'failed' ? '重试此镜头' : '生成此镜头'}</button>`;
    return `<article class="video-clip-card">${media}<div class="video-clip-copy"><div><span>镜头 ${String(index + 1).padStart(2, '0')} · ${duration} 秒</span><h4>${esc(String(item.fileName || `镜头-${String(index + 1).padStart(2, '0')}.mp4`))}</h4><div class="video-prompt-editor-head"><b>视频生成提示词</b><span class="${promptEdited ? 'edited' : ''}" data-video-prompt-status="${index}">${promptEdited ? '已修改 · 自动保存' : '原始提示词 · 自动保存'}</span><button class="reset-video-prompt" data-reset-video-prompt-index="${index}" ${project.running || !promptEdited ? 'disabled' : ''}>恢复原始提示词</button></div><textarea class="video-prompt-editor" data-video-prompt-index="${index}" aria-label="镜头 ${String(index + 1).padStart(2, '0')} 视频生成提示词" ${project.running ? 'disabled' : ''}>${esc(editablePrompt)}</textarea>${videoReferenceBindingTemplate(index, editablePrompt, item)}</div><b class="video-task-status ${esc(String(item.status || 'pending'))}">${esc(label)}</b>${item.error ? `<div class="video-task-error">${esc(cleanRemoteError(item.error, '生成失败'))}</div>` : ''}${action}</div></article>`;
  }).join('');
  const nextButtonText = allComplete
    ? '全部视频已完成'
    : nextItem?.status === 'failed'
      ? `重试镜头 ${String(nextIndex + 1).padStart(2, '0')}`
      : `生成下一个镜头 ${String(nextIndex + 1).padStart(2, '0')}`;
  const batchButtonText = failed ? '批量重试失败镜头' : completed ? '批量继续生成' : '批量生成全部视频';
  const progressHelp = !seedanceStatus.configured
    ? '尚未配置火山方舟 API Key，配置后即可调用 Seedance 2.0。'
    : certificationPending
      ? '完成方舟真人认证并填写 Asset ID 后，程序会自动重试当前镜头，并继续原来的批量任务。'
    : '可以“生成下一个镜头”，也可以“一键批量生成”；每张镜头卡仍可单独生成或重试。';
  return `<section class="seedance-generator"><div class="seedance-generator-head"><div><span class="section-kicker">AI VIDEO GENERATION</span><h4>第六步 · Seedance 分镜视频</h4><p>${esc(seedanceModelLabel(state.model || seedanceStatus.model))} · ${esc(state.ratio || seedanceStatus.ratio)} · ${esc(state.resolution || seedanceStatus.resolution)} · 支持逐镜与批量 · 按分镜 ${esc(durationText)}${state.generateAudio === false ? ' · 无声' : ' · 同步音频'}</p></div><div class="seedance-actions"><button class="outline-button" id="configureSeedance">视频设置</button>${state.outputDirectory ? '<button class="outline-button" id="openVideoFolder">打开视频文件夹</button>' : ''}<button class="outline-button" id="generateNextVideo" ${project.running || !prompts.length || allComplete ? 'disabled' : ''}>${esc(nextButtonText)}</button><button class="primary-button" id="generateAllVideos" ${project.running || !prompts.length || allComplete ? 'disabled' : ''}>${esc(batchButtonText)}</button></div></div><div class="seedance-video-progress"><div><b>${esc(statusText)}</b><span>${progress}%</span></div><i><em style="width:${progress}%"></em></i><small>${esc(progressHelp)}</small>${state.lastError ? `<p class="seedream-global-error">${esc(cleanRemoteError(state.lastError, '生成失败'))}</p>` : ''}</div><div class="video-clips-grid">${cards}</div></section>`;
}

function storyboardShotDuration(index, prompt, fallback = seedanceStatus.duration) {
  const explicitDuration = project.outputs.storyboard?.durations?.[index];
  return resolveSeedanceDuration(explicitDuration, prompt, fallback);
}

function effectiveVideoGenerationMode(state = project.videoGeneration || defaultProject.videoGeneration) {
  const items = Array.isArray(state.items) ? state.items : [];
  const hasGenerationHistory = items.some((item) => item.status && item.status !== 'pending');
  return normalizeSeedanceGenerationMode(project.running || hasGenerationHistory ? state.generationMode : seedanceStatus.generationMode);
}

function videoDurationSummary(prompts, items = [], fallback = seedanceStatus.duration) {
  const durations = prompts.map((prompt, index) => normalizeSeedanceDuration(
    items[index]?.duration,
    storyboardShotDuration(index, prompt, fallback),
  ));
  if (!durations.length) return `${normalizeSeedanceDuration(fallback)} 秒`;
  const minimum = Math.min(...durations);
  const maximum = Math.max(...durations);
  return minimum === maximum ? `${minimum} 秒` : `${minimum}-${maximum} 秒`;
}

function outputTemplate() {
  const output = project.outputs[project.activeStep];
  if (project.running && !output) return `<div class="generating"><div class="generating-orb">✦</div><h3>正在生成${steps[currentIndex()].label}...</h3><p>${currentIndex() < 4 ? `文案流程第 ${currentIndex() + 1} / 4 步，完成后进入本地参考图上传` : '正在生成并下载视频镜头'}</p><div class="generating-track"><i></i></div><small>请保持程序开启</small></div>`;
  if (project.activeStep === 'video' && !output && steps.slice(0, 5).every((step) => project.completed.includes(step.id))) return `<div class="video-ready"><div class="video-ready-icon">▶</div><span class="section-kicker">READY FOR SEEDANCE</span><h3>本地参考图和分镜已经准备完成</h3><p>Seedance 支持单独生成一个镜头或批量生成全部镜头，并将完成的视频保存到本机。</p><div class="video-ready-actions"><button class="outline-button" id="configureSeedance">视频设置</button><button class="next-button" id="generateVideo">进入视频生成 <span>→</span></button></div></div>`;
  if (!output) return `<div class="empty-output"><div class="empty-icon">✧</div><h3>准备好开始创作了吗？</h3><p>输入一段剧本，点击“开始生成”，你的短剧工作流会从这里展开。</p><button class="outline-button" id="emptyStart">使用示例开始 <span>→</span></button></div>`;
  const isAssets = project.activeStep === 'assets';
  const isVideo = project.activeStep === 'video';
  const stageComplete = project.completed.includes(project.activeStep);
  const stageStatus = project.running ? '生成中' : stageComplete ? '已完成' : '待生成';
  const videoDurationText = isVideo ? videoDurationSummary(project.outputs.storyboard?.prompts || [], project.videoGeneration?.items || [], project.videoGeneration?.duration) : '';
  const videoGenerationModeText = effectiveVideoGenerationMode() === 'confirm' ? '逐镜确认' : '批量连续';
  const body = `${isAssets ? assetGenerationTemplate(output) : ''}${isVideo ? videoGenerationTemplate() : ''}${output.body || ''}`;
  return `<div class="result-layout ${project.activeStep === 'storyboard' ? 'seedance-layout' : ''} ${isAssets ? 'assets-layout' : ''} ${isVideo ? 'video-generation-layout' : ''}"><div class="result-main"><div class="result-title"><span class="result-badge">${steps.find((s) => s.id === project.activeStep).no}</span><div><h3>${esc(output.title)}</h3><p>${esc(output.subtitle)}</p></div><span class="result-time">刚刚生成</span></div><div class="result-body">${body}</div></div><div class="result-side"><div class="side-stat"><span>阶段状态</span><b><i></i> ${stageStatus}</b></div><div class="side-stat"><span>${isVideo ? '镜头时长' : '预计耗时'}</span><b>${isVideo ? esc(videoDurationText) : output.time || '12 秒'}</b></div>${project.activeStep === 'storyboard' ? '<div class="side-stat vertical"><span>分镜规范</span><b>即梦二点零</b><small>按剧情动态分配<br>素材引用已分配</small></div>' : ''}${isAssets ? '<div class="side-stat vertical"><span>素材方式</span><b>本地上传</b><small>按人物、场景和道具分别上传<br>模型生图暂时关闭</small></div>' : ''}${isVideo ? `<div class="side-stat vertical"><span>视频模型</span><b>${esc(seedanceModelLabel(project.videoGeneration?.model))}</b><small>${esc(project.videoGeneration?.ratio || seedanceStatus.ratio)} · ${esc(project.videoGeneration?.resolution || seedanceStatus.resolution)}<br>逐镜或批量 · 保存 MP4</small></div>` : ''}<button class="outline-button full" id="rerunStep">${isVideo ? '重新生成全部视频' : '重新生成'} <span>↻</span></button>${isVideo ? '<div class="auto-note">成功镜头已保存到本机，可逐个生成或批量继续。</div>' : stageComplete ? '<div class="auto-note"><i>✓</i> 已确认本地参考图</div>' : '<div class="auto-note">当前阶段尚未完成</div>'}</div></div>`;
}

function makeOutput(id) {
  const title = project.title === '未命名短剧项目' ? deriveTitle(project.script) : project.title;
  const story = getStoryUnits(project.script);
  const characters = story.characters.length ? story.characters : ['未识别人物'];
  const type = getMetadataValue(project.script, ['类型', '题材']) || '短剧';
  const sellingPoints = getMetadataValue(project.script, ['核心卖点', '卖点']) || story.units.slice(0, 2).map((unit) => unit.text).join('，');
  const firstAction = story.units.find((unit) => unit.type === 'action')?.text || story.units[0]?.text || '剧情开始';
  const firstDialogue = story.units.find((unit) => unit.type === 'dialogue');
  if (id === 'analysis') return { title: '故事结构分析', subtitle: `已从剧本中识别 ${characters.length} 名人物`, time: '8 秒', body: `<div class="analysis-grid"><div><label>故事定位</label><strong>${esc(type)}</strong><p>${esc(sellingPoints.slice(0, 100))}</p></div><div><label>主要人物</label><strong>${esc(characters.join('、'))}</strong><p>后续剧本、分镜和素材均使用这些人物姓名。</p></div><div><label>开场事件</label><strong>${esc(firstAction.slice(0, 30))}</strong><p>${firstDialogue ? `${esc(firstDialogue.speaker)}的首句对白：“${esc(firstDialogue.text)}”` : '剧本暂未识别到独立对白。'}</p></div><div><label>解析状态</label><div class="tags"><span>已排除标题</span><span>已排除规格</span><span>已识别对白</span><span>已提取姓名</span></div></div></div><div class="callout"><b>人物校验</b><span>当前识别人物：${esc(characters.join('、'))}。若姓名不完整，请在原剧本中增加“人物：姓名一、姓名二”或使用“姓名：对白”的格式。</span></div>` };
  if (id === 'episodes') {
    const chunks = splitIntoChunks(story.units, 3);
    return { title: '三段式剧情大纲', subtitle: `围绕 ${characters.join('、')} 拆分剧情推进`, time: '10 秒', body: `<div class="episode-list">${chunks.map((chunk, index) => { const text = chunk.map((unit) => unit.type === 'dialogue' ? `${unit.speaker}说：“${unit.text}”` : unit.text).join(' '); const hook = chunk[chunk.length - 1]; return `<article><span>段落 ${String(index + 1).padStart(2, '0')}</span><div><h4>${['冲突建立','矛盾升级','悬念收束'][index]}</h4><p>${esc(text.slice(0, 180))}</p><b>段尾重点：${esc((hook?.text || '保留悬念').slice(0, 80))}</b></div></article>`; }).join('')}</div>` };
  }
  if (id === 'script') return { title: '第1集 · 可拍摄剧本', subtitle: `${story.units.length} 个剧情单元 · 人物 ${characters.join('、')}`, time: '15 秒', body: `<div class="script-preview"><div class="scene-label">第1场 · 根据原剧本整理</div>${story.units.slice(0, 12).map((unit) => unit.type === 'dialogue' ? `<p><b>${esc(unit.speaker)}</b>　${unit.direction ? `（${esc(unit.direction)}）` : ''}${esc(unit.text)}</p>` : `<p class="direction">${esc(unit.text)}</p>`).join('')}</div>` };
  if (id === 'storyboard') return makeSeedanceStoryboard(project.script);
  if (id === 'assets') {
    const characterCards = characters.slice(0, 3).map((name, index) => `<div class="asset-card asset-character ${index % 2 ? 'dark' : ''}"><span class="asset-type">角色</span><strong>${esc(name)}</strong><small>外貌、发型、服装和表情参考图</small><em>对应 @Image${index + 1}</em></div>`).join('');
    const sceneNo = Math.min(characters.length, 3) + 1;
    return { title: '视觉素材清单', subtitle: `角色 ${characters.length} 名 · 场景与道具参考`, time: '22 秒', body: `<div class="asset-grid">${characterCards}<div class="asset-card asset-scene"><span class="asset-type">场景</span><strong>主场景参考</strong><small>根据原剧本中的地点、构图和光线制作</small><em>对应 @Image${sceneNo}</em></div><div class="asset-card asset-scene blue"><span class="asset-type">道具</span><strong>关键道具参考</strong><small>根据剧情中的证据、手机、文件或物件制作</small><em>对应 @Image${sceneNo + 1}</em></div></div>` };
  }
  return { title: 'Seedance 分镜视频', subtitle: '按第四步分镜逐条生成并保存 MP4', time: '数分钟 / 镜头', body: '' };
}

function getMetadataValue(script, labels) {
  const lines = script.split(/\r?\n/).map(cleanScriptLine);
  for (const label of labels) {
    const match = lines.map((line) => line.match(new RegExp(`^${label}\\s*[：:]\\s*(.+)$`))).find(Boolean);
    if (match) return match[1].trim();
  }
  return '';
}

function splitIntoChunks(items, count) {
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(items.length * index / count);
    const end = Math.floor(items.length * (index + 1) / count);
    chunks.push(items.slice(start, Math.max(start + 1, end)));
  }
  return chunks;
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
  const characterRefs = new Map(referencedCharacters.map((name, index) => [name, `@Image${index + 1}`]));
  const sceneImageNo = referencedCharacters.length + 1;
  const propImageNo = sceneImageNo + 1;
  const requiredImages = propImageNo;
  const configured = { images: requiredImages, videos: 0, audios: 0, ...(project.seedanceMaterials || {}) };
  const materials = { ...configured, images: Math.max(requiredImages, Number(configured.images) || 0) };
  const totalFiles = Number(materials.images) + Number(materials.videos) + Number(materials.audios);
  const materialValid = materials.images <= 9 && materials.videos <= 3 && materials.audios <= 3 && totalFiles <= 12;

  const baseReferences = referencedCharacters.map((name, index) => ({ ref: `@Image${index + 1}`, role: `${name}角色设定图`, use: `作为${name}的外貌、发型和服装参考` }));
  baseReferences.push({ ref: `@Image${sceneImageNo}`, role: '场景设定图', use: '作为环境、构图和光线参考' });
  baseReferences.push({ ref: `@Image${propImageNo}`, role: '关键道具图', use: '作为证据、手机、照片或其他关键物件参考' });

  const extraReferences = [];
  for (let imageNo = requiredImages + 1; imageNo <= materials.images; imageNo += 1) extraReferences.push({ ref: `@Image${imageNo}`, role: `补充视觉参考${imageNo - requiredImages}`, use: imageNo % 2 === 0 ? '作为服装与造型细节参考' : '作为场景光线与构图参考' });
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
    const subjectLine = `${roleReferences.join('；')}；@Image${sceneImageNo}作为场景、构图和光线参考`;
    const needsProp = /手机|照片|戒指|文件|证据|信件|钥匙|捧花|礼物|道具|退婚书|合同|银行卡|药瓶/.test(unit.text);
    const propLine = needsProp ? `；@Image${propImageNo}作为关键道具外观参考` : '';
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
}

function capturePageScrollPositions() {
  return ['.main', '.sidebar', '.project-list'].map((selector) => {
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

function bindEvents() {
  configureAutomaticSeedanceDurationField();
  document.querySelector('#scriptInput').addEventListener('input', (event) => {
    project.script = event.target.value;
    project.title = project.title === '未命名短剧项目' && project.script ? deriveTitle(project.script) : project.title;
    saveProject();
    const count = document.querySelector('.textarea-footer span');
    if (count) count.textContent = `${project.script.length} 字`;
  });
  document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => {
    if (project.running) return showToast('自动生成进行中，请稍候');
    project.activeStep = button.dataset.step; saveProject(); render();
  }));
  document.querySelector('#startGenerate').addEventListener('click', () => startGeneration());
  document.querySelector('#emptyStart')?.addEventListener('click', () => { project.script = demoScript; saveProject(); render(); startGeneration(); });
  document.querySelector('#useDemo').addEventListener('click', () => { project.script = demoScript; project.title = '失控的婚礼'; saveProject(); render(); showToast('示例剧本已载入'); });
  document.querySelector('#fileInput').addEventListener('change', readFile);
  document.querySelector('#newProject').addEventListener('click', createNewProject);
  document.querySelectorAll('[data-project-id]').forEach((button) => button.addEventListener('click', () => switchProject(button.dataset.projectId)));
  document.querySelectorAll('[data-delete-project-id]').forEach((button) => button.addEventListener('click', () => deleteProject(button.dataset.deleteProjectId)));
  document.querySelector('#exportProject').addEventListener('click', exportProject);
  document.querySelector('#importProject').addEventListener('click', () => document.querySelector('#projectFileInput').click());
  document.querySelector('#projectFileInput').addEventListener('change', importProject);
  document.querySelector('#clearOutput').addEventListener('click', () => { generationRun += 1; project.outputs = {}; project.completed = []; project.assetGeneration = { ...defaultProject.assetGeneration, items: [] }; project.videoGeneration = { ...defaultProject.videoGeneration, items: [] }; project.activeStep = 'analysis'; project.running = false; saveProject(); render(); showToast('生成结果已清空，本地已生成图片和视频不会被删除'); });
  document.querySelector('#copyOutput').addEventListener('click', copyOutput);
  document.querySelector('#rerunStep')?.addEventListener('click', () => startGeneration(project.activeStep === 'video' ? 'force-video' : true));
  document.querySelector('#generateVideo')?.addEventListener('click', () => startGeneration());
  document.querySelector('#openSettings').addEventListener('click', openModelSettings);
  document.querySelector('#openImageSettings')?.addEventListener('click', openImageSettings);
  document.querySelector('#openSeedanceSettings').addEventListener('click', openSeedanceSettings);
  document.querySelector('#heroModelStatus').addEventListener('click', openModelSettings);
  document.querySelector('#heroImageStatus')?.addEventListener('click', openImageSettings);
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
  document.querySelectorAll('[data-generate-video-index]').forEach((button) => button.addEventListener('click', () => generateSeedanceVideos({ token: ++generationRun, indexes: [Number(button.dataset.generateVideoIndex)], mode: 'confirm' })));
  document.querySelectorAll('[data-add-existing-video-reference]').forEach((button) => button.addEventListener('click', () => addVideoReference(Number(button.dataset.addExistingVideoReference))));
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
      state.generatedCount = state.items.filter((videoItem) => videoItem.status === 'success').length;
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
  document.querySelectorAll('[data-video-reference-shot]').forEach((select) => select.addEventListener('change', () => {
    const scrollPositions = capturePageScrollPositions();
    const shotIndex = Number(select.dataset.videoReferenceShot);
    const referenceNumber = Number(select.dataset.videoReferenceNumber);
    const [assetItemIndex, fileIndex] = String(select.value || '').split(':').map(Number);
    const prompts = project.outputs.storyboard?.prompts || [];
    const state = alignVideoGenerationItems(prompts);
    const item = state.items[shotIndex];
    const asset = project.assetGeneration?.items?.[assetItemIndex];
    const file = asset?.files?.[fileIndex];
    if (!item || !asset || !file || !Number.isInteger(referenceNumber)) return;
    item.referenceBindings = {
      ...(item.referenceBindings || {}),
      [String(referenceNumber)]: {
        assetName: String(asset.name || ''),
        localPath: String(file.localPath || ''),
        trustedAssetId: normalizeTrustedAssetId(file.trustedAssetId),
        sourceName: String(file.sourceName || file.fileName || ''),
      },
    };
    const shot = project.outputs.storyboard?.shots?.[shotIndex];
    const upload = shot?.uploads?.find((entry) => Number(String(entry?.ref || '').match(/@Image(\d+)/i)?.[1]) === referenceNumber);
    if (upload?.addedInVideoStep) {
      upload.asset = String(asset.name || '');
      upload.purpose = videoReferencePurpose(asset);
      const linePattern = new RegExp(`@Image${referenceNumber}作为[^\\n]*`, 'i');
      const currentPrompt = effectiveVideoPrompt(shotIndex, prompts[shotIndex], state);
      item.promptOverride = linePattern.test(currentPrompt)
        ? currentPrompt.replace(linePattern, videoReferencePromptLine(referenceNumber, asset))
        : `${currentPrompt.trim()}\n${videoReferencePromptLine(referenceNumber, asset)}`;
      item.promptEditedAt = new Date().toISOString();
    }
    resetVideoItemAfterReferenceChange(item, state);
    saveProject();
    renderWithoutMovingPage(scrollPositions);
    showToast(`镜头 ${String(shotIndex + 1).padStart(2, '0')} 的图片${referenceNumber}已绑定为“${file.sourceName || file.fileName || asset.name}”`);
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
    const addedNumbers = new Set((Array.isArray(shot?.uploads) ? shot.uploads : [])
      .filter((upload) => upload?.addedInVideoStep)
      .map((upload) => Number(String(upload?.ref || '').match(/@Image(\d+)/i)?.[1] || 0)));
    if (shot && Array.isArray(shot.uploads)) shot.uploads = shot.uploads.filter((upload) => !upload?.addedInVideoStep);
    if (addedNumbers.size) {
      item.referenceBindings = Object.fromEntries(Object.entries(item.referenceBindings || {}).filter(([number]) => !addedNumbers.has(Number(number))));
    }
    delete item.promptOverride;
    delete item.promptEditedAt;
    item.status = 'pending';
    item.taskId = '';
    item.error = '';
    state.status = 'pending';
    state.generatedCount = state.items.filter((videoItem) => videoItem.status === 'success').length;
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
    if (prompts.length) copyText(`${suffix ? `【统一附加词】\n${suffix}\n\n` : ''}${prompts.map((prompt, index) => `【镜头${String(index + 1).padStart(2, '0')}】\n${prompt}`).join('\n\n')}`, '全部即梦提示词已复制');
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
    const updateMaterials = () => {
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
  generationRun += 1;
  if (!project.running) return;
  project.running = false;
  saveProject();
}

function createNewProject() {
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
  if (!IMAGE_MODEL_GENERATION_ENABLED) return showToast('第五步模型生图已暂停，请直接上传本地参考图');
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
  if (help) help.textContent = '自动读取第四步每个分镜的时长；无有效标注时内部使用 5 秒。';
  const display = document.createElement('div');
  display.className = 'automatic-duration-display';
  display.innerHTML = '<b>按分镜自动</b><span>4-15 秒</span>';
  select.replaceWith(display);
}
function closeImageSettings() { document.querySelector('#imageSettingsModal').hidden = true; }
function openSeedanceSettings() {
  seedanceGenerationModeDraft = normalizeSeedanceGenerationMode(seedanceStatus.generationMode);
  const modal = document.querySelector('#seedanceSettingsModal');
  modal.hidden = false;
  selectSeedanceGenerationModeDraft(seedanceGenerationModeDraft);
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
    window.setTimeout(() => { closeModelSettings(); render(); showToast('DeepSeek V4 Pro 已配置'); }, 500);
  } catch (error) { setModelMessage(error.message || '保存失败。', 'error'); }
}

async function testDeepSeekConnection() {
  const apiKey = document.querySelector('#deepseekKey').value.trim();
  setModelMessage('正在连接 DeepSeek V4 Pro…');
  try {
    await window.storyforgeAI.testConnection(apiKey);
    setModelMessage('连接成功，DeepSeek V4 Pro 可用。', 'success');
  } catch (error) { setModelMessage(error.message || '连接失败。', 'error'); }
}

async function refreshDeepSeekStatus() {
  if (!window.storyforgeAI) {
    deepseekStatus = { configured: false, model: 'deepseek-v4-pro', checking: false };
    render(); return;
  }
  try { deepseekStatus = { ...(await window.storyforgeAI.getStatus()), checking: false }; }
  catch { deepseekStatus = { configured: false, model: 'deepseek-v4-pro', checking: false }; }
  render();
}

function setImageMessage(message, type = '') {
  const node = document.querySelector('#imageMessage');
  if (!node) return;
  node.textContent = message;
  node.className = `modal-message ${type}`;
}

async function saveImageSettings() {
  if (!IMAGE_MODEL_GENERATION_ENABLED) return setImageMessage('第五步模型生图已暂停，请直接上传本地参考图。', 'error');
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
      showToast(`${imageProviderLabel(provider)} 已配置为第五步生图模型`);
      if (shouldResume) generateImageAssets({ token: ++generationRun, autoAdvance: true });
    }, 450);
  } catch (error) { setImageMessage(cleanRemoteError(error, '保存失败。'), 'error'); }
}

async function testImageConnection() {
  if (!IMAGE_MODEL_GENERATION_ENABLED) return setImageMessage('第五步模型生图已暂停。', 'error');
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
    project.videoGeneration.generationMode = seedanceStatus.generationMode;
    saveProject();
    setSeedanceMessage('Seedance 设置已安全保存。', 'success');
    window.setTimeout(() => {
      closeSeedanceSettings();
      render();
      showToast(`${seedanceModelLabel()} 已配置为第六步视频模型`);
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

function renderAIWorkflow(data, usage, model) {
  const analysis = data.analysis || {};
  const characters = Array.isArray(analysis.characters) ? analysis.characters : [];
  const sellingPoints = Array.isArray(analysis.sellingPoints) ? analysis.sellingPoints : [];
  const visualKeywords = Array.isArray(analysis.visualKeywords) ? analysis.visualKeywords : [];
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  const script = data.script || {};
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  const storyboard = data.storyboard || {};
  const shots = Array.isArray(storyboard.shots) ? storyboard.shots : [];
  const assets = data.assets || {};
  if (!characters.length || !scenes.length || !shots.length) throw new Error('DeepSeek 返回的数据不完整，请重新生成。');

  const analysisBody = `<div class="analysis-grid"><div><label>故事定位</label><strong>${esc(String(analysis.positioning || ''))}</strong><p>${esc(String(analysis.coreConflict || ''))}</p></div><div><label>主要人物</label><strong>${esc(characters.map((item) => item.name).join('、'))}</strong><p>${esc(characters.map((item) => `${item.name}：${item.identity || item.traits || ''}`).join('；'))}</p></div><div><label>核心卖点</label><div class="tags">${sellingPoints.map((item) => `<span>${esc(String(item))}</span>`).join('')}</div></div><div><label>视觉关键词</label><div class="tags">${visualKeywords.map((item) => `<span>${esc(String(item))}</span>`).join('')}</div></div></div><div class="callout"><b>DeepSeek V4 Pro</b><span>${esc(String(analysis.coreConflict || '已完成故事结构分析。'))}</span></div>`;
  const episodesBody = `<div class="episode-list">${episodes.map((item) => `<article><span>第${esc(String(item.episode || ''))}集</span><div><h4>${esc(String(item.title || ''))}</h4><p>${esc(String(item.summary || ''))}</p><b>结尾钩子：${esc(String(item.hook || ''))}</b></div></article>`).join('')}</div>`;
  const scriptBody = `<div class="script-preview">${scenes.map((scene) => `<div class="scene-label">第${esc(String(scene.scene || ''))}场 · ${esc(String(scene.location || ''))} · ${esc(String(scene.time || ''))}</div><p class="direction">${esc(String(scene.action || ''))}</p>${(Array.isArray(scene.dialogues) ? scene.dialogues : []).map((dialogue) => `<p><b>${esc(String(dialogue.speaker || ''))}</b>　${dialogue.direction ? `（${esc(String(dialogue.direction))}）` : ''}${esc(String(dialogue.line || ''))}</p>`).join('')}`).join('')}</div>`;
  const unifiedSuffix = String(storyboard.unifiedSuffix || '');
  const shotCards = shots.map((shot, index) => {
    const uploads = Array.isArray(shot.uploads) ? shot.uploads : [];
    const segments = Array.isArray(shot.segments) ? shot.segments : [];
    const prompt = String(shot.prompt || buildPromptFromShot(shot));
    shot.prompt = prompt;
    const durationText = formatDuration(shot.duration);
    return `<article class="seedance-shot ai-shot"><div class="shot-card-head"><div><span class="shot-number">${esc(String(shot.no || String(index + 1).padStart(2, '0')))}</span><div><h4>${esc(String(shot.title || `镜头${index + 1}`))}</h4><p>${esc(durationText)} · ${uploads.length}项上传素材</p></div></div><div class="shot-actions"><span>${esc(durationText)}</span><button class="copy-shot" data-shot-index="${index}">复制提示词</button></div></div><div class="upload-plan"><b>上传：</b>${uploads.map((upload) => `<span><code>${esc(String(upload.ref || ''))}</code>${esc(String(upload.asset || ''))}：${esc(String(upload.purpose || ''))}</span>`).join('')}</div><div class="segment-list">${segments.map((segment) => `<div><b>${esc(String(segment.time || ''))}</b><span>${esc(String(segment.visual || ''))}</span></div>`).join('')}</div><div class="sound-line"><b>声音：</b>${esc(String(shot.sound || ''))}</div><pre>${esc(prompt)}</pre></article>`;
  }).join('');
  const storyboardBody = `<div class="unified-suffix"><div><b>统一附加词</b><span>复制镜头提示词时一并添加</span></div><p>${esc(unifiedSuffix)}</p><button id="copyUnifiedSuffix">复制统一附加词</button></div><div class="prompt-toolbar"><div><b>第一集 ${shots.length} 个镜头提示词</b><span>由 DeepSeek V4 Pro 按剧情节拍、对白量和动作量设计</span></div><button id="copyAllSeedance">复制全部提示词</button></div><div class="seedance-shots">${shotCards}</div>`;
  const checklist = Array.isArray(assets.characterChecklist) ? assets.characterChecklist : [];
  const differenceMatrix = Array.isArray(assets.characterDifferenceMatrix) ? assets.characterDifferenceMatrix : [];
  const promptItems = [
    ...(Array.isArray(assets.characters) ? assets.characters.map((item) => ({ ...item, type: '人物参考图' })) : []),
    ...(Array.isArray(assets.scenes) ? assets.scenes.map((item) => ({ ...item, type: '场景参考图' })) : []),
    ...(Array.isArray(assets.groups) ? assets.groups.map((item) => ({ ...item, type: '群像参考图' })) : []),
    ...(Array.isArray(assets.props) ? assets.props.map((item) => ({ ...item, type: '道具参考图' })) : []),
  ].map((item) => ({ ...item, prompt: String(item.prompt || item.description || '') }));
  const checklistBody = checklist.length ? `<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">CAST CHECKLIST</span><h4>人物参考图清单</h4></div><span>${checklist.filter((item) => item.requiresReferenceImage ?? item.requiresTurnaround).length} 人需要独立参考图</span></div><div class="asset-checklist">${checklist.map((item) => { const required = item.requiresReferenceImage ?? item.requiresTurnaround; return `<div><b>${esc(String(item.name || ''))}</b><span>${esc(String(item.roleType || '人物'))}</span><div class="asset-flags"><i class="${item.speaks ? 'yes' : ''}">对白</i><i class="${item.drivesPlot ? 'yes' : ''}">推动剧情</i><i class="${item.recurring ? 'yes' : ''}">反复出现</i><i class="${item.needsCloseUp ? 'yes' : ''}">特写</i></div><em class="${required ? 'required' : ''}">${required ? '上传单人参考图' : '归入功能人物'}</em><small>${esc(String(item.reason || ''))}</small></div>`; }).join('')}</div></section>` : '';
  const matrixBody = differenceMatrix.length ? `<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">FACE DIFFERENCE MATRIX</span><h4>人物差异化视觉锚点</h4></div><span>防止角色同脸</span></div><div class="asset-matrix"><div class="asset-matrix-row header"><b>角色 / 脸谱</b><b>面部锚点</b><b>发型 / 体态</b><b>服装 / 排除项</b></div>${differenceMatrix.map((item) => `<div class="asset-matrix-row"><b>${esc(String(item.name || ''))}<small>${esc(String(item.faceCode || ''))} · ${esc(String(item.ageRange || item.ageImpression || ''))}</small></b><span>${esc([item.faceShape, item.eyeShape, item.brows, item.noseLips, item.jawCheekbones].filter(Boolean).join('；'))}</span><span>${esc([item.hair, item.bodyType].filter(Boolean).join('；'))}</span><span>${esc([item.clothingSilhouette, item.signatureAccessory, item.differentFrom].filter(Boolean).join('；'))}</span></div>`).join('')}</div></section>` : '';
  const promptCards = promptItems.map((item, index) => `<article class="asset-prompt-card"><div class="asset-prompt-head"><div><span>${esc(String(item.type))}</span><h4>${esc(String(item.name || '参考图'))}</h4><code>${esc(String(item.fileName || ''))}</code></div><button class="copy-asset-prompt" data-asset-prompt-index="${index}">复制提示词</button></div>${item.description ? `<p>${esc(String(item.description))}</p>` : ''}${Array.isArray(item.exclusions) && item.exclusions.length ? `<div class="asset-exclusions"><b>排除：</b>${item.exclusions.map((value) => `<span>${esc(String(value))}</span>`).join('')}</div>` : ''}${Array.isArray(item.spatialAnchors) && item.spatialAnchors.length ? `<div class="asset-exclusions anchors"><b>空间锚点：</b>${item.spatialAnchors.map((value) => `<span>${esc(String(value))}</span>`).join('')}</div>` : ''}<pre>${esc(item.prompt)}</pre></article>`).join('');
  const assetsBody = `${checklistBody}${matrixBody}<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">REFERENCE IMAGE PROMPTS</span><h4>参考图生成提示词</h4></div><button id="copyAllAssetPrompts">复制全部提示词</button></div><div class="asset-prompt-list">${promptCards}</div></section>`;
  const usageText = usage ? `输入 ${usage.prompt_tokens || 0} · 输出 ${usage.completion_tokens || 0} tokens` : '用量由 DeepSeek 账户结算';

  return {
    analysis: { title: analysis.title || '故事结构分析', subtitle: `模型：${model || 'deepseek-v4-pro'} · ${usageText}`, time: 'AI 生成', body: analysisBody },
    episodes: { title: '分集大纲', subtitle: `${episodes.length} 集 · 人物与主线保持一致`, time: 'AI 生成', body: episodesBody },
    script: { title: script.title || '短剧剧本', subtitle: `${scenes.length} 场 · 可拍摄动作与人物对白`, time: 'AI 生成', body: scriptBody },
    storyboard: { title: storyboard.title || '即梦二点零分镜提示词', subtitle: `${shots.length} 个镜头 · 时长由剧情动态分配`, time: 'AI 生成', prompts: shots.map((shot) => String(shot.prompt || '')), durations: shots.map((shot) => resolveSeedanceDuration(shot.duration, shot.prompt, SEEDANCE_DEFAULT_DURATION)), shots, unifiedSuffix, body: storyboardBody },
    assets: { title: '本地参考图素材', subtitle: `${promptItems.length} 项 · 请按人物、场景、群像和道具分别上传`, time: '本地上传', promptItems, body: assetsBody },
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

function initializeAssetGeneration(promptItems) {
  project.assetGeneration = {
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

function alignAssetGenerationItems(prompts) {
  const state = project.assetGeneration || {};
  const current = Array.isArray(state.items) ? state.items : [];
  const byFileName = new Map(current.map((item) => [String(item.fileName || ''), item]));
  state.items = prompts.map((prompt, index) => {
    const saved = byFileName.get(String(prompt.fileName || '')) || current[index] || {};
    const files = Array.isArray(saved.files) ? saved.files.filter((file) => file?.localPath) : [];
    if (!files.length && saved.localPath) files.push({ localPath: saved.localPath, imageUrl: saved.imageUrl || '', fileName: saved.fileName || '', sourceName: saved.fileName || '' });
    return {
      name: String(prompt.name || ''),
      type: String(prompt.type || ''),
      fileName: String(saved.fileName || prompt.fileName || ''),
      status: files.length ? 'success' : 'pending',
      files,
      localPath: files[0]?.localPath || '',
      imageUrl: files[0]?.imageUrl || '',
      error: '',
      generatedAt: saved.generatedAt || '',
    };
  });
  state.provider = 'local';
  state.model = '';
  state.size = '';
  state.quality = '';
  state.totalCount = prompts.length;
  state.generatedCount = state.items.filter((item) => item.files.length).length;
  state.status = state.generatedCount === prompts.length && prompts.length ? 'complete' : 'pending';
  project.assetGeneration = state;
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
  return `@Image${number}作为${name}的补充参考图，严格保持该素材对应的人物、场景或道具一致。`;
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
  state.generatedCount = state.items.filter((videoItem) => videoItem.status === 'success').length;
  project.completed = project.completed.filter((id) => id !== 'video');
}

function materializeLegacyVideoUploads(shotIndex, prompt, item) {
  const storyboard = project.outputs.storyboard;
  if (!storyboard) return null;
  const shot = ensureStoryboardShot(storyboard, shotIndex, prompt, storyboardShotDuration(shotIndex, prompt, seedanceStatus.duration));
  if (Array.isArray(shot.uploads) && shot.uploads.length) return shot;
  const plan = resolveStrictReferencePlan({
    prompt,
    shot,
    assetItems: project.assetGeneration?.items || [],
    savedBindings: item?.referenceBindings || {},
  });
  shot.uploads = plan.bindings.map((binding) => ({
    ref: binding.ref,
    asset: String(binding.selected?.assetName || binding.assetName || ''),
    purpose: String(binding.purpose || `图片${binding.number}的视觉参考`),
    restoredFromLegacy: true,
  }));
  return shot;
}

function addVideoReference(shotIndex, assetItemIndex = null) {
  const scrollPositions = capturePageScrollPositions();
  const prompts = project.outputs.storyboard?.prompts || [];
  const state = alignVideoGenerationItems(prompts);
  const item = state.items?.[shotIndex];
  const currentPrompt = effectiveVideoPrompt(shotIndex, prompts[shotIndex], state);
  const shot = materializeLegacyVideoUploads(shotIndex, currentPrompt, item);
  if (!shot || !item) return showToast('当前镜头无法添加参考图');
  const usedNumbers = [
    ...(Array.isArray(shot.uploads) ? shot.uploads.map((upload) => Number(String(upload?.ref || '').match(/@Image(\d+)/i)?.[1] || 0)) : []),
    ...extractImageReferenceNumbers(currentPrompt),
  ].filter(Boolean);
  const number = (usedNumbers.length ? Math.max(...usedNumbers) : 0) + 1;
  if (number > 9) return showToast('单个镜头最多只能添加 9 张参考图');
  const asset = Number.isInteger(assetItemIndex) ? project.assetGeneration?.items?.[assetItemIndex] : null;
  const file = asset?.files?.[0];
  const purpose = asset ? videoReferencePurpose(asset) : '用户补充的当前镜头参考图，请在下方选择具体素材';
  shot.uploads.push({ ref: `@Image${number}`, asset: String(asset?.name || ''), purpose, addedInVideoStep: true });
  item.promptOverride = `${String(currentPrompt || '').trim()}\n${videoReferencePromptLine(number, asset)}`.trim();
  item.promptEditedAt = new Date().toISOString();
  if (asset && file) {
    item.referenceBindings = {
      ...(item.referenceBindings || {}),
      [String(number)]: {
        assetName: String(asset.name || ''),
        localPath: String(file.localPath || ''),
        trustedAssetId: normalizeTrustedAssetId(file.trustedAssetId),
        sourceName: String(file.sourceName || file.fileName || ''),
      },
    };
  }
  resetVideoItemAfterReferenceChange(item, state);
  saveProject();
  renderWithoutMovingPage(scrollPositions);
  showToast(asset ? `已将“${asset.name}”添加为 @Image${number}` : `已新增 @Image${number}，请在下拉框中选择对应图片`);
}

function removeVideoReference(shotIndex, number) {
  const scrollPositions = capturePageScrollPositions();
  const prompts = project.outputs.storyboard?.prompts || [];
  const state = alignVideoGenerationItems(prompts);
  const item = state.items?.[shotIndex];
  const currentPrompt = effectiveVideoPrompt(shotIndex, prompts[shotIndex], state);
  const shot = materializeLegacyVideoUploads(shotIndex, currentPrompt, item);
  const uploads = Array.isArray(shot?.uploads) ? shot.uploads : [];
  const target = uploads.find((upload) => Number(String(upload?.ref || '').match(/@Image(\d+)/i)?.[1]) === number);
  if (!item || !target) return showToast('没有找到要删除的参考图节点');
  const marker = new RegExp(`@Image${number}(?!\\d)`, 'i');
  const promptWithoutTarget = target.addedInVideoStep
    ? currentPrompt.split('\n').filter((line) => !marker.test(line)).join('\n')
    : currentPrompt.replace(new RegExp(`@Image${number}(?!\\d)`, 'gi'), String(target.asset || '该素材'));
  const remainingUploads = uploads.filter((upload) => upload !== target);
  const remainingBindings = Object.fromEntries(Object.entries(item.referenceBindings || {}).filter(([key]) => Number(key) !== number));
  const normalized = normalizeImageReferenceSequence(promptWithoutTarget, remainingUploads, remainingBindings);
  shot.uploads = normalized.uploads;
  item.referenceBindings = normalized.bindings;
  item.promptOverride = normalized.prompt;
  item.promptEditedAt = new Date().toISOString();
  if (state.pendingCertification?.shotIndex === shotIndex) state.pendingCertification = null;
  resetVideoItemAfterReferenceChange(item, state);
  saveProject();
  renderWithoutMovingPage(scrollPositions);
  showToast(`已从当前镜头删除图片${number}，后续编号已自动整理`);
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
  if (lockLabel) lockLabel.textContent = Number.isInteger(customAssetTargetShotIndex) ? '第六步镜头素材' : '第五步本地素材';
  if (lockHelp) lockHelp.textContent = Number.isInteger(customAssetTargetShotIndex) ? '填写名称并选择图片后，会自动创建新的 @Image 编号并绑定到当前镜头。' : '适合补充主持人、医生、秘书、额外场景或遗漏道具。创建后立即选择本地参考图片。';
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
  const state = project.videoGeneration;
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
  if (state.items?.[shotIndex]) state.items[shotIndex] = { ...state.items[shotIndex], status: 'pending', taskId: '', error: '' };
  state.pendingCertification = null;
  state.lastError = '';
  const scrollPositions = capturePageScrollPositions();
  closePortraitCertificationModal();
  saveProject();
  renderWithoutMovingPage(scrollPositions);
  showToast('可信素材已绑定，正在自动继续生成');
  window.setTimeout(() => generateSeedanceVideos({ token: ++generationRun, indexes: resumeIndexes, mode }), 0);
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
  const scrollPositions = capturePageScrollPositions();
  try {
    const result = await window.storyforgeAI.selectLocalAssetImages({
      projectId: project.id,
      projectTitle: project.title,
      index,
      assetName: String(prompt.name || `素材${index + 1}`),
      assetType: String(prompt.type || '参考图'),
    });
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
    project.completed = project.completed.filter((id) => id !== 'assets');
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
  saveProject(); render();
  showToast('已清空此项的参考图关联，磁盘中的原文件仍然保留');
}

async function showLocalAssetImage(itemIndex, fileIndex) {
  const filePath = project.assetGeneration?.items?.[itemIndex]?.files?.[fileIndex]?.localPath;
  try { await window.storyforgeAI.showLocalAssetImage(filePath); }
  catch (error) { showToast(cleanRemoteError(error, '无法找到这张参考图')); }
}

function confirmLocalAssets() {
  const prompts = project.outputs.assets?.promptItems || [];
  const state = alignAssetGenerationItems(prompts);
  const missing = state.items.filter((item) => !item.files.length);
  if (!prompts.length) return showToast('第五步没有可确认的素材清单');
  if (missing.length) return showToast(`还有 ${missing.length} 项没有上传参考图`);
  state.status = 'complete';
  state.generatedCount = state.items.length;
  if (!project.completed.includes('assets')) project.completed.push('assets');
  project.activeStep = 'video';
  if (!project.outputs.video) project.outputs.video = makeOutput('video');
  alignVideoGenerationItems(project.outputs.storyboard?.prompts || []);
  saveProject(); render();
  showToast('本地参考图已确认，可以逐个或批量生成视频');
}

async function generateImageAssets({ token, indexes = null, autoAdvance = true }) {
  if (!IMAGE_MODEL_GENERATION_ENABLED) return showToast('第五步模型生图已暂停，请为每项上传本地参考图');
  const prompts = project.outputs.assets?.promptItems || [];
  if (!prompts.length) return showToast('第五步还没有可生成的参考图提示词');
  const provider = imageProvider;
  const providerStatus = activeImageStatus(provider);
  if (!window.storyforgeAI || !providerStatus.configured) {
    project.running = false;
    project.activeStep = 'assets';
    saveProject(); render();
    openImageSettings();
    setImageMessage(`请先配置${provider === 'openai' ? ' OpenAI' : '火山方舟'} API Key。保存后会自动继续第五步。`, 'error');
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
      project.activeStep = 'video';
      saveProject(); render();
    } else showToast('所有参考图都已经生成');
    return;
  }

  project.completed = project.completed.filter((id) => id !== 'assets');
  project.activeStep = 'assets';
  project.running = true;
  state.status = 'running';
  saveProject(); render();

  for (const index of requested) {
    if (token !== generationRun) return;
    const prompt = prompts[index];
    state.items[index] = { ...state.items[index], status: 'generating', error: '' };
    state.generatedCount = state.items.filter((item) => item.status === 'success').length;
    saveProject(); render();
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
    saveProject(); render();
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
    if (autoAdvance) project.activeStep = 'video';
    saveProject(); render();
    showToast(`${imageProviderLabel(provider)} 已生成并保存 ${state.generatedCount} 张参考图`);
  } else {
    saveProject(); render();
    showToast(state.lastError || `已生成 ${state.generatedCount} 张，${failed} 张失败，可单独重试`);
  }
}

async function openAssetOutputFolder() {
  try { await window.storyforgeAI.openLocalAssetOutput(project.assetGeneration?.outputDirectory); }
  catch (error) { showToast(cleanRemoteError(error, '无法打开图片文件夹')); }
}

async function startGeneration(retry = false) {
  if (!project.script.trim()) { showToast('请先输入或导入一段剧本'); document.querySelector('#scriptInput')?.focus(); return; }
  const activeIndex = currentIndex();
  if (activeIndex === 5) {
    await generateVideoStage(++generationRun, retry === 'force-video');
    return;
  }
  if (!window.storyforgeAI || !deepseekStatus.configured) { openModelSettings(); setModelMessage('请先配置 DeepSeek API Key，再开始生成。', 'error'); return; }

  const token = ++generationRun;
  project.outputs = {};
  project.completed = [];
  project.assetGeneration = { ...defaultProject.assetGeneration, items: [] };
  project.videoGeneration = { ...defaultProject.videoGeneration, items: [] };
  project.activeStep = 'analysis';
  project.running = true;
  saveProject(); render();
  try {
    const response = await window.storyforgeAI.generateWorkflow(project.script);
    if (token !== generationRun) return;
    const outputs = renderAIWorkflow(response.data, response.usage, response.model);
    const stageIds = ['analysis', 'episodes', 'script', 'storyboard'];
    for (const stageId of stageIds) {
      if (token !== generationRun) return;
      project.activeStep = stageId;
      project.outputs[stageId] = outputs[stageId];
      project.completed.push(stageId);
      saveProject(); render();
      await wait(260);
    }
    project.activeStep = 'assets';
    project.outputs.assets = outputs.assets;
    initializeAssetGeneration(outputs.assets.promptItems || []);
    project.aiGeneration = { model: response.model || 'deepseek-v4-pro', usage: response.usage || null, generatedAt: new Date().toISOString() };
    project.running = false;
    saveProject(); render();
    showToast('DeepSeek 已完成前四步，请在第五步为每项上传本地参考图');
  } catch (error) {
    if (token !== generationRun) return;
    project.running = false;
    saveProject(); render();
    showToast(error.message || 'DeepSeek 生成失败');
    window.setTimeout(() => { openModelSettings(); setModelMessage(error.message || 'DeepSeek 生成失败，请检查设置。', 'error'); }, 100);
  }
}

function initializeVideoGeneration(prompts) {
  project.videoGeneration = {
    status: 'pending',
    model: seedanceStatus.model,
    ratio: seedanceStatus.ratio,
    resolution: seedanceStatus.resolution,
    duration: seedanceStatus.duration,
    generationMode: normalizeSeedanceGenerationMode(seedanceStatus.generationMode),
    generateAudio: seedanceStatus.generateAudio,
    outputDirectory: '',
    generatedCount: 0,
    totalCount: prompts.length,
    lastError: '',
    pendingCertification: null,
    items: prompts.map((prompt, index) => ({
      fileName: `镜头-${String(index + 1).padStart(2, '0')}.mp4`,
      duration: storyboardShotDuration(index, prompt, seedanceStatus.duration),
      status: 'pending',
      taskId: '',
      localPath: '',
      videoFileUrl: '',
      remoteVideoUrl: '',
      error: '',
    })),
  };
  return project.videoGeneration;
}

function alignVideoGenerationItems(prompts) {
  const state = project.videoGeneration || initializeVideoGeneration(prompts);
  const current = Array.isArray(state.items) ? state.items : [];
  state.items = prompts.map((prompt, index) => ({
    fileName: `镜头-${String(index + 1).padStart(2, '0')}.mp4`,
    duration: normalizeSeedanceDuration(
      current[index]?.duration,
      current[index]?.status === 'success'
        ? state.duration
        : storyboardShotDuration(index, prompt, state.duration || seedanceStatus.duration),
    ),
    status: current[index]?.status || 'pending',
    taskId: current[index]?.taskId || '',
    localPath: current[index]?.localPath || '',
    videoFileUrl: current[index]?.videoFileUrl || '',
    remoteVideoUrl: current[index]?.remoteVideoUrl || '',
    error: current[index]?.error || '',
    generatedAt: current[index]?.generatedAt || '',
    usage: current[index]?.usage || null,
    referenceBindings: current[index]?.referenceBindings && typeof current[index].referenceBindings === 'object' ? current[index].referenceBindings : {},
    ...(typeof current[index]?.promptOverride === 'string' ? { promptOverride: current[index].promptOverride } : {}),
    ...(current[index]?.promptEditedAt ? { promptEditedAt: current[index].promptEditedAt } : {}),
  }));
  state.totalCount = prompts.length;
  state.generatedCount = state.items.filter((item) => item.status === 'success').length;
  project.videoGeneration = state;
  return state;
}

function prepareSeedancePrompt(prompt, shotIndex) {
  const shot = project.outputs.storyboard?.shots?.[shotIndex] || {};
  const item = project.videoGeneration?.items?.[shotIndex] || {};
  return buildSeedanceReferenceRequest({
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

async function pollSeedanceTask(taskId, token, state, index) {
  let transientFailures = 0;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (token !== generationRun) return null;
    if (attempt > 0) await wait(10000);
    if (token !== generationRun) return null;
    try {
      const task = await window.storyforgeAI.getSeedanceTask(taskId);
      transientFailures = 0;
      const remoteStatus = task.status === 'pending' ? 'queued' : task.status;
      const displayStatus = ['succeeded', 'success'].includes(remoteStatus) ? 'downloading' : remoteStatus;
      state.items[index] = { ...state.items[index], status: displayStatus, remoteVideoUrl: task.videoUrl || '', usage: task.usage || null };
      saveProject(); render();
      if (remoteStatus === 'succeeded' || (remoteStatus === 'success' && task.videoUrl)) return task;
      if (remoteStatus === 'failed') throw new Error(task.error || 'Seedance 视频任务失败。');
    } catch (error) {
      transientFailures += 1;
      if (transientFailures >= 3 || /任务失败|无效|权限|额度|余额|尚未开通/.test(String(error?.message || ''))) throw error;
    }
  }
  throw new Error('Seedance 视频任务等待超过 30 分钟，请稍后重试或到火山方舟控制台查看。');
}

async function generateSeedanceVideos({ token, indexes = null, force = false, mode = null }) {
  const prompts = project.outputs.storyboard?.prompts || [];
  if (!prompts.length) return showToast('第四步还没有可生成的视频分镜');
  if (!window.storyforgeAI || !seedanceStatus.configured) {
    project.running = false;
    project.activeStep = 'video';
    saveProject(); render();
    openSeedanceSettings();
    setSeedanceMessage('请先配置火山方舟 API Key。保存后即可开始第六步。', 'error');
    return;
  }
  if (!project.outputs.video) project.outputs.video = makeOutput('video');
  const state = alignVideoGenerationItems(prompts);
  state.model = seedanceStatus.model;
  state.ratio = seedanceStatus.ratio;
  state.resolution = seedanceStatus.resolution;
  state.duration = seedanceStatus.duration;
  state.generationMode = normalizeSeedanceGenerationMode(mode || seedanceStatus.generationMode);
  state.generateAudio = seedanceStatus.generateAudio;
  state.lastError = '';
  const selection = selectSeedanceGenerationIndexes(state.items, { indexes, force, mode: state.generationMode });
  if (!selection.candidates.length) return showToast('所有分镜视频都已经生成');
  const emptyPromptIndex = selection.requested.find((index) => !effectiveVideoPrompt(index, prompts[index], state).trim());
  if (Number.isInteger(emptyPromptIndex)) return showToast(`镜头 ${String(emptyPromptIndex + 1).padStart(2, '0')} 的视频生成提示词不能为空`);
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
      project.activeStep = 'video';
      state.lastError = `镜头 ${String(index + 1).padStart(2, '0')}：${plan.errors[0] || '参考图绑定不完整。'}`;
      saveProject(); render();
      showToast(state.lastError);
      return;
    }
  }
  if (state.pendingCertification && selection.requested.includes(Number(state.pendingCertification.shotIndex))) {
    project.running = false;
    project.activeStep = 'video';
    saveProject(); render();
    openPortraitCertificationModal();
    return;
  }
  if (force) {
    for (const index of selection.reset) state.items[index] = { ...state.items[index], status: 'pending', taskId: '', error: '' };
  }
  const requested = selection.requested;
  project.completed = project.completed.filter((id) => id !== 'video');
  project.activeStep = 'video';
  project.running = true;
  state.status = 'running';
  saveProject(); render();

  let certificationTriggered = false;
  for (let requestPosition = 0; requestPosition < requested.length; requestPosition += 1) {
    const index = requested[requestPosition];
    if (token !== generationRun) return;
    const promptForGeneration = effectiveVideoPrompt(index, prompts[index], state);
    let prepared;
    const duration = storyboardShotDuration(index, prompts[index], state.duration);
    try {
      prepared = prepareSeedancePrompt(promptForGeneration, index);
      state.items[index] = { ...state.items[index], duration, status: 'creating', taskId: '', error: '' };
      saveProject(); render();
      const created = await window.storyforgeAI.createSeedanceTask({
        model: state.model,
        prompt: prepared.prompt,
        imageInputs: prepared.imageInputs,
        imagePaths: prepared.imagePaths,
        ratio: state.ratio,
        resolution: state.resolution,
        duration,
        generateAudio: state.generateAudio,
      });
      if (token !== generationRun) return;
      state.items[index] = { ...state.items[index], status: created.status === 'running' ? 'running' : 'queued', taskId: created.id };
      saveProject(); render();
      const task = await pollSeedanceTask(created.id, token, state, index);
      if (!task || token !== generationRun) return;
      state.items[index] = { ...state.items[index], status: 'downloading', remoteVideoUrl: task.videoUrl };
      saveProject(); render();
      const saved = await window.storyforgeAI.downloadSeedanceVideo({
        taskId: created.id,
        projectId: project.id,
        projectTitle: project.title,
        fileName: `镜头-${String(index + 1).padStart(2, '0')}.mp4`,
        index,
      });
      if (token !== generationRun) return;
      state.items[index] = { ...state.items[index], ...saved, status: 'success', error: '', generatedAt: new Date().toISOString() };
      state.outputDirectory = saved.outputDirectory || state.outputDirectory;
    } catch (error) {
      if (token !== generationRun) return;
      const message = cleanRemoteError(error, 'Seedance 视频生成失败');
      const blockedInputs = isPortraitSafetyError(message) && prepared ? blockedPortraitInputs(message, prepared) : [];
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
    state.generatedCount = state.items.filter((item) => item.status === 'success').length;
    saveProject(); render();
    if (state.lastError || certificationTriggered) break;
  }

  if (token !== generationRun) return;
  const failed = state.items.filter((item) => item.status === 'failed').length;
  const allComplete = state.items.length === prompts.length && state.items.every((item) => item.status === 'success');
  state.status = allComplete ? 'complete' : certificationTriggered ? 'awaiting-certification' : failed ? 'partial' : state.generationMode === 'confirm' ? 'awaiting-confirmation' : 'pending';
  state.generatedCount = state.items.filter((item) => item.status === 'success').length;
  project.running = false;
  if (allComplete && !project.completed.includes('video')) project.completed.push('video');
  saveProject(); render();
  const generatedIndex = requested[requested.length - 1];
  const nextIndex = state.items.findIndex((item) => item.status !== 'success');
  const resultMessage = allComplete
    ? `Seedance 已生成并保存 ${state.generatedCount} 个视频镜头`
    : certificationTriggered
      ? `镜头 ${String(Number(state.pendingCertification?.shotIndex || 0) + 1).padStart(2, '0')} 需要真人素材认证，完成后会自动继续`
    : state.lastError
      || (state.generationMode === 'confirm' && state.items[generatedIndex]?.status === 'success'
        ? `镜头 ${String(generatedIndex + 1).padStart(2, '0')} 已保存，请确认后生成镜头 ${String(nextIndex + 1).padStart(2, '0')}`
        : `已生成 ${state.generatedCount} 个，${failed} 个失败，可单独重试`);
  showToast(resultMessage);
  if (certificationTriggered) openPortraitCertificationModal();
}

async function generateVideoStage(token, force = false) {
  return generateSeedanceVideos({ token, force, mode: 'batch' });
}

async function openVideoOutputFolder() {
  try { await window.storyforgeAI.openSeedanceOutput(project.videoGeneration?.outputDirectory); }
  catch (error) { showToast(cleanRemoteError(error, '无法打开视频文件夹')); }
}

async function showGeneratedVideo(index) {
  const filePath = project.videoGeneration?.items?.[index]?.localPath;
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
refreshSeedreamStatus();
refreshOpenAIImageStatus();
refreshSeedanceStatus();
