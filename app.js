/* Imagine — a tiny iPhone-friendly front end for a hosted InvokeAI instance.
 * Flow: Invoke sign-in (JWT, remembered) → pick photo → type an instruction (+ optional LoRAs) → generate → save.
 */
(() => {
  'use strict';

  const CFG = Object.assign({
    baseUrl: '',
    appTitle: 'Imagine',
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

  const state = {
    token: LS.get('invoke_token') || '',
    file: null,
    outfit: null,         // optional second reference photo (File)
    models: [],
    loras: [],            // all LoRAs on the server
    activeLoras: {},      // key -> weight
    subModels: { t5_encoder: [], clip_embed: [], vae: [], qwen3_encoder: [] },
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
  // Download with progress + timeout: onProgress(loadedBytes, totalBytes|null)
  async function apiBlobProgress(path, onProgress, timeoutMs = 90000) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await api(path, { signal: ctrl.signal });
      const total = Number(res.headers.get('content-length')) || null;
      if (!res.body) return await res.blob();
      const reader = res.body.getReader(); const chunks = []; let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        chunks.push(value); loaded += value.length; onProgress?.(loaded, total);
      }
      return new Blob(chunks, { type: res.headers.get('content-type') || 'image/png' });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Image download timed out — check the 🕘 gallery, the image is on the server.');
      throw e;
    } finally { clearTimeout(t); }
  }

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
    if (CFG.build) $('app-title').title = `build ${CFG.build}`;
    $('login-host').textContent = CFG.baseUrl.replace(/^https?:\/\//, '');
    if (!CFG.baseUrl) { show('screen-login'); $('login-error').textContent = 'config.js is missing INVOKE_URL. See README.'; return; }
    if (!state.token) { show('screen-login'); return; }
    await enterApp();
  }
  async function enterApp() {
    show('screen-app');
    try {
      $('prompt').value = LS.get('last_prompt') || '';
      updateGenerate();
      await loadModels();
      renderSaved(); renderImproveRow();
    } catch (err) { $('app-error').textContent = err.message; }
  }

  // ---------- Saved presets (device-local, localStorage) ----------
  const savedList = () => { try { return JSON.parse(LS.get('saved_presets') || '[]'); } catch { return []; } };
  const savedWrite = (list) => LS.set('saved_presets', JSON.stringify(list));
  let currentSavedId = null;
  function snapshot() {
    return {
      prompt: $('prompt').value, negative: $('negative').value, mode: state.mode,
      strength: Number($('strength').value), steps: Number($('steps').value), cfg: Number($('cfg').value),
      modelKey: $('model').value || null, loras: Object.assign({}, state.activeLoras),
    };
  }
  function applySaved(p) {
    $('prompt').value = p.prompt || ''; LS.set('last_prompt', $('prompt').value);
    $('negative').value = p.negative || '';
    $('strength').value = p.strength ?? 0.65; $('strength-val').textContent = $('strength').value;
    $('steps').value = p.steps ?? 4; $('cfg').value = p.cfg ?? 7;
    if (p.modelKey && state.models.some((m) => m.key === p.modelKey)) { $('model').value = p.modelKey; LS.set('last_model_key', p.modelKey); }
    state.activeLoras = {}; for (const [k, w] of Object.entries(p.loras || {})) if (state.loras.some((l) => l.key === k)) state.activeLoras[k] = w;
    LS.set('active_loras', JSON.stringify(state.activeLoras));
    const m = currentModel();
    $('mode').hidden = !m || m.base !== 'flux2';
    state.mode = (!m || m.base !== 'flux2') ? 'restyle' : (p.mode || 'edit'); LS.set('mode', state.mode);
    renderMode(); renderLoras(); updateGenerate();
  }
  // Does what's on screen still match the loaded preset?
  const norm = (p) => JSON.stringify({ prompt: (p.prompt || '').trim(), negative: (p.negative || '').trim(), mode: p.mode, strength: +p.strength, steps: +p.steps, cfg: +p.cfg, modelKey: p.modelKey || null, loras: Object.fromEntries(Object.entries(p.loras || {}).sort()) });
  function savedIsEdited() {
    const cur = savedList().find((p) => p.id === currentSavedId);
    return cur ? norm(cur) !== norm(snapshot()) : false;
  }
  function renderSaved() {
    const list = savedList(); const wrap = $('saved-chips'); wrap.innerHTML = '';
    $('saved-empty').hidden = list.length > 0;
    const edited = savedIsEdited();
    for (const p of list) {
      const isCur = p.id === currentSavedId;
      const b = document.createElement('button'); b.className = 'chip' + (isCur ? (edited ? ' edited' : ' active') : '');
      b.textContent = p.name; b.title = p.prompt;
      if (isCur) { const st = document.createElement('span'); st.className = 'state'; st.textContent = edited ? '● edited' : '✓ loaded'; b.appendChild(st); }
      b.addEventListener('click', () => { currentSavedId = p.id; applySaved(p); renderSaved(); });
      wrap.appendChild(b);
    }
    const cur = list.find((p) => p.id === currentSavedId);
    $('saved-actions').hidden = !cur;
    $('btn-update-preset').hidden = !edited; $('btn-revert-preset').hidden = !edited;
    $('btn-save-preset').textContent = cur && edited ? '＋ Save as new' : '＋ Save';
    if (cur) $('saved-current').textContent = edited ? `“${cur.name}” — you've changed it` : `“${cur.name}” loaded`;
  }
  // Re-check the loaded/edited state whenever any setting changes.
  for (const id of ['prompt', 'negative', 'strength', 'steps', 'cfg', 'model', 'seed']) $(id).addEventListener('input', () => renderSaved());
  $('model').addEventListener('change', () => renderSaved());
  $('mode').addEventListener('click', () => setTimeout(renderSaved, 0)); // after the mode handler has run
  $('btn-revert-preset').addEventListener('click', () => {
    const p = savedList().find((x) => x.id === currentSavedId); if (p) { applySaved(p); renderSaved(); }
  });
  $('btn-save-preset').addEventListener('click', () => {
    $('saved-name-row').hidden = false; $('saved-name').value = ''; $('saved-name').focus();
  });
  $('btn-save-cancel').addEventListener('click', () => { $('saved-name-row').hidden = true; });
  $('btn-save-confirm').addEventListener('click', () => {
    const name = $('saved-name').value.trim() || ($('prompt').value.trim().slice(0, 30) || 'Untitled');
    const list = savedList(); const p = Object.assign({ id: uid('p'), name }, snapshot());
    list.push(p); savedWrite(list); currentSavedId = p.id;
    $('saved-name-row').hidden = true; renderSaved(); toast(`Saved “${name}”`);
  });
  $('saved-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-save-confirm').click(); });
  $('btn-update-preset').addEventListener('click', () => {
    const list = savedList(); const i = list.findIndex((p) => p.id === currentSavedId); if (i < 0) return;
    list[i] = Object.assign({}, list[i], snapshot()); savedWrite(list); renderSaved(); toast(`Updated “${list[i].name}”`);
  });
  $('btn-delete-preset').addEventListener('click', () => {
    const list = savedList(); const p = list.find((x) => x.id === currentSavedId); if (!p) return;
    savedWrite(list.filter((x) => x.id !== currentSavedId)); currentSavedId = null; renderSaved(); toast(`Deleted “${p.name}”`);
  });

  // ---------- Settings / xAI ----------
  const xai = { key: LS.get('xai_key') || '', model: LS.get('xai_model') || '', vision: LS.get('xai_vision') !== '0' };
  $('btn-settings').addEventListener('click', () => { show('screen-settings'); $('build-info').textContent = CFG.build ? `Build ${CFG.build}` : ''; $('xai-key').value = xai.key; $('xai-vision').checked = xai.vision; $('xai-status').textContent = ''; if (xai.key) loadXaiModels(); });
  $('btn-settings-back').addEventListener('click', () => { show('screen-app'); renderImproveRow(); });
  $('xai-key').addEventListener('change', () => loadXaiModels($('xai-key').value.trim()));
  $('btn-xai-save').addEventListener('click', () => {
    xai.key = $('xai-key').value.trim(); xai.model = $('xai-model').value; xai.vision = $('xai-vision').checked;
    LS.set('xai_key', xai.key); LS.set('xai_model', xai.model); LS.set('xai_vision', xai.vision ? '1' : '0');
    $('xai-status').textContent = xai.key ? `Saved · using ${xai.model || 'default model'}` : 'No key — Improve is off.'; renderImproveRow();
  });
  $('btn-xai-clear').addEventListener('click', () => { xai.key = ''; xai.model = ''; LS.del('xai_key'); LS.del('xai_model'); $('xai-key').value = ''; $('xai-model').innerHTML = '<option value="">— enter a key first —</option>'; $('xai-status').textContent = 'Key removed.'; renderImproveRow(); });
  $('btn-xai-test').addEventListener('click', async () => {
    $('xai-status').textContent = 'Testing…';
    try { const r = await grokChat([{ role: 'user', content: 'Reply with the single word OK.' }], { key: $('xai-key').value.trim(), model: $('xai-model').value, maxTokens: 5 }); $('xai-status').textContent = `Works · replied “${r.trim()}”`; }
    catch (e) { $('xai-status').textContent = e.message; }
  });
  async function loadXaiModels(key = xai.key) {
    if (!key) return;
    const sel = $('xai-model'); sel.innerHTML = '<option value="">loading…</option>';
    try {
      const res = await fetch('https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const ids = ((await res.json()).data || []).map((m) => m.id).filter((id) => /grok/i.test(id) && !/image|imagine|video|tts|stt|embed/i.test(id)).sort();
      sel.innerHTML = '';
      for (const id of ids) { const o = document.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o); }
      // Prefer the newest "fast non-reasoning" model (quick + vision), then any fast, then any grok-4.
      const ver = (id) => { const m = id.match(/grok-(\d+)(?:[.-](\d+))?/); return m ? Number(m[1]) + Number(m[2] || 0) / 100 : 0; };
      const best = (re) => ids.filter((i) => re.test(i)).sort((a, b) => ver(b) - ver(a))[0];
      const pref = ids.find((i) => i === xai.model) || best(/fast-non-reasoning/) || best(/fast/) || best(/grok-4/) || ids[0] || '';
      sel.value = pref; $('xai-status').textContent = ids.length ? `${ids.length} models available` : 'No chat models found for this key.';
    } catch (e) { sel.innerHTML = '<option value="">— could not load —</option>'; $('xai-status').textContent = e.message; }
  }
  async function grokChat(messages, { key = xai.key, model = xai.model, maxTokens = 600, json = false } = {}) {
    if (!key) throw new Error('No xAI key — add one in ⚙ Settings.');
    const body = { model: model || 'grok-4-fast', messages, max_tokens: maxTokens, temperature: 0.7 };
    if (json) body.response_format = { type: 'json_object' };
    const res = await fetch('https://api.x.ai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    if (!res.ok) { let t = await res.text(); try { t = JSON.parse(t).error || t; } catch {} throw new Error(`xAI ${res.status}: ${String(t).slice(0, 200)}`); }
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  }
  function renderImproveRow() { $('improve-row').hidden = !xai.key; }

  // ---------- Improve prompt with Grok ----------
  let lastSuggestion = null;
  $('btn-improve').addEventListener('click', improvePrompt);
  $('btn-suggest-retry').addEventListener('click', improvePrompt);
  $('btn-suggest-dismiss').addEventListener('click', () => { $('suggest').hidden = true; });
  $('btn-suggest-use').addEventListener('click', () => {
    if (!lastSuggestion) return;
    $('prompt').value = lastSuggestion.prompt; LS.set('last_prompt', $('prompt').value);
    if (lastSuggestion.negative && state.mode !== 'edit') $('negative').value = lastSuggestion.negative;
    $('suggest').hidden = true; updateGenerate(); renderSaved(); toast('Prompt updated');
  });

  async function photoDataUrl(file, maxEdge = 768) {
    if (!file) return null;
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.85);
  }
  function loraContext(m) {
    const all = lorasForModel(m);
    const line = (l) => `- "${l.name}"${l.key in state.activeLoras ? ` (ENABLED, weight ${state.activeLoras[l.key]})` : ' (available, off)'}${l.description ? ` — ${l.description}` : ''}${l.trigger_phrases?.length ? ` — trigger words: ${l.trigger_phrases.join(', ')}` : ''}`;
    return all.length ? all.map(line).join('\n') : '(none installed for this model)';
  }
  async function improvePrompt() {
    const m = currentModel(); if (!m) return;
    const rough = $('prompt').value.trim();
    if (!rough) { toast('Type a rough idea first'); return; }
    const edit = state.mode === 'edit';
    const family = m.base === 'flux2' ? (/dev/i.test(m.name) ? 'FLUX.2 Dev' : 'FLUX.2 Klein (distilled, ~4 steps, no CFG/negative prompt)') : m.base === 'flux' ? 'FLUX.1' : m.base === 'sdxl' ? 'Stable Diffusion XL' : 'Stable Diffusion 1.5';
    const guide = edit
      ? `MODE: reference-image EDIT. The user's photo is passed to the model as a reference and the prompt is an instruction describing the change. Write one clear instruction in plain English (1–3 sentences, under 80 words): say exactly what to change, be concrete about materials/colors/lighting, and explicitly say what must stay the same (face, identity, pose, expression, background, framing) unless the user wants those changed. No tag lists, no quality boilerplate, no negative prompt.`
      : m.base.startsWith('sd')
        ? `MODE: image-to-image RESTYLE with ${family}. Write a comma-separated descriptive prompt (subject, style, medium, lighting, composition, quality terms) under 75 tokens, and a short negative prompt.`
        : `MODE: image-to-image RESTYLE with ${family}. Write a vivid natural-language description of the finished image (1–3 sentences, under 90 words): subject, style, lighting, mood. No negative prompt needed.`;
    const sys = `You are a prompt engineer for InvokeAI. Turn the user's rough idea into a prompt that this exact setup will follow well.
MODEL: ${m.name} — ${family}.
${guide}
LoRAs on the server for this model (ENABLED ones are active in this generation; include their trigger words naturally in the prompt if they are relevant; you may recommend enabling an available one only if it clearly fits the idea):
${loraContext(m)}
${xai.vision && state.file ? (state.outfit && edit && m.base === 'flux2' ? 'Two photos are attached in the order the model will see them: IMAGE 1 is the person to keep; IMAGE 2 shows an outfit on someone else. Refer to them literally as "image 1" and "image 2". Say to output a single photo of the person from image 1 wearing the outfit from image 2; describe the garments you actually see in image 2 (type, color, fabric, fit, details); keep face, hair, pose, framing and background from image 1; and do not show the person or background from image 2.' : 'The user\'s photo is attached — use what you see (subject, clothing, setting, lighting) so the prompt is specific to it.') : ''}
Reply with JSON only: {"prompt": string, "negative": string (empty if not applicable), "enable_loras": [exact LoRA names to enable, usually empty], "notes": one short sentence for the user}.`;
    const userContent = [{ type: 'text', text: `Rough idea: ${rough}` }];
    $('improve-status').textContent = 'Asking Grok…'; $('btn-improve').disabled = true;
    try {
      if (xai.vision && state.file) {
        try { userContent.push({ type: 'image_url', image_url: { url: await photoDataUrl(state.file), detail: 'low' } }); } catch {}
        if (state.outfit && edit && m.base === 'flux2') {
          try { userContent.push({ type: 'image_url', image_url: { url: await photoDataUrl(state.outfit), detail: 'low' } }); } catch {}
        }
      }
      let text = await grokChat([{ role: 'system', content: sys }, { role: 'user', content: userContent }], { json: true });
      text = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      let out; try { out = JSON.parse(text); } catch { out = { prompt: text, negative: '', enable_loras: [], notes: '' }; }
      if (!out.prompt) throw new Error('Grok returned no prompt.');
      lastSuggestion = out;
      $('suggest-prompt').textContent = out.prompt;
      $('suggest-notes').textContent = [out.notes, out.negative ? `Negative: ${out.negative}` : ''].filter(Boolean).join(' · ');
      const chips = $('suggest-loras'); chips.innerHTML = '';
      for (const name of out.enable_loras || []) {
        const l = lorasForModel(m).find((x) => x.name === name); if (!l || l.key in state.activeLoras) continue;
        const b = document.createElement('button'); b.className = 'chip'; b.textContent = `＋ enable “${l.name}”`;
        b.addEventListener('click', () => { state.activeLoras[l.key] = 0.75; LS.set('active_loras', JSON.stringify(state.activeLoras)); renderLoras(); renderSaved(); b.remove(); toast(`Enabled ${l.name}`); });
        chips.appendChild(b);
      }
      $('suggest').hidden = false; $('improve-status').textContent = '';
    } catch (e) { $('improve-status').textContent = e.message; }
    finally { $('btn-improve').disabled = false; }
  }

  // ---------- Reset ----------
  // Clears the working state: photos, prompt, mode, LoRAs, advanced fields, result and suggestion.
  // Leaves alone: sign-in, xAI settings, saved presets, the running queue, and the selected model.
  $('btn-reset').addEventListener('click', () => {
    state.file = null; $('file-input').value = '';
    const pv = $('preview'); if (pv.src.startsWith('blob:')) URL.revokeObjectURL(pv.src); pv.removeAttribute('src'); pv.hidden = true;
    $('drop').classList.remove('has-image'); $('btn-change-photo').hidden = true; $('photo-meta').textContent = '';
    setOutfit(null);
    $('prompt').value = ''; LS.del('last_prompt');
    $('negative').value = ''; $('seed').value = '';
    $('strength').value = 0.65; $('strength-val').textContent = '0.65';
    $('steps').value = 30; $('cfg').value = 7; applyModelDefaults();
    state.activeLoras = {}; LS.del('active_loras'); renderLoras();
    if (!$('mode').hidden) { state.mode = 'edit'; LS.set('mode', 'edit'); renderMode(); }
    currentSavedId = null; renderSaved();
    $('suggest').hidden = true; $('improve-status').textContent = ''; $('app-error').textContent = '';
    if ($('result-img').src.startsWith('blob:')) URL.revokeObjectURL($('result-img').src);
    $('result-img').removeAttribute('src'); $('result').hidden = true; state.resultBlob = null; state.resultName = '';
    $('advanced').hidden = true;
    updateGenerate(); window.scrollTo({ top: 0, behavior: 'smooth' }); toast('Reset');
  });

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
  // A LoRA fits if its base matches and, for FLUX.2, its variant family matches too (a Klein 9B or Dev LoRA on Klein 4B
  // fails inside the denoiser with a tensor-shape error). LoRAs with no recorded variant are shown but flagged.
  const variantFamily = (v) => (v || '').replace(/_base$/, '');
  function loraFit(l, m) {
    if (!(l.base === m.base || l.base === 'any')) return 'no';
    if (m.base === 'flux2' && m.variant) {
      if (!l.variant) return 'unknown';
      return variantFamily(l.variant) === variantFamily(m.variant) ? 'yes' : 'no';
    }
    return 'yes';
  }
  function lorasForModel(m) {
    return state.loras.filter((l) => loraFit(l, m) !== 'no');
  }
  function renderLoras() {
    const m = currentModel(); const card = $('lora-card'); const wrap = $('loras');
    if (!m) { card.hidden = true; return; }
    const list = lorasForModel(m);
    card.hidden = !list.length; wrap.innerHTML = '';
    for (const l of list) {
      const on = l.key in state.activeLoras;
      const row = document.createElement('div'); row.className = 'lora' + (on ? ' on' : '');
      const warn = loraFit(l, m) === 'unknown' ? ` <small class="meta">· variant unknown — may not fit ${m.variant || m.base}</small>` : '';
      row.innerHTML = `<button class="lora-toggle"><span class="dot"></span><span class="name">${l.name}${warn}</span></button>
        <div class="lora-w" ${on ? '' : 'hidden'}><input type="range" min="-1" max="2" step="0.05" value="${state.activeLoras[l.key] ?? 0.75}" /><b>${(state.activeLoras[l.key] ?? 0.75).toFixed(2)}</b></div>`;
      const range = row.querySelector('input'); const val = row.querySelector('b');
      row.querySelector('.lora-toggle').addEventListener('click', () => {
        if (l.key in state.activeLoras) delete state.activeLoras[l.key]; else state.activeLoras[l.key] = Number(range.value) || 0.75;
        LS.set('active_loras', JSON.stringify(state.activeLoras)); renderLoras(); renderSaved();
      });
      range.addEventListener('input', () => { state.activeLoras[l.key] = Number(range.value); val.textContent = Number(range.value).toFixed(2); LS.set('active_loras', JSON.stringify(state.activeLoras)); renderSaved(); });
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
    renderOutfitCard();
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
    $('drop').classList.add('has-image'); $('btn-change-photo').hidden = false;
    img.onload = () => { $('photo-meta').textContent = `${img.naturalWidth}×${img.naturalHeight}`; };
    updateGenerate();
  }
  function updateGenerate() {
    $('btn-generate').disabled = !(state.file && $('prompt').value.trim());
  }

  // Outfit reference (second Kontext image; FLUX.2 edit mode only)
  $('outfit-input').addEventListener('change', (e) => setOutfit(e.target.files[0]));
  $('btn-outfit-remove').addEventListener('click', () => setOutfit(null));
  // Both photos go in as references (yours first — `collect` orders by node id). Verified on Klein 4B FP8: this keeps
  // face, hat, pose and background and swaps the garments; anchoring on the person's latents does not work.
  function outfitPrompt() {
    return 'Output a single photo of the person from image 1 wearing the exact outfit worn in image 2 — same garments, colors, fabrics and fit. Keep the face, hair, skin, body shape, pose, expression, framing and background from image 1 unchanged. Do not show the person or background from image 2.';
  }
  $('btn-outfit-prompt').addEventListener('click', () => {
    $('prompt').value = outfitPrompt(); LS.set('last_prompt', $('prompt').value); updateGenerate(); renderSaved(); toast('Prompt written — edit it if you like');
  });
  function setOutfit(f) {
    state.outfit = f || null;
    const img = $('outfit-preview');
    if (f) { img.src = URL.createObjectURL(f); img.hidden = false; $('outfit-drop').classList.add('has-image'); }
    else { img.removeAttribute('src'); img.hidden = true; $('outfit-drop').classList.remove('has-image'); $('outfit-input').value = ''; }
    $('btn-outfit-remove').hidden = !f; $('btn-outfit-prompt').hidden = !f;
    if (f && !$('prompt').value.trim()) { $('prompt').value = outfitPrompt(); LS.set('last_prompt', $('prompt').value); }
    updateGenerate();
  }
  function renderOutfitCard() {
    const m = currentModel();
    $('outfit-card').hidden = !(m && m.base === 'flux2' && state.mode === 'edit');
  }

  // Paste an image: Cmd/Ctrl-V anywhere, or the 📋 buttons (iOS needs a tap to read the clipboard).
  function imageFromClipboardItems(items) {
    for (const it of items || []) if (it.type?.startsWith('image/')) { const f = it.getAsFile?.(); if (f) return f; }
    return null;
  }
  document.addEventListener('paste', (e) => {
    if ($('screen-app').hidden) return;
    const f = imageFromClipboardItems(e.clipboardData?.items);
    if (!f) return;
    e.preventDefault();
    const outfitOpen = !$('outfit-card').hidden;
    if (!state.file) setFile(f); else if (outfitOpen && !state.outfit) { setOutfit(f); toast('Pasted as outfit reference'); } else setFile(f);
  });
  async function readClipboardImage() {
    if (!navigator.clipboard?.read) throw new Error('Clipboard paste isn\'t available here — use Choose instead.');
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) { const blob = await item.getType(type); return new File([blob], `pasted.${type.split('/')[1] || 'png'}`, { type }); }
    }
    throw new Error('No image on the clipboard.');
  }
  $('btn-paste-photo').addEventListener('click', async () => { try { setFile(await readClipboardImage()); } catch (e) { toast(e.message); } });
  $('btn-paste-outfit').addEventListener('click', async () => { try { setOutfit(await readClipboardImage()); } catch (e) { toast(e.message); } });

  // ---------- Generate (queued) ----------
  // Each tap on Generate uploads + enqueues immediately and adds a row to the local queue.
  // A single background poller watches all active items; results land in the preview as they finish.
  state.jobs = [];            // { id, itemId, prompt, model, status, t0, error, imageName }
  let pollerRunning = false;

  $('btn-generate').addEventListener('click', generate);
  $('btn-again').addEventListener('click', () => { $('seed').value = ''; generate(); });
  $('btn-upscale').addEventListener('click', () => { if (state.resultName) upscale(state.resultName, 2); });
  $('btn-clear').addEventListener('click', () => {
    // Just hides the result; the image stays on the server and in 🕘. Photo, prompt and settings are untouched.
    if ($('result-img').src.startsWith('blob:')) URL.revokeObjectURL($('result-img').src);
    $('result-img').removeAttribute('src'); $('result').hidden = true;
    state.resultBlob = null; state.resultName = ''; $('app-error').textContent = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  function targetSize(w, h, base) {
    const max = Number(CFG.maxSize) || 1024;
    const cap = base === 'sd-1' ? Math.min(max, 768) : max;
    const mult = base === 'flux' || base === 'flux2' ? 16 : 8;
    const s = Math.min(1, cap / Math.max(w, h));
    return { width: round(w * s, mult), height: round(h * s, mult) };
  }

  async function generate() {
    if (!state.file || !$('prompt').value.trim()) return;
    const model = currentModel();
    const prompt = $('prompt').value.trim();
    const negative = $('negative').value.trim();
    const strength = Number($('strength').value);
    const steps = Number($('steps').value) || 30;
    const cfg = Number($('cfg').value) || 7;
    const seed = $('seed').value === '' ? Math.floor(Math.random() * 2 ** 31) : Number($('seed').value);
    const file = state.file;
    const outfit = (model.base === 'flux2' && state.mode === 'edit') ? state.outfit : null;

    const job = { id: uid('j'), itemId: null, prompt, model: model.name, status: 'uploading', t0: Date.now(), error: null, imageName: null, outputId: null, cancelled: false,
      loras: lorasForModel(model).filter((l) => l.key in state.activeLoras).map((l) => l.name) };
    state.jobs.push(job); $('app-error').textContent = ''; renderQueue();

    try {
      const fd = new FormData(); fd.append('file', file, file.name || 'photo.jpg');
      const up = await api('/api/v1/images/upload?image_category=user&is_intermediate=false', { method: 'POST', body: fd });
      const { width, height } = targetSize(up.width, up.height, model.base);
      let refImage = null;
      if (outfit) {
        const fd2 = new FormData(); fd2.append('file', outfit, outfit.name || 'outfit.jpg');
        const up2 = await api('/api/v1/images/upload?image_category=user&is_intermediate=false', { method: 'POST', body: fd2 });
        const r = targetSize(up2.width, up2.height, model.base); const k = Math.min(1, 768 / Math.max(r.width, r.height));
        refImage = { imageName: up2.image_name, width: round(r.width * k, 16), height: round(r.height * k, 16) };
      }
      const args = { model, imageName: up.image_name, width, height, prompt, negative, strength, steps, cfg, seed, refImage };
      const g = model.base === 'flux2' ? flux2Graph(args) : model.base === 'flux' ? fluxGraph(args) : sdGraph(args);
      job.outputId = g.outputId; job.detail = `${model.name} · ${steps} steps · ${width}×${height}${refImage ? ' · outfit ref' : ''}${job.loras.length ? ' · LoRA: ' + job.loras.join(', ') : ''}`;
      const enq = await api('/api/v1/queue/default/enqueue_batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: { graph: g.graph, runs: 1, origin: 'imagine-mobile' } }),
      });
      job.itemId = enq.item_ids?.[0];
      if (job.itemId == null) throw new Error('Server did not return a queue item id.');
      job.status = 'pending'; renderQueue();
      runPoller();
    } catch (err) {
      job.status = 'failed'; job.error = err.message; renderQueue();
    }
  }

  // Queue any small graph (e.g. an upscale) through the same poller/queue card.
  async function enqueueGraph({ graph, outputId, label, detail, onDone }) {
    const job = { id: uid('j'), itemId: null, prompt: label, model: '', status: 'pending', t0: Date.now(), error: null, imageName: null, outputId, cancelled: false, loras: [], detail, onDone };
    state.jobs.push(job); renderQueue();
    try {
      const enq = await api('/api/v1/queue/default/enqueue_batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: { graph, runs: 1, origin: 'imagine-mobile' } }) });
      job.itemId = enq.item_ids?.[0]; if (job.itemId == null) throw new Error('Server did not return a queue item id.');
      renderQueue(); runPoller();
    } catch (err) { job.status = 'failed'; job.error = err.message; renderQueue(); }
    return job;
  }
  // Real-ESRGAN upscale of an image already on the server. Result lands in the gallery like any generation.
  function upscale(imageName, factor = 2, onDone) {
    const id = uid('up'); const nid = `${id}_esr`;
    const graph = { id, nodes: { [nid]: { id: nid, type: 'esrgan', image: { image_name: imageName }, model_name: factor === 4 ? 'RealESRGAN_x4plus.pth' : 'RealESRGAN_x2plus.pth', tile_size: 400, is_intermediate: false, use_cache: false } }, edges: [] };
    toast(`Upscaling ${factor}×…`);
    return enqueueGraph({ graph, outputId: nid, label: `Upscale ${factor}×`, detail: `Real-ESRGAN x${factor}`, onDone });
  }

  async function cancelJob(job) {
    job.cancelled = true;
    if (job.itemId != null) { try { await api(`/api/v1/queue/default/i/${job.itemId}/cancel`, { method: 'PUT' }); } catch {} }
    else { job.status = 'canceled'; renderQueue(); }
  }

  async function runPoller() {
    if (pollerRunning) return; pollerRunning = true;
    try {
      for (;;) {
        const active = state.jobs.filter((j) => j.status === 'pending' || j.status === 'in_progress');
        if (!active.length) break;
        await sleep(CFG.pollMs);
        for (const job of active) {
          let item;
          try { item = await api(`/api/v1/queue/default/i/${job.itemId}`); } catch (e) { job.status = 'failed'; job.error = e.message; continue; }
          if (item.status === 'pending' || item.status === 'in_progress') { job.status = item.status; continue; }
          if (item.status === 'canceled') { job.status = 'canceled'; continue; }
          if (item.status === 'failed') {
            job.status = 'failed'; job.error = item.error_message || item.error || 'Generation failed on the server.';
            if (/shape '\[\d+, \d+\]' is invalid/.test(job.error)) job.error = `A LoRA that was on doesn't fit ${job.model} (tensor shape mismatch — it was trained for a different model size). Turn it off and try again. Server said: ${job.error}`;
            continue;
          }
          // completed → find the output image, download it, show it
          // Execution node ids are UUIDs; session.source_prepared_mapping maps our node id → prepared id(s).
          // (Never fall back to "any image in the results" — the resize nodes emit images too.)
          const results = item.session?.results || {};
          const prepared = item.session?.source_prepared_mapping?.[job.outputId] || [];
          let imageName = null;
          for (const pid of prepared) if (results[pid]?.image?.image_name) imageName = results[pid].image.image_name;
          if (!imageName) for (const [k, r] of Object.entries(results)) if (r?.image?.image_name && k === job.outputId) imageName = r.image.image_name;
          if (!imageName) { job.status = 'failed'; job.error = 'Finished, but the output image could not be located in the result.'; continue; }
          job.imageName = imageName; job.status = 'downloading'; job.progress = ''; renderQueue();
          try {
            const fmt = (b) => (b / 1048576).toFixed(1) + ' MB';
            const blob = await apiBlobProgress(`/api/v1/images/i/${encodeURIComponent(imageName)}/full`, (loaded, total) => {
              job.progress = total ? `${Math.round((loaded / total) * 100)}%` : fmt(loaded); renderQueue();
            });
            showResult(blob, imageName);
            job.status = 'done'; job.doneAt = Date.now();
            try { job.onDone?.(blob, imageName); } catch {}
            setTimeout(() => { state.jobs = state.jobs.filter((j) => j !== job); renderQueue(); }, 2500);
          } catch (e) { job.status = 'failed'; job.error = e.message; }
        }
        renderQueue();
      }
    } finally { pollerRunning = false; renderQueue(); }
  }

  function showResult(blob, imageName) {
    if ($('result-img').src.startsWith('blob:')) URL.revokeObjectURL($('result-img').src);
    resultZoom.reset();
    state.resultBlob = blob; state.resultName = imageName;
    $('result-img').src = URL.createObjectURL(blob); $('result').hidden = false;
    $('result-img').onload = () => { $('result-meta').textContent = `${$('result-img').naturalWidth}×${$('result-img').naturalHeight} · pinch to zoom · double-tap to reset`; };
    $('result-hint').textContent = navigator.canShare ? '' : 'Tip: press and hold the image, then choose “Add to Photos”.';
  }

  const STATUS_LABEL = { uploading: 'Uploading photo…', pending: 'Waiting in queue…', in_progress: 'Generating…', downloading: 'Downloading…', done: 'Done', failed: 'Failed', canceled: 'Cancelled' };
  function renderQueue() {
    const card = $('queue'); const list = $('queue-list');
    const jobs = state.jobs;
    card.hidden = !jobs.length; list.innerHTML = '';
    for (const job of jobs) {
      const row = document.createElement('div'); row.className = `qrow ${job.status}`;
      const active = ['uploading', 'pending', 'in_progress', 'downloading'].includes(job.status);
      const secs = Math.round(((job.doneAt || Date.now()) - job.t0) / 1000);
      const sub = job.status === 'failed' ? job.error : job.status === 'downloading' ? `${job.progress || ''} · ${job.detail || ''}` : job.status === 'in_progress' ? `${job.detail || ''} · ${secs}s` : job.status === 'done' ? `${secs}s` : '';
      row.innerHTML = `<span class="qicon">${active ? '<span class="spinner"></span>' : job.status === 'done' ? '✓' : job.status === 'failed' ? '!' : '–'}</span>
        <div class="grow"><div class="qprompt">${job.prompt.replace(/</g, '&lt;')}</div><div class="meta">${STATUS_LABEL[job.status]}${sub ? ' · ' + sub : ''}</div></div>`;
      const btn = document.createElement('button'); btn.className = 'ghost small';
      if (active && job.status !== 'downloading') { btn.textContent = 'Cancel'; btn.addEventListener('click', () => cancelJob(job)); row.appendChild(btn); }
      else if (!active && job.status !== 'done') { btn.textContent = '✕'; btn.addEventListener('click', () => { state.jobs = state.jobs.filter((j) => j !== job); renderQueue(); }); row.appendChild(btn); }
      list.appendChild(row);
    }
    const n = jobs.filter((j) => ['uploading', 'pending', 'in_progress', 'downloading'].includes(j.status)).length;
    $('queue-title').textContent = n ? `Queue · ${n} running` : 'Queue';
  }
  // Keep elapsed-time labels ticking while anything is running.
  setInterval(() => { if (state.jobs.some((j) => j.status === 'in_progress')) renderQueue(); }, 1000);

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
  function flux2Graph({ model, imageName, width, height, prompt, strength, steps, seed, refImage }) {
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
      if (!refImage) edges.push(E(N.resize, 'image', N.ref, 'image'));
      if (refImage) {
        // Second reference (e.g. an outfit). `collect` orders items by source node id: "_ka" (person) is image 1, "_kb" (outfit) is image 2.
        N.resize2 = `${id}_resize2`; N.col = `${id}_collect`; const ka = `${id}_ka`, kb = `${id}_kb`;
        delete nodes[N.ref];
        nodes[N.resize2] = { id: N.resize2, type: 'img_resize', image: { image_name: refImage.imageName }, width: refImage.width, height: refImage.height, resample_mode: 'lanczos', is_intermediate: true };
        nodes[ka] = { id: ka, type: 'flux_kontext', is_intermediate: true };
        nodes[kb] = { id: kb, type: 'flux_kontext', is_intermediate: true };
        nodes[N.col] = { id: N.col, type: 'collect', is_intermediate: true };
        edges.push(E(N.resize, 'image', ka, 'image'), E(N.resize2, 'image', kb, 'image'), E(ka, 'kontext_cond', N.col, 'item'), E(kb, 'kontext_cond', N.col, 'item'), E(N.col, 'collection', N.den, 'kontext_conditioning'));
      } else {
        edges.push(E(N.ref, 'kontext_cond', N.den, 'kontext_conditioning'));
      }
    } else {
      // Classic img2img: encode the photo, re-noise it to (1 - strength) and denoise.
      nodes[N.enc] = { id: N.enc, type: 'flux2_vae_encode', is_intermediate: true };
      edges.push(E(N.loader, 'vae', N.enc, 'vae'), E(N.resize, 'image', N.enc, 'image'), E(N.enc, 'latents', N.den, 'latents'));
    }
    const graph = { id, nodes, edges };
    spliceLoras(graph, N.loader, isKlein ? 'flux2_klein_lora_collection_loader' : 'flux2_dev_lora_collection_loader', ['transformer', encField]);
    return { graph, outputId: N.dec };
  }

  // ---------- Pinch-zoom / pan ----------
  // Pointer-events based so it works with touch (pinch), trackpad/mouse (wheel + drag). Double-tap resets.
  function attachZoom(box, img) {
    let scale = 1, tx = 0, ty = 0; const pts = new Map(); let start = null; let lastTap = 0;
    const MAX = 6;
    const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; box.classList.toggle('zoomed', scale > 1.01); };
    const clamp = () => {
      const w = box.clientWidth, h = box.clientHeight;
      if (scale <= 1) { scale = 1; tx = 0; ty = 0; return; }
      tx = Math.min(0, Math.max(w - w * scale, tx)); ty = Math.min(0, Math.max(h - h * scale, ty));
    };
    const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };
    const zoomAt = (cx, cy, factor) => {
      const ns = Math.min(MAX, Math.max(1, scale * factor)); const f = ns / scale;
      tx = cx - (cx - tx) * f; ty = cy - (cy - ty) * f; scale = ns; clamp(); apply();
    };
    box.addEventListener('pointerdown', (e) => {
      box.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = Date.now();
      if (pts.size === 1 && now - lastTap < 300) { const r = box.getBoundingClientRect(); scale > 1.01 ? reset() : zoomAt(e.clientX - r.left, e.clientY - r.top, 2.5); lastTap = 0; return; }
      lastTap = now;
      const p = [...pts.values()];
      start = { scale, tx, ty, p0: p[0], p1: p[1] || null, dist: p[1] ? Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) : 0,
        mid: p[1] ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : p[0] };
    });
    box.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !start) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = [...pts.values()]; const r = box.getBoundingClientRect();
      if (p.length >= 2 && start.p1) {
        const dist = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
        const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
        const ns = Math.min(MAX, Math.max(1, start.scale * (dist / (start.dist || 1)))); const f = ns / start.scale;
        const cx = start.mid.x - r.left, cy = start.mid.y - r.top;
        tx = cx - (cx - start.tx) * f + (mid.x - start.mid.x); ty = cy - (cy - start.ty) * f + (mid.y - start.mid.y); scale = ns;
      } else if (scale > 1) {
        tx = start.tx + (p[0].x - start.p0.x); ty = start.ty + (p[0].y - start.p0.y);
      } else return;
      clamp(); apply();
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size === 0) start = null; else { const p = [...pts.values()]; start = { scale, tx, ty, p0: p[0], p1: null, dist: 0, mid: p[0] }; } };
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up); box.addEventListener('pointerleave', up);
    box.addEventListener('wheel', (e) => { e.preventDefault(); const r = box.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.002)); }, { passive: false });
    // iOS Safari ignores user-scalable=no and will hijack a pinch for page zoom (cancelling our pointer events)
    // unless the native gesture/touch handling is explicitly prevented on the element.
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) box.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    box.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || scale > 1) e.preventDefault(); }, { passive: false });
    box.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    box.addEventListener('dblclick', (e) => { e.preventDefault(); });
    img.addEventListener('load', reset);
    return { reset };
  }
  const resultZoom = attachZoom($('result-zoom'), $('result-img'));
  const viewerZoom = attachZoom($('viewer-zoom'), $('viewer-img'));

  // ---------- Save ----------
  $('btn-save').addEventListener('click', saveResult);
  async function saveResult() { if (state.resultBlob) shareBlob(state.resultBlob, state.resultName); }
  async function shareBlob(blob, name) {
    const file = new File([blob], name || 'imagine.png', { type: blob.type || 'image/png' });
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
  const gal = { items: [], selecting: false, selected: new Set() };
  $('btn-gallery').addEventListener('click', openGallery);
  $('btn-gallery-back').addEventListener('click', () => { setSelecting(false); show('screen-app'); });
  $('btn-gallery-select').addEventListener('click', () => setSelecting(!gal.selecting));
  $('btn-gallery-delete').addEventListener('click', () => armDelete(true));
  $('btn-gallery-nevermind').addEventListener('click', () => armDelete(false));
  $('btn-gallery-confirm').addEventListener('click', deleteSelected);

  function setSelecting(on) {
    gal.selecting = on; gal.selected.clear(); armDelete(false);
    $('gallery-grid').classList.toggle('selecting', on);
    $('gallery-bar').hidden = !on;
    $('btn-gallery-select').textContent = on ? 'Cancel' : 'Select';
    $('gallery-grid').querySelectorAll('.tile').forEach((t) => t.classList.remove('selected'));
    updateGalleryBar();
  }
  function updateGalleryBar() {
    const n = gal.selected.size;
    $('btn-gallery-delete').disabled = !n; $('btn-gallery-delete').textContent = n ? `Delete ${n}` : 'Delete';
    $('gallery-count').textContent = n ? `${n} selected` : 'Tap images to select';
  }
  function armDelete(on) {
    $('btn-gallery-confirm').hidden = !on; $('btn-gallery-nevermind').hidden = !on; $('btn-gallery-delete').hidden = on;
    if (on) $('btn-gallery-confirm').textContent = `Delete ${gal.selected.size} for good`;
  }
  async function deleteSelected() {
    const names = [...gal.selected]; if (!names.length) return;
    $('btn-gallery-confirm').disabled = true;
    try {
      await api('/api/v1/images/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_names: names }) });
      for (const n of names) {
        $('gallery-grid').querySelector(`[data-name="${CSS.escape(n)}"]`)?.remove();
        if (state.resultName === n) { $('result').hidden = true; state.resultBlob = null; state.resultName = ''; }
      }
      gal.items = gal.items.filter((it) => !names.includes(it.image_name));
      toast(`Deleted ${names.length} image${names.length > 1 ? 's' : ''}`);
      setSelecting(false);
      if (!gal.items.length) $('gallery-grid').innerHTML = '<p class="meta">Nothing yet.</p>';
    } catch (e) { toast(e.message); armDelete(false); }
    finally { $('btn-gallery-confirm').disabled = false; }
  }
  function addGalleryTile(it, prepend) {
    const grid = $('gallery-grid');
    if (prepend) { gal.items.unshift(it); grid.querySelector('p.meta')?.remove(); }
    const tile = document.createElement('div'); tile.className = 'tile'; tile.dataset.name = it.image_name;
    const img = document.createElement('img'); img.alt = '';
    const check = document.createElement('span'); check.className = 'check'; check.textContent = '✓';
    tile.append(img, check);
    tile.addEventListener('click', async () => {
      if (gal.selecting) {
        if (gal.selected.has(it.image_name)) gal.selected.delete(it.image_name); else gal.selected.add(it.image_name);
        tile.classList.toggle('selected', gal.selected.has(it.image_name)); armDelete(false); updateGalleryBar();
        return;
      }
      openViewer(it.image_name, img.src);
    });
    prepend ? grid.prepend(tile) : grid.appendChild(tile);
    apiBlob(`/api/v1/images/i/${encodeURIComponent(it.image_name)}/thumbnail`).then((b) => (img.src = URL.createObjectURL(b))).catch(() => {});
  }
  async function openGallery() {
    show('screen-gallery'); setSelecting(false);
    const grid = $('gallery-grid'); grid.innerHTML = '<p class="meta">Loading…</p>';
    try {
      const j = await api('/api/v1/images/?image_origin=internal&categories=general&is_intermediate=false&limit=50&offset=0');
      gal.items = j.items || [];
      grid.innerHTML = '';
      if (!gal.items.length) grid.innerHTML = '<p class="meta">Nothing yet.</p>';
      for (const it of gal.items) addGalleryTile(it, false);
    } catch (e) { grid.innerHTML = `<p class="error">${e.message}</p>`; }
  }

  // ---------- Full-screen viewer ----------
  const viewer = { name: null, blob: null };
  function openViewer(name, thumbUrl) {
    viewer.name = name; viewer.blob = null; viewerZoom.reset();
    const v = $('viewer'); const img = $('viewer-img');
    img.src = thumbUrl || ''; v.hidden = false; document.body.style.overflow = 'hidden';
    $('viewer-status').textContent = 'Loading full size…'; $('btn-viewer-save').disabled = true; viewerArm(false);
    const fmt = (b) => (b / 1048576).toFixed(1) + ' MB';
    apiBlobProgress(`/api/v1/images/i/${encodeURIComponent(name)}/full`, (l, t) => { $('viewer-status').textContent = t ? `Loading ${Math.round((l / t) * 100)}%` : `Loading ${fmt(l)}`; })
      .then((blob) => { if (viewer.name !== name) return; viewer.blob = blob; img.src = URL.createObjectURL(blob); $('viewer-status').textContent = ''; $('btn-viewer-save').disabled = false; })
      .catch((e) => { if (viewer.name === name) $('viewer-status').textContent = e.message; });
  }
  function closeViewer() { $('viewer').hidden = true; document.body.style.overflow = ''; viewer.name = null; viewer.blob = null; }
  function viewerArm(on) { $('btn-viewer-delete').hidden = on; $('btn-viewer-confirm').hidden = !on; $('btn-viewer-keep').hidden = !on; }
  $('btn-viewer-close').addEventListener('click', closeViewer);
  $('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) closeViewer(); });
  $('btn-viewer-save').addEventListener('click', () => { if (viewer.blob) shareBlob(viewer.blob, viewer.name); });
  const viewerUpscale = (factor) => {
    const name = viewer.name; if (!name) return;
    $('btn-viewer-upscale').disabled = $('btn-viewer-upscale4').disabled = true; $('viewer-status').textContent = `Upscaling ${factor}×…`;
    upscale(name, factor, (blob, newName) => {
      // add to the front of the gallery grid so it's there when the viewer closes
      addGalleryTile({ image_name: newName }, true);
      if (!$('viewer').hidden) { viewer.name = newName; viewer.blob = blob; $('viewer-img').src = URL.createObjectURL(blob); viewerZoom.reset(); $('viewer-status').textContent = `Upscaled ${factor}× ✓`; }
      $('btn-viewer-upscale').disabled = $('btn-viewer-upscale4').disabled = false;
    });
    // re-enable on failure after a bit (the queue card shows the error)
    setTimeout(() => { if (state.jobs.every((j) => j.status !== 'pending' && j.status !== 'in_progress' && j.status !== 'downloading')) { $('btn-viewer-upscale').disabled = $('btn-viewer-upscale4').disabled = false; } }, 8000);
  };
  $('btn-viewer-upscale').addEventListener('click', () => viewerUpscale(2));
  $('btn-viewer-upscale4').addEventListener('click', () => viewerUpscale(4));
  $('btn-viewer-delete').addEventListener('click', () => viewerArm(true));
  $('btn-viewer-keep').addEventListener('click', () => viewerArm(false));
  $('btn-viewer-confirm').addEventListener('click', async () => {
    const name = viewer.name; if (!name) return;
    try {
      await api(`/api/v1/images/i/${encodeURIComponent(name)}`, { method: 'DELETE' });
      $('gallery-grid').querySelector(`[data-name="${CSS.escape(name)}"]`)?.remove();
      gal.items = gal.items.filter((it) => it.image_name !== name);
      if (state.resultName === name) { $('result').hidden = true; state.resultBlob = null; state.resultName = ''; }
      closeViewer(); toast('Deleted');
    } catch (e) { toast(e.message); viewerArm(false); }
  });

  boot();
})();
