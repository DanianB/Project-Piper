import fs from "fs";
import { APPS_FILE } from "../config/paths.js";

export function loadApps() {
  try {
    if (!fs.existsSync(APPS_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(APPS_FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
