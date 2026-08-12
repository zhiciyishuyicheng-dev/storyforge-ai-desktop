import './style.css';

const STORAGE_KEY = 'storyforge-project-v1';
const SCHEMA_VERSION = 5;

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
  title: '未命名短剧项目',
  script: '',
  activeStep: 'analysis',
  completed: [],
  outputs: {},
  seedanceMaterials: { images: 3, videos: 0, audios: 0 },
  running: false,
  updatedAt: null,
};

let project = loadProject();
let toastTimer;
let generationRun = 0;
let deepseekStatus = { configured: false, model: 'deepseek-v4-pro', checking: true };

function loadProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const migrated = { ...defaultProject, ...saved };
    if (saved?.schemaVersion !== SCHEMA_VERSION) {
      migrated.outputs = {};
      migrated.completed = [];
      migrated.activeStep = 'analysis';
      migrated.running = false;
      delete migrated.aiGeneration;
      migrated.schemaVersion = SCHEMA_VERSION;
    }
    return migrated;
  }
  catch { return { ...defaultProject }; }
}

function saveProject() {
  project.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
}

function esc(value = '') {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function currentIndex() { return steps.findIndex((step) => step.id === project.activeStep); }

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
        <button class="new-project" id="newProject"><span>＋</span> 新建项目 <kbd>⌘ N</kbd></button>
        <div class="side-label">我的项目 <span>⌁</span></div>
        <div class="project-list">
          <button class="project-item selected"><span class="project-dot"></span><span class="project-name">${esc(project.title)}</span><span class="more">•••</span></button>
          <button class="project-item muted"><span class="project-dot"></span><span>灵感收集</span></button>
        </div>
        <div class="sidebar-bottom">
          <div class="usage"><div class="usage-head"><span>本月生成额度</span><b>68%</b></div><div class="usage-bar"><i style="width:68%"></i></div><small>还剩 32 次生成</small></div>
          <button class="account" id="openSettings"><div class="avatar">深</div><div><b>DeepSeek V4 Pro</b><small>${deepseekStatus.configured ? '模型已连接' : '需要配置 API Key'}</small></div><span class="settings">⚙</span></button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar"><div class="breadcrumbs"><span>工作台</span><i>/</i><b>${esc(project.title)}</b></div><div class="top-actions"><span class="saved"><span class="saved-dot"></span> 已自动保存</span><button class="icon-button" title="字体缩放：Ctrl + / Ctrl - / Ctrl 0">A</button><button class="transfer-button" id="importProject">导入项目</button><button class="export-button" id="exportProject">导出项目 <span>↓</span></button><input type="file" id="projectFileInput" accept=".json,application/json" hidden /></div></header>
        <section class="hero"><div><div class="eyebrow">AI SHORT DRAMA STUDIO</div><h1>把故事，变成一部短剧。</h1><p>视频生成前五个阶段全部由 DeepSeek V4 Pro 完成，分镜严格遵循即梦二点零提示词规范。</p></div><div class="hero-meta"><button class="status-pill model-status ${deepseekStatus.configured ? 'connected' : 'disconnected'}" id="heroModelStatus"><i></i> ${deepseekStatus.checking ? '正在检查模型' : deepseekStatus.configured ? 'DeepSeek V4 Pro 已连接' : '点击配置 DeepSeek'}</button><span class="updated">${project.updatedAt ? '本机已保存' : '等待输入'}</span></div></section>
        <section class="workspace-grid">
          <div class="workflow-card card">
            <div class="card-head"><div><span class="section-kicker">WORKFLOW</span><h2>制作流程</h2></div><div class="progress-wrap"><span>${progress}% 完成</span><div class="progress-line"><i style="width:${Math.max(4, progress)}%"></i></div></div></div>
            <div class="steps">${steps.map(stepTemplate).join('')}</div>
            <div class="tip"><span class="tip-icon">✦</span><span><b>自动流程</b>　视频生成前的阶段会自动确认并继续，视频生成仍由你手动开始。</span><button id="dismissTip">知道了</button></div>
          </div>
          <div class="editor-card card">
            <div class="card-head editor-head"><div><span class="section-kicker">INPUT</span><h2>剧本入口</h2></div><span class="format-label">支持 TXT · DOCX · PDF</span></div>
            <div class="script-input-wrap ${project.script ? 'has-content' : ''}"><textarea id="scriptInput" placeholder="把小说改编后的剧本粘贴到这里...\n\n建议包含：集数、场景、人物和对白。${project.script ? '' : '\n\n还没有剧本？试试右下角的示例。'}">${esc(project.script)}</textarea><div class="textarea-footer"><span>${project.script.length ? `${project.script.length} 字` : '0 字'}</span><label class="upload-link" for="fileInput">↑ 导入文件</label><input type="file" id="fileInput" accept=".txt,.md" hidden /></div></div>
            <div class="input-actions"><button class="sample-link" id="useDemo">加载示例剧本 <span>↗</span></button><button class="primary-button" id="startGenerate" ${project.running ? 'disabled' : ''}><span class="sparkle">✦</span> ${generateLabel} <span>→</span></button></div>
          </div>
        </section>
        <section class="output-card card"><div class="card-head output-head"><div><span class="section-kicker">OUTPUT</span><h2>生成结果</h2></div><div class="output-tools"><button class="small-button" id="clearOutput">清空结果</button><button class="small-button" id="copyOutput">复制当前结果</button></div></div><div id="outputArea">${outputTemplate()}</div></section>
      </main>
      <div class="modal-backdrop" id="settingsModal" hidden><div class="settings-modal"><div class="modal-head"><div><span class="section-kicker">MODEL SETTINGS</span><h2>DeepSeek 模型设置</h2></div><button id="closeSettings">×</button></div><div class="model-lock"><span>固定模型</span><b>DeepSeek V4 Pro</b><small>视频生成前的故事分析、分集大纲、剧本、分镜和视觉素材全部使用此模型。</small></div><label class="key-field"><span>DeepSeek API Key</span><input id="deepseekKey" type="password" placeholder="sk-..." autocomplete="off"><small>密钥使用 Windows 本机加密保存，不会写入项目或安装包。</small></label><div class="modal-message" id="modelMessage"></div><div class="modal-actions"><button class="outline-button" id="testDeepSeek">测试连接</button><button class="primary-button" id="saveDeepSeek">保存设置</button></div><a class="key-help" href="https://platform.deepseek.com/api_keys" target="_blank">前往 DeepSeek 平台创建 API Key ↗</a></div></div>
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

function outputTemplate() {
  const output = project.outputs[project.activeStep];
  if (project.running && !output) return `<div class="generating"><div class="generating-orb">✦</div><h3>正在生成${steps[currentIndex()].label}...</h3><p>${currentIndex() < 5 ? `自动流程第 ${currentIndex() + 1} / 5 步，完成后将自动进入下一阶段` : '正在合成视频、配音与字幕'}</p><div class="generating-track"><i></i></div><small>无需手动确认，请保持程序开启</small></div>`;
  if (project.activeStep === 'video' && !output && steps.slice(0, 5).every((step) => project.completed.includes(step.id))) return `<div class="video-ready"><div class="video-ready-icon">▶</div><span class="section-kicker">READY TO GENERATE</span><h3>视频生成前的准备工作已完成</h3><p>故事、剧本、分镜和视觉素材已经自动生成。视频生成可能消耗模型额度，请确认后手动开始。</p><button class="next-button" id="generateVideo">开始生成视频 <span>→</span></button></div>`;
  if (!output) return `<div class="empty-output"><div class="empty-icon">✧</div><h3>准备好开始创作了吗？</h3><p>输入一段剧本，点击“开始生成”，你的短剧工作流会从这里展开。</p><button class="outline-button" id="emptyStart">使用示例开始 <span>→</span></button></div>`;
  return `<div class="result-layout ${project.activeStep === 'storyboard' ? 'seedance-layout' : ''}"><div class="result-main"><div class="result-title"><span class="result-badge">${steps.find((s) => s.id === project.activeStep).no}</span><div><h3>${esc(output.title)}</h3><p>${esc(output.subtitle)}</p></div><span class="result-time">刚刚生成</span></div><div class="result-body">${output.body}</div></div><div class="result-side"><div class="side-stat"><span>阶段状态</span><b><i></i> 已完成</b></div><div class="side-stat"><span>预计耗时</span><b>${output.time || '12 秒'}</b></div>${project.activeStep === 'storyboard' ? '<div class="side-stat vertical"><span>分镜规范</span><b>即梦二点零</b><small>每镜五秒<br>素材引用已分配</small></div>' : ''}<button class="outline-button full" id="rerunStep">重新生成 <span>↻</span></button>${project.activeStep === 'video' ? '<div class="auto-note">视频已生成，前置阶段无需人工确认。</div>' : '<div class="auto-note"><i>✓</i> 已自动确认并继续流程</div>'}</div></div>`;
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
  document.querySelector('#newProject').addEventListener('click', () => { generationRun += 1; project = { ...defaultProject, seedanceMaterials: { ...defaultProject.seedanceMaterials } }; saveProject(); render(); showToast('已新建空白项目'); });
  document.querySelector('#exportProject').addEventListener('click', exportProject);
  document.querySelector('#importProject').addEventListener('click', () => document.querySelector('#projectFileInput').click());
  document.querySelector('#projectFileInput').addEventListener('change', importProject);
  document.querySelector('#clearOutput').addEventListener('click', () => { generationRun += 1; project.outputs = {}; project.completed = []; project.activeStep = 'analysis'; project.running = false; saveProject(); render(); showToast('生成结果已清空'); });
  document.querySelector('#copyOutput').addEventListener('click', copyOutput);
  document.querySelector('#rerunStep')?.addEventListener('click', () => startGeneration(true));
  document.querySelector('#generateVideo')?.addEventListener('click', () => startGeneration(true));
  document.querySelector('#dismissTip').addEventListener('click', (event) => event.currentTarget.closest('.tip').remove());
  document.querySelector('#openSettings').addEventListener('click', openModelSettings);
  document.querySelector('#heroModelStatus').addEventListener('click', openModelSettings);
  document.querySelector('#closeSettings').addEventListener('click', closeModelSettings);
  document.querySelector('#settingsModal').addEventListener('click', (event) => { if (event.target.id === 'settingsModal') closeModelSettings(); });
  document.querySelector('#saveDeepSeek').addEventListener('click', saveDeepSeekSettings);
  document.querySelector('#testDeepSeek').addEventListener('click', testDeepSeekConnection);
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

function openModelSettings() { document.querySelector('#settingsModal').hidden = false; document.querySelector('#deepseekKey').focus(); }
function closeModelSettings() { document.querySelector('#settingsModal').hidden = true; }

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
  const assetItems = [
    ...(Array.isArray(assets.characters) ? assets.characters.map((item) => ({ ...item, type: '角色' })) : []),
    ...(Array.isArray(assets.scenes) ? assets.scenes.map((item) => ({ ...item, type: '场景' })) : []),
    ...(Array.isArray(assets.props) ? assets.props.map((item) => ({ ...item, type: '道具' })) : []),
  ];
  const assetsBody = `<div class="asset-grid">${assetItems.map((item, index) => `<div class="asset-card ${item.type === '角色' ? 'asset-character' : 'asset-scene'} ${index % 2 ? 'dark' : ''}"><span class="asset-type">${item.type}</span><strong>${esc(String(item.name || ''))}</strong><small>${esc(String(item.description || ''))}</small><em>DeepSeek 生成</em></div>`).join('')}</div>`;
  const usageText = usage ? `输入 ${usage.prompt_tokens || 0} · 输出 ${usage.completion_tokens || 0} tokens` : '用量由 DeepSeek 账户结算';

  return {
    analysis: { title: analysis.title || '故事结构分析', subtitle: `模型：${model || 'deepseek-v4-pro'} · ${usageText}`, time: 'AI 生成', body: analysisBody },
    episodes: { title: '分集大纲', subtitle: `${episodes.length} 集 · 人物与主线保持一致`, time: 'AI 生成', body: episodesBody },
    script: { title: script.title || '短剧剧本', subtitle: `${scenes.length} 场 · 可拍摄动作与人物对白`, time: 'AI 生成', body: scriptBody },
    storyboard: { title: storyboard.title || '即梦二点零分镜提示词', subtitle: `${shots.length} 个镜头 · 时长由剧情动态分配`, time: 'AI 生成', prompts: shots.map((shot) => String(shot.prompt || '')), unifiedSuffix, body: storyboardBody },
    assets: { title: '视觉素材清单', subtitle: `${assetItems.length} 项角色、场景与道具参考`, time: 'AI 生成', body: assetsBody },
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
  project.activeStep = 'analysis';
  project.running = true;
  saveProject(); render();
  try {
    const response = await window.storyforgeAI.generateWorkflow(project.script);
    if (token !== generationRun) return;
    const outputs = renderAIWorkflow(response.data, response.usage, response.model);
    const stageIds = ['analysis', 'episodes', 'script', 'storyboard', 'assets'];
    for (const stageId of stageIds) {
      if (token !== generationRun) return;
      project.activeStep = stageId;
      project.outputs[stageId] = outputs[stageId];
      project.completed.push(stageId);
      saveProject(); render();
      await wait(260);
    }
    project.activeStep = 'video';
    project.running = false;
    project.aiGeneration = { model: response.model || 'deepseek-v4-pro', usage: response.usage || null, generatedAt: new Date().toISOString() };
    saveProject(); render(); showToast('DeepSeek 已完成视频前五个阶段');
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
      generationRun += 1;
      project = {
        ...defaultProject,
        ...incoming,
        schemaVersion: SCHEMA_VERSION,
        running: false,
        completed: Array.isArray(incoming.completed) ? incoming.completed.filter((id) => steps.some((step) => step.id === id)) : [],
        outputs: incoming.outputs && typeof incoming.outputs === 'object' ? incoming.outputs : {},
      };
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
