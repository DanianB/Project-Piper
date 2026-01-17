// src/mcp/client.js
// Local MCP (stdio) client manager.

import fs from "fs";
import path from "path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_CFG = path.join(process.cwd(), "data", "mcp_servers.json");

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function safeObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

export function loadMcpConfig() {
  const cfgPath = process.env.MCP_CONFIG || DEFAULT_CFG;
  const cfg = readJson(cfgPath) || {};
  const servers = safeArr(cfg.servers).filter((s) => s && s.name && s.command);
  return { cfgPath, servers };
}

const _clients = new Map();

export async function getMcpClient(serverName) {
  const { servers } = loadMcpConfig();
  const server = servers.find((s) => s.name === serverName);
  if (!server) throw new Error(`Unknown MCP server: ${serverName}`);

  if (_clients.has(serverName)) return _clients.get(serverName);

  const transport = new StdioClientTransport({
    command: server.command,
    args: safeArr(server.args),
    env: safeObj(server.env),
  });

  const client = new Client({ name: "piper-hub", version: "1.0.0" });
  await client.connect(transport);

  const entry = { client, transport, server };
  _clients.set(serverName, entry);
  return entry;
}

export async function listMcpTools(serverName) {
  const { client } = await getMcpClient(serverName);
  return await client.listTools();
}

export async function callMcpTool(serverName, toolName, input) {
  const { client } = await getMcpClient(serverName);
  return await client.callTool({ name: toolName, arguments: safeObj(input) });
}

