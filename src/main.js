import './style.css';

const LEGACY_STORAGE_KEY = 'storyforge-project-v1';
const LIBRARY_STORAGE_KEY = 'storyforge-project-library-v1';
const LIBRARY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 5;
const SEEDREAM_DEFAULT_MODEL = 'doubao-seedream-5-0-lite-260128';
const SEEDREAM_DEFAULT_SIZE = '2K';
const SEEDREAM_MODELS = [
  { id: 'doubao-seedream-5-0-lite-260128', label: 'Seedream 5.0 Lite', pricePerImage: 0.22 },
  { id: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0 正式版', pricePerImage: null },
];

const steps = [
  { id: 'analysis', no: '01', label: '故事分析', icon: '⌘', sub: '主线与人物' },
  { id: 'episodes', no: '02', label: '分集大纲', icon: '▤', sub: '节奏与悬念' },
  { id: 'script', no: '03', label: '短剧剧本', icon: '✎', sub: '场次与对白' },
  { id: 'storyboard', no: '04', label: '分镜脚本', icon: '▦', sub: '镜头与动作' },
  { id: 'assets', no: '05', label: '视觉素材', icon: '✦', sub: '角色与场景' },
  { id: 'video', no: '06', label: '视频合成', icon: '▶', sub: '配音与剪辑' },
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
  assetGeneration: { status: 'idle', model: SEEDREAM_DEFAULT_MODEL, size: SEEDREAM_DEFAULT_SIZE, items: [], outputDirectory: '', generatedCount: 0, totalCount: 0 },
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

function createProject(overrides = {}) {
  const now = new Date().toISOString();
  return {
    ...defaultProject,
    seedanceMaterials: { ...defaultProject.seedanceMaterials },
    assetGeneration: { ...defaultProject.assetGeneration, items: [] },
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

function seedreamModelLabel(modelId) {
  return SEEDREAM_MODELS.find((item) => item.id === modelId)?.label || 'Seedream 5.0';
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

function appTemplate() {
  const progress = Math.round((project.completed.length / steps.length) * 100);
  const generateLabel = project.running
    ? '正在自动生成...'
    : project.activeStep === 'video'
      ? (project.outputs.video ? '重新生成视频' : '开始生成视频')
      : (project.completed.length ? '自动生成到视频' : '开始自动生成');
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
          <p class="auto-flow-note">前四步由 DeepSeek 完成，第五步由 Seedream 生成并保存参考图</p>
        </section>
        <div class="sidebar-bottom">
          <button class="account" id="openSettings"><div class="avatar">深</div><div><b>DeepSeek V4 Pro</b><small>${deepseekStatus.configured ? '模型已连接' : '需要配置 API Key'}</small></div><span class="settings">⚙</span></button>
          <button class="account seedream-account" id="openSeedreamSettings"><div class="avatar seedream-avatar">图</div><div><b>${esc(seedreamModelLabel(seedreamStatus.model))}</b><small>${seedreamStatus.configured ? `${seedreamStatus.size} 生图已连接` : '需要配置火山方舟 API Key'}</small></div><span class="settings">⚙</span></button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar"><div class="breadcrumbs"><span>工作台</span><i>/</i><b>${esc(project.title)}</b></div><div class="top-actions"><span class="saved"><span class="saved-dot"></span> 已自动保存</span><button class="icon-button" title="字体缩放：Ctrl + / Ctrl - / Ctrl 0">A</button><button class="transfer-button" id="importProject">导入项目</button><button class="export-button" id="exportProject">导出项目 <span>↓</span></button><input type="file" id="projectFileInput" accept=".json,application/json" hidden /></div></header>
        <section class="hero"><div><div class="eyebrow">AI SHORT DRAMA STUDIO</div><h1>把故事，变成一部短剧。</h1><p>DeepSeek 负责剧本与分镜，Seedream 5.0 负责第五步参考图生成，图片自动保存到本机。</p></div><div class="hero-meta"><button class="status-pill model-status ${deepseekStatus.configured ? 'connected' : 'disconnected'}" id="heroModelStatus"><i></i> ${deepseekStatus.checking ? '正在检查模型' : deepseekStatus.configured ? 'DeepSeek 已连接' : '配置 DeepSeek'}</button><button class="status-pill model-status ${seedreamStatus.configured ? 'connected' : 'disconnected'}" id="heroSeedreamStatus"><i></i> ${seedreamStatus.checking ? '正在检查生图模型' : seedreamStatus.configured ? 'Seedream 已连接' : '配置 Seedream'}</button><span class="updated">${project.updatedAt ? '本机已保存' : '等待输入'}</span></div></section>
        <section class="output-card card"><div class="card-head output-head"><div><span class="section-kicker">OUTPUT</span><h2>生成结果</h2></div><div class="output-tools"><button class="small-button" id="clearOutput">清空结果</button><button class="small-button" id="copyOutput">复制当前结果</button></div></div><div id="outputArea">${outputTemplate()}</div></section>
      </main>
      <div class="modal-backdrop" id="settingsModal" hidden><div class="settings-modal"><div class="modal-head"><div><span class="section-kicker">MODEL SETTINGS</span><h2>DeepSeek 模型设置</h2></div><button id="closeSettings">×</button></div><div class="model-lock"><span>固定模型</span><b>DeepSeek V4 Pro</b><small>视频生成前的故事分析、分集大纲、剧本、分镜和视觉素材全部使用此模型。</small></div><label class="key-field"><span>DeepSeek API Key</span><input id="deepseekKey" type="password" placeholder="sk-..." autocomplete="off"><small>密钥使用 Windows 本机加密保存，不会写入项目或安装包。</small></label><div class="modal-message" id="modelMessage"></div><div class="modal-actions"><button class="outline-button" id="testDeepSeek">测试连接</button><button class="primary-button" id="saveDeepSeek">保存设置</button></div><a class="key-help" href="https://platform.deepseek.com/api_keys" target="_blank">前往 DeepSeek 平台创建 API Key ↗</a></div></div>
      <div class="modal-backdrop" id="seedreamSettingsModal" hidden><div class="settings-modal"><div class="modal-head"><div><span class="section-kicker">IMAGE MODEL SETTINGS</span><h2>Seedream 5.0 生图设置</h2></div><button id="closeSeedreamSettings">×</button></div><div class="model-lock seedream-lock"><span>第五步真实生图</span><b>火山方舟 Seedream 5.0</b><small>逐张生成角色、场景和道具参考图，并保存到“文档\StoryForge\项目名\项目编号\视觉素材”。</small></div><label class="key-field"><span>火山方舟 API Key</span><input id="seedreamKey" type="password" placeholder="输入 ARK_API_KEY" autocomplete="off"><small>${seedreamStatus.configured ? '密钥已加密保存；留空可只修改模型和尺寸。' : '密钥使用 Windows 本机加密保存，不会写入项目或安装包。'}</small></label><label class="key-field"><span>图片模型</span><select id="seedreamModel">${SEEDREAM_MODELS.map((item) => `<option value="${item.id}" ${item.id === seedreamStatus.model ? 'selected' : ''}>${item.label}${item.pricePerImage ? ` · ¥${item.pricePerImage.toFixed(2)}/张` : ' · 需账号单独开通'}</option>`).join('')}</select><small>充值只增加余额；Seedream 5.0 正式版和 Lite 都需要在火山方舟单独开通。</small></label><label class="key-field"><span>输出尺寸</span><select id="seedreamSize"><option value="2K" ${seedreamStatus.size === '2K' ? 'selected' : ''}>2K（推荐）</option><option value="4K" ${seedreamStatus.size === '4K' ? 'selected' : ''}>4K</option></select><small>每个提示词生成一张 PNG 图片，不加水印。</small></label><div class="modal-message" id="seedreamMessage"></div><div class="modal-actions"><button class="outline-button" id="testSeedream">测试 API Key（不生图）</button><button class="primary-button" id="saveSeedream">保存设置</button></div><div class="key-links"><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">开通 Seedream 模型服务 ↗</a><a class="key-help" href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?projectName=default" target="_blank">管理 API Key ↗</a></div></div></div>
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
  const state = project.assetGeneration || defaultProject.assetGeneration;
  const items = Array.isArray(state.items) ? state.items : [];
  const completed = items.filter((item) => item.status === 'success').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const progress = prompts.length ? Math.round((completed / prompts.length) * 100) : 0;
  const modelInfo = SEEDREAM_MODELS.find((item) => item.id === (state.model || seedreamStatus.model));
  const priceText = modelInfo?.pricePerImage
    ? `预计 ¥${(prompts.length * modelInfo.pricePerImage).toFixed(2)}（${prompts.length} 张 × ¥${modelInfo.pricePerImage.toFixed(2)}）`
    : `${prompts.length} 张，费用以火山方舟控制台为准`;
  const statusText = state.status === 'running'
    ? `正在生成 ${Math.min(completed + 1, prompts.length)} / ${prompts.length}`
    : completed === prompts.length && prompts.length
      ? `已完成 ${completed} / ${prompts.length}`
      : failed
        ? `已完成 ${completed} 张，失败 ${failed} 张`
        : `等待生成 ${prompts.length} 张`;
  const cards = prompts.map((prompt, index) => {
    const result = items[index] || { status: 'pending' };
    const statusLabel = { pending: '待生成', generating: '生成中', success: '已保存', failed: '生成失败' }[result.status] || '待生成';
    const preview = result.status === 'success' && result.imageUrl
      ? `<button class="asset-image-preview" data-show-asset-index="${index}" title="在文件夹中查看"><img src="${esc(String(result.imageUrl))}" alt="${esc(String(prompt.name || '参考图'))}"></button>`
      : `<div class="asset-image-placeholder ${result.status}"><span>${result.status === 'generating' ? '✦' : result.status === 'failed' ? '!' : '图'}</span><small>${esc(statusLabel)}</small></div>`;
    return `<article class="generated-asset-card">${preview}<div class="generated-asset-copy"><div><span>${esc(String(prompt.type || '参考图'))}</span><h4>${esc(String(prompt.name || `参考图${index + 1}`))}</h4><code>${esc(String(result.fileName || prompt.fileName || ''))}</code></div><b class="asset-result-status ${result.status}">${statusLabel}</b>${result.error ? `<p>${esc(cleanRemoteError(result.error, '生成失败'))}</p>` : ''}<button class="outline-button generate-one-asset" data-generate-asset-index="${index}" ${project.running ? 'disabled' : ''}>${result.status === 'success' ? '重新生成此图' : result.status === 'failed' ? '重试此图' : '生成此图'}</button></div></article>`;
  }).join('');
  return `<section class="seedream-generator"><div class="seedream-generator-head"><div><span class="section-kicker">SEEDREAM 5.0 IMAGE GENERATION</span><h4>第五步 · 生成真实参考图</h4><p>${esc(seedreamModelLabel(state.model || seedreamStatus.model))} · ${esc(String(state.size || seedreamStatus.size))} · ${esc(priceText)}</p></div><div class="seedream-actions"><button class="outline-button" id="configureSeedream">模型设置</button>${state.outputDirectory ? '<button class="outline-button" id="openAssetFolder">打开图片文件夹</button>' : ''}<button class="primary-button" id="generateAllAssets" ${project.running || !prompts.length ? 'disabled' : ''}>${failed ? '重试失败图片' : completed ? '继续生成' : '开始生成全部图片'}</button></div></div><div class="seedream-progress"><div><b>${esc(statusText)}</b><span>${progress}%</span></div><i><em style="width:${progress}%"></em></i>${!seedreamStatus.configured ? '<small>尚未配置火山方舟 API Key，配置后即可开始真实生图。</small>' : '<small>生成时请保持程序开启。成功图片不会因单张失败而丢失。</small>'}${state.lastError ? `<p class="seedream-global-error">${esc(cleanRemoteError(state.lastError, '生成失败'))}</p>` : ''}</div>${cards ? `<div class="generated-assets-grid">${cards}</div>` : ''}</section>`;
}

function outputTemplate() {
  const output = project.outputs[project.activeStep];
  if (project.running && !output) return `<div class="generating"><div class="generating-orb">✦</div><h3>正在生成${steps[currentIndex()].label}...</h3><p>${currentIndex() < 5 ? `自动流程第 ${currentIndex() + 1} / 5 步，完成后将自动进入下一阶段` : '正在合成视频、配音与字幕'}</p><div class="generating-track"><i></i></div><small>无需手动确认，请保持程序开启</small></div>`;
  if (project.activeStep === 'video' && !output && steps.slice(0, 5).every((step) => project.completed.includes(step.id))) return `<div class="video-ready"><div class="video-ready-icon">▶</div><span class="section-kicker">READY TO GENERATE</span><h3>视频生成前的准备工作已完成</h3><p>故事、剧本、分镜和视觉素材已经自动生成。视频生成可能消耗模型额度，请确认后手动开始。</p><button class="next-button" id="generateVideo">开始生成视频 <span>→</span></button></div>`;
  if (!output) return `<div class="empty-output"><div class="empty-icon">✧</div><h3>准备好开始创作了吗？</h3><p>输入一段剧本，点击“开始生成”，你的短剧工作流会从这里展开。</p><button class="outline-button" id="emptyStart">使用示例开始 <span>→</span></button></div>`;
  const isAssets = project.activeStep === 'assets';
  const stageComplete = project.completed.includes(project.activeStep);
  const stageStatus = project.running ? '生成中' : stageComplete ? '已完成' : '待生成';
  const body = `${isAssets ? assetGenerationTemplate(output) : ''}${output.body}`;
  return `<div class="result-layout ${project.activeStep === 'storyboard' ? 'seedance-layout' : ''} ${isAssets ? 'assets-layout' : ''}"><div class="result-main"><div class="result-title"><span class="result-badge">${steps.find((s) => s.id === project.activeStep).no}</span><div><h3>${esc(output.title)}</h3><p>${esc(output.subtitle)}</p></div><span class="result-time">刚刚生成</span></div><div class="result-body">${body}</div></div><div class="result-side"><div class="side-stat"><span>阶段状态</span><b><i></i> ${stageStatus}</b></div><div class="side-stat"><span>预计耗时</span><b>${output.time || '12 秒'}</b></div>${project.activeStep === 'storyboard' ? '<div class="side-stat vertical"><span>分镜规范</span><b>即梦二点零</b><small>每镜五秒<br>素材引用已分配</small></div>' : ''}${isAssets ? `<div class="side-stat vertical"><span>生图模型</span><b>${esc(seedreamModelLabel(project.assetGeneration?.model || seedreamStatus.model))}</b><small>${esc(String(project.assetGeneration?.size || seedreamStatus.size))} · 本机自动保存</small></div>` : ''}<button class="outline-button full" id="rerunStep">重新生成 <span>↻</span></button>${project.activeStep === 'video' ? '<div class="auto-note">视频已生成，前置阶段无需人工确认。</div>' : stageComplete ? '<div class="auto-note"><i>✓</i> 已自动确认并继续流程</div>' : '<div class="auto-note">当前阶段尚未完成</div>'}</div></div>`;
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
  return { title: '视频合成准备就绪', subtitle: '配音、字幕与镜头已完成时间线编排', time: '30 秒', body: `<div class="video-preview"><div class="video-placeholder"><div class="play-circle">▶</div><span>第 1 集预览</span><small>点击生成视频后可在此预览</small></div><div class="timeline"><div class="timeline-head"><span>SCENE 01</span><span>00:00:00 — 00:00:18</span></div><div class="timeline-track"><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="timeline-labels"><span>画面</span><span>对白</span><span>音乐 / 音效</span></div></div></div><div class="callout success"><b>可以开始合成</b><span>素材、配音和字幕均已准备。点击右侧按钮开始生成视频文件。</span></div>` };
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
  return { title: '第1集 · 即梦二点零分镜提示词', subtitle: `${shots.length}个独立镜头 · 每镜五秒 · 已识别人物：${characterSummary}`, time: '18秒', prompts: shots.map((shot) => shot.prompt), characters: characterNames, body };
}

function deriveTitle(script) {
  const first = script.split(/\n+/).find((line) => line.trim() && !/^第\s*\d+\s*集/.test(line.trim())) || '未命名短剧项目';
  return first.replace(/^第\s*\d+\s*集\s*/, '').slice(0, 18) || '未命名短剧项目';
}

function render() {
  document.querySelector('#app').innerHTML = appTemplate();
  bindEvents();
}

function bindEvents() {
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
  document.querySelector('#clearOutput').addEventListener('click', () => { generationRun += 1; project.outputs = {}; project.completed = []; project.assetGeneration = { ...defaultProject.assetGeneration, items: [] }; project.activeStep = 'analysis'; project.running = false; saveProject(); render(); showToast('生成结果已清空，本地已生成图片不会被删除'); });
  document.querySelector('#copyOutput').addEventListener('click', copyOutput);
  document.querySelector('#rerunStep')?.addEventListener('click', () => startGeneration(true));
  document.querySelector('#generateVideo')?.addEventListener('click', () => startGeneration(true));
  document.querySelector('#openSettings').addEventListener('click', openModelSettings);
  document.querySelector('#openSeedreamSettings').addEventListener('click', openSeedreamSettings);
  document.querySelector('#heroModelStatus').addEventListener('click', openModelSettings);
  document.querySelector('#heroSeedreamStatus').addEventListener('click', openSeedreamSettings);
  document.querySelector('#closeSettings').addEventListener('click', closeModelSettings);
  document.querySelector('#settingsModal').addEventListener('click', (event) => { if (event.target.id === 'settingsModal') closeModelSettings(); });
  document.querySelector('#saveDeepSeek').addEventListener('click', saveDeepSeekSettings);
  document.querySelector('#testDeepSeek').addEventListener('click', testDeepSeekConnection);
  document.querySelector('#closeSeedreamSettings').addEventListener('click', closeSeedreamSettings);
  document.querySelector('#seedreamSettingsModal').addEventListener('click', (event) => { if (event.target.id === 'seedreamSettingsModal') closeSeedreamSettings(); });
  document.querySelector('#saveSeedream').addEventListener('click', saveSeedreamSettings);
  document.querySelector('#testSeedream').addEventListener('click', testSeedreamConnection);
  document.querySelector('#configureSeedream')?.addEventListener('click', openSeedreamSettings);
  document.querySelector('#generateAllAssets')?.addEventListener('click', () => generateSeedreamAssets({ token: ++generationRun, autoAdvance: true }));
  document.querySelector('#openAssetFolder')?.addEventListener('click', openAssetOutputFolder);
  document.querySelectorAll('[data-show-asset-index]').forEach((button) => button.addEventListener('click', () => showGeneratedAsset(Number(button.dataset.showAssetIndex))));
  document.querySelectorAll('[data-generate-asset-index]').forEach((button) => button.addEventListener('click', () => generateSeedreamAssets({ token: ++generationRun, indexes: [Number(button.dataset.generateAssetIndex)], autoAdvance: false })));
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
function openSeedreamSettings() { document.querySelector('#seedreamSettingsModal').hidden = false; document.querySelector('#seedreamKey').focus(); }
function closeSeedreamSettings() { document.querySelector('#seedreamSettingsModal').hidden = true; }

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

function setSeedreamMessage(message, type = '') {
  const node = document.querySelector('#seedreamMessage');
  if (!node) return;
  node.textContent = message;
  node.className = `modal-message ${type}`;
}

async function saveSeedreamSettings() {
  const apiKey = document.querySelector('#seedreamKey').value.trim();
  const model = document.querySelector('#seedreamModel').value;
  const size = document.querySelector('#seedreamSize').value;
  if (!apiKey && !seedreamStatus.configured) return setSeedreamMessage('请输入火山方舟 API Key。', 'error');
  setSeedreamMessage('正在使用 Windows 安全保存…');
  try {
    const status = await window.storyforgeAI.saveSeedreamSettings({ apiKey, model, size });
    seedreamStatus = { ...seedreamStatus, ...status, checking: false };
    setSeedreamMessage('Seedream 设置已安全保存。', 'success');
    const shouldResume = project.activeStep === 'assets'
      && project.outputs.assets?.promptItems?.length
      && !project.completed.includes('assets')
      && !project.running;
    window.setTimeout(() => {
      closeSeedreamSettings();
      render();
      showToast(`${seedreamModelLabel(model)} 已配置`);
      if (shouldResume) generateSeedreamAssets({ token: ++generationRun, autoAdvance: true });
    }, 450);
  } catch (error) { setSeedreamMessage(cleanRemoteError(error, '保存失败。'), 'error'); }
}

async function testSeedreamConnection() {
  const apiKey = document.querySelector('#seedreamKey').value.trim();
  setSeedreamMessage('正在验证火山方舟 API Key，不会生成图片或产生生图费用…');
  try {
    await window.storyforgeAI.testSeedreamConnection(apiKey);
    setSeedreamMessage('API Key 有效。注意：所选模型是否已开通，会在首次生图时验证。', 'success');
  } catch (error) { setSeedreamMessage(cleanRemoteError(error, '连接失败。'), 'error'); }
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
    ...(Array.isArray(assets.characters) ? assets.characters.map((item) => ({ ...item, type: '人物三视图' })) : []),
    ...(Array.isArray(assets.scenes) ? assets.scenes.map((item) => ({ ...item, type: '场景设定图' })) : []),
    ...(Array.isArray(assets.groups) ? assets.groups.map((item) => ({ ...item, type: '群像参考图' })) : []),
    ...(Array.isArray(assets.props) ? assets.props.map((item) => ({ ...item, type: '道具参考图' })) : []),
  ].map((item) => ({ ...item, prompt: String(item.prompt || item.description || '') }));
  const checklistBody = checklist.length ? `<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">CAST CHECKLIST</span><h4>人物三视图生成清单</h4></div><span>${checklist.filter((item) => item.requiresTurnaround).length} 人需要单独出图</span></div><div class="asset-checklist">${checklist.map((item) => `<div><b>${esc(String(item.name || ''))}</b><span>${esc(String(item.roleType || '人物'))}</span><div class="asset-flags"><i class="${item.speaks ? 'yes' : ''}">对白</i><i class="${item.drivesPlot ? 'yes' : ''}">推动剧情</i><i class="${item.recurring ? 'yes' : ''}">反复出现</i><i class="${item.needsCloseUp ? 'yes' : ''}">特写</i></div><em class="${item.requiresTurnaround ? 'required' : ''}">${item.requiresTurnaround ? '生成三视图' : '归入功能人物'}</em><small>${esc(String(item.reason || ''))}</small></div>`).join('')}</div></section>` : '';
  const matrixBody = differenceMatrix.length ? `<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">FACE DIFFERENCE MATRIX</span><h4>人物差异化视觉锚点</h4></div><span>防止角色同脸</span></div><div class="asset-matrix"><div class="asset-matrix-row header"><b>角色 / 脸谱</b><b>面部锚点</b><b>发型 / 体态</b><b>服装 / 排除项</b></div>${differenceMatrix.map((item) => `<div class="asset-matrix-row"><b>${esc(String(item.name || ''))}<small>${esc(String(item.faceCode || ''))} · ${esc(String(item.ageRange || item.ageImpression || ''))}</small></b><span>${esc([item.faceShape, item.eyeShape, item.brows, item.noseLips, item.jawCheekbones].filter(Boolean).join('；'))}</span><span>${esc([item.hair, item.bodyType].filter(Boolean).join('；'))}</span><span>${esc([item.clothingSilhouette, item.signatureAccessory, item.differentFrom].filter(Boolean).join('；'))}</span></div>`).join('')}</div></section>` : '';
  const promptCards = promptItems.map((item, index) => `<article class="asset-prompt-card"><div class="asset-prompt-head"><div><span>${esc(String(item.type))}</span><h4>${esc(String(item.name || '参考图'))}</h4><code>${esc(String(item.fileName || ''))}</code></div><button class="copy-asset-prompt" data-asset-prompt-index="${index}">复制提示词</button></div>${item.description ? `<p>${esc(String(item.description))}</p>` : ''}${Array.isArray(item.exclusions) && item.exclusions.length ? `<div class="asset-exclusions"><b>排除：</b>${item.exclusions.map((value) => `<span>${esc(String(value))}</span>`).join('')}</div>` : ''}${Array.isArray(item.spatialAnchors) && item.spatialAnchors.length ? `<div class="asset-exclusions anchors"><b>空间锚点：</b>${item.spatialAnchors.map((value) => `<span>${esc(String(value))}</span>`).join('')}</div>` : ''}<pre>${esc(item.prompt)}</pre></article>`).join('');
  const assetsBody = `${checklistBody}${matrixBody}<section class="asset-section"><div class="asset-section-head"><div><span class="section-kicker">REFERENCE IMAGE PROMPTS</span><h4>参考图生成提示词</h4></div><button id="copyAllAssetPrompts">复制全部提示词</button></div><div class="asset-prompt-list">${promptCards}</div></section>`;
  const usageText = usage ? `输入 ${usage.prompt_tokens || 0} · 输出 ${usage.completion_tokens || 0} tokens` : '用量由 DeepSeek 账户结算';

  return {
    analysis: { title: analysis.title || '故事结构分析', subtitle: `模型：${model || 'deepseek-v4-pro'} · ${usageText}`, time: 'AI 生成', body: analysisBody },
    episodes: { title: '分集大纲', subtitle: `${episodes.length} 集 · 人物与主线保持一致`, time: 'AI 生成', body: episodesBody },
    script: { title: script.title || '短剧剧本', subtitle: `${scenes.length} 场 · 可拍摄动作与人物对白`, time: 'AI 生成', body: scriptBody },
    storyboard: { title: storyboard.title || '即梦二点零分镜提示词', subtitle: `${shots.length} 个镜头 · 时长由剧情动态分配`, time: 'AI 生成', prompts: shots.map((shot) => String(shot.prompt || '')), unifiedSuffix, body: storyboardBody },
    assets: { title: 'Seedream 5.0 视觉素材', subtitle: `${promptItems.length} 张 · 人物三视图、场景多视角、群像与道具`, time: '逐张生成', promptItems, body: assetsBody },
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
    model: seedreamStatus.model || SEEDREAM_DEFAULT_MODEL,
    size: seedreamStatus.size || SEEDREAM_DEFAULT_SIZE,
    outputDirectory: '',
    generatedCount: 0,
    totalCount: promptItems.length,
    items: promptItems.map((item) => ({
      name: String(item.name || ''),
      type: String(item.type || ''),
      fileName: String(item.fileName || ''),
      status: 'pending',
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
    return {
      name: String(prompt.name || ''),
      type: String(prompt.type || ''),
      fileName: String(saved.fileName || prompt.fileName || ''),
      status: saved.status || 'pending',
      localPath: saved.localPath || '',
      imageUrl: saved.imageUrl || '',
      error: saved.error || '',
      generatedAt: saved.generatedAt || '',
    };
  });
  state.model = state.model || seedreamStatus.model || SEEDREAM_DEFAULT_MODEL;
  state.size = state.size || seedreamStatus.size || SEEDREAM_DEFAULT_SIZE;
  state.totalCount = prompts.length;
  project.assetGeneration = state;
  return state;
}

async function generateSeedreamAssets({ token, indexes = null, autoAdvance = true }) {
  const prompts = project.outputs.assets?.promptItems || [];
  if (!prompts.length) return showToast('第五步还没有可生成的参考图提示词');
  if (!window.storyforgeAI || !seedreamStatus.configured) {
    project.running = false;
    project.activeStep = 'assets';
    saveProject(); render();
    openSeedreamSettings();
    setSeedreamMessage('请先配置火山方舟 API Key。保存后会自动继续第五步。', 'error');
    return;
  }

  const state = alignAssetGenerationItems(prompts);
  state.model = seedreamStatus.model;
  state.size = seedreamStatus.size;
  state.lastError = '';
  const requested = Array.isArray(indexes)
    ? indexes.filter((index) => Number.isInteger(index) && index >= 0 && index < prompts.length)
    : prompts.map((_, index) => index).filter((index) => state.items[index].status !== 'success');
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
      const result = await window.storyforgeAI.generateSeedreamImage({
        projectId: project.id,
        projectTitle: project.title,
        index,
        prompt: prompt.prompt,
        fileName: prompt.fileName,
        model: state.model,
        size: state.size,
      });
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
      if (/尚未开通|API Key 无效|没有模型权限|额度不足/.test(message)) state.lastError = message;
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
    showToast(`Seedream 已生成并保存 ${state.generatedCount} 张参考图`);
  } else {
    saveProject(); render();
    showToast(state.lastError || `已生成 ${state.generatedCount} 张，${failed} 张失败，可单独重试`);
  }
}

async function openAssetOutputFolder() {
  try { await window.storyforgeAI.openSeedreamOutput(project.assetGeneration?.outputDirectory); }
  catch (error) { showToast(cleanRemoteError(error, '无法打开图片文件夹')); }
}

async function showGeneratedAsset(index) {
  const filePath = project.assetGeneration?.items?.[index]?.localPath;
  try { await window.storyforgeAI.showSeedreamImage(filePath); }
  catch (error) { showToast(cleanRemoteError(error, '无法找到这张图片')); }
}

async function startGeneration(retry = false) {
  if (!project.script.trim()) { showToast('请先输入或导入一段剧本'); document.querySelector('#scriptInput')?.focus(); return; }
  const activeIndex = currentIndex();
  if (activeIndex === 5) {
    await generateVideoStage(++generationRun);
    return;
  }
  if (!window.storyforgeAI || !deepseekStatus.configured) { openModelSettings(); setModelMessage('请先配置 DeepSeek API Key，再开始生成。', 'error'); return; }

  const token = ++generationRun;
  project.outputs = {};
  project.completed = [];
  project.assetGeneration = { ...defaultProject.assetGeneration, items: [] };
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
    saveProject(); render();
    if (!seedreamStatus.configured) {
      project.running = false;
      saveProject(); render();
      openSeedreamSettings();
      setSeedreamMessage('DeepSeek 已完成前四步。请配置火山方舟 API Key，保存后自动生成第五步参考图。', 'error');
      return;
    }
    await generateSeedreamAssets({ token, autoAdvance: true });
  } catch (error) {
    if (token !== generationRun) return;
    project.running = false;
    saveProject(); render();
    showToast(error.message || 'DeepSeek 生成失败');
    window.setTimeout(() => { openModelSettings(); setModelMessage(error.message || 'DeepSeek 生成失败，请检查设置。', 'error'); }, 100);
  }
}

async function generateVideoStage(token) {
  project.activeStep = 'video'; project.running = true; saveProject(); render();
  await wait(1400);
  if (token !== generationRun) return;
  project.outputs.video = makeOutput('video');
  if (!project.completed.includes('video')) project.completed.push('video');
  project.running = false; saveProject(); render(); showToast('视频合成阶段已生成');
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
