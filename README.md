# Imagine — InvokeAI Mobile

A tiny, iPhone-friendly web app for a hosted [InvokeAI](https://github.com/invoke-ai/InvokeAI) instance.
Pick a photo → type an instruction → (optionally switch on LoRAs) → generate → save to Photos. Static files only; hosts on GitHub Pages.

Tested against Invoke **6.14** (multi-user auth, `/api/v2/models`, queue API). Supports SD 1.5, SDXL, FLUX.1 and FLUX.2 (Klein / Dev) main models.

## How it works

1. **Sign in to Invoke** with your Invoke email/password. The JWT is stored on the phone and reused; you won't see the login again until it expires.
2. Each tap on **Generate** uploads the photo and queues a job right away — you can keep editing the prompt and queueing more. A **Queue** card shows what's uploading / waiting / generating / downloading (with Cancel), and each finished image lands in the preview as it arrives; all of them are in the 🕘 history. The prompt is remembered between sessions. Two modes:
   - **Edit photo** (FLUX.2 only) — the photo goes in as a reference image and the prompt is an instruction ("Put him in a navy suit"). Face, pose and scene are preserved. This is the default for FLUX.2 Klein.
   - **Restyle** — classic image-to-image: the photo is re-noised by *strength* and re-drawn to the prompt. Works with every model; the only mode for SD/SDXL/FLUX.1.
3. **Save to Photos** uses the iOS share sheet (choose *Save Image*). If the share sheet isn't available, press-and-hold the image → *Add to Photos*.

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

## LoRAs

Every LoRA installed on the server whose base matches the selected model is listed under **LoRAs** with an on/off toggle and a weight slider (−1 … 2, default 0.75). Active LoRAs are spliced into the graph with the family's `*_lora_collection_loader` node (Klein, FLUX.2 Dev, FLUX.1, SDXL, SD 1.5). Selections are remembered on the phone.

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

- FLUX.2 Klein uses the first Qwen3 encoder and the FLUX.2 VAE found on the server; steps are dropped to 4 automatically when a FLUX.2 model is selected (CFG is ignored by Klein). FLUX.1 uses the first T5 / CLIP / FLUX VAE; Schnell is capped at 8 steps.
- SD 1.5 models are sent images with a longest edge of 768.
- The gallery (🕘) shows the last 50 non-intermediate images on the server. Tap one for a full-screen view with **Save to Photos** and **Delete**; **Select** → tap images → **Delete** → **Confirm** removes several at once. Deletion is permanent on the server (two taps, no pop-ups).
- The JWT is stored in `localStorage`; use ⎋ to sign out.
