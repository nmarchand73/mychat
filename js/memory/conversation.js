/**
 * Intent: hold the model-facing chat history (user / assistant / tool).
 * Architecture: in-memory message array with push/truncate/checkpoint;
 * separate from the UI transcript (threadLog in session/app).
 */

const ROLE = Object.freeze({
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
  SYSTEM: "system",
});

function cloneMessage(m) {
  const out = { role: m.role, content: m.content ?? "" };
  if (m.tool_calls) out.tool_calls = structuredClone(m.tool_calls);
  if (m.tool_name) out.tool_name = m.tool_name;
  return out;
}

function messageChars(m) {
  let n = String(m.content || "").length;
  if (m.tool_name) n += String(m.tool_name).length;
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n;
}

export class ConversationStore {
  /** @param {{ maxToolContentChars?: number }} [opts] */
  constructor(opts = {}) {
    /** @type {object[]} */
    this._messages = [];
    this.maxToolContentChars = opts.maxToolContentChars ?? 6000;
  }

  get length() {
    return this._messages.length;
  }

  /** Snapshot for the model (shallow-cloned messages). */
  getMessages() {
    return this._messages.map(cloneMessage);
  }

  /** Index suitable for UI edit checkpoints (length before next user push). */
  checkpoint() {
    return this._messages.length;
  }

  clear() {
    this._messages.length = 0;
  }

  /**
   * Truncate to a prior checkpoint (edit-from-here).
   * @param {number} index
   */
  truncateTo(index) {
    const i = Math.max(0, Number(index) || 0);
    this._messages.length = Math.min(this._messages.length, i);
  }

  pushUser(content) {
    this._messages.push({ role: ROLE.USER, content: String(content ?? "") });
    return this.checkpoint() - 1;
  }

  /**
   * @param {string} content
   * @param {{ tool_calls?: object[] }} [extra]
   */
  pushAssistant(content, extra = {}) {
    const msg = { role: ROLE.ASSISTANT, content: String(content ?? "") };
    if (extra.tool_calls?.length) msg.tool_calls = structuredClone(extra.tool_calls);
    this._messages.push(msg);
  }

  /**
   * @param {{ tool_name: string, content: string }} tool
   */
  pushTool({ tool_name, content }) {
    let body = String(content ?? "");
    if (body.length > this.maxToolContentChars) {
      body = `${body.slice(0, this.maxToolContentChars)}\n…[truncated tool output]`;
    }
    this._messages.push({
      role: ROLE.TOOL,
      tool_name: String(tool_name || "tool"),
      content: body,
    });
  }

  /** Append a contiguous batch from an in-flight tool loop (already cloned). */
  appendMany(messages) {
    for (const m of messages || []) {
      if (!m?.role) continue;
      if (m.role === ROLE.TOOL) {
        this.pushTool({ tool_name: m.tool_name, content: m.content });
      } else if (m.role === ROLE.ASSISTANT) {
        this.pushAssistant(m.content, { tool_calls: m.tool_calls });
      } else if (m.role === ROLE.USER) {
        this.pushUser(m.content);
      }
    }
  }

  popLast() {
    return this._messages.pop() || null;
  }

  /** Rough size for budgeting (chars ≈ tokens/3–4 for Latin text). */
  estimateChars() {
    return this._messages.reduce((sum, m) => sum + messageChars(m), 0);
  }

  /**
   * Keep the newest messages under a char budget (preserves tool call groups).
   * @param {number} maxChars
   * @returns {object[]} dropped prefix (for summarization)
   */
  trimToBudget(maxChars) {
    if (this.estimateChars() <= maxChars) return [];
    const dropped = [];
    while (this._messages.length && this.estimateChars() > maxChars) {
      // Never leave a dangling tool without its assistant tool_calls
      const first = this._messages[0];
      dropped.push(this._messages.shift());
      if (first?.role === ROLE.ASSISTANT && first.tool_calls?.length) {
        while (this._messages[0]?.role === ROLE.TOOL) {
          dropped.push(this._messages.shift());
        }
      }
    }
    // If we start on a tool message, drop orphan tools
    while (this._messages[0]?.role === ROLE.TOOL) {
      dropped.push(this._messages.shift());
    }
    return dropped;
  }

  toJSON() {
    return this._messages.map(cloneMessage);
  }

  /**
   * @param {unknown} raw
   */
  loadJSON(raw) {
    this.clear();
    if (!Array.isArray(raw)) return;
    for (const m of raw) {
      if (!m || typeof m !== "object") continue;
      if (m.role === ROLE.USER && typeof m.content === "string") {
        this.pushUser(m.content);
      } else if (m.role === ROLE.ASSISTANT) {
        this.pushAssistant(typeof m.content === "string" ? m.content : "", {
          tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : undefined,
        });
      } else if (m.role === ROLE.TOOL) {
        this.pushTool({
          tool_name: m.tool_name || "tool",
          content: typeof m.content === "string" ? m.content : "",
        });
      }
    }
  }

  /** Count user turns (for status UI). */
  userTurnCount() {
    return this._messages.filter((m) => m.role === ROLE.USER).length;
  }
}

export { ROLE as ConversationRole };
