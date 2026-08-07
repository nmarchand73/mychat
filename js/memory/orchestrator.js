/**
 * Intent: one facade that builds the Ollama message list for a turn.
 * Architecture: composes ConversationStore + Summarizer + FactsStore + RagClient;
 * UI only calls prepareTurn / willLikelyCompress / export-import — layers stay swappable.
 */

import { ConversationStore } from "./conversation.js";
import { FactsStore } from "./facts.js";
import { Summarizer } from "./summarizer.js";
import { RagClient } from "./rag.js";

const SETTINGS_KEY = "mychat.memory.settings";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

/**
 * @param {{
 *   ollamaUrl: string,
 *   getModel: () => string,
 *   apiBase?: string,
 * }} config
 */
export function createMemorySystem(config) {
  const saved = loadSettings();

  const conversation = new ConversationStore({ maxToolContentChars: 6000 });
  const facts = new FactsStore({ storageKey: "mychat.facts", maxFacts: 40 });
  const summarizer = new Summarizer({
    ollamaUrl: config.ollamaUrl,
    getModel: config.getModel,
    charBudget: 24000,
    keepRecentChars: 10000,
  });
  const rag = new RagClient({
    baseUrl: config.apiBase || location.origin,
    enabled: saved.ragEnabled !== false,
  });

  const settings = {
    factsEnabled: saved.factsEnabled !== false,
    ragEnabled: saved.ragEnabled !== false,
    summarizeEnabled: saved.summarizeEnabled !== false,
    rememberToolEnabled: saved.rememberToolEnabled !== false,
  };
  rag.setEnabled(settings.ragEnabled);

  function persistSettings() {
    saveSettings(settings);
    rag.setEnabled(settings.ragEnabled);
  }

  /**
   * Build system + history for one model turn.
   * @param {{
   *   prompt: string,
   *   baseSystem: string,
   *   signal?: AbortSignal,
   * }} args
   */
  async function prepareTurn({ prompt, baseSystem, signal }) {
    const meta = {
      summarized: false,
      dropped: 0,
      ragHits: 0,
      facts: facts.count(),
    };

    if (settings.summarizeEnabled) {
      const r = await summarizer.maybeCompress(conversation, { signal });
      meta.summarized = r.summarized;
      meta.dropped = r.dropped;
    } else if (conversation.estimateChars() > 40000) {
      // Hard safety trim even if summarize is off
      conversation.trimToBudget(20000);
    }

    /** @type {string[]} */
    const blocks = [String(baseSystem || "").trim()];

    if (settings.factsEnabled) {
      const f = facts.toSystemBlock();
      if (f) blocks.push(f);
    }

    const sum = summarizer.toSystemBlock();
    if (sum) blocks.push(sum);

    if (settings.ragEnabled) {
      const { hits, ok } = await rag.query(prompt, { topK: 4, signal });
      if (ok && hits.length) {
        meta.ragHits = hits.length;
        blocks.push(rag.toSystemBlock(hits));
      }
    }

    if (settings.rememberToolEnabled) {
      blocks.push(
        "## Memory tools",
        "You may call remember_fact to store a durable user preference or fact for future turns.",
        "Only store clear, lasting information the user wants remembered — not ephemeral search results."
      );
    }

    const system = { role: "system", content: blocks.filter(Boolean).join("\n\n") };
    const messages = [system, ...conversation.getMessages()];
    return { messages, meta };
  }

  /** Tool schema for Ollama (optional). */
  function rememberToolSchema() {
    return {
      type: "function",
      function: {
        name: "remember_fact",
        description:
          "Store a durable fact or preference about the user for future conversations. Use when the user says to remember something, or states a lasting preference.",
        parameters: {
          type: "object",
          properties: {
            fact: {
              type: "string",
              description: "Short standalone fact to remember",
            },
          },
          required: ["fact"],
        },
      },
    };
  }

  /**
   * Execute remember_fact and return tool content for the model.
   * @param {{ fact?: string }} args
   */
  function executeRememberFact(args) {
    const fact = String(args?.fact || "").trim();
    if (!fact) return { ok: false, content: "Empty fact — nothing stored." };
    const savedFact = facts.add(fact);
    return {
      ok: true,
      content: savedFact
        ? `Stored fact: ${savedFact.text}`
        : `Fact already known: ${fact}`,
      fact: savedFact,
    };
  }

  function exportState() {
    return {
      conversation: conversation.toJSON(),
      summary: summarizer.toJSON(),
    };
  }

  function importState(data) {
    if (!data || typeof data !== "object") return;
    conversation.loadJSON(data.conversation);
    summarizer.loadJSON(data.summary);
  }

  function clearConversationMemory() {
    conversation.clear();
    summarizer.clear();
  }

  return {
    conversation,
    facts,
    summarizer,
    rag,
    settings,
    persistSettings,
    willLikelyCompress() {
      return (
        settings.summarizeEnabled &&
        conversation.estimateChars() > summarizer.charBudget
      );
    },
    prepareTurn,
    rememberToolSchema,
    executeRememberFact,
    exportState,
    importState,
    clearConversationMemory,
  };
}

export { ConversationStore, FactsStore, Summarizer, RagClient };
