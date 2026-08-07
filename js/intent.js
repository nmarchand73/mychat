/**
 * Intent: decide chat vs image vs refine for Auto mode (and forced modes).
 * Architecture: cheap regex first, optional Ollama one-word classifier;
 * pure functions — callers pass lastImage/refineArmed/getChatModel.
 */

import {
  OLLAMA,
  IMAGE_STRONG,
  IMAGE_SOFT,
  IMAGE_NEGATIVE,
  REFINE_HINT,
} from "./config.js";
import { stripThink } from "./markdown.js";
import { isAbortError, StoppedError } from "./util.js";

export function isQuestionLike(text) {
  return (
    /[?？]/.test(text) ||
    /^(who|what|when|where|why|how|is|are|can|could|should|quel|quelle|quels|quelles|quoi|comment|pourquoi|est[- ]ce)\b/i.test(text) ||
    IMAGE_NEGATIVE.test(text)
  );
}

export function wantsRefine(text, { lastImageB64, refineArmed }) {
  if (!lastImageB64) return false;
  if (refineArmed) return true;
  return REFINE_HINT.test(text.trim());
}

export function wantsImage(text) {
  const t = text.trim();
  if (!t) return false;

  const strong = IMAGE_STRONG.test(t);
  const question = isQuestionLike(t);

  if (question) {
    return /\b(draw|sketch|paint|generat\w*\s+(an?\s+)?(image|picture|photo)|dessine|peins|génère\s+.*(image|photo)|generate\s+.*(image|picture))\b/i.test(t);
  }

  if (strong) return true;
  if (IMAGE_SOFT.test(t) && t.split(/\s+/).length <= 40) return true;

  const visualNouns = (t.match(/\b(cat|dog|city|street|forest|mountain|sunset|portrait|robot|castle|car|flower|ocean|rain|brick|neon|néon|café|cafe|room|kitchen|spaceship|chat|chien|forêt|foret|montagne|robot|château|chateau)\b/gi) || []).length;
  if (visualNouns >= 2 && t.split(/\s+/).length <= 30 && !/\b(is|are|was|were|est|sont|était|etait)\b/i.test(t)) {
    return true;
  }
  return false;
}

export async function classifyImageIntent(text, {
  signal,
  getChatModel,
  lastImageB64,
  refineArmed,
}) {
  if (wantsRefine(text, { lastImageB64, refineArmed })) return "refine";
  if (IMAGE_STRONG.test(text)) return "image";
  if (IMAGE_NEGATIVE.test(text)) return "chat";
  if (!IMAGE_SOFT.test(text) && text.split(/\s+/).length > 12) {
    return wantsImage(text) ? "image" : "chat";
  }

  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: getChatModel(),
        stream: false,
        options: { temperature: 0, num_predict: 8 },
        messages: [
          {
            role: "system",
            content:
              "You route user prompts. Reply with only one word: IMAGE (new picture), REFINE (edit an existing/last picture), or CHAT (question, explanation, code).",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return wantsImage(text) ? "image" : "chat";
    const data = await res.json();
    const reply = stripThink(data?.message?.content || "").toUpperCase();
    if (/\bREFINE\b/.test(reply) && lastImageB64) return "refine";
    if (/\bIMAGE\b/.test(reply)) return "image";
    if (/\bCHAT\b/.test(reply)) return "chat";
  } catch (err) {
    if (isAbortError(err)) throw new StoppedError();
  }
  return wantsImage(text) ? "image" : "chat";
}

export async function resolveMode(text, {
  mode,
  signal,
  getChatModel,
  lastImageB64,
  refineArmed,
}) {
  if (mode === "chat") return "chat";
  if (mode === "image") {
    if (wantsRefine(text, { lastImageB64, refineArmed })) return "refine";
    return "image";
  }
  return classifyImageIntent(text, {
    signal,
    getChatModel,
    lastImageB64,
    refineArmed,
  });
}
