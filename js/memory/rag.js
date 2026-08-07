/**
 * Intent: retrieve / ingest notes via local RAG HTTP API.
 * Architecture: thin fetch client; server embeds with Ollama and stores
 * chunks on disk — this module never talks to the embed model directly.
 */

export class RagClient {
  /**
   * @param {{ baseUrl?: string, enabled?: boolean }} [opts]
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || location.origin).replace(/\/$/, "");
    this.enabled = opts.enabled !== false;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
  }

  /**
   * @param {string} text
   * @param {{ source?: string, signal?: AbortSignal }} [opts]
   */
  async ingest(text, opts = {}) {
    const res = await fetch(`${this.baseUrl}/api/rag/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        text: String(text || ""),
        source: opts.source || "manual",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `RAG ingest failed (${res.status})`);
    return data;
  }

  /**
   * @param {string} query
   * @param {{ topK?: number, signal?: AbortSignal }} [opts]
   */
  async query(query, opts = {}) {
    if (!this.enabled) return { hits: [], ok: false, skipped: true };
    const q = String(query || "").trim();
    if (!q) return { hits: [], ok: true };

    const res = await fetch(`${this.baseUrl}/api/rag/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({ query: q, top_k: opts.topK ?? 4 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { hits: [], ok: false, error: data.error || `RAG query failed (${res.status})` };
    }
    return { hits: data.hits || [], ok: true, model: data.model };
  }

  async list(signal) {
    const res = await fetch(`${this.baseUrl}/api/rag/list`, { signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `RAG list failed (${res.status})`);
    return data;
  }

  async remove(id, signal) {
    const res = await fetch(`${this.baseUrl}/api/rag/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `RAG delete failed (${res.status})`);
    return data;
  }

  async health(signal) {
    try {
      const res = await fetch(`${this.baseUrl}/api/rag/health`, { signal });
      return await res.json();
    } catch {
      return { ok: false };
    }
  }

  /**
   * @param {{ text: string, score?: number, source?: string }[]} hits
   */
  toSystemBlock(hits) {
    if (!hits?.length) return "";
    const lines = hits.map((h, i) => {
      const src = h.source ? ` (${h.source})` : "";
      const score = typeof h.score === "number" ? ` · sim ${h.score.toFixed(2)}` : "";
      return `${i + 1}.${src}${score}\n${String(h.text || "").trim()}`;
    });
    return [
      "## Retrieved notes (local RAG)",
      "Use when relevant; quote sparingly. These are from the user's local knowledge base.",
      ...lines,
    ].join("\n\n");
  }
}
