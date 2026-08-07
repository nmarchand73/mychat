# MyChat

Local chat UI for [Ollama](https://ollama.com) — chat, web search, image generation, and a layered memory stack. Everything runs on your machine; no cloud accounts.

**Chat** · **Auto / Image** routing · **DuckDuckGo search** · **Flux images** · **Facts + RAG + auto-summarize**

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
| Images | `x/flux2-klein:4b` | Generate / refine |
| RAG embeddings | `nomic-embed-text` | Local note retrieval |

```bash
ollama pull ministral-3:8b
ollama pull qwen3.5:9b
ollama pull x/flux2-klein:4b
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

---

## What it does

- **Chat** — streaming Markdown answers via Ollama `/api/chat`
- **Auto mode** — routes prompts to chat, image, or refine (regex + optional classifier)
- **Web search** — model tool `web_search` → local DuckDuckGo (`ddgs`) through `serve.py`
- **Images** — Flux generate / refine; refine reuses the last image when armed
- **Think** — reasoning UI for `qwen3.5:9b` only (Ministral rejects `think`)
- **Session** — conversation restored from `localStorage` across reloads
- **Memory** (Settings)
  - **Facts** — durable notes injected into the system prompt
  - **Local RAG** — embed notes, retrieve on each turn
  - **Auto-summarize** — compress old turns when context grows
  - **`remember_fact` tool** — let the model store facts mid-chat

---

## Architecture

```
Browser (index.html)
 ├── css/          tokens → regions (topbar, chat, composer…)
 └── js/
     ├── app.js           composition root (state + events)
     ├── chat.js          turn pipeline (tools + stream)
     ├── image.js         Flux generate / refine
     ├── ui.js            bubbles, tool cards, banners
     ├── session.js       persist / restore
     ├── intent.js        Auto → chat | image | refine
     ├── markdown.js      think tags + safe Markdown
     ├── config.js        models, keys, tools, regexes
     └── memory/          conversation · facts · summarizer · rag · orchestrator

serve.py                  static files + /api/search + /api/rag/* + /api/health
memory/rag_store.py       chunk → embed (Ollama) → cosine retrieve
```

**Separation of concerns**

| Layer | Owns |
|-------|------|
| `app.js` | Mutable UI state, listeners, wiring |
| `chat` / `image` | Ollama I/O pipelines |
| `ui` | DOM only (deps injected) |
| `memory/*` | Model context (not the visible transcript) |
| `serve.py` | Search + RAG HTTP; no LLM chat proxy |

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
