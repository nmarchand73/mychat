/**
 * Intent: store durable user facts (prefs, standing notes) across chats.
 * Architecture: localStorage-backed list with de-dupe + cap; injected into
 * the system prompt by the orchestrator when enabled.
 */

function uid() {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class FactsStore {
  /**
   * @param {{ storageKey?: string, maxFacts?: number }} [opts]
   */
  constructor(opts = {}) {
    this.storageKey = opts.storageKey || "mychat.facts";
    this.maxFacts = opts.maxFacts ?? 40;
    /** @type {{ id: string, text: string, createdAt: number }[]} */
    this._facts = [];
    this.load();
  }

  list() {
    return this._facts.map((f) => ({ ...f }));
  }

  count() {
    return this._facts.length;
  }

  /**
   * @param {string} text
   */
  add(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    // de-dupe similar
    const lower = t.toLowerCase();
    if (this._facts.some((f) => f.text.toLowerCase() === lower)) {
      return this._facts.find((f) => f.text.toLowerCase() === lower) || null;
    }
    const fact = { id: uid(), text: t, createdAt: Date.now() };
    this._facts.push(fact);
    while (this._facts.length > this.maxFacts) this._facts.shift();
    this.save();
    return fact;
  }

  /**
   * @param {string} id
   */
  remove(id) {
    const before = this._facts.length;
    this._facts = this._facts.filter((f) => f.id !== id);
    if (this._facts.length !== before) this.save();
    return before !== this._facts.length;
  }

  clear() {
    this._facts = [];
    this.save();
  }

  /** Block injected into the system prompt. */
  toSystemBlock() {
    if (!this._facts.length) return "";
    const lines = this._facts.map((f) => `- ${f.text}`);
    return [
      "## Durable memory (facts you should honor)",
      "These are explicit user-approved notes. Prefer them over conflicting guesses.",
      ...lines,
    ].join("\n");
  }

  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this._facts));
    } catch { /* ignore quota */ }
  }

  load() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      this._facts = data
        .filter((f) => f && typeof f.text === "string" && f.text.trim())
        .map((f) => ({
          id: typeof f.id === "string" ? f.id : uid(),
          text: String(f.text).trim(),
          createdAt: Number(f.createdAt) || Date.now(),
        }))
        .slice(-this.maxFacts);
    } catch {
      this._facts = [];
    }
  }
}
