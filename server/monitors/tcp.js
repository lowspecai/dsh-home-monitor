import net from 'node:net';

export function checkTcp(target, defaults = {}) {
  const timeoutMs = Number(target.timeoutMs ?? defaults.timeoutMs ?? 5000);
  const host = target.host;
  const port = Number(target.port);

  return new Promise((resolve) => {
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve({ ok: false, name: target.name ?? null, host: host ?? null, port: Number.isFinite(port) ? port : null, error: 'host and port are required' });
      return;
    }

    const started = performance.now();
    let settled = false;
    const socket = new net.Socket();
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...payload, ms: Math.round(performance.now() - started) });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, name: target.name ?? null, host, port, localPort: socket.localPort ?? null }));
    socket.once('timeout', () => finish({ ok: false, name: target.name ?? null, host, port, error: 'timeout after ' + timeoutMs + 'ms' }));
    socket.once('error', (err) => {
      const code = err && err.code ? err.code + ': ' : '';
      finish({ ok: false, name: target.name ?? null, host, port, error: code + (err && err.message ? err.message : String(err)) });
    });
    socket.connect({ host, port });
  });
}

export async function checkTcpMany(targets, defaults = {}) {
  return Promise.all(targets.map((t) => checkTcp(t, defaults)));
}
