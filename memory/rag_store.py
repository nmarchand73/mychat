"""
Intent: local RAG — chunk text, embed via Ollama, cosine retrieve.
Architecture: JSON store under Application Support (or MYCHAT_DATA_DIR);
embeds with nomic-embed-text; exposed via serve.py /api/rag/*.
Quality: 7/10 — Application Support + legacy migrate; append-only ingest, non-atomic save.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

OLLAMA = "http://127.0.0.1:11434"
EMBED_MODEL = "nomic-embed-text"
LEGACY_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "rag"
MAX_CHUNKS = 400
CHUNK_SIZE = 900
CHUNK_OVERLAP = 120


def _resolve_data_dir() -> Path:
    env = (os.environ.get("MYCHAT_DATA_DIR") or "").strip()
    if env:
        return Path(env).expanduser() / "rag"
    # Durable path: survives .app rebuilds and is writable from Finder launches.
    return Path.home() / "Library" / "Application Support" / "MyChat" / "rag"


DATA_DIR = _resolve_data_dir()
STORE_PATH = DATA_DIR / "chunks.json"


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # One-time migrate from old repo-local data/rag if present.
    legacy = LEGACY_DATA_DIR / "chunks.json"
    if STORE_PATH.exists() or not legacy.is_file():
        return
    try:
        if legacy.stat().st_size <= 2:
            return
        shutil.copy2(legacy, STORE_PATH)
    except OSError:
        pass


def _load() -> list[dict]:
    _ensure_dir()
    if not STORE_PATH.exists():
        return []
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save(chunks: list[dict]) -> None:
    _ensure_dir()
    STORE_PATH.write_text(json.dumps(chunks, ensure_ascii=False, indent=2), encoding="utf-8")


def _ollama_embed(text: str, model: str = EMBED_MODEL) -> list[float]:
    payload = json.dumps({"model": model, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    emb = body.get("embedding")
    if not isinstance(emb, list) or not emb:
        raise RuntimeError("Ollama returned no embedding — is nomic-embed-text pulled?")
    return [float(x) for x in emb]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / (na * nb)


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    raw = re.sub(r"\s+", " ", (text or "").strip())
    if not raw:
        return []
    if len(raw) <= size:
        return [raw]
    out: list[str] = []
    i = 0
    while i < len(raw):
        out.append(raw[i : i + size])
        i += max(1, size - overlap)
    return out


def health() -> dict:
    try:
        req = urllib.request.Request(f"{OLLAMA}/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            tags = json.loads(resp.read().decode("utf-8"))
        names = [m.get("name") or "" for m in tags.get("models") or []]
        embed_ok = any("nomic-embed" in n for n in names)
        return {
            "ok": True,
            "ollama": True,
            "embed_model": EMBED_MODEL,
            "embed_ready": embed_ok,
            "chunks": len(_load()),
        }
    except Exception as e:  # noqa: BLE001
        return {
            "ok": False,
            "ollama": False,
            "embed_model": EMBED_MODEL,
            "embed_ready": False,
            "chunks": len(_load()),
            "error": str(e),
        }


def list_chunks() -> dict:
    chunks = _load()
    return {
        "count": len(chunks),
        "chunks": [
            {
                "id": c.get("id"),
                "source": c.get("source"),
                "text": (c.get("text") or "")[:240],
                "createdAt": c.get("createdAt"),
            }
            for c in chunks
        ],
    }


def ingest(text: str, source: str = "manual") -> dict:
    pieces = chunk_text(text)
    if not pieces:
        return {"ok": False, "error": "empty text", "added": 0}

    chunks = _load()
    added = []
    for piece in pieces:
        emb = _ollama_embed(piece)
        row = {
            "id": str(uuid.uuid4()),
            "text": piece,
            "source": (source or "manual")[:120],
            "embedding": emb,
            "createdAt": int(time.time() * 1000),
        }
        chunks.append(row)
        added.append({"id": row["id"], "text": piece[:160], "source": row["source"]})

    if len(chunks) > MAX_CHUNKS:
        chunks = chunks[-MAX_CHUNKS:]
    _save(chunks)
    return {"ok": True, "added": len(added), "chunks": added, "total": len(chunks)}


def query(q: str, top_k: int = 4) -> dict:
    q = (q or "").strip()
    if not q:
        return {"hits": [], "model": EMBED_MODEL}
    top_k = max(1, min(int(top_k or 4), 8))
    chunks = _load()
    if not chunks:
        return {"hits": [], "model": EMBED_MODEL}

    q_emb = _ollama_embed(q)
    scored = []
    for c in chunks:
        emb = c.get("embedding")
        if not isinstance(emb, list):
            continue
        scored.append((_cosine(q_emb, emb), c))
    scored.sort(key=lambda x: x[0], reverse=True)

    hits = []
    for score, c in scored[:top_k]:
        if score < 0.15:
            continue
        hits.append(
            {
                "id": c.get("id"),
                "text": c.get("text") or "",
                "source": c.get("source") or "",
                "score": round(float(score), 4),
            }
        )
    return {"hits": hits, "model": EMBED_MODEL}


def delete(chunk_id: str) -> dict:
    chunks = _load()
    next_chunks = [c for c in chunks if c.get("id") != chunk_id]
    if len(next_chunks) == len(chunks):
        return {"ok": False, "error": "not found"}
    _save(next_chunks)
    return {"ok": True, "total": len(next_chunks)}
