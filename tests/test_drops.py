"""Drag and drop: staging, the plan (grouping, matching, kinds, folders), Tess sorting, applying and undo."""

from __future__ import annotations

import asyncio
import io
import zipfile
from pathlib import Path

from PIL import Image

from forge import drops
from forge.asset_studio import read_asset
from forge.blueprint_contract import serialize_frontmatter

GLB = b"glTF" + b"\x00" * 12


def png(color=(200, 40, 40)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), color).save(buffer, "PNG")
    return buffer.getvalue()


def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "art"
    (ws / "characters" / "enemies").mkdir(parents=True)
    (ws / "characters" / "README.md").write_text("# Characters\n", encoding="utf-8")
    (ws / "characters" / "enemies" / "README.md").write_text("# Enemies\n", encoding="utf-8")
    (ws / "sounds").mkdir()
    (ws / "sounds" / "README.md").write_text("# Sounds\n", encoding="utf-8")
    (ws / "characters" / "enemies" / "ember-golem.md").write_text(
        serialize_frontmatter({"kind": "creature", "prompt": "a golem"}, "# Ember Golem\n"), encoding="utf-8")
    return ws


def rows_by_title(plan):
    return {r["title"]: r for r in plan["rows"]}


def test_stage_skips_clutter_and_unpacks_zips(tmp_path):
    ws = workspace(tmp_path)
    pack = io.BytesIO()
    with zipfile.ZipFile(pack, "w") as z:
        z.writestr("pack/hero.png", png())
        z.writestr("pack/License.txt", "CC0")
        z.writestr("__MACOSX/pack/._hero.png", "junk")
    staged = drops.stage(ws, [("pack.zip", pack.getvalue()), ("Thumbs.db", b"x"), ("../../evil.png", png())])
    assert "pack/pack/hero.png" in staged["files"]
    assert "evil.png" in staged["files"]  # the '..' is dropped, never written outside the drop
    why = {s["name"]: s["why"] for s in staged["skipped"]}
    assert why["pack/pack/License.txt"] == "not art"
    assert "Thumbs.db" in why
    assert not any("MACOSX" in f for f in staged["files"])


def test_plan_matches_names_groups_frames_and_guesses_kinds(tmp_path):
    ws = workspace(tmp_path)
    staged = drops.stage(ws, [
        ("Ember Golem.png", png()),
        ("knight_run_01.png", png()), ("knight_run_02.png", png()), ("knight_run_03.png", png()),
        ("sfx/door_creak.wav", b"RIFF0000WAVE"),
    ])
    rows = rows_by_title(drops.plan(ws, staged["id"]))
    golem = rows["Ember Golem"]
    assert golem["action"] == "add" and golem["match"] == "characters/enemies/ember-golem.md"
    run = rows["Knight Run"]
    assert run["action"] == "new" and len(run["files"]) == 3 and run["kind"] == "character"
    assert run["folder"] == "characters"
    creak = rows["Door Creak"]
    assert creak["type"] == "audio" and creak["kind"] == "sfx" and creak["folder"] == "sounds"


def test_dropping_on_a_section_uses_its_folder_and_kind(tmp_path):
    ws = workspace(tmp_path)
    staged = drops.stage(ws, [("blob.png", png()), ("crate.png", png())])
    plan = drops.plan(ws, staged["id"], "characters/enemies")
    assert {r["folder"] for r in plan["rows"]} == {"characters/enemies"}
    assert {r["kind"] for r in plan["rows"]} == {"creature"}


def test_model_keeps_its_textures_and_preview(tmp_path):
    ws = workspace(tmp_path)
    staged = drops.stage(ws, [
        ("kit/barrel.glb", GLB), ("kit/barrel_preview.png", png()),
        ("kit/crate.glb", GLB), ("kit/colormap.png", png()), ("kit/crate_normal.png", png()),
    ])
    rows = rows_by_title(drops.plan(ws, staged["id"]))
    assert set(rows) == {"Barrel", "Crate"}
    assert "kit/colormap.png" in rows["Barrel"]["textures"] and "kit/colormap.png" in rows["Crate"]["textures"]
    assert "kit/crate_normal.png" in rows["Crate"]["textures"] and "kit/crate_normal.png" not in rows["Barrel"]["files"]
    assert "kit/barrel_preview.png" in rows["Barrel"]["files"] and "kit/barrel_preview.png" not in rows["Barrel"]["textures"]


def test_apply_adds_candidates_keeps_winner_and_undo_takes_it_back(tmp_path):
    ws = workspace(tmp_path)
    golem = "characters/enemies/ember-golem.md"
    staged = drops.stage(ws, [("Ember Golem.png", png()), ("slime.png", png()), ("kit/barrel.glb", GLB), ("kit/barrel_preview.png", png())])
    plan = drops.plan(ws, staged["id"])
    result = drops.apply(ws, staged["id"], plan["rows"])
    assert golem in result["updated"] and len(result["created"]) == 2 and not result["problems"]
    winner = read_asset(ws, golem)[1]["winner"]
    assert winner.endswith("candidates/Ember-Golem.png")
    barrel = next(r for r in result["created"] if r.endswith("barrel.md"))
    meta = read_asset(ws, barrel)[1]
    assert meta["imported"] is True and meta["winner"].endswith("barrel_preview.png")
    assert (ws / barrel.replace(".md", "") / "3d" / "barrel.glb").is_file()

    # A second drop on an asset that has a winner adds a candidate and leaves the winner alone.
    again = drops.stage(ws, [("other.png", png((0, 0, 255)))])
    drops.apply(ws, again["id"], drops.plan(ws, again["id"], golem)["rows"])
    assert read_asset(ws, golem)[1]["winner"] == winner

    drops.undo(ws, staged["id"])
    assert not (ws / barrel).exists()
    assert not read_asset(ws, golem)[1].get("winner")
    assert (ws / ".trash").is_dir()


def test_apply_makes_new_folders_and_undo_removes_them(tmp_path):
    ws = workspace(tmp_path)
    staged = drops.stage(ws, [("tree.png", png())])
    rows = drops.plan(ws, staged["id"])["rows"]
    rows[0]["folder"] = "nature/trees"
    result = drops.apply(ws, staged["id"], rows)
    assert result["created"] == ["nature/trees/tree.md"]
    drops.undo(ws, staged["id"])
    assert not (ws / "nature").exists()


def test_tess_sort_fills_names_kinds_folders_and_matches(tmp_path):
    ws = workspace(tmp_path)
    staged = drops.stage(ws, [("IMG_0042.png", png()), ("asset 7.png", png((0, 200, 0)))])
    plan = drops.plan(ws, staged["id"])
    seen = {}

    async def model_call(**kwargs):
        seen.update(kwargs)
        return {"text": '{"rows": [{"id": 1, "title": "Bramble Goblin", "kind": "creature", "folder": "characters/enemies", "match": ""},'
                        ' {"id": 2, "title": "Golem", "kind": "creature", "folder": "x", "match": "characters/enemies/ember-golem.md"}]}'}

    sorted_plan = asyncio.run(drops.tess_sort(ws, plan, model_call))
    assert sorted_plan["sorted_by"] == "tess"
    first, second = sorted_plan["rows"]
    assert (first["title"], first["kind"], first["folder"], first["action"]) == ("Bramble Goblin", "creature", "characters/enemies", "new")
    assert second["action"] == "add" and second["match"] == "characters/enemies/ember-golem.md" and second["title"] == "Ember Golem"
    assert seen["images_b64"], "Tess gets a contact sheet of the pictures"


def test_tess_sort_falls_back_to_names_when_tess_fails(tmp_path):
    ws = workspace(tmp_path)
    staged = drops.stage(ws, [("crate.png", png())])
    plan = drops.plan(ws, staged["id"])

    async def broken(**kwargs):
        raise RuntimeError("no chat model")

    result = asyncio.run(drops.tess_sort(ws, plan, broken))
    assert result["sorted_by"] == "names" and "no chat model" in result["note"]
    assert result["rows"] == plan["rows"]


def test_unknown_drop_ids_are_refused(tmp_path):
    ws = workspace(tmp_path)
    for bad in ("../../etc", "", "ABC"):
        try:
            drops.plan(ws, bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} was accepted")


def test_drop_routes_stage_plan_apply_and_undo(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from forge.server.app import app

    client = TestClient(app, base_url="http://127.0.0.1:8420")
    project = client.post("/api/projects", json={"name": "drops", "unique": True}).json()["project"]
    q = {"project": project}
    staged = client.post("/api/drops", params=q, files=[("files", ("a.png", png())), ("files", ("b.png", png()))],
                         data={"paths": ["pack/heroes/knight.png", "pack/heroes/slime.png"]}).json()
    assert staged["files"] == ["pack/heroes/knight.png", "pack/heroes/slime.png"]
    more = client.post("/api/drops", params={**q, "drop": staged["id"]}, files=[("files", ("door.wav", b"RIFF0000WAVE"))]).json()
    assert more["id"] == staged["id"] and len(more["files"]) == 3
    plan = client.get(f"/api/drops/{staged['id']}/plan", params=q).json()
    assert {r["title"] for r in plan["rows"]} == {"Knight", "Slime", "Door"}
    assert client.get(f"/api/drops/{staged['id']}/file", params={**q, "path": "pack/heroes/knight.png"}).status_code == 200
    assert client.get(f"/api/drops/{staged['id']}/file", params={**q, "path": "../drop.json"}).status_code == 404
    result = client.post(f"/api/drops/{staged['id']}/apply", params=q, json={"rows": plan["rows"]}).json()
    assert len(result["created"]) == 3
    board = client.get("/api/board", params=q).json()
    assert sum(len(g["assets"]) for g in board["groups"]) == 3
    client.post(f"/api/drops/{staged['id']}/undo", params=q)
    board = client.get("/api/board", params=q).json()
    assert sum(len(g["assets"]) for g in board["groups"]) == 0
    bad = client.post("/api/drops/url", params=q, json={"url": "file:///etc/passwd"})
    assert bad.status_code == 400


def test_a_picture_dropped_on_the_picked_image_replaces_it_and_undo_restores(tmp_path):
    ws = workspace(tmp_path)
    golem = "characters/enemies/ember-golem.md"
    first = drops.stage(ws, [("one.png", png())])
    drops.apply(ws, first["id"], drops.plan(ws, first["id"], golem)["rows"])
    old = read_asset(ws, golem)[1]["winner"]
    second = drops.stage(ws, [("two.png", png((0, 0, 255)))])
    rows = drops.plan(ws, second["id"], golem)["rows"]
    rows[0]["pick"] = True
    drops.apply(ws, second["id"], rows)
    assert read_asset(ws, golem)[1]["winner"].endswith("two.png")
    drops.undo(ws, second["id"])
    assert read_asset(ws, golem)[1]["winner"] == old
