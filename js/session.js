/**
 * Intent: multi-chat library — list, create, switch, persist threads.
 * Architecture: localStorage blob v3 `{ activeId, chats[] }`; each chat holds
 * memory + threadLog + lastImage. v1/v2 single sessions migrate into one chat.
 * Quality: 8/10 — sanitize covers tool cards; still no binary image quota strategy
 */

import { IMAGE_MODEL, SESSION_KEY, SESSION_VERSION } from "./config.js";

export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m) => m && typeof m === "object" && m.role);
}

function sanitizeToolResults(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      title: typeof r.title === "string" ? r.title : "",
      url: typeof r.url === "string" ? r.url : "",
      snippet: typeof r.snippet === "string" ? r.snippet : "",
    }))
    .slice(0, 12);
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
      out.push({
        t: "system",
        c: item.c,
        historyBefore: Number.isFinite(Number(item.historyBefore))
          ? Number(item.historyBefore)
          : undefined,
      });
    } else if (item.t === "bot" && typeof item.c === "string") {
      out.push({
        t: "bot",
        c: item.c,
        label: typeof item.label === "string" ? item.label : null,
        md: item.md !== false,
        historyBefore: Number.isFinite(Number(item.historyBefore))
          ? Number(item.historyBefore)
          : undefined,
      });
    } else if (item.t === "tool" && typeof item.name === "string") {
      out.push({
        t: "tool",
        name: item.name,
        input:
          item.input && typeof item.input === "object"
            ? {
                query: typeof item.input.query === "string" ? item.input.query : "",
                max_results: Number(item.input.max_results) || undefined,
              }
            : {},
        results: sanitizeToolResults(item.results),
        status: item.status === "error" ? "error" : "done",
        error: typeof item.error === "string" ? item.error : undefined,
        historyBefore: Number.isFinite(Number(item.historyBefore))
          ? Number(item.historyBefore)
          : undefined,
      });
    } else if (item.t === "image") {
      out.push({
        t: "image",
        prompt: typeof item.prompt === "string" ? item.prompt : "",
        label: typeof item.label === "string" ? item.label : IMAGE_MODEL,
        img: typeof item.img === "string" ? item.img : null,
        missing: Boolean(item.missing) || !item.img,
        historyBefore: Number.isFinite(Number(item.historyBefore))
          ? Number(item.historyBefore)
          : undefined,
      });
    }
  }
  return out;
}

export function chatId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFromThread(thread) {
  const user = (thread || []).find((t) => t?.t === "user" && typeof t.c === "string");
  if (!user) return "New chat";
  const t = String(user.c).trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > 42 ? `${t.slice(0, 40)}…` : t;
}

function emptyChat(id = chatId()) {
  const now = Date.now();
  return {
    id,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    history: [],
    memory: null,
    thread: [],
    lastImage: null,
  };
}

/** Normalize any stored payload into a v3 library. */
export function normalizeLibrary(raw) {
  if (!raw || typeof raw !== "object") {
    const chat = emptyChat();
    return { v: SESSION_VERSION, activeId: chat.id, chats: [chat] };
  }

  // Already multi-chat
  if (raw.v === SESSION_VERSION && Array.isArray(raw.chats)) {
    const chats = raw.chats
      .filter((c) => c && typeof c.id === "string")
      .map((c) => ({
        id: c.id,
        title: typeof c.title === "string" && c.title.trim() ? c.title : titleFromThread(c.thread),
        createdAt: Number(c.createdAt) || Date.now(),
        updatedAt: Number(c.updatedAt) || Date.now(),
        history: sanitizeHistory(c.history),
        memory: c.memory || null,
        thread: sanitizeThread(c.thread),
        lastImage: typeof c.lastImage === "string" ? c.lastImage : null,
      }));
    if (!chats.length) {
      const chat = emptyChat();
      return { v: SESSION_VERSION, activeId: chat.id, chats: [chat] };
    }
    const activeId =
      chats.some((c) => c.id === raw.activeId) ? raw.activeId : chats[0].id;
    return { v: SESSION_VERSION, activeId, chats };
  }

  // Legacy single session (v1 / v2)
  if (raw.v === 1 || raw.v === 2) {
    const thread = sanitizeThread(raw.thread);
    const chat = {
      ...emptyChat(),
      title: titleFromThread(thread),
      history: sanitizeHistory(raw.history),
      memory: raw.memory || null,
      thread,
      lastImage: typeof raw.lastImage === "string" ? raw.lastImage : null,
    };
    return { v: SESSION_VERSION, activeId: chat.id, chats: [chat] };
  }

  const chat = emptyChat();
  return { v: SESSION_VERSION, activeId: chat.id, chats: [chat] };
}

/**
 * @param {{
 *   memory: object,
 *   threadLog: object[],
 *   getLastImage: () => string | null,
 * }} deps
 */
export function createSessionStore({ memory, threadLog, getLastImage }) {
  /** @type {{ v: number, activeId: string, chats: object[] }} */
  let library = normalizeLibrary(null);

  function readRaw() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function writeLibrary(lib, { includeImages = true } = {}) {
    const payload = {
      v: SESSION_VERSION,
      activeId: lib.activeId,
      chats: lib.chats.map((c) => {
        if (includeImages) return c;
        return {
          ...c,
          lastImage: null,
          thread: (c.thread || []).map((e) =>
            e.t === "image"
              ? { t: "image", prompt: e.prompt, label: e.label, missing: true }
              : e
          ),
        };
      }),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  }

  function activeChat() {
    return library.chats.find((c) => c.id === library.activeId) || null;
  }

  function buildActiveSnapshot({ includeImages = true } = {}) {
    const mem = memory.exportState();
    const thread = includeImages
      ? [...threadLog]
      : threadLog.map((e) =>
          e.t === "image"
            ? { t: "image", prompt: e.prompt, label: e.label, missing: true }
            : e
        );
    const prev = activeChat();
    return {
      id: library.activeId || chatId(),
      title: titleFromThread(threadLog),
      createdAt: prev?.createdAt || Date.now(),
      updatedAt: Date.now(),
      history: mem.conversation
        .filter((m) => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
        .map((m) => ({ role: m.role, content: m.content || "" })),
      memory: mem,
      thread,
      lastImage: includeImages ? getLastImage() : null,
    };
  }

  function commitActiveToLibrary({ includeImages = true } = {}) {
    if (!library.activeId) {
      const chat = emptyChat();
      library = { v: SESSION_VERSION, activeId: chat.id, chats: [chat] };
    }
    const snap = buildActiveSnapshot({ includeImages });
    library.activeId = snap.id;
    const idx = library.chats.findIndex((c) => c.id === snap.id);
    if (idx >= 0) library.chats[idx] = snap;
    else library.chats.unshift(snap);
    // newest activity first
    library.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function persistSession() {
    try {
      commitActiveToLibrary({ includeImages: true });
      writeLibrary(library, { includeImages: true });
      return;
    } catch {
      /* quota */
    }
    try {
      commitActiveToLibrary({ includeImages: false });
      writeLibrary(library, { includeImages: false });
    } catch {
      /* ignore */
    }
  }

  function loadLibrary() {
    library = normalizeLibrary(readRaw());
    return library;
  }

  /** @returns {object | null} active chat payload for UI restore */
  function loadSession() {
    loadLibrary();
    const chat = activeChat();
    if (!chat) return null;
    return {
      id: chat.id,
      history: sanitizeHistory(chat.history),
      memory: chat.memory || null,
      thread: sanitizeThread(chat.thread),
      lastImage: typeof chat.lastImage === "string" ? chat.lastImage : null,
    };
  }

  function listChats() {
    return library.chats.map((c) => ({
      id: c.id,
      title: c.title || "New chat",
      updatedAt: c.updatedAt || 0,
      empty: !(c.thread?.length || c.memory?.conversation?.length || c.history?.length),
    }));
  }

  function getActiveId() {
    return library.activeId;
  }

  function recordThread(entry, el) {
    const idx = threadLog.length;
    threadLog.push(entry);
    if (el) el.dataset.threadIndex = String(idx);
    persistSession();
    return idx;
  }

  /** Clear only the active chat content (keep the chat slot). */
  function clearActiveChat() {
    const id = library.activeId || chatId();
    const prev = activeChat();
    const now = Date.now();
    const cleared = {
      id,
      title: "New chat",
      createdAt: prev?.createdAt || now,
      updatedAt: now,
      history: [],
      memory: null,
      thread: [],
      lastImage: null,
    };
    const idx = library.chats.findIndex((c) => c.id === id);
    if (idx >= 0) library.chats[idx] = cleared;
    else library.chats.unshift(cleared);
    library.activeId = id;
    try {
      writeLibrary(library, { includeImages: true });
    } catch {
      /* ignore */
    }
  }

  function createChat() {
    commitActiveToLibrary({ includeImages: true });
    // Reuse existing empty "New chat" if it's already active / present
    const existingEmpty = library.chats.find(
      (c) =>
        c.title === "New chat" &&
        !(c.thread?.length || c.memory?.conversation?.length || c.history?.length)
    );
    if (existingEmpty) {
      library.activeId = existingEmpty.id;
      try {
        writeLibrary(library, { includeImages: true });
      } catch {
        /* ignore */
      }
      return existingEmpty.id;
    }
    const chat = emptyChat();
    library.chats.unshift(chat);
    library.activeId = chat.id;
    try {
      writeLibrary(library, { includeImages: true });
    } catch {
      /* ignore */
    }
    return chat.id;
  }

  function switchChat(id) {
    if (!id || id === library.activeId) return false;
    const target = library.chats.find((c) => c.id === id);
    if (!target) return false;
    commitActiveToLibrary({ includeImages: true });
    library.activeId = id;
    try {
      writeLibrary(library, { includeImages: true });
    } catch {
      /* ignore */
    }
    return true;
  }

  function deleteChat(id) {
    if (!id) return false;
    commitActiveToLibrary({ includeImages: true });
    const remaining = library.chats.filter((c) => c.id !== id);
    if (!remaining.length) {
      const chat = emptyChat();
      library = { v: SESSION_VERSION, activeId: chat.id, chats: [chat] };
    } else {
      library.chats = remaining;
      if (library.activeId === id) library.activeId = remaining[0].id;
    }
    try {
      writeLibrary(library, { includeImages: true });
    } catch {
      /* ignore */
    }
    return true;
  }

  function wipeStorage() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    library = normalizeLibrary(null);
  }

  return {
    buildSessionPayload: () => buildActiveSnapshot({ includeImages: true }),
    persistSession,
    loadSession,
    loadLibrary,
    listChats,
    getActiveId,
    recordThread,
    clearActiveChat,
    createChat,
    switchChat,
    deleteChat,
    wipeStorage,
  };
}
