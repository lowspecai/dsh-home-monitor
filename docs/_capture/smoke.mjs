// One-shot MCP smoke client: lists tools, then calls check_http on the "dsh" target.
// Run from inside the dsh container. A dev helper — not part of the shipped package.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["/workspace/home-monitor/server/index.js"],
  cwd: "/workspace/home-monitor",
  stderr: "ignore",
  env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const list = await client.listTools();
console.log("--- listTools ---");
console.log("count: " + list.tools.length);
for (const t of list.tools) console.log("  " + t.name);
console.log("names: " + list.tools.map((t) => t.name).join(", "));

console.log("--- callTool check_http {target:'dsh'} ---");
const res = await client.callTool({ name: "check_http", arguments: { target: "dsh" } });
console.log(JSON.stringify(res.structuredContent ?? res.content, null, 2));

await client.close();
process.exit(0);
