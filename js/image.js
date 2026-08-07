/**
 * Intent: generate or refine images via Ollama Flux (`/api/generate`).
 * Architecture: factory `createImageRunner(deps)` — shows a bot phase bubble
 * while waiting (same presence as chat), then swaps in the image result.
 * Quality: 8/10 — is-generating + setWorkingPhase while Flux runs; still fixed 512²
 */

import { OLLAMA, IMAGE_MODEL } from "./config.js";
import { setWorkingPhase } from "./markdown.js";
import { isAbortError, StoppedError } from "./util.js";

/**
 * @param {{
 *   addBubble: Function,
 *   addImageBubble: Function,
 *   setLastImage: (b64: string) => void,
 *   clearRefineArmed: () => void,
 *   updateRefineBanner: Function,
 *   getImageModel?: () => string,
 * }} deps
 */
export function createImageRunner(deps) {
  const {
    addBubble,
    addImageBubble,
    setLastImage,
    clearRefineArmed,
    updateRefineBanner,
    getImageModel = () => IMAGE_MODEL,
  } = deps;

  async function runImage(prompt, { sourceB64 = null, signal = undefined } = {}) {
    const model = getImageModel() || IMAGE_MODEL;
    const refining = Boolean(sourceB64);

    const placeholder = addBubble("bot", "", {
      label: model,
      persist: false,
    });
    const body = document.createElement("div");
    body.className = "md";
    placeholder.appendChild(body);
    placeholder.classList.add("is-generating");
    setWorkingPhase(
      body,
      refining
        ? "Refining image (reference sent; may still reinvent the scene)…"
        : "Painting image…"
    );

    const payload = {
      model,
      prompt,
      stream: false,
      width: 512,
      height: 512,
    };
    if (sourceB64) payload.images = [sourceB64];

    try {
      let res;
      try {
        res = await fetch(`${OLLAMA}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify(payload),
        });
      } catch (err) {
        if (isAbortError(err)) throw new StoppedError();
        throw err;
      }

      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(raw || `Image failed (${res.status})`);
      }
      if (!res.ok || data.error)
        throw new Error(data.error || `Image failed (${res.status})`);
      if (!data.image)
        throw new Error("No image returned — is Ollama 0.32.5 with image gen?");

      setLastImage(data.image);
      clearRefineArmed();
      updateRefineBanner();

      placeholder.remove();
      addImageBubble({
        prompt,
        b64: data.image,
        label: refining ? `${model} · refined` : model,
      });
    } catch (err) {
      placeholder.remove();
      throw err;
    }
  }

  return { runImage };
}
