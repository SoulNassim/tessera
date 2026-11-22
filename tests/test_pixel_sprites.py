"""Pixel Studio: pixelize is deterministic and palette-exact; sprite sets round-trip and export for engines."""

import json
from pathlib import Path

from PIL import Image, ImageDraw

from forge import pixel, sprites


def _figure(w: int = 200, h: int = 300, shift: int = 0) -> Image.Image:
    im = Image.new("RGB", (w, h), (240, 240, 240))
    d = ImageDraw.Draw(im)
    d.ellipse((70 + shift, 20, 130 + shift, 80), fill=(220, 60, 60))
    d.rectangle((60 + shift, 80, 140 + shift, 220), fill=(40, 90, 200))
    d.rectangle((60 + shift, 220, 90 + shift, 290), fill=(30, 30, 30))
    d.rectangle((110 + shift, 220, 140 + shift, 290), fill=(30, 30, 30))
    return im


def test_pixelize_is_deterministic_and_palette_exact() -> None:
    a, sa = pixel.pixelize(_figure(), 32, "pico-8")
    b, _ = pixel.pixelize(_figure(), 32, "pico-8")
    assert a.size == (32, 32)
    assert a.tobytes() == b.tobytes()
    assert pixel.off_palette(a, sa["palette"]) == 0
    assert {px[3] for px in pixel._pixels(a)} <= {0, 255}


def test_feet_sit_on_the_bottom_anchor() -> None:
    sprite, _ = pixel.pixelize(_figure(), 32, "pico-8", outline=False)
    box = sprite.getchannel("A").getbbox()
    assert box[3] == 31  # one pixel margin at the bottom
    assert abs((box[0] + box[2]) / 2 - 16) <= 1.5


def test_outline_uses_darkest_colour() -> None:
    sprite, s = pixel.pixelize(_figure(), 32, "sweetie-16", outline=True)
    dark = pixel.hex_to_rgb(pixel.darkest(s["palette"]))
    assert any(px[:3] == dark for px in pixel._pixels(sprite) if px[3])


def test_strip_frames_share_scale_and_anchor() -> None:
    strip = Image.new("RGB", (800, 300), (240, 240, 240))
    for i in range(4):
        strip.paste(_figure(shift=(i % 2) * 10), (i * 200, 0))
    settings = {"canvas": 32, "palette": pixel.PALETTES["pico-8"], "outline": False}
    frames = pixel.frames_from_strip(strip, 4, settings)
    assert len(frames) == 4
    bottoms = {f.getchannel("A").getbbox()[3] for f in frames}
    heights = {f.getchannel("A").getbbox()[3] - f.getchannel("A").getbbox()[1] for f in frames}
    assert bottoms == {31}
    assert len(heights) == 1


def test_sprite_set_round_trip_and_export(tmp_path: Path) -> None:
    ws = tmp_path
    (ws / "chars").mkdir()
    (ws / "chars" / "hero.md").write_text("---\nkind: character\n---\n# Hero\n", encoding="utf-8")
    _figure().save(ws / "chars" / "hero.png")
    strip = Image.new("RGB", (800, 300), (240, 240, 240))
    for i in range(4):
        strip.paste(_figure(shift=i * 4), (i * 200, 0))
    strip.save(ws / "chars" / "walk.png")

    made = sprites.create_set(ws, "chars/hero.md", "chars/hero.png", canvas=32, palette="pico-8")
    assert made["directions"] == ["s"] and made["animations"]["base"]["frames"]["s"] == ["base-s-0.png"]
    sprites.add_direction(ws, "chars/hero.md", "main", "e", "chars/hero.png")
    data = sprites.add_animation(ws, "chars/hero.md", "main", "walk", "s", "chars/walk.png", 4)
    assert data["directions"] == ["s", "e"]
    assert len(data["animations"]["walk"]["frames"]["s"]) == 4
    assert data["animations"]["walk"]["loop"] is True

    out = sprites.export_set(ws, "chars/hero.md", "main")
    folder = ws / "chars" / "hero" / "sprites" / "main"
    sheet = json.loads((folder / "sheet.json").read_text(encoding="utf-8"))
    assert sheet["meta"]["image"] == "sheet.png"
    assert {t["name"] for t in sheet["meta"]["frameTags"]} == {"base_s", "base_e", "walk_s"}
    assert len(sheet["frames"]) == 6
    tres = (folder / "main.tres").read_text(encoding="utf-8")
    assert tres.startswith('[gd_resource type="SpriteFrames"') and '&"walk_s"' in tres
    assert (folder / "preview.gif").is_file()
    assert set(out["exports"]) == {"sheet.png", "sheet.json", "main.tres", "preview.gif"}
    assert [s["name"] for s in sprites.list_sets(ws, "chars/hero.md")] == ["main"]


def test_list_all_and_preview(tmp_path: Path) -> None:
    (tmp_path / "chars").mkdir()
    (tmp_path / "chars" / "hero.md").write_text("---\nkind: character\n---\n# Hero\n", encoding="utf-8")
    _figure().save(tmp_path / "chars" / "hero.png")
    assert sprites.preview_png(tmp_path, "chars/hero.png", 32, "pico-8", True).startswith("data:image/png;base64,")
    assert sprites.list_all(tmp_path) == []
    sprites.create_set(tmp_path, "chars/hero.md", "chars/hero.png", canvas=32, palette="pico-8")
    found = sprites.list_all(tmp_path)
    assert [(s["asset"], s["name"]) for s in found] == [("chars/hero.md", "main")]
