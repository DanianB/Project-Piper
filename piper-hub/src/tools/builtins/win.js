// src/tools/builtins/win.js
// Windows discovery helpers (read-only).
// Tool: win.findApp
// Finds likely executable paths for an app name using:
// - Start Menu .lnk resolution (PowerShell WScript.Shell)
// - Shallow scans of common install directories
//
// Returns: { query, results: [{ path, title, source, score }] }

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { toolRegistry, ToolRisk } from "../registry.js";

function clampInt(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(x)));
}

function isWindows() {
  return process.platform === "win32";
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreCandidate(appNorm, title, p, source) {
  const t = norm(title);
  const pn = norm(p);
  let score = 0;
  if (t.includes(appNorm)) score += 5;
  if (pn.includes(appNorm)) score += 3;
  if (/(program files)/i.test(p)) score += 2;
  if (/(appdata\\local\\programs)/i.test(p)) score += 2;
  if (/(windowsapps)/i.test(p)) score += 1;
  if (source === "start_menu_lnk") score += 4;
  if (/uninstall|setup|installer|update/i.test(p)) score -= 6;
  if (/helper|crash|launcher/i.test(p)) score -= 1;
  return score;
}

function walkFilesShallow(rootDir, { maxFiles = 2500, maxDepth = 4 } = {}) {
  const out = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: p, depth: depth + 1 });
      } else if (ent.isFile()) {
        out.push(p);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

function runPowershellJson(psScript, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const to = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error("PowerShell timeout"));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf-8")));
    child.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`PowerShell failed (${code}): ${stderr.trim()}`));
      }
      try {
        const txt = stdout.trim();
        resolve(txt ? JSON.parse(txt) : []);
      } catch (e) {
        reject(new Error(`PowerShell JSON parse failed: ${e?.message || e}`));
      }
    });
  });
}

async function findStartMenuLinks(appName, maxResults) {
  const appNorm = norm(appName);
  const ps = `
$ErrorActionPreference = "SilentlyContinue"
$paths = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"
)
$links = @()
foreach ($p in $paths) {
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Recurse -Filter *.lnk | ForEach-Object {
      $links += $_.FullName
    }
  }
}
$wsh = New-Object -ComObject WScript.Shell
$out = @()
foreach ($lnk in $links) {
  $n = [IO.Path]::GetFileNameWithoutExtension($lnk)
  if ($n -match "${appName.replace(/"/g,'`"')}") {
    $sc = $wsh.CreateShortcut($lnk)
    if ($sc.TargetPath) {
      $out += [pscustomobject]@{
        title = $n
        path = $sc.TargetPath
        source = "start_menu_lnk"
      }
    }
  }
}
$out | Select-Object -First ${maxResults} | ConvertTo-Json -Depth 3
`;
  try {
    const arr = await runPowershellJson(ps, 20000);
    return Array.isArray(arr) ? arr : (arr ? [arr] : []);
  } catch {
    // Fallback: no results
    return [];
  }
}

async function findExeByScan(appName, maxResults) {
  const appNorm = norm(appName);
  const roots = [];
  const env = process.env;
  if (env.ProgramFiles) roots.push(env.ProgramFiles);
  if (env["ProgramFiles(x86)"]) roots.push(env["ProgramFiles(x86)"]);
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "Programs"));
  if (env.APPDATA) roots.push(path.join(env.APPDATA));
  // avoid duplicates
  const uniqRoots = [...new Set(roots.filter(Boolean))];

  const hits = [];
  for (const r of uniqRoots) {
    const files = walkFilesShallow(r, { maxFiles: 2000, maxDepth: 4 });
    for (const f of files) {
      if (hits.length >= maxResults * 8) break;
      if (!f.toLowerCase().endsWith(".exe")) continue;
      const bn = path.basename(f, ".exe");
      const bnNorm = norm(bn);
      if (!bnNorm) continue;
      if (bnNorm.includes(appNorm) || appNorm.includes(bnNorm)) {
        hits.push({ title: bn, path: f, source: "scan" });
      }
    }
  }
  return hits.slice(0, maxResults);
}

toolRegistry.register({
  id: "win.findApp",
  description: "Windows-only: find likely executable paths for an app name (Start Menu .lnk + shallow scans).",
  risk: ToolRisk.READ_ONLY,
  validateArgs: (args) => {
    const name = String(args?.name || "").trim();
    const maxResults = clampInt(args?.maxResults, 1, 20, 8);
    if (!name) return { ok: false, error: "Missing name" };
    return { ok: true, value: { name, maxResults } };
  },
  handler: async ({ args }) => {
    const name = String(args?.name || "").trim();
    const maxResults = clampInt(args?.maxResults, 1, 20, 8);

    if (!isWindows()) {
      return { query: name, results: [], error: "win.findApp is Windows-only" };
    }

    const appNorm = norm(name);
    const out = [];

    const lnk = await findStartMenuLinks(name, maxResults);
    for (const r of lnk) {
      const p = String(r?.path || "");
      if (!p || !p.toLowerCase().endsWith(".exe")) continue;
      const title = String(r?.title || path.basename(p, ".exe"));
      out.push({
        title,
        path: p,
        source: "start_menu_lnk",
        score: scoreCandidate(appNorm, title, p, "start_menu_lnk"),
      });
    }

    const scan = await findExeByScan(name, maxResults);
    for (const r of scan) {
      const p = String(r?.path || "");
      const title = String(r?.title || path.basename(p, ".exe"));
      out.push({
        title,
        path: p,
        source: "scan",
        score: scoreCandidate(appNorm, title, p, "scan"),
      });
    }

    // de-dup by path
    const seen = new Set();
    const dedup = [];
    for (const r of out.sort((a, b) => (b.score || 0) - (a.score || 0))) {
      const p = r.path;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      dedup.push(r);
      if (dedup.length >= maxResults) break;
    }

    return { query: name, results: dedup };
  },
});
