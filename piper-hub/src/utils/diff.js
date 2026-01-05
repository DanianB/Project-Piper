export function unifiedDiff(oldText, newText, filePath = "file") {
  const a = String(oldText ?? "")
    .replace(/\r/g, "")
    .split("\n");
  const b = String(newText ?? "")
    .replace(/\r/g, "")
    .split("\n");

  if (oldText === newText) {
    return `--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +0,0 @@\n (no changes)`;
  }

  const lines = [];
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  lines.push(`@@ -1,${a.length} +1,${b.length} @@`);
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const ao = a[i];
    const bo = b[i];
    if (ao === bo) {
      if (ao !== undefined) lines.push(" " + ao);
      continue;
    }
    if (ao !== undefined) lines.push("-" + ao);
    if (bo !== undefined) lines.push("+" + bo);
  }
  return lines.join("\n");
}
