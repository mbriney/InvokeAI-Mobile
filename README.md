# Imagine — InvokeAI Mobile

A tiny, iPhone-friendly web app for a hosted [InvokeAI](https://github.com/invoke-ai/InvokeAI) instance.
Pick a photo → type an instruction → (optionally switch on LoRAs) → generate → save to Photos. Static files only; hosts on GitHub Pages.

Tested against Invoke **6.14** (multi-user auth, `/api/v2/models`, queue API). Supports SD 1.5, SDXL, FLUX.1 and FLUX.2 (Klein / Dev) main models.

## How it works

1. **Sign in to Invoke** with your Invoke email/password. The JWT is stored on the phone and reused; you won't see the login again until it expires.
2. Each tap on **Generate** uploads the photo and queues a job right away — you can keep editing the prompt and queueing more. A **Queue** card shows what's uploading / waiting / generating / downloading (with Cancel), with a live per-step progress bar and percentage fed by Invoke's Socket.IO channel (polling remains the fallback), and each finished image lands in the preview as it arrives; all of them are in the 🕘 history. The prompt is remembered between sessions. A **Keep face & hair** switch (on by default) appends a likeness clause to every prompt at generation time — exact face, facial structure, skin tone, hair color/style/length — without cluttering the box; it's saved with presets and Grok is told not to duplicate it. Two modes:
   - **Edit photo** (FLUX.2 only) — the photo goes in as a reference image and the prompt is an instruction ("Put him in a navy suit"). Face, pose and scene are preserved. This is the default for FLUX.2 Klein.
   - **Restyle** — classic image-to-image: the photo is re-noised by *strength* and re-drawn to the prompt. Works with every model; the only mode for SD/SDXL/FLUX.1.
3. **Paste** works too: ⌘V anywhere on the page, or the 📋 buttons on iPhone (Safari asks once to allow paste). With a FLUX.2 model in Edit mode an **Outfit reference** slot appears — add a photo of someone wearing an outfit (choose or paste) and the person in your photo is shown wearing it. Both photos go to Klein as reference images (yours first) — verified to keep face, pose and background and swap the garments; a ready-made instruction is filled in (tap *Write the outfit prompt for me* to reset it), and ✨ Improve with Grok sees both images and describes the actual garments.
4. The result (and the full-screen viewer) supports **pinch to zoom, drag to pan, double-tap to reset**; mouse wheel zooms on desktop.
5. **⬆︎ 2×** on the result card upscales it (queued like a generation). The viewer in 🕘 has 2× and 4×. The model is chosen in ⚙ Settings → Upscaler: any Spandrel upscaler installed on the server (4xNomos8kSC is the default and much sharper on photos), or the built-in Real-ESRGAN.
6. **🛠 Fix it** on a result (needs the xAI key): type what's wrong — "the jacket is brown not charcoal, her hair got shorter" — and Grok gets the exact prompt that ran, the original photo, the result image, and the LoRA set, then returns a revised prompt (plus LoRA weights/steps if it thinks they caused it). **Apply & regenerate** reruns the *original* photo with the fix; **Apply only** just updates the prompt.
7. **Save to Photos** uses the iOS share sheet (choose *Save Image*). If the share sheet isn't available, press-and-hold the image → *Add to Photos*.

Add it to your Home Screen (Share → *Add to Home Screen*) and it runs full-screen like an app.

## One-time server setup (required)

GitHub Pages runs on a different origin than your Invoke server, so Invoke must allow it. In `invokeai.yaml`:

```yaml
allow_origins:
  - https://mbriney.github.io
allow_credentials: true
```

Restart Invoke afterwards. (If you later put the app on a custom domain, add that origin too.)

## Configuration

All settings come from environment variables. Locally they live in `.env`; on GitHub they live in **Settings → Secrets and variables → Actions → Variables** and the workflow bakes them into `config.js` at deploy time. Access control is Invoke's own login.

| Variable | Where in GitHub | Required | Notes |
|---|---|---|---|
| `INVOKE_URL` | Variable | yes | e.g. `https://imagine.briney.me` |
| `APP_TITLE` | Variable | no | Name shown in the app / home screen |
| `DEFAULT_MODEL` | Variable | no | Model name (or part of it) to pre-select |
| `MAX_SIZE` | Variable | no | Longest edge sent to the model (default 1024) |

## Deploy to GitHub Pages

1. Push this repo to GitHub (branch `main`).
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions:** add the variables above (at minimum `INVOKE_URL`).
4. Push (or run the *Deploy to GitHub Pages* workflow manually). The site appears at `https://<user>.github.io/InvokeAI-Mobile/`.

Changing a variable in GitHub doesn't redeploy by itself — re-run the workflow from the Actions tab.

## Run locally

```bash
cp .env.example .env      # edit INVOKE_URL
node scripts/build-config.mjs
python3 -m http.server 8080   # then open http://localhost:8080
```

(Add `http://localhost:8080` to `allow_origins` on the server for local testing.)

## Saved presets

**＋ Save** stores the prompt, mode, negative prompt, strength/steps/CFG, model and active LoRAs (with weights) under a name. Tap a chip to load it (chip shows **✓ loaded**). Change anything and the chip switches to **● edited** with three choices: **Update** (overwrite the preset with what's on screen), **Revert** (reload the preset), or **＋ Save as new**. **Delete** removes it. Presets live in the browser's `localStorage` on that device only — nothing is written to the server or the repo, and they don't sync between phones.

## ✨ Improve with Grok (optional)

Open **⚙ Settings**, paste an xAI API key (console.x.ai), pick a Grok model, Save. A **✨ Improve with Grok** button then appears under the prompt. It sends Grok your rough idea plus the real context — which model family is selected (e.g. FLUX.2 Klein: instruction-style, no CFG), whether you're in Edit or Restyle mode, every LoRA installed for that model with its description and trigger words and which ones are on, and (optionally) a downscaled copy of the photo so it can see what it's describing. Grok returns a rewritten prompt, a negative prompt where the model uses one, a one-line note, and the set of LoRAs it thinks fit — each with a recommended weight taken from the LoRA's description (its "recommended strength" guidance) or a sensible default. **Use it + N LoRAs** applies the prompt *and* makes the active LoRAs exactly that set at those weights (anything else on is switched off); **Prompt only** changes just the text; chips can be toggled individually; **Keep mine** discards.

The key lives only in that browser's `localStorage` and is sent only to `api.x.ai` — it is never in the repo, `config.js`, or your Invoke server.

## LoRAs

Every LoRA installed on the server that fits the selected model is listed under **LoRAs** — same base, and for FLUX.2 the same variant (a Klein 9B or Dev LoRA is hidden when Klein 4B is selected, because it fails inside the denoiser with a tensor-shape error; a LoRA with no recorded variant is shown with a warning) with an on/off toggle and a weight slider (−1 … 2, default 0.75). Active LoRAs are spliced into the graph with the family's `*_lora_collection_loader` node (Klein, FLUX.2 Dev, FLUX.1, SDXL, SD 1.5). Selections are remembered on the phone.

Note for FLUX.2 Klein: Invoke can only patch LoRAs onto FP8 / NF4 / 8-bit builds — a GGUF k-quant main model silently ignores them (the same reason the Concepts picker greys out in the Invoke UI).

## Files

```
index.html / styles.css / app.js   the app
config.js                          generated — never commit (see .gitignore)
scripts/build-config.mjs           .env / CI env → config.js
.github/workflows/deploy.yml       Pages deployment
manifest.webmanifest, icon-*.png   PWA / home-screen icon
```

## Notes & limits

- FLUX.2 Klein uses the first Qwen3 encoder and the FLUX.2 VAE found on the server; steps default to 8 when a FLUX.2 model is selected (CFG is ignored by Klein); in testing, identity at 4/8/12 steps was near-identical with no LoRA on — LoRAs above ~0.6 are what change faces, and the LoRA card warns when the likeness lock is on and one is set that high. FLUX.1 uses the first T5 / CLIP / FLUX VAE; Schnell is capped at 8 steps.
- SD 1.5 models are sent images with a longest edge of 768.
- The gallery (🕘) lists the server's non-intermediate images newest first, 30 at a time, loading more as you scroll. Tap one for a full-screen view with **Save to Photos**, **⬆︎ 2× / 4× upscale** (the upscaled copy is a new gallery image and the viewer switches to it) and **Delete**; **Select** → tap images → **Delete** → **Confirm** removes several at once. Deletion is permanent on the server (two taps, no pop-ups).
- The JWT is stored in `localStorage`; use ⎋ to sign out.
