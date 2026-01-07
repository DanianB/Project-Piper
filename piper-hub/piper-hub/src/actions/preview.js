// src/actions/preview.js
import fs from "fs";
import { safeResolve } from "../utils/fsx.js";
import { unifiedDiff } from "../utils/diff.js";

function setHtmlTitleInText(html, title) {
  const t = String(title ?? "");
  const re = /<title>[\s\S]*?<\/title>/i;
  if (!re.test(html)) {
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head[^>]*>/i, (m) => `${m}\n  <title>${t}</title>`);
    }
    return `<title>${t}</title>\n` + html;
  }
  return html.replace(re, `<title>${t}</title>`);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function splitLines(s) {
  return String(s ?? "")
    .replace(/\r/g, "")
    .split("\n");
}

function buildLineDiff(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const max = Math.max(oldLines.length, newLines.length);

  const rows = [];
  let changedCount = 0;

  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];

    let oldClass = "";
    let newClass = "";

    if (o === undefined && n !== undefined) {
      newClass = "added";
      changedCount++;
    } else if (o !== undefined && n === undefined) {
      oldClass = "removed";
      changedCount++;
    } else if ((o ?? "") !== (n ?? "")) {
      oldClass = "changed";
      newClass = "changed";
      changedCount++;
    }

    rows.push({
      oldNum: o === undefined ? "" : String(i + 1),
      newNum: n === undefined ? "" : String(i + 1),
      oldLine: o === undefined ? "" : o,
      newLine: n === undefined ? "" : n,
      oldClass,
      newClass,
    });
  }

  return { rows, changedCount };
}

function highlightUnifiedDiff(diffText) {
  const lines = splitLines(diffText);
  return lines
    .map((ln) => {
      let cls = "";
      if (ln.startsWith("+") && !ln.startsWith("+++")) cls = "ud-add";
      else if (ln.startsWith("-") && !ln.startsWith("---")) cls = "ud-del";
      else if (ln.startsWith("@@")) cls = "ud-hunk";
      return `<div class="udline ${cls}">${escapeHtml(ln)}</div>`;
    })
    .join("");
}

export function isPreviewableType(type) {
  return [
    "apply_patch",
    "write_file",
    "bundle",
    "mkdir",
    "set_html_title",
  ].includes(String(type || ""));
}

export function computePreviewFilesForAction(action) {
  const type = String(action?.type || "");
  const p = action?.payload || {};
  const files = [];

  if (type === "set_html_title") {
    const rel = String(p.path || "");
    const abs = safeResolve(rel);
    const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const newText = setHtmlTitleInText(oldText, p.title);

    const diff = unifiedDiff(oldText, newText, rel);

    console.log(
      `[preview] set_html_title preview rel="${rel}" title="${String(p.title)}"`
    );

    files.push({
      path: rel,
      old: oldText,
      new: newText,
      diff,
      note: "",
    });
    return files;
  }

  if (type === "mkdir") {
    const rel = String(p.path || "").trim();
    const abs = safeResolve(rel);
    console.log(`[preview] mkdir preview rel="${rel}" abs="${abs}"`);
    const diff =
      `--- a/${rel}\n` +
      `+++ b/${rel}\n` +
      `@@ mkdir @@\n` +
      `+ mkdir -p ${abs}\n`;
    files.push({
      path: rel || "(folder)",
      old: "",
      new: "",
      diff,
      note: "This action creates a folder (no file content to diff).",
    });
    return files;
  }

  if (type === "write_file") {
    const rel = String(p.path || "");
    const abs = safeResolve(rel);
    const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const newText = String(p.content ?? "");
    console.log(
      `[preview] write_file preview rel="${rel}" oldBytes=${oldText.length} newBytes=${newText.length}`
    );
    const diff = unifiedDiff(oldText, newText, rel);
    files.push({
      path: rel,
      old: oldText,
      new: newText,
      diff,
      note: oldText === newText ? "⚠️ No changes." : "",
    });
    return files;
  }

  if (type === "apply_patch") {
    // We keep apply_patch preview as-is (it already works for you)
    const rel = String(p.path || "");
    const abs = safeResolve(rel);
    const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const edits = Array.isArray(p.edits) ? p.edits : [];

    // Minimal in-memory patching for preview (matches executor logic)
    let out = oldText;
    for (const e of edits) {
      const find = String(e?.find ?? "");
      const replace = String(e?.replace ?? "");
      const mode = e?.mode === "all" ? "all" : "once";
      if (!find) continue;
      if (mode === "all") out = out.split(find).join(replace);
      else {
        const idx = out.indexOf(find);
        if (idx !== -1)
          out = out.slice(0, idx) + replace + out.slice(idx + find.length);
      }
    }

    console.log(
      `[preview] apply_patch preview rel="${rel}" edits=${edits.length} oldBytes=${oldText.length}`
    );
    const diff = unifiedDiff(oldText, out, rel);
    files.push({ path: rel, old: oldText, new: out, diff, note: "" });
    return files;
  }

  if (type === "bundle") {
    const steps = Array.isArray(p.steps)
      ? p.steps
      : Array.isArray(p.actions)
      ? p.actions
      : [];
    const byPath = new Map();
    for (const step of steps) {
      if (!step) continue;
      const sub = { type: step.type, payload: step.payload || {} };
      if (!isPreviewableType(sub.type)) continue;
      const subFiles = computePreviewFilesForAction(sub);
      for (const f of subFiles) byPath.set(f.path, f);
    }
    return Array.from(byPath.values());
  }

  return files;
}

/**
 * IMPORTANT: must match your route signature:
 *   htmlPreviewPage({ action, files })
 */
export function htmlPreviewPage({ action, files }) {
  const title = `Preview — ${action?.title || action?.type || "Action"} (${
    action?.id || ""
  })`;

  const fileTabs = (files || [])
    .map(
      (f, i) =>
        `<button class="tab" data-tab="${i}">${escapeHtml(f.path)}</button>`
    )
    .join("");

  const panes = (files || [])
    .map((f, i) => {
      const { rows, changedCount } = buildLineDiff(f.old, f.new);

      const oldCol = rows
        .map(
          (r) => `
          <div class="row ${r.oldClass}">
            <div class="ln">${escapeHtml(r.oldNum)}</div>
            <div class="txt">${escapeHtml(r.oldLine)}</div>
          </div>`
        )
        .join("");

      const newCol = rows
        .map(
          (r) => `
          <div class="row ${r.newClass}">
            <div class="ln">${escapeHtml(r.newNum)}</div>
            <div class="txt">${escapeHtml(r.newLine)}</div>
          </div>`
        )
        .join("");

      const udiffHtml = highlightUnifiedDiff(f.diff || "");

      return `
<section class="pane" data-pane="${i}" style="display:none">
  ${f.note ? `<div class="note">${escapeHtml(f.note)}</div>` : ``}

  <div class="summary">
    <span class="badge">Lines changed: ${changedCount}</span>
    ${
      changedCount === 0
        ? `<span class="muted">No visible line-level differences.</span>`
        : ``
    }
  </div>

  <div class="views">
    <div class="view">
      <div class="viewTitle">Old</div>
      <div class="codeGrid">${oldCol}</div>
    </div>

    <div class="view">
      <div class="viewTitle">New</div>
      <div class="codeGrid">${newCol}</div>
    </div>
  </div>

  <details class="udiff">
    <summary>Unified diff</summary>
    <div class="udwrap">${
      udiffHtml || `<div class="muted">No diff output.</div>`
    }</div>
  </details>
</section>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    :root{
      --bg:#0b0f14; --border:#1f2a3a; --text:#e7edf7; --muted:#a9b6c9; --muted2:#7f8da3;
      --shadow:0 12px 30px rgba(0,0,0,.35);
      --chg: rgba(250, 204, 21, .14);
      --add: rgba(34, 197, 94, .14);
      --del: rgba(244, 63, 94, .14);
      --accent:#6aa6ff;
    }
    *{box-sizing:border-box}
    body{margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: var(--bg); color:var(--text);}
    a{color:var(--accent); text-decoration:none}
    .wrap{max-width: 1200px; margin: 18px auto; padding: 14px;}
    .panel{border:1px solid var(--border); border-radius:16px; overflow:hidden; box-shadow: var(--shadow);}
    header{padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--border);}
    .badge{padding:3px 9px; border-radius:999px; border:1px solid rgba(255,255,255,.1); color: var(--muted); display:inline-flex;}
    .tabs{padding:10px 14px; display:flex; gap:8px; flex-wrap:wrap; border-bottom:1px solid var(--border);}
    .tab{padding:8px 10px; border-radius:12px; border:1px solid rgba(255,255,255,.10); color: var(--text); cursor:pointer; background:transparent;}
    .tab.active{border-color: rgba(106,166,255,.35);}
    .content{padding:14px;}
    .views{display:grid; grid-template-columns: 1fr 1fr; gap:12px;}
    @media (max-width: 980px){ .views{grid-template-columns: 1fr;} }
    .view{border:1px solid rgba(255,255,255,.10); border-radius:14px; overflow:hidden;}
    .viewTitle{padding:8px 10px; font-size:12px; color: var(--muted); border-bottom:1px solid rgba(255,255,255,.08);}
    .summary{display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px;}
    .muted{color:var(--muted); font-size:12px;}
    .note{padding:10px 12px; border-radius:14px; border:1px solid rgba(251,191,36,.22); color:#ffd08a; margin-bottom:12px; font-size:12px;}
    .codeGrid{
      display:block; max-height: 520px; overflow:auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size:12px; line-height:1.4;
    }
    .row{display:grid; grid-template-columns: 56px 1fr; border-bottom:1px solid rgba(255,255,255,.06);}
    .row:nth-child(odd){ background: rgba(255,255,255,.02); }
    .row.changed{ background: var(--chg); }
    .row.added{ background: var(--add); }
    .row.removed{ background: var(--del); }
    .ln{padding:6px 8px; color: var(--muted2); border-right:1px solid rgba(255,255,255,.08); user-select:none; text-align:right;}
    .txt{padding:6px 10px; white-space: pre; overflow:hidden; text-overflow: ellipsis;}
    details.udiff{margin-top:12px;}
    details.udiff summary{cursor:pointer; color: var(--accent); user-select:none;}
    .udwrap{
      margin-top:8px; padding:10px; border:1px solid rgba(255,255,255,.08);
      border-radius:14px; overflow:auto; max-height: 420px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size:12px; line-height:1.4;
    }
    .udline{white-space: pre;}
    .udline.ud-add{background: rgba(34,197,94,.14);}
    .udline.ud-del{background: rgba(244,63,94,.14);}
    .udline.ud-hunk{color: #93c5fd;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <header>
        <div>
          <div style="font-size:14px; font-weight:700">${escapeHtml(
            action?.title || action?.type || "Action"
          )}</div>
          <div style="font-size:12px; color:var(--muted)">
            Type: <code>${escapeHtml(action?.type || "")}</code>
            &nbsp; <span class="badge">${escapeHtml(
              action?.status || "pending"
            )}</span>
          </div>
        </div>
        <div><a href="/" style="font-size:12px">← Back</a></div>
      </header>

      <div class="tabs">
        ${
          fileTabs ||
          `<span style="color:var(--muted); font-size:12px">No previewable files.</span>`
        }
      </div>

      <div class="content">
        ${
          panes ||
          `<div style="color:var(--muted); font-size:12px">No preview available for this action type.</div>`
        }
      </div>
    </div>
  </div>

<script>
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panes = Array.from(document.querySelectorAll(".pane"));
  function show(i){
    tabs.forEach((t, idx) => t.classList.toggle("active", idx===i));
    panes.forEach((p, idx) => p.style.display = idx===i ? "block" : "none");
  }
  if(tabs.length) show(0);
</script>
</body>
</html>`;
}
