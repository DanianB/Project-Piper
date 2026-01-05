// src/planner/chunker.js
import { normalizeWs } from "./uimapper.js";

/**
 * Block format:
 *  { file, blockId, kind, label, startLine, endLine, text }
 */

function stripCR(s) {
  return String(s ?? "").replace(/\r/g, "");
}

function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).slice(0, 10);
}

function lineOfIndex(text, idx) {
  if (idx <= 0) return 1;
  return text.slice(0, idx).split("\n").length;
}

function sliceWithLines(text, startIdx, endIdx) {
  const startLine = lineOfIndex(text, startIdx);
  const endLine = lineOfIndex(text, endIdx);
  return { startLine, endLine, text: text.slice(startIdx, endIdx) };
}

function findMatchingBrace(text, openIdx) {
  // openIdx points to '{'
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function buildCssBlocks(file, cssText) {
  const css = stripCR(cssText);
  const blocks = [];

  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;

    let selEnd = open;
    let selStart = css.lastIndexOf("}", open);
    selStart = selStart === -1 ? 0 : selStart + 1;

    const selector = normalizeWs(css.slice(selStart, selEnd));
    if (!selector) {
      i = open + 1;
      continue;
    }

    const close = findMatchingBrace(css, open);
    if (close === -1) break;

    const fullStart = selStart;
    const fullEnd = close + 1;
    const full = css.slice(fullStart, fullEnd);

    const { startLine, endLine } = sliceWithLines(css, fullStart, fullEnd);

    const blockId = `css_${hashId(
      file + "::" + selector + "::" + full.slice(0, 240)
    )}`;
    blocks.push({
      file,
      blockId,
      kind: "css_rule",
      label: selector,
      startLine,
      endLine,
      text: full,
    });

    i = close + 1;
  }

  return blocks;
}

export function buildLineBlocks(
  file,
  text,
  { windowLines = 60, overlap = 12 } = {}
) {
  const t = stripCR(text);
  const lines = t.split("\n");
  const blocks = [];
  if (!lines.length) return blocks;

  let start = 0;
  while (start < lines.length) {
    const end = Math.min(lines.length, start + windowLines);
    const chunkText = lines.slice(start, end).join("\n");
    const label = `lines_${start + 1}-${end}`;
    const blockId = `ln_${hashId(
      file + "::" + label + "::" + chunkText.slice(0, 240)
    )}`;

    blocks.push({
      file,
      blockId,
      kind: "lines",
      label,
      startLine: start + 1,
      endLine: end,
      text: chunkText,
    });

    if (end === lines.length) break;
    start = Math.max(0, end - overlap);
  }

  return blocks;
}

function buildJsNamedBlocks(file, jsText) {
  const js = stripCR(jsText);
  const blocks = [];
  const usedRanges = [];

  function overlaps(aStart, aEnd) {
    return usedRanges.some(
      ([bStart, bEnd]) => Math.max(aStart, bStart) < Math.min(aEnd, bEnd)
    );
  }
  function addRange(aStart, aEnd) {
    usedRanges.push([aStart, aEnd]);
  }

  // 1) export function / function
  const fnRe =
    /(^|\n)\s*(export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = fnRe.exec(js)) !== null) {
    const name = m[3];
    const braceIdx = fnRe.lastIndex - 1; // points at '{'
    const close = findMatchingBrace(js, braceIdx);
    if (close === -1) continue;

    // include "export function..." line start
    const startIdx = m.index === 0 ? 0 : m.index + 1;
    const endIdx = close + 1;

    if (overlaps(startIdx, endIdx)) continue;

    const seg = js.slice(startIdx, endIdx);
    const { startLine, endLine } = sliceWithLines(js, startIdx, endIdx);
    const label = `function ${name}`;
    const blockId = `jsfn_${hashId(
      file + "::" + label + "::" + seg.slice(0, 240)
    )}`;

    blocks.push({
      file,
      blockId,
      kind: "js_function",
      label,
      startLine,
      endLine,
      text: seg,
    });
    addRange(startIdx, endIdx);
  }

  // 2) export class / class
  const classRe =
    /(^|\n)\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)\s*(extends\s+[A-Za-z_$][\w$]*)?\s*\{/g;
  while ((m = classRe.exec(js)) !== null) {
    const name = m[3];
    const braceIdx = classRe.lastIndex - 1;
    const close = findMatchingBrace(js, braceIdx);
    if (close === -1) continue;

    const startIdx = m.index === 0 ? 0 : m.index + 1;
    const endIdx = close + 1;
    if (overlaps(startIdx, endIdx)) continue;

    const seg = js.slice(startIdx, endIdx);
    const { startLine, endLine } = sliceWithLines(js, startIdx, endIdx);
    const label = `class ${name}`;
    const blockId = `jscl_${hashId(
      file + "::" + label + "::" + seg.slice(0, 240)
    )}`;

    blocks.push({
      file,
      blockId,
      kind: "js_class",
      label,
      startLine,
      endLine,
      text: seg,
    });
    addRange(startIdx, endIdx);
  }

  // 3) export const name = (...) => { ... }  OR const name = (...) => { ... }
  const arrowRe =
    /(^|\n)\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\([^)]*\)\s*=>\s*\{/g;
  while ((m = arrowRe.exec(js)) !== null) {
    const name = m[3];
    const braceIdx = arrowRe.lastIndex - 1;
    const close = findMatchingBrace(js, braceIdx);
    if (close === -1) continue;

    const startIdx = m.index === 0 ? 0 : m.index + 1;
    const endIdx = close + 1;
    if (overlaps(startIdx, endIdx)) continue;

    const seg = js.slice(startIdx, endIdx);
    const { startLine, endLine } = sliceWithLines(js, startIdx, endIdx);
    const label = `const ${name} = (...) =>`;
    const blockId = `jsar_${hashId(
      file + "::" + label + "::" + seg.slice(0, 240)
    )}`;

    blocks.push({
      file,
      blockId,
      kind: "js_arrow",
      label,
      startLine,
      endLine,
      text: seg,
    });
    addRange(startIdx, endIdx);
  }

  // 4) router.<method>("/path", ... => { ... })
  // This captures the handler block starting at "router.get(...{"
  const routeRe =
    /(^|\n)\s*router\.(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]+)\3[\s\S]*?\{\s*$/gim;
  // The regex above is hard because JS is flexible. We'll do a simpler scan:
  const routeScan =
    /(^|\n)\s*router\.(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]+)\3/gi;
  while ((m = routeScan.exec(js)) !== null) {
    const method = m[2].toUpperCase();
    const routePath = m[4];

    // Find the first '{' after this match
    const from = routeScan.lastIndex;
    const braceIdx = js.indexOf("{", from);
    if (braceIdx === -1) continue;

    // Heuristic: ensure it's not a plain object; routes should have ')', '=>', etc nearby
    const between = js.slice(from, Math.min(js.length, braceIdx + 20));
    if (!between.includes("=>") && !between.includes("function")) continue;

    const close = findMatchingBrace(js, braceIdx);
    if (close === -1) continue;

    // Start the block at the beginning of the line containing router.<method>(
    const startIdx = m.index === 0 ? 0 : m.index + 1;
    const endIdx = close + 1;
    if (overlaps(startIdx, endIdx)) continue;

    const seg = js.slice(startIdx, endIdx);
    const { startLine, endLine } = sliceWithLines(js, startIdx, endIdx);
    const label = `route ${method} ${routePath}`;
    const blockId = `jsrt_${hashId(
      file + "::" + label + "::" + seg.slice(0, 240)
    )}`;

    blocks.push({
      file,
      blockId,
      kind: "js_route",
      label,
      startLine,
      endLine,
      text: seg,
    });
    addRange(startIdx, endIdx);
  }

  // Sort blocks by startLine
  blocks.sort((a, b) => a.startLine - b.startLine);

  return blocks;
}

export function buildFileBlocks(file, text) {
  const ext = String(file).toLowerCase();
  if (ext.endsWith(".css")) return buildCssBlocks(file, text);

  if (ext.endsWith(".js") || ext.endsWith(".mjs") || ext.endsWith(".ts")) {
    const named = buildJsNamedBlocks(file, text);

    // If named blocks cover very little, also include line blocks
    // (line blocks ensure there is always a way to edit even if patterns miss)
    const lineFallback = buildLineBlocks(file, text, {
      windowLines: 80,
      overlap: 16,
    });

    // Deduplicate by blockId
    const map = new Map();
    for (const b of [...named, ...lineFallback]) map.set(b.blockId, b);
    return Array.from(map.values());
  }

  // HTML/other: line blocks only
  return buildLineBlocks(file, text, { windowLines: 80, overlap: 16 });
}
