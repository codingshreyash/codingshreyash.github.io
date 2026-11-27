# Split Gemini Proxy

Minimal Cloudflare Worker proxy for `/split` receipt scanning so `GEMINI_API_KEY` stays off GitHub and out of client bundles. Zero runtime dependencies and zero paid bindings (uses Cloudflare's free Workers tier + Cache API rate limiting).

## Deploy in 3 Steps

1. **Deploy & set secret** (handles Cloudflare login, deploy, and `GEMINI_API_KEY` secret):
   ```bash
   ./deploy.sh
   ```
2. **Verify health**:
   ```bash
   curl https://<your-worker>.workers.dev/health
   # -> {"ok":true,"configured":true}
   ```
3. **Wire up `/split`**:
   Paste the printed `https://<your-worker>.workers.dev` URL into `DEFAULT_PROXY_URL` near the top of `../../split/index.html` (or test immediately via `/split/#proxy=https://<your-worker>.workers.dev`).

## API Contract

- `GET /health` -> `{ "ok": true, "configured": boolean }`
- `POST /api/scan` -> accepts `{ model, imageBase64, mimeType, thinkingLevel }` and returns `{ ok: true, model, data }` or `{ ok: false, error, code }`
  - Allowed models: `gemini-3.5-flash-lite`, `gemini-3.6-flash`
  - Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`
  - Allowed `thinkingLevel`: `minimal`, `low`
  - Max payload: 4.5 MB (`413`)
  - Per-IP limits: 8 req/min burst, 30 req/hr (`429`)
  - CORS allowlist: `https://shreyashranjan.com`, `https://www.shreyashranjan.com`, `https://codingshreyash.github.io`, `http://localhost:*`, `http://127.0.0.1:*`

## Local Development & Tests

```bash
npm test
# Local dev (put GEMINI_API_KEY=... in .dev.vars, gitignored):
npm install && npm run dev
```
