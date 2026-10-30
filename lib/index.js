import { readFileSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { checkHttpMany } from '../server/monitors/http.js';
import { checkTcpMany } from '../server/monitors/tcp.js';
import { checkSslMany } from '../server/monitors/ssl.js';
import { checkDocker } from '../server/monitors/docker.js';

export const name = 'home-monitor';
export const inject = ['tools'];

const CONFIG_URL = new URL('../server/config.json', import.meta.url);
const HARD_TIMEOUT_MS = 20000;

let config = {};
try {
  config = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
} catch (err) {
  process.stderr.write('home-monitor: failed to read ' + CONFIG_URL.pathname + ': ' + err.message + '\n');
}

const httpGroup = config.http || {};
const tcpGroup = config.tcp || {};
const sslGroup = config.ssl || {};
const dockerGroup = config.docker || {};

function targetsOf(group) {
  return Array.isArray(group.targets) ? group.targets.filter((t) => t && typeof t === 'object') : [];
}

function namesOf(group) {
  return targetsOf(group)
    .map((t) => t.name)
    .filter((n) => typeof n === 'string' && n.length > 0);
}

function selectTargets(group, targetName) {
  const all = targetsOf(group);
  if (typeof targetName !== 'string' || targetName.length === 0) return { targets: all, unknown: null };
  const hit = all.filter((t) => t.name === targetName);
  if (hit.length === 0) return { targets: [], unknown: targetName };
  return { targets: hit, unknown: null };
}

function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => !r || r.ok !== true).map((r) => (r && r.name) || 'unknown');
  return { ok: list.length > 0 && failed.length === 0, checked: list.length, failed, results: list };
}

function unknownTarget(tool, targetName, group) {
  return { ok: false, error: 'unknown target "' + targetName + '" for ' + tool, known: namesOf(group) };
}

function withDeadline(signal) {
  if (!signal) return AbortSignal.timeout(HARD_TIMEOUT_MS);
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, AbortSignal.timeout(HARD_TIMEOUT_MS)]);
  }
  return signal;
}

async function runGuarded(signal, run) {
  const effective = withDeadline(signal);
  if (effective.aborted) return { ok: false, error: 'aborted before start' };
  let onAbort = null;
  const abortPromise = new Promise((resolve) => {
    onAbort = () => resolve({ ok: false, error: 'aborted after ' + HARD_TIMEOUT_MS + 'ms' });
    effective.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([run(), abortPromise]);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (onAbort) effective.removeEventListener('abort', onAbort);
  }
}

const TARGET_PARAMS = (what) => ({
  target: {
    type: 'string',
    description:
      'Name of one ' + what + ' target from config.json. Leave it out to check every configured ' + what + ' target.',
  },
});

function targetTool(toolName, what, group, describe, run) {
  return defineTool({
    name: toolName,
    description: describe,
    parameters: TARGET_PARAMS(what),
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const targetName = args && args.target;
      const picked = selectTargets(group, targetName);
      if (picked.unknown) return unknownTarget(toolName, picked.unknown, group);
      if (picked.targets.length === 0) {
        return { ok: false, error: 'no ' + what + ' targets configured in config.json' };
      }
      return runGuarded(exec && exec.signal, async () => {
        const results = await run(picked.targets);
        return summarize(results);
      });
    },
  });
}

const httpTool = targetTool(
  'monitor_http',
  'HTTP',
  httpGroup,
  'Check that the self-hosted HTTP services listed in config.json answer with an expected status code. Read-only: sends GET requests only.',
  (targets) => checkHttpMany(targets, { timeoutMs: httpGroup.timeoutMs })
);

const tcpTool = targetTool(
  'monitor_tcp',
  'TCP',
  tcpGroup,
  'Check that TCP ports on the hosts listed in config.json accept connections (SSH, databases, anything without an HTTP endpoint). Read-only: opens a socket and closes it immediately.',
  (targets) => checkTcpMany(targets, { timeoutMs: tcpGroup.timeoutMs })
);

const sslTool = targetTool(
  'monitor_ssl',
  'TLS',
  sslGroup,
  'Check TLS certificates for the hosts listed in config.json: expiry, days left, issuer and chain trust. Reports a problem when a certificate expires within its warnDays window.',
  (targets) => checkSslMany(targets, { timeoutMs: sslGroup.timeoutMs, warnDays: sslGroup.warnDays })
);

const dockerTool = defineTool({
  name: 'monitor_docker',
  description:
    'Report Docker engine reachability and per-container state through the local Docker socket. Only works when docker.enabled is true in config.json; otherwise it reports status "unavailable".',
  parameters: {},
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(_args, exec) {
    return runGuarded(exec && exec.signal, () => checkDocker(dockerGroup));
  },
});

const statusTool = defineTool({
  name: 'monitor_targets',
  description:
    'List the monitoring targets this plugin knows about (HTTP, TCP and TLS names from config.json) and whether Docker checks are enabled. Use it when a target name is rejected as unknown.',
  parameters: {},
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  execute() {
    return Promise.resolve({
      ok: true,
      config: CONFIG_URL.pathname,
      http: namesOf(httpGroup),
      tcp: namesOf(tcpGroup),
      ssl: namesOf(sslGroup),
      docker: {
        enabled: dockerGroup.enabled === true,
        socket: dockerGroup.socket || '/var/run/docker.sock',
        expectRunning: Array.isArray(dockerGroup.expectRunning) ? dockerGroup.expectRunning : [],
      },
    });
  },
});

export function apply(ctx) {
  for (const tool of [httpTool, tcpTool, sslTool, dockerTool, statusTool]) {
    ctx.tools.register(tool);
  }
}
