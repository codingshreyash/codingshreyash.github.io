/**
 * Cloudflare Worker proxy for /split receipt scanning via Gemini REST API.
 * Zero runtime dependencies, zero extra Cloudflare bindings required.
 */

export const ALLOWED_MODELS = new Set([
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
]);

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const ALLOWED_THINKING_LEVELS = new Set(['minimal', 'low']);

export const MAX_BODY_BYTES = 4_500_000; // ~4.5 MB
export const GEMINI_TIMEOUT_MS = 25_000;
export const DEFAULT_HOURLY_LIMIT = 30;
export const DEFAULT_BURST_LIMIT = 8; // per 60s (2-stage scan uses 2 reqs/receipt)

const STATIC_ALLOWED_ORIGINS = new Set([
  'https://shreyashranjan.com',
  'https://www.shreyashranjan.com',
  'https://codingshreyash.github.io',
]);

const LOCALHOST_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export const RECEIPT_PROMPT =
  'This is a photo of a purchase receipt. Extract the merchant name, receipt date, ' +
  'every purchased line item, and the summary totals.\n' +
  'Rules:\n' +
  '- Expand store abbreviations into readable item names (e.g. "ORG CHKN THGH" -> "Organic Chicken Thighs").\n' +
  '- Use the final extended price charged for each line item (not unit price when quantity > 1).\n' +
  '- Include coupons, discounts, and markdowns as separate items with a negative price.\n' +
  '- Do NOT include subtotal, tax, fees, tip, total, change, or payment lines in "items".\n' +
  '- Sum multiple tax lines into "tax". Put service charges, delivery/bag/bottle fees in "fees".\n' +
  '- Use null for any of subtotal, tax, fees, tip, or total that is not printed on the receipt.\n' +
  '- Format "date" as YYYY-MM-DD when readable, otherwise empty string "".';

export const RECEIPT_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    place: {
      type: 'string',
      description: 'Merchant or store name, or empty string if not visible.',
    },
    date: {
      type: 'string',
      description: 'Receipt date in YYYY-MM-DD format if visible, otherwise empty string.',
    },
    items: {
      type: 'array',
      description: 'Purchased line items plus separate negative-price coupon/discount lines.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: 'Readable item name with abbreviations expanded.',
          },
          price: {
            type: 'number',
            description: 'Extended line price charged (negative for discounts/coupons).',
          },
        },
        required: ['name', 'price'],
      },
    },
    subtotal: {
      type: ['number', 'null'],
      description: 'Printed subtotal before tax and tip, or null if not shown.',
    },
    tax: {
      type: ['number', 'null'],
      description: 'Total tax charged, or null if not shown.',
    },
    fees: {
      type: ['number', 'null'],
      description: 'Service, delivery, bag, or bottle fees, or null if not shown.',
    },
    tip: {
      type: ['number', 'null'],
      description: 'Tip or gratuity amount, or null if not shown.',
    },
    total: {
      type: ['number', 'null'],
      description: 'Final total charged, or null if not shown.',
    },
  },
  required: ['place', 'date', 'items', 'subtotal', 'tax', 'fees', 'tip', 'total'],
};

// In-isolate fallback counter store for burst consistency and local/test environments.
const memoryCounters = new Map();

export function resetMemoryRateLimits() {
  memoryCounters.clear();
}

export function isAllowedOrigin(origin, env = {}) {
  if (!origin || typeof origin !== 'string') return false;
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  if (LOCALHOST_ORIGIN_RE.test(origin)) return true;
  if (typeof env?.EXTRA_ALLOWED_ORIGINS === 'string' && env.EXTRA_ALLOWED_ORIGINS.trim()) {
    const extras = env.EXTRA_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    if (extras.includes(origin)) return true;
  }
  return false;
}

function buildCorsHeaders(origin, allowed) {
  const headers = new Headers({
    Vary: 'Origin',
    'Cache-Control': 'no-store',
  });
  if (origin && allowed) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return headers;
}

function jsonResponse(body, status, origin, originAllowed, extraHeaders = {}) {
  const headers = buildCorsHeaders(origin, originAllowed);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) {
    headers.set(k, String(v));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function getClientIp(request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

function parsePositiveInt(val, fallback) {
  const n = Number.parseInt(String(val ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pruneMemoryCounters(nowSec) {
  if (memoryCounters.size <= 2000) return;
  for (const [k, entry] of memoryCounters) {
    if (entry.expiresAt <= nowSec) memoryCounters.delete(k);
  }
}

async function incrementWindowCounter(cache, key, windowSec, nowSec) {
  const bucket = Math.floor(nowSec / windowSec);
  const bucketEnd = (bucket + 1) * windowSec;
  const ttl = Math.max(1, bucketEnd - nowSec);
  const fullKey = `${key}:${bucket}`;

  let cacheCount = 0;
  const cacheReq = cache
    ? new Request(`https://shreyashranjan.com/__split_proxy_rl/${encodeURIComponent(fullKey)}`, {
        method: 'GET',
      })
    : null;

  if (cache && cacheReq) {
    try {
      const hit = await cache.match(cacheReq);
      if (hit) {
        const parsed = Number.parseInt(await hit.text(), 10);
        if (Number.isFinite(parsed) && parsed > 0) cacheCount = parsed;
      }
    } catch {
      // Fall back silently to in-isolate counter if Cache API is unavailable.
    }
  }

  const memEntry = memoryCounters.get(fullKey);
  const memCount = memEntry && memEntry.expiresAt > nowSec ? memEntry.count : 0;
  const nextCount = Math.max(cacheCount, memCount) + 1;

  pruneMemoryCounters(nowSec);
  memoryCounters.set(fullKey, { count: nextCount, expiresAt: bucketEnd });

  if (cache && cacheReq) {
    try {
      await cache.put(
        cacheReq,
        new Response(String(nextCount), {
          status: 200,
          headers: { 'Cache-Control': `public, max-age=${ttl}` },
        }),
      );
    } catch {
      // Ignore cache write errors.
    }
  }

  return { count: nextCount, retryAfter: ttl };
}

async function checkRateLimit(ip, env, nowMs = Date.now()) {
  const hourlyLimit = parsePositiveInt(env?.RATE_LIMIT_HOURLY, DEFAULT_HOURLY_LIMIT);
  const burstLimit = parsePositiveInt(env?.RATE_LIMIT_BURST, DEFAULT_BURST_LIMIT);
  const nowSec = Math.floor(nowMs / 1000);
  const cache = typeof caches !== 'undefined' && caches?.default ? caches.default : null;

  const [burst, hourly] = await Promise.all([
    incrementWindowCounter(cache, `m:${ip}`, 60, nowSec),
    incrementWindowCounter(cache, `h:${ip}`, 3600, nowSec),
  ]);

  if (burst.count > burstLimit) {
    return { allowed: false, retryAfter: burst.retryAfter };
  }
  if (hourly.count > hourlyLimit) {
    return { allowed: false, retryAfter: hourly.retryAfter };
  }
  return { allowed: true, retryAfter: 0 };
}

async function readBodyWithLimit(request, maxBytes) {
  const cl = request.headers.get('Content-Length');
  if (cl !== null) {
    const declared = Number.parseInt(cl, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { tooLarge: true, text: '' };
    }
  }

  if (!request.body) {
    return { tooLarge: false, text: '' };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return { tooLarge: true, text: '' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, text: new TextDecoder().decode(merged) };
}

function toNullableNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = typeof val === 'number' ? val : Number.parseFloat(String(val));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

export function normalizeReceiptData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Model response root is not a JSON object');
  }

  const items = [];
  if (Array.isArray(raw.items)) {
    for (const item of raw.items) {
      if (!item || typeof item !== 'object') continue;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const price =
        typeof item.price === 'number' ? item.price : Number.parseFloat(String(item.price));
      if (!name || !Number.isFinite(price)) continue;
      items.push({
        name,
        price: Math.round(price * 100) / 100,
      });
    }
  }

  return {
    place: typeof raw.place === 'string' ? raw.place.trim() : '',
    date: typeof raw.date === 'string' ? raw.date.trim() : '',
    items,
    subtotal: toNullableNumber(raw.subtotal),
    tax: toNullableNumber(raw.tax),
    fees: toNullableNumber(raw.fees),
    tip: toNullableNumber(raw.tip),
    total: toNullableNumber(raw.total),
  };
}

export function buildGeminiRequestBody({ imageBase64, mimeType, thinkingLevel }) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
          { text: RECEIPT_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: RECEIPT_RESPONSE_JSON_SCHEMA,
      thinkingConfig: {
        thinkingLevel,
      },
    },
  };
}

export function extractGeminiReceipt(payload) {
  const blockReason = payload?.promptFeedback?.blockReason;
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const cand = candidates[0];

  if (!cand) {
    return {
      ok: false,
      status: 422,
      code: blockReason ? 'UPSTREAM_BLOCKED' : 'UPSTREAM_EMPTY',
      error: blockReason
        ? `Receipt was blocked by safety filters (${blockReason}).`
        : 'Model returned no candidate response.',
    };
  }

  const finishReason = cand.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    if (finishReason === 'MAX_TOKENS') {
      return {
        ok: false,
        status: 502,
        code: 'UPSTREAM_TRUNCATED',
        error: 'Model output was truncated before finishing the receipt.',
      };
    }
    if (
      finishReason === 'SAFETY' ||
      finishReason === 'RECITATION' ||
      finishReason === 'PROHIBITED_CONTENT' ||
      finishReason === 'BLOCKLIST' ||
      finishReason === 'SPII'
    ) {
      return {
        ok: false,
        status: 422,
        code: 'UPSTREAM_BLOCKED',
        error: `Model blocked the response (${finishReason}).`,
      };
    }
    return {
      ok: false,
      status: 502,
      code: 'UPSTREAM_INCOMPLETE',
      error: `Model did not complete cleanly (${finishReason}).`,
    };
  }

  const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
  const rawText = parts
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();

  if (!rawText) {
    return {
      ok: false,
      status: 502,
      code: 'UPSTREAM_EMPTY',
      error: 'Model returned empty content.',
    };
  }

  // Strip accidental markdown fences if a model ever wraps JSON.
  let cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      ok: false,
      status: 502,
      code: 'UPSTREAM_INVALID_JSON',
      error: 'Model returned malformed JSON.',
    };
  }

  try {
    const data = normalizeReceiptData(parsed);
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      status: 502,
      code: 'UPSTREAM_INVALID_JSON',
      error: 'Model returned unexpected receipt structure.',
    };
  }
}

function sanitizeUpstreamMessage(text) {
  return String(text || '')
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[redacted]')
    .slice(0, 180)
    .trim();
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const originAllowed = isAllowedOrigin(origin, env);

    // Health check route
    if (url.pathname === '/health') {
      if (request.method === 'OPTIONS') {
        if (origin && !originAllowed) {
          return jsonResponse(
            { ok: false, error: 'Origin not allowed.', code: 'CORS_FORBIDDEN' },
            403,
            origin,
            false,
          );
        }
        return new Response(null, { status: 204, headers: buildCorsHeaders(origin, originAllowed) });
      }
      if (request.method !== 'GET') {
        return jsonResponse(
          { ok: false, error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' },
          405,
          origin,
          originAllowed,
          { Allow: 'GET, OPTIONS' },
        );
      }
      return jsonResponse(
        { ok: true, configured: Boolean(env?.GEMINI_API_KEY) },
        200,
        origin,
        originAllowed,
      );
    }

    if (url.pathname !== '/api/scan') {
      return jsonResponse(
        { ok: false, error: 'Not found.', code: 'NOT_FOUND' },
        404,
        origin,
        originAllowed,
      );
    }

    // Enforce CORS allowlist whenever Origin header is sent
    if (origin && !originAllowed) {
      return jsonResponse(
        { ok: false, error: 'Origin not allowed.', code: 'CORS_FORBIDDEN' },
        403,
        origin,
        false,
      );
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: buildCorsHeaders(origin, originAllowed) });
    }

    if (request.method !== 'POST') {
      return jsonResponse(
        { ok: false, error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' },
        405,
        origin,
        originAllowed,
        { Allow: 'POST, OPTIONS' },
      );
    }

    // Enforce payload size limit before buffering large bodies
    const { tooLarge, text: rawBody } = await readBodyWithLimit(request, MAX_BODY_BYTES);
    if (tooLarge) {
      return jsonResponse(
        { ok: false, error: 'Request payload exceeds the 4.5 MB limit.', code: 'PAYLOAD_TOO_LARGE' },
        413,
        origin,
        originAllowed,
      );
    }

    // Parse & validate request body
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse(
        { ok: false, error: 'Invalid JSON request body.', code: 'INVALID_JSON' },
        400,
        origin,
        originAllowed,
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse(
        { ok: false, error: 'Request body must be a JSON object.', code: 'INVALID_JSON' },
        400,
        origin,
        originAllowed,
      );
    }

    const { model, mimeType } = body;
    const thinkingLevel = body.thinkingLevel ?? 'minimal';
    const rawImage = typeof body.imageBase64 === 'string' ? body.imageBase64.replace(/\s+/g, '') : '';

    if (typeof model !== 'string' || !ALLOWED_MODELS.has(model)) {
      return jsonResponse(
        {
          ok: false,
          error: 'Unsupported model. Allowed: gemini-3.5-flash-lite, gemini-3.6-flash.',
          code: 'INVALID_MODEL',
        },
        400,
        origin,
        originAllowed,
      );
    }

    if (typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(mimeType)) {
      return jsonResponse(
        {
          ok: false,
          error: 'Unsupported mimeType. Allowed: image/jpeg, image/png, image/webp.',
          code: 'INVALID_MIME_TYPE',
        },
        400,
        origin,
        originAllowed,
      );
    }

    if (typeof thinkingLevel !== 'string' || !ALLOWED_THINKING_LEVELS.has(thinkingLevel)) {
      return jsonResponse(
        {
          ok: false,
          error: 'Unsupported thinkingLevel. Allowed: minimal, low.',
          code: 'INVALID_THINKING_LEVEL',
        },
        400,
        origin,
        originAllowed,
      );
    }

    if (!rawImage || rawImage.length > MAX_BODY_BYTES || !BASE64_RE.test(rawImage)) {
      return jsonResponse(
        { ok: false, error: 'Missing or invalid base64 image payload.', code: 'INVALID_IMAGE' },
        400,
        origin,
        originAllowed,
      );
    }

    if (!env?.GEMINI_API_KEY) {
      return jsonResponse(
        { ok: false, error: 'Proxy is not configured with a Gemini API key.', code: 'NOT_CONFIGURED' },
        503,
        origin,
        originAllowed,
      );
    }

    // Per-IP rate limiting (KV-free via CF Cache API + in-isolate burst guard)
    const ip = getClientIp(request);
    const rl = await checkRateLimit(ip, env);
    if (!rl.allowed) {
      return jsonResponse(
        { ok: false, error: 'Rate limit exceeded. Please wait and try again.', code: 'RATE_LIMITED' },
        429,
        origin,
        originAllowed,
        { 'Retry-After': rl.retryAfter },
      );
    }

    // Call Gemini REST API
    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const geminiBody = buildGeminiRequestBody({
      imageBase64: rawImage,
      mimeType,
      thinkingLevel,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    let upstreamRes;
    try {
      upstreamRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify(geminiBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        return jsonResponse(
          { ok: false, error: 'Gemini API request timed out.', code: 'UPSTREAM_TIMEOUT' },
          504,
          origin,
          originAllowed,
        );
      }
      return jsonResponse(
        { ok: false, error: 'Failed to reach Gemini API.', code: 'UPSTREAM_NETWORK_ERROR' },
        502,
        origin,
        originAllowed,
      );
    } finally {
      clearTimeout(timer);
    }

    const upstreamText = await upstreamRes.text();
    if (!upstreamRes.ok) {
      let detail = '';
      try {
        const errJson = JSON.parse(upstreamText);
        detail = errJson?.error?.message || '';
      } catch {
        detail = upstreamText;
      }
      const safeDetail = sanitizeUpstreamMessage(detail);

      if (upstreamRes.status === 429) {
        return jsonResponse(
          {
            ok: false,
            error: safeDetail || 'Gemini API quota temporarily exceeded.',
            code: 'UPSTREAM_RATE_LIMITED',
          },
          429,
          origin,
          originAllowed,
        );
      }
      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        return jsonResponse(
          {
            ok: false,
            error: 'Upstream Gemini API authentication failed.',
            code: 'UPSTREAM_AUTH_ERROR',
          },
          502,
          origin,
          originAllowed,
        );
      }
      if (upstreamRes.status === 400) {
        return jsonResponse(
          {
            ok: false,
            error: safeDetail || 'Gemini rejected the scan request.',
            code: 'UPSTREAM_BAD_REQUEST',
          },
          400,
          origin,
          originAllowed,
        );
      }
      return jsonResponse(
        {
          ok: false,
          error: safeDetail || `Gemini API returned HTTP ${upstreamRes.status}.`,
          code: 'UPSTREAM_ERROR',
        },
        502,
        origin,
        originAllowed,
      );
    }

    let payload;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      return jsonResponse(
        { ok: false, error: 'Invalid JSON received from Gemini API.', code: 'UPSTREAM_INVALID_JSON' },
        502,
        origin,
        originAllowed,
      );
    }

    const extracted = extractGeminiReceipt(payload);
    if (!extracted.ok) {
      return jsonResponse(
        { ok: false, error: extracted.error, code: extracted.code },
        extracted.status,
        origin,
        originAllowed,
      );
    }

    return jsonResponse(
      { ok: true, model, data: extracted.data },
      200,
      origin,
      originAllowed,
    );
  },
};
