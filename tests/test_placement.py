"""Placement data for the game's coding agent: size, scale, front, named points, clip loops, sounds, icons, requests."""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest
from PIL import Image

from forge import asset_index, asset_studio, model_info


def _glb(path: Path, gltf: dict) -> Path:
    """A GLB with only its JSON chunk: enough for everything Glob measures (bounds live in the accessors)."""
    body = json.dumps(gltf).encode()
    body += b" " * (-len(body) % 4)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(body)) + struct.pack("<I", len(body)) + b"JSON" + body)
    return path


def _box(lo: list[float], hi: list[float], **node: object) -> dict:
    return {
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, **node}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"count": 8, "type": "VEC3", "componentType": 5126, "min": lo, "max": hi}],
    }


def _rigged() -> dict:
    return {
        "scene": 0,
        "scenes": [{"nodes": [0, 1]}],
        "nodes": [
            {"mesh": 0, "skin": 0, "translation": [5, 5, 5]},  # a skinned mesh's own transform is ignored
            {"name": "mixamorig:Hips", "translation": [0, 1, 0], "children": [2, 3, 4]},
            {"name": "mixamorig:Head", "translation": [0, 0.6, 0]},
            {"name": "mixamorig:RightHand", "translation": [-0.7, 0.4, 0]},
            {"name": "LeftFoot", "translation": [0.1, -0.95, 0]},
        ],
        "skins": [{"joints": [1, 2, 3, 4]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"count": 8, "type": "VEC3", "componentType": 5126, "min": [-0.4, 0, -0.2], "max": [0.4, 1.8, 0.2]}],
    }


def _asset(ws: Path, rel: str, header: str) -> Path:
    path = ws / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{header}\n---\n# {path.stem}\n", encoding="utf-8")
    return path


def test_size_comes_from_bounds_moved_by_node_transforms(tmp_path: Path) -> None:
    glb = _glb(tmp_path / "m.glb", _box([-1, 0, -1], [1, 2, 1], scale=[0.5, 0.5, 0.5], translation=[0, 3, 0]))
    info = model_info.describe(glb)
    assert info["size"] == [1.0, 1.0, 1.0]
    assert info["min"][1] == 3.0 and info["max"][1] == 4.0
    assert info["auto_points"] == {"ground": [0.0, 3.0, 0.0], "top": [0.0, 4.0, 0.0]}


def test_rotation_turns_the_box(tmp_path: Path) -> None:
    half = 2 ** -0.5  # 90 degrees about Z: the 4 m long X side stands up
    info = model_info.describe(_glb(tmp_path / "m.glb", _box([-2, 0, 0], [2, 1, 1], rotation=[0, 0, half, half])))
    assert info["size"][1] == pytest.approx(4.0, abs=1e-3)


def test_rig_bones_become_named_points(tmp_path: Path) -> None:
    info = model_info.describe(_glb(tmp_path / "r.glb", _rigged()))
    assert info["size"] == [0.8, 1.8, 0.4]
    assert info["bone_points"]["head"] == [0.0, 1.6, 0.0]
    assert info["bone_points"]["hand_r"] == [-0.7, 1.4, 0.0]
    assert info["bone_points"]["foot_l"] == [0.1, 0.05, 0.0]
    assert info["bones"] == 4


def test_clip_length_and_loop_guess(tmp_path: Path) -> None:
    gltf = _box([0, 0, 0], [1, 1, 1])
    gltf["accessors"].append({"count": 2, "type": "SCALAR", "componentType": 5126, "min": [0], "max": [1.25]})
    gltf["animations"] = [{"name": "Walk", "samplers": [{"input": 1, "output": 0}], "channels": []}]
    assert model_info.describe(_glb(tmp_path / "a.glb", gltf))["clips"] == [{"name": "Walk", "seconds": 1.25}]
    assert model_info.guess_loop("walk_forward") is True
    assert model_info.guess_loop("Attack02") is False
    assert model_info.guess_loop("mixamo.com|Running") is True
    assert model_info.guess_loop("butterfly") is None
    assert model_info.guess_loop("pose") is None


def test_unreadable_files_are_none(tmp_path: Path) -> None:
    (tmp_path / "bad.glb").write_bytes(b"nope")
    assert model_info.describe(tmp_path / "bad.glb") is None
    assert model_info.describe(tmp_path / "missing.glb") is None


def test_viewer_values_are_checked(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    _asset(ws, "post.md", "kind: prop\nprompt: a post")
    out = asset_studio.update_asset(ws, "post.md", {"front": "x", "points": {"Light Hook": [0, 2.5, 0.1]}, "height_m": "2.8"})
    assert out["meta"]["front"] == "+X" and out["meta"]["points"] == {"light_hook": [0.0, 2.5, 0.1]} and out["meta"]["height_m"] == 2.8
    for bad in ({"front": "up"}, {"points": {"ground": [0, 0, 0]}}, {"points": {"a": [0, 0]}}, {"points": {"a": [0, float("nan"), 0]}}, {"height_m": "-1"}):
        with pytest.raises(ValueError):
            asset_studio.update_asset(ws, "post.md", bad)


def test_assets_md_gives_height_scale_front_and_points(tmp_path: Path) -> None:
    ws = tmp_path / "glob" / "workspace"
    _asset(ws, "props/post.md", "kind: prop\nprompt: a post\nheight_m: 2.8\nfront: -X\npoints_for: props/post/3d/post.glb\npoints:\n  light: [0.3, 1.9, 0]")
    _glb(ws / "props" / "post" / "3d" / "post.glb", _box([-0.1, 0, -0.1], [0.1, 2.0, 0.1]))
    _asset(ws, "props/crate.md", "kind: prop\nprompt: a crate")
    _glb(ws / "props" / "crate" / "3d" / "crate.glb", _box([-1, 0, -1], [1, 2, 1]))
    text = asset_index.render(ws, "Game")
    post = next(line for line in text.splitlines() if line.startswith("| post |") or line.startswith("| Post |"))
    assert "2.8 m tall (set in Tessera)" in post and "scale ×1.4" in post and "front -X (set in Tessera)" in post
    assert "ground (0, 0, 0)" in post and "top (0, 2, 0)" in post and "light (0.3, 1.9, 0)" in post
    crate = next(line for line in text.splitlines() if line.startswith("| Crate |"))
    assert "1 m tall (default for its kind, not checked)" in crate and "scale ×0.5" in crate and "front +Z (glTF default, not checked)" in crate
    assert "glob/REQUESTS.md" in text and "glob/ASSETS.json" in text


def test_size_line_gives_the_height_when_height_m_is_missing(tmp_path: Path) -> None:
    ws = tmp_path / "glob" / "workspace"
    _asset(ws, "post.md", "kind: prop\nprompt: a post\nsize: 0.4 x 2.4 x 0.6")
    _glb(ws / "post" / "3d" / "post.glb", _box([0, 0, 0], [1, 1.2, 1]))
    assert "2.4 m tall (from the page's size line, not checked) · scale ×2" in asset_index.render(ws)
    assert asset_index.size_height("2 × 1.5 × 1 m") == 1.5 and asset_index.size_height("big") is None


def test_points_on_an_older_model_are_flagged(tmp_path: Path) -> None:
    ws = tmp_path / "glob" / "workspace"
    _asset(ws, "post.md", "kind: prop\nprompt: a post\npoints_for: post/3d/old.glb\npoints:\n  light: [0, 1, 0]")
    _glb(ws / "post" / "3d" / "post.glb", _box([0, 0, 0], [1, 1, 1]))
    text = asset_index.render(ws)
    assert "light (" not in text and "placed on an older model" in text


def test_rig_and_clips_are_listed_with_points_and_loops(tmp_path: Path) -> None:
    ws = tmp_path / "glob" / "workspace"
    _asset(ws, "hero.md", "kind: character\nprompt: a hero\nanim_loops:\n  hero-wave: true")
    _glb(ws / "hero" / "3d" / "hero.glb", _box([-0.4, 0, -0.2], [0.4, 1.8, 0.2]))
    _glb(ws / "hero" / "rig" / "hero-rigged.glb", _rigged())
    _glb(ws / "hero" / "animations" / "hero-walk.glb", _box([0, 0, 0], [1, 1, 1]))
    _glb(ws / "hero" / "animations" / "hero-attack.glb", _box([0, 0, 0], [1, 1, 1]))
    _glb(ws / "hero" / "animations" / "hero-wave.glb", _box([0, 0, 0], [1, 1, 1]))
    _glb(ws / "hero" / "animations" / "hero-pose.glb", _box([0, 0, 0], [1, 1, 1]))
    text = asset_index.render(ws)
    assert "head (0, 1.6, 0)" in text and "hand_r (-0.7, 1.4, 0)" in text
    assert "hero-walk (loop)" in text and "hero-attack (once)" in text and "hero-wave (loop)" in text and "hero-pose (loop or once not set)" in text
    data = json.loads(asset_index.render_json(ws))
    hero = data["assets"][0]
    wave = next(c for c in hero["animations"] if c["name"] == "hero-wave")
    assert wave["loop"] is True and wave["loop_source"] == "set in Tessera"
    assert hero["rig"]["points"]["head"] == [0.0, 1.6, 0.0]
    assert hero["placement"]["scale"] == pytest.approx(1.7 / 1.8, abs=1e-3)


def test_sounds_say_ready_and_have_no_model_column(tmp_path: Path) -> None:
    ws = tmp_path / "glob" / "workspace"
    _asset(ws, "sfx/step.md", "kind: sfx\nprompt: a footstep\nwinner: sfx/step/audio/step-1.mp3")
    (ws / "sfx" / "step" / "audio").mkdir(parents=True)
    (ws / "sfx" / "step" / "audio" / "step-1.mp3").write_bytes(b"ID3")
    _asset(ws, "sfx/door.md", "kind: sfx\nprompt: a door")
    (ws / "sfx" / "door" / "audio").mkdir(parents=True)
    (ws / "sfx" / "door" / "audio" / "door-1.mp3").write_bytes(b"ID3")
    _asset(ws, "sfx/bell.md", "kind: sfx\nprompt: a bell")
    rows = {line.split("|")[1].strip(): line for line in asset_index.render(ws).splitlines() if line.startswith("| ") and "sfx" in line}
    assert "sound ready `glob/workspace/sfx/step/audio/step-1.mp3`" in rows["Step"]
    assert "1 take, none picked yet" in rows["Door"]
    assert rows["Step"].split("|")[4].strip() == "—"  # no 3D model is expected of a sound
    assert "not made yet" in rows["Bell"]
    assert json.loads(asset_index.render_json(ws))["assets"][-1]["sound_ready"] in (True, False)


def test_icon_is_cropped_square_and_transparent(tmp_path: Path) -> None:
    ws = tmp_path / "glob" / "workspace"
    (ws / "key" / "candidates").mkdir(parents=True)
    picture = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
    picture.paste((200, 160, 40, 255), (150, 100, 250, 140))  # a small key in a big empty picture
    picture.save(ws / "key" / "candidates" / "key-1.png")
    _asset(ws, "key.md", "kind: item\nprompt: a key\nwinner: key/candidates/key-1.png")
    text = asset_index.render(ws)
    icon = tmp_path / "glob" / "exports" / "icons" / "key.png"
    assert "icon (256px, transparent) `glob/exports/icons/key.png`" in text
    with Image.open(icon) as img:
        assert img.size == (256, 256) and img.mode == "RGBA"
        assert img.getpixel((0, 0))[3] == 0 and img.getpixel((128, 128))[3] == 255
        box = img.getchannel("A").getbbox()
        assert box[2] - box[0] > 200  # tightly cropped: the key fills the width


def test_requests_file_is_read_and_index_json_written(tmp_path: Path) -> None:
    ws = tmp_path / "glob" / "workspace"
    ws.mkdir(parents=True)
    assert asset_index.read_requests(ws)["exists"] is False
    (tmp_path / "glob" / "REQUESTS.md").write_text("# Wishes\n\n- [ ] Stone Altar, 2.5 m\n- [x] Gate\n* Crewmate taller\nnot a list line\n", encoding="utf-8")
    req = asset_index.read_requests(ws)
    assert req["open"] == ["Stone Altar, 2.5 m", "Crewmate taller"] and req["done"] == ["Gate"]
    asset_index.write(ws, "Game")
    assert json.loads((tmp_path / "glob" / "ASSETS.json").read_text(encoding="utf-8"))["requests_file"] == "glob/REQUESTS.md"


def test_selection_routes_list_a_folder_and_plan_exactly_the_selection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FORGE_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("FORGE_PROJECTS_DIR", str(tmp_path / "projects"))
    from fastapi.testclient import TestClient

    from forge.server.app import _ws_dir, app

    client = TestClient(app, base_url="http://127.0.0.1")
    project = client.post("/api/projects", json={"name": "select_game"}).json()["project"]
    ws = _ws_dir(project)
    _asset(ws, "props/rooms/crate.md", "kind: prop\nprompt: a crate")
    _asset(ws, "props/barrel.md", "kind: prop\nprompt: a barrel")
    _asset(ws, "items/key.md", "kind: item\nprompt: a key")
    listed = client.get("/api/studio/assets-under", params={"folder": "props", "project": project}).json()["assets"]
    assert sorted(a["path"] for a in listed) == ["props/barrel.md", "props/rooms/crate.md"]
    plan = client.get("/api/studio/batch", params={"assets": ["items/key.md"], "project": project}).json()["assets"]
    assert [p["asset"] for p in plan] == ["items/key.md"]
    info = client.get("/api/studio/model-info", params={"path": "props/barrel.md", "project": project})
    assert info.status_code == 404


def test_grid_images_come_as_small_cached_copies(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FORGE_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("FORGE_PROJECTS_DIR", str(tmp_path / "projects"))
    from fastapi.testclient import TestClient

    from forge.server.app import _ws_dir, app

    client = TestClient(app, base_url="http://127.0.0.1")
    project = client.post("/api/projects", json={"name": "thumb_game"}).json()["project"]
    ws = _ws_dir(project)
    Image.effect_noise((1600, 1200), 90).convert("RGB").save(ws / "big.png")
    full = client.get(f"/projects/{project}/workspace/big.png")
    small = client.get(f"/projects/{project}/workspace/big.png", params={"w": 300})
    assert small.headers["content-type"] == "image/webp" and len(small.content) < len(full.content) / 4
    import io

    with Image.open(io.BytesIO(small.content)) as img:
        assert img.width == 320  # snapped to the next cached width
    assert list((ws.parent / ".studio" / "thumbs").rglob("*.webp"))  # cached in the studio's folder, not in the art
