// src/tools/mcp/register.js
import fs from "fs";
import path from "path";
import { toolRegistry, ToolRisk } from "../registry.js";

// MCP SDK (stdio client)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_CFG = path.join(process.cwd(), "data", "mcp_servers.json");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function normalizeRisk(risk) {
  if (risk === ToolRisk.EXTERNAL_SIDE_EFFECT)
    return ToolRisk.EXTERNAL_SIDE_EFFECT;
  return ToolRisk.READ_ONLY;
}

// Cache clients per server name (connect on demand)
const _clients = new Map();

async function getClientFor(server) {
  const key = server.name;
  if (_clients.has(key)) return _clients.get(key);

  const transport = new StdioClientTransport({
    command: server.command,
    args: safeArr(server.args),
    env: safeObj(server.env),
  });

  const client = new Client({
    name: "piper-hub",
    version: "1.0.0",
  });

  await client.connect(transport);
  _clients.set(key, { client, transport, server });
  return _clients.get(key);
}

function loadServers() {
  const cfgPath = process.env.MCP_CONFIG || DEFAULT_CFG;
  const cfg = readJson(cfgPath) || {};
  const servers = safeArr(cfg.servers).filter((s) => s && s.name && s.command);
  return { cfgPath, servers };
}

// Tool: list servers
toolRegistry.register({
  id: "mcp.list_servers",
  description: "List configured MCP servers (stdio).",
  risk: ToolRisk.READ_ONLY,
  handler: async () => {
    const { cfgPath, servers } = loadServers();
    return {
      configPath: cfgPath,
      servers: servers.map((s) => ({
        name: s.name,
        command: s.command,
        args: safeArr(s.args),
        risk: normalizeRisk(s.risk),
      })),
    };
  },
});

// Tool: list tools on a server
toolRegistry.register({
  id: "mcp.list_tools",
  description: "List tools exposed by a specific MCP server.",
  risk: ToolRisk.READ_ONLY,
  validateArgs: (args) => {
    if (!args || typeof args !== "object")
      return { ok: false, error: "args must be an object" };
    if (!args.server || typeof args.server !== "string")
      return { ok: false, error: "args.server (string) required" };
    return { ok: true };
  },
  handler: async ({ args }) => {
    const { servers } = loadServers();
    const server = servers.find((s) => s.name === args.server);
    if (!server) throw new Error(`Unknown MCP server: ${args.server}`);

    const { client } = await getClientFor(server);
    const out = await client.listTools();
    return out;
  },
});

// Tool: call tool on a server (read-only by default; you can enforce approvals later)
toolRegistry.register({
  id: "mcp.call_tool",
  description: "Call a tool on an MCP server (stdio).",
  risk: ToolRisk.READ_ONLY,
  validateArgs: (args) => {
    if (!args || typeof args !== "object")
      return { ok: false, error: "args must be an object" };
    if (!args.server || typeof args.server !== "string")
      return { ok: false, error: "args.server (string) required" };
    if (!args.tool || typeof args.tool !== "string")
      return { ok: false, error: "args.tool (string) required" };
    if (
      args.input != null &&
      (typeof args.input !== "object" || Array.isArray(args.input))
    )
      return { ok: false, error: "args.input must be an object if provided" };
    return { ok: true };
  },
  handler: async ({ args }) => {
    const { servers } = loadServers();
    const server = servers.find((s) => s.name === args.server);
    if (!server) throw new Error(`Unknown MCP server: ${args.server}`);

    const { client } = await getClientFor(server);
    const result = await client.callTool({
      name: args.tool,
      arguments: args.input || {},
    });
    return result;
  },
});
