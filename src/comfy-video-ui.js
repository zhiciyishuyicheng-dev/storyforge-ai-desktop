const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const options = (values, selected) => values.map(([id, label]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${label}</option>`).join('');

export function bindModalBackdropDismiss(modal, close) {
  let startedOnBackdrop = false;
  let endedOnBackdrop = false;
  modal.addEventListener('pointerdown', event => {
    startedOnBackdrop = event.target === modal && event.button === 0;
    endedOnBackdrop = false;
  });
  modal.addEventListener('pointerup', event => {
    endedOnBackdrop = event.target === modal && event.button === 0;
  });
  modal.addEventListener('pointercancel', () => { startedOnBackdrop = endedOnBackdrop = false; });
  modal.addEventListener('click', event => {
    const dismiss = startedOnBackdrop && endedOnBackdrop && event.target === modal;
    startedOnBackdrop = endedOnBackdrop = false;
    if (dismiss) close();
  });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
}

// Status refreshes redraw the app. Keep an open connection form and its text
// selection in memory rather than replacing the user's unfinished edits.
export function captureComfyVideoSettingsState(document) {
  const modal = document.querySelector('#comfyVideoSettingsModal');
  if (!modal || modal.hidden !== false) return null;
  const focused = document.activeElement;
  const message = modal.querySelector('#comfyVideoMessage');
  return {
    fields: [...modal.querySelectorAll('input, select')].map(field => ({ id: field.id, value: field.value, checked: field.checked })),
    details: [...modal.querySelectorAll('details')].map(details => details.open),
    message: message ? { text: message.textContent, className: message.className } : null,
    focus: modal.contains(focused) ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null,
  };
}

export function restoreComfyVideoSettingsState(document, state) {
  if (!state) return;
  const modal = document.querySelector('#comfyVideoSettingsModal');
  if (!modal) return;
  modal.hidden = false;
  for (const saved of state.fields) {
    const field = document.getElementById(saved.id);
    if (!field || !modal.contains(field)) continue;
    field.value = saved.value;
    if (typeof saved.checked === 'boolean') field.checked = saved.checked;
  }
  [...modal.querySelectorAll('details')].forEach((details, index) => { details.open = state.details[index] === true; });
  const message = modal.querySelector('#comfyVideoMessage');
  if (message && state.message) { message.textContent = state.message.text; message.className = state.message.className; }
  const focused = state.focus?.id && document.getElementById(state.focus.id);
  if (focused && modal.contains(focused)) {
    focused.focus({ preventScroll: true });
    if (typeof state.focus.start === 'number' && typeof focused.setSelectionRange === 'function') {
      focused.setSelectionRange(state.focus.start, state.focus.end, state.focus.direction);
    }
  }
}

export function comfyVideoSettingsTemplate(status) {
  const modelField = (key, label) => `<label class="key-field"><span>${label}</span><input id="comfy-${key}" value="${esc(status[key])}" placeholder="留空自动检测已安装模型"></label>`;
  return `<div class="modal-backdrop" id="comfyVideoSettingsModal" hidden><div class="settings-modal seedance-settings-modal">
    <div class="modal-head"><div><span class="section-kicker">VIDEO SETTINGS</span><h2>仙宫云 · MiniMax H3</h2></div><button id="closeComfyVideoSettings">×</button></div>
    <label class="key-field"><span>视频生成服务</span><select id="comfyVideoProvider"><option value="comfy">仙宫云 GPU · H3 Ref2VA</option><option value="seedance">火山方舟 · Seedance 2.0</option></select></label>
    <label class="key-field"><span>ComfyUI 访问地址</span><input id="comfy-baseUrl" type="password" value="${esc(status.baseUrl)}" placeholder="粘贴仙宫云“打开 ComfyUI”的完整地址" autocomplete="off"><small>填写实例的 ComfyUI 地址，包括访问密钥参数；连接信息在本机加密保存。实例须保持运行。</small></label>
    <label class="key-field"><span>Bearer 访问令牌（按需填写）</span><input id="comfy-token" type="password" placeholder="${status.tokenConfigured ? '已加密保存，留空继续使用' : '镜像未要求时留空'}" autocomplete="off"></label>
    <label class="toggle-field"><input id="comfy-clearToken" type="checkbox"><span>清除已保存的 Bearer 令牌</span></label>
    <div class="seedance-setting-grid">
      <label class="key-field"><span>画面比例</span><select id="comfy-ratio">${options(['16:9', '9:16', '1:1', '4:3', '3:4'].map(x => [x, x]), status.ratio)}</select></label>
      <label class="key-field"><span>画面质量</span><select id="comfy-resolution">${options([['480p', '约 480p · 试片'], ['768p', '约 768p · 成片']], status.resolution)}</select><small>按比例取整到32像素；16:9分别为864×480、1344×768。</small></label>
      <label class="key-field"><span>采样步数</span><input id="comfy-steps" type="number" min="20" max="50" value="${Number(status.steps) || 20}"></label>
      <label class="key-field"><span>生成方式</span><select id="comfy-generationMode">${options([['confirm', '逐镜确认'], ['batch', '批量连续']], status.generationMode)}</select></label>
    </div>
    <p>按分镜时长逐镜生成，单镜4—15秒；H3以24fps及17k+5帧对齐，实际片长可能略长。支持1—9张图片参考。</p>
    <label class="toggle-field"><input id="comfy-generateAudio" type="checkbox" ${status.generateAudio !== false ? 'checked' : ''}><span>保存 H3 同步音频</span></label>
    <details><summary>模型文件（测试连接可自动检测）</summary><div class="seedance-setting-grid">${modelField('model', 'Ref2VA 主模型')}${modelField('clipModel', 'H3 Qwen 文本编码器')}${modelField('videoVae', 'H3 视频 VAE')}${modelField('audioVae', 'H3 音频 VAE')}</div></details>
    <div class="modal-message" id="comfyVideoMessage"></div>
    <div class="modal-actions"><button class="outline-button" id="testComfyVideo">测试连接（不生成视频）</button><button class="primary-button" id="saveComfyVideo">保存并使用仙宫云</button></div>
  </div></div>`;
}

export function readComfyVideoSettings(document) {
  const read = key => document.querySelector(`#comfy-${key}`);
  return {
    ...Object.fromEntries(['baseUrl', 'token', 'model', 'clipModel', 'videoVae', 'audioVae', 'ratio', 'resolution', 'generationMode'].map(key => [key, read(key).value.trim()])),
    steps: Number(read('steps').value), generateAudio: read('generateAudio').checked, clearToken: read('clearToken').checked,
  };
}
