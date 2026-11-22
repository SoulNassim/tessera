"""Keeping Tessera up to date from its GitHub releases.

`check()` asks GitHub for the latest release (cached for a few hours) and compares it with the
running version. How an update is installed depends on how Tessera was installed:

  * windows-app: the Inno Setup installer is downloaded and run silently; it replaces the app
    and starts it again, so Tessera quits right after launching it.
  * mac-app:     the .dmg is downloaded, the app bundle is swapped in place by a small script that runs
    after Tessera quits, and the new version is opened.
  * uv-tool:     `uv tool install --force` with the release's wheel; restart afterwards.
  * source:      a git checkout or development install; Tessera only shows the command to run.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx

from forge import __version__, brand

REPO = brand.PUBLIC_REPO  # its GitHub releases hold the installers and the wheel
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
CACHE_SECONDS = 6 * 3600
# The release file each install kind updates from.
ASSETS = {
    "windows-app": ("TesseraStudio-Setup-Windows.exe",),
    "mac-app": ("TesseraStudio-macOS.dmg",),
}
WHEEL = re.compile(r"^tessera_studio-[\w.]+-py3-none-any\.whl$")


def release_asset(release: dict[str, Any], kind: str) -> str | None:
    """The release file this install updates from, or None when the release has none for it."""
    assets = release.get("assets", {})
    if kind == "uv-tool":
        return next((name for name in assets if WHEEL.match(name)), None)
    return next((name for name in ASSETS.get(kind, ()) if name in assets), None)

_cache: dict[str, Any] = {"at": 0.0, "release": None}
state: dict[str, Any] = {"status": "idle", "progress": 0.0, "error": "", "message": ""}


def parse_version(text: str) -> tuple[int, ...]:
    numbers = re.findall(r"\d+", str(text).split("-")[0].split("+")[0])
    return tuple(int(n) for n in numbers[:3]) or (0,)


def install_kind() -> str:
    if getattr(sys, "frozen", False):
        if sys.platform == "win32":
            return "windows-app"
        if sys.platform == "darwin":
            return "mac-app"
        return "source"
    prefix = Path(sys.prefix).resolve()
    if prefix.parent.name == "tools" and "uv" in {p.lower() for p in prefix.parts}:
        return "uv-tool"
    return "source"


def _mac_bundle() -> Path | None:
    for parent in Path(sys.executable).resolve().parents:
        if parent.suffix == ".app":
            return parent
    return None


async def latest_release(force: bool = False) -> dict[str, Any] | None:
    if not force and _cache["release"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["release"]
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        response = await client.get(LATEST_URL, headers={"Accept": "application/vnd.github+json", "User-Agent": f"TesseraStudio/{__version__}"})
    if response.status_code == 404:
        release = {}
    else:
        response.raise_for_status()
        data = response.json()
        release = {
            "version": str(data.get("tag_name") or "").lstrip("v"),
            "tag": data.get("tag_name") or "",
            "name": data.get("name") or "",
            "notes": str(data.get("body") or "")[:4000],
            "url": data.get("html_url") or f"https://github.com/{REPO}/releases",
            "published": data.get("published_at") or "",
            "assets": {a["name"]: a["browser_download_url"] for a in data.get("assets") or [] if a.get("name")},
        }
    _cache.update(at=time.time(), release=release)
    return release


async def check(force: bool = False) -> dict[str, Any]:
    kind = install_kind()
    info: dict[str, Any] = {"current": __version__, "kind": kind, "available": False, "state": dict(state)}
    try:
        release = await latest_release(force)
    except httpx.HTTPError as exc:
        return {**info, "error": f"Couldn't reach GitHub: {exc}"}
    except Exception as exc:  # noqa: BLE001 — a broken install (missing certificates, files) must still say why
        return {**info, "error": f"Tessera couldn't check for updates: {type(exc).__name__}: {exc}. Reinstall Tessera from the latest release if this keeps happening."}
    if not release or not release.get("version"):
        return info
    newer = parse_version(release["version"]) > parse_version(__version__)
    info.update(latest=release["version"], notes=release["notes"], url=release["url"], published=release["published"], available=newer)
    asset = release_asset(release, kind)
    info["can_install"] = newer and bool(asset) and (kind != "uv-tool" or shutil.which("uv") is not None)
    if kind == "source":
        wheel = release_asset(release, "uv-tool")
        info["command"] = "git pull && uv sync" if (Path.cwd() / ".git").exists() else (
            f"uv tool install --force --python 3.12 {release['assets'][wheel]}" if wheel else f"Download it from {brand.SITE}")
    return info


async def _download(url: str, dest: Path) -> None:
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120), follow_redirects=True) as client:
        async with client.stream("GET", url, headers={"User-Agent": f"TesseraStudio/{__version__}"}) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or 0)
            done = 0
            with open(dest, "wb") as sink:
                async for chunk in response.aiter_bytes(1 << 20):
                    sink.write(chunk)
                    done += len(chunk)
                    state["progress"] = done / total if total else 0.0


def _quit_soon(delay: float = 1.5) -> None:
    """Exit the whole app (server and window) shortly, after the HTTP response went out."""
    from forge.launcher import mark_quit

    mark_quit()  # the windows close too, rather than starting the old version again
    loop = asyncio.get_running_loop()
    loop.call_later(delay, lambda: os._exit(0))


async def install() -> dict[str, Any]:
    """Download and install the latest release. Runs in the background; poll `state` for progress."""
    if state["status"] in ("downloading", "installing"):
        return dict(state)
    kind = install_kind()
    release = await latest_release(force=True)
    if not release or parse_version(release.get("version", "0")) <= parse_version(__version__):
        state.update(status="idle", message="Tessera is up to date.")
        return dict(state)
    state.update(status="downloading", progress=0.0, error="", message=f"Downloading Tessera {release['version']}…")
    try:
        if kind == "uv-tool":
            state.update(status="installing", message=f"Installing Tessera {release['version']}…")
            wheel = release_asset(release, kind)
            if not wheel:
                raise RuntimeError(f"This release has no package for a uv install. Download it from {brand.SITE}")
            source = release["assets"][wheel]
            proc = await asyncio.create_subprocess_exec(
                shutil.which("uv") or "uv", "tool", "install", "--force", "--python", "3.12", source,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            output, _ = await proc.communicate()
            if proc.returncode:
                raise RuntimeError(output.decode(errors="ignore")[-600:])
            state.update(status="restart", message=f"Tessera {release['version']} is installed. Restart Tessera to use it.")
            return dict(state)
        asset = release_asset(release, kind)
        if not asset:
            raise RuntimeError(f"This install can't update itself. Download the new version from {brand.SITE}")
        folder = Path(tempfile.mkdtemp(prefix="tessera-update-"))
        file = folder / asset
        await _download(release["assets"][asset], file)
        state.update(status="installing", progress=1.0, message=f"Installing Tessera {release['version']}; Tessera restarts by itself.")
        if kind == "windows-app":
            flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            subprocess.Popen([str(file), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS"], creationflags=flags, close_fds=True)
        else:
            bundle = _mac_bundle()
            if bundle is None:
                raise RuntimeError("Couldn't find the app bundle to replace.")
            script = folder / "update.sh"
            script.write_text(
                "#!/bin/sh\n"
                f"while kill -0 {os.getpid()} 2>/dev/null; do sleep 0.5; done\n"
                f"mount=$(hdiutil attach -nobrowse -noautoopen '{file}' | tail -1 | cut -f3-)\n"
                f"rm -rf '{bundle}.old' && mv '{bundle}' '{bundle}.old' && ditto \"$(ls -d \"$mount\"/*.app | head -1)\" '{bundle}' && rm -rf '{bundle}.old' "
                f"|| {{ rm -rf '{bundle}'; mv '{bundle}.old' '{bundle}'; }}\n"
                "hdiutil detach \"$mount\" -quiet\n"
                f"xattr -dr com.apple.quarantine '{bundle}' 2>/dev/null\n"
                f"open '{bundle}'\n",
                encoding="utf-8",
            )
            script.chmod(0o755)
            subprocess.Popen(["/bin/sh", str(script)], start_new_session=True, close_fds=True)
        _quit_soon()
    except Exception as exc:  # noqa: BLE001 — shown in the update banner
        state.update(status="failed", error=str(exc)[:600], message="The update failed.")
    return dict(state)
