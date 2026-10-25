const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash, randomInt } = require('node:crypto');
const { downloadAndSave } = require('./seedance.cjs');

const DEFAULTS = Object.freeze({ baseUrl: '', token: '', model: '', clipModel: '', videoVae: '', audioVae: '', ratio: '16:9', resolution: '480p', duration: 5, steps: 20, generationMode: 'confirm', generateAudio: true });
const REQUIRED_NODES = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoadImage', 'MiniMaxH3ReferenceToVideo', 'RandomNoise', 'BasicGuider', 'KSamplerSelect', 'BasicScheduler', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeAudio', 'CreateVideo', 'SaveVideo'];

function connection(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('请输入仙宫云 ComfyUI 的完整访问地址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('ComfyUI 地址只支持 HTTP/HTTPS，不能包含用户名和密码。');
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function normalizeSettings(raw = {}) {
  const settings = Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, raw[key] ?? fallback]));
  settings.baseUrl = connection(settings.baseUrl).href;
  settings.token = String(settings.token || '').trim();
  if (/[\r\n]/.test(settings.token)) throw new Error('访问令牌格式无效。');
  for (const key of ['model', 'clipModel', 'videoVae', 'audioVae']) settings[key] = String(settings[key] || '').trim();
  if (settings.model && !/ref2va/i.test(settings.model)) throw new Error('H3 参考图生成必须选择 Ref2VA 模型。');
  if (!['16:9', '9:16', '1:1', '4:3', '3:4'].includes(settings.ratio)) throw new Error('H3 不支持这个画面比例。');
  if (!['480p', '768p'].includes(settings.resolution)) throw new Error('请选择 480p 试片或 768p 成片。');
  settings.steps = Number(settings.steps);
  if (!Number.isInteger(settings.steps) || settings.steps < 20 || settings.steps > 50) throw new Error('H3 基础模型采样步数须为 20 至 50。');
  settings.generationMode = settings.generationMode === 'batch' ? 'batch' : 'confirm';
  settings.generateAudio = settings.generateAudio !== false;
  return settings;
}

function endpoint(settings, route, query = {}) {
  const url = connection(settings.baseUrl);
  const relative = new URL(route.replace(/^\//, ''), 'http://comfy.internal/');
  url.pathname = `${url.pathname.replace(/\/$/, '')}${relative.pathname}`;
  for (const [key, value] of relative.searchParams) url.searchParams.set(key, value);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

function fingerprint(settings) {
  return createHash('sha256').update(connection(settings.baseUrl).href).digest('hex');
}

function createClient(settings, fetchImpl = globalThis.fetch) {
  return {
    async json(route, { method = 'GET', body, form } = {}) {
      const headers = settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      try {
        const response = await fetchImpl(endpoint(settings, route), { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual', signal: AbortSignal.timeout(120000) });
        if (response.status >= 300 && response.status < 400) throw new Error('ComfyUI 地址发生跳转，请填写能直接打开 ComfyUI 的实例访问地址及访问密钥。');
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); } catch { throw new Error('返回内容不是 ComfyUI API，请检查实例是否运行、地址是否正确，以及访问密钥是否有效。'); }
        if (!response.ok || data.error) {
          const details = Object.values(data.node_errors || {}).flatMap(node => (node.errors || []).map(e => e.details || e.message)).join('；');
          const error = new Error(`ComfyUI 请求失败（${response.status}）：${details || data.error?.message || data.error || '请检查实例权限和模型文件。'}`);
          error.definitive = true;
          throw error;
        }
        return data;
      } catch (error) {
        // Do not echo URLs (仙宫云的访问密钥可能就在 URL 查询参数里).
        if (/ComfyUI|返回内容/.test(error.message || '')) throw error;
        throw new Error('无法连接仙宫云 ComfyUI：请检查实例运行状态、访问地址和网络。');
      }
    },
  };
}

function choices(info, node, field) {
  const spec = info[node]?.input?.required?.[field] || info[node]?.input?.optional?.[field];
  return Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options || [];
}

function resolveModels(settings, info) {
  for (const node of REQUIRED_NODES) if (!info[node]) throw new Error(`ComfyUI 缺少 ${node} 节点，请更新仙宫云镜像中的 ComfyUI。`);
  const resolve = (key, node, field, pattern, preferred) => {
    const available = choices(info, node, field);
    const selected = settings[key] || available.find(name => name === preferred) || available.find(name => pattern.test(name));
    if (!selected || !available.includes(selected) || !pattern.test(selected)) throw new Error(`实例缺少可用的 ${key} 模型，请在视频设置中选择已安装的 H3 模型文件。`);
    return selected;
  };
  return {
    model: resolve('model', 'UNETLoader', 'unet_name', /ref2va/i, 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'),
    clipModel: resolve('clipModel', 'CLIPLoader', 'clip_name', /qwen3.*minimax.*h3/i, 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'),
    videoVae: resolve('videoVae', 'VAELoader', 'vae_name', /minimax.*h3.*video.*vae/i, 'minimax_h3_video_vae_fp16.safetensors'),
    audioVae: resolve('audioVae', 'VAELoader', 'vae_name', /minimax.*h3.*audio.*vae/i, 'minimax_h3_audio_vae_fp32.safetensors'),
  };
}

function dimensions(ratio, resolution) {
  const [w, h] = ratio.split(':').map(Number);
  const area = resolution === '768p' ? 1344 * 768 : 864 * 480;
  return { width: Math.round(Math.sqrt(area * w / h) / 32) * 32, height: Math.round(Math.sqrt(area * h / w) / 32) * 32 };
}

function frameCount(duration) {
  if (!Number.isFinite(duration) || duration < 4 || duration > 15) throw new Error('H3 单镜时长须在 4 至 15 秒之间，请先调整分镜。');
  // Official H3 grid: smallest 17k+5 frame count at or above requested 24 fps duration.
  return Math.ceil((Math.round(duration * 24) - 5) / 17) * 17 + 5;
}

function buildWorkflow({ settings, prompt, images, duration, seed = randomInt(0, 2 ** 48 - 1), info = null }) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('视频提示词不能为空。');
  if (!images.length || images.length > 9) throw new Error('H3 参考图生成需要 1 至 9 张参考图。');
  const nums = [...text.matchAll(/<Picture\s+(\d+)>/gi)].map(m => Number(m[1]));
  if (nums.some(n => n < 1 || n > images.length)) throw new Error('提示词中的 Picture 编号超出了本次参考图范围。');
  const size = dimensions(settings.ratio, settings.resolution);
  const node = (class_type, inputs) => ({ class_type, inputs });
  const graph = {
    '1': node('UNETLoader', { unet_name: settings.model, weight_dtype: 'default' }),
    '2': node('CLIPLoader', { clip_name: settings.clipModel, type: 'minimax', device: 'default' }),
    '3': node('VAELoader', { vae_name: settings.videoVae }),
    '4': node('VAELoader', { vae_name: settings.audioVae }),
    '5': node('MiniMaxH3ReferenceToVideo', { clip: ['2', 0], vae: ['3', 0], audio_vae: ['4', 0], prompt: text, ...size, length: frameCount(duration), ref_image_size: 'match' }),
    '6': node('RandomNoise', { noise_seed: seed }),
    '7': node('BasicGuider', { model: ['1', 0], conditioning: ['5', 0] }),
    '8': node('KSamplerSelect', { sampler_name: 'res_multistep' }),
    '9': node('BasicScheduler', { model: ['1', 0], scheduler: 'normal', steps: settings.steps, denoise: 1 }),
    '10': node('SamplerCustomAdvanced', { noise: ['6', 0], guider: ['7', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['5', 1] }),
    '11': node('VAEDecode', { samples: ['10', 0], vae: ['3', 0] }),
    '13': node('CreateVideo', { images: ['11', 0], fps: 24 }),
    '14': node('SaveVideo', { video: ['13', 0], filename_prefix: `video/StoryForge_H3_${randomUUID()}`, format: 'mp4', codec: 'h264' }),
  };
  if (settings.generateAudio) {
    graph['12'] = node('VAEDecodeAudio', { samples: ['10', 0], vae: ['4', 0] });
    graph['13'].inputs.audio = ['12', 0];
  }
  images.forEach((image, i) => {
    const id = String(100 + i);
    graph[id] = node('LoadImage', { image });
    graph['5'].inputs[`ref_images.ref_image_${i}`] = [id, 0];
  });
  // Newer ComfyUI releases add optional encoding widgets. Fill declared defaults,
  // without importing any saved director/timeline/example state.
  if (info) for (const n of Object.values(graph)) {
    for (const [key, spec] of Object.entries(info[n.class_type]?.input?.required || {})) {
      if (key in n.inputs) continue;
      if (spec[1]?.default !== undefined) n.inputs[key] = spec[1].default;
      else if (Array.isArray(spec[0])) n.inputs[key] = spec[0][0];
    }
  }
  return { graph, ...size, frames: frameCount(duration), actualDuration: frameCount(duration) / 24 };
}

function outputFile(entry) {
  const output = entry?.outputs?.['14'];
  const candidates = ['images', 'videos', 'gifs', 'video'].flatMap(key => Array.isArray(output?.[key]) ? output[key] : output?.[key] ? [output[key]] : []);
  return candidates.find(file => typeof file?.filename === 'string' && /\.mp4$/i.test(file.filename) && file.type === 'output') || null;
}

function createService({ readSettings, jobsPath, outputRoot, assertImagePath, fetchImpl = globalThis.fetch }) {
  function jobs() { try { return JSON.parse(fs.readFileSync(jobsPath, 'utf8')); } catch { return {}; } }
  function store(id, job) {
    const saved = jobs(); saved[id] = job;
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    const temp = `${jobsPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(saved, null, 2), 'utf8');
    fs.renameSync(temp, jobsPath);
  }
  function lookup(id) {
    if (!/^comfy-[a-f\d-]{36}$/i.test(String(id))) throw new Error('H3 任务 ID 无效。');
    const job = jobs()[id];
    if (!job) throw new Error('本机没有这个 H3 任务的记录。');
    const settings = normalizeSettings(readSettings());
    if (job.endpoint !== fingerprint(settings)) throw new Error('这个 H3 任务属于另一台实例，请恢复原 ComfyUI 地址后继续查询。');
    return { job, settings, client: createClient(settings, fetchImpl) };
  }
  return {
    async test(raw) {
      const settings = normalizeSettings(raw || readSettings());
      const client = createClient(settings, fetchImpl);
      await client.json('system_stats');
      const info = await client.json('object_info');
      return { ok: true, ...resolveModels(settings, info) };
    },
    async createTask(task) {
      const settings = normalizeSettings({ ...readSettings(), ratio: task.ratio, resolution: task.resolution, generateAudio: task.generateAudio });
      const id = task.taskId || `comfy-${randomUUID()}`;
      if (!/^comfy-[a-f\d-]{36}$/i.test(id)) throw new Error('H3 任务编号格式无效。');
      const existing = jobs()[id];
      if (existing) {
        if (existing.endpoint !== fingerprint(settings)) throw new Error('H3 任务属于另一台实例。');
        return { id, status: 'queued', model: existing.model, actualDuration: existing.actualDuration };
      }
      frameCount(Number(task.duration));
      const inputs = task.imageInputs || [];
      if (!inputs.length || inputs.length > 9) throw new Error('H3 参考图生成需要 1 至 9 张本地图片。');
      const paths = inputs.map((input, i) => {
        if (Number(input.referenceNumber) !== i + 1) throw new Error('H3 参考图编号必须与上传顺序一致。');
        if (!input.localPath) throw new Error(`图片${i + 1}缺少本地文件；方舟 Asset ID 不能用于 H3，请重新上传图片。`);
        const local = assertImagePath(input.localPath);
        const stat = fs.statSync(local);
        if (!stat.isFile() || stat.size > 30 * 1024 * 1024 || !/\.(png|jpe?g|webp|bmp)$/i.test(local)) throw new Error(`图片${i + 1}须为不超过 30 MB 的 PNG/JPEG/WebP/BMP 文件。`);
        return local;
      });
      const client = createClient(settings, fetchImpl);
      const info = await client.json('object_info');
      Object.assign(settings, resolveModels(settings, info));
      // Validate text/options before uploading any bytes.
      buildWorkflow({ settings, prompt: task.prompt, images: paths, duration: Number(task.duration), info });
      const images = [];
      for (const local of paths) {
        const form = new FormData();
        form.append('image', new Blob([await fs.promises.readFile(local)]), `storyforge-${randomUUID()}${path.extname(local).toLowerCase()}`);
        form.append('type', 'input'); form.append('overwrite', 'false');
        const uploaded = await client.json('upload/image', { method: 'POST', form });
        if (!uploaded.name || uploaded.type !== 'input') throw new Error('ComfyUI 没有返回有效的参考图上传结果。');
        images.push(uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name);
      }
      const built = buildWorkflow({ settings, prompt: task.prompt, images, duration: Number(task.duration), info });
      // Reserve a durable handle before submission. If the response is lost, never
      // blindly resubmit a potentially billable GPU job.
      const clientId = randomUUID();
      const record = { endpoint: fingerprint(settings), clientId, promptId: '', state: 'submitting', createdAt: new Date().toISOString(), model: settings.model, actualDuration: built.actualDuration };
      store(id, record);
      try {
        const result = await client.json('prompt', { method: 'POST', body: { client_id: clientId, prompt: built.graph, extra_data: { storyforge_task_id: id } } });
        if (!result.prompt_id) throw new Error('ComfyUI 没有返回任务编号。');
        store(id, { ...record, promptId: result.prompt_id, state: 'queued' });
      } catch (error) {
        try { store(id, { ...record, state: error.definitive ? 'rejected' : 'submission-unknown' }); } catch { /* The durable pre-submit record can still recover this job. */ }
        if (error.definitive) throw error;
        // Return the handle, so the UI can recover via client_id/history/queue.
        return { id, status: 'queued', model: settings.model, actualDuration: built.actualDuration, submissionUncertain: true };
      }
      return { id, status: 'queued', model: settings.model, actualDuration: built.actualDuration };
    },
    async getTask(id) {
      const { job, client } = lookup(id);
      if (!job.promptId) {
        const [queue, history] = await Promise.all([client.json('queue'), client.json('history?max_items=200')]);
        const queued = [...(queue.queue_running || []), ...(queue.queue_pending || [])].find(row => row[3]?.client_id === job.clientId || row[3]?.storyforge_task_id === id);
        const finished = Object.entries(history).find(([, entry]) => entry.prompt?.[3]?.client_id === job.clientId || entry.prompt?.[3]?.storyforge_task_id === id);
        job.promptId = queued?.[1] || finished?.[0] || '';
        if (!job.promptId) return { id, status: 'failed', error: '任务提交结果未确认，请先在 ComfyUI 队列及历史中核对后再重新生成，避免重复提交。' };
        store(id, job);
      }
      const history = await client.json(`history/${encodeURIComponent(job.promptId)}`);
      const entry = history[job.promptId];
      const failure = entry?.status?.messages?.find(([type]) => ['execution_error', 'execution_interrupted'].includes(type));
      if (failure || entry?.status?.status_str === 'error') return { id, status: 'failed', error: `H3 视频任务失败：${failure?.[1]?.exception_message || failure?.[0] || '请查看 ComfyUI 日志。'}` };
      const file = outputFile(entry);
      if (file) return { id, status: 'succeeded', videoUrl: `comfy-output:${id}`, model: job.model, actualDuration: job.actualDuration };
      if (entry?.status?.completed) return { id, status: 'failed', error: 'H3 已执行完成，但 SaveVideo 没有返回 MP4 文件。' };
      const queue = await client.json('queue');
      if ((queue.queue_running || []).some(row => row[1] === job.promptId)) return { id, status: 'running' };
      if ((queue.queue_pending || []).some(row => row[1] === job.promptId)) return { id, status: 'queued' };
      return { id, status: 'failed', error: '实例队列和历史中已找不到该任务，可能实例已重启或队列被清理。' };
    },
    async download(task) {
      const { job, settings, client } = lookup(task.taskId);
      const history = await client.json(`history/${encodeURIComponent(job.promptId)}`);
      const file = outputFile(history[job.promptId]);
      if (!file) throw new Error('H3 任务还没有可下载的 MP4 文件。');
      const url = endpoint(settings, 'view', { filename: file.filename, subfolder: file.subfolder || '', type: 'output' });
      return downloadAndSave({ ...task, videoUrl: url.href, outputRoot, providerName: '仙宫云 H3', allowHttp: true, requestHeaders: settings.token ? { Authorization: `Bearer ${settings.token}` } : {} });
    },
  };
}

module.exports = { DEFAULTS, REQUIRED_NODES, normalizeSettings, endpoint, createClient, resolveModels, dimensions, frameCount, buildWorkflow, outputFile, createService };
