// src/tools/builtins/mcp.js
// MCP client tools (stdio) exposed to the planner.

import crypto from "crypto";

import { toolRegistry, ToolRisk } from "../registry.js";
import { loadMcpConfig, listMcpTools, callMcpTool } from "../../mcp/client.js";

function safeObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function clampInt(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(x)));
}

function classifyMcpCall({ server, tool, input }) {
  // Policy layer for step (2): decide whether a call should be approval-gated.
  // Keep this conservative.

  // Filesystem write tools are side effects.
  if (String(server) === "local-fs" && /^fs_write_/i.test(String(tool))) {
    return { risk: ToolRisk.EXTERNAL_SIDE_EFFECT, reason: "Filesystem write" };
  }

  // Large web searches should be approval-gated.
  if (String(server) === "local-web" && String(tool) === "web_search") {
    const maxResults = clampInt(input?.maxResults, 1, 25, 5);
    if (maxResults > 10) {
      return {
        risk: ToolRisk.EXTERNAL_SIDE_EFFECT,
        reason: `Large web search (maxResults=${maxResults})`,
      };
    }
  }

  return { risk: ToolRisk.READ_ONLY, reason: "Read-only" };
}

toolRegistry.register({
  id: "mcp.list_servers",
  description: "List configured local MCP servers (stdio).",
  risk: ToolRisk.READ_ONLY,
  handler: async () => {
    const { cfgPath, servers } = loadMcpConfig();
    return {
      configPath: cfgPath,
      servers: servers.map((s) => ({
        name: s.name,
        command: s.command,
        args: Array.isArray(s.args) ? s.args : [],
        notes: s.notes || "",
      })),
    };
  },
});

toolRegistry.register({
  id: "mcp.list_tools",
  description: "List tools exposed by a given MCP server.",
  risk: ToolRisk.READ_ONLY,
  inputSchema: (args) => {
    const server = String(args?.server || "").trim();
    if (!server) return { ok: false, error: "Missing server" };
    return { ok: true, value: { server } };
  },
  handler: async ({ server }) => {
    return await listMcpTools(server);
  },
});

toolRegistry.register({
  id: "mcp.call_tool",
  description:
    "Call an MCP tool on a local server. Read-only calls execute immediately; side-effect/large calls return a proposal for approval.",
  risk: ToolRisk.READ_ONLY,
  inputSchema: (args) => {
    const server = String(args?.server || "").trim();
    const tool = String(args?.tool || "").trim();
    const input = safeObj(args?.input);
    if (!server) return { ok: false, error: "Missing server" };
    if (!tool) return { ok: false, error: "Missing tool" };
    return { ok: true, value: { server, tool, input } };
  },
  handler: async ({ server, tool, input }) => {
    const decision = classifyMcpCall({ server, tool, input });
    if (decision.risk !== ToolRisk.READ_ONLY) {
      return {
        ok: false,
        requiresApproval: true,
        reason: decision.reason,
        proposal: {
          id: crypto.randomUUID(),
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          type: "mcp_call_tool",
          title: `MCP: ${server}.${tool}`,
          reason: decision.reason,
          payload: { server, tool, input },
          meta: {
            preview: {
              kind: "tool_call",
              tool: "mcp.call_tool",
              server,
              name: tool,
              input,
            },
          },
          summary: { type: "mcp_call_tool", title: `MCP: ${server}.${tool}` },
        },
      };
    }

    const result = await callMcpTool(server, tool, input);
    return { ok: true, requiresApproval: false, result };
  },
});
