// src/tools/builtins/system.js
import os from "os";
import { toolRegistry, ToolRisk } from "../registry.js";

toolRegistry.register({
  id: "system.info",
  description: "Basic system info (platform, arch, cpu count).",
  risk: ToolRisk.READ_ONLY,
  handler: async () => {
    return {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus()?.length || 0,
      hostname: os.hostname(),
    };
  },
});

export function registerSystemTools() {
  return true;
}
