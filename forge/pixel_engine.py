"""Tessera's pixel-art engine: prompt → consistent pixel sprites, turnarounds and animation sheets.

The image model draws; Tessera makes it pixel art and keeps it consistent:

1. **Prompt recipe.** Each request is written for pixel art: kind, camera view, canvas, palette size, outline,
   shading and detail become explicit drawing rules, and anything that breaks pixel art (gradients, blur,
   anti-aliasing, scenery) is ruled out.
2. **Grid snap.** Generated "pixel art" is drawn big on a grid that never lines up exactly. `pixel.snap_grid`
   measures the real cell size and phase and rebuilds the picture one sample per cell, so no colours get mixed.
3. **Locked set.** The first sprite fixes the canvas, palette, scale and foot anchor. Every facing and frame goes
   through the same lock, so nothing drifts in colour or size.
4. **Guide sheets.** Facings and animations are drawn in one call on a guide: the approved sprite repeated in
   every cell of a sheet, upscaled with hard pixels. The model edits cells it can see side by side, which keeps
   the character, scale and ground line the same in every cell, and the cells split exactly where they were drawn.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

KINDS = {
    "character": "a single game character, full body, standing",
    "creature": "a single creature or monster, full body",
    "item": "a single item or pickup, shown whole",
    "weapon": "a single weapon, shown whole",
    "prop": "a single prop or object, shown whole",
    "icon": "a single UI icon, bold and readable at small size",
    "effect": "a single visual effect (spell, explosion, sparkle), on its own",
    "tile": "a seamless square terrain tile that fills the whole frame edge to edge",
    "portrait": "a character portrait, head and shoulders",
}
VIEWS = {
    "side": "pure side view, like a platformer",
    "top-down": "top-down view from high above, like a classic RPG overworld",
    "three-quarter": "three-quarter top-down view, like a modern action RPG",
    "isometric": "isometric view, 2:1 pixel lines",
    "front": "straight-on front view",
}
OUTLINES = {"black": "a clean 1-pixel dark outline around the whole shape",
            "selective": "a selective outline: dark on the shadow side, coloured on the lit side",
            "none": "no outline, shapes defined by colour only"}
SHADING = {"flat": "flat colours with at most one shadow tone",
           "soft": "simple cel shading: one shadow and one highlight tone per colour",
           "detailed": "detailed hand-placed shading with 3-4 tones per colour ramp, still with hard edges"}
DETAIL = {"low": "very simple, iconic shapes", "medium": "clear readable details", "high": "rich detail for its size"}
DIRECTION_WORDS = {
    "s": "facing the viewer (front)", "n": "facing away (back)", "e": "facing right (side)", "w": "facing left (side)",
    "se": "three-quarter front, facing right", "sw": "three-quarter front, facing left",
    "ne": "three-quarter back, facing right", "nw": "three-quarter back, facing left",
}
# Best first: the image models that draw the cleanest grid-locked pixel art and keep cells consistent in a sheet.
RECOMMENDED = ("gpt-image-2-5", "gpt-image-2.5", "gpt_image_2_5", "gpt-image-2", "gpt_image_2", "nano-banana-pro",
               "3-pro-image", "nano-banana-2-1", "nano-banana-2.1", "nano-banana-2")
GUIDE_CELL = 256


def defaults(opts: dict) -> dict:
    """The pixel settings of an asset, with every field present."""
    o = dict(opts or {})
    return {
        "kind": o.get("kind") if o.get("kind") in KINDS else "character",
        "view": o.get("view") if o.get("view") in VIEWS else "side",
        "canvas": int(o.get("canvas") or 32),
        "palette": o.get("palette") or "auto-16",
        "outline": o.get("outline") if o.get("outline") in OUTLINES else "black",
        "shading": o.get("shading") if o.get("shading") in SHADING else "soft",
        "detail": o.get("detail") if o.get("detail") in DETAIL else "medium",
    }


def palette_words(palette: str | list[str]) -> str:
    from forge import pixel

    if isinstance(palette, list):
        return f"a strict palette of these {len(palette)} colours only: " + ", ".join(f"#{c}" for c in palette)
    if palette in pixel.PALETTES:
        cols = pixel.PALETTES[palette]
        return f"the {palette.upper()} palette only ({len(cols)} colours: " + ", ".join(f"#{c}" for c in cols) + ")"
    n = palette.split("-")[-1] if palette.startswith("auto-") else "16"
    return f"a limited palette of at most {n} colours"


def style_rules(o: dict) -> str:
    """The drawing rules shared by every request of a pixel asset, so they all look like one artist made them."""
    o = defaults(o)
    canvas = o["canvas"]
    tile = o["kind"] == "tile"
    return " ".join([
        f"Authentic {canvas}x{canvas} pixel art, as if hand-placed in Aseprite on a {canvas}x{canvas} grid and scaled up "
        "with nearest-neighbour: big, perfectly square, equal-sized pixels on one strict grid.",
        f"{VIEWS[o['view']].capitalize()}.",
        f"Use {palette_words(o['palette'])}.",
        f"{SHADING[o['shading']].capitalize()}; {DETAIL[o['detail']]}.",
        "" if tile else f"{OUTLINES[o['outline']].capitalize()}.",
        "No anti-aliasing, no gradients, no blur, no glow, no soft brushes, no noise, no dithering unless it is a deliberate"
        " pixel pattern, no sub-pixel detail, no text, no watermark, no border.",
        "" if tile else "Centred, the whole subject inside the frame with a little space around it, readable silhouette,"
        " on one plain flat solid background colour that is not used in the subject, no ground shadow, no scenery.",
    ]).replace("  ", " ").strip()


def create_prompt(description: str, opts: dict) -> str:
    o = defaults(opts)
    subject = description.strip().rstrip(".")
    return f"Pixel art: {KINDS[o['kind']]}: {subject}.\n\n{style_rules(o)}"


def recommended_model(models: list[dict]) -> str:
    """The best available model for pixel art from a list of {id, available}."""
    ready = [m for m in models if m.get("available", True)]
    for key in RECOMMENDED:
        hit = next((m["id"] for m in ready if key in str(m["id"]).lower()), "")
        if hit:
            return hit
    return ready[0]["id"] if ready else ""


# ---------- guide sheets ----------

def _cell_image(sprite: Image.Image, cell: int = GUIDE_CELL) -> Image.Image:
    """The sprite blown up with hard pixels, on a flat light background, feet on the cell's ground line."""
    scale = max(1, (cell - cell // 8) // max(sprite.size))
    big = sprite.resize((sprite.width * scale, sprite.height * scale), Image.Resampling.NEAREST)
    out = Image.new("RGBA", (cell, cell), (236, 236, 240, 255))
    out.alpha_composite(big, ((cell - big.width) // 2, cell - big.height - cell // 16))
    return out


def grid_for(cells: int) -> tuple[int, int, str]:
    """A sheet layout whose shape is an aspect ratio image models accept, so cells come back unstretched."""
    if cells <= 4:
        return 2, 2, "1:1"
    if cells <= 6:
        return 3, 2, "3:2"
    if cells <= 9:
        return 3, 3, "1:1"
    return 4, 3, "4:3"


# Eight facings as a compass on a 3x3 sheet (the middle stays empty); four facings on 2x2.
COMPASS = {"nw": 0, "n": 1, "ne": 2, "w": 3, "e": 5, "sw": 6, "s": 7, "se": 8}
FOUR = {"s": 0, "e": 1, "n": 2, "w": 3}


def turnaround_layout(directions: list[str]) -> tuple[int, int, str, dict[str, int]]:
    if len(directions) <= 4 and set(directions) <= set(FOUR):
        return 2, 2, "1:1", {d: FOUR[d] for d in directions}
    return 3, 3, "1:1", {d: COMPASS[d] for d in directions}


def guide_sheet(sprite: Image.Image, cols: int, rows: int, filled: set[int]) -> Image.Image:
    """The approved sprite in the filled cells of a sheet (others left plain), with thin borders the model keeps."""
    sheet = Image.new("RGBA", (cols * GUIDE_CELL, rows * GUIDE_CELL), (236, 236, 240, 255))
    cell = _cell_image(sprite)
    draw = ImageDraw.Draw(sheet)
    for i in range(cols * rows):
        x, y = (i % cols) * GUIDE_CELL, (i // cols) * GUIDE_CELL
        if i in filled:
            sheet.alpha_composite(cell, (x, y))
        draw.rectangle((x, y, x + GUIDE_CELL - 1, y + GUIDE_CELL - 1), outline=(200, 200, 208, 255))
    return sheet.convert("RGB")


def split_sheet(image: Image.Image, cols: int, rows: int) -> list[Image.Image]:
    """Cut a returned sheet back into the cells of its guide, reading order (the model keeps the guide's layout)."""
    w, h = image.size
    cw, ch = w / cols, h / rows
    inset = 0.03  # skip the cell borders
    return [image.crop((round(x * cw + cw * inset), round(y * ch + ch * inset), round((x + 1) * cw - cw * inset), round((y + 1) * ch - ch * inset)))
            for y in range(rows) for x in range(cols)]


def _cell_name(i: int, cols: int) -> str:
    return f"row {i // cols + 1}, column {i % cols + 1}"


def turnaround_instruction(cells: dict[str, int], cols: int, rows: int, opts: dict) -> str:
    order = "; ".join(f"{_cell_name(i, cols)}: {DIRECTION_WORDS[d]}" for d, i in sorted(cells.items(), key=lambda kv: kv[1]))
    empty = [i for i in range(cols * rows) if i not in cells.values()]
    return (f"This is a {cols}x{rows} sheet of the same pixel-art character. Redraw the character in each cell turned to a"
            f" new facing: {order}." + (f" Leave {', '.join(_cell_name(i, cols) for i in empty)} empty." if empty else "")
            + " Keep the exact same design, colours, proportions, size and pixel grid in every cell, feet on the same ground"
            f" line, one character per cell, keep the cell layout and the plain background. {style_rules(opts)}")


def animation_instruction(anim: str, frames: int, direction: str, cols: int, rows: int, opts: dict, notes: str = "") -> str:
    empty = cols * rows - frames
    return (f"This is a {cols}x{rows} sheet of the same pixel-art character {DIRECTION_WORDS.get(direction, '')}. Turn the first"
            f" {frames} cells, in reading order (left to right, then the next row), into the {frames} frames of a smooth"
            f" '{anim}' animation of that exact character: clear key poses, each frame a small step from the last, the same"
            " facing in every frame." + (f" Leave the last {empty} cell{'s' if empty > 1 else ''} empty." if empty else "")
            + " Keep the exact same design, colours, proportions, size and pixel grid, feet on the same ground line, one"
            f" character per cell, the cell layout and the plain background.{(' ' + notes.strip()) if notes.strip() else ''}"
            f" {style_rules(opts)}")


def save_guide(path: Path, sheet: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


# ---------- pixel assets in the workspace ----------

ASSET_KIND = {"character": "character", "creature": "creature", "item": "item", "weapon": "weapon", "prop": "prop",
              "icon": "ui", "effect": "vfx", "tile": "environment", "portrait": "character"}
PIXEL_FOLDER = "pixel-art"


STOP_WORDS = {"a", "an", "the", "with", "and", "of", "in", "on", "for", "to", "that", "who", "holding", "wearing"}


def short_title(description: str) -> str:
    """'a grumpy slime king with a tiny crown' → 'Grumpy slime king'."""
    words = [w.strip(".,;:!?") for w in description.split()]
    while words and words[0].lower() in STOP_WORDS:
        words.pop(0)
    cut = next((i for i, w in enumerate(words) if i and w.lower() in STOP_WORDS), len(words))
    words = words[: min(cut, 4)] or ["Sprite"]
    return " ".join(words).capitalize()


def create_asset(ws_dir: Path, description: str, opts: dict, *, name: str = "", folder: str = "") -> str:
    """A new pixel-art asset page: its prompt plus the pixel settings every later generation reuses."""
    from forge.blueprint_contract import serialize_frontmatter
    from forge.overview import resolve_rel, slugify

    description = description.strip()
    if not description:
        raise ValueError("Describe what to draw first.")
    o = defaults(opts)
    title = name.strip() or short_title(description)
    base = resolve_rel(ws_dir, folder or PIXEL_FOLDER) if (folder or PIXEL_FOLDER) else ws_dir
    base.mkdir(parents=True, exist_ok=True)
    slug = slugify(title) or "sprite"
    path, n = base / f"{slug}.md", 2
    while path.exists():
        path, n = base / f"{slug}-{n}.md", n + 1
    meta = {"kind": ASSET_KIND[o["kind"]], "title": title, "prompt": description, "aspect": "1:1", "pixel": o}
    body = f"# {title}\n\nPixel art made in Pixel Studio ({o['canvas']}px, {o['view']} view).\n"
    path.write_text(serialize_frontmatter(meta, body), encoding="utf-8")
    return path.relative_to(ws_dir.resolve()).as_posix()


def pixel_dir(ws_dir: Path, asset_rel: str) -> Path:
    from forge.overview import resolve_rel

    return resolve_rel(ws_dir, asset_rel).with_suffix("") / "pixel"


def snap_candidate(ws_dir: Path, asset_rel: str, image_rel: str, opts: dict) -> str:
    """The pixel sprite of one generated candidate, saved next to it so the studio shows crisp pixels."""
    from forge import pixel
    from forge.overview import resolve_rel

    o = defaults(opts)
    with Image.open(resolve_rel(ws_dir, image_rel)) as im:
        sprite, _ = pixel.pixelize(im.convert("RGBA"), o["canvas"], o["palette"], o["outline"] != "none", fill=o["kind"] == "tile")
    out = pixel_dir(ws_dir, asset_rel) / f"{Path(image_rel).stem}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    sprite.save(out)
    return out.relative_to(ws_dir.resolve()).as_posix()


def candidates(ws_dir: Path, asset_rel: str) -> list[dict]:
    """Generated pictures of a pixel asset with their pixel sprites, newest first."""
    from forge.overview import resolve_rel

    page = resolve_rel(ws_dir, asset_rel)
    raw = page.with_suffix("") / "candidates"
    snapped = pixel_dir(ws_dir, asset_rel)
    root = ws_dir.resolve()
    out = []
    if raw.is_dir():
        for f in sorted(raw.iterdir(), key=lambda p: -p.stat().st_mtime):
            if f.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp") or f.stem.endswith("_thumb"):
                continue
            sprite = snapped / f"{f.stem}.png"
            out.append({"image": f.relative_to(root).as_posix(), "sprite": sprite.relative_to(root).as_posix() if sprite.is_file() else ""})
    return out


def list_assets(ws_dir: Path) -> list[dict]:
    """Every pixel asset (a page with pixel settings), newest first, with its candidates and whether it has a sprite."""
    from forge.blueprint_contract import split_frontmatter

    root = ws_dir.resolve()
    found = []
    for page in root.rglob("*.md"):
        rel = page.relative_to(root)
        if any(part.startswith(".") or part.startswith("_") for part in rel.parts):
            continue
        try:
            meta, _, _ = split_frontmatter(page.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(meta.get("pixel"), dict):
            continue
        rel_s = rel.as_posix()
        found.append({"path": rel_s, "title": meta.get("title") or page.stem, "prompt": meta.get("prompt") or "", "pixel": defaults(meta["pixel"]),
                      "candidates": candidates(ws_dir, rel_s), "has_sprite": (page.with_suffix("") / "sprites").is_dir(),
                      "changed": page.stat().st_mtime})
    return sorted(found, key=lambda a: -a["changed"])
