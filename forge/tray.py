"""Tessera's icon in the system tray while it runs in the background: Open Tessera, Quit Tessera.

Only for a studio started in the background (no window or terminal to close it with). Windows only for now:
pystray needs the main thread on macOS, and the main thread runs the server.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

ICON = Path(__file__).resolve().parent / "ui" / "tessera-icon.png"


def start(url: str) -> bool:
    """Show the tray icon in a background thread. False when there is no tray here."""
    if sys.platform != "win32":
        return False
    try:
        import pystray
        from PIL import Image
    except ImportError:
        return False

    from forge.appwindow import open_window

    def _open(icon, item) -> None:  # noqa: ARG001 — pystray's callback signature
        open_window(url)

    def _quit(icon, item) -> None:  # noqa: ARG001
        from forge.launcher import mark_quit

        mark_quit()  # open windows close, rather than starting Tessera again
        icon.stop()
        os._exit(0)

    menu = pystray.Menu(pystray.MenuItem("Open Tessera", _open, default=True), pystray.MenuItem("Quit Tessera", _quit))
    icon = pystray.Icon("tessera", Image.open(ICON), "Tessera Studio is running", menu)
    threading.Thread(target=icon.run, daemon=True, name="tessera-tray").start()
    return True
