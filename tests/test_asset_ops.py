"""Moving, renaming and trashing assets keeps the page and its outputs together, and undo puts them back."""

from pathlib import Path

import pytest

from forge import asset_ops


def _make(ws: Path) -> None:
    (ws / "props" / "lamp" / "candidates").mkdir(parents=True)
    (ws / "props" / "lamp" / "candidates" / "lamp-1.png").write_bytes(b"png")
    (ws / "props" / "lamp.md").write_text("---\nkind: prop\nwinner: props/lamp/candidates/lamp-1.png\n---\n# Lamp\n", encoding="utf-8")
    (ws / "level").mkdir()


def test_move_rewrites_paths(tmp_path: Path) -> None:
    _make(tmp_path)
    new = asset_ops.move_asset(tmp_path, "props/lamp.md", "level")
    assert new == "level/lamp.md"
    assert (tmp_path / "level" / "lamp" / "candidates" / "lamp-1.png").is_file()
    assert "winner: level/lamp/candidates/lamp-1.png" in (tmp_path / new).read_text(encoding="utf-8")
    assert not (tmp_path / "props" / "lamp").exists()


def test_rename_and_back(tmp_path: Path) -> None:
    _make(tmp_path)
    new = asset_ops.move_asset(tmp_path, "props/lamp.md", name="Street Lamp")
    assert new == "props/street-lamp.md"
    assert "props/street-lamp/candidates/lamp-1.png" in (tmp_path / new).read_text(encoding="utf-8")
    back = asset_ops.move_asset(tmp_path, new, name="lamp")
    assert back == "props/lamp.md"
    assert "winner: props/lamp/candidates/lamp-1.png" in (tmp_path / back).read_text(encoding="utf-8")


def test_move_refuses_to_overwrite(tmp_path: Path) -> None:
    _make(tmp_path)
    (tmp_path / "level" / "lamp.md").write_text("x", encoding="utf-8")
    with pytest.raises(ValueError):
        asset_ops.move_asset(tmp_path, "props/lamp.md", "level")


def test_trash_and_restore(tmp_path: Path) -> None:
    _make(tmp_path)
    items = asset_ops.trash_assets(tmp_path, ["props/lamp.md"])
    assert len(items) == 2
    assert not (tmp_path / "props" / "lamp.md").exists()
    restored = asset_ops.restore(tmp_path, items)
    assert sorted(restored) == ["props/lamp", "props/lamp.md"]
    assert (tmp_path / "props" / "lamp" / "candidates" / "lamp-1.png").is_file()


def test_model_suffix_sniffs_bytes() -> None:
    from forge.game_tools import model_suffix

    assert model_suffix(b"glTF\x02\x00\x00\x00") == ".glb"
    assert model_suffix(b"Kaydara FBX Binary  \x00") == ".fbx"
    assert model_suffix(b'  {"asset":{}}') == ".gltf"
