import tls from 'node:tls';

const DAY = 86400000;

function parseDate(value) {
  if (!value || value === 'Never') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function checkSsl(target, defaults = {}) {
  const timeoutMs = Number(target.timeoutMs ?? defaults.timeoutMs ?? 10000);
  const warnDays = Number(target.warnDays ?? defaults.warnDays ?? 21);
  const host = target.host;
  const port = Number(target.port ?? 443);

  return new Promise((resolve) => {
    if (!host) {
      resolve({ ok: false, name: target.name ?? null, host: null, port, error: 'host is required' });
      return;
    }

    const started = performance.now();
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, ms: Math.round(performance.now() - started) });
    };

    const socket = tls.connect(
      {
        host,
        port,
        servername: target.servername || (host.includes(':') ? undefined : host),
        rejectUnauthorized: false, // we report trust instead of refusing to look
        timeout: timeoutMs,
      },
      () => {
        const peer = socket.getPeerCertificate() || {};
        const now = Date.now();
        const validFrom = parseDate(peer.valid_from);
        const validTo = parseDate(peer.valid_to);
        const daysLeft = validTo === null ? null : Math.floor((validTo - now) / DAY);
        const authorized = socket.authorized === true;
        const allowSelfSigned = target.allowSelfSigned === true;

        const problems = [];
        if (authorized !== true) {
          if (!allowSelfSigned) problems.push('certificate not trusted: ' + (socket.authorizationError || 'unknown'));
        }
        if (daysLeft !== null && warnDays > 0 && daysLeft < warnDays) problems.push('expires in ' + daysLeft + ' day(s), warn threshold ' + warnDays);
        if (daysLeft !== null && daysLeft < 0) problems.push('certificate expired ' + Math.abs(daysLeft) + ' day(s) ago');

        const out = {
          ok: problems.length === 0,
          name: target.name ?? null,
          host,
          port,
          protocol: socket.getProtocol() || null,
          authorized,
          authorizationError: socket.authorizationError || null,
          selfSignedAllowed: allowSelfSigned,
          subject: peer.subject ? peer.subject.CN || null : null,
          issuer: peer.issuer ? peer.issuer.O || peer.issuer.CN || null : null,
          validFrom: peer.valid_from || null,
          validTo: peer.valid_to || null,
          daysLeft,
          warnDays,
          serialNumber: peer.serialNumber || null,
          fingerprint256: peer.fingerprint256 || null,
          alpn: socket.alpnProtocol || null,
          problems,
        };
        socket.end();
        finish(out);
      }
    );

    socket.once('timeout', () => {
      socket.destroy();
      finish({ ok: false, name: target.name ?? null, host, port, error: 'timeout after ' + timeoutMs + 'ms' });
    });
    socket.once('error', (err) => {
      const code = err && err.code ? err.code + ': ' : '';
      finish({ ok: false, name: target.name ?? null, host, port, error: code + (err && err.message ? err.message : String(err)) });
    });
  });
}

export async function checkSslMany(targets, defaults = {}) {
  return Promise.all(targets.map((t) => checkSsl(t, defaults)));
}
