// src/services/mind_classifier.js
//
// Lightweight, deterministic classifier for "mind" behaviors.
// Goal: decide when to form/shift opinions and when to shift mood.

function norm(s) {
  return String(s || "").trim();
}

function lower(s) {
  return norm(s).toLowerCase();
}

export function classifyUserMessage(text) {
  const raw = norm(text);
  const t = raw.toLowerCase();

  // Strong social signals
  if (
    /\b(you'?re|you are)\s+(awesome|amazing|great|excellent|brilliant)\b/.test(t) ||
    /\b(great job|well done|nailed it|good job)\b/.test(t) ||
    /\byou\s+did\s+a\s+good\s+job\b/.test(t)
  ) {
    return { kind: "PRAISE" };
  }
  if (/\b(useless|idiot|stupid|trash|garbage)\b/.test(t) || /\b(shut up)\b/.test(t)) {
    return { kind: "INSULT" };
  }

  // Social rituals (no opinion, no mood shift)
  if (/^(hi|hello|hey|good\s(morning|afternoon|evening))\b/.test(t)) return { kind: "SOCIAL_RITUAL" };
  if (/\b(thanks|thank you|cheers)\b/.test(t)) return { kind: "SOCIAL_RITUAL" };
  if (/\b(bye|goodbye|see you)\b/.test(t)) return { kind: "SOCIAL_RITUAL" };

  // Utility queries (no opinion, no mood shift)
  if (/\b(what\s+time\s+is\s+it|time\s+is\s+it|current\s+time)\b/.test(t)) return { kind: "UTILITY" };
  if (/\b(what\s+date\s+is\s+it|current\s+date)\b/.test(t)) return { kind: "UTILITY" };

  // Opinion queries
  if (isOpinionQuery(raw)) return { kind: "OPINION_QUERY" };

  // Persuasion attempts about a prior topic
  if (parsePersuasionAttempt(raw)) return { kind: "PERSUASION" };

  return { kind: "OTHER" };
}

export function isOpinionQuery(msg) {
  const m = lower(msg);
  return (
    m.includes("how do you feel about") ||
    m.includes("what do you think about") ||
    m.includes("your opinion on") ||
    m.startsWith("do you like ") ||
    m.startsWith("do you hate ") ||
    m.startsWith("do you love ")
  );
}

export function extractOpinionTopic(msg) {
  const s = norm(msg);
  let m = s.match(/feel about\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");
  m = s.match(/think about\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");
  m = s.match(/opinion on\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");
  m = s.match(/do you (?:like|love|hate)\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");
  return null;
}

export function extractReasonClause(msg) {
  const s = norm(msg);
  const m = s.match(/\b(because|since|considering|given that)\b\s+([\s\S]{1,240})/i);
  return m?.[2] ? String(m[2]).trim() : "";
}

export function isOpinionWorthyTopic(rawTopic) {
  const t = lower(rawTopic);
  if (!t) return false;
  // Block trivial / ritual / utility topics
  if (/\b(hello|hi|hey|good morning|good evening|good afternoon)\b/.test(t)) return false;
  if (/\b(time|date|day)\b/.test(t) && t.length < 18) return false;
  if (/\b(test|testing|ping)\b/.test(t)) return false;
  return true;
}

export function parseUserPreferenceSignal(msg) {
  const s = lower(msg);
  if (/(i\s+)?(really\s+)?(hate|can'?t\s+stand|despise)\b/.test(s)) return { signal: "dislike", strength: 0.8 };
  if (/(i\s+)?(don'?t|do not)\s+like\b/.test(s)) return { signal: "dislike", strength: 0.6 };
  if (/\bnot\s+a\s+fan\b/.test(s)) return { signal: "dislike", strength: 0.5 };
  if (/(i\s+)?(really\s+)?(love|adore)\b/.test(s)) return { signal: "like", strength: 0.8 };
  if (/(i\s+)?(like|enjoy)\b/.test(s)) return { signal: "like", strength: 0.55 };
  if (/\b(my\s+favo(u)?rite)\b/.test(s)) return { signal: "like", strength: 0.7 };
  return null;
}

export function parsePersuasionAttempt(msg) {
  const s = lower(msg);
  // "you should like it" / "you should love" style
  if (/\byou\s+should\s+(like|love|prefer)\b/.test(s)) return { signal: "like", strength: 0.65 };
  // "should be your favorite" style
  if (/\bshould\s+be\s+your\s+favo(u)?rite\b/.test(s)) return { signal: "like", strength: 0.6 };
  // "it is your theme color" style
  if ((/\btheme\s+color\b/.test(s) || /\bprimary\s+color\b/.test(s) || /\bui\b/.test(s)) && /\bshould\b/.test(s)) {
    return { signal: "like", strength: 0.55 };
  }
  return null;
}
