import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  MAX_BODY_BYTES,
  RECEIPT_RESPONSE_JSON_SCHEMA,
  resetMemoryRateLimits,
} from '../src/index.js';

const VALID_BASE64 = Buffer.from('fake-jpeg-bytes').toString('base64');
const ALLOWED_ORIGIN = 'https://shreyashranjan.com';

function makeScanRequest(body, { origin = ALLOWED_ORIGIN, ip = '203.0.113.10', headers = {} } = {}) {
  const reqHeaders = new Headers({
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip,
    ...headers,
  });
  if (origin !== null) reqHeaders.set('Origin', origin);
  return new Request('https://split-gemini-proxy.example.workers.dev/api/scan', {
    method: 'POST',
    headers: reqHeaders,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('split-gemini-proxy Worker', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetMemoryRateLimits();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('GET /health reports configured status and CORS headers', async () => {
    const req = new Request('https://split-gemini-proxy.example.workers.dev/health', {
      method: 'GET',
      headers: { Origin: ALLOWED_ORIGIN },
    });

    const resUnset = await worker.fetch(req, {});
    assert.equal(resUnset.status, 200);
    assert.equal(resUnset.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
    assert.deepEqual(await resUnset.json(), { ok: true, configured: false });

    const resSet = await worker.fetch(req, { GEMINI_API_KEY: 'test-key' });
    assert.equal(resSet.status, 200);
    assert.deepEqual(await resSet.json(), { ok: true, configured: true });
  });

  it('enforces CORS allowlist for preflight and POST requests', async () => {
    const allowed = [
      'https://shreyashranjan.com',
      'https://www.shreyashranjan.com',
      'https://codingshreyash.github.io',
      'http://localhost:8000',
      'http://127.0.0.1:5173',
      'http://localhost',
    ];
    for (const origin of allowed) {
      const preflight = new Request('https://split-gemini-proxy.example.workers.dev/api/scan', {
        method: 'OPTIONS',
        headers: { Origin: origin },
      });
      const res = await worker.fetch(preflight, { GEMINI_API_KEY: 'test-key' });
      assert.equal(res.status, 204, `expected 204 for ${origin}`);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(res.headers.get('Vary'), 'Origin');
    }

    const disallowed = [
      'https://evil.example.com',
      'https://shreyashranjan.com.evil.com',
      'http://shreyashranjan.com',
      'https://localhost:8000',
    ];
    for (const origin of disallowed) {
      const preflight = new Request('https://split-gemini-proxy.example.workers.dev/api/scan', {
        method: 'OPTIONS',
        headers: { Origin: origin },
      });
      const preRes = await worker.fetch(preflight, { GEMINI_API_KEY: 'test-key' });
      assert.equal(preRes.status, 403, `expected 403 preflight for ${origin}`);
      assert.equal(preRes.headers.get('Access-Control-Allow-Origin'), null);

      const postRes = await worker.fetch(
        makeScanRequest(
          {
            model: 'gemini-3.5-flash-lite',
            imageBase64: VALID_BASE64,
            mimeType: 'image/jpeg',
            thinkingLevel: 'minimal',
          },
          { origin },
        ),
        { GEMINI_API_KEY: 'test-key' },
      );
      assert.equal(postRes.status, 403);
      const body = await postRes.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, 'CORS_FORBIDDEN');
    }
  });

  it('rejects unknown routes and wrong HTTP methods', async () => {
    const notFound = await worker.fetch(
      new Request('https://split-gemini-proxy.example.workers.dev/unknown'),
      {},
    );
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).code, 'NOT_FOUND');

    const badMethod = await worker.fetch(
      new Request('https://split-gemini-proxy.example.workers.dev/api/scan', { method: 'GET' }),
      {},
    );
    assert.equal(badMethod.status, 405);
    assert.equal((await badMethod.json()).code, 'METHOD_NOT_ALLOWED');
  });

  it('enforces strict model, mimeType, thinkingLevel, and imageBase64 validation', async () => {
    const cases = [
      [{ model: 'gemini-2.5-flash', imageBase64: VALID_BASE64, mimeType: 'image/jpeg', thinkingLevel: 'minimal' }, 'INVALID_MODEL'],
      [{ model: 'gemini-3.8-flash', imageBase64: VALID_BASE64, mimeType: 'image/jpeg', thinkingLevel: 'minimal' }, 'INVALID_MODEL'],
      [{ model: 'gemini-3.5-flash-lite', imageBase64: VALID_BASE64, mimeType: 'image/gif', thinkingLevel: 'minimal' }, 'INVALID_MIME_TYPE'],
      [{ model: 'gemini-3.6-flash', imageBase64: VALID_BASE64, mimeType: 'image/png', thinkingLevel: 'high' }, 'INVALID_THINKING_LEVEL'],
      [{ model: 'gemini-3.5-flash-lite', imageBase64: 'not!valid@base64', mimeType: 'image/webp', thinkingLevel: 'low' }, 'INVALID_IMAGE'],
      [{ model: 'gemini-3.5-flash-lite', imageBase64: '', mimeType: 'image/jpeg', thinkingLevel: 'minimal' }, 'INVALID_IMAGE'],
    ];

    for (const [payload, expectedCode] of cases) {
      const res = await worker.fetch(makeScanRequest(payload), { GEMINI_API_KEY: 'test-key' });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(json.code, expectedCode);
    }

    const badJson = await worker.fetch(makeScanRequest('{not json'), { GEMINI_API_KEY: 'test-key' });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).code, 'INVALID_JSON');
  });

  it('rejects oversized payloads with 413 via Content-Length and streaming cap', async () => {
    // 1. Declared Content-Length > MAX_BODY_BYTES
    const headerRes = await worker.fetch(
      makeScanRequest(
        { model: 'gemini-3.5-flash-lite', imageBase64: VALID_BASE64, mimeType: 'image/jpeg' },
        { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1024) } },
      ),
      { GEMINI_API_KEY: 'test-key' },
    );
    assert.equal(headerRes.status, 413);
    assert.equal((await headerRes.json()).code, 'PAYLOAD_TOO_LARGE');

    // 2. Actual streamed body > MAX_BODY_BYTES without Content-Length
    const chunk = new Uint8Array(1_000_000).fill(65);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const streamReq = new Request('https://split-gemini-proxy.example.workers.dev/api/scan', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.11',
      },
      body: stream,
      duplex: 'half',
    });
    const streamRes = await worker.fetch(streamReq, { GEMINI_API_KEY: 'test-key' });
    assert.equal(streamRes.status, 413);
    assert.equal((await streamRes.json()).code, 'PAYLOAD_TOO_LARGE');
  });

  it('returns 503 when GEMINI_API_KEY is missing', async () => {
    const res = await worker.fetch(
      makeScanRequest({
        model: 'gemini-3.5-flash-lite',
        imageBase64: VALID_BASE64,
        mimeType: 'image/jpeg',
        thinkingLevel: 'minimal',
      }),
      {},
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'NOT_CONFIGURED');
  });

  it('sends correct REST schema + thinkingConfig and parses receipt JSON cleanly', async () => {
    const captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url, init, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      place: '  Trader Joes  ',
                      date: '2026-11-27',
                      items: [
                        { name: 'Organic Chicken Thighs', price: 11.49 },
                        { name: 'Store Coupon', price: -1.5 },
                      ],
                      subtotal: 9.99,
                      tax: 0.7,
                      fees: null,
                      tip: null,
                      total: 10.69,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    for (const [model, thinkingLevel] of [
      ['gemini-3.5-flash-lite', 'minimal'],
      ['gemini-3.6-flash', 'low'],
    ]) {
      const res = await worker.fetch(
        makeScanRequest({
          model,
          imageBase64: VALID_BASE64,
          mimeType: 'image/jpeg',
          thinkingLevel,
        }),
        { GEMINI_API_KEY: 'secret-test-key' },
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);

      const json = await res.json();
      assert.deepEqual(json, {
        ok: true,
        model,
        data: {
          place: 'Trader Joes',
          date: '2026-11-27',
          items: [
            { name: 'Organic Chicken Thighs', price: 11.49 },
            { name: 'Store Coupon', price: -1.5 },
          ],
          subtotal: 9.99,
          tax: 0.7,
          fees: null,
          tip: null,
          total: 10.69,
        },
      });
    }

    assert.equal(captured.length, 2);
    assert.equal(
      captured[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    );
    assert.equal(
      captured[1].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    );
    assert.equal(captured[0].init.headers['x-goog-api-key'], 'secret-test-key');
    assert.equal(captured[0].body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(captured[0].body.generationConfig.responseJsonSchema, RECEIPT_RESPONSE_JSON_SCHEMA);
    assert.deepEqual(captured[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
    assert.deepEqual(captured[1].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
    assert.equal('temperature' in captured[0].body.generationConfig, false);
    assert.equal('responseSchema' in captured[0].body.generationConfig, false);
  });

  it('filters out thought parts (part.thought === true) before JSON parsing', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  { thought: true, text: 'Let me sum the receipt items carefully: 4.50 + 2.50 = 7.00' },
                  {
                    text: JSON.stringify({
                      place: 'Cafe Luna',
                      date: '2026-11-26',
                      items: [{ name: 'Latte', price: 5.5 }],
                      subtotal: 5.5,
                      tax: 0.44,
                      fees: null,
                      tip: 1.0,
                      total: 6.94,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );

    const res = await worker.fetch(
      makeScanRequest({
        model: 'gemini-3.6-flash',
        imageBase64: VALID_BASE64,
        mimeType: 'image/png',
        thinkingLevel: 'minimal',
      }),
      { GEMINI_API_KEY: 'test-key' },
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.data.place, 'Cafe Luna');
    assert.equal(json.data.tip, 1);
  });

  it('handles finishReason errors and upstream HTTP failures cleanly without leaking secrets', async () => {
    // MAX_TOKENS
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"place":' }] } }],
        }),
        { status: 200 },
      );
    let res = await worker.fetch(
      makeScanRequest({ model: 'gemini-3.5-flash-lite', imageBase64: VALID_BASE64, mimeType: 'image/jpeg' }),
      { GEMINI_API_KEY: 'AIzaSyFakeKey12345678901234567890' },
    );
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'UPSTREAM_TRUNCATED');

    // SAFETY
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
        }),
        { status: 200 },
      );
    res = await worker.fetch(
      makeScanRequest({ model: 'gemini-3.5-flash-lite', imageBase64: VALID_BASE64, mimeType: 'image/jpeg' }),
      { GEMINI_API_KEY: 'AIzaSyFakeKey12345678901234567890' },
    );
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'UPSTREAM_BLOCKED');

    // Upstream 429
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'Resource exhausted' } }), { status: 429 });
    res = await worker.fetch(
      makeScanRequest({ model: 'gemini-3.5-flash-lite', imageBase64: VALID_BASE64, mimeType: 'image/jpeg' }),
      { GEMINI_API_KEY: 'AIzaSyFakeKey12345678901234567890' },
    );
    assert.equal(res.status, 429);
    assert.equal((await res.json()).code, 'UPSTREAM_RATE_LIMITED');

    // Upstream 403 auth error should never leak key
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: { message: 'API key AIzaSyFakeKey12345678901234567890 invalid' } }),
        { status: 403 },
      );
    res = await worker.fetch(
      makeScanRequest({ model: 'gemini-3.5-flash-lite', imageBase64: VALID_BASE64, mimeType: 'image/jpeg' }),
      { GEMINI_API_KEY: 'AIzaSyFakeKey12345678901234567890' },
    );
    assert.equal(res.status, 502);
    const authErr = await res.json();
    assert.equal(authErr.code, 'UPSTREAM_AUTH_ERROR');
    assert.equal(authErr.error.includes('AIza'), false);
  });

  it('enforces per-IP burst rate limiting with 429 and Retry-After', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      place: 'Shop',
                      date: '',
                      items: [],
                      subtotal: null,
                      tax: null,
                      fees: null,
                      tip: null,
                      total: null,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );

    const env = { GEMINI_API_KEY: 'test-key', RATE_LIMIT_BURST: '2', RATE_LIMIT_HOURLY: '10' };
    const payload = {
      model: 'gemini-3.5-flash-lite',
      imageBase64: VALID_BASE64,
      mimeType: 'image/jpeg',
      thinkingLevel: 'minimal',
    };

    assert.equal((await worker.fetch(makeScanRequest(payload, { ip: '198.51.100.1' }), env)).status, 200);
    assert.equal((await worker.fetch(makeScanRequest(payload, { ip: '198.51.100.1' }), env)).status, 200);

    const limited = await worker.fetch(makeScanRequest(payload, { ip: '198.51.100.1' }), env);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) >= 1);
    assert.equal((await limited.json()).code, 'RATE_LIMITED');

    // Different IP is unaffected
    const otherIp = await worker.fetch(makeScanRequest(payload, { ip: '198.51.100.2' }), env);
    assert.equal(otherIp.status, 200);
  });
});
