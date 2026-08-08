/**
 * Intent: decide chat vs image vs refine from the explicit mode toggle.
 * Architecture: no Auto classifier — Image mode only paints; Chat stays chat.
 * Quality: 8/10 — false Auto→Image switches removed; refine still Image-only.
 */

import { IMAGE_STRONG, IMAGE_SOFT, IMAGE_NEGATIVE, REFINE_HINT } from "./config.js";

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

export async function resolveMode(text, {
  mode,
  lastImageB64,
  refineArmed,
}) {
  // No Auto routing — Image mode paints; everything else stays chat.
  if (mode === "image") {
    if (wantsRefine(text, { lastImageB64, refineArmed })) return "refine";
    return "image";
  }
  return "chat";
}
