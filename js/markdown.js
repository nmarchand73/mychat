/**
 * Intent: turn model text into safe HTML; parse/display <think> blocks.
 * Architecture: marked → DOMPurify → force links to new tabs; thought UI
 * is a small details/summary widget used by the chat stream painter.
 */

import { escapeHtml } from "./util.js";

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*<think>[\s\S]*$/i, "")
    .trim();
}

export function extractThinkTags(text) {
  const raw = String(text || "");
  const parts = [];
  let rest = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_, t) => {
    parts.push(String(t).trim());
    return "";
  });
  const open = rest.match(/^\s*<think>([\s\S]*)$/i);
  if (open) {
    parts.push(String(open[1]).trim());
    rest = "";
  }
  return { thinking: parts.filter(Boolean).join("\n\n"), content: rest.trim() };
}

export function formatThoughtMeta(thinking, { streaming = false } = {}) {
  if (streaming && !thinking.trim()) return "…";
  if (streaming) return "briefly";
  const words = thinking.trim().split(/\s+/).filter(Boolean).length;
  if (!words) return "";
  if (words < 40) return "briefly";
  if (words < 120) return "for a moment";
  return "for a bit";
}

export function createThoughtBlock() {
  const details = document.createElement("details");
  details.className = "thought";
  details.hidden = true;

  const summary = document.createElement("summary");
  summary.innerHTML =
    '<span class="thought-label">Thought</span> ' +
    '<span class="thought-meta"></span> ' +
    '<span class="chevron" aria-hidden="true"></span>';

  const body = document.createElement("div");
  body.className = "thought-body";

  details.appendChild(summary);
  details.appendChild(body);
  return {
    el: details,
    metaEl: summary.querySelector(".thought-meta"),
    bodyEl: body,
    update(thinking, { streaming = false } = {}) {
      const t = String(thinking || "").trim();
      if (!t && !streaming) {
        details.hidden = true;
        details.classList.remove("streaming");
        return;
      }
      details.hidden = false;
      details.classList.toggle("streaming", streaming);
      this.metaEl.textContent = formatThoughtMeta(t, { streaming });
      this.bodyEl.textContent = t || "…";
    },
    finish(thinking) {
      this.update(thinking, { streaming: false });
      details.classList.remove("streaming");
    },
  };
}

export function openLinksInNewTab(root) {
  if (!root) return;
  root.querySelectorAll("a[href]").forEach((a) => {
    // Keep same-tab only for pure page anchors
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}

export function renderMarkdown(text) {
  const cleaned = stripThink(text);
  const html = marked.parse(cleaned || "");
  const sanitized = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel"],
    USE_PROFILES: { html: true },
  });
  const wrap = document.createElement("div");
  wrap.innerHTML = sanitized;
  openLinksInNewTab(wrap);
  return wrap.innerHTML;
}

export function setMarkdown(bodyEl, text) {
  bodyEl.innerHTML = renderMarkdown(text);
}

export function setWorkingPhase(bodyEl, text) {
  bodyEl.innerHTML =
    `<p class="phase" aria-live="polite"><span class="phase-dot" aria-hidden="true"></span>${escapeHtml(text)}</p>`;
}
