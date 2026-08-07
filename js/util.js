/**
 * Intent: tiny shared primitives used across modules.
 * Architecture: no deps — StoppedError, abort detection, HTML escaping.
 */

export class StoppedError extends Error {
  constructor(message = "Stopped") {
    super(message);
    this.name = "StoppedError";
  }
}

export function isAbortError(err) {
  return (
    err?.name === "AbortError" ||
    err?.name === "StoppedError" ||
    /aborted|The user aborted|Stopped/i.test(String(err?.message || err || ""))
  );
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
