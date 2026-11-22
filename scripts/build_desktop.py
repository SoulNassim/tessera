"""Build Tessera Studio as a standalone desktop app (no Python needed on the target machine).

    uv run --with pyinstaller python scripts/build_desktop.py

Output: dist/TesseraStudio/ (Windows: TesseraStudio.exe) or dist/TesseraStudio.app (macOS). Projects and settings live in the
user's home folder (~/Tessera/projects, or ~/Glob/projects for older installs, and ~/.forge), never inside the app bundle.

Release installers are built from this in CI (.github/workflows/release.yml):
Windows -> packaging/windows/tessera.iss (Inno Setup engine) wrapped by packaging/windows/setup/build_setup.py, macOS -> a .dmg made with hdiutil.
"""

from __future__ import annotations

import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
SEP = ";" if sys.platform == "win32" else ":"
ENTRY = ROOT / "build" / "glob_entry.py"


def main() -> None:
    ENTRY.parent.mkdir(exist_ok=True)
    ENTRY.write_text(
        "import os\n"
        "from pathlib import Path\n"
        "from forge.config import home_projects_root\n"
        "os.environ.setdefault('FORGE_PROJECTS_DIR', str(home_projects_root()))\n"
        "import sys\n"
        "if sys.argv[1:2] == ['--window']:  # one native app window (forge/native_window.py)\n"
        "    from forge.native_window import main\n"
        "    sys.argv[1:] = sys.argv[2:]\n"
        "elif len(sys.argv) > 1:  # --mcp, or the background server (--no-browser --port N)\n"
        "    from forge.cli import main\n"
        "else:\n"
        "    from forge.desktop import main\n"
        "main()\n",
        encoding="utf-8",
    )
    icon = ROOT / "forge" / "ui" / ("tessera.ico" if sys.platform == "win32" else "tessera-icon.png")
    PyInstaller.__main__.run([
        str(ENTRY),
        "--name", "TesseraStudio",
        "--windowed",
        "--noconfirm",
        "--icon", str(icon),
        "--distpath", str(ROOT / "dist"),
        "--workpath", str(ROOT / "build" / "pyinstaller"),
        "--specpath", str(ROOT / "build"),
        "--add-data", f"{ROOT / 'forge' / 'ui'}{SEP}forge/ui",
        "--add-data", f"{ROOT / 'forge' / 'recipes' / 'builtins'}{SEP}forge/recipes/builtins",
        "--add-data", f"{ROOT / 'forge' / 'agent' / 'tess_prompt.md'}{SEP}forge/agent",
        "--add-data", f"{ROOT / 'forge' / 'agent' / 'skills'}{SEP}forge/agent/skills",
        "--add-data", f"{ROOT / 'forge' / 'samples'}{SEP}forge/samples",
        # Run as a script by the local AI runtime's own Python, so it must be a real file in the bundle.
        "--add-data", f"{ROOT / 'forge' / 'local_ai' / 'worker_main.py'}{SEP}forge/local_ai",
        "--collect-submodules", "forge",
        "--collect-submodules", "uvicorn",
        "--hidden-import", "forge.server.app",
        # The bundle id stays from before the rename: macOS ties permissions and the keychain to it.
        "--osx-bundle-identifier", "io.github.soulnassim.tessera",
    ])
    print(f"\nBuilt {ROOT / 'dist' / 'TesseraStudio'}")


if __name__ == "__main__":
    main()
