"""A "Tessera Studio" shortcut on the desktop and in the Start menu / app list, so the user can open Tessera without an agent.

The shortcut runs `tessera-app` (or `tessera open`): it starts Tessera in the background when it isn't running and opens
its app window.
`tessera shortcut` (and the installers, and the first `tessera connect`) make it.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ICON_DIR = Path(__file__).with_name("ui")


def glob_command() -> Path | None:
    """The installed `tessera` executable next to this Python (a uv tool or a venv), else the one on PATH."""
    scripts = Path(sys.executable).parent
    for name in ("tessera.exe", "tessera", "glob.exe", "glob"):  # glob: installs from before the rename
        if (scripts / name).is_file():
            return scripts / name
    found = shutil.which("tessera") or shutil.which("glob")
    return Path(found) if found else None


def app_command() -> Path | None:
    """`tessera-app`, which opens Tessera's window without a console (Windows), next to `tessera`."""
    exe = glob_command()
    if exe is None or sys.platform != "win32":
        return None
    for name in ("tessera-app.exe", "glob-app.exe"):
        app = exe.with_name(name)
        if app.is_file():
            return app
    return None


def _desktop() -> Path:
    if sys.platform == "win32":
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                                 capture_output=True, text=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if out.stdout.strip():
                return Path(out.stdout.strip())
        except (OSError, subprocess.SubprocessError):
            pass
    return Path.home() / "Desktop"


def locations() -> list[Path]:
    """Where the shortcut goes on this system."""
    if sys.platform == "win32":
        start_menu = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Microsoft/Windows/Start Menu/Programs"
        return [_desktop() / "Tessera Studio.lnk", start_menu / "Tessera Studio.lnk"]
    if sys.platform == "darwin":
        return [_desktop() / "Tessera Studio.command"]
    return [Path.home() / ".local/share/applications/tessera-studio.desktop"]


def legacy_locations() -> list[Path]:
    """The shortcuts made before the rename to Tessera Studio; making the new ones removes these."""
    if sys.platform == "win32":
        start_menu = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Microsoft/Windows/Start Menu/Programs"
        return [_desktop() / "Glob.lnk", start_menu / "Glob.lnk"]
    if sys.platform == "darwin":
        return [_desktop() / "Glob.command"]
    return [Path.home() / ".local/share/applications/glob.desktop"]


def exists() -> bool:
    return any(path.exists() for path in locations())


def _ps_quote(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def create() -> list[Path]:
    """Make (or refresh) the shortcuts; returns the paths written."""
    exe = glob_command()
    if exe is None:
        raise RuntimeError("Couldn't find the installed `tessera` command.")
    app = app_command()
    made: list[Path] = []
    for path in locations():
        path.parent.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            # tessera-app has no console; the `tessera open` fallback's console starts minimised (WindowStyle 7).
            target, arguments = (app, "") if app else (exe, "open")
            script = (
                f"$s = (New-Object -ComObject WScript.Shell).CreateShortcut({_ps_quote(str(path))}); "
                f"$s.TargetPath = {_ps_quote(str(target))}; $s.Arguments = {_ps_quote(arguments)}; "
                f"$s.WorkingDirectory = {_ps_quote(str(Path.home()))}; $s.WindowStyle = 7; "
                f"$s.IconLocation = {_ps_quote(str(ICON_DIR / 'tessera.ico'))}; "
                "$s.Description = 'Open Tessera, the asset studio for your game'; $s.Save()"
            )
            result = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True,
                                    timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode != 0 or not path.exists():
                raise RuntimeError(f"Couldn't create {path}: {(result.stderr or result.stdout).strip()[:200]}")
        elif sys.platform == "darwin":
            path.write_text(f'#!/bin/sh\n"{exe}" open\nosascript -e \'tell application "Terminal" to close front window\' >/dev/null 2>&1 &\n', encoding="utf-8")
            path.chmod(0o755)
        else:
            path.write_text(
                "[Desktop Entry]\nType=Application\nName=Tessera\nComment=The asset studio for your game\n"
                f'Exec="{exe}" open\nIcon={ICON_DIR / "tessera-icon.png"}\nTerminal=false\nCategories=Graphics;Development;\n',
                encoding="utf-8",
            )
            path.chmod(0o755)
        made.append(path)
    for old in legacy_locations():
        try:
            old.unlink(missing_ok=True)
        except OSError:
            pass  # a locked or read-only old shortcut only means two icons
    return made
