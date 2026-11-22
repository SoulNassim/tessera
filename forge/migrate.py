"""Move a project made before Tessera Studio 4 to the new layout (forge.layout), and back.

Before:  <game>/glob/{workspace, vault, assets, exports, logs, inbox_watch, .thumbs, manifest.db, project.json, ...}
After:   <game>/tessera/{art, export, .studio/…, ASSETS.md, README.md}

Rules this follows, because it touches the user's only copy of their art:
- Nothing is deleted. Folders and files are renamed in place (same drive, so nothing is copied either).
- `plan()` lists every step first; the app and `tessera migrate --dry-run` show it before anything happens.
- Every step is written to a journal (`.studio/migration.json`) the moment it is done. A failure part-way undoes the
  steps already done; `undo()` replays the journal backwards at any later time.
- It refuses to run while a job is generating, and when a destination already exists.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable

from forge.layout import GAME_FOLDER, GAME_IGNORE, LEGACY_GAME_FOLDER, MOVES, STUDIO, Layout, readme_text

JOURNAL = "migration.json"
ACTIVE = ("running", "queued", "waiting")


class MigrationError(RuntimeError):
    pass


def _home(project: str, root: Path | None) -> Path:
    from forge.storage.project_store import project_home

    return project_home(project, root).resolve()


def _entry(project: str, root: Path | None) -> Path:
    from forge.config import get_projects_root

    return (root or get_projects_root()) / project


def refresh_files(project: str, root: Path | None = None) -> None:
    """After a move: rewrite ASSETS.md and the game's agent note so they name the new paths."""
    from forge import asset_index
    from forge.agent import connect
    from forge.storage.project_store import ProjectStore

    store = ProjectStore(project_name=project, root_dir=root)
    asset_index.write(store.layout.art, store.get_bible().display_name or project)
    connect.refresh(project, root)


def projects_to_upgrade(root: Path | None = None) -> list[str]:
    """Every project still in the old layout."""
    from forge.storage.project_store import list_all_projects

    out = []
    for name in list_all_projects(root):
        try:
            if plan(name, root)["needed"]:
                out.append(name)
        except OSError:
            continue
    return out


def _busy(home: Path) -> str:
    """Why the project can't be moved right now, or ""."""
    layout = Layout.of(home)
    try:
        jobs = json.loads(layout.jobs.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        jobs = []
    rows = jobs.values() if isinstance(jobs, dict) else jobs if isinstance(jobs, list) else []
    if any(isinstance(job, dict) and str(job.get("status", "")).lower() in ACTIVE for job in rows):
        return "A job is still generating in this project. Wait for it to finish, then upgrade."
    return ""


def _is_legacy_ignore(text: str) -> bool:
    """The .gitignore an older version wrote (whatever it called itself), not one the user changed."""
    lines = [line.strip() for line in text.strip().splitlines()]
    return bool(lines) and lines[0].startswith("#") and lines[1:] == ["manifest.db*", "studio_jobs.json", "logs/", "inbox_watch/", "assets/", ".thumbs/"]


def plan(project: str, root: Path | None = None) -> dict[str, Any]:
    """What `migrate` would do, step by step, without doing it."""
    home = _home(project, root)
    layout = Layout.of(home)
    steps: list[dict[str, str]] = []
    blocked = ""
    if layout.legacy:
        for old, new in MOVES:
            if (home / old).exists():
                if (home / new).exists():
                    blocked = blocked or f"Both {old} and {new} exist in {home}; move one of them away first."
                steps.append({"do": "move", "from": old, "to": new})
        ignore = home / ".gitignore"
        if ignore.is_file():
            steps.append({"do": "gitignore", "to": ".gitignore"})
    target_home = home
    if home.name == LEGACY_GAME_FOLDER and (home.parent / GAME_FOLDER) != home:
        target_home = home.parent / GAME_FOLDER
        if target_home.exists():
            blocked = blocked or f"{target_home} already exists; rename or remove it first."
        steps.append({"do": "rename_home", "from": str(home), "to": str(target_home)})
    if steps:
        blocked = blocked or _busy(home)
    return {
        "project": project,
        "home": str(home),
        "new_home": str(target_home),
        "steps": steps,
        "needed": bool(steps),
        "blocked": blocked,
    }


def describe(p: dict[str, Any]) -> list[str]:
    """The plan as lines a person reads."""
    out = []
    for step in p["steps"]:
        if step["do"] == "move":
            out.append(f"move   {step['from']}  ->  {step['to']}")
        elif step["do"] == "gitignore":
            out.append("update .gitignore for the new folders (your own lines are kept)")
        else:
            out.append(f"rename {step['from']}  ->  {step['to']}")
    return out


def _write_journal(home: Path, journal: dict[str, Any]) -> None:
    folder = home / STUDIO
    folder.mkdir(exist_ok=True)
    tmp = folder / (JOURNAL + ".part")
    tmp.write_text(json.dumps(journal, indent=2), encoding="utf-8")
    os.replace(tmp, folder / JOURNAL)


def _rename(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.rename(src, dst)
    except OSError as exc:
        raise MigrationError(f"Couldn't move {src} to {dst}: {exc.strerror or exc}. Close any program using it and try again.") from exc


def _set_home_pointer(project: str, root: Path | None, folder: Path) -> str | None:
    """Point the project's entry at its new folder; returns what it said before (None when it had no pointer)."""
    from forge.storage.project_store import HOME_FILE

    pointer = _entry(project, root) / HOME_FILE
    if not pointer.is_file():
        return None
    before = pointer.read_text(encoding="utf-8")
    pointer.write_text(json.dumps({"folder": str(folder)}, indent=2), encoding="utf-8")
    return before


def migrate(project: str, root: Path | None = None, dry_run: bool = False, refresh: Callable[[str], None] | None = None) -> dict[str, Any]:
    """Move the project to the new layout. Returns the plan with `done: true`, or just the plan for a dry run."""
    p = plan(project, root)
    if dry_run or not p["needed"]:
        return p | {"done": False}
    if p["blocked"]:
        raise MigrationError(p["blocked"])
    home = Path(p["home"])
    journal: dict[str, Any] = {"version": 1, "project": project, "started": time.time(), "home": str(home), "steps": []}
    created_studio = not (home / STUDIO).exists()
    if created_studio:
        (home / STUDIO).mkdir()
        journal["steps"].append({"do": "mkdir", "path": STUDIO})
    _write_journal(home, journal)
    try:
        for step in p["steps"]:
            if step["do"] == "move":
                _rename(home / step["from"], home / step["to"])
                journal["steps"].append(step)
            elif step["do"] == "gitignore":
                ignore = home / ".gitignore"
                before = ignore.read_text(encoding="utf-8")
                if _is_legacy_ignore(before):
                    after = GAME_IGNORE
                elif f"{STUDIO}/*" in before:
                    after = before
                else:
                    after = before.rstrip() + "\n\n" + GAME_IGNORE
                ignore.write_text(after, encoding="utf-8")
                journal["steps"].append({"do": "gitignore", "before": before})
            elif step["do"] == "rename_home":
                _write_journal(home, journal)
                new_home = Path(step["to"])
                _rename(home, new_home)
                home = new_home
                journal["home"] = str(home)
                journal["steps"].append({"do": "rename_home", "from": step["from"], "to": step["to"],
                                         "pointer_before": _set_home_pointer(project, root, home)})
            _write_journal(home, journal)
        if not (home / "README.md").exists():
            (home / "README.md").write_text(readme_text(project), encoding="utf-8")
            journal["steps"].append({"do": "readme"})
        journal["finished"] = time.time()
        _write_journal(home, journal)
    except Exception:
        _replay_back(project, root, home, journal)
        raise
    if refresh:
        refresh(project)
    return p | {"done": True, "home": str(home)}


def _replay_back(project: str, root: Path | None, home: Path, journal: dict[str, Any]) -> Path:
    """Undo the journal's steps, newest first. Returns where the project folder is afterwards."""
    for step in reversed(journal.get("steps", [])):
        if step["do"] == "rename_home":
            old = Path(step["from"])
            _rename(home, old)
            home = old
            pointer_before = step.get("pointer_before")
            if pointer_before is not None:
                from forge.storage.project_store import HOME_FILE

                (_entry(project, root) / HOME_FILE).write_text(pointer_before, encoding="utf-8")
        elif step["do"] == "move":
            _rename(home / step["to"], home / step["from"])
        elif step["do"] == "gitignore":
            (home / ".gitignore").write_text(step["before"], encoding="utf-8")
        elif step["do"] == "readme":
            (home / "README.md").unlink(missing_ok=True)
    studio = home / STUDIO
    (studio / JOURNAL).unlink(missing_ok=True)
    (studio / (JOURNAL + ".part")).unlink(missing_ok=True)
    if any(step["do"] == "mkdir" for step in journal.get("steps", [])):
        try:
            studio.rmdir()
        except OSError:
            pass  # something new was written there since: keep it
    return home


def undo(project: str, root: Path | None = None, refresh: Callable[[str], None] | None = None) -> dict[str, Any]:
    """Put a migrated project back the way it was, from its journal."""
    home = _home(project, root)
    try:
        journal = json.loads((home / STUDIO / JOURNAL).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MigrationError("This project has no record of an upgrade to undo.") from exc
    reason = _busy(home)
    if reason:
        raise MigrationError(reason)
    home = _replay_back(project, root, home, journal)
    if refresh:
        refresh(project)
    return {"project": project, "home": str(home), "undone": True}


def library_plan(home: Path | None = None) -> dict[str, Any]:
    """Moving the project library from ~/Glob/projects to ~/Tessera/projects (installs from before the rename)."""
    home = home or Path.home()
    old, new = home / "Glob" / "projects", home / "Tessera" / "projects"
    has = old.is_dir() and any(d.is_dir() for d in old.iterdir())
    blocked = ""
    if has and new.is_dir() and any(new.iterdir()):
        blocked = f"{new} already has projects; move them yourself or keep using {old}."
    return {"from": str(old), "to": str(new), "needed": has, "blocked": blocked}


def migrate_library(home: Path | None = None, dry_run: bool = False, running: Callable[[], bool] | None = None) -> dict[str, Any]:
    """Rename ~/Glob/projects to ~/Tessera/projects (one rename; projects living in game folders stay where they are)."""
    p = library_plan(home)
    if dry_run or not p["needed"]:
        return p | {"done": False}
    if p["blocked"]:
        raise MigrationError(p["blocked"])
    if running and running():
        raise MigrationError("Tessera Studio is running. Quit it (tray icon > Quit), then move the library.")
    old, new = Path(p["from"]), Path(p["to"])
    if new.is_dir():
        new.rmdir()  # empty: checked above
    _rename(old, new)
    return p | {"done": True}


def undo_library(home: Path | None = None, running: Callable[[], bool] | None = None) -> dict[str, Any]:
    home = home or Path.home()
    old, new = home / "Glob" / "projects", home / "Tessera" / "projects"
    if not new.is_dir() or (old.is_dir() and any(old.iterdir())):
        raise MigrationError(f"Nothing to move back: {new} is missing or {old} is not empty.")
    if running and running():
        raise MigrationError("Tessera Studio is running. Quit it, then move the library back.")
    if old.is_dir():
        old.rmdir()
    _rename(new, old)
    return {"from": str(new), "to": str(old), "undone": True}
