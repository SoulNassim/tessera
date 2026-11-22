"""Tessera's pixel engine: grid snap, pixel prompts, guide sheets and prompt-first pixel assets."""

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

from forge import pixel, pixel_engine, sprites
from forge.blueprint_contract import split_frontmatter


def _fake_pixel_art(cell: int, offset: int, size: int = 1024) -> tuple[Image.Image, Image.Image]:
    """Pixel art drawn big on a grid that doesn't line up with the image, slightly blurred, like a model's output."""
    rnd = random.Random(cell)
    small = Image.new("RGB", (40, 40), "white")
    px = small.load()
    for y in range(6, 36):
        for x in range(8, 32):
            px[x, y] = rnd.choice([(200, 60, 80), (40, 40, 60), (250, 200, 120)])
    big = small.resize((40 * cell, 40 * cell), Image.Resampling.NEAREST)
    canvas = Image.new("RGB", (size, size), "white")
    canvas.paste(big, (offset - cell, offset - cell))
    return canvas.filter(ImageFilter.GaussianBlur(0.8)), small


def test_grid_snap_finds_the_real_pixel_size() -> None:
    for cell, offset in ((23, 7), (16, 0), (9, 4)):
        image, _ = _fake_pixel_art(cell, offset)
        assert pixel.detect_grid(image) == (cell, offset % cell, offset % cell)


def test_grid_snap_keeps_flat_colours() -> None:
    image, small = _fake_pixel_art(16, 0)
    snapped = pixel.snap_grid(image).convert("RGB")
    colours = set(pixel._pixels(snapped))
    assert colours <= {(200, 60, 80), (40, 40, 60), (250, 200, 120), (255, 255, 255)}
    assert snapped.getpixel((10, 10)) == small.getpixel((11, 11))  # the grid starts one cell in (offset 0 - cell)


def test_smooth_picture_has_no_grid() -> None:
    assert pixel.detect_grid(Image.new("RGB", (512, 512), (90, 120, 200))) is None


def test_prompt_states_the_pixel_rules() -> None:
    text = pixel_engine.create_prompt("a knight with a blue cape", {"canvas": 48, "palette": "pico-8", "view": "top-down", "kind": "character"})
    assert "48x48" in text and "#ff004d" in text and "top-down" in text.lower() and "No anti-aliasing" in text
    tile = pixel_engine.create_prompt("mossy stone", {"kind": "tile"})
    assert "seamless" in tile and "outline" not in tile.lower()


def test_recommended_model_ranks_gpt_image_first() -> None:
    models = [{"id": "gemini-nano-banana-2.1", "available": True}, {"id": "meshy:gpt-image-2", "available": True},
              {"id": "meshy:nano-banana-pro", "available": True}, {"id": "svc:x/gpt-image-2.5-sunburst", "available": False}]
    assert pixel_engine.recommended_model(models) == "meshy:gpt-image-2"


def test_guide_sheet_round_trips_through_split() -> None:
    sprite = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    ImageDraw.Draw(sprite).rectangle((10, 4, 21, 31), fill=(200, 40, 40, 255))
    cols, rows, aspect, cells = pixel_engine.turnaround_layout(["nw", "n", "ne", "w", "e", "sw", "s", "se"])
    assert (cols, rows, aspect) == (3, 3, "1:1") and 4 not in cells.values()
    sheet = pixel_engine.guide_sheet(sprite, cols, rows, set(cells.values()))
    assert sheet.size == (3 * pixel_engine.GUIDE_CELL, 3 * pixel_engine.GUIDE_CELL)
    parts = pixel_engine.split_sheet(sheet.resize((1024, 1024), Image.Resampling.NEAREST), cols, rows)
    assert len(parts) == 9
    centre = parts[4].convert("RGB")
    assert all(c == (236, 236, 240) for c in pixel._pixels(centre))  # the empty middle stays empty
    assert pixel_engine.grid_for(8)[:2] == (3, 3) and pixel_engine.grid_for(6)[2] == "3:2" and pixel_engine.grid_for(12)[2] == "4:3"


def test_pixel_asset_from_prompt_to_sprite(tmp_path: Path) -> None:
    ws = tmp_path
    rel = pixel_engine.create_asset(ws, "A tiny slime with a crown", {"kind": "creature", "canvas": 32, "palette": "sweetie-16"})
    meta, _, _ = split_frontmatter((ws / rel).read_text(encoding="utf-8"))
    assert rel.startswith("pixel-art/") and meta["kind"] == "creature" and meta["pixel"]["canvas"] == 32
    # A generated candidate (as the job saves it) gets its crisp sprite.
    raw = (ws / rel).with_suffix("") / "candidates" / "slime-1.png"
    raw.parent.mkdir(parents=True)
    _fake_pixel_art(20, 5)[0].save(raw)
    image_rel = raw.relative_to(ws).as_posix()
    sprite_rel = pixel_engine.snap_candidate(ws, rel, image_rel, meta["pixel"])
    with Image.open(ws / sprite_rel) as im:
        assert im.size == (32, 32)
        assert pixel.off_palette(im, pixel.PALETTES["sweetie-16"]) == 0
    listed = pixel_engine.list_assets(ws)
    assert listed[0]["path"] == rel and listed[0]["candidates"][0]["sprite"] == sprite_rel and not listed[0]["has_sprite"]
    # Picking it locks the set; a turnaround sheet then lands as facings, an animation sheet as frames.
    made = sprites.create_set(ws, rel, image_rel, canvas=32, palette="sweetie-16")
    assert (ws / made["folder"] / "ref.png").is_file()
    base = sprites.base_sprite(ws, rel, "main")
    cols, rows, _, cells = pixel_engine.turnaround_layout(["s", "e", "n", "w"])
    sheet = pixel_engine.guide_sheet(base, cols, rows, set(cells.values()))
    parts = pixel_engine.split_sheet(sheet, cols, rows)
    out = sprites.add_directions(ws, rel, "main", {d: parts[i] for d, i in cells.items()})
    assert set(out["directions"]) == {"s", "e", "n", "w"}
    cols, rows, _ = pixel_engine.grid_for(6)
    strip = pixel_engine.guide_sheet(base, cols, rows, set(range(6)))
    out = sprites.add_cells(ws, rel, "main", "walk", "e", pixel_engine.split_sheet(strip, cols, rows)[:6])
    assert len(out["animations"]["walk"]["frames"]["e"]) == 6
    for f in out["animations"]["walk"]["frames"]["e"]:
        with Image.open(ws / made["folder"] / f) as im:
            assert pixel.off_palette(im, out["palette"]) == 0
