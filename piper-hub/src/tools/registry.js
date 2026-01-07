// src/tools/registry.js
/**
 * Minimal MCP-style tool registry.
 * Tools are callable functions with a risk level and a small, predictable IO shape.
 *
 * Risk levels:
 * - read_only: safe to run automatically (no side effects beyond reading)
 * - proposes_actions: may return ops to be approved (not used in Phase 1)
 * - external_side_effect: must never be auto-run; should be compiled into approval-gated actions
 */

export const ToolRisk = Object.freeze({
  READ_ONLY: "read_only",
  PROPOSES_ACTIONS: "proposes_actions",
  EXTERNAL_SIDE_EFFECT: "external_side_effect",
});

function safeString(x, max = 4000) {
  const s = typeof x === "string" ? x : JSON.stringify(x ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `...(+${s.length - max} chars)`;
}

function defaultValidateArgs(args) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "args must be an object" };
  }
  return { ok: true };
}

export class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  register(tool) {
    const t = tool || {};
    if (!t.id || typeof t.id !== "string") throw new Error("tool.id required");
    if (this._tools.has(t.id)) throw new Error(`tool already registered: ${t.id}`);
    if (!t.description) t.description = "";
    if (!Object.values(ToolRisk).includes(t.risk)) {
      throw new Error(`invalid tool risk for ${t.id}: ${t.risk}`);
    }
    if (typeof t.handler !== "function") throw new Error(`tool.handler must be function: ${t.id}`);
    if (typeof t.validateArgs !== "function") t.validateArgs = defaultValidateArgs;

    this._tools.set(t.id, t);
  }

  get(id) {
    return this._tools.get(id);
  }

  list() {
    return Array.from(this._tools.values()).map((t) => ({
      id: t.id,
      description: t.description || "",
      risk: t.risk,
    }));
  }

  async run({ id, args, context }) {
    const t = this.get(id);
    if (!t) return { ok: false, error: `Unknown tool: ${id}` };

    const v = t.validateArgs(args);
    if (!v?.ok) return { ok: false, error: v?.error || "Invalid args" };

    try {
      const result = await t.handler({ args: args || {}, context: context || {} });
      return {
        ok: true,
        result,
        resultSummary: safeString(result, 12000),
      };
    } catch (e) {
      return {
        ok: false,
        error: String(e?.message || e),
      };
    }
  }
}

// singleton
export const toolRegistry = new ToolRegistry();
