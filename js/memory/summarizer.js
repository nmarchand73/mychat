/**
 * Intent: compress old turns into a rolling summary when context grows.
 * Architecture: calls Ollama chat once; keeps a tail of recent messages;
 * soft-fails to a stub summary if the model call errors.
 */

function formatTurn(m) {
  const role = m.role || "?";
  const name = m.tool_name ? `${role}:${m.tool_name}` : role;
  let body = String(m.content || "").trim();
  if (m.tool_calls?.length) {
    const names = m.tool_calls.map((c) => c?.function?.name || "tool").join(", ");
    body = `${body}${body ? "\n" : ""}[called tools: ${names}]`;
  }
  if (body.length > 1200) body = `${body.slice(0, 1200)}…`;
  return `${name.toUpperCase()}: ${body || "(empty)"}`;
}

export class Summarizer {
  /**
   * @param {{
   *   ollamaUrl: string,
   *   getModel: () => string,
   *   charBudget?: number,
   *   keepRecentChars?: number,
   * }} opts
   */
  constructor(opts) {
    this.ollamaUrl = opts.ollamaUrl;
    this.getModel = opts.getModel;
    this.charBudget = opts.charBudget ?? 24000;
    this.keepRecentChars = opts.keepRecentChars ?? 10000;
    /** @type {string} */
    this.summary = "";
  }

  clear() {
    this.summary = "";
  }

  toSystemBlock() {
    if (!this.summary.trim()) return "";
    return [
      "## Conversation summary (compressed earlier turns)",
      "Use this as background; prefer newer messages if they conflict.",
      this.summary.trim(),
    ].join("\n");
  }

  toJSON() {
    return this.summary;
  }

  loadJSON(raw) {
    this.summary = typeof raw === "string" ? raw : "";
  }

  /**
   * If store exceeds budget, summarize the dropped prefix and keep a recent window.
   * @param {import('./conversation.js').ConversationStore} store
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ summarized: boolean, dropped: number }>}
   */
  async maybeCompress(store, opts = {}) {
    if (store.estimateChars() <= this.charBudget) {
      return { summarized: false, dropped: 0 };
    }

    const dropped = store.trimToBudget(this.keepRecentChars);
    if (!dropped.length) return { summarized: false, dropped: 0 };

    const transcript = dropped.map(formatTurn).join("\n\n");
    const prior = this.summary.trim();
    const prompt = [
      "Summarize the following chat excerpt into a compact memory note.",
      "Keep: user goals, decisions, facts, tool findings (with key URLs), open questions.",
      "Drop: chit-chat, duplicate text, full tool dumps.",
      "Write in the same language as the excerpt. Max ~250 words.",
      prior ? `\nExisting summary to merge:\n${prior}\n` : "",
      "\nExcerpt:\n",
      transcript,
    ].join("\n");

    try {
      const res = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: opts.signal,
        body: JSON.stringify({
          model: this.getModel(),
          stream: false,
          options: { temperature: 0.2, num_predict: 400 },
          messages: [
            {
              role: "system",
              content: "You compress chat history into durable notes for a later model turn.",
            },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const text = String(data?.message?.content || "").trim();
      if (text) this.summary = text;
      else if (!this.summary) {
        this.summary = `Earlier turns covered: ${dropped.length} messages (summary failed).`;
      }
      return { summarized: true, dropped: dropped.length };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Soft-fail: keep a stub so context still shrinks
      if (!this.summary) {
        this.summary = `Earlier conversation omitted (${dropped.length} messages) to fit context.`;
      }
      return { summarized: true, dropped: dropped.length };
    }
  }
}
