"""Pixel art from any image, the same way every time.

`pixelize` is deterministic: the same picture, canvas and palette always give the same sprite. Consistency across
directions and frames comes from here, not from the image model: every frame goes through the same palette lock,
the same canvas and the same foot anchor.

Steps: knock out the background → crop to the subject → fit the canvas (feet on the bottom centre) → hard alpha →
lock to the palette with no dither → drop orphan pixels → optional 1 px outline.
"""

from __future__ import annotations

from typing import Iterable

from PIL import Image

CANVAS_SIZES = (16, 24, 32, 48, 64, 96, 128)

PALETTES: dict[str, list[str]] = {
    "pico-8": ["000000", "1d2b53", "7e2553", "008751", "ab5236", "5f574f", "c2c3c7", "fff1e8",
               "ff004d", "ffa300", "ffec27", "00e436", "29adff", "83769c", "ff77a8", "ffccaa"],
    "sweetie-16": ["1a1c2c", "5d275d", "b13e53", "ef7d57", "ffcd75", "a7f070", "38b764", "257179",
                   "29366f", "3b5dc9", "41a6f6", "73eff7", "f4f4f4", "94b0c2", "566c86", "333c57"],
    "gameboy": ["0f380f", "306230", "8bac0f", "9bbc0f"],
}

Rgb = tuple[int, int, int]


def _pixels(image: Image.Image) -> list:
    """Pixel tuples, on Pillow versions before and after getdata's removal."""
    flat = getattr(image, "get_flattened_data", None)
    return list(flat() if flat else image.getdata())


def hex_to_rgb(value: str) -> Rgb:
    v = value.strip().lstrip("#")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def rgb_to_hex(rgb: Iterable[int]) -> str:
    r, g, b = list(rgb)[:3]
    return f"{r:02x}{g:02x}{b:02x}"


def palette_from_image(image: Image.Image, colors: int = 16) -> list[str]:
    """The `colors` colours that best describe the opaque part of an image (median cut)."""
    rgba = image.convert("RGBA")
    solid = Image.new("RGB", rgba.size, (0, 0, 0))
    solid.paste(rgba, mask=rgba.getchannel("A").point(lambda a: 255 if a >= 128 else 0))
    pixels = [p for p, a in zip(_pixels(solid), _pixels(rgba.getchannel("A"))) if a >= 128]
    if not pixels:
        return PALETTES["pico-8"]
    sample = Image.new("RGB", (len(pixels), 1))
    sample.putdata(pixels)
    quant = sample.quantize(colors=max(2, min(64, colors)), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    flat = quant.getpalette()[: 3 * max(2, min(64, colors))]
    seen: list[str] = []
    for i in range(0, len(flat), 3):
        h = rgb_to_hex(flat[i:i + 3])
        if h not in seen:
            seen.append(h)
    return seen


def resolve_palette(name: str | list[str], image: Image.Image | None = None) -> list[str]:
    if isinstance(name, list):
        return [c.lstrip("#").lower() for c in name if c]
    key = str(name or "auto").lower()
    if key in PALETTES:
        return PALETTES[key]
    if key.startswith("auto") and image is not None:
        count = int(key.split("-")[1]) if "-" in key and key.split("-")[1].isdigit() else 16
        return palette_from_image(image, count)
    return PALETTES["pico-8"]


def _profile(gray: Image.Image, axis: int) -> list[float]:
    """Mean edge strength per column (axis 0) or per row (axis 1)."""
    from PIL import ImageChops

    w, h = gray.size
    if axis == 0:
        shifted = gray.crop((1, 0, w, h))
        diff = ImageChops.difference(gray.crop((0, 0, w - 1, h)), shifted)
        return _pixels(diff.resize((w - 1, 1), Image.Resampling.BOX))
    shifted = gray.crop((0, 1, w, h))
    diff = ImageChops.difference(gray.crop((0, 0, w, h - 1)), shifted)
    return _pixels(diff.resize((1, h - 1), Image.Resampling.BOX))


def _period(profile: list[float], low: int = 3, high: int = 48) -> tuple[int, int, float]:
    """The repeat of the edges in a profile: (period, phase, how clearly it stands out)."""
    mean = sum(profile) / max(1, len(profile))
    if mean < 0.4:  # a smooth picture: no edges to measure
        return 0, 0, 0.0
    scores = []
    for k in range(low, min(high, len(profile) // 4) + 1):
        best = max(((sum(profile[ph::k]) / max(1, len(profile[ph::k]))) / mean, ph) for ph in range(k))
        scores.append((best[0], k, best[1]))
    if not scores:
        return 0, 0, 0.0
    top = max(s[0] for s in scores)
    # Multiples of the real cell size score about as well: take the smallest that is nearly as clear.
    ratio, k, phase = next(s for s in scores if s[0] >= top * 0.72)
    return k, (phase + 1) % k, ratio  # profile[i] is the edge between pixel i and i + 1


def detect_grid(image: Image.Image) -> tuple[int, int, int] | None:
    """The pixel size of AI 'pixel art' (it is drawn big, on a grid that is never exactly aligned).

    Returns (cell, phase_x, phase_y) or None when the picture has no clear pixel grid."""
    gray = image.convert("RGBA")
    flat = Image.new("RGBA", gray.size, (255, 255, 255, 255))
    flat.alpha_composite(gray)
    gray = flat.convert("L")
    if min(gray.size) < 96:
        return None
    kx, px, rx = _period(_profile(gray, 0))
    ky, py, ry = _period(_profile(gray, 1))
    if not kx or not ky or min(rx, ry) < 2.0:
        return None
    if abs(kx - ky) > max(1, min(kx, ky) // 6):
        k = kx if rx >= ry else ky
    else:
        k = round((kx + ky) / 2)
    return k, px % k, py % k


def snap_grid(image: Image.Image) -> Image.Image:
    """Rebuild the picture at its real pixel resolution: one sample from the middle of each grid cell.

    Sampling the centre (not averaging) keeps the artist's flat colours instead of blurring cell borders."""
    grid = detect_grid(image)
    if not grid:
        return image.convert("RGBA")
    k, px, py = grid
    src = image.convert("RGBA")
    w, h = src.size
    cols, rows = (w - px) // k, (h - py) // k
    if cols < 8 or rows < 8:
        return src
    out = Image.new("RGBA", (cols, rows))
    sp, op = src.load(), out.load()
    half = k // 2
    for y in range(rows):
        for x in range(cols):
            op[x, y] = sp[min(w - 1, px + x * k + half), min(h - 1, py + y * k + half)]
    return out


def knock_out(image: Image.Image) -> Image.Image:
    """Transparent background: kept as is when the image already has transparency, else the corner colour is removed."""
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    if alpha.getextrema()[0] < 250:
        return rgba
    from forge.game_tools import _knock_out_background

    return _knock_out_background(rgba).convert("RGBA")


def _nearest(rgb: Rgb, palette: list[Rgb], cache: dict[Rgb, Rgb]) -> Rgb:
    hit = cache.get(rgb)
    if hit is None:
        hit = min(palette, key=lambda p: (p[0] - rgb[0]) ** 2 * 3 + (p[1] - rgb[1]) ** 2 * 4 + (p[2] - rgb[2]) ** 2 * 2)
        cache[rgb] = hit
    return hit


def lock_palette(image: Image.Image, palette: list[str]) -> Image.Image:
    """Every opaque pixel becomes its nearest palette colour (no dither); alpha becomes 0 or 255."""
    rgba = image.convert("RGBA")
    pal = [hex_to_rgb(c) for c in palette]
    cache: dict[Rgb, Rgb] = {}
    out = [(*_nearest((r, g, b), pal, cache), 255) if a >= 128 else (0, 0, 0, 0) for r, g, b, a in _pixels(rgba)]
    result = Image.new("RGBA", rgba.size)
    result.putdata(out)
    return result


def remove_orphans(image: Image.Image) -> Image.Image:
    """Drop single opaque pixels with no opaque neighbour (noise the downscale leaves behind)."""
    img = image.copy()
    w, h = img.size
    px = img.load()
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                continue
            if not any(0 <= x + dx < w and 0 <= y + dy < h and px[x + dx, y + dy][3] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                px[x, y] = (0, 0, 0, 0)
    return img


def add_outline(image: Image.Image, color: str) -> Image.Image:
    """A 1 px outline (4-neighbour) around the opaque shape, inside the canvas."""
    img = image.copy()
    w, h = img.size
    src = image.load()
    px = img.load()
    rgb = (*hex_to_rgb(color), 255)
    for y in range(h):
        for x in range(w):
            if src[x, y][3]:
                continue
            if any(0 <= x + dx < w and 0 <= y + dy < h and src[x + dx, y + dy][3] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                px[x, y] = rgb
    return img


def darkest(palette: list[str]) -> str:
    return min(palette, key=lambda c: sum(hex_to_rgb(c)))


def fit_canvas(subject: Image.Image, canvas: int, scale: float | None = None, margin: int = 1) -> tuple[Image.Image, float]:
    """Scale the subject into a square canvas, feet on the bottom centre. Returns the image and the scale used,
    so later frames can reuse it (same scale = the character doesn't grow or shrink between frames)."""
    box = subject.getchannel("A").getbbox()
    crop = subject.crop(box) if box else subject
    room = canvas - 2 * margin - 1  # one pixel spare for the outline
    if scale is None:
        scale = min(room / max(1, crop.width), room / max(1, crop.height))
    w, h = max(1, round(crop.width * scale)), max(1, round(crop.height * scale))
    w, h = min(w, canvas), min(h, canvas)
    # BOX averages each block (colour stays true); hard alpha comes later in lock_palette.
    small = crop.resize((w, h), Image.Resampling.BOX)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.paste(small, ((canvas - w) // 2, canvas - margin - h), small)
    return out, scale


def fill_canvas(image: Image.Image, canvas: int) -> Image.Image:
    """Tiles and backgrounds: no cut-out, the whole picture (centre square) becomes the canvas."""
    img = image.convert("RGBA")
    side = min(img.size)
    left, top = (img.width - side) // 2, (img.height - side) // 2
    return img.crop((left, top, left + side, top + side)).resize((canvas, canvas), Image.Resampling.BOX)


def pixelize(image: Image.Image, canvas: int = 32, palette: str | list[str] = "auto", outline: bool = True,
             scale: float | None = None, fill: bool = False) -> tuple[Image.Image, dict]:
    """One sprite from any image. Returns the sprite and the settings that reproduce it on other frames."""
    if canvas not in CANVAS_SIZES:
        raise ValueError(f"Canvas must be one of {', '.join(map(str, CANVAS_SIZES))}.")
    image = snap_grid(image)
    if fill:
        tile = fill_canvas(image, canvas)
        colours = resolve_palette(palette, tile)
        sprite = lock_palette(tile.convert("RGB").convert("RGBA"), colours)
        return sprite, {"canvas": canvas, "palette": colours, "outline": False, "scale": None, "fill": True}
    subject = knock_out(image)
    colours = resolve_palette(palette, subject)
    fitted, used = fit_canvas(subject, canvas, scale)
    sprite = remove_orphans(lock_palette(fitted, colours))
    if outline:
        sprite = add_outline(sprite, darkest(colours))
    return sprite, {"canvas": canvas, "palette": colours, "outline": outline, "scale": used}


def split_strip(image: Image.Image, frames: int) -> list[Image.Image]:
    """Cut a horizontal strip (or a grid that is wider than tall) into `frames` equal cells, left to right."""
    frames = max(1, int(frames))
    w, h = image.size
    cols = frames
    rows = 1
    if w / max(1, h) < frames * 0.5:  # roughly square: probably a grid
        import math

        cols = math.ceil(math.sqrt(frames))
        rows = math.ceil(frames / cols)
    cw, ch = w // cols, h // rows
    cells = []
    for i in range(frames):
        x, y = (i % cols) * cw, (i // cols) * ch
        cells.append(image.crop((x, y, x + cw, y + ch)))
    return cells


def frames_from_strip(image: Image.Image, frames: int, settings: dict) -> list[Image.Image]:
    """Every cell of a generated strip, pixelized with one locked palette and one scale, feet on one anchor."""
    return frames_from_cells(split_strip(image, frames), settings)


def frames_from_cells(images: list[Image.Image], settings: dict) -> list[Image.Image]:
    """Cells of one generated sheet, pixelized with one locked palette and one scale, feet on one anchor."""
    if settings.get("fill"):
        return [lock_palette(fill_canvas(snap_grid(c), settings["canvas"]).convert("RGB").convert("RGBA"), settings["palette"]) for c in images]
    cells = [knock_out(snap_grid(c)) for c in images]
    # One scale for the whole sheet: from the tallest cell, so no frame is cropped and none changes size.
    tallest = max(cells, key=lambda c: (c.getchannel("A").getbbox() or (0, 0, 0, 0))[3] - (c.getchannel("A").getbbox() or (0, 0, 0, 0))[1])
    _, scale = fit_canvas(tallest, settings["canvas"])
    out = []
    for cell in cells:
        fitted, _ = fit_canvas(cell, settings["canvas"], scale)
        sprite = remove_orphans(lock_palette(fitted, settings["palette"]))
        if settings.get("outline"):
            sprite = add_outline(sprite, darkest(settings["palette"]))
        out.append(sprite)
    return out


def off_palette(image: Image.Image, palette: list[str]) -> int:
    """How many opaque pixels are not a palette colour (0 for a clean sprite)."""
    allowed = {hex_to_rgb(c) for c in palette}
    return sum(1 for r, g, b, a in _pixels(image.convert("RGBA")) if a and (r, g, b) not in allowed)
