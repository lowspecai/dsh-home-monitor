import http from 'node:http';
import https from 'node:https';

const MAX_BODY_BYTES = 65536;

function normalizeExpect(value) {
  if (value === undefined || value === null) return [200];
  if (Array.isArray(value)) return value.length ? value.map(Number) : [200];
  return [Number(value)];
}

function one(target, timeoutMs) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(target.url);
    } catch {
      resolve({ error: 'invalid url: ' + String(target.url) });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve({ error: 'unsupported protocol: ' + parsed.protocol });
      return;
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const started = performance.now();
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, ms: Math.round(performance.now() - started) });
    };

    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: target.method || 'GET',
        headers: { 'user-agent': 'home-monitor/0.1', accept: '*/*' },
        // We measure reachability, not trust. Trust is reported separately.
        rejectUnauthorized: false,
      },
      (res) => {
        let bytes = 0;
        const socket = res.socket || {};
        const tlsAuthorized = typeof socket.authorized === 'boolean' ? socket.authorized : null;
        const base = {
          status: res.statusCode,
          location: res.headers.location || null,
          contentType: res.headers['content-type'] || null,
          server: res.headers.server || null,
          tlsAuthorized,
        };
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            finish({ ...base, bytes, truncated: true });
            res.destroy();
          }
        });
        res.on('end', () => finish({ ...base, bytes, truncated: false }));
        res.on('close', () => finish({ ...base, bytes, truncated: true }));
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
    req.on('error', (err) => {
      const code = err && err.code ? err.code + ': ' : '';
      finish({ error: code + (err && err.message ? err.message : String(err)) });
    });
    req.end();
  });
}

export async function checkHttp(target, defaults = {}) {
  const timeoutMs = Number(target.timeoutMs ?? defaults.timeoutMs ?? 8000);
  const expect = normalizeExpect(target.expect ?? defaults.expect);
  const res = await one(target, timeoutMs);

  if (res.error) {
    return { ok: false, name: target.name ?? null, url: target.url, expected: expect, error: res.error, ms: res.ms ?? null };
  }
  const ok = expect.includes(Number(res.status));
  return {
    ok,
    name: target.name ?? null,
    url: target.url,
    expected: expect,
    status: res.status,
    ms: res.ms,
    bytes: res.bytes,
    truncated: res.truncated,
    contentType: res.contentType,
    server: res.server,
    location: res.location,
    tlsAuthorized: res.tlsAuthorized,
  };
}

export async function checkHttpMany(targets, defaults = {}) {
  const results = await Promise.all(targets.map((t) => checkHttp(t, defaults)));
  return results;
}
