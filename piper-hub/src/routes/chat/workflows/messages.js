// src/routes/chat/workflows/messages.js
import { piperSystemPrompt } from "../../../services/persona.js";
const sessions = new Map();

function buildChatMessages({
  userMsg,
  affect,
  disagreeLevel,
  authorityOverride,
  opinion,
  history,
  lastTopic,
}) {
  const mood = Number(affect?.mood || 0).toFixed(2);
  const fr = Number(affect?.frustration?.total || 0).toFixed(2);

  const opinionLine = opinion
    ? `Known opinion: ${opinion.key} score=${Number(opinion.score ?? 0).toFixed(
        2
      )} stance="${opinion.stance}" rationale="${String(
        opinion.rationale || ""
      ).slice(0, 220)}"`
    : "Known opinion: none";

  const topicLine = lastTopic
    ? `Last topic: ${String(lastTopic).slice(0, 140)}`
    : "Last topic: none";

  const disagreePolicy =
    disagreeLevel === 0
      ? "Disagreement policy: do not disagree."
      : disagreeLevel === 1
      ? "Disagreement policy: mild. Briefly state hesitation, propose a safer alternative."
      : "Disagreement policy: firm. Clearly warn about risks, propose safer approach.";

  const authorityPolicy = authorityOverride
    ? "Authority override: present. The user explicitly insists. You must yield and proceed with their decision (while still being safe and clear)."
    : "Authority override: not present.";

  const out = [
    {
      role: "system",
      content: `${piperSystemPrompt()}

Return plain text (no JSON).
Be concise; keep replies coherent across turns.
If the user says something ambiguous like "I don't like it", interpret it as referring to the last topic when reasonable.
You may be opinionated, but never hostile.
If you disagree, do it once, then move to next steps.

Affect snapshot: mood=${mood} frustration=${fr}
${topicLine}
${opinionLine}
${disagreePolicy}
${authorityPolicy}`,
    },
  ];

  // Short conversational history for coherence (most recent first -> append in order)
  const hist = Array.isArray(history) ? history : [];
  for (const h of hist) {
    if (!h || !h.role || !h.content) continue;
    const role = h.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: String(h.content).slice(0, 1200) });
  }

  out.push({ role: "user", content: String(userMsg || "") });

  return out;
}

export { buildChatMessages };
