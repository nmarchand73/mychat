/**
 * Intent: single source of truth for URLs, keys, models, tools, intent regexes.
 * Architecture: pure exports — no DOM, no I/O; imported by app/chat/image/intent.
 */

export const OLLAMA = "http://127.0.0.1:11434";
export function getSearchApi() {
  return `${location.origin}/api/search`;
}
export const CHAT_MODELS = ["ministral-3:8b", "qwen3.5:9b"];
/** Models that accept Ollama `think: true` */
export const THINK_MODELS = ["qwen3.5:9b"];
export const IMAGE_MODEL = "x/flux2-klein:4b";
export const CHAT_MODEL_KEY = "mychat.chatModel";
export const THINK_KEY = "mychat.think";
export const SEARCH_KEY = "mychat.search";
export const FONT_SIZE_KEY = "mychat.fontSize";
export const FONT_SIZES = ["sm", "md", "lg", "xl"];
export const SESSION_KEY = "mychat.session";
export const SESSION_VERSION = 2;
export const MAX_TOOL_ROUNDS = 3;

export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web from this laptop (local DuckDuckGo via ddgs). Use for current events, facts, docs, or anything that needs up-to-date information.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        max_results: {
          type: "integer",
          description: "Number of results (1-8)",
        },
      },
      required: ["query"],
    },
  },
};

// Strong positives: explicit generation verbs / visual artefacts
export const IMAGE_STRONG = new RegExp(
  [
    String.raw`\b(draw|sketch|paint|illustrat\w*|render|depict|visualize|visualise)\b`,
    String.raw`\b(dessine|dessiner|peins|peindre|illustre|illustrer)\b`,
    String.raw`\b(generat\w*|creat\w*|make|show|give)\s+(me\s+)?(an?\s+)?(image|picture|photo|illustration|artwork|drawing|painting|poster|logo|icon|wallpaper)\b`,
    String.raw`\b(génère|genere|générer|generer|crée|cree|créer|creer)\s+(moi\s+)?(une?\s+)?(image|photo|illustration|dessin|affiche|logo|icône|icone)\b`,
    String.raw`\b(image|picture|photo|illustration|artwork|poster|logo|icon)\s+of\b`,
    String.raw`\b(text[- ]to[- ]image|txt2img|flux)\b`,
    String.raw`\b(une?|un)\s+(image|photo|illustration|dessin|affiche|logo|icône|icone)\b.{0,60}\b(de|d['’]|of)\b`,
    String.raw`\b(neon|néon)\s+sign\b`,
    String.raw`\bphotorealistic\b`,
  ].join("|"),
  "i"
);

// Soft visual scene briefs (short, descriptive, no question)
export const IMAGE_SOFT = new RegExp(
  [
    String.raw`\b(cinematic|bokeh|wide[- ]angle|close[- ]up|oil painting|watercolor|watercolour|pixel art|anime style|concept art)\b`,
    String.raw`\b(sur une|on a|against a|in the style of)\b`,
  ].join("|"),
  "i"
);

export const IMAGE_NEGATIVE = new RegExp(
  [
    String.raw`\b(how (do|to)|explain|what is|why|difference|compare|markdown|code|function|bug|error|debug)\b`,
    String.raw`\b(comment|explique|qu['’]est[- ]ce|pourquoi|différence|difference)\b`,
    String.raw`\b(analyse|analyz|summar|résume|resume|tradui|translat)\b`,
  ].join("|"),
  "i"
);

// Edit / refine an existing image (needs a source on hand)
export const REFINE_HINT = new RegExp(
  [
    String.raw`\b(refine|edit|modify|tweak|adjust|remix|restyle|inpaint)\b`,
    String.raw`\b(change|turn|make|convert|transform|update)\b.{0,40}\b(it|this|the\s+image|the\s+picture|the\s+photo|the\s+sign|the\s+neon)\b`,
    String.raw`\b(make\s+it|change\s+it|edit\s+it|fix\s+it)\b`,
    String.raw`\b(add|remove|replace|swap)\b.{0,30}\b(to|from|in|on)\b.{0,20}\b(image|picture|photo|sign|neon|background)\b`,
    String.raw`\b(same\s+image|based\s+on\s+(this|the\s+last|previous)|from\s+the\s+last\s+image)\b`,
    String.raw`\b(affine|modifie|modifier|change|changer|améliore|ameliorer|refine)\b.{0,30}\b(l['’]?image|la\s+photo|le\s+néon|le\s+neon|ça|ca)\b`,
    String.raw`\b(rends[- ]le|fais[- ]le|mets[- ]le)\b`,
    String.raw`\b(plus\s+(bleu|rouge|vert|sombre|clair|bright|dark|blue|red|green))\b`,
  ].join("|"),
  "i"
);

