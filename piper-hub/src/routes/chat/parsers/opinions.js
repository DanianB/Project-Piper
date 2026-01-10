// src/routes/chat/parsers/opinions.js
function isOpinionQuery(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("how do you feel about") ||
    m.includes("what do you think about") ||
    m.includes("what are your thoughts on") ||
    m.includes("what were your thoughts on") ||
    m.includes("your thoughts on") ||
    m.includes("your opinion on") ||
    m.startsWith("do you like ") ||
    m.startsWith("do you hate ") ||
    m.startsWith("do you love ")
  );
}

function extractOpinionTopic(msg) {
  const s = String(msg || "").trim();

  let m = s.match(/feel about\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");

  m = s.match(/think about\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");

  m = s.match(/(?:are|were)\s+your\s+thoughts\s+on\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");

  m = s.match(/your\s+thoughts\s+on\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");

  m = s.match(/opinion on\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");

  m = s.match(/do you (?:like|love|hate)\s+(.+)$/i);
  if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "");

  return null;
}

function parseUserPreferenceSignal(msg) {
  const s = String(msg || "")
    .trim()
    .toLowerCase();

  // strong negatives
  if (/(i\s+)?(really\s+)?(hate|can'?t\s+stand|despise)\b/.test(s))
    return { signal: "dislike", strength: 0.8 };
  if (/(i\s+)?(don'?t|do not)\s+like\b/.test(s))
    return { signal: "dislike", strength: 0.6 };
  if (/\bnot\s+a\s+fan\b/.test(s)) return { signal: "dislike", strength: 0.5 };

  // positives
  if (/(i\s+)?(really\s+)?(love|adore)\b/.test(s))
    return { signal: "like", strength: 0.8 };
  if (/(i\s+)?(like|enjoy)\b/.test(s))
    return { signal: "like", strength: 0.55 };

  // Soft persuasion cue: "it's your theme color / primary UI color" implies a gentle 'like' nudge.
  if (
    /(theme\s+color|primary\s+color|ui\s+color)/.test(s) &&
    /(should|favorite|favourite|ought)/.test(s)
  ) {
    return { signal: "like", strength: 0.45 };
  }
  if (
    /(theme\s+color|primary\s+color|ui\s+color)/.test(s) &&
    !/(don'?t|do not|hate|not\s+a\s+fan)/.test(s)
  ) {
    // Even without 'should', treat as a mild positive framing cue.
    return { signal: "like", strength: 0.3 };
  }
  return null;
}

function extractReasonClause(msg) {
  const s = String(msg || "").trim();
  // Keep it simple: capture after "because" if present
  const m = s.match(/because\s+([\s\S]{1,240})/i);
  return m && m[1] ? String(m[1]).trim() : "";
}

function isLikelyPreferenceFollowup(msg) {
  const s = String(msg || "")
    .trim()
    .toLowerCase();
  // short preference statements often omit the topic: "I don't like it"
  return /(don'?t\s+like|do not like|not a fan|hate|love|like it|don'?t like it|theme\s+color|primary\s+color|ui\s+color)/.test(
    s
  );
}

export { isOpinionQuery, extractOpinionTopic, parseUserPreferenceSignal, extractReasonClause, isLikelyPreferenceFollowup };
