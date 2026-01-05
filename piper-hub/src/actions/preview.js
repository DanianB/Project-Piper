import fs from "fs";
import { safeResolve } from "../utils/fsx.js";
import { unifiedDiff } from "../utils/diff.js";

function applyPatchInMemory(before, edits) {
  let out = String(before ?? "");
  let changedAny = false;
  const perEdit = [];

  for (let i = 0; i < (edits || []).length; i++) {
    const e = edits[i] || {};
    const find = String(e?.find ?? "");
    const replace = String(e?.replace ?? "");
    const mode = e?.mode === "all" ? "all" : "once";

    if (!find) {
      perEdit.push({
        index: i,
        matched: false,
        changed: false,
        mode,
        note: "missing find",
      });
      continue;
    }

    if (mode === "all") {
      const matched = out.includes(find);
      const next = matched ? out.split(find).join(replace) : out;
      const changed = next !== out;
      if (changed) changedAny = true;
      out = next;
      perEdit.push({ index: i, matched, changed, mode });
    } else {
      const idx = out.indexOf(find);
      const matched = idx !== -1;
      if (matched) {
        out = out.slice(0, idx) + replace + out.slice(idx + find.length);
        changedAny = true;
        perEdit.push({ index: i, matched: true, changed: true, mode });
      } else {
        perEdit.push({ index: i, matched: false, changed: false, mode });
      }
    }
  }

  return { out, changedAny, perEdit };
}

export function isPreviewableType(type) {
  return ["apply_patch", "write_file", "bundle"].includes(String(type || ""));
}

function coerceBundleSteps(payload) {
  if (Array.isArray(payload?.steps)) return payload.steps;
  if (Array.isArray(payload?.actions)) return payload.actions;
  return [];
}

export function computePreviewFilesForAction(action) {
  const type = String(action?.type || "");
  const p = action?.payload || {};
  const files = [];

  if (type === "write_file") {
    const rel = String(p.path || "");
    const abs = safeResolve(rel);
    const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const newText = String(p.content ?? "");

    const diff = unifiedDiff(oldText, newText, rel);

    files.push({
      path: rel,
      old: oldText,
      new: newText,
      diff,
      note:
        oldText === newText
          ? "⚠️ No changes (new content identical to existing file)."
          : "",
    });
    return files;
  }

  if (type === "apply_patch") {
    const rel = String(p.path || "");
    const abs = safeResolve(rel);
    const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const edits = Array.isArray(p.edits) ? p.edits : [];

    const mem = applyPatchInMemory(oldText, edits);
    const newText = mem.out;

    const diff = unifiedDiff(oldText, newText, rel);

    // if patch didn't match, make the warning loud
    const anyUnmatched = (mem.perEdit || []).some((e) => e.matched === false);
    const note = !mem.changedAny
      ? "⚠️ Patch did not change the file. At least one 'find' anchor likely did not match."
      : anyUnmatched
      ? "⚠️ Patch partially matched. One or more edits did not match their 'find' anchors."
      : "";

    files.push({
      path: rel,
      old: oldText,
      new: newText,
      diff,
      note,
      perEdit: mem.perEdit,
    });
    return files;
  }

  if (type === "bundle") {
    const list = coerceBundleSteps(p);
    for (const sub of list) {
      const subAction = {
        type: String(sub?.type || ""),
        payload: sub?.payload || {},
      };
      if (!isPreviewableType(subAction.type)) continue;
      files.push(...computePreviewFilesForAction(subAction));
    }
    return files;
  }

  return files;
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

export function htmlPreviewPage({ action, files }) {
  const title = `Preview — ${action.title || action.type} (${action.id})`;

  const fileTabs = files
    .map(
      (f, i) =>
        `<button class="tab" data-tab="${i}">${escapeHtml(f.path)}</button>`
    )
    .join("");

  const panes = files
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

      const perEditHtml =
        Array.isArray(f.perEdit) && f.perEdit.length
          ? `<details class="peredit">
             <summary>Patch edit diagnostics</summary>
             <div class="pereditList">
               ${f.perEdit
                 .map((e) => {
                   const status = e.matched
                     ? e.changed
                       ? "matched + changed"
                       : "matched (no change)"
                     : "NOT matched";
                   return `<div class="pereditItem">
                             <code>edit[${e.index}]</code>
                             <span class="${
                               e.matched ? "ok" : "bad"
                             }">${escapeHtml(status)}</span>
                             <span class="muted">mode=${escapeHtml(
                               e.mode || "once"
                             )}</span>
                             ${
                               e.note
                                 ? `<span class="muted">${escapeHtml(
                                     e.note
                                   )}</span>`
                                 : ""
                             }
                           </div>`;
                 })
                 .join("")}
             </div>
           </details>`
          : "";

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

  ${perEditHtml}

  <details class="udiff">
    <summary>Unified diff</summary>
    <div class="udwrap">${
      udiffHtml || `<div class="muted">No diff output.</div>`
    }</div>
  </details>
</section>`;
    })
    .join("");

  const canApprove = action.status === "pending";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    :root{
      --bg:#0b0f14; --border:#1f2a3a; --text:#e7edf7; --muted:#a9b6c9; --muted2:#7f8da3;
      --accent:#6aa6ff; --shadow:0 12px 30px rgba(0,0,0,.35);
      --row:#0f1520;
      --chg: rgba(250, 204, 21, .14);
      --add: rgba(34, 197, 94, .14);
      --del: rgba(244, 63, 94, .14);
    }
    *{box-sizing:border-box}
    body{margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: var(--bg); color:var(--text);}
    a{color:var(--accent); text-decoration:none} a:hover{text-decoration:underline}
    .wrap{max-width: 1200px; margin: 18px auto; padding: 14px;}
    .panel{border:1px solid var(--border); border-radius:16px; box-shadow: var(--shadow); overflow:hidden;}
    header{padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--border);}
    header .meta{display:flex; gap:10px; flex-wrap:wrap; align-items:center; font-size:12px; color:var(--muted);}
    .badge{padding:3px 9px; border-radius:999px; border:1px solid rgba(255,255,255,.1); color: var(--muted); display:inline-flex; gap:6px; align-items:center;}
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

    /* Side-by-side code grid */
    .codeGrid{
      display:block;
      max-height: 520px;
      overflow:auto;
      background: transparent;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size:12px;
      line-height:1.4;
    }
    .row{
      display:grid;
      grid-template-columns: 56px 1fr;
      gap:0;
      border-bottom:1px solid rgba(255,255,255,.06);
      background: transparent;
    }
    .row:nth-child(odd){ background: rgba(255,255,255,.02); }
    .row.changed{ background: var(--chg); }
    .row.added{ background: var(--add); }
    .row.removed{ background: var(--del); }
    .ln{
      padding:6px 8px;
      color: var(--muted2);
      border-right:1px solid rgba(255,255,255,.08);
      user-select:none;
      text-align:right;
    }
    .txt{
      padding:6px 10px;
      white-space: pre;
      overflow:hidden;
      text-overflow: ellipsis;
    }

    details.udiff{margin-top:12px;}
    details.udiff summary{cursor:pointer; color: var(--accent); user-select:none;}
    .udwrap{
      margin-top:8px;
      padding:10px;
      border:1px solid rgba(255,255,255,.08);
      border-radius:14px;
      overflow:auto;
      max-height: 420px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size:12px;
      line-height:1.4;
    }
    .udline{white-space: pre;}
    .udline.ud-add{background: rgba(34,197,94,.14);}
    .udline.ud-del{background: rgba(244,63,94,.14);}
    .udline.ud-hunk{color: #93c5fd;}

    .peredit{margin-top:12px;}
    .peredit summary{cursor:pointer; color: var(--accent); user-select:none;}
    .pereditList{margin-top:8px; padding:10px; border:1px solid rgba(255,255,255,.08); border-radius:14px;}
    .pereditItem{display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12px; color: var(--text); padding:6px 0; border-bottom:1px solid rgba(255,255,255,.06);}
    .pereditItem:last-child{border-bottom:none;}
    .pereditItem code{color: #cbd5e1;}
    .pereditItem .ok{color: #86efac;}
    .pereditItem .bad{color: #fda4af;}

    .btns{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
    button.actionBtn{padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,.12); color: var(--text); cursor:pointer; background:transparent;}
    button.actionBtn.primary{border-color: rgba(45,212,191,.22);}
    button.actionBtn.danger{border-color: rgba(251,113,133,.22);}
    button.actionBtn:disabled{opacity:.55; cursor:not-allowed;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <header>
        <div>
          <div style="font-size:14px; font-weight:700">${escapeHtml(
            action.title || action.type
          )}</div>
          <div class="meta">
            <span>Type: <code>${escapeHtml(action.type)}</code></span>
            <span class="badge">${escapeHtml(action.status || "pending")}</span>
          </div>
        </div>
        <div class="btns">
          <a href="/" style="font-size:12px">← Back</a>
          ${
            canApprove
              ? `<button class="actionBtn primary" id="approveBtn">✅ Approve</button>
                 <button class="actionBtn danger" id="rejectBtn">❌ Reject</button>`
              : `<span style="font-size:12px; color:var(--muted)">Already processed.</span>`
          }
        </div>
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
          `<div style="color:var(--muted); font-size:12px">Nothing to preview for this action type.</div>`
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

  async function api(path, body){
    const r = await fetch(path,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body||{}) });
    const j = await r.json().catch(()=>null);
    if(!r.ok) throw new Error((j && (j.error||j.message)) || (r.status+" "+r.statusText));
    return j;
  }

  const approveBtn = document.getElementById("approveBtn");
  const rejectBtn = document.getElementById("rejectBtn");

  if(approveBtn){
    approveBtn.onclick = async () => {
      if(!confirm("Approve and execute this action?")) return;
      approveBtn.disabled = true;
      try{
        await api("/action/approve",{ id: ${JSON.stringify(action.id)} });
        location.reload();
      }catch(e){
        alert("Approve failed: "+e);
        approveBtn.disabled = false;
      }
    };
  }
  if(rejectBtn){
    rejectBtn.onclick = async () => {
      if(!confirm("Reject this action?")) return;
      rejectBtn.disabled = true;
      try{
        const note = prompt("Reject note (optional):") || "";
        await api("/action/reject",{ id: ${JSON.stringify(action.id)}, note });
        location.reload();
      }catch(e){
        alert("Reject failed: "+e);
        rejectBtn.disabled = false;
      }
    };
  }
</script>
</body>
</html>`;
}
