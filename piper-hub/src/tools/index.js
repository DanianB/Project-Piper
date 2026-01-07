// src/tools/index.js
import { toolRegistry } from "./registry.js";
import "./builtins/repo.js";
import "./builtins/system.js";

export function listTools() {
  return toolRegistry.list();
}
