"""Show Tessera in its own app window: no tabs, no address bar, Tessera's icon in the taskbar.

First choice is Tessera's native window (`forge/native_window.py`: WebView2 on Windows, WKWebView on macOS). Without
it, the Chromium the computer already has in app mode (`--app=<url>`, with its own profile): Edge ships with Windows,
Chrome or Chromium elsewhere. Without one, Tessera opens in the default browser.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

WINDOW_SIZE = "1480,940"


def _candidates() -> list[str]:
    if sys.platform == "win32":
        roots = [os.environ.get(k, "") for k in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA")]
        paths = [str(Path(r) / sub) for r in roots if r for sub in (
            "Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe")]
        return paths + [p for p in (shutil.which("msedge"), shutil.which("chrome")) if p]
    if sys.platform == "darwin":
        return [f"/Applications/{app}.app/Contents/MacOS/{app}" for app in ("Google Chrome", "Microsoft Edge", "Chromium")]
    return [p for p in (shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge")) if p]


def find_browser() -> str | None:
    """A Chromium that can open app windows, or None."""
    return next((p for p in _candidates() if Path(p).is_file()), None)


def spawn_detached(command: list[str], **kwargs) -> subprocess.Popen:
    """Start a process that outlives this one, with no console window.

    A coding agent's terminal (or any tool runner) may run us inside a Windows job object that kills every process
    in it when the command ends: break away from it when the job allows that."""
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL} | kwargs
    if sys.platform != "win32":
        return subprocess.Popen(command, start_new_session=True, **kwargs)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
    try:
        return subprocess.Popen(command, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kwargs)
    except OSError:
        return subprocess.Popen(command, creationflags=flags, **kwargs)


def open_window(url: str) -> bool:
    """Open `url` in Tessera's native window, else a Chromium app window, else the default browser.
    True when something opened."""
    from forge import native_window

    if native_window.available():
        try:
            spawn_detached(native_window.command(url))
            return True
        except OSError:
            pass
    return open_browser_window(url)


def open_browser_window(url: str) -> bool:
    """Open `url` as a Chromium app window, else in the default browser. True when something opened."""
    exe = find_browser()
    if exe:
        from forge.config import get_config_dir

        # Its own profile: the user's extensions stay out of Tessera, and a busy browser can't slow it down.
        profile = get_config_dir() / "browser"
        try:
            spawn_detached([exe, f"--app={url}", f"--window-size={WINDOW_SIZE}", f"--user-data-dir={profile}",
                            "--no-first-run", "--no-default-browser-check", "--disable-extensions"])
            return True
        except OSError:
            pass
    try:
        return webbrowser.open(url)
    except Exception:  # noqa: BLE001 — no browser (CI, SSH): the caller still has the URL
        return False
