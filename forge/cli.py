"""CLI entrypoint for Tessera (`tessera`, `uv run forge` or `./run`).

  tessera         run the studio at http://127.0.0.1:8420 and open it in the browser
  tessera connect    make or find this game folder's Tessera project, connect its coding agents, open Tessera on it
  tessera open       open Tessera on this game folder's project (starting it in the background if needed)
  tessera shortcut   put a Tessera shortcut on the desktop and in the Start menu / app list
  tessera migrate    move projects made before Tessera Studio 4 to the simpler folder layout (--dry-run, --undo)
  tessera --mcp      the stdio MCP server coding agents start
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
import threading
import time
import uvicorn

from forge import __version__, brand
from forge.config import load_config
from forge.server.security import is_loopback


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="tessera",
        description=f"{brand.NAME}: {brand.TAGLINE.lower()}, driven by your coding agent",
        epilog="tessera connect   connect this game folder's coding agents to Tessera and open it\n"
               "tessera open      open Tessera on this game folder (starting it if needed)\n"
               "tessera shortcut  add a Tessera shortcut to the desktop and Start menu\n"
               "tessera migrate   upgrade this game's project to the simpler folder layout (--dry-run first; --undo)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("command", nargs="?", choices=["connect", "open", "shortcut", "migrate"], help="connect, open, shortcut or migrate (default: run the studio)")
    parser.add_argument("--game", default=None, help="connect/open: the game folder (default: the current folder)")
    parser.add_argument("--agents", default="", help="connect: comma-separated agents (claude,codex,cursor,vscode,opencode,gemini)")
    parser.add_argument("--host", default=None, help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="Bind port (default: 8420)")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser on start")
    parser.add_argument("--mcp", action="store_true", help="Run as stdio MCP server instead of HTTP server")
    parser.add_argument("--project", default=None, help="With --mcp: the Tessera project this agent works on")
    parser.add_argument("--dry-run", action="store_true", help="migrate: list what would move, change nothing")
    parser.add_argument("--undo", action="store_true", help="migrate: put an upgraded project (or the library) back")
    parser.add_argument("--all", action="store_true", help="migrate: every project in the library")
    parser.add_argument("--library", action="store_true", help="migrate: move ~/Glob/projects to ~/Tessera/projects")
    parser.add_argument("--desktop", action="store_true", help="Open Tessera in its app window, starting it in the background if needed")
    args = parser.parse_args()
    if Path(sys.argv[0]).stem.lower() == "glob" and not args.mcp:
        # Agents and scripts set up before the rename still type `glob`: it works, and says what it is called now.
        print(f"  (`glob` is now `{brand.CLI}`; both work.)", file=sys.stderr)
    # A redirected Windows console is cp1252: the banner's arrows must not crash the start.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    if args.command == "migrate":
        _migrate(args)
        return
    if args.command:
        _launch(args)
        return
    if args.mcp:
        if args.project:
            os.environ["FORGE_PROJECT"] = args.project
        from forge.mcp.server import main as mcp_main
        mcp_main()
        return
    if args.desktop:
        from forge.desktop import main as desktop_main
        desktop_main(args.port)
        return

    cfg = load_config()
    host = args.host or cfg.host or "127.0.0.1"
    port = args.port or cfg.port or 8420
    url = f"http://{host}:{port}"

    print(f"\n  {brand.NAME} {__version__}: {brand.TAGLINE.lower()}")
    print(f"  -> Studio       : {url}")
    print(f"  -> Your game    : run `tessera connect` in your game folder; your coding agent copies art from tessera/ASSETS.md")
    print(f"  -> Mode         : {'Demo Mode (No API keys needed)' if cfg.demo_mode else 'Live Provider Mode'}\n")

    if not args.no_browser:
        def _open() -> None:
            time.sleep(1.1)
            from forge.appwindow import open_window
            open_window(url)
        threading.Thread(target=_open, daemon=True).start()

    if not is_loopback(host):
        print("  !! WARNING: Tessera has no login. Binding to a non-local address lets anyone on your network\n"
              "     use your API keys and write project files.\n")
    os.environ["FORGE_BIND_HOST"] = host
    if os.environ.get("FORGE_BACKGROUND") == "1":
        from forge import tray
        tray.start(f"http://127.0.0.1:{port}")  # no window or terminal: the tray icon opens and quits Tessera
    uvicorn.run("forge.server.app:app", host=host, port=port, log_level="info")


def _migrate(args: argparse.Namespace) -> None:
    from forge import launcher, migrate
    from forge.storage.project_store import home_owner

    try:
        if args.library:
            if args.undo:
                done = migrate.undo_library(running=launcher.is_running)
                print(f"\n  Library moved back: {done['to']}\n")
                return
            p = migrate.migrate_library(dry_run=args.dry_run, running=launcher.is_running)
            if not p["needed"]:
                print("\n  Nothing to move: the library is already in ~/Tessera/projects.\n")
            elif p["blocked"]:
                print(f"\n  !! {p['blocked']}\n")
            else:
                print(f"\n  {'Would move' if args.dry_run else 'Moved'}: {p['from']}  ->  {p['to']}\n")
            return
        if args.all:
            projects = migrate.projects_to_upgrade()
        elif args.project:
            projects = [args.project]
        else:
            game = Path(os.path.abspath(args.game or os.getcwd()))
            owner = home_owner(game)
            if not owner:
                raise SystemExit("  !! This folder has no Tessera project. Use --project <name>, or --all.")
            projects = [owner]
        if not projects:
            print("\n  Every project already uses the new layout.\n")
            return
        if launcher.is_running() and not args.dry_run:
            # The running studio keeps the old paths open; the app's own "Upgrade project" button is safe while running.
            raise SystemExit("  !! Tessera Studio is running. Use its Upgrade button, or quit it and run this again.")
        for project in projects:
            if args.undo:
                done = migrate.undo(project, refresh=migrate.refresh_files)
                print(f"\n  {project}: put back the way it was, in {done['home']}")
                continue
            p = migrate.migrate(project, dry_run=args.dry_run, refresh=None if args.dry_run else migrate.refresh_files)
            if not p["needed"]:
                print(f"\n  {project}: already uses the new layout.")
                continue
            print(f"\n  {project}{' (dry run)' if args.dry_run else ''}: {p['home']}")
            for line in migrate.describe(p):
                print(f"    {line}")
            if p["blocked"]:
                print(f"  !! {p['blocked']}")
            elif args.dry_run:
                print("  Nothing changed. Run without --dry-run to do it; `tessera migrate --undo` puts it back.")
            else:
                print("  Done. `tessera migrate --undo` puts it back.")
        print()
    except migrate.MigrationError as exc:
        raise SystemExit(f"  !! {exc}") from exc


def _launch(args: argparse.Namespace) -> None:
    from forge import launcher
    from forge.agent import connect as connect_agent
    from forge.storage.project_store import home_owner

    from forge import shortcut

    if args.command == "shortcut":
        try:
            made = shortcut.create()
        except (RuntimeError, OSError) as exc:
            raise SystemExit(f"  !! {exc}") from exc
        print("\n  Tessera shortcut added: " + ", ".join(str(p) for p in made))
        print("  Double-click it any time to open Tessera.\n")
        return
    game = os.path.abspath(args.game or os.getcwd())
    try:
        if args.command == "connect":
            agents = [a.strip() for a in args.agents.split(",") if a.strip()] or None
            result = connect_agent.connect_game(game, agents)
            project = result["project"]
            print(f"\n  Tessera project : {project} ({'new, in ' + os.path.join(game, 'tessera') if result['created'] else 'already made'})")
            print(f"  -> Note      : {', '.join(result['notes'])} tell your coding agent to copy art from tessera/ASSETS.md")
        else:
            project = home_owner(Path(game)) or ""
            if not project:
                print("  This folder isn't connected to Tessera yet; opening Tessera. Run `tessera connect` to connect it.")
        opened = launcher.open_tessera(project)
    except (RuntimeError, ValueError, OSError) as exc:
        raise SystemExit(f"  !! {exc}") from exc
    print(f"\n  Tessera is open: {opened['url']}")
    if args.command == "connect":
        # The first time, a shortcut too: Tessera should open without an agent as well.
        if not shortcut.exists():
            try:
                made = shortcut.create()
                print(f"  -> Shortcut  : {made[0]} (open Tessera any time, no agent needed)")
            except (RuntimeError, OSError):
                pass
        print("  Make your art in Tessera. Your coding agent copies it from tessera/ASSETS.md; nothing to restart.\n")


if __name__ == "__main__":
    main()
