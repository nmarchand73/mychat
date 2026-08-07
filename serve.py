#!/usr/bin/env python3
"""
Intent: serve the static MyChat UI plus local APIs (search + RAG).
Architecture: ThreadingHTTPServer from ROOT; /api/search (ddgs), /api/rag/*
and /api/health; everything else is static files with no-store caching.
Quality: 7/10 — make_server() clean; repeated rag imports + broad except per route
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

                self._json(200, {"chunks": rag_store.list_chunks()})
            except Exception as e:  # noqa: BLE001
                self._json(500, {"error": str(e), "chunks": []})
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/search":
            try:
                body = _read_json_body(self)
            except ValueError:
                self._json(400, {"error": "invalid JSON", "results": []})
                return
            self._run_search(body.get("query") or "", int(body.get("max_results") or 5))
            return
        if path == "/api/rag/ingest":
            try:
                body = _read_json_body(self)
                from memory import rag_store

                self._json(
                    200,
                    rag_store.ingest(
                        body.get("text") or "",
                        source=body.get("source") or "ui",
                    ),
                )
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._json(500, {"error": str(e)})
            return
        if path == "/api/rag/query":
            try:
                body = _read_json_body(self)
                from memory import rag_store

                self._json(
                    200,
                    {
                        "hits": rag_store.query(
                            body.get("query") or "",
                            top_k=int(body.get("top_k") or 5),
                        )
                    },
                )
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._json(500, {"error": str(e), "hits": []})
            return
        self.send_error(404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/rag/"):
            chunk_id = path[len("/api/rag/") :].strip("/")
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


def make_server(host: str = "127.0.0.1", port: int = PORT) -> ThreadingHTTPServer:
    ThreadingHTTPServer.allow_reuse_address = True
    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    with make_server() as httpd:
        print(f"MyChat → http://127.0.0.1:{PORT}")
        print("Local search: ddgs · Local RAG: /api/rag/* (nomic-embed-text)")
        print("Keep Ollama running (image gen needs 0.32.5)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
