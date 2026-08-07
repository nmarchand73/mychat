/**
 * Intent: build thread DOM (bubbles, tool cards, banners, status, scroll).
 * Architecture: factory `createUi(deps)` returns helpers; persistence / edit /
 * delete / regenerate callbacks stay injected — presentation only.
 * Includes ChatGPT-style image wait tile + top-down frosted reveal on arrival.
 * Quality: 8/10 — double-rAF frosted wipe, reduced-motion skip, frost cleanup; no reveal on restore.
 */

import { renderMarkdown, setWorkingPhase } from "./markdown.js";
import { escapeHtml } from "./util.js";

/**
 * @param {{
 *   thread: HTMLElement,
 *   empty: HTMLElement | null,
 *   statusEl: HTMLElement,
 *   dot: HTMLElement,
 *   refineBanner: HTMLElement,
 *   refineThumb: HTMLImageElement,
 *   refineLabel: HTMLElement,
 *   editBanner: HTMLElement,
 *   promptEl: HTMLTextAreaElement,
 *   getHistoryLength: () => number,
 *   recordThread: (entry: object, el?: HTMLElement) => number,
 *   onEditUserBubble: (el: HTMLElement) => void,
 *   onDeleteFromBubble: (el: HTMLElement) => void,
 *   onRegenerateBubble?: (el: HTMLElement) => void,
 *   setLastImage: (b64: string) => void,
 *   armRefine: () => void,
 * }} deps
 */
export function createUi(deps) {
  const {
    thread,
    empty,
    statusEl,
    dot,
    refineBanner,
    refineThumb,
    refineLabel,
    editBanner,
    promptEl,
    getHistoryLength,
    recordThread,
    onEditUserBubble,
    onDeleteFromBubble,
    onRegenerateBubble,
    setLastImage,
    armRefine,
  } = deps;

  function attachMsgActions(el, { edit = false, regenerate = false } = {}) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    if (edit) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onEditUserBubble(el);
      });
      actions.appendChild(editBtn);
    }
    if (regenerate && typeof onRegenerateBubble === "function") {
      const regenBtn = document.createElement("button");
      regenBtn.type = "button";
      regenBtn.textContent = "Regenerate";
      regenBtn.title = "Redo from the previous user message";
      regenBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onRegenerateBubble(el);
      });
      actions.appendChild(regenBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.title = "Delete this and everything after";
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onDeleteFromBubble(el);
    });
    actions.appendChild(delBtn);
    el.appendChild(actions);
  }

  function isThreadNearBottom(px = 96) {
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight <= px;
  }

  function scrollThreadToBottom(force = false) {
    if (force || isThreadNearBottom()) {
      thread.scrollTop = thread.scrollHeight;
    }
  }

  function setStatus(text, state = "ok") {
    statusEl.textContent = text;
    dot.classList.toggle("busy", state === "busy");
    dot.classList.toggle("err", state === "err");
  }

  function clearEmpty() {
    empty?.remove();
  }

  function updateRefineBanner({ refineArmed, lastImageB64 }) {
    if (refineArmed && lastImageB64) {
      refineBanner.classList.add("on");
      refineThumb.src = `data:image/png;base64,${lastImageB64}`;
      refineLabel.textContent = "Next prompt will refine this image";
    } else {
      refineBanner.classList.remove("on");
    }
  }

  function updateEditBanner(editPending) {
    editBanner.classList.toggle("on", editPending);
  }

  function addBubble(
    role,
    content,
    {
      html = false,
      label = null,
      md = false,
      persist = true,
      historyBefore = null,
    } = {}
  ) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = `bubble ${role}`;
    if (historyBefore != null) {
      el.dataset.historyBefore = String(Number(historyBefore));
    }
    if (label) {
      const lab = document.createElement("span");
      lab.className = "label";
      lab.textContent = label;
      el.appendChild(lab);
    }

    if (role === "user") {
      const before =
        historyBefore != null ? Number(historyBefore) : getHistoryLength();
      el.dataset.prompt = content;
      el.dataset.historyBefore = String(before);
      const text = document.createElement("span");
      text.className = "user-text";
      text.textContent = content;
      el.appendChild(text);

      attachMsgActions(el, { edit: true });

      el.title = "Double-click to edit";
      el.addEventListener("dblclick", () => onEditUserBubble(el));
      if (persist) {
        recordThread({ t: "user", c: content, historyBefore: before }, el);
      }
    } else if (md) {
      const before =
        historyBefore != null ? Number(historyBefore) : getHistoryLength();
      el.dataset.historyBefore = String(before);
      const body = document.createElement("div");
      body.className = "md";
      body.innerHTML = renderMarkdown(content);
      el.appendChild(body);
      attachMsgActions(el, { regenerate: true });
      if (persist) {
        recordThread(
          { t: "bot", c: content, label, md: true, historyBefore: before },
          el
        );
      }
    } else if (html) {
      el.insertAdjacentHTML("beforeend", content);
    } else {
      if (content) el.appendChild(document.createTextNode(content));
      const before =
        historyBefore != null ? Number(historyBefore) : getHistoryLength();
      el.dataset.historyBefore = String(before);
      if (role === "bot" || role === "system") {
        attachMsgActions(el, { regenerate: role === "bot" });
      }
      if (persist && role === "system") {
        recordThread(
          { t: "system", c: content, historyBefore: before },
          el
        );
      }
    }

    thread.appendChild(el);
    scrollThreadToBottom(true);
    return el;
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  function addImageBubble({
    prompt,
    b64,
    label,
    persist = true,
    reveal = false,
  }) {
    const before = getHistoryLength();
    const src = b64 ? `data:image/png;base64,${b64}` : "";
    const bot = addBubble("bot", "", {
      label,
      persist: false,
      historyBefore: before,
    });
    if (b64) {
      const useReveal = reveal && !prefersReducedMotion();
      if (useReveal) {
        const wrap = document.createElement("div");
        wrap.className = "img-reveal";
        const img = document.createElement("img");
        img.className = "img-reveal-photo";
        img.src = src;
        img.alt = prompt;
        const frost = document.createElement("div");
        frost.className = "img-reveal-frost";
        frost.setAttribute("aria-hidden", "true");
        wrap.appendChild(img);
        wrap.appendChild(frost);
        bot.appendChild(wrap);
        // Double rAF so the frost starts covering, then slides down.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            wrap.classList.add("is-revealed");
          });
        });
        frost.addEventListener(
          "transitionend",
          () => {
            frost.remove();
            wrap.classList.add("is-done");
          },
          { once: true }
        );
      } else {
        const img = document.createElement("img");
        img.src = src;
        img.alt = prompt;
        bot.appendChild(img);
      }
    } else {
      const note = document.createElement("div");
      note.className = "md";
      note.innerHTML = renderMarkdown(
        "_Image unavailable after restart (storage limit)._"
      );
      bot.appendChild(note);
    }

    const actions = document.createElement("div");
    actions.className = "img-actions";

    if (b64) {
      const link = document.createElement("a");
      link.href = src;
      link.download = `mychat-${Date.now()}.png`;
      link.textContent = "Download PNG";

      const refineBtn = document.createElement("button");
      refineBtn.type = "button";
      refineBtn.textContent = "Refine this";
      refineBtn.addEventListener("click", () => {
        setLastImage(b64);
        armRefine();
      });

      actions.appendChild(link);
      actions.appendChild(refineBtn);
      bot.appendChild(actions);
    }

    if (persist) {
      recordThread(
        {
          t: "image",
          prompt,
          label,
          img: b64 || null,
          missing: !b64,
          historyBefore: Number(bot.dataset.historyBefore) || before,
        },
        bot
      );
    }
    const actionBar = bot.querySelector(".msg-actions");
    if (actionBar) bot.appendChild(actionBar);
    scrollThreadToBottom(true);
    return bot;
  }

  /** ChatGPT-style shimmer tile + status line while Flux runs. */
  function addImagePlaceholder({ label, message }) {
    const bot = addBubble("bot", "", { label, persist: false });
    bot.classList.add("is-generating", "is-image-gen");
    bot.querySelector(".msg-actions")?.remove();

    const wrap = document.createElement("div");
    wrap.className = "img-placeholder";
    wrap.setAttribute("aria-busy", "true");
    wrap.setAttribute("aria-live", "polite");

    const frame = document.createElement("div");
    frame.className = "img-placeholder-frame";
    frame.setAttribute("aria-hidden", "true");

    const msg = document.createElement("p");
    msg.className = "img-placeholder-msg";
    msg.innerHTML =
      `<span class="phase-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="img-placeholder-text">${escapeHtml(message)}</span>`;

    wrap.appendChild(frame);
    wrap.appendChild(msg);
    bot.appendChild(wrap);
    scrollThreadToBottom(true);
    return bot;
  }

  function createMemoryCompactCard({ beforeEl }) {
    const details = document.createElement("details");
    details.className = "memory-compact running";

    const summary = document.createElement("summary");
    summary.innerHTML = `
      <span class="mc-icon" aria-hidden="true">⋈</span>
      <span class="mc-title">
        <span class="mc-name">memory_compact</span>
        <span class="mc-preview">Compressing older turns…</span>
      </span>
      <span class="mc-status">Running</span>
    `;

    const body = document.createElement("div");
    body.className = "mc-body";
    body.textContent = "Folding prior messages into a durable summary…";

    details.appendChild(summary);
    details.appendChild(body);

    const previewEl = summary.querySelector(".mc-preview");
    const statusNode = summary.querySelector(".mc-status");

    if (beforeEl?.parentNode) beforeEl.parentNode.insertBefore(details, beforeEl);
    else thread.appendChild(details);
    scrollThreadToBottom();

    return {
      el: details,
      setRunning() {
        details.classList.add("running");
        details.classList.remove("done");
        statusNode.textContent = "Running";
        previewEl.textContent = "Compressing older turns…";
        body.textContent = "Folding prior messages into a durable summary…";
      },
      setDone({ dropped = 0, summaryText = "" } = {}) {
        details.classList.remove("running");
        details.classList.add("done");
        statusNode.textContent = "Compacted";
        previewEl.textContent = dropped
          ? `${dropped} message${dropped === 1 ? "" : "s"} folded into summary`
          : "Context compacted";
        body.textContent = String(summaryText || "").trim() || "(empty summary)";
        scrollThreadToBottom();
      },
      remove() {
        details.remove();
      },
    };
  }

  function createToolUseCard({
    name,
    input,
    beforeEl,
    persist = true,
    restored = null,
  }) {
    let shouldPersist = Boolean(persist) && !restored;
    const details = document.createElement("details");
    details.className = "tool-use running";

    const summary = document.createElement("summary");
    summary.innerHTML = `
      <span class="tool-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
      </span>
      <span class="tool-title">
        <span class="tool-name"></span>
        <span class="tool-preview"></span>
      </span>
      <span class="tool-status">Running</span>
      <span class="tool-chevron" aria-hidden="true"></span>
    `;

    const body = document.createElement("div");
    body.className = "tool-body";

    const reqWrap = document.createElement("div");
    reqWrap.innerHTML = `<div class="tool-section-label">Request</div>`;
    const inputEl = document.createElement("pre");
    inputEl.className = "tool-input";
    inputEl.textContent =
      typeof input === "string" ? input : JSON.stringify(input, null, 2);
    reqWrap.appendChild(inputEl);

    const resWrap = document.createElement("div");
    resWrap.innerHTML = `<div class="tool-section-label">Response</div>`;
    const resultsEl = document.createElement("div");
    resultsEl.className = "tool-results";
    resultsEl.innerHTML = `<div class="tool-empty">Waiting for results…</div>`;
    resWrap.appendChild(resultsEl);

    body.appendChild(reqWrap);
    body.appendChild(resWrap);
    details.appendChild(summary);
    details.appendChild(body);

    const nameEl = summary.querySelector(".tool-name");
    const previewEl = summary.querySelector(".tool-preview");
    const toolStatusEl = summary.querySelector(".tool-status");
    nameEl.textContent = name === "web_search" ? "web_search" : name;

    const query = input?.query || "";
    previewEl.textContent = query ? `query: ${query}` : "Preparing…";

    if (beforeEl?.parentNode) beforeEl.parentNode.insertBefore(details, beforeEl);
    else thread.appendChild(details);
    scrollThreadToBottom();

    const card = {
      el: details,
      setRunning() {
        details.classList.remove("done", "error");
        details.classList.add("running");
        toolStatusEl.textContent = "Running";
        previewEl.textContent = query ? `query: ${query}` : "Running…";
      },
      setDone(results) {
        details.classList.remove("running", "error");
        details.classList.add("done");
        const n = Array.isArray(results) ? results.length : 0;
        toolStatusEl.textContent = "Completed";
        previewEl.textContent = query
          ? `query: ${query} · ${n} result${n === 1 ? "" : "s"}`
          : `${n} result${n === 1 ? "" : "s"}`;

        resultsEl.innerHTML = "";
        if (!n) {
          resultsEl.innerHTML = `<div class="tool-empty">No results found.</div>`;
        } else {
          for (const r of results) {
            const item = document.createElement("div");
            item.className = "tool-result";
            const title = escapeHtml(r.title || r.url || "Result");
            const url = escapeHtml(r.url || "");
            const snippet = escapeHtml(r.snippet || "");
            item.innerHTML = `
              <a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a>
              <div class="url">${url}</div>
              ${snippet ? `<div class="snippet">${snippet}</div>` : ""}
            `;
            resultsEl.appendChild(item);
          }
        }
        if (shouldPersist && !details.dataset.threadIndex) {
          recordThread(
            {
              t: "tool",
              name,
              input,
              results: Array.isArray(results) ? results : [],
              status: "done",
              historyBefore: getHistoryLength(),
            },
            details
          );
          shouldPersist = false;
        }
        scrollThreadToBottom();
      },
      setError(message) {
        details.classList.remove("running", "done");
        details.classList.add("error");
        details.open = true;
        toolStatusEl.textContent = "Failed";
        previewEl.textContent = query ? `query: ${query}` : "Error";
        resultsEl.innerHTML = `<div class="tool-error-text">${escapeHtml(
          message || "Tool failed"
        )}</div>`;
        if (shouldPersist && !details.dataset.threadIndex) {
          recordThread(
            {
              t: "tool",
              name,
              input,
              results: [],
              status: "error",
              error: String(message || "Tool failed"),
              historyBefore: getHistoryLength(),
            },
            details
          );
          shouldPersist = false;
        }
      },
    };

    if (restored?.status === "error") {
      card.setError(restored.error || "Tool failed");
    } else if (restored) {
      card.setDone(restored.results || []);
    }

    return card;
  }

  function restoreToolCard(item) {
    return createToolUseCard({
      name: item.name || "tool",
      input: item.input || {},
      beforeEl: null,
      persist: false,
      restored: item,
    });
  }

  return {
    isThreadNearBottom,
    scrollThreadToBottom,
    setStatus,
    clearEmpty,
    updateRefineBanner,
    updateEditBanner,
    addBubble,
    addImageBubble,
    addImagePlaceholder,
    createMemoryCompactCard,
    createToolUseCard,
    restoreToolCard,
    setWorkingPhase,
  };
}
