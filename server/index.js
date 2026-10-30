import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { checkHttpMany } from './monitors/http.js';
import { checkTcpMany } from './monitors/tcp.js';
import { checkSslMany } from './monitors/ssl.js';
import { checkDocker } from './monitors/docker.js';

const CONFIG_URL = new URL('./config.json', import.meta.url);

let config = {};
try {
  config = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
} catch (err) {
  process.stderr.write('home-monitor: failed to read config.json: ' + err.message + '\n');
  config = {};
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

function selectTargets(group, name) {
  const all = targetsOf(group);
  if (typeof name !== 'string' || name.length === 0) return { targets: all, unknown: null };
  const hit = all.filter((t) => t.name === name);
  if (hit.length === 0) return { targets: [], unknown: name };
  return { targets: hit, unknown: null };
}

function summarize(results) {
  if (!Array.isArray(results)) return { ok: false, error: 'internal: results is not an array' };
  const failed = results.filter((r) => !r || r.ok !== true).map((r) => (r && r.name) || 'unknown');
  return {
    ok: results.length > 0 && failed.length === 0,
    checked: results.length,
    failed,
    results,
  };
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function unknownTarget(tool, name, group) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { ok: false, error: 'unknown target "' + name + '" for ' + tool, known: namesOf(group) },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

async function toolHttp(args) {
  const { targets, unknown } = selectTargets(httpGroup, args && args.target);
  if (unknown) return unknownTarget('check_http', unknown, httpGroup);
  const results = await checkHttpMany(targets, { timeoutMs: httpGroup.timeoutMs });
  return textResult(summarize(results));
}

async function toolTcp(args) {
  const { targets, unknown } = selectTargets(tcpGroup, args && args.target);
  if (unknown) return unknownTarget('check_tcp', unknown, tcpGroup);
  const results = await checkTcpMany(targets, { timeoutMs: tcpGroup.timeoutMs });
  return textResult(summarize(results));
}

async function toolSsl(args) {
  const { targets, unknown } = selectTargets(sslGroup, args && args.target);
  if (unknown) return unknownTarget('check_ssl', unknown, sslGroup);
  const results = await checkSslMany(targets, {
    timeoutMs: sslGroup.timeoutMs,
    warnDays: sslGroup.warnDays,
  });
  return textResult(summarize(results));
}

async function toolDocker() {
  const result = await checkDocker(dockerGroup);
  return textResult(result);
}

async function toolStatus() {
  return textResult({
    ok: true,
    version: '0.1.0',
    config: CONFIG_URL.pathname,
    http: namesOf(httpGroup),
    tcp: namesOf(tcpGroup),
    ssl: namesOf(sslGroup),
    docker: { enabled: dockerGroup.enabled === true, socket: dockerGroup.socket || '/var/run/docker.sock' },
  });
}

const TARGET_SCHEMA = (what) => ({
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description: 'Name of a single ' + what + ' target from config.json. Omit to check every configured target.',
    },
  },
  additionalProperties: false,
});

const TOOLS = [
  {
    name: 'check_http',
    description:
      'Check that configured HTTP endpoints are reachable and answer with an expected status code. Read-only: it only issues GET requests to the targets listed in config.json.',
    inputSchema: TARGET_SCHEMA('HTTP'),
    handler: toolHttp,
  },
  {
    name: 'check_tcp',
    description:
      'Check that TCP ports on configured hosts accept connections (useful for SSH, databases, or any service without an HTTP endpoint). Read-only: it only opens and immediately closes a socket.',
    inputSchema: TARGET_SCHEMA('TCP'),
    handler: toolTcp,
  },
  {
    name: 'check_ssl',
    description:
      'Check TLS certificates for configured hosts: expiry date, days left, issuer and whether the chain is trusted. Reports a problem when a certificate expires within warnDays.',
    inputSchema: TARGET_SCHEMA('TLS'),
    handler: toolSsl,
  },
  {
    name: 'check_docker',
    description:
      'Report Docker engine reachability and per-container state over the local Docker socket. Requires docker.enabled=true in config.json; otherwise it returns status "unavailable" instead of failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolDocker,
  },
  {
    name: 'monitor_status',
    description:
      'List which monitoring targets this server knows about (HTTP, TCP, TLS names) and whether Docker checks are enabled. Use it when a target name is unknown.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolStatus,
  },
];

const server = new Server(
  { name: 'home-monitor', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params && req.params.name;
  const args = (req.params && req.params.arguments) || {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unknown tool "' + name + '"' }, null, 2) }],
      isError: true,
    };
  }
  try {
    return await tool.handler(args);
  } catch (err) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: false, error: String((err && err.message) || err) }, null, 2) },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
