# Imagine — InvokeAI Mobile

A tiny, iPhone-friendly web app for a hosted [InvokeAI](https://github.com/invoke-ai/InvokeAI) instance.
Pick a photo → pick a style → generate → save to Photos. Static files only; hosts on GitHub Pages.

Tested against Invoke **6.14** (multi-user auth, `/api/v2/models`, queue API). Supports SD 1.5, SDXL and FLUX main models.

## How it works

1. **Optional 4-digit code** (set `APP_PIN`) locks the app on the phone. It's a convenience lock, not real security — the real gate is step 2.
2. **Sign in to Invoke** with your Invoke email/password. The JWT is stored on the phone and reused; you won't see the login again until it expires.
3. The photo is uploaded to Invoke, an image-to-image graph is queued with the preset's prompt/strength/steps, the queue item is polled, and the finished image is fetched and shown.
4. **Save to Photos** uses the iOS share sheet (choose *Save Image*). If the share sheet isn't available, press-and-hold the image → *Add to Photos*.

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

All settings come from environment variables. Locally they live in `.env`; on GitHub they live in **Settings → Secrets and variables → Actions** and the workflow bakes them into `config.js` at deploy time.

| Variable | Where in GitHub | Required | Notes |
|---|---|---|---|
| `INVOKE_URL` | Variable | yes | e.g. `https://imagine.briney.me` |
| `APP_PIN` | **Secret** | no | 4 digits. Empty = no lock screen |
| `APP_TITLE` | Variable | no | Name shown in the app / home screen |
| `DEFAULT_MODEL` | Variable | no | Model name (or part of it) to pre-select |
| `MAX_SIZE` | Variable | no | Longest edge sent to the model (default 1024) |

## Deploy to GitHub Pages

1. Push this repo to GitHub (branch `main`).
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions:** add the variables/secret above (at minimum `INVOKE_URL`).
4. Push (or run the *Deploy to GitHub Pages* workflow manually). The site appears at `https://<user>.github.io/InvokeAI-Mobile/`.

Changing a variable in GitHub doesn't redeploy by itself — re-run the workflow from the Actions tab.

## Run locally

```bash
cp .env.example .env      # edit INVOKE_URL / APP_PIN
node scripts/build-config.mjs
python3 -m http.server 8080   # then open http://localhost:8080
```

(Add `http://localhost:8080` to `allow_origins` on the server for local testing.)

## Presets

Edit `presets.json`. Each preset:

```json
{ "id": "watercolor", "label": "Watercolor", "emoji": "🎨",
  "prompt": "...", "negative": "...",
  "strength": 0.6, "steps": 30, "cfg": 6.5,
  "model": "optional model name or substring" }
```

`strength` is how far the result may drift from the photo (0.1 = subtle touch-up, 1.0 = ignores the photo). The **Advanced** toggle in the app exposes negative prompt, strength, steps, CFG, model and seed for one-off tweaks.

## Files

```
index.html / styles.css / app.js   the app
presets.json                       stored prompts & styles
config.js                          generated — never commit (see .gitignore)
scripts/build-config.mjs           .env / CI env → config.js
.github/workflows/deploy.yml       Pages deployment
manifest.webmanifest, icon-*.png   PWA / home-screen icon
```

## Notes & limits

- FLUX presets use the first T5 encoder / CLIP embed / FLUX VAE found on the server. Schnell models are capped at 8 steps.
- SD 1.5 models are sent images with a longest edge of 768.
- The gallery (🕘) shows the last 50 non-intermediate images on the server.
- The JWT is stored in `localStorage`; use ⎋ to sign out.
