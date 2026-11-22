"""Tessera's own native window: a real app window with Tessera's icon, title bar and taskbar entry, no browser.

On Windows it draws the studio with WebView2 (the Edge engine that ships with Windows 10 and 11), on macOS with
WKWebView, through pywebview. Each window is its own small process, `python -m forge.native_window <url>` (the
installed app: `TesseraStudio --window <url>`), so it never shares a process, profile or extensions with the user's
browser, and the studio server keeps running behind it when the window closes.

`appwindow.open_window` starts it. When pywebview or WebView2 is missing, the window falls back to a Chromium app
window (`appwindow.open_browser_window`). `FORGE_WINDOW=browser` skips the native window altogether.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
import urllib.parse
from pathlib import Path

WIDTH, HEIGHT = 1480, 940
MIN_SIZE = (960, 620)
BACKGROUND = "#08080B"  # --bg in styles.css: no white flash before the page paints
UI_DIR = Path(__file__).resolve().parent / "ui"
APP_ID = "SoulNassim.TesseraStudio"


def available() -> bool:
    """A native window can open here: pywebview is installed on Windows or macOS and not turned off."""
    if os.environ.get("FORGE_WINDOW", "").strip().lower() == "browser":
        return False
    return sys.platform in ("win32", "darwin") and importlib.util.find_spec("webview") is not None


def command(url: str) -> list[str]:
    """How to start a window process for `url`."""
    if getattr(sys, "frozen", False):  # the installed app is its own interpreter
        return [sys.executable, "--window", url]
    exe = sys.executable
    if sys.platform == "win32":  # pythonw: no console window behind Tessera's
        pythonw = Path(exe).with_name("pythonw.exe")
        exe = str(pythonw) if pythonw.is_file() else exe
    return [exe, "-m", "forge.native_window", url]


class NativeUnavailable(RuntimeError):
    pass


def _tune_windows() -> None:
    """WebView2 settings pywebview doesn't expose. Raises NativeUnavailable without WebView2."""
    import ctypes

    from webview.platforms import edgechromium, winforms

    if winforms.renderer != "edgechromium":  # pywebview would fall back to Internet Explorer
        raise NativeUnavailable("WebView2 is not installed")
    try:  # its own taskbar button with Tessera's icon, not grouped with Python
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception:  # noqa: BLE001
        pass
    winforms.BrowserView.BrowserForm.is_dark_theme = lambda self: True  # Tessera is always dark: so is its title bar

    original = edgechromium.EdgeChrome.on_webview_ready

    def on_ready(self, sender, args) -> None:  # noqa: ANN001 — WebView2 event handler
        original(self, sender, args)
        if not args.IsSuccess:
            return
        core = sender.CoreWebView2
        # pywebview passes every request and response through Python to fire its request events. Tessera uses
        # neither, and a page of thumbnails would pay that hop for every image, so take the hooks off again.
        try:
            core.RemoveWebResourceRequestedFilter("*", edgechromium.CoreWebView2WebResourceContext.All)
        except Exception:  # noqa: BLE001
            pass
        for event, handler in (("WebResourceRequested", self.on_web_resource_request), ("WebResourceResponseReceived", self.on_web_resource_response)):
            try:
                getattr(core, event).__isub__(handler)
            except Exception:  # noqa: BLE001
                pass
        settings = core.Settings
        settings.AreDefaultContextMenusEnabled = True  # copy and paste in the chat and fields
        settings.AreBrowserAcceleratorKeysEnabled = True  # Ctrl+F, Ctrl+R, zoom, like the app window had

    edgechromium.EdgeChrome.on_webview_ready = on_ready


WATCH_SECONDS = 2.0
MISSES_BEFORE_RESTART = 2


def studio_base(url: str) -> str | None:
    """The studio's address (http://127.0.0.1:8420) behind a window URL, also for the loading page
    (file:///.../loading.html#<studio url>). None for anything else."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme == "file" and parts.fragment:
        parts = urllib.parse.urlsplit(urllib.parse.unquote(parts.fragment))
    if parts.scheme in ("http", "https") and parts.hostname in ("127.0.0.1", "localhost", "::1"):
        return f"{parts.scheme}://{parts.netloc}"
    return None


def watch(window, url: str, *, interval: float = WATCH_SECONDS, sleep=time.sleep) -> None:  # noqa: ANN001 — a pywebview Window
    """Keep the studio behind this window alive.

    If it disappears (a crash, a killed process), the window shows the "Starting Tessera" page and starts it again,
    instead of failing every request. If it was quit on purpose (tray, Settings, an update), the window closes."""
    from forge import launcher

    base = studio_base(url)
    if not base:
        return
    opened, misses = time.time(), 0
    while True:
        sleep(interval)
        if launcher.quit_since(opened):
            window.destroy()
            return
        if launcher._health(base):
            misses = 0
            continue
        misses += 1
        if misses != MISSES_BEFORE_RESTART:
            continue
        current = window.get_current_url() or f"{base}/"
        if current.startswith("file:") and time.time() - opened < launcher.START_TIMEOUT:
            misses = 0  # the launcher is still starting it behind the loading page: don't start a second one
            continue
        if not current.startswith("file:"):
            loading = UI_DIR / "loading.html"
            window.load_url(f"{loading.as_uri()}#{urllib.parse.quote(current, safe='')}")  # it switches back once up
        try:
            launcher.ensure_running()
        except Exception:  # noqa: BLE001 — the loading page says so after a while; try again next round
            misses = 0


def run(url: str) -> None:
    """Open the window on `url` and return when it closes. Raises NativeUnavailable when it can't open here."""
    try:
        import webview
    except ImportError as exc:
        raise NativeUnavailable(str(exc)) from exc
    from forge import brand
    from forge.config import get_config_dir

    if sys.platform == "win32":
        _tune_windows()
    webview.settings["ALLOW_DOWNLOADS"] = True  # project ZIPs, press kits, exports
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True  # sign-in pages and outside links go to the browser
    debug = os.environ.get("FORGE_WINDOW_DEBUG", "").strip().lower() in ("1", "true", "yes")
    if debug:
        webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = False  # Inspect is in the right-click menu instead
    window = webview.create_window(brand.NAME, url, width=WIDTH, height=HEIGHT, min_size=MIN_SIZE, background_color=BACKGROUND, text_select=True)
    icon = UI_DIR / ("tessera.ico" if sys.platform == "win32" else "tessera-icon.png")
    storage = get_config_dir() / "window"
    storage.mkdir(parents=True, exist_ok=True)
    # Not private: the studio keeps its view, chat layout and choices in localStorage between launches.
    webview.start(watch, (window, url), private_mode=False, storage_path=str(storage), icon=str(icon) if icon.is_file() else None, debug=debug)


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    url = args[0] if args else "http://127.0.0.1:8420/"
    try:
        run(url)
    except Exception:  # noqa: BLE001 — no native window here: the Chromium app window still shows Tessera
        from forge.appwindow import open_browser_window

        open_browser_window(url)


if __name__ == "__main__":
    main()
