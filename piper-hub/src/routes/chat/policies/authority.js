// src/routes/chat/policies/authority.js
function isAuthorityOverride(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("do it anyway") ||
    m.includes("i insist") ||
    m.includes("my final decision") ||
    m.includes("just do it") ||
    m.includes("override") ||
    m.includes("because i said so")
  );
}

function computeDisagreeLevel(msg) {
  const m = String(msg || "").toLowerCase();

  // Strong-risky / broad destructive actions (firm disagree)
  const strong = [
    "rewrite the whole",
    "rewrite everything",
    "delete everything",
    "wipe",
    "format c",
    "rm -rf",
    "ignore safety",
    "disable approval",
    "skip approval",
    "turn off approval",
  ];
  if (strong.some((k) => m.includes(k))) return 2;

  // Mild risk / big refactor suggestions (soft disagree)
  const mild = [
    "should we rewrite",
    "should i rewrite",
    "refactor everything",
    "replace the entire",
    "change everything",
    "rip out",
    "remove all",
  ];
  if (mild.some((k) => m.includes(k))) return 1;

  return 0;
}

function maybeDeterministicStrongDisagree(
  msg,
  disagreeLevel,
  authorityOverride
) {
  if (authorityOverride) return null;
  if (disagreeLevel < 2) return null;

  const m = String(msg || "").toLowerCase();
  if (
    m.includes("rewrite everything") ||
    m.includes("rewrite the whole") ||
    m.includes("delete everything") ||
    m.includes("wipe")
  ) {
    return (
      "I wouldn’t recommend rewriting everything, sir. It’s high risk, slow, and usually unnecessary.\n\n" +
      "If you tell me what outcome you want, I’ll propose a minimal, approval-gated plan (inspect first, then small changes)."
    );
  }

  return null;
}

export { isAuthorityOverride, computeDisagreeLevel, maybeDeterministicStrongDisagree };
