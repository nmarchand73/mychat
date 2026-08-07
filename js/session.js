/**
 * Intent: save/restore conversation + UI transcript across reloads.
 * Architecture: `createSessionStore` serializes memory + threadLog to
 * localStorage (with image-stripping fallback on quota).
 */

import { IMAGE_MODEL, SESSION_KEY, SESSION_VERSION } from "./config.js";

export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m) => m && typeof m === "object" && m.role);
}

export function sanitizeThread(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (item.t === "user" && typeof item.c === "string") {
      out.push({
        t: "user",
        c: item.c,
        historyBefore: Number.isFinite(Number(item.historyBefore))
          ? Number(item.historyBefore)
          : 0,
      });
    } else if (item.t === "system" && typeof item.c === "string") {
      out.push({ t: "system", c: item.c });
    } else if (item.t === "bot" && typeof item.c === "string") {
      out.push({
        t: "bot",
        c: item.c,
        label: typeof item.label === "string" ? item.label : null,
        md: item.md !== false,
      });
    } else if (item.t === "image") {
      out.push({
        t: "image",
        prompt: typeof item.prompt === "string" ? item.prompt : "",
        label: typeof item.label === "string" ? item.label : IMAGE_MODEL,
        img: typeof item.img === "string" ? item.img : null,
        missing: Boolean(item.missing) || !item.img,
      });
    }
  }
  return out;
}

/**
 * @param {{
 *   memory: object,
 *   threadLog: object[],
 *   getLastImage: () => string | null,
 * }} deps
 */
export function createSessionStore({ memory, threadLog, getLastImage }) {
  function buildSessionPayload({ includeImages = true } = {}) {
    const thread = includeImages
      ? threadLog
      : threadLog.map((e) =>
          e.t === "image"
            ? { t: "image", prompt: e.prompt, label: e.label, missing: true }
            : e
        );
    const mem = memory.exportState();
    return {
      v: SESSION_VERSION,
      history: mem.conversation
        .filter((m) => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
        .map((m) => ({ role: m.role, content: m.content || "" })),
      memory: mem,
      thread,
      lastImage: includeImages ? getLastImage() : null,
    };
  }

  function persistSession() {
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify(buildSessionPayload({ includeImages: true }))
      );
      return;
    } catch {
      /* quota — retry without image payloads */
    }
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify(buildSessionPayload({ includeImages: false }))
      );
    } catch {
      /* ignore */
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || (data.v !== 1 && data.v !== SESSION_VERSION)) return null;
      return {
        history: sanitizeHistory(data.history),
        memory: data.memory || null,
        thread: sanitizeThread(data.thread),
        lastImage: typeof data.lastImage === "string" ? data.lastImage : null,
      };
    } catch {
      return null;
    }
  }

  function recordThread(entry, el) {
    const idx = threadLog.length;
    threadLog.push(entry);
    if (el) el.dataset.threadIndex = String(idx);
    persistSession();
    return idx;
  }

  function wipeStorage() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  return {
    buildSessionPayload,
    persistSession,
    loadSession,
    recordThread,
    wipeStorage,
  };
}
