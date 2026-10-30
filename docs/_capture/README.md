# docs/_capture

Dev helpers. Nothing in this directory ships — `package.json` `files` only picks
up `lib/`, `server/`, `cordis.patch.yml`, `README.md`, `LICENSE` and
`docs/assets/`.

| file | what it is |
| --- | --- |
| `render_shots.py` | Renders the three PNGs in `../assets/` with PIL. Inputs are real captured text (a `dsh --dump-config` tail and a real `probe2.mjs` run), not mock-ups. Private IPv4 literals are masked to `***.***.*.***` at render time (same length, so the layout is unchanged); pass `redact_ips=False` for an unredacted local copy. |
| `smoke.mjs` | One-shot MCP stdio client: `tools/list`, then `check_http` on the `dsh` target. Run it inside the dsh container from `/workspace/home-monitor/server` (or any dir where `@modelcontextprotocol/sdk` resolves). |

Both assume the repo is bind-mounted at `/workspace/home-monitor` inside the
container. The README smoke test (`## Standalone MCP server → One smoke test, no
client needed`) needs neither file — it pipes raw JSON-RPC into `node index.js`.
