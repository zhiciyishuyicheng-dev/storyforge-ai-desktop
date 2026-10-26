import * as skillHistory from './generation-skill-history.js';
import * as outlineUI from './storyboard-outline.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as durations from './seedance-duration.js';
import * as references from './seedance-references.js';
import * as generation from './seedance-generation.js';
import * as progress from './workflow-progress.js';
import * as h3 from './h3-references.js';
import * as comfyUI from './comfy-video-ui.js';

const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const renderer = source.slice(0, source.lastIndexOf('\nrender();')).replace(/^import .*;\r?\n/gm, '');

// Model browser event targets and DOM replacement without replacing the app's
// actual event-binding, open/close, refresh, read-settings, or render functions.
function documentFixture() {
  const document = { activeElement: null, nodes: new Map() };
  class Element {
    constructor(id) { this.id = id; this.hidden = true; this.value = ''; this.checked = false; this.listeners = new Map(); this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; }
    addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
    dispatch(type, properties = {}) {
      const event = { target: this, currentTarget: this, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
      for (const listener of this.listeners.get(type) || []) listener(event);
      return event;
    }
    closest() { return null; }
    contains(node) { return this === document.modal && (node === this || document.fields.includes(node) || node === document.details || node === document.message); }
    querySelector(selector) { return selector === '#comfyVideoMessage' ? document.message : null; }
    querySelectorAll(selector) { return selector === 'input, select' ? document.fields : selector === 'details' ? [document.details] : []; }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  }
  const initial = { baseUrl: 'https://cached.example/?token=old', token: '', model: '', clipModel: '', videoVae: '', audioVae: '', ratio: '16:9', resolution: '480p', generationMode: 'confirm', steps: '20', generateAudio: '', clearToken: '' };
  document.rebuild = () => {
    document.nodes = new Map([['app', root]]);
    document.modal = new Element('comfyVideoSettingsModal'); document.nodes.set(document.modal.id, document.modal);
    document.fields = Object.entries(initial).map(([key, value]) => { const field = new Element('comfy-' + key); field.value = value; document.nodes.set(field.id, field); return field; });
    document.details = new Element('comfy-details'); document.details.open = false;
    document.message = new Element('comfyVideoMessage'); document.message.textContent = ''; document.message.className = 'modal-message'; document.nodes.set(document.message.id, document.message);
    document.activeElement = null;
  };
  const root = new Element('app');
  Object.defineProperty(root, 'innerHTML', { set() { document.rebuild(); } });
  document.querySelector = selector => {
    if (!selector.startsWith('#')) return null;
    const id = selector.slice(1);
    if (!document.nodes.has(id)) document.nodes.set(id, new Element(id));
    return document.nodes.get(id);
  };
  document.getElementById = id => document.nodes.get(id) || null;
  document.querySelectorAll = () => [];
  document.rebuild();
  return document;
}

function harness(api = {}) {
  const document = documentFixture(), storage = new Map(), saved = [];
  const context = vm.createContext({
    ...skillHistory,
    ...outlineUI,
    ...durations, ...references, ...generation, ...progress, ...h3, ...comfyUI, structuredClone, document,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { storyforgeAI: {
      getComfyVideoStatus: async () => ({ configured: true, baseUrl: 'https://cached.example/?token=old' }),
      saveComfyVideoSettings: async settings => { saved.push(settings); return { ...settings, configured: true }; },
      ...api,
    }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
  });
  vm.runInContext(renderer, context);
  vm.runInContext('showToast = () => {}; render(); openComfyVideoSettings();', context);
  return { document, saved, run: code => vm.runInContext(code, context) };
}

test('drag-selecting a cached ComfyUI address onto the backdrop keeps the actual settings modal open', () => {
  const h = harness(), modal = h.document.modal, input = h.document.getElementById('comfy-baseUrl');
  input.focus(); input.setSelectionRange(0, input.value.length);
  modal.dispatch('pointerdown', { target: input });
  modal.dispatch('pointerup');
  // Chromium targets the click at the common ancestor of the down/up targets.
  modal.dispatch('click');
  assert.equal(modal.hidden, false);
  assert.equal(input.selectionEnd, input.value.length);
  modal.dispatch('pointerdown'); modal.dispatch('pointerup', { target: input }); modal.dispatch('click');
  assert.equal(modal.hidden, false);
  modal.dispatch('pointerdown'); modal.dispatch('pointerup'); modal.dispatch('click');
  assert.equal(modal.hidden, true);
});

test('select-all and replacing the cached address can be saved; the close button remains wired', async () => {
  const h = harness(), modal = h.document.modal, input = h.document.getElementById('comfy-baseUrl');
  input.focus(); input.setSelectionRange(0, input.value.length);
  const selectAll = modal.dispatch('keydown', { target: input, key: 'a', ctrlKey: true });
  assert.equal(selectAll.defaultPrevented, false);
  input.value = 'https://replacement.example/comfy?token=new';
  await h.run('saveComfyVideoSettings()');
  assert.equal(h.saved[0].baseUrl, 'https://replacement.example/comfy?token=new');
  assert.equal(h.document.modal.hidden, true);
  h.run('openComfyVideoSettings()');
  h.document.querySelector('#closeComfyVideoSettings').dispatch('click');
  assert.equal(h.document.modal.hidden, true);
});

test('an async connection-status refresh preserves the open URL draft, focus, selection and other form edits', async () => {
  const h = harness(), oldModal = h.document.modal, oldInput = h.document.getElementById('comfy-baseUrl');
  oldInput.value = 'https://editing.example/comfy?token=unsaved'; oldInput.focus(); oldInput.setSelectionRange(0, oldInput.value.length, 'backward');
  h.document.getElementById('comfy-token').value = 'unsaved-token';
  h.document.getElementById('comfy-steps').value = '31';
  h.document.getElementById('comfy-clearToken').checked = true;
  h.document.details.open = true;
  h.document.message.textContent = 'Connection result'; h.document.message.className = 'modal-message success';
  await h.run('refreshComfyVideoStatus()');
  const input = h.document.getElementById('comfy-baseUrl');
  assert.notEqual(h.document.modal, oldModal);
  assert.equal(h.document.modal.hidden, false);
  assert.equal(input.value, oldInput.value); assert.equal(h.document.activeElement, input);
  assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, input.value.length); assert.equal(input.selectionDirection, 'backward');
  assert.equal(h.document.getElementById('comfy-token').value, 'unsaved-token');
  assert.equal(h.document.getElementById('comfy-steps').value, '31'); assert.equal(h.document.getElementById('comfy-clearToken').checked, true);
  assert.equal(h.document.details.open, true); assert.equal(h.document.message.textContent, 'Connection result');
  const escape = h.document.modal.dispatch('keydown', { target: input, key: 'Escape' });
  assert.equal(escape.defaultPrevented, true); assert.equal(h.document.modal.hidden, true);
  await h.run('refreshComfyVideoStatus()');
  assert.equal(h.document.modal.hidden, true);
});

test('detected model filenames survive a later status redraw without discarding the address being edited', async () => {
  const h = harness({ testComfyVideoConnection: async () => ({ model: 'detected-ref2va.safetensors', clipModel: 'detected-qwen.safetensors', videoVae: 'video.safetensors', audioVae: 'audio.safetensors' }) });
  h.document.getElementById('comfy-baseUrl').value = 'https://tested.example/comfy';
  await h.run('testComfyVideoConnection()');
  await h.run('refreshComfyVideoStatus()');
  assert.equal(h.document.modal.hidden, false);
  assert.equal(h.document.getElementById('comfy-baseUrl').value, 'https://tested.example/comfy');
  assert.equal(h.document.getElementById('comfy-model').value, 'detected-ref2va.safetensors');
  assert.equal(h.document.getElementById('comfy-clipModel').value, 'detected-qwen.safetensors');
});
