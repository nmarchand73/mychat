#!/usr/bin/env python3
"""
Intent: native desktop shell for MyChat (local window over serve.py).
Architecture: background ThreadingHTTPServer + pywebview (Cocoa) to
127.0.0.1:PORT; private_mode=False so chats/settings persist; RAG under
~/Library/Application Support/MyChat; launch errors in ~/Library/Logs/MyChat.log.
Quality: 8/10 — private_mode=False + MYCHAT_DATA_DIR before serve; alert/log on crash.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG_DIR = Path.home() / "Library" / "Logs"
LOG_FILE = LOG_DIR / "MyChat.log"
SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "MyChat"


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


def _wait_ready(host: str, port: int, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _port_open(host, port):
            return True
        time.sleep(0.05)
    return False


def main() -> int:
    os.chdir(ROOT)
    # Prefer Cocoa; avoids picking a headless backend when GUI env is thin.
    os.environ.setdefault("PYWEBVIEW_GUI", "cocoa")
    # Durable files outside the .app bundle (survives rebuilds / is writable).
    SUPPORT_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MYCHAT_DATA_DIR", str(SUPPORT_DIR))

    try:
        # Register as a real GUI app before creating the window (Finder launches).
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

    from serve import PORT, make_server

    host = "127.0.0.1"
    httpd = None
    if _port_open(host, PORT):
        _log(f"[mychat-app] Reusing server already on http://{host}:{PORT}")
    else:
        httpd = make_server(host, PORT)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        if not _wait_ready(host, PORT):
            msg = f"Server failed to start on http://{host}:{PORT}"
            _log(msg)
            _alert("MyChat failed to start", msg)
            return 1
        _log(f"[mychat-app] Serving http://{host}:{PORT}")

    url = f"http://{host}:{PORT}/"
    webview.create_window(
        title="MyChat",
        url=url,
        width=1180,
        height=780,
        min_size=(720, 520),
        background_color="#f7f0e4",
    )
    try:
        # Default private_mode=True wipes localStorage every launch.
        webview.start(private_mode=False, storage_path=str(SUPPORT_DIR / "webview"))
    finally:
        if httpd is not None:
            httpd.shutdown()
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
