/**
 * Intent: boot the UI, own mutable app state, wire user events.
 * Architecture: composition root — imports factories (ui/chat/image/session/memory)
 * and holds mode/busy/session flags; no heavy chat/image logic lives here.
 * Quality: 7/10 — shimmer placeholder wired in runUserTurn; root still ~1k lines
 */

import { createMemorySystem } from "./memory/orchestrator.js";
import {
  OLLAMA,
  CHAT_MODELS,
  IMAGE_MODELS,
  THINK_MODELS,
  CHAT_MODEL_KEY,
  IMAGE_MODEL_KEY,
  THINK_KEY,
  SEARCH_KEY,
  FONT_SIZE_KEY,
  FONT_SIZES,
  SIDEBAR_COLLAPSED_KEY,
} from "./config.js";
import { createSessionStore } from "./session.js";
import { createUi } from "./ui.js";
import { createChatRunner } from "./chat.js";
import { createImageRunner } from "./image.js";
import { resolveMode } from "./intent.js";
import { threadToMarkdown, downloadText } from "./export.js";
import { isAbortError, StoppedError } from "./util.js";

const thread = document.getElementById("thread");
const empty = document.getElementById("empty");
const form = document.getElementById("form");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const chatModelEl = document.getElementById("chatModel");
const imageModelEl = document.getElementById("imageModel");
const thinkToggleEl = document.getElementById("thinkToggle");
const thinkToggleLabel = document.getElementById("thinkToggleLabel");
const searchToggleEl = document.getElementById("searchToggle");
const searchToggleLabel = document.getElementById("searchToggleLabel");
const fontSizePicks = document.getElementById("fontSizePicks");
const factsToggleEl = document.getElementById("factsToggle");
const ragToggleEl = document.getElementById("ragToggle");
const summarizeToggleEl = document.getElementById("summarizeToggle");
const rememberToolToggleEl = document.getElementById("rememberToolToggle");
const factInputEl = document.getElementById("factInput");
const addFactBtn = document.getElementById("addFactBtn");
const factListEl = document.getElementById("factList");
const ragInputEl = document.getElementById("ragInput");
const ragIngestBtn = document.getElementById("ragIngestBtn");
const ragStatusEl = document.getElementById("ragStatus");
const statusEl = document.getElementById("status");
const dot = document.getElementById("dot");
const refineBanner = document.getElementById("refineBanner");
const refineThumb = document.getElementById("refineThumb");
const refineLabel = document.getElementById("refineLabel");
const clearRefineBtn = document.getElementById("clearRefine");
const editBanner = document.getElementById("editBanner");
const clearEditBtn = document.getElementById("clearEdit");
const clearChatBtn = document.getElementById("clearChat");
const exportChatBtn = document.getElementById("exportChat");
const suggestionsEl = document.getElementById("suggestions");
const chatListEl = document.getElementById("chatList");
const newChatBtn = document.getElementById("newChatBtn");
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebarClose = document.getElementById("sidebarClose");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const modeButtons = [...document.querySelectorAll(".modes button")];

let mode = "chat";
let busy = false;
/** @type {AbortController | null} */
let activeAbort = null;
/** @type {HTMLElement | null} */
let editingUserEl = null;
let editPending = false;
/** @type {string | null} */
let lastImageB64 = null;
let refineArmed = false;
/** @type {object[]} */
const threadLog = [];

function loadChatModel() {
  try {
    const saved = localStorage.getItem(CHAT_MODEL_KEY);
    if (CHAT_MODELS.includes(saved)) return saved;
  } catch {
    /* ignore */
  }
  return CHAT_MODELS[0];
}

function loadImageModel() {
  try {
    const saved = localStorage.getItem(IMAGE_MODEL_KEY);
    if (IMAGE_MODELS.includes(saved)) return saved;
  } catch {
    /* ignore */
  }
  return IMAGE_MODELS[0];
}

function loadThinkEnabled() {
  try {
    const saved = localStorage.getItem(THINK_KEY);
    if (saved === "0" || saved === "false") return false;
    if (saved === "1" || saved === "true") return true;
  } catch {
    /* ignore */
  }
  return false;
}

function loadSearchEnabled() {
  try {
    const saved = localStorage.getItem(SEARCH_KEY);
    if (saved === "0" || saved === "false") return false;
    if (saved === "1" || saved === "true") return true;
  } catch {
    /* ignore */
  }
  return true;
}

function loadFontSize() {
  try {
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    if (FONT_SIZES.includes(saved)) return saved;
  } catch {
    /* ignore */
  }
  return "md";
}

function applyFontSize(size) {
  const next = FONT_SIZES.includes(size) ? size : "md";
  document.documentElement.dataset.fontSize = next;
  fontSizePicks?.querySelectorAll("button").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.fontSize === next));
  });
  return next;
}

let chatModel = loadChatModel();
chatModelEl.value = chatModel;
let imageModel = loadImageModel();
if (imageModelEl) imageModelEl.value = imageModel;
let thinkEnabled = loadThinkEnabled();
thinkToggleEl.checked = thinkEnabled;
thinkToggleLabel.classList.toggle("on", thinkEnabled);
let searchEnabled = loadSearchEnabled();
searchToggleEl.checked = searchEnabled;
searchToggleLabel.classList.toggle("on", searchEnabled);
let fontSize = applyFontSize(loadFontSize());

const memory = createMemorySystem({
  ollamaUrl: OLLAMA,
  getModel: () => getChatModel(),
  apiBase: location.origin,
});

const history = {
  get length() {
    return memory.conversation.length;
  },
};

const session = createSessionStore({
  memory,
  threadLog,
  getLastImage: () => lastImageB64,
});

function persistSession() {
  session.persistSession();
  refreshChatList();
}

function recordThread(entry, el) {
  const idx = session.recordThread(entry, el);
  refreshChatList();
  return idx;
}

const ui = createUi({
  thread,
  empty,
  statusEl,
  dot,
  refineBanner,
  refineThumb,
  refineLabel,
  editBanner,
  promptEl,
  getHistoryLength: () => history.length,
  recordThread,
  onEditUserBubble: (el) => beginEditUserBubble(el),
  onDeleteFromBubble: (el) => deleteFromBubble(el),
  onRegenerateBubble: (el) => regenerateFromBot(el),
  setLastImage,
  armRefine,
});

const {
  setStatus,
  scrollThreadToBottom,
  updateRefineBanner,
  updateEditBanner,
  addBubble,
  addImageBubble,
  addImagePlaceholder,
  createMemoryCompactCard,
  createToolUseCard,
  restoreToolCard,
} = ui;

function getChatModel() {
  return chatModel;
}

function getImageModel() {
  return imageModel;
}

function modelSupportsThink(model = getChatModel()) {
  return THINK_MODELS.includes(model);
}

function getThinkEnabled() {
  return thinkEnabled && modelSupportsThink();
}

function getSearchEnabled() {
  return searchEnabled;
}

function syncThinkToggleUi() {
  const supported = modelSupportsThink();
  thinkToggleEl.disabled = busy || !supported;
  thinkToggleLabel.classList.toggle("on", getThinkEnabled());
  thinkToggleLabel.classList.toggle("unsupported", !supported);
  thinkToggleLabel.title = supported
    ? "Show model reasoning before the answer"
    : `${getChatModel()} does not support thinking — switch to qwen3.5:9b`;
}

function setLastImage(b64) {
  lastImageB64 = b64;
  session.persistSession();
  refreshChatList();
}

function armRefine() {
  if (!lastImageB64) return;
  refineArmed = true;
  updateRefineBanner({ refineArmed, lastImageB64 });
  promptEl.placeholder = "Describe the change… e.g. “make the neon blue”";
  promptEl.focus();
}

function clearEditState() {
  editPending = false;
  editingUserEl = null;
  updateEditBanner(editPending);
}

function truncateFromBubble(el) {
  const checkpoint = Number(el.dataset.historyBefore);
  if (Number.isFinite(checkpoint)) {
    memory.conversation.truncateTo(Math.max(0, checkpoint));
  }
  const ti = Number(el.dataset.threadIndex);
  if (Number.isFinite(ti)) threadLog.length = Math.max(0, ti);
  let node = el;
  while (node) {
    const next = node.nextSibling;
    node.remove();
    node = next;
  }
  if (!thread.querySelector(".bubble")) {
    if (empty && !empty.parentNode) thread.appendChild(empty);
  }
  session.persistSession();
  refreshChatList();
}

function truncateFromUserBubble(userEl) {
  truncateFromBubble(userEl);
}

function beginEditUserBubble(userEl) {
  if (busy) return;
  const text =
    userEl.dataset.prompt || userEl.querySelector(".user-text")?.textContent || "";
  truncateFromUserBubble(userEl);
  editPending = true;
  editingUserEl = null;
  updateEditBanner(editPending);
  promptEl.value = text;
  promptEl.focus();
  promptEl.setSelectionRange(text.length, text.length);
  setStatus("Edit the prompt, then Send to redo", "ok");
}

function deleteFromBubble(el) {
  if (busy || !el) return;
  const isUser = el.classList.contains("user");
  const label = isUser
    ? "Delete this message and everything after it?"
    : "Delete this and everything after it?";
  if (!confirm(label)) return;
  clearEditState();
  truncateFromBubble(el);
  setStatus("Deleted from here", "ok");
  promptEl.focus();
}

function findPreviousUserBubble(fromEl) {
  let node = fromEl?.previousElementSibling || null;
  while (node) {
    if (node.classList?.contains("bubble") && node.classList.contains("user")) {
      return node;
    }
    node = node.previousElementSibling;
  }
  return null;
}

function regenerateFromBot(botEl) {
  if (busy || !botEl) return;
  const userEl = findPreviousUserBubble(botEl);
  if (!userEl) {
    setStatus("Nothing to regenerate", "err");
    return;
  }
  const prompt =
    userEl.dataset.prompt ||
    userEl.querySelector(".user-text")?.textContent ||
    "";
  if (!prompt.trim()) {
    setStatus("Nothing to regenerate", "err");
    return;
  }

  const checkpoint = Number(userEl.dataset.historyBefore);
  // Drop the prior user turn from model history; runChat will push it again.
  if (Number.isFinite(checkpoint)) {
    memory.conversation.truncateTo(Math.max(0, checkpoint));
  }

  const userTi = Number(userEl.dataset.threadIndex);
  let node = userEl.nextSibling;
  while (node) {
    const next = node.nextSibling;
    node.remove();
    node = next;
  }
  if (Number.isFinite(userTi)) threadLog.length = userTi + 1;
  clearEditState();
  persistSession();
  setStatus("Regenerating…", "busy");
  void runUserTurn(prompt, { skipUserBubble: true });
}

function clearSession() {
  memory.clearConversationMemory();
  threadLog.length = 0;
  lastImageB64 = null;
  refineArmed = false;
  updateRefineBanner({ refineArmed, lastImageB64 });
  clearEditState();
  clearThreadDom();
  session.clearActiveChat();
  refreshChatList();
  setStatus("Chat cleared (facts & RAG kept)", "ok");
  promptEl.focus();
}

function clearThreadDom() {
  thread.querySelectorAll(".bubble, .tool-use, .memory-compact").forEach((n) => n.remove());
  if (empty && !empty.parentNode) thread.appendChild(empty);
}

function paintThreadFromData(data) {
  clearThreadDom();
  memory.clearConversationMemory();
  if (data?.memory?.conversation) {
    memory.importState(data.memory);
  } else if (data?.history?.length) {
    memory.importState({ conversation: data.history, summary: "" });
  }

  threadLog.length = 0;
  const items = data?.thread || [];
  for (const item of items) threadLog.push(item);

  lastImageB64 = data?.lastImage || null;
  refineArmed = false;
  updateRefineBanner({ refineArmed, lastImageB64 });
  clearEditState();

  items.forEach((item, idx) => {
    let el = null;
    if (item.t === "user") {
      el = addBubble("user", item.c, {
        persist: false,
        historyBefore: item.historyBefore,
      });
    } else if (item.t === "system") {
      el = addBubble("system", item.c, {
        persist: false,
        historyBefore: item.historyBefore,
      });
    } else if (item.t === "bot") {
      el = addBubble("bot", item.c, {
        label: item.label,
        md: item.md !== false,
        persist: false,
        historyBefore: item.historyBefore,
      });
    } else if (item.t === "tool") {
      el = restoreToolCard(item)?.el || null;
    } else if (item.t === "image") {
      el = addImageBubble({
        prompt: item.prompt,
        b64: item.missing ? null : item.img,
        label: item.label,
        persist: false,
      });
      if (el && item.historyBefore != null) {
        el.dataset.historyBefore = String(item.historyBefore);
      }
    }
    if (el) el.dataset.threadIndex = String(idx);
  });

  scrollThreadToBottom(true);
}

function restoreSession() {
  const data = session.loadSession();
  if (!data) {
    refreshChatList();
    return false;
  }
  const hasContent =
    data.history?.length ||
    data.memory?.conversation?.length ||
    data.thread.length;
  paintThreadFromData(data);
  refreshChatList();
  return Boolean(hasContent);
}

function refreshChatList() {
  if (!chatListEl) return;
  const chats = session.listChats();
  const activeId = session.getActiveId();
  chatListEl.innerHTML = "";
  for (const c of chats) {
    const row = document.createElement("div");
    row.className = "chat-item";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.dataset.chatId = c.id;
    if (c.id === activeId) row.setAttribute("aria-current", "page");

    const title = document.createElement("span");
    title.className = "chat-item-title";
    title.textContent = c.title || "New chat";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-item-del";
    del.title = "Delete chat";
    del.setAttribute("aria-label", `Delete ${c.title || "chat"}`);
    del.textContent = "✕";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteChatById(c.id);
    });

    row.appendChild(title);
    row.appendChild(del);
    row.addEventListener("click", () => switchToChat(c.id));
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        switchToChat(c.id);
      }
    });
    chatListEl.appendChild(row);
  }
}

function switchToChat(id) {
  if (busy) {
    setStatus("Wait for the current reply to finish", "err");
    return;
  }
  if (!id || id === session.getActiveId()) return;
  if (!session.switchChat(id)) return;
  const data = session.loadSession();
  paintThreadFromData(data);
  refreshChatList();
  promptEl.focus();
  setStatus("Chat loaded", "ok");
  maybeCollapseSidebarOnMobile();
}

function startNewChat() {
  if (busy) {
    setStatus("Wait for the current reply to finish", "err");
    return;
  }
  session.createChat();
  const data = session.loadSession();
  paintThreadFromData(data || { thread: [], history: [], memory: null, lastImage: null });
  refreshChatList();
  promptEl.value = "";
  promptEl.focus();
  setStatus("New chat", "ok");
  maybeCollapseSidebarOnMobile();
}

function deleteChatById(id) {
  if (busy) {
    setStatus("Wait for the current reply to finish", "err");
    return;
  }
  const chats = session.listChats();
  const target = chats.find((c) => c.id === id);
  const label = target?.title || "this chat";
  if (!confirm(`Delete “${label}”?`)) return;
  const wasActive = id === session.getActiveId();
  session.deleteChat(id);
  if (wasActive) {
    const data = session.loadSession();
    paintThreadFromData(data || { thread: [], history: [], memory: null, lastImage: null });
  }
  refreshChatList();
  setStatus("Chat deleted", "ok");
}

function applySidebarCollapsed(collapsed) {
  document.body.dataset.sidebar = collapsed ? "collapsed" : "open";
  const label = collapsed ? "Open sidebar" : "Close sidebar";
  if (sidebarToggle) {
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    sidebarToggle.setAttribute("aria-label", label);
    sidebarToggle.title = label;
  }
  if (sidebarClose) sidebarClose.disabled = collapsed;
  if (sidebarBackdrop) {
    sidebarBackdrop.tabIndex = collapsed ? -1 : 0;
  }
}

function loadSidebarCollapsed() {
  try {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    /* ignore */
  }
  return window.matchMedia("(max-width: 720px)").matches;
}

function setSidebarCollapsed(collapsed) {
  applySidebarCollapsed(collapsed);
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function toggleSidebar() {
  const collapsed = document.body.dataset.sidebar !== "collapsed";
  setSidebarCollapsed(collapsed);
}

function maybeCollapseSidebarOnMobile() {
  if (window.matchMedia("(max-width: 720px)").matches) {
    setSidebarCollapsed(true);
  }
}

function setBusy(on) {
  busy = on;
  form.classList.toggle("busy", on);
  sendBtn.disabled = on;
  stopBtn.classList.toggle("on", on);
  stopBtn.disabled = !on;
  chatModelEl.disabled = on;
  if (imageModelEl) imageModelEl.disabled = on;
  thinkToggleEl.disabled = on || !modelSupportsThink();
  searchToggleEl.disabled = on;
  if (clearChatBtn) clearChatBtn.disabled = on;
  if (exportChatBtn) exportChatBtn.disabled = on;
  if (newChatBtn) newChatBtn.disabled = on;
  suggestionsEl?.querySelectorAll("button").forEach((btn) => {
    btn.disabled = on;
  });
  thread.querySelectorAll(".msg-actions button").forEach((btn) => {
    btn.disabled = on;
  });
}

function stopActive() {
  if (!activeAbort) return;
  activeAbort.abort();
}

function syncMemoryToggles() {
  factsToggleEl.checked = memory.settings.factsEnabled;
  ragToggleEl.checked = memory.settings.ragEnabled;
  summarizeToggleEl.checked = memory.settings.summarizeEnabled;
  rememberToolToggleEl.checked = memory.settings.rememberToolEnabled;
}

function refreshFactList() {
  if (!factListEl) return;
  factListEl.innerHTML = "";
  const facts = memory.facts.list();
  if (!facts.length) {
    factListEl.innerHTML = `<li><span style="color:var(--muted)">No facts yet</span></li>`;
    return;
  }
  for (const f of facts) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = f.text;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => {
      memory.facts.remove(f.id);
      refreshFactList();
      setStatus("Fact removed", "ok");
    });
    li.appendChild(span);
    li.appendChild(btn);
    factListEl.appendChild(li);
  }
}

async function refreshRagStatus() {
  if (!ragStatusEl) return;
  try {
    const h = await memory.rag.health();
    if (!h.ok) {
      ragStatusEl.textContent = "RAG: Ollama unreachable";
      return;
    }
    ragStatusEl.textContent = h.embed_ready
      ? `RAG: ${h.chunks || 0} chunk(s) · ${h.embed_model}`
      : `RAG: pull ${h.embed_model} in Ollama`;
  } catch {
    ragStatusEl.textContent = "RAG: unavailable (is serve.py running?)";
  }
}

const chat = createChatRunner({
  memory,
  getChatModel,
  modelSupportsThink,
  getThinkEnabled,
  getSearchEnabled,
  addBubble,
  persistSession,
  recordThread,
  setStatus,
  scrollThreadToBottom,
  createMemoryCompactCard,
  createToolUseCard,
  refreshFactList,
});

const image = createImageRunner({
  addBubble,
  addImageBubble,
  addImagePlaceholder,
  setLastImage,
  clearRefineArmed: () => {
    refineArmed = false;
  },
  updateRefineBanner: () => updateRefineBanner({ refineArmed, lastImageB64 }),
  getImageModel,
});

async function runUserTurn(prompt, { skipUserBubble = false } = {}) {
  if (busy) return;
  const text = String(prompt || "").trim();
  if (!text) return;

  const controller = new AbortController();
  activeAbort = controller;
  setBusy(true);
  if (!skipUserBubble) {
    promptEl.value = "";
    promptEl.style.height = "auto";
    clearEditState();
    addBubble("user", text);
  }
  setStatus("Working…", "busy");

  try {
    const chosen = await resolveMode(text, {
      mode,
      signal: controller.signal,
      getChatModel,
      lastImageB64,
      refineArmed,
    });
    if (controller.signal.aborted) throw new StoppedError();
    if (chosen === "refine") {
      if (!lastImageB64)
        throw new Error("No image to refine yet — generate one first.");
      setStatus("Refining…", "busy");
      await image.runImage(text, {
        sourceB64: lastImageB64,
        signal: controller.signal,
      });
    } else if (chosen === "image") {
      setStatus("Painting…", "busy");
      await image.runImage(text, { signal: controller.signal });
    } else {
      setStatus("Thinking…", "busy");
      await chat.runChat(text, controller.signal);
    }
    setStatus("Ready", "ok");
  } catch (err) {
    if (isAbortError(err)) {
      addBubble("system", "Stopped");
      setStatus("Stopped", "ok");
    } else {
      addBubble("system", String(err.message || err));
      setStatus(String(err.message || err), "err");
    }
  } finally {
    activeAbort = null;
    setBusy(false);
    refreshChatList();
    promptEl.focus();
  }
}

async function checkOllama(restoredExchanges) {
  try {
    const res = await fetch(`${OLLAMA}/api/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let fluxOk = false;
    try {
      const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
      fluxOk = (tags.models || []).some((m) =>
        (m.name || "").includes("flux2-klein")
      );
    } catch {
      /* ignore */
    }

    let searchOk = false;
    let ragReady = false;
    let ragDetail = null;
    try {
      const health = await fetch(`${location.origin}/api/health`).then((r) =>
        r.json()
      );
      searchOk = Boolean(health?.search);
      ragDetail = health?.rag_detail || null;
      ragReady = Boolean(health?.rag && ragDetail?.embed_ready);
    } catch {
      /* ignore */
    }

    const bits = [`Ollama ${data.version}`];
    bits.push(fluxOk ? "flux ready" : "no flux");
    bits.push(searchOk ? "local search ready" : "restart serve.py for search");
    if (ragReady) bits.push("RAG ready");
    else if (ragDetail?.ok === false) bits.push("RAG offline");
    else if (ragDetail && ragDetail.embed_ready === false)
      bits.push(`pull ${ragDetail.embed_model || "nomic-embed-text"}`);
    if (restoredExchanges > 0) bits.push(`${restoredExchanges} chat(s) restored`);
    setStatus(bits.join(" · "), searchOk && fluxOk ? "ok" : "err");
    refreshRagStatus();
    return true;
  } catch {
    setStatus(
      "Ollama not reachable at 127.0.0.1:11434 — open the Ollama app",
      "err"
    );
    return false;
  }
}

/* ——— Settings listeners ——— */

chatModelEl.addEventListener("change", () => {
  const next = chatModelEl.value;
  if (!CHAT_MODELS.includes(next)) return;
  chatModel = next;
  try {
    localStorage.setItem(CHAT_MODEL_KEY, chatModel);
  } catch {
    /* ignore */
  }
  syncThinkToggleUi();
  const thinkNote = modelSupportsThink()
    ? thinkEnabled
      ? " · Think on"
      : ""
    : " · Think unavailable";
  setStatus(`Chat model → ${chatModel}${thinkNote}`, "ok");
});

imageModelEl?.addEventListener("change", () => {
  const next = imageModelEl.value;
  if (!IMAGE_MODELS.includes(next)) return;
  imageModel = next;
  try {
    localStorage.setItem(IMAGE_MODEL_KEY, imageModel);
  } catch {
    /* ignore */
  }
  setStatus(`Image model → ${imageModel}`, "ok");
});

thinkToggleEl.addEventListener("change", () => {
  if (!modelSupportsThink()) {
    thinkToggleEl.checked = false;
    syncThinkToggleUi();
    setStatus(`${getChatModel()} does not support thinking`, "err");
    return;
  }
  thinkEnabled = thinkToggleEl.checked;
  try {
    localStorage.setItem(THINK_KEY, thinkEnabled ? "1" : "0");
  } catch {
    /* ignore */
  }
  syncThinkToggleUi();
  setStatus(thinkEnabled ? "Thinking on" : "Thinking off", "ok");
});

searchToggleEl.addEventListener("change", () => {
  searchEnabled = searchToggleEl.checked;
  searchToggleLabel.classList.toggle("on", searchEnabled);
  try {
    localStorage.setItem(SEARCH_KEY, searchEnabled ? "1" : "0");
  } catch {
    /* ignore */
  }
  setStatus(searchEnabled ? "Web search on (local ddgs)" : "Web search off", "ok");
});

fontSizePicks?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-font-size]");
  if (!btn || busy) return;
  fontSize = applyFontSize(btn.dataset.fontSize);
  try {
    localStorage.setItem(FONT_SIZE_KEY, fontSize);
  } catch {
    /* ignore */
  }
  const labels = { sm: "Small", md: "Medium", lg: "Large", xl: "Extra large" };
  setStatus(`Text size → ${labels[fontSize] || fontSize}`, "ok");
});

syncMemoryToggles();
refreshFactList();
refreshRagStatus();

factsToggleEl?.addEventListener("change", () => {
  memory.settings.factsEnabled = factsToggleEl.checked;
  memory.persistSettings();
  setStatus(memory.settings.factsEnabled ? "Facts on" : "Facts off", "ok");
});
ragToggleEl?.addEventListener("change", () => {
  memory.settings.ragEnabled = ragToggleEl.checked;
  memory.persistSettings();
  setStatus(memory.settings.ragEnabled ? "Local RAG on" : "Local RAG off", "ok");
});
summarizeToggleEl?.addEventListener("change", () => {
  memory.settings.summarizeEnabled = summarizeToggleEl.checked;
  memory.persistSettings();
  setStatus(
    memory.settings.summarizeEnabled ? "Auto-summarize on" : "Auto-summarize off",
    "ok"
  );
});
rememberToolToggleEl?.addEventListener("change", () => {
  memory.settings.rememberToolEnabled = rememberToolToggleEl.checked;
  memory.persistSettings();
  setStatus(
    memory.settings.rememberToolEnabled
      ? "remember_fact tool on"
      : "remember_fact tool off",
    "ok"
  );
});

addFactBtn?.addEventListener("click", () => {
  const text = factInputEl?.value.trim() || "";
  if (!text) return;
  memory.facts.add(text);
  factInputEl.value = "";
  refreshFactList();
  setStatus("Fact saved", "ok");
});
factInputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addFactBtn?.click();
  }
});

ragIngestBtn?.addEventListener("click", async () => {
  const text = ragInputEl?.value.trim() || "";
  if (!text) return;
  ragIngestBtn.disabled = true;
  setStatus("Embedding note…", "busy");
  try {
    const result = await memory.rag.ingest(text, { source: "settings" });
    ragInputEl.value = "";
    await refreshRagStatus();
    setStatus(`RAG: added ${result.added || 0} chunk(s)`, "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  } finally {
    ragIngestBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", () => {
  if (!busy) return;
  stopActive();
  setStatus("Stopping…", "busy");
});

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode;
    modeButtons.forEach((b) =>
      b.setAttribute("aria-pressed", String(b === btn))
    );
  });
});

clearRefineBtn.addEventListener("click", () => {
  refineArmed = false;
  updateRefineBanner({ refineArmed, lastImageB64 });
  promptEl.focus();
});

clearEditBtn.addEventListener("click", () => {
  clearEditState();
  promptEl.value = "";
  promptEl.focus();
  setStatus("Edit cancelled", "ok");
});

clearChatBtn?.addEventListener("click", () => {
  if (busy) return;
  if (memory.conversation.length === 0 && threadLog.length === 0) {
    setStatus("Nothing to clear", "ok");
    return;
  }
  if (!confirm("Clear this chat’s messages? (Facts & RAG notes are kept)"))
    return;
  clearSession();
});

exportChatBtn?.addEventListener("click", () => {
  if (!threadLog.length) {
    setStatus("Nothing to export", "ok");
    return;
  }
  const title =
    session.listChats().find((c) => c.id === session.getActiveId())?.title ||
    "MyChat";
  const md = threadToMarkdown(threadLog, { title });
  const safe = String(title)
    .replace(/[^\w\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "mychat";
  downloadText(`${safe}.md`, md);
  setStatus("Chat exported", "ok");
});

suggestionsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-prompt]");
  if (!btn || busy) return;
  const text = btn.dataset.prompt || "";
  if (!text) return;
  const forcedMode = btn.dataset.mode;
  if (forcedMode === "chat" || forcedMode === "image") {
    mode = forcedMode;
    modeButtons.forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode))
    );
  }
  promptEl.value = text;
  promptEl.focus();
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 180)}px`;
  form.requestSubmit();
});

newChatBtn?.addEventListener("click", () => startNewChat());

sidebarToggle?.addEventListener("click", () => toggleSidebar());
sidebarClose?.addEventListener("click", () => setSidebarCollapsed(true));
sidebarBackdrop?.addEventListener("click", () => setSidebarCollapsed(true));

document.addEventListener("keydown", (e) => {
  if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
  e.preventDefault();
  toggleSidebar();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  await runUserTurn(prompt);
});

promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 180)}px`;
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && busy) {
    e.preventDefault();
    stopActive();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

document.addEventListener("click", (e) => {
  const settings = document.getElementById("settings");
  if (settings?.open && !settings.contains(e.target)) settings.open = false;

  const link = e.target.closest?.("a[href]");
  if (!link || !document.querySelector(".app")?.contains(link)) return;
  const href = link.getAttribute("href") || "";
  if (href.startsWith("#")) return;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
});

applySidebarCollapsed(loadSidebarCollapsed());
const restored = restoreSession();
const restoredExchanges = restored ? memory.conversation.userTurnCount() : 0;
syncThinkToggleUi();
checkOllama(restoredExchanges);
