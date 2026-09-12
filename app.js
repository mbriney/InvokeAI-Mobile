/* Imagine — a tiny iPhone-friendly front end for a hosted InvokeAI instance.
 * Flow: PIN (optional) → Invoke sign-in (JWT, remembered) → pick photo → type an instruction (+ optional LoRAs) → generate → save.
 */
(() => {
  'use strict';

  const CFG = Object.assign({
    baseUrl: '',
    appTitle: 'Imagine',
    pinHash: '',            // sha256 hex of the 4-digit code, '' = no PIN
    defaultModel: '',       // model name (or substring) to pre-select
    maxSize: 1024,          // longest edge sent to the model
    pollMs: 1500,
  }, window.INVOKE_CONFIG || {});
  CFG.baseUrl = (CFG.baseUrl || '').replace(/\/+$/, '');

  const $ = (id) => document.getElementById(id);
  const LS = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };
  const SS = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  };

  const state = {
    token: LS.get('invoke_token') || '',
    file: null,
    models: [],
    loras: [],            // all LoRAs on the server
    activeLoras: {},      // key -> weight
    subModels: { t5_encoder: [], clip_embed: [], vae: [], qwen3_encoder: [] },
    job: null,      // { itemId, cancelled }
    resultBlob: null,
    resultName: '',
  };

  // ---------- helpers ----------
  const show = (id) => {
    for (const s of document.querySelectorAll('.screen')) s.hidden = true;
    $(id).hidden = false;
    window.scrollTo(0, 0);
  };
  let toastTimer;
  const toast = (msg, ms = 2600) => {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  };
  const sha256 = async (s) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`;
  const round = (n, m) => Math.max(m, Math.round(n / m) * m);

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const res = await fetch(CFG.baseUrl + path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      state.token = ''; LS.del('invoke_token');
      show('screen-login');
      throw new Error('Signed out — please sign in again.');
    }
    if (!res.ok) {
      let detail = res.statusText;
      try { const j = await res.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail || j); } catch {}
      throw new Error(`${res.status}: ${detail}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res;
  }
  const apiBlob = async (path) => (await api(path)).blob();

  // ---------- PIN gate ----------
  let pinBuf = '';
  function renderPin() {
    $('pin-dots').querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i < pinBuf.length));
  }
  async function pinPress(k) {
    if (k === 'del') { pinBuf = pinBuf.slice(0, -1); renderPin(); return; }
    if (pinBuf.length >= 4) return;
    pinBuf += k; renderPin();
    if (pinBuf.length === 4) {
      const ok = (await sha256(pinBuf)) === CFG.pinHash;
      if (ok) { SS.set('pin_ok', '1'); pinBuf = ''; renderPin(); afterPin(); }
      else {
        $('pin-dots').classList.add('shake'); $('pin-error').textContent = 'Wrong code';
        setTimeout(() => { $('pin-dots').classList.remove('shake'); pinBuf = ''; renderPin(); $('pin-error').textContent = ''; }, 500);
      }
    }
  }
  $('keypad').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pinPress(b.dataset.k); });
  document.addEventListener('keydown', (e) => {
    if ($('screen-pin').hidden) return;
    if (/^[0-9]$/.test(e.key)) pinPress(e.key); else if (e.key === 'Backspace') pinPress('del');
  });

  // ---------- Login ----------
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn'); btn.disabled = true; $('login-error').textContent = '';
    try {
      const j = await api('/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('login-email').value.trim(), password: $('login-password').value, remember_me: true }),
      });
      state.token = j.token; LS.set('invoke_token', j.token);
      $('login-password').value = '';
      await enterApp();
    } catch (err) {
      $('login-error').textContent = err.message.replace(/^\d+: /, '');
    } finally { btn.disabled = false; }
  });
  $('btn-signout').addEventListener('click', async () => {
    try { await api('/api/v1/auth/logout', { method: 'POST' }); } catch {}
    state.token = ''; LS.del('invoke_token'); show('screen-login');
  });

  // ---------- Boot ----------
  async function boot() {
    document.title = CFG.appTitle; $('app-title').textContent = CFG.appTitle;
    $('login-host').textContent = CFG.baseUrl.replace(/^https?:\/\//, '');
    if (!CFG.baseUrl) { show('screen-login'); $('login-error').textContent = 'config.js is missing INVOKE_URL. See README.'; return; }
    if (CFG.pinHash && SS.get('pin_ok') !== '1') { show('screen-pin'); return; }
    afterPin();
  }
  async function afterPin() {
    if (!state.token) { show('screen-login'); return; }
    await enterApp();
  }
  async function enterApp() {
    show('screen-app');
    try {
      $('prompt').value = LS.get('last_prompt') || '';
      updateGenerate();
      await loadModels();
    } catch (err) { $('app-error').textContent = err.message; }
  }

  // ---------- Prompt ----------
  $('prompt').addEventListener('input', () => { LS.set('last_prompt', $('prompt').value); updateGenerate(); });
  $('strength').addEventListener('input', () => ($('strength-val').textContent = $('strength').value));
  $('btn-toggle-adv').addEventListener('click', () => { $('advanced').hidden = !$('advanced').hidden; });

  // ---------- Models ----------
  async function loadModels() {
    const j = await api('/api/v2/models/?model_type=main');
    state.models = (j.models || []).filter((m) => ['sd-1', 'sd-2', 'sdxl', 'flux', 'flux2'].includes(m.base));
    const sel = $('model'); sel.innerHTML = '';
    for (const m of state.models) {
      const o = document.createElement('option');
      o.value = m.key; o.textContent = `${m.name} (${m.base})`;
      sel.appendChild(o);
    }
    if (!state.models.length) throw new Error('No SD/SDXL/FLUX main models found on the server.');
    pickModel(LS.get('last_model_key') || CFG.defaultModel || '');
    sel.addEventListener('change', () => { LS.set('last_model_key', sel.value); applyModelDefaults(); });
    // companion models for FLUX / FLUX.2
    const need = new Set();
    if (state.models.some((m) => m.base === 'flux')) ['t5_encoder', 'clip_embed', 'vae'].forEach((t) => need.add(t));
    if (state.models.some((m) => m.base === 'flux2')) ['qwen3_encoder', 'vae'].forEach((t) => need.add(t));
    for (const t of need) {
      try { const r = await api(`/api/v2/models/?model_type=${t}`); state.subModels[t] = r.models || []; } catch {}
    }
    try { const r = await api('/api/v2/models/?model_type=lora'); state.loras = r.models || []; } catch {}
    const saved = JSON.parse(LS.get('active_loras') || '{}');
    for (const l of state.loras) if (l.key in saved) state.activeLoras[l.key] = saved[l.key];
    applyModelDefaults();
  }
  // Distilled FLUX.2 Klein wants few steps and ignores CFG; nudge the fields when such a model is picked.
  function applyModelDefaults() {
    const m = currentModel(); if (!m) return;
    if (m.base === 'flux2' && Number($('steps').value) > 12) $('steps').value = 4;
    $('mode').hidden = m.base !== 'flux2';        // only FLUX.2 can do reference-image editing
    if (m.base !== 'flux2') state.mode = 'restyle';
    else state.mode = LS.get('mode') || 'edit';
    renderMode();
    renderLoras();
  }

  // ---------- LoRAs ----------
  const LORA_NODE = {
    'sd-1': ['lora_collection_loader', ['unet', 'clip']],
    'sd-2': ['lora_collection_loader', ['unet', 'clip']],
    'sdxl': ['sdxl_lora_collection_loader', ['unet', 'clip', 'clip2']],
    'flux': ['flux_lora_collection_loader', ['transformer', 'clip', 't5_encoder']],
    'flux2': null, // decided per model: klein vs dev
  };
  function lorasForModel(m) {
    return state.loras.filter((l) => l.base === m.base || l.base === 'any');
  }
  function renderLoras() {
    const m = currentModel(); const card = $('lora-card'); const wrap = $('loras');
    if (!m) { card.hidden = true; return; }
    const list = lorasForModel(m);
    card.hidden = !list.length; wrap.innerHTML = '';
    for (const l of list) {
      const on = l.key in state.activeLoras;
      const row = document.createElement('div'); row.className = 'lora' + (on ? ' on' : '');
      row.innerHTML = `<button class="lora-toggle"><span class="dot"></span><span class="name">${l.name}</span></button>
        <div class="lora-w" ${on ? '' : 'hidden'}><input type="range" min="-1" max="2" step="0.05" value="${state.activeLoras[l.key] ?? 1}" /><b>${(state.activeLoras[l.key] ?? 1).toFixed(2)}</b></div>`;
      const range = row.querySelector('input'); const val = row.querySelector('b');
      row.querySelector('.lora-toggle').addEventListener('click', () => {
        if (l.key in state.activeLoras) delete state.activeLoras[l.key]; else state.activeLoras[l.key] = Number(range.value);
        LS.set('active_loras', JSON.stringify(state.activeLoras)); renderLoras();
      });
      range.addEventListener('input', () => { state.activeLoras[l.key] = Number(range.value); val.textContent = Number(range.value).toFixed(2); LS.set('active_loras', JSON.stringify(state.activeLoras)); });
      wrap.appendChild(row);
    }
  }
  // Insert a LoRA collection loader between the model loader and everything that consumed `fields` from it.
  function spliceLoras(graph, loaderId, nodeType, fields) {
    const m = currentModel();
    const active = lorasForModel(m).filter((l) => l.key in state.activeLoras);
    if (!active.length) return;
    const loraId = `${graph.id}_lora`;
    graph.nodes[loraId] = { id: loraId, type: nodeType, is_intermediate: true, loras: active.map((l) => ({ lora: idField(l), weight: state.activeLoras[l.key] })) };
    for (const e of graph.edges) if (e.source.node_id === loaderId && fields.includes(e.source.field)) e.source.node_id = loraId;
    for (const f of fields) graph.edges.push({ source: { node_id: loaderId, field: f }, destination: { node_id: loraId, field: f } });
  }

  // ---------- Mode (Edit = reference-image editing, Restyle = img2img) ----------
  state.mode = 'edit';
  const MODE_HINT = {
    edit: 'Keeps the person and scene; tell it what to change. e.g. “Put him in a navy suit.”',
    restyle: 'Re-draws the whole photo in a new look. Strength controls how far it drifts.',
  };
  function renderMode() {
    $('mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    $('mode-hint').textContent = $('mode').hidden ? '' : MODE_HINT[state.mode];
    $('strength-field').hidden = state.mode === 'edit';
  }
  $('mode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.mode = b.dataset.mode; LS.set('mode', state.mode); renderMode();
  });
  function pickModel(hint) {
    const sel = $('model'); if (!hint) return;
    const h = hint.toLowerCase();
    const m = state.models.find((x) => x.key === hint) || state.models.find((x) => x.name.toLowerCase().includes(h));
    if (m) sel.value = m.key;
  }
  const currentModel = () => state.models.find((m) => m.key === $('model').value) || state.models[0];
  const idField = (m) => ({ key: m.key, hash: m.hash, name: m.name, base: m.base, type: m.type });

  // ---------- Photo ----------
  $('file-input').addEventListener('change', (e) => setFile(e.target.files[0]));
  $('btn-change-photo').addEventListener('click', () => $('file-input').click());
  function setFile(f) {
    if (!f) return;
    state.file = f;
    const url = URL.createObjectURL(f);
    const img = $('preview'); img.src = url; img.hidden = false;
    $('drop').classList.add('has-image'); $('photo-actions').hidden = false;
    img.onload = () => { $('photo-meta').textContent = `${img.naturalWidth}×${img.naturalHeight}`; };
    updateGenerate();
  }
  function updateGenerate() {
    $('btn-generate').disabled = !(state.file && $('prompt').value.trim() && !state.job);
  }

  // ---------- Generate ----------
  $('btn-generate').addEventListener('click', generate);
  $('btn-again').addEventListener('click', () => { $('seed').value = ''; generate(); });
  $('btn-cancel').addEventListener('click', async () => {
    if (!state.job) return;
    state.job.cancelled = true;
    try { await api(`/api/v1/queue/default/i/${state.job.itemId}/cancel`, { method: 'PUT' }); } catch {}
  });

  function targetSize(w, h, base) {
    const max = Number(CFG.maxSize) || 1024;
    const cap = base === 'sd-1' ? Math.min(max, 768) : max;
    const mult = base === 'flux' || base === 'flux2' ? 16 : 8;
    const s = Math.min(1, cap / Math.max(w, h));
    return { width: round(w * s, mult), height: round(h * s, mult) };
  }

  async function generate() {
    if (state.job) return;
    const model = currentModel();
    const prompt = $('prompt').value.trim();
    const negative = $('negative').value.trim();
    const strength = Number($('strength').value);
    const steps = Number($('steps').value) || 30;
    const cfg = Number($('cfg').value) || 7;
    const seed = $('seed').value === '' ? Math.floor(Math.random() * 2 ** 31) : Number($('seed').value);

    state.job = { itemId: null, cancelled: false };
    $('app-error').textContent = ''; $('result').hidden = true; $('progress').hidden = false;
    $('progress-text').textContent = 'Uploading photo…'; $('progress-sub').textContent = '';
    updateGenerate();

    try {
      // 1) upload
      const fd = new FormData(); fd.append('file', state.file, state.file.name || 'photo.jpg');
      const up = await api('/api/v1/images/upload?image_category=user&is_intermediate=false', { method: 'POST', body: fd });
      const { width, height } = targetSize(up.width, up.height, model.base);

      // 2) graph
      const args = { model, imageName: up.image_name, width, height, prompt, negative, strength, steps, cfg, seed };
      const g = model.base === 'flux2' ? flux2Graph(args) : model.base === 'flux' ? fluxGraph(args) : sdGraph(args);

      $('progress-text').textContent = 'Queued…';
      const enq = await api('/api/v1/queue/default/enqueue_batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: { graph: g.graph, runs: 1, origin: 'imagine-mobile' }, prepend: true }),
      });
      const itemId = enq.item_ids?.[0];
      if (itemId == null) throw new Error('Server did not return a queue item id.');
      state.job.itemId = itemId;

      // 3) poll
      let item;
      for (;;) {
        await sleep(CFG.pollMs);
        item = await api(`/api/v1/queue/default/i/${itemId}`);
        const st = item.status;
        if (st === 'pending') { $('progress-text').textContent = 'Waiting in queue…'; }
        else if (st === 'in_progress') { $('progress-text').textContent = 'Generating…'; $('progress-sub').textContent = `${model.name} · ${steps} steps · ${width}×${height}` + (Object.keys(state.activeLoras).length ? ` · ${lorasForModel(model).filter((l) => l.key in state.activeLoras).length} LoRA` : ''); }
        if (st === 'completed' || st === 'failed' || st === 'canceled') break;
      }
      if (item.status === 'canceled') { toast('Cancelled'); return; }
      if (item.status === 'failed') throw new Error(item.error_message || item.error || 'Generation failed on the server.');

      // 4) find the output image
      const results = item.session?.results || {};
      let imageName = null;
      for (const [k, r] of Object.entries(results)) {
        if (r?.image?.image_name && (k === g.outputId || k.startsWith(g.outputId))) imageName = r.image.image_name;
      }
      if (!imageName) for (const r of Object.values(results)) if (r?.image?.image_name) imageName = r.image.image_name;
      if (!imageName) throw new Error('Finished, but no image was found in the result.');

      $('progress-text').textContent = 'Fetching image…';
      const blob = await apiBlob(`/api/v1/images/i/${encodeURIComponent(imageName)}/full`);
      state.resultBlob = blob; state.resultName = imageName;
      const url = URL.createObjectURL(blob);
      $('result-img').src = url; $('result').hidden = false;
      $('result-hint').textContent = navigator.canShare ? '' : 'Tip: press and hold the image, then choose “Add to Photos”.';
      $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (!state.job?.cancelled) $('app-error').textContent = err.message;
    } finally {
      $('progress').hidden = true; state.job = null; updateGenerate();
    }
  }

  // ---------- Graph builders ----------
  function sdGraph({ model, imageName, width, height, prompt, negative, strength, steps, cfg, seed }) {
    const isXL = model.base === 'sdxl';
    const id = uid('g');
    const N = {
      loader: `${id}_loader`, pos: `${id}_pos`, neg: `${id}_neg`, resize: `${id}_resize`,
      i2l: `${id}_i2l`, noise: `${id}_noise`, denoise: `${id}_denoise`, l2i: `${id}_l2i`,
    };
    const nodes = {};
    nodes[N.loader] = { id: N.loader, type: isXL ? 'sdxl_model_loader' : 'main_model_loader', model: idField(model), is_intermediate: true };
    nodes[N.pos] = isXL
      ? { id: N.pos, type: 'sdxl_compel_prompt', prompt, style: prompt, is_intermediate: true }
      : { id: N.pos, type: 'compel', prompt, is_intermediate: true };
    nodes[N.neg] = isXL
      ? { id: N.neg, type: 'sdxl_compel_prompt', prompt: negative, style: negative, is_intermediate: true }
      : { id: N.neg, type: 'compel', prompt: negative, is_intermediate: true };
    nodes[N.resize] = { id: N.resize, type: 'img_resize', image: { image_name: imageName }, width, height, resample_mode: 'lanczos', is_intermediate: true };
    nodes[N.i2l] = { id: N.i2l, type: 'i2l', is_intermediate: true };
    nodes[N.noise] = { id: N.noise, type: 'noise', seed, width, height, use_cpu: true, is_intermediate: true };
    nodes[N.denoise] = {
      id: N.denoise, type: 'denoise_latents', steps, cfg_scale: cfg, scheduler: 'dpmpp_2m_k',
      denoising_start: Math.max(0, Math.min(1, 1 - strength)), denoising_end: 1, is_intermediate: true,
    };
    nodes[N.l2i] = { id: N.l2i, type: 'l2i', fp32: false, is_intermediate: false, use_cache: false };

    const E = (s, sf, d, df) => ({ source: { node_id: s, field: sf }, destination: { node_id: d, field: df } });
    const edges = [
      E(N.loader, 'clip', N.pos, 'clip'), E(N.loader, 'clip', N.neg, 'clip'),
      E(N.loader, 'unet', N.denoise, 'unet'),
      E(N.loader, 'vae', N.i2l, 'vae'), E(N.loader, 'vae', N.l2i, 'vae'),
      E(N.resize, 'image', N.i2l, 'image'),
      E(N.i2l, 'latents', N.denoise, 'latents'),
      E(N.noise, 'noise', N.denoise, 'noise'),
      E(N.pos, 'conditioning', N.denoise, 'positive_conditioning'),
      E(N.neg, 'conditioning', N.denoise, 'negative_conditioning'),
      E(N.denoise, 'latents', N.l2i, 'latents'),
    ];
    if (isXL) edges.push(E(N.loader, 'clip2', N.pos, 'clip2'), E(N.loader, 'clip2', N.neg, 'clip2'));
    const graph = { id, nodes, edges };
    spliceLoras(graph, N.loader, ...LORA_NODE[isXL ? 'sdxl' : 'sd-1']);
    return { graph, outputId: N.l2i };
  }

  function fluxGraph({ model, imageName, width, height, prompt, strength, steps, cfg, seed }) {
    const id = uid('g');
    const N = { loader: `${id}_loader`, txt: `${id}_txt`, resize: `${id}_resize`, enc: `${id}_enc`, den: `${id}_den`, dec: `${id}_dec` };
    const pick = (t, pred) => state.subModels[t].find(pred) || state.subModels[t][0];
    const t5 = pick('t5_encoder', () => true);
    const clip = pick('clip_embed', () => true);
    const vae = pick('vae', (m) => m.base === 'flux');
    if (!t5 || !clip || !vae) throw new Error('FLUX needs a T5 encoder, CLIP embed and FLUX VAE installed on the server.');
    const isSchnell = /schnell/i.test(model.name);
    const nodes = {
      [N.loader]: { id: N.loader, type: 'flux_model_loader', model: idField(model), t5_encoder_model: idField(t5), clip_embed_model: idField(clip), vae_model: idField(vae), is_intermediate: true },
      [N.txt]: { id: N.txt, type: 'flux_text_encoder', prompt, t5_max_seq_len: isSchnell ? 256 : 512, is_intermediate: true },
      [N.resize]: { id: N.resize, type: 'img_resize', image: { image_name: imageName }, width, height, resample_mode: 'lanczos', is_intermediate: true },
      [N.enc]: { id: N.enc, type: 'flux_vae_encode', is_intermediate: true },
      [N.den]: {
        id: N.den, type: 'flux_denoise', num_steps: isSchnell ? Math.min(steps, 8) : steps, guidance: cfg, cfg_scale: 1,
        denoising_start: Math.max(0, Math.min(1, 1 - strength)), denoising_end: 1, add_noise: true, width, height, seed, is_intermediate: true,
      },
      [N.dec]: { id: N.dec, type: 'flux_vae_decode', is_intermediate: false, use_cache: false },
    };
    const E = (s, sf, d, df) => ({ source: { node_id: s, field: sf }, destination: { node_id: d, field: df } });
    const edges = [
      E(N.loader, 'clip', N.txt, 'clip'), E(N.loader, 't5_encoder', N.txt, 't5_encoder'),
      E(N.loader, 'transformer', N.den, 'transformer'),
      E(N.loader, 'vae', N.enc, 'vae'), E(N.loader, 'vae', N.dec, 'vae'),
      E(N.resize, 'image', N.enc, 'image'),
      E(N.enc, 'latents', N.den, 'latents'),
      E(N.txt, 'conditioning', N.den, 'positive_text_conditioning'),
      E(N.den, 'latents', N.dec, 'latents'),
    ];
    const graph = { id, nodes, edges };
    spliceLoras(graph, N.loader, ...LORA_NODE.flux);
    return { graph, outputId: N.dec };
  }

  // FLUX.2 (Klein / Dev). Mirrors the working Invoke UI setup: standalone FLUX.2 VAE + Qwen3 encoder chosen explicitly.
  function flux2Graph({ model, imageName, width, height, prompt, strength, steps, seed }) {
    const id = uid('g');
    const isKlein = !/\bdev\b/i.test(model.name);
    const N = { loader: `${id}_loader`, txt: `${id}_txt`, resize: `${id}_resize`, enc: `${id}_enc`, den: `${id}_den`, dec: `${id}_dec` };
    const vae = state.subModels.vae.find((m) => m.base === 'flux2') || state.subModels.vae.find((m) => /flux\.?2/i.test(m.name)) || state.subModels.vae.find((m) => m.base === 'flux');
    if (!vae) throw new Error('FLUX.2 needs a standalone FLUX.2 VAE installed on the server.');
    const loader = { id: N.loader, type: isKlein ? 'flux2_klein_model_loader' : 'flux2_dev_model_loader', model: idField(model), vae_model: idField(vae), is_intermediate: true };
    if (isKlein) {
      const q = state.subModels.qwen3_encoder[0];
      if (!q) throw new Error('FLUX.2 Klein needs a Qwen3 text encoder installed on the server.');
      loader.qwen3_encoder_model = idField(q);
    }
    const edit = state.mode === 'edit';
    const nodes = {
      [N.loader]: loader,
      [N.txt]: { id: N.txt, type: isKlein ? 'flux2_klein_text_encoder' : 'flux2_dev_text_encoder', prompt, is_intermediate: true },
      [N.resize]: { id: N.resize, type: 'img_resize', image: { image_name: imageName }, width, height, resample_mode: 'lanczos', is_intermediate: true },
      [N.den]: {
        id: N.den, type: 'flux2_denoise', num_steps: steps, cfg_scale: 1, scheduler: 'euler',
        denoising_start: edit ? 0 : Math.max(0, Math.min(1, 1 - strength)), denoising_end: 1, add_noise: true, width, height, seed, is_intermediate: true,
      },
      [N.dec]: { id: N.dec, type: 'flux2_vae_decode', is_intermediate: false, use_cache: false },
    };
    const E = (s, sf, d, df) => ({ source: { node_id: s, field: sf }, destination: { node_id: d, field: df } });
    const encField = isKlein ? 'qwen3_encoder' : 'mistral_encoder';
    const edges = [
      E(N.loader, encField, N.txt, encField),
      E(N.loader, 'max_seq_len', N.txt, 'max_seq_len'),
      E(N.loader, 'transformer', N.den, 'transformer'),
      E(N.loader, 'vae', N.den, 'vae'), E(N.loader, 'vae', N.dec, 'vae'),
      E(N.txt, 'conditioning', N.den, 'positive_text_conditioning'),
      E(N.den, 'latents', N.dec, 'latents'),
    ];
    if (edit) {
      // Reference-image editing: photo goes in as Kontext conditioning, generation starts from pure noise.
      N.ref = `${id}_ref`;
      nodes[N.ref] = { id: N.ref, type: 'flux_kontext', is_intermediate: true };
      edges.push(E(N.resize, 'image', N.ref, 'image'), E(N.ref, 'kontext_cond', N.den, 'kontext_conditioning'));
    } else {
      // Classic img2img: encode the photo, re-noise it to (1 - strength) and denoise.
      nodes[N.enc] = { id: N.enc, type: 'flux2_vae_encode', is_intermediate: true };
      edges.push(E(N.loader, 'vae', N.enc, 'vae'), E(N.resize, 'image', N.enc, 'image'), E(N.enc, 'latents', N.den, 'latents'));
    }
    const graph = { id, nodes, edges };
    spliceLoras(graph, N.loader, isKlein ? 'flux2_klein_lora_collection_loader' : 'flux2_dev_lora_collection_loader', ['transformer', encField]);
    return { graph, outputId: N.dec };
  }

  // ---------- Save ----------
  $('btn-save').addEventListener('click', saveResult);
  async function saveResult() {
    if (!state.resultBlob) return;
    const file = new File([state.resultBlob], state.resultName || 'imagine.png', { type: state.resultBlob.type || 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    // Fallback: download link (desktop) / open in new tab (older iOS)
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name; a.target = '_blank';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Press and hold the image → Add to Photos');
  }

  // ---------- Gallery ----------
  $('btn-gallery').addEventListener('click', openGallery);
  $('btn-gallery-back').addEventListener('click', () => show('screen-app'));
  async function openGallery() {
    show('screen-gallery');
    const grid = $('gallery-grid'); grid.innerHTML = '<p class="meta">Loading…</p>';
    try {
      const j = await api('/api/v1/images/?image_origin=internal&categories=general&is_intermediate=false&limit=50&offset=0');
      const items = j.items || [];
      grid.innerHTML = '';
      if (!items.length) grid.innerHTML = '<p class="meta">Nothing yet.</p>';
      for (const it of items) {
        const img = document.createElement('img'); img.alt = '';
        img.addEventListener('click', async () => {
          try {
            const blob = await apiBlob(`/api/v1/images/i/${encodeURIComponent(it.image_name)}/full`);
            state.resultBlob = blob; state.resultName = it.image_name;
            $('result-img').src = URL.createObjectURL(blob); $('result').hidden = false;
            show('screen-app'); $('result').scrollIntoView();
          } catch (e) { toast(e.message); }
        });
        grid.appendChild(img);
        apiBlob(`/api/v1/images/i/${encodeURIComponent(it.image_name)}/thumbnail`).then((b) => (img.src = URL.createObjectURL(b))).catch(() => {});
      }
    } catch (e) { grid.innerHTML = `<p class="error">${e.message}</p>`; }
  }

  boot();
})();
