export function normalizeWs(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseButtonsFromHtml(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    const text = normalizeWs(inner.replace(/<[^>]+>/g, ""));
    const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i);
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const classes = classMatch
      ? classMatch[1].split(/\s+/).filter(Boolean)
      : [];
    out.push({
      text,
      id: idMatch ? idMatch[1] : "",
      type: typeMatch ? typeMatch[1] : "",
      classes,
      attrs,
      inner,
    });
  }
  return out;
}

export function parseCssBlocks(css) {
  const blocks = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;

    let selEnd = open;
    let selStart = css.lastIndexOf("}", open);
    selStart = selStart === -1 ? 0 : selStart + 1;
    const selector = normalizeWs(css.slice(selStart, selEnd));

    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= css.length) break;

    const body = css.slice(open + 1, j);
    blocks.push({
      selector,
      full: css.slice(selStart, j + 1), // exact substring for apply_patch find
      body,
    });
    i = j + 1;
  }
  return blocks;
}

export function findCssBlock(blocks, selector) {
  const t = normalizeWs(selector);
  return blocks.find((b) => normalizeWs(b.selector) === t) || null;
}
