"""Build Tessera Studio's Windows setup: the custom setup window (Setup.cs + ui/) wrapped around the Inno Setup engine.

    uv run python packaging/windows/setup/build_setup.py --version 1.2.3

Needs, from earlier build steps:
  dist/TesseraStudio/              the app (scripts/build_desktop.py)
  dist/TesseraStudio-Engine.exe    the Inno Setup engine (iscc packaging/windows/tessera.iss)
Writes dist/TesseraStudio-Setup-Windows.exe.

Compiles with the C# compiler that ships with .NET Framework 4 on every Windows, so nothing else is installed.
The WebView2 SDK DLLs come from pywebview, which Tessera already depends on.

    --stage DIR   only lay out the UI folder (index.html + assets), to open it in a browser while designing it.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
UI_ASSETS = {  # published name in ui/assets -> source
    "tess-hero.webp": ROOT / "forge" / "ui" / "tess-hero.webp",
    "tess-generating.webp": ROOT / "forge" / "ui" / "art" / "tess-generating.webp",
    "tess-success.webp": ROOT / "forge" / "ui" / "art" / "tess-success.webp",
    "tessera-mark.svg": ROOT / "forge" / "ui" / "tessera-mark.svg",
}
MAGIC = b"TSSETUP1"


def stage_ui(target: Path) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "ui" / "index.html", target / "index.html")
    (target / "assets").mkdir(exist_ok=True)
    for name, src in UI_ASSETS.items():
        shutil.copy2(src, target / "assets" / name)
    return target


def find_csc() -> Path:
    windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
    for fw in ("Framework64", "Framework"):
        csc = windir / "Microsoft.NET" / fw / "v4.0.30319" / "csc.exe"
        if csc.is_file():
            return csc
    sys.exit("No C# compiler: .NET Framework 4 (csc.exe) wasn't found.")


def webview2_dlls() -> dict[str, Path]:
    import webview  # pywebview ships the WebView2 SDK

    lib = Path(webview.__file__).resolve().parent / "lib"
    dlls = {
        "Microsoft.Web.WebView2.Core.dll": lib / "Microsoft.Web.WebView2.Core.dll",
        "Microsoft.Web.WebView2.WinForms.dll": lib / "Microsoft.Web.WebView2.WinForms.dll",
        "WebView2Loader.dll": lib / "runtimes" / "win-x64" / "native" / "WebView2Loader.dll",
    }
    missing = [str(p) for p in dlls.values() if not p.is_file()]
    if missing:
        sys.exit("pywebview's WebView2 DLLs are missing: " + ", ".join(missing))
    return dlls


def compile_host(out: Path) -> None:
    dlls = webview2_dlls()
    with tempfile.TemporaryDirectory(prefix="tessera-setup-") as tmp:
        ui = stage_ui(Path(tmp) / "ui")
        args = [
            str(find_csc()), "/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/codepage:65001",
            f"/out:{out}",
            f"/win32icon:{ROOT / 'forge' / 'ui' / 'tessera.ico'}",
            f"/win32manifest:{HERE / 'setup.manifest'}",
            "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
            f"/reference:{dlls['Microsoft.Web.WebView2.Core.dll']}",
            f"/reference:{dlls['Microsoft.Web.WebView2.WinForms.dll']}",
        ]
        for name, path in dlls.items():
            args.append(f"/resource:{path},lib/{name}")
        for file in sorted(p for p in ui.rglob("*") if p.is_file()):
            args.append(f"/resource:{file},ui/{file.relative_to(ui).as_posix()}")
        args.append(str(HERE / "Setup.cs"))
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode:
            sys.exit(result.stdout + result.stderr)


def app_stats(app: Path) -> tuple[int, int]:
    files = [p for p in app.rglob("*") if p.is_file()]
    return len(files), sum(p.stat().st_size for p in files)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", default="0.0.0")
    ap.add_argument("--app", type=Path, default=ROOT / "dist" / "TesseraStudio")
    ap.add_argument("--engine", type=Path, default=ROOT / "dist" / "TesseraStudio-Engine.exe")
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "TesseraStudio-Setup-Windows.exe")
    ap.add_argument("--stage", type=Path, help="only lay out the UI folder here")
    opts = ap.parse_args()

    if opts.stage:
        print(f"UI staged in {stage_ui(opts.stage)}")
        return
    if not opts.engine.is_file():
        sys.exit(f"No engine at {opts.engine}: build packaging/windows/tessera.iss first.")
    files, size = app_stats(opts.app) if opts.app.is_dir() else (0, 0)

    opts.out.parent.mkdir(parents=True, exist_ok=True)
    compile_host(opts.out)
    info = json.dumps({
        "version": opts.version,
        "files": files,
        "bytes": size,
        "license": (ROOT / "LICENSE").read_text(encoding="utf-8"),
    }).encode("utf-8")
    engine_len = opts.engine.stat().st_size
    with opts.out.open("ab") as out, opts.engine.open("rb") as engine:
        shutil.copyfileobj(engine, out, 1 << 20)
        out.write(info)
        out.write(struct.pack("<qi", engine_len, len(info)) + MAGIC)
    print(f"Built {opts.out} ({opts.out.stat().st_size / 1e6:.1f} MB, {files} app files)")


if __name__ == "__main__":
    main()
