"""Folder pages give each asset tile what the grid filters and sorts on: picked, rigged, changed."""

from pathlib import Path

from forge.overview import describe_folder


def _asset(ws: Path, name: str, winner: str = "") -> Path:
    page = ws / "props" / f"{name}.md"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(f"---\nkind: prop\nwinner: {winner}\n---\n# {name}\n", encoding="utf-8")
    return page


def test_tiles_carry_grid_flags(tmp_path: Path) -> None:
    ws = tmp_path / "art"
    _asset(ws, "lamp", winner="props/lamp/candidates/lamp-1.png")
    (ws / "props" / "lamp" / "candidates").mkdir(parents=True)
    (ws / "props" / "lamp" / "candidates" / "lamp-1.png").write_bytes(b"png")
    _asset(ws, "crate")
    rig = ws / "props" / "crate" / "rig"
    rig.mkdir(parents=True)
    (rig / "crate.glb").write_bytes(b"glTF")

    tiles = {f["name"]: f for f in describe_folder(ws, "props")["files"] if f["kind"] == "asset"}

    assert tiles["lamp.md"]["picked"] is True
    assert tiles["lamp.md"]["rigged"] is False
    assert tiles["crate.md"]["picked"] is False
    assert tiles["crate.md"]["rigged"] is True
    assert tiles["crate.md"]["model"].endswith("crate.glb")
    assert all(isinstance(t["changed"], int) and t["changed"] > 0 for t in tiles.values())
