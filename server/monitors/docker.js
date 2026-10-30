import http from 'node:http';

function dockerGet(socketPath, path, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    let req;
    try {
      req = http.request(
        { socketPath, path, method: 'GET', headers: { host: 'docker' }, timeout: timeoutMs },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < 4 * 1024 * 1024) body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              done({ error: 'HTTP ' + res.statusCode + ' on ' + path + ': ' + body.slice(0, 200) });
              return;
            }
            try {
              done({ json: JSON.parse(body) });
            } catch (e) {
              done({ error: 'invalid JSON from ' + path });
            }
          });
          res.on('error', (err) => done({ error: 'response error: ' + err.message }));
        }
      );
    } catch (err) {
      done({ error: (err.code ? err.code + ': ' : '') + err.message });
      return;
    }
    req.on('timeout', () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
    req.on('error', (err) => done({ error: (err.code ? err.code + ': ' : '') + err.message }));
    req.end();
  });
}

export async function checkDocker(dockerConfig = {}) {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);

  if (dockerConfig.enabled !== true) {
    return { ok: true, status: 'unavailable', reason: 'docker checks disabled in config (set docker.enabled=true to enable)', ms: ms() };
  }

  const socketPath = dockerConfig.socket || '/var/run/docker.sock';
  const timeoutMs = Number(dockerConfig.timeoutMs ?? 5000);
  const expectRunning = Array.isArray(dockerConfig.expectRunning) ? dockerConfig.expectRunning.slice() : [];

  const ping = await dockerGet(socketPath, '/_ping', timeoutMs);
  if (ping.error) {
    return { ok: false, status: 'unreachable', socket: socketPath, error: ping.error, ms: ms() };
  }

  const version = await dockerGet(socketPath, '/version', timeoutMs);
  const list = await dockerGet(socketPath, '/containers/json?all=true', timeoutMs);
  if (list.error) {
    return { ok: false, status: 'error', socket: socketPath, error: list.error, ms: ms() };
  }

  const containers = Array.isArray(list.json) ? list.json : [];
  const rows = containers.map((c) => {
    const names = Array.isArray(c.Names) ? c.Names.map((n) => String(n).replace(/^\//, '')) : [];
    const name = names[0] || (c.Id ? String(c.Id).slice(0, 12) : 'unknown');
    return {
      name,
      names,
      image: c.Image || null,
      state: c.State || null,
      status: c.Status || null,
    };
  });

  const running = rows.filter((r) => r.state === 'running').map((r) => r.name);
  const stopped = rows.filter((r) => r.state !== 'running');

  const problems = [];
  for (const wanted of expectRunning) {
    const found = rows.find((r) => r.names.includes(wanted));
    if (!found) {
      problems.push('container "' + wanted + '" not found');
    } else if (found.state !== 'running') {
      problems.push('container "' + wanted + '" is ' + found.state + ' (' + (found.status || 'no status') + ')');
    }
  }

  return {
    ok: problems.length === 0,
    status: 'ok',
    socket: socketPath,
    engineVersion: version.json && version.json.Version ? version.json.Version : null,
    apiVersion: version.json && version.json.ApiVersion ? version.json.ApiVersion : null,
    total: rows.length,
    running: running.length,
    expectRunning,
    stopped: stopped.map((r) => ({ name: r.name, state: r.state, status: r.status })),
    containers: rows,
    problems,
    ms: ms(),
  };
}
