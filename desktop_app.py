#!/usr/bin/env python3
"""
Intent: native desktop shell for MyChat (local window over serve.py).
Architecture: owned ThreadingHTTPServer in a background thread + pywebview (Cocoa);
private_mode=False so chats/settings persist; RAG/webview under
~/Library/Application Support/MyChat; launch errors in Logs.
Quality: 8/10 — Chess Insight-style: own server, free-port pick, /api/health ready,
text_select=True; shut down on quit (no orphan listener).
"""

from __future__ import annotations

import atexit
import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
LOG_DIR = Path.home() / "Library" / "Logs"
LOG_FILE = LOG_DIR / "MyChat.log"
SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "MyChat"

# Desktop prefers 8770 so it can run beside `python serve.py` on 8765.
PREFERRED_PORT = int(os.environ.get("MYCHAT_PORT", "8770"))


def _log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass
    print(msg, flush=True)


def _alert(title: str, message: str) -> None:
    """Show a macOS dialog when launched from Finder (no Terminal)."""
    if sys.platform != "darwin":
        return
    try:
        import subprocess

        def esc(s: str) -> str:
            return s.replace("\\", "\\\\").replace('"', '\\"')

        subprocess.run(
            [
                "osascript",
                "-e",
                f'display alert "{esc(title)}" message "{esc(message)}" as critical',
            ],
            check=False,
            capture_output=True,
        )
    except Exception:
        pass


def _port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex((host, port)) == 0


def _is_our_server(host: str, port: int) -> bool:
    """True only if something on the port answers as MyChat /api/health."""
    try:
        import urllib.request

        with urllib.request.urlopen(
            f"http://{host}:{port}/api/health", timeout=0.8
        ) as resp:
            if resp.getcode() != 200:
                return False
            body = resp.read(256).decode("utf-8", errors="ignore")
            return '"ok"' in body
    except Exception:
        return False


def _wait_ready(host: str, port: int, timeout: float = 12.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _is_our_server(host, port):
            return True
        time.sleep(0.1)
    return False


def _pick_free_port(host: str, preferred: int) -> int:
    """Prefer MYCHAT_PORT; if busy, take the next free one."""
    if not _port_open(host, preferred):
        return preferred
    ours = _is_our_server(host, preferred)
    _log(
        f"[mychat-app] Port {preferred} is busy"
        f"{' (MyChat leftover)' if ours else ''} — picking another port"
    )
    for candidate in range(preferred + 1, preferred + 40):
        if not _port_open(host, candidate):
            return candidate
    raise RuntimeError(f"No free port near {preferred}")


def _stop_server(httpd: Any, thread: threading.Thread | None) -> None:
    if httpd is None:
        return
    try:
        _log("[mychat-app] Shutting down server…")
        httpd.shutdown()
    except Exception as exc:
        _log(f"[mychat-app] shutdown() error: {exc}")
    try:
        httpd.server_close()
    except Exception as exc:
        _log(f"[mychat-app] server_close() error: {exc}")
    if thread is not None and thread.is_alive():
        thread.join(timeout=3.0)
        if thread.is_alive():
            _log("[mychat-app] Server thread still alive after join timeout")
        else:
            _log("[mychat-app] Server stopped")


def main() -> int:
    os.chdir(ROOT)
    # Prefer Cocoa; avoids picking a headless backend when GUI env is thin.
    os.environ.setdefault("PYWEBVIEW_GUI", "cocoa")
    # Durable files outside the .app bundle (survives rebuilds / is writable).
    SUPPORT_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MYCHAT_DATA_DIR", str(SUPPORT_DIR))

    try:
        if sys.platform == "darwin":
            from AppKit import NSApplication

            NSApplication.sharedApplication()
        import webview
    except ImportError as exc:
        msg = (
            f"Missing dependency: {exc}\n"
            f"Install with:\n  {sys.executable} -m pip install -r requirements.txt"
        )
        _log(msg)
        _alert("MyChat failed to start", msg)
        return 1

    from serve import make_server

    host = "127.0.0.1"
    preferred = PREFERRED_PORT
    try:
        port = _pick_free_port(host, preferred)
    except RuntimeError as exc:
        _log(str(exc))
        _alert("MyChat failed to start", str(exc))
        return 1

    # Own the server for this process lifetime — never "reuse" so quit can stop it.
    httpd = make_server(host, port)
    server_thread = threading.Thread(
        target=httpd.serve_forever,
        name="mychat-http",
        daemon=True,
    )
    server_thread.start()
    atexit.register(_stop_server, httpd, server_thread)

    if not _wait_ready(host, port):
        msg = f"Server failed to start on http://{host}:{port}"
        _log(msg)
        _stop_server(httpd, server_thread)
        _alert("MyChat failed to start", msg)
        return 1

    if port != preferred:
        _log(
            f"[mychat-app] Serving http://{host}:{port} "
            f"(preferred {preferred} unavailable)"
        )
    else:
        _log(f"[mychat-app] Serving http://{host}:{port}")

    url = f"http://{host}:{port}/"
    webview_dir = SUPPORT_DIR / "webview"
    webview_dir.mkdir(parents=True, exist_ok=True)
    webview.create_window(
        title="MyChat",
        url=url,
        width=1180,
        height=780,
        min_size=(720, 520),
        background_color="#f7f0e4",
        text_select=True,
    )
    try:
        # Default private_mode=True wipes localStorage every launch.
        webview.start(private_mode=False, storage_path=str(webview_dir))
    finally:
        _stop_server(httpd, server_thread)
        _log("[mychat-app] Quit")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        tb = traceback.format_exc()
        _log(tb)
        _alert("MyChat crashed", f"See log:\n{LOG_FILE}\n\n{tb[-800:]}")
        raise SystemExit(1)
