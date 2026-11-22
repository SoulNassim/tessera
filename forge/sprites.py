"""Sprite sets: pixel sprites with directions and animations, stored next to an asset and exported for engines.

    art/<folder>/<asset>/sprites/<set>/
        sprite.json        {canvas, palette, outline, scale, directions, animations: {name: {fps, loop, frames: {dir: [png]}}}}
        <name>-<dir>-<n>.png   one PNG per frame
        sheet.png  sheet.json (Aseprite)  <set>.tres (Godot SpriteFrames)  preview.gif   ← from export_set

The base sprite is the animation "base" (one frame per direction). Every frame added later is pixelized with the
set's locked palette, canvas and scale, so directions and animations stay consistent.
"""

from __future__ import annotations

import base64
import io
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image

from forge import pixel
from forge.overview import resolve_rel, slugify

DIRECTIONS = ("s", "se", "e", "ne", "n", "nw", "w", "sw")
PRESETS = {"idle": (4, 6, True), "walk": (8, 10, True), "run": (8, 12, True), "attack": (6, 12, False),
           "hurt": (3, 10, False), "death": (6, 8, False), "jump": (6, 10, False)}


def _asset_dir(ws_dir: Path, asset_rel: str) -> Path:
    page = resolve_rel(ws_dir, asset_rel)
    if page.suffix.lower() != ".md" or not page.is_file():
        raise ValueError(f"No asset page '{asset_rel}'.")
    return page.with_suffix("")


def _set_dir(ws_dir: Path, asset_rel: str, name: str) -> Path:
    clean = slugify(name)
    if not clean:
        raise ValueError("A sprite set needs a name.")
    return _asset_dir(ws_dir, asset_rel) / "sprites" / clean


def _rel(ws_dir: Path, path: Path) -> str:
    return path.resolve().relative_to(ws_dir.resolve()).as_posix()


def _load(folder: Path) -> dict[str, Any]:
    try:
        return json.loads((folder / "sprite.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("That sprite set doesn't exist.") from exc


def _save(folder: Path, data: dict[str, Any]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "sprite.json").write_text(json.dumps(data, indent=2), encoding="utf-8")


def _open(ws_dir: Path, rel: str) -> Image.Image:
    path = resolve_rel(ws_dir, rel)
    if not path.is_file():
        raise FileNotFoundError(f"No image '{rel}'.")
    with Image.open(path) as im:
        return im.convert("RGBA")


def _write_frames(folder: Path, data: dict[str, Any], anim: str, direction: str, images: list[Image.Image]) -> list[str]:
    for old in folder.glob(f"{anim}-{direction}-*.png"):
        old.unlink()
    names = []
    for i, im in enumerate(images):
        name = f"{anim}-{direction}-{i}.png"
        im.save(folder / name)
        names.append(name)
    entry = data["animations"].setdefault(anim, {"fps": PRESETS.get(anim, (1, 8, True))[1], "loop": PRESETS.get(anim, (1, 8, True))[2], "frames": {}})
    entry["frames"][direction] = names
    if direction not in data["directions"]:
        data["directions"].append(direction)
        data["directions"].sort(key=lambda d: DIRECTIONS.index(d) if d in DIRECTIONS else 99)
    return names


def describe(ws_dir: Path, folder: Path) -> dict[str, Any]:
    data = _load(folder)
    base = _rel(ws_dir, folder)
    return {**data, "name": folder.name, "folder": base,
            "exports": {f: f"{base}/{f}" for f in ("sheet.png", "sheet.json", f"{folder.name}.tres", "preview.gif") if (folder / f).is_file()}}


def list_sets(ws_dir: Path, asset_rel: str) -> list[dict[str, Any]]:
    root = _asset_dir(ws_dir, asset_rel) / "sprites"
    if not root.is_dir():
        return []
    return [describe(ws_dir, d) for d in sorted(root.iterdir()) if (d / "sprite.json").is_file()]


REF_SIZE = 512


def write_ref(folder: Path, sprite: Image.Image) -> None:
    """The base sprite blown up with hard pixels: the asset's picture, and a clean reference for new generations."""
    k = max(1, REF_SIZE // max(sprite.size))
    sprite.resize((sprite.width * k, sprite.height * k), Image.Resampling.NEAREST).save(folder / "ref.png")


def create_set(ws_dir: Path, asset_rel: str, image_rel: str, *, name: str = "main", canvas: int = 32,
               palette: str | list[str] = "auto", outline: bool = True, direction: str = "s", fill: bool = False) -> dict[str, Any]:
    """The base sprite from an image (a winner or candidate). Locks the palette, canvas and scale for the set."""
    folder = _set_dir(ws_dir, asset_rel, name)
    if (folder / "sprite.json").is_file():
        raise ValueError(f"There is already a sprite set called '{folder.name}'.")
    sprite, settings = pixel.pixelize(_open(ws_dir, image_rel), int(canvas), palette, bool(outline), fill=fill)
    data = {**settings, "source": image_rel, "directions": [], "animations": {}}
    folder.mkdir(parents=True, exist_ok=True)
    _write_frames(folder, data, "base", direction if direction in DIRECTIONS else "s", [sprite])
    data["animations"]["base"].update({"fps": 1, "loop": True})
    write_ref(folder, sprite)
    _save(folder, data)
    return describe(ws_dir, folder)


def base_sprite(ws_dir: Path, asset_rel: str, name: str, direction: str = "s") -> Image.Image:
    """The still sprite of a facing (the first facing there is when that one is missing)."""
    folder = _set_dir(ws_dir, asset_rel, name)
    data = _load(folder)
    frames = data["animations"]["base"]["frames"]
    files = frames.get(direction) or next(iter(frames.values()), [])
    if not files:
        raise ValueError("This sprite has no base frame.")
    with Image.open(folder / files[0]) as im:
        return im.convert("RGBA")


def add_directions(ws_dir: Path, asset_rel: str, name: str, cells: dict[str, Image.Image]) -> dict[str, Any]:
    """Several facings at once (cells of one generated turnaround sheet), one scale for all of them."""
    folder = _set_dir(ws_dir, asset_rel, name)
    data = _load(folder)
    sprites = pixel.frames_from_cells(list(cells.values()), data)
    for direction, sprite in zip(cells, sprites):
        if direction in DIRECTIONS:
            _write_frames(folder, data, "base", direction, [sprite])
    _save(folder, data)
    return describe(ws_dir, folder)


def add_cells(ws_dir: Path, asset_rel: str, name: str, anim: str, direction: str, cells: list[Image.Image],
              fps: int | None = None, loop: bool | None = None) -> dict[str, Any]:
    """An animation from the cells of one generated sheet: each pixelized with the set's lock, one shared scale."""
    anim = slugify(anim) or "anim"
    if anim == "base":
        raise ValueError("'base' is the still sprite; pick another animation name.")
    folder = _set_dir(ws_dir, asset_rel, name)
    data = _load(folder)
    images = pixel.frames_from_cells(cells, data)
    _write_frames(folder, data, anim, direction if direction in DIRECTIONS else "s", images)
    preset = PRESETS.get(anim, (len(images), 10, True))
    entry = data["animations"][anim]
    entry["fps"] = int(fps or entry.get("fps") or preset[1])
    entry["loop"] = bool(preset[2] if loop is None else loop)
    _save(folder, data)
    return describe(ws_dir, folder)


def add_direction(ws_dir: Path, asset_rel: str, name: str, direction: str, image_rel: str) -> dict[str, Any]:
    """Another facing of the base sprite (from a `views`/edit image), with the set's locked settings."""
    if direction not in DIRECTIONS:
        raise ValueError(f"Direction must be one of {', '.join(DIRECTIONS)}.")
    folder = _set_dir(ws_dir, asset_rel, name)
    data = _load(folder)
    sprite, _ = pixel.pixelize(_open(ws_dir, image_rel), data["canvas"], data["palette"], data["outline"], scale=data.get("scale"), fill=bool(data.get("fill")))
    _write_frames(folder, data, "base", direction, [sprite])
    _save(folder, data)
    return describe(ws_dir, folder)


def add_animation(ws_dir: Path, asset_rel: str, name: str, anim: str, direction: str, image_rel: str,
                  frames: int, fps: int | None = None, loop: bool | None = None) -> dict[str, Any]:
    """An animation for one direction from a generated strip: cut into frames, each pixelized and anchored alike."""
    anim = slugify(anim) or "anim"
    if anim == "base":
        raise ValueError("'base' is the still sprite; pick another animation name.")
    folder = _set_dir(ws_dir, asset_rel, name)
    data = _load(folder)
    images = pixel.frames_from_strip(_open(ws_dir, image_rel), int(frames), data)
    _write_frames(folder, data, anim, direction if direction in DIRECTIONS else "s", images)
    preset = PRESETS.get(anim, (len(images), 10, True))
    entry = data["animations"][anim]
    entry["fps"] = int(fps or entry.get("fps") or preset[1])
    entry["loop"] = bool(preset[2] if loop is None else loop)
    _save(folder, data)
    return describe(ws_dir, folder)


def _decode_png(data_url: str) -> Image.Image:
    raw = base64.b64decode(re.sub(r"^data:image/png;base64,", "", data_url))
    with Image.open(io.BytesIO(raw)) as im:
        return im.convert("RGBA")


def save_animation(ws_dir: Path, asset_rel: str, name: str, anim: str, direction: str, frames: list[str],
                   fps: int | None = None, loop: bool | None = None) -> dict[str, Any]:
    """Frames edited by hand (PNG data URLs, in order). Each is checked against the canvas and snapped to the palette."""
    folder = _set_dir(ws_dir, asset_rel, name)
    data = _load(folder)
    if anim not in data["animations"] and anim != "base":
        data["animations"][anim] = {"fps": int(fps or 8), "loop": True if loop is None else bool(loop), "frames": {}}
    images = []
    for url in frames:
        im = _decode_png(url)
        if im.size != (data["canvas"], data["canvas"]):
            raise ValueError(f"Frames must be {data['canvas']}×{data['canvas']} pixels.")
        images.append(pixel.lock_palette(im, data["palette"]))
    if not images:
        data["animations"][anim]["frames"].pop(direction, None)
        for old in folder.glob(f"{anim}-{direction}-*.png"):
            old.unlink()
    else:
        _write_frames(folder, data, anim, direction, images)
    entry = data["animations"][anim]
    if fps:
        entry["fps"] = int(fps)
    if loop is not None:
        entry["loop"] = bool(loop)
    _save(folder, data)
    return describe(ws_dir, folder)


def delete_animation(ws_dir: Path, asset_rel: str, name: str, anim: str) -> dict[str, Any]:
    folder = _set_dir(ws_dir, asset_rel, name)
    data = _load(folder)
    if anim == "base":
        raise ValueError("The base sprite can't be removed.")
    for old in folder.glob(f"{anim}-*.png"):
        old.unlink()
    data["animations"].pop(anim, None)
    _save(folder, data)
    return describe(ws_dir, folder)


def _strips(data: dict[str, Any]) -> list[tuple[str, str, dict[str, Any], list[str]]]:
    """(tag, animation, entry, frame files) for every animation × direction, base first."""
    out = []
    for anim in sorted(data["animations"], key=lambda a: (a != "base", a)):
        entry = data["animations"][anim]
        for direction in data["directions"]:
            files = entry["frames"].get(direction) or []
            if files:
                out.append((f"{anim}_{direction}", anim, entry, files))
    return out


def export_set(ws_dir: Path, asset_rel: str, name: str) -> dict[str, Any]:
    """Packed sheet (one row per animation and direction), Aseprite JSON, Godot SpriteFrames and a GIF preview."""
    folder = _set_dir(ws_dir, asset_rel, name)
    data = _load(folder)
    size = data["canvas"]
    strips = _strips(data)
    if not strips:
        raise ValueError("This set has no frames yet.")
    cols = max(len(files) for *_, files in strips)
    sheet = Image.new("RGBA", (cols * size, len(strips) * size), (0, 0, 0, 0))
    frames_json: dict[str, Any] = {}
    tags = []
    index = 0
    godot_subs, godot_anims = [], []
    for row, (tag, _anim, entry, files) in enumerate(strips):
        start = index
        sub_ids = []
        duration_ms = round(1000 / max(1, int(entry.get("fps") or 8)))
        for col, file in enumerate(files):
            with Image.open(folder / file) as im:
                sheet.paste(im.convert("RGBA"), (col * size, row * size))
            frames_json[f"{tag} {col}"] = {
                "frame": {"x": col * size, "y": row * size, "w": size, "h": size}, "rotated": False, "trimmed": False,
                "spriteSourceSize": {"x": 0, "y": 0, "w": size, "h": size}, "sourceSize": {"w": size, "h": size}, "duration": duration_ms,
            }
            sub_id = f"AtlasTexture_{index}"
            godot_subs.append(f'[sub_resource type="AtlasTexture" id="{sub_id}"]\natlas = ExtResource("1_sheet")\nregion = Rect2({col * size}, {row * size}, {size}, {size})\n')
            sub_ids.append(sub_id)
            index += 1
        tags.append({"name": tag, "from": start, "to": index - 1, "direction": "forward"})
        frames_text = ", ".join(f'{{\n"duration": 1.0,\n"texture": SubResource("{s}")\n}}' for s in sub_ids)
        godot_anims.append(f'{{\n"frames": [{frames_text}],\n"loop": {str(bool(entry.get("loop", True))).lower()},\n"name": &"{tag}",\n"speed": {float(entry.get("fps") or 8)}\n}}')
    sheet.save(folder / "sheet.png")
    aseprite = {"frames": frames_json, "meta": {"app": "Tessera Studio", "version": "1", "image": "sheet.png", "format": "RGBA8888",
                                                "size": {"w": sheet.width, "h": sheet.height}, "scale": "1", "frameTags": tags}}
    (folder / "sheet.json").write_text(json.dumps(aseprite, indent=1), encoding="utf-8")
    tres = (f'[gd_resource type="SpriteFrames" load_steps={len(godot_subs) + 2} format=3]\n\n'
            f'[ext_resource type="Texture2D" path="sheet.png" id="1_sheet"]\n\n'
            + "\n".join(godot_subs)
            + "\n[resource]\nanimations = [" + ", ".join(godot_anims) + "]\n")
    (folder / f"{folder.name}.tres").write_text(tres, encoding="utf-8")
    # The preview: the first moving animation facing south (or the base), scaled up so it is visible.
    moving = [s for s in strips if s[1] != "base"] or strips
    tag, _, entry, files = moving[0]
    scale = max(1, 128 // size)
    gif_frames = []
    for file in files:
        with Image.open(folder / file) as im:
            big = im.convert("RGBA").resize((size * scale, size * scale), Image.Resampling.NEAREST)
            bg = Image.new("RGBA", big.size, (24, 24, 30, 255))
            bg.alpha_composite(big)
            gif_frames.append(bg.convert("P", palette=Image.Palette.ADAPTIVE))
    gif_frames[0].save(folder / "preview.gif", save_all=True, append_images=gif_frames[1:], duration=round(1000 / max(1, int(entry.get("fps") or 8))), loop=0, disposal=2)
    return describe(ws_dir, folder)


def list_all(ws_dir: Path) -> list[dict[str, Any]]:
    """Every sprite set in the project, newest first, with the asset each belongs to."""
    found = []
    for meta in ws_dir.rglob("sprites/*/sprite.json"):
        if any(part.startswith(".") for part in meta.relative_to(ws_dir).parts):
            continue
        folder = meta.parent
        page = folder.parent.parent.with_suffix(".md")
        if not page.is_file():
            continue
        try:
            item = describe(ws_dir, folder)
        except ValueError:
            continue
        item["asset"] = _rel(ws_dir, page)
        item["changed"] = meta.stat().st_mtime
        found.append(item)
    return sorted(found, key=lambda s: -s["changed"])


def preview_png(ws_dir: Path, image_rel: str, canvas: int, palette: str | list[str], outline: bool) -> str:
    """What create_set would make, as a PNG data URL, without saving anything."""
    sprite, settings = pixel.pixelize(_open(ws_dir, image_rel), int(canvas), palette, bool(outline))
    buf = io.BytesIO()
    sprite.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
