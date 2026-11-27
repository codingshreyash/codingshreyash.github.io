#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export WRANGLER_SEND_METRICS=false

if [ -x "./node_modules/.bin/wrangler" ]; then
  WRANGLER=("./node_modules/.bin/wrangler")
elif command -v wrangler >/dev/null 2>&1; then
  WRANGLER=("wrangler")
else
  echo "==> Installing wrangler locally (one-time setup)..."
  npm install --no-audit --no-fund
  WRANGLER=("./node_modules/.bin/wrangler")
fi

echo "==> Checking Cloudflare authentication..."
WHOAMI_STATUS=0
WHOAMI_OUT="$(CI=true "${WRANGLER[@]}" whoami 2>&1)" || WHOAMI_STATUS=$?
if [ "$WHOAMI_STATUS" -ne 0 ]; then
  if printf '%s' "$WHOAMI_OUT" | grep -qiE 'not authenticated|not logged in|wrangler login|CLOUDFLARE_API_TOKEN'; then
    echo "Not logged in to Cloudflare. Opening browser login..."
    "${WRANGLER[@]}" login
  else
    echo "Unexpected error running 'wrangler whoami':" >&2
    printf '%s\n' "$WHOAMI_OUT" >&2
    exit "$WHOAMI_STATUS"
  fi
fi

echo "==> Deploying split-gemini-proxy..."
DEPLOY_LOG="$(mktemp)"
trap 'rm -f "$DEPLOY_LOG"' EXIT
"${WRANGLER[@]}" deploy 2>&1 | tee "$DEPLOY_LOG"

WORKER_URL="$(grep -Eo 'https://[a-zA-Z0-9._-]+\.workers\.dev' "$DEPLOY_LOG" | tail -n 1 || true)"

echo "==> Checking GEMINI_API_KEY secret..."
HAS_SECRET="no"
if CI=true "${WRANGLER[@]}" secret list 2>/dev/null | grep -q '"GEMINI_API_KEY"'; then
  HAS_SECRET="yes"
fi

if [ "$HAS_SECRET" = "yes" ]; then
  echo "GEMINI_API_KEY secret is already set on this Worker."
elif [ -n "${GEMINI_API_KEY:-}" ]; then
  echo "Setting GEMINI_API_KEY secret from environment..."
  printf '%s' "$GEMINI_API_KEY" | "${WRANGLER[@]}" secret put GEMINI_API_KEY
else
  echo "GEMINI_API_KEY secret is not set yet. Paste your Gemini API key when prompted:"
  "${WRANGLER[@]}" secret put GEMINI_API_KEY
fi

echo ""
echo "========================================"
if [ -n "$WORKER_URL" ]; then
  echo "Live Worker URL: $WORKER_URL"
  echo "Health check:    curl $WORKER_URL/health"
  echo "Next step:       Paste $WORKER_URL into DEFAULT_PROXY_URL in ../../split/index.html"
else
  echo "Deploy complete! Copy the workers.dev URL shown above into DEFAULT_PROXY_URL in ../../split/index.html"
fi
echo "========================================"
