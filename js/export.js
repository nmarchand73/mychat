/**
 * Intent: turn a UI threadLog into a portable Markdown export.
 * Architecture: pure formatter — no DOM; maps t=user|bot|system|tool|image.
 * Quality: 8/10 — focused; image export is link stub only (no binary embed)
 */

/**
 * @param {object[]} thread
 * @param {{ title?: string }} [opts]
 */
export function threadToMarkdown(thread, { title = "MyChat" } = {}) {
  const lines = [`# ${title}`, ""];
  for (const item of thread || []) {
    if (!item || typeof item !== "object") continue;
    if (item.t === "user") {
      lines.push("## You", "", String(item.c || "").trim(), "");
    } else if (item.t === "bot") {
      const label = item.label ? ` (${item.label})` : "";
      lines.push(`## Assistant${label}`, "", String(item.c || "").trim(), "");
    } else if (item.t === "system") {
      lines.push(`_${String(item.c || "").trim()}_`, "");
    } else if (item.t === "tool") {
      const name = item.name || "tool";
      const q = item.input?.query ? ` — ${item.input.query}` : "";
      lines.push(`### Tool: ${name}${q}`, "");
      if (item.status === "error") {
        lines.push(`Error: ${item.error || "failed"}`, "");
      } else if (Array.isArray(item.results)) {
        for (const r of item.results) {
          const t = r.title || r.url || "Result";
          const url = r.url || "";
          lines.push(`- [${t}](${url})`);
          if (r.snippet) lines.push(`  - ${r.snippet}`);
        }
        lines.push("");
      }
    } else if (item.t === "image") {
      lines.push(
        `## Image${item.label ? ` (${item.label})` : ""}`,
        "",
        item.prompt ? `Prompt: ${item.prompt}` : "_Image_",
        item.missing || !item.img
          ? "_Image binary not included in export._"
          : "_Image attached in session (base64 omitted from Markdown)._",
        ""
      );
    }
  }
  return lines.join("\n").trim() + "\n";
}

export function downloadText(filename, text, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
