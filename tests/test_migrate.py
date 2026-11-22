"""Upgrading a project made before Tessera Studio 4 to the new layout, and back (forge.migrate)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from forge import migrate
from forge.layout import GAME_IGNORE, LEGACY_GAME_IGNORE, Layout
from forge.storage.project_store import HOME_FILE, ProjectStore, project_home


def _snapshot(folder: Path) -> dict[str, bytes | None]:
    """Every file and folder under `folder`, with each file's bytes."""
    return {p.relative_to(folder).as_posix(): (p.read_bytes() if p.is_file() else None) for p in sorted(folder.rglob("*"))}


@pytest.fixture()
def legacy(tmp_path: Path) -> tuple[str, Path, Path]:
    """A game whose project lives in <game>/glob/ with the old layout, made the way an older version made it."""
    return _make_legacy(tmp_path / "projects", tmp_path / "game")


def _make_legacy(root: Path, game: Path) -> tuple[str, Path, Path]:
    home = game / "glob"
    (home / "workspace" / "characters").mkdir(parents=True)
    (home / "workspace" / "characters" / "hero.md").write_text("---\nwinner: characters/hero.png\n---\n# Hero\n", encoding="utf-8")
    (home / "workspace" / "characters" / "hero.png").write_bytes(b"\x89PNG fake hero")
    (home / "vault" / "characters").mkdir(parents=True)
    (home / "vault" / "characters" / "hero.v1.png").write_bytes(b"\x89PNG old hero")
    (home / ".thumbs").mkdir()
    (home / ".thumbs" / "hero.webp").write_bytes(b"thumb")
    (home / "ASSETS.md").write_text("# Assets\n- glob/workspace/characters/hero.png\n", encoding="utf-8")
    (home / ".gdignore").touch()
    (home / ".gitignore").write_text(LEGACY_GAME_IGNORE, encoding="utf-8")
    (root / "dungeon").mkdir(parents=True)
    (root / "dungeon" / HOME_FILE).write_text(json.dumps({"folder": str(home.resolve())}), encoding="utf-8")
    store = ProjectStore("dungeon", root_dir=root)  # writes manifest.db, project.json, assets/, logs/ ... the old way
    assert store.layout.legacy and (home / "manifest.db").is_file() and (home / "project.json").is_file()
    return "dungeon", root, game


def test_dry_run_lists_every_move_and_changes_nothing(legacy: tuple[str, Path, Path]) -> None:
    project, root, game = legacy
    before = _snapshot(game)
    p = migrate.migrate(project, root, dry_run=True)
    assert p["needed"] and not p["blocked"] and not p["done"]
    moves = {(s["from"], s["to"]) for s in p["steps"] if s["do"] == "move"}
    assert ("workspace", "art") in moves and ("manifest.db", ".studio/studio.db") in moves and ("vault", ".studio/history") in moves
    assert p["new_home"] == str((game / "tessera").resolve())
    assert any("rename" in line for line in migrate.describe(p))
    assert _snapshot(game) == before


def test_migrate_moves_everything_and_the_project_still_opens(legacy: tuple[str, Path, Path]) -> None:
    project, root, game = legacy
    refreshed: list[str] = []
    result = migrate.migrate(project, root, refresh=refreshed.append)
    home = game / "tessera"
    assert result["done"] and refreshed == [project]
    assert not (game / "glob").exists()
    assert project_home(project, root).resolve() == home.resolve()
    assert (home / "art" / "characters" / "hero.png").read_bytes() == b"\x89PNG fake hero"
    assert (home / ".studio" / "history" / "characters" / "hero.v1.png").read_bytes() == b"\x89PNG old hero"
    assert (home / ".studio" / "thumbs" / "hero.webp").is_file()
    assert (home / ".studio" / "studio.db").is_file() and (home / ".studio" / "project.json").is_file()
    assert (home / "README.md").is_file() and (home / ".gdignore").is_file()
    assert (home / ".gitignore").read_text(encoding="utf-8") == GAME_IGNORE
    for old in ("workspace", "vault", "assets", "logs", "manifest.db", "project.json", ".thumbs"):
        assert not (home / old).exists(), old
    store = ProjectStore(project, root_dir=root)
    assert not store.layout.legacy and store.layout.art == home / "art"
    # Paths stored before the move still find their file.
    assert store.layout.resolve("workspace/characters/hero.png").read_bytes() == b"\x89PNG fake hero"
    # Running it again has nothing left to do.
    assert not migrate.plan(project, root)["needed"]


def test_undo_puts_back_every_byte(legacy: tuple[str, Path, Path]) -> None:
    project, root, game = legacy
    before, entry_before = _snapshot(game), _snapshot(root)
    migrate.migrate(project, root)
    migrate.undo(project, root)
    assert _snapshot(game) == before
    assert _snapshot(root) == entry_before
    assert Layout.of(game / "glob").legacy


def test_a_failure_part_way_undoes_what_was_done(legacy: tuple[str, Path, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    project, root, game = legacy
    before = _snapshot(game)
    real = migrate._rename
    failed = []

    def flaky(src: Path, dst: Path) -> None:
        if src.name == "logs" and not failed:  # a folder some other program holds open
            failed.append(src)
            raise migrate.MigrationError("Couldn't move logs")
        real(src, dst)

    monkeypatch.setattr(migrate, "_rename", flaky)
    with pytest.raises(migrate.MigrationError):
        migrate.migrate(project, root)
    assert failed and _snapshot(game) == before


def test_a_failure_renaming_the_folder_undoes_the_moves_too(legacy: tuple[str, Path, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    project, root, game = legacy
    before, entry_before = _snapshot(game), _snapshot(root)
    real = migrate._rename

    def flaky(src: Path, dst: Path) -> None:
        if dst.name == "tessera":
            raise migrate.MigrationError("the game folder is open in another program")
        real(src, dst)

    monkeypatch.setattr(migrate, "_rename", flaky)
    with pytest.raises(migrate.MigrationError):
        migrate.migrate(project, root)
    assert _snapshot(game) == before and _snapshot(root) == entry_before


def test_it_will_not_run_while_a_job_is_generating(legacy: tuple[str, Path, Path]) -> None:
    project, root, game = legacy
    (game / "glob" / "studio_jobs.json").write_text(json.dumps([{"id": "j1", "status": "running"}]), encoding="utf-8")
    before = _snapshot(game)
    assert "generating" in migrate.plan(project, root)["blocked"]
    with pytest.raises(migrate.MigrationError):
        migrate.migrate(project, root)
    assert _snapshot(game) == before


def test_it_will_not_overwrite_an_existing_folder(legacy: tuple[str, Path, Path]) -> None:
    project, root, game = legacy
    (game / "tessera").mkdir()
    (game / "tessera" / "notes.txt").write_text("mine", encoding="utf-8")
    p = migrate.plan(project, root)
    assert "already exists" in p["blocked"]
    with pytest.raises(migrate.MigrationError):
        migrate.migrate(project, root)
    assert (game / "glob" / "workspace").is_dir() and (game / "tessera" / "notes.txt").read_text(encoding="utf-8") == "mine"


def test_a_gitignore_the_user_changed_keeps_their_lines(legacy: tuple[str, Path, Path]) -> None:
    project, root, game = legacy
    mine = LEGACY_GAME_IGNORE + "my_secret_notes/\n"
    (game / "glob" / ".gitignore").write_text(mine, encoding="utf-8")
    migrate.migrate(project, root)
    text = (game / "tessera" / ".gitignore").read_text(encoding="utf-8")
    assert "my_secret_notes/" in text and ".studio/*" in text
    migrate.undo(project, root)
    assert (game / "glob" / ".gitignore").read_text(encoding="utf-8") == mine


def test_undo_without_an_upgrade_says_so(legacy: tuple[str, Path, Path]) -> None:
    project, root, _ = legacy
    with pytest.raises(migrate.MigrationError, match="no record"):
        migrate.undo(project, root)


def test_a_new_project_needs_no_upgrade(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    ProjectStore("fresh", root_dir=root)
    assert not migrate.plan("fresh", root)["needed"]


def test_the_library_moves_to_the_new_home_and_back(tmp_path: Path) -> None:
    old = tmp_path / "Glob" / "projects"
    (old / "dungeon").mkdir(parents=True)
    (old / "dungeon" / HOME_FILE).write_text("{}", encoding="utf-8")
    (tmp_path / "Tessera" / "projects").mkdir(parents=True)  # made empty by a first start of the new version
    assert migrate.migrate_library(tmp_path, dry_run=True)["needed"] and old.is_dir()
    with pytest.raises(migrate.MigrationError, match="running"):
        migrate.migrate_library(tmp_path, running=lambda: True)
    assert migrate.migrate_library(tmp_path, running=lambda: False)["done"]
    assert (tmp_path / "Tessera" / "projects" / "dungeon" / HOME_FILE).is_file() and not old.exists()
    assert not migrate.library_plan(tmp_path)["needed"]
    migrate.undo_library(tmp_path)
    assert (old / "dungeon" / HOME_FILE).is_file()


def test_the_library_never_merges_into_a_used_folder(tmp_path: Path) -> None:
    (tmp_path / "Glob" / "projects" / "a").mkdir(parents=True)
    (tmp_path / "Tessera" / "projects" / "b").mkdir(parents=True)
    assert migrate.library_plan(tmp_path)["blocked"]
    with pytest.raises(migrate.MigrationError):
        migrate.migrate_library(tmp_path)
    assert (tmp_path / "Glob" / "projects" / "a").is_dir()


def test_the_app_upgrades_and_undoes_a_project(tmp_path: Path) -> None:
    import os

    from fastapi.testclient import TestClient

    from forge.server.app import app

    root = Path(os.environ["FORGE_PROJECTS_DIR"])
    project, _, game = _make_legacy(root, tmp_path / "game")
    client = TestClient(app, base_url="http://127.0.0.1:8420")
    before = _snapshot(game)
    p = client.get(f"/api/projects/{project}/upgrade").json()
    assert p["needed"] and not p["blocked"] and not p["undoable"] and p["lines"]
    assert client.post(f"/api/projects/{project}/upgrade", json={}).json()["done"]
    ws = Path(client.get("/api/storage", params={"project": project}).json()["workspace_dir"])
    assert ws == (game / "tessera" / "art").resolve()
    assert "glob/workspace" not in (game / "tessera" / "ASSETS.md").read_text(encoding="utf-8")  # rewritten for the new paths
    after = client.get(f"/api/projects/{project}/upgrade").json()
    assert not after["needed"] and after["undoable"]
    client.post(f"/api/projects/{project}/upgrade", json={"undo": True}).raise_for_status()
    assert not (game / "tessera").exists() and (game / "glob" / "workspace" / "characters" / "hero.png").is_file()
    # The indexes are rewritten for the paths of the moment; everything else is byte for byte as before.
    generated = ("glob/ASSETS.", "glob/manifest.db")
    now = _snapshot(game)
    assert {k for k in now if not k.startswith(generated)} == {k for k in before if not k.startswith(generated)}
    assert all(now[k] == before[k] for k in before if not k.startswith(generated))
