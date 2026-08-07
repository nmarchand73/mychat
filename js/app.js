/**
 * Intent: boot the UI, own mutable app state, wire user events.
 * Architecture: composition root — imports factories (ui/chat/image/session/memory)
 * and holds mode/busy/session flags; no heavy chat/image logic lives here.
 */

import { createMemorySystem } from "./memory/orchestrator.js";
import {
  OLLAMA,
  CHAT_MODELS,
  THINK_MODELS,
  CHAT_MODEL_KEY,
  THINK_KEY,
  SEARCH_KEY,
  FONT_SIZE_KEY,
  FONT_SIZES,
} from "./config.js";
import { createSessionStore } from "./session.js";
import { createUi } from "./ui.js";
import { createChatRunner } from "./chat.js";
import { createImageRunner } from "./image.js";
import { resolveMode } from "./intent.js";
import { isAbortError, StoppedError } from "./util.js";

const thread = document.getElementById("thread");
const empty = document.getElementById("empty");
const form = document.getElementById("form");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const chatModelEl = document.getElementById("chatModel");
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
const modeButtons = [...document.querySelectorAll(".modes button")];

let mode = "auto";
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
  recordThread: session.recordThread,
  onEditUserBubble: (el) => beginEditUserBubble(el),
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
  createMemoryCompactCard,
  createToolUseCard,
} = ui;

function getChatModel() {
  return chatModel;
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

function truncateFromUserBubble(userEl) {
  const checkpoint = Number(userEl.dataset.historyBefore || 0);
  memory.conversation.truncateTo(Math.max(0, checkpoint));
  const ti = Number(userEl.dataset.threadIndex);
  if (Number.isFinite(ti)) threadLog.length = Math.max(0, ti);
  let node = userEl;
  while (node) {
    const next = node.nextSibling;
    node.remove();
    node = next;
  }
  session.persistSession();
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

function clearSession() {
  memory.clearConversationMemory();
  threadLog.length = 0;
  lastImageB64 = null;
  refineArmed = false;
  updateRefineBanner({ refineArmed, lastImageB64 });
  clearEditState();
  thread.querySelectorAll(".bubble, .tool-use").forEach((n) => n.remove());
  if (empty && !empty.parentNode) thread.appendChild(empty);
  session.wipeStorage();
  setStatus("History cleared (facts & RAG kept)", "ok");
  promptEl.focus();
}

function restoreSession() {
  const data = session.loadSession();
  if (
    !data ||
    (!data.history?.length &&
      !data.memory?.conversation?.length &&
      !data.thread.length)
  ) {
    return false;
  }

  memory.clearConversationMemory();
  if (data.memory?.conversation) {
    memory.importState(data.memory);
  } else if (data.history?.length) {
    memory.importState({ conversation: data.history, summary: "" });
  }

  threadLog.length = 0;
  for (const item of data.thread) threadLog.push(item);

  lastImageB64 = data.lastImage;
  refineArmed = false;
  updateRefineBanner({ refineArmed, lastImageB64 });

  data.thread.forEach((item, idx) => {
    let el = null;
    if (item.t === "user") {
      el = addBubble("user", item.c, {
        persist: false,
        historyBefore: item.historyBefore,
      });
    } else if (item.t === "system") {
      el = addBubble("system", item.c, { persist: false });
    } else if (item.t === "bot") {
      el = addBubble("bot", item.c, {
        label: item.label,
        md: item.md !== false,
        persist: false,
      });
    } else if (item.t === "image") {
      el = addImageBubble({
        prompt: item.prompt,
        b64: item.missing ? null : item.img,
        label: item.label,
        persist: false,
      });
    }
    if (el) el.dataset.threadIndex = String(idx);
  });

  scrollThreadToBottom(true);
  return true;
}

function setBusy(on) {
  busy = on;
  form.classList.toggle("busy", on);
  sendBtn.disabled = on;
  stopBtn.classList.toggle("on", on);
  stopBtn.disabled = !on;
  chatModelEl.disabled = on;
  thinkToggleEl.disabled = on || !modelSupportsThink();
  searchToggleEl.disabled = on;
  if (clearChatBtn) clearChatBtn.disabled = on;
  thread.querySelectorAll(".bubble.user .msg-actions button").forEach((btn) => {
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
  persistSession: session.persistSession,
  recordThread: session.recordThread,
  setStatus,
  scrollThreadToBottom,
  createMemoryCompactCard,
  createToolUseCard,
  refreshFactList,
});

const image = createImageRunner({
  addBubble,
  addImageBubble,
  setLastImage,
  clearRefineArmed: () => {
    refineArmed = false;
  },
  updateRefineBanner: () => updateRefineBanner({ refineArmed, lastImageB64 }),
});

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
  if (!confirm("Clear the conversation history? (Facts & RAG notes are kept)"))
    return;
  clearSession();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  const controller = new AbortController();
  activeAbort = controller;
  setBusy(true);
  promptEl.value = "";
  promptEl.style.height = "auto";
  clearEditState();
  addBubble("user", prompt);
  setStatus(mode === "auto" ? "Detecting…" : "Working…", "busy");

  try {
    const chosen = await resolveMode(prompt, {
      mode,
      signal: controller.signal,
      getChatModel,
      lastImageB64,
      refineArmed,
    });
    if (controller.signal.aborted) throw new StoppedError();
    if (mode === "auto") {
      const label =
        chosen === "refine"
          ? "Auto → Refine"
          : chosen === "image"
            ? "Auto → Image"
            : "Auto → Chat";
      addBubble("system", label);
    }
    if (chosen === "refine") {
      if (!lastImageB64)
        throw new Error("No image to refine yet — generate one first.");
      setStatus("Refining…", "busy");
      await image.runImage(prompt, {
        sourceB64: lastImageB64,
        signal: controller.signal,
      });
    } else if (chosen === "image") {
      setStatus("Painting…", "busy");
      await image.runImage(prompt, { signal: controller.signal });
    } else {
      setStatus("Thinking…", "busy");
      await chat.runChat(prompt, controller.signal);
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
    promptEl.focus();
  }
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

const restored = restoreSession();
const restoredExchanges = restored ? memory.conversation.userTurnCount() : 0;
syncThinkToggleUi();
checkOllama(restoredExchanges);
