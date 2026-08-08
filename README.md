<!-- Quality: 8/10 — private_mode + Application Support RAG documented; no troubleshooting -->
# MyChat

Local chat UI for [Ollama](https://ollama.com) — chat, web search, image generation, and a layered memory stack. Everything runs on your machine; no cloud accounts.

**Chat** · **Image** (explicit) · **DuckDuckGo search** · **Flux images** · **Facts + RAG + auto-summarize**

---

## Requirements

- [Ollama](https://ollama.com) **0.32.5+** (image gen needs a recent build)
- Python 3.11+
- Node.js 18+ (tests only)

### Models

| Role | Model | Notes |
|------|--------|--------|
| Chat (default) | `ministral-3:8b` | Fast everyday chat |
| Chat + Think | `qwen3.5:9b` | Only model that gets `think: true` |
| Images | `x/flux2-klein:4b` / `:9b` | Generate / refine (pick in Settings) |
| RAG embeddings | `nomic-embed-text` | Local note retrieval |

```bash
ollama pull ministral-3:8b
ollama pull qwen3.5:9b
ollama pull x/flux2-klein:4b
ollama pull x/flux2-klein:9b
ollama pull nomic-embed-text
```

---

## Quick start

```bash
cd MyChat
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Terminal 1 — Ollama running in the background
# Terminal 2 — UI + APIs
.venv/bin/python serve.py
```

Open **http://127.0.0.1:8765**

### Desktop app (macOS)

Build a double-clickable **MyChat.app** (embeds UI + a private venv so Finder isn’t blocked by Documents privacy):

```bash
chmod +x scripts/build_macos_app.sh
./scripts/build_macos_app.sh
open dist/MyChat.app
```

Optional: drag `dist/MyChat.app` into **Applications**. Icon: `assets/icon-1024.png`. Logs: `~/Library/Logs/MyChat.log`. Chats/settings persist in the app WebView (`private_mode` off); RAG notes live in `~/Library/Application Support/MyChat/`. The desktop shell listens on **8770** by default (`MYCHAT_PORT`, auto-picks the next free port if busy) so it can run beside browser `serve.py` on **8765**. Ollama must still be running. Rebuild after code changes so the bundle stays in sync.

Dev window without rebuilding the `.app`:

```bash
.venv/bin/python desktop_app.py
# or: MYCHAT_PORT=8771 .venv/bin/python desktop_app.py
```

---

## What it does

- **Chat** — streaming Markdown answers via Ollama `/api/chat`
- **Multi-chat sidebar** — new / switch / delete threads; collapsible panel
- **Modes** — **Chat** (default) or **Image**; no Auto routing between text and pictures
- **Web search** — model tool `web_search` → local DuckDuckGo (`ddgs`) through `serve.py` (tool cards persist)
- **Images** — Flux generate / refine in Image mode; refine reuses the last image when armed
- **Think** — reasoning UI for `qwen3.5:9b` only (Ministral rejects `think`)
- **Edit / Delete / Regenerate** — trim the thread from a message; redo the last answer
- **Export** — download the active chat as Markdown (Settings)
- **Session** — conversations restored from `localStorage` across reloads (desktop app keeps them too)
- **Memory** (Settings)
  - **Facts** — durable notes injected into the system prompt
  - **Local RAG** — embed notes, retrieve on each turn
  - **Auto-summarize** — compress old turns when context grows
  - **`remember_fact` tool** — let the model store facts mid-chat

---

## Architecture

```
Browser (index.html)
 ├── css/          tokens → regions (sidebar, topbar, chat, composer…)
 └── js/
     ├── app.js           composition root (state + events)
     ├── chat.js          turn pipeline (tools + stream)
     ├── image.js         Flux generate / refine
     ├── ui.js            bubbles, tool cards, banners
     ├── session.js       multi-chat persist / restore
     ├── export.js        thread → Markdown download
     ├── intent.js        Chat | Image (explicit; no Auto)
     ├── markdown.js      think tags + safe Markdown
     ├── config.js        models, keys, tools, regexes
     └── memory/          conversation · facts · summarizer · rag · orchestrator

serve.py                  static files + /api/search + /api/rag/* + /api/health
desktop_app.py            pywebview shell over serve.py
memory/rag_store.py       chunk → embed (Ollama) → cosine retrieve
scripts/build_macos_app.sh → dist/MyChat.app (+ favicons from icon)
```

**Separation of concerns**

| Layer | Owns |
|-------|------|
| `app.js` | Mutable UI state, listeners, wiring |
| `chat` / `image` | Ollama I/O pipelines |
| `ui` | DOM only (deps injected) |
| `memory/*` | Model context (not the visible transcript) |
| `serve.py` | Search + RAG HTTP; no LLM chat proxy |

### Agent rules (Boy Scout + Quality score)

Cursor rules in [`.cursor/rules/`](.cursor/rules/) keep the codebase maintainable: the parent agent leaves every touched file a bit cleaner (**Boy Scout**), then a **sub-agent** scores those files at the end of the turn and writes an honest **`Quality: N/10 — note`** in each header (scores are not self-graded by the editor). See `mychat-boyscout.mdc`, `mychat-modularity.mdc`, and `mychat-coding.mdc`.

---

## API (local)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Ollama reachability hints + search/RAG status |
| `POST` | `/api/search` | `{ "query", "max_results" }` → DuckDuckGo hits |
| `GET` | `/api/rag/health` | Embed model + chunk count |
| `POST` | `/api/rag/ingest` | `{ "text", "source?" }` → embed & store |
| `POST` | `/api/rag/query` | `{ "query", "top_k?" }` → nearest chunks |
| `GET` | `/api/rag/list` | List stored chunks |
| `DELETE` | `/api/rag/<id>` | Remove a chunk |

Chat and image calls go **directly** from the browser to Ollama at `http://127.0.0.1:11434`.

---

## Tests

```bash
npm test          # JS memory suites + Python rag_store
npm run test:js   # JS only
```

---

## Notes

- Prefer **serve.py** over opening `index.html` as a file — search and RAG need the local APIs.
- Image refine sends a reference image; Ollama may still reinvent the scene.
- Clearing the conversation keeps facts and RAG notes.
- Large images may be dropped from session restore if `localStorage` hits quota.
