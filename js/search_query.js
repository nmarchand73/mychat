/**
 * Intent: decide when to force web search and what query to send to ddgs.
 * Architecture: pure helpers — no DOM / Ollama; used by chat.js turn runner.
 * Quality: 8/10 — framing-only prompts reuse prior user topic from history.
 */

import { SEARCH_INTENT } from "./config.js";

export function wantsForcedSearch(text) {
  return SEARCH_INTENT.test(String(text || ""));
}

const SEARCH_FRAMING_ONLY =
  /^(peux[- ]tu|can you|please|svp|s'il te pla[iî]t)?\s*(fait|fais|faire|lance|lancer)?\s*(des?\s+)?(recherches?|search|google|look\s+up|cherche[rz]?)\s*((sur\s+le\s+web|the\s+web|online|en ligne|web)\s*)?[:\-–—.]?\s*$/i;

/** Strip “search the web” framing so ddgs gets a usable query. Empty = framing-only. */
export function extractSearchQuery(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (SEARCH_FRAMING_ONLY.test(raw)) return "";

  const cleaned = raw
    .replace(
      /^(peux[- ]tu|can you|please|svp|s'il te pla[iî]t)\s+/i,
      ""
    )
    .replace(
      /\b(fait|fais|faire|lance|lancer)\s+(des?\s+)?recherches?\s*((sur\s+le\s+web|web|en ligne)\s*)?[:\-]?\s*/i,
      ""
    )
    .replace(
      /\b(search|google|look\s+up|rechercher?|cherche[rz]?)\s*((the\s+web|online|en ligne|sur\s+le\s+web)\s*(for\s+)?)?/i,
      ""
    )
    .replace(/^[:\-–—]\s*/, "")
    .trim();

  // Do not fall back to framing-only prompts ("fais des recherches") — that
  // made ddgs look up the phrase itself (dictionaries) and ignore chat history.
  if (!cleaned || SEARCH_FRAMING_ONLY.test(cleaned)) return "";
  return cleaned;
}

/**
 * Build a ddgs query that keeps conversation topic when the user only says
 * “fais des recherches” / “search the web”.
 * @param {string} prompt
 * @param {object[]} messages  prepared Ollama messages (system + history)
 */
export function resolveSearchQuery(prompt, messages = []) {
  const direct = extractSearchQuery(prompt);
  if (direct) return direct.slice(0, 240);

  const priorUsers = [];
  for (const m of messages) {
    if (m?.role !== "user") continue;
    const t = String(m.content || "").trim();
    if (!t) continue;
    priorUsers.push(t);
  }
  // Last user turn is the current search ask — drop it.
  if (
    priorUsers.length &&
    priorUsers[priorUsers.length - 1] === String(prompt || "").trim()
  ) {
    priorUsers.pop();
  }

  const topicBits = [];
  for (let i = priorUsers.length - 1; i >= 0 && topicBits.length < 2; i--) {
    const u = priorUsers[i];
    const cleaned = extractSearchQuery(u) || (wantsForcedSearch(u) ? "" : u);
    if (cleaned) topicBits.unshift(cleaned);
  }

  if (topicBits.length) return topicBits.join(" — ").slice(0, 240);

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const plain = String(m.content || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[[\]#>*_`]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length > 48) return plain.slice(0, 160);
  }

  // Framing-only with no prior topic — do not search the phrase itself.
  return "";
}
