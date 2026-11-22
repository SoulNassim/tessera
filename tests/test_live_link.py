"""Live Link knows which copies in the game are current, stale or edited, by content, and never writes to the game."""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image

from forge import asset_index, live_link


def _picture(path: Path, colour: tuple[int, int, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (48, 48), colour).save(path)


def _project(tmp_path: Path, kind: str = "ui") -> tuple[Path, Path]:
    """A game with its Tessera project inside it: one asset, one picked image."""
    game = tmp_path / "game"
    ws = game / "tessera" / "art"
    (game / "tessera" / ".studio").mkdir(parents=True)
    (game / "assets").mkdir()
    _picture(ws / "ui" / "health-bar" / "candidates" / "health-bar-1.png", (200, 30, 30))
    (ws / "ui" / "health-bar.md").write_text(
        f"---\nkind: {kind}\nprompt: a health bar\nwinner: ui/health-bar/candidates/health-bar-1.png\n---\n# Health Bar\n", encoding="utf-8")
    return game, ws


def _asset(snap: dict, path: str = "ui/health-bar.md") -> dict:
    return next(a for a in snap["assets"] if a["path"] == path)


def _game_files(game: Path) -> dict[str, bytes]:
    return {p.relative_to(game).as_posix(): p.read_bytes() for p in game.rglob("*") if p.is_file() and "tessera" not in p.relative_to(game).parts}


def test_finished_asset_waits_for_the_game_until_its_copy_is_there(tmp_path: Path) -> None:
    game, ws = _project(tmp_path)
    snap = live_link.snapshot(ws)
    asset = _asset(snap)
    assert snap["game"]["linked"] and asset["ready"] and asset["at"] == "game"
    assert asset["stages"] == {"concept": "done", "picked": "done", "model": "na", "motion": "na", "game": "todo"}

    shutil.copy(ws / "ui/health-bar/candidates/health-bar-1.png", game / "assets" / "hp.png")  # renamed on the way in
    asset = _asset(live_link.snapshot(ws))
    assert asset["at"] == "shipped" and asset["stages"]["game"] == "done"
    assert asset["files"][0]["copies"] == [{"file": "assets/hp.png", "state": "current"}]


def test_copy_of_an_older_version_is_stale_and_listed_for_the_agent(tmp_path: Path) -> None:
    game, ws = _project(tmp_path)
    live_link.snapshot(ws)  # Tessera sees version one
    shutil.copy(ws / "ui/health-bar/candidates/health-bar-1.png", game / "assets" / "hp.png")
    # The user picks a new winner.
    _picture(ws / "ui" / "health-bar" / "candidates" / "health-bar-2.png", (30, 200, 30))
    page = ws / "ui" / "health-bar.md"
    page.write_text(page.read_text(encoding="utf-8").replace("health-bar-1.png", "health-bar-2.png"), encoding="utf-8")

    snap = live_link.snapshot(ws)
    asset = _asset(snap)
    assert asset["at"] == "stale" and asset["stages"]["game"] == "stale"
    assert snap["totals"]["stale"] == 1 and snap["totals"]["stale_files"] == 1
    assert live_link.out_of_date(snap) == [{
        "game_file": "assets/hp.png", "asset": "Health Bar", "what": "Picked image",
        "replace_with": "tessera/art/ui/health-bar/candidates/health-bar-2.png"}]
    assert "`assets/hp.png` ← `tessera/art/ui/health-bar/candidates/health-bar-2.png`" in live_link.agent_note(snap)

    # The index tells the coding agent, in both of its files.
    asset_index.write(ws, "Game")
    text = (game / "tessera" / "ASSETS.md").read_text(encoding="utf-8")
    assert "## Copies in the game that are out of date" in text and "`assets/hp.png`" in text
    assert '"state": "stale"' in (game / "tessera" / "ASSETS.json").read_text(encoding="utf-8")

    # The agent copies the new file: current again, and the section goes away.
    shutil.copy(ws / "ui/health-bar/candidates/health-bar-2.png", game / "assets" / "hp.png")
    assert _asset(live_link.snapshot(ws))["at"] == "shipped"
    asset_index.write(ws, "Game")
    assert "out of date" not in (game / "tessera" / "ASSETS.md").read_text(encoding="utf-8")


def test_picking_the_first_take_again_makes_its_copy_current(tmp_path: Path) -> None:
    game, ws = _project(tmp_path)
    live_link.snapshot(ws)
    shutil.copy(ws / "ui/health-bar/candidates/health-bar-1.png", game / "assets" / "hp.png")
    _picture(ws / "ui" / "health-bar" / "candidates" / "health-bar-2.png", (30, 200, 30))
    page = ws / "ui" / "health-bar.md"
    first = page.read_text(encoding="utf-8")
    page.write_text(first.replace("health-bar-1.png", "health-bar-2.png"), encoding="utf-8")
    assert _asset(live_link.snapshot(ws))["at"] == "stale"
    page.write_text(first, encoding="utf-8")
    assert _asset(live_link.snapshot(ws))["at"] == "shipped"


def test_a_file_named_like_the_asset_is_an_edited_copy(tmp_path: Path) -> None:
    game, ws = _project(tmp_path)
    _picture(game / "assets" / "health_bar.png", (1, 2, 3))  # the agent resized or repainted it
    asset = _asset(live_link.snapshot(ws))
    assert asset["stages"]["game"] == "edited" and asset["edited"] == ["assets/health_bar.png"]
    assert asset["at"] == "game"  # not counted as shipped: Tessera can't vouch for it


def test_stages_follow_kind_and_dimension(tmp_path: Path) -> None:
    _, ws = _project(tmp_path, kind="character")
    (ws / "sfx").mkdir()
    (ws / "sfx" / "roar.md").write_text("---\nkind: sfx\nprompt: a roar\n---\n# Roar\n", encoding="utf-8")
    snap = live_link.snapshot(ws)
    hero = _asset(snap)
    assert hero["stages"]["model"] == "todo" and hero["stages"]["motion"] == "todo" and hero["at"] == "model" and not hero["ready"]
    roar = _asset(snap, "sfx/roar.md")
    assert roar["stages"] == {"concept": "todo", "picked": "todo", "model": "na", "motion": "na", "game": "todo"} and roar["at"] == "concept"
    assert snap["totals"]["model"] == 1 and snap["totals"]["concept"] == 1


def test_requests_are_matched_to_assets(tmp_path: Path) -> None:
    game, ws = _project(tmp_path)
    (game / "tessera" / "REQUESTS.md").write_text(
        "- [ ] Health Bar: wider, 3 segments\n- [ ] Stone Altar: new prop, 2.5 m tall\n- [x] Old thing\n", encoding="utf-8")
    snap = live_link.snapshot(ws)
    states = {r["text"].split(":")[0]: (r["state"], r["asset"]) for r in snap["requests"]}
    assert states == {"Health Bar": ("ready", "ui/health-bar.md"), "Stone Altar": ("new", ""), "Old thing": ("done", "")}
    assert snap["totals"]["requests"] == 2 and snap["totals"]["requests_ready"] == 1
    assert "Health Bar: wider, 3 segments" in live_link.agent_note(snap)


def test_the_game_folder_is_only_read(tmp_path: Path) -> None:
    game, ws = _project(tmp_path)
    shutil.copy(ws / "ui/health-bar/candidates/health-bar-1.png", game / "assets" / "hp.png")
    (game / "node_modules" / "pkg").mkdir(parents=True)
    shutil.copy(ws / "ui/health-bar/candidates/health-bar-1.png", game / "node_modules" / "pkg" / "hp.png")
    before = _game_files(game)
    snap = live_link.snapshot(ws)
    asset_index.write(ws, "Game")
    assert _game_files(game) == before
    # Tooling folders and Tessera's own folder are never searched for copies.
    assert [c["file"] for f in _asset(snap)["files"] for c in f["copies"]] == ["assets/hp.png"]


def test_unlinked_project_stops_at_ready(tmp_path: Path) -> None:
    ws = tmp_path / "projects" / "solo" / "art"
    (tmp_path / "projects" / "solo" / ".studio").mkdir(parents=True)
    _picture(ws / "logo" / "candidates" / "logo-1.png", (9, 9, 9))
    (ws / "logo.md").write_text("---\nkind: ui\nprompt: a logo\nwinner: logo/candidates/logo-1.png\n---\n# Logo\n", encoding="utf-8")
    snap = live_link.snapshot(ws)
    assert not snap["game"]["linked"] and _asset(snap, "logo.md")["at"] == "ready" and _asset(snap, "logo.md")["stages"]["game"] == "na"
    assert live_link.agent_note(snap).startswith("Tessera has newer art")


def test_api_serves_the_snapshot_and_the_note(tmp_path: Path, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    monkeypatch.setenv("FORGE_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("FORGE_PROJECTS_DIR", str(tmp_path / "projects"))
    from forge.server.app import app

    client = TestClient(app, base_url="http://127.0.0.1:8420")
    name = client.post("/api/projects", json={"name": "link-api", "unique": True}).json()["project"]
    ws = Path(client.get("/api/storage", params={"project": name}).json()["workspace_dir"])
    _picture(ws / "logo" / "candidates" / "logo-1.png", (9, 9, 9))
    (ws / "logo.md").write_text("---\nkind: ui\nprompt: a logo\nwinner: logo/candidates/logo-1.png\n---\n# Logo\n", encoding="utf-8")
    snap = client.get("/api/link", params={"project": name}).json()
    assert [a["title"] for a in snap["assets"]] == ["Logo"] and [s["id"] for s in snap["stages"]] == ["concept", "picked", "model", "motion", "game"]
    assert "Logo" in client.get("/api/link/note", params={"project": name}).json()["note"]


def test_listing_paths_need_no_resolving_and_headers_are_parsed_once(tmp_path: Path, monkeypatch) -> None:
    """Big projects were slow because every file was resolved and every page header parsed several times."""
    from forge import asset_studio, blueprint_contract, showcase

    _, ws = _project(tmp_path)
    assert asset_studio._ws_rel(ws, ws / "ui" / "health-bar.md") == "ui/health-bar.md"
    assert asset_studio._ws_rel(ws, ws / "ui" / ".." / "ui" / "health-bar.md") == "ui/health-bar.md"  # still safe
    light = asset_studio.describe_asset(ws, "ui/health-bar.md", full=False)
    full = asset_studio.describe_asset(ws, "ui/health-bar.md")
    assert light["outputs"] == full["outputs"] and light["winner"] == full["winner"] and light["pillars"] == []

    parses = []
    real = blueprint_contract.split_frontmatter
    monkeypatch.setattr(blueprint_contract, "split_frontmatter", lambda text: parses.append(1) or real(text))
    blueprint_contract._doc_cache.clear()
    showcase.board(ws, "game")
    showcase.board(ws, "game")
    assert len(parses) == 1  # one page, read many times, parsed once
    page = ws / "ui" / "health-bar.md"
    page.write_text(page.read_text(encoding="utf-8").replace("# Health Bar", "# Health Bar II"), encoding="utf-8")
    assert showcase.board(ws, "game")["groups"][0]["assets"][0]["title"] == "Health Bar II"  # a change is seen at once
