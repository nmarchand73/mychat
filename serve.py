#!/usr/bin/env python3
"""
Intent: serve the static MyChat UI plus local APIs (search + RAG).
Architecture: ThreadingHTTPServer from ROOT; /api/search (ddgs), /api/rag/*
and /api/health; everything else is static files with no-store caching.
"""

from __future__ import annotations

import json
import traceback
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8765


def web_search(query: str, max_results: int = 5) -> list[dict]:
    """Search the web from this machine via DuckDuckGo (ddgs library)."""
    from ddgs import DDGS

    q = (query or "").strip()
    if not q:
        return []
    max_results = max(1, min(int(max_results or 5), 10))
    rows: list[dict] = []
    with DDGS() as ddgs:
        for item in ddgs.text(q, max_results=max_results):
            rows.append(
                {
                    "title": item.get("title") or "",
                    "url": item.get("href") or item.get("url") or "",
                    "snippet": item.get("body") or item.get("snippet") or "",
                }
            )
    return rows


def _read_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except json.JSONDecodeError as e:
        raise ValueError("invalid JSON") from e


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/search":
            self._handle_search(parsed)
            return
        if path == "/api/health":
            rag_ok = False
            rag_info: dict = {}
            try:
                from memory import rag_store

                rag_info = rag_store.health()
                rag_ok = bool(rag_info.get("ok"))
            except Exception as e:  # noqa: BLE001
                rag_info = {"ok": False, "error": str(e)}
            self._json(
                200,
                {
                    "ok": True,
                    "search": True,
                    "rag": rag_ok,
                    "rag_detail": rag_info,
                },
            )
            return
        if path == "/api/rag/health":
            try:
                from memory import rag_store

                self._json(200, rag_store.health())
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
            return
        if path == "/api/rag/list":
            try:
                from memory import rag_store

                self._json(200, rag_store.list_chunks())
            except Exception as e:  # noqa: BLE001
                self._json(500, {"error": str(e)})
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/search":
            try:
                body = _read_json_body(self)
            except ValueError:
                self._json(400, {"error": "invalid JSON"})
                return
            query = body.get("query") or body.get("q") or ""
            max_results = body.get("max_results") or 5
            self._run_search(query, max_results)
            return

        if path == "/api/rag/ingest":
            try:
                body = _read_json_body(self)
                from memory import rag_store

                result = rag_store.ingest(
                    text=body.get("text") or "",
                    source=body.get("source") or "manual",
                )
                status = 200 if result.get("ok") else 400
                self._json(status, result)
            except urllib.error.URLError as e:
                self._json(503, {"ok": False, "error": f"Ollama embed failed: {e}"})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._json(500, {"ok": False, "error": str(e)})
            return

        if path == "/api/rag/query":
            try:
                body = _read_json_body(self)
                from memory import rag_store

                result = rag_store.query(
                    q=body.get("query") or body.get("q") or "",
                    top_k=body.get("top_k") or body.get("topK") or 4,
                )
                self._json(200, result)
            except urllib.error.URLError as e:
                self._json(503, {"hits": [], "error": f"Ollama embed failed: {e}"})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._json(500, {"hits": [], "error": str(e)})
            return

        self.send_error(404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/rag/"):
            chunk_id = path[len("/api/rag/") :].strip("/")
            if not chunk_id or chunk_id in {"ingest", "query", "list", "health"}:
                self._json(400, {"error": "missing chunk id"})
                return
            try:
                from memory import rag_store

                self._json(200, rag_store.delete(urllib.parse.unquote(chunk_id)))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"error": str(e)})
            return
        self.send_error(404)

    def _handle_search(self, parsed: urllib.parse.ParseResult) -> None:
        qs = urllib.parse.parse_qs(parsed.query)
        query = (qs.get("q") or qs.get("query") or [""])[0]
        max_results = int((qs.get("max_results") or ["5"])[0])
        self._run_search(query, max_results)

    def _run_search(self, query: str, max_results: int) -> None:
        try:
            results = web_search(query, max_results=max_results)
            self._json(200, {"query": query, "results": results})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json(500, {"error": str(e), "results": []})

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[mychat] {self.address_string()} {fmt % args}")


if __name__ == "__main__":
    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"MyChat → http://127.0.0.1:{PORT}")
        print("Local search: ddgs · Local RAG: /api/rag/* (nomic-embed-text)")
        print("Keep Ollama running (image gen needs 0.32.5)")
        httpd.serve_forever()
