"""What each step of a Node Studio workflow does, and saving the results as project assets.

The paid steps go through Tessera's own generators (`asset_studio.run_action`, handed in as `run.request`), so models,
keys, demo mode and the record of how a file was made work as everywhere else. Each run of a step works on a hidden
asset page in `.flows/<id>/out/<step>/`, because an asset page is what those generators take.
"""

from __future__ import annotations

import asyncio
import colorsys
import hashlib
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any, Awaitable, Callable

from PIL import Image

from forge import asset_studio, flow_models
from forge.blueprint_contract import serialize_frontmatter
from forge.config import load_config
from forge.flow_nodes import kind_of
from forge.flows import PICTURES, Run, Value, flow_dir, lines_of, rel_to, sha, title_of, types_after, write_json
from forge.layout import Layout
from forge.overview import humanize, resolve_rel, slugify

Others = dict[str, list[Value]]


def _page(run: Run, node: dict[str, Any], key: str, kind: str, title: str, prompt: str = "", **meta: Any) -> str:
    path = flow_dir(run.ws_dir, run.flow_id) / "out" / node["id"] / f"{key[:12]}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = {"kind": kind, "title": title, **({"prompt": prompt} if prompt else {}), **{k: v for k, v in meta.items() if v not in ("", None)}}
    path.write_text(serialize_frontmatter(fields, f"# {title}\n"), encoding="utf-8")
    return rel_to(run.ws_dir, path)


def _file(run: Run, node: dict[str, Any], key: str, folder: str, name: str) -> Path:
    path = flow_dir(run.ws_dir, run.flow_id) / "out" / node["id"] / key[:12] / folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _open(run: Run, rel: str) -> Image.Image:
    with Image.open(resolve_rel(run.ws_dir, rel)) as im:
        im.load()
        return im.copy()


def _made(run: Run, t: str, path: str, item: Value, folder: str, **more: Any) -> Value:
    """A new thing made from `item`: it keeps its name, what it came from and everything on the way (`from`)."""
    value: Value = {"t": t, "path": path, "name": item.get("name") or "", "origin": item.get("origin") or "", "kind": item.get("kind") or "",
                    "desc": item.get("desc") or item.get("text") or "", "folder": folder, "root": item.get("root") or path,
                    "from": [*(item.get("from") or []), *([{k: item[k] for k in ("t", "path", "folder", "pixel", "raw", "rig", "side") if item.get(k)}] if item.get("path") else [])]}
    if t in ("model", "rig", "clip"):
        thumb = resolve_rel(run.ws_dir, path).with_name(f"{Path(path).stem}_thumb.png")
        value["thumb"] = rel_to(run.ws_dir, thumb) if thumb.is_file() else item.get("thumb") or (item["path"] if item.get("t") == "picture" else "")
    value.update(more)
    return value


def _pictures(outputs: list[str]) -> list[str]:
    return [o for o in outputs if Path(o).suffix.lower() in PICTURES]


def _stem(item: Value) -> str:
    return slugify(item.get("name") or "")[:40] or "picture"


# ---------- pictures ----------

async def _draw(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    f = node["fields"]
    # What comes after shapes a new drawing, and is left out of its key: a 3D step added later must not redraw what is paid for.
    after = types_after(run.doc, node["id"])
    kind = f["kind"] if f["kind"] != "auto" else kind_of(item["text"]) or ("character" if "rig" in after else "item" if "icons" in after else "material" if "tile" in after else "prop")
    style = [v["text"] for v in others["style"] if v.get("text")]
    if "make3d" in after:
        style.append("The whole subject is in view with nothing cropped, seen from the front at a slight angle, evenly lit, on a plain empty background")
        if "rig" in after:
            style.append("It stands upright in a neutral A-pose: arms straight and held away from the body, legs slightly apart")
    page = _page(run, node, key, kind, item["name"], item["text"], style=". ".join(style))
    request = asset_studio.build_request(run.ws_dir, page, "candidates", model=f["model"])
    request["count"] = f["count"]
    if f["background"] != "auto":
        request["settings"]["transparent_background"] = f["background"] == "cutout"
    if f["shape"] != "auto":
        request["settings"]["aspect_ratio"] = f["shape"]
    likes = [v for v in others["like"] if v.get("path")][:3]
    if likes:
        extra = [{"path": v["path"], "source": "Look like this", "role": "extra"} for v in likes]
        request["references"] = [*request["references"][:asset_studio.MAX_REFERENCES - len(extra)], *extra]
        request["prompt"] += "\n\nUse the attached picture as the guide for how the subject looks: its design, colours and proportions."
    return [_made(run, "picture", p, item, "candidates", kind=kind, root=p) for p in _pictures(await run.request(request))]


async def _pixel(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    from forge import pixel_engine

    f = node["fields"]
    kind = f["kind"] if f["kind"] != "auto" else kind_of(item["text"])
    opts = pixel_engine.defaults({**{k: f[k] for k in ("canvas", "view", "outline")}, "kind": kind if kind in pixel_engine.ASSET_KIND else "character"})
    kind = pixel_engine.ASSET_KIND[opts["kind"]]
    page = _page(run, node, key, kind, item["name"], item["text"], aspect="1:1")
    request = asset_studio.build_request(run.ws_dir, page, "candidates", model=flow_models.used(node, load_config()))
    request.update(prompt=pixel_engine.create_prompt(item["text"], opts), references=[], use_bible=False, count=f["count"],
                   settings={"aspect_ratio": "1:1", "transparent_background": False})
    out = []
    for raw in _pictures(await run.request(request)):
        sprite = await asyncio.to_thread(pixel_engine.snap_candidate, run.ws_dir, page, raw, opts)
        out.append(_made(run, "picture", sprite, item, "candidates", kind=kind, root=sprite, pixel=opts, raw=raw))
    return out


async def _change(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    words = " ".join(v["text"] for v in others["text"] if v.get("text"))
    page = _page(run, node, key, item.get("kind") or "prop", item["name"], words)
    request = asset_studio.build_request(run.ws_dir, page, "edit", source=item["path"], instruction=words, model=node["fields"]["model"])
    request["count"] = 1
    return [_made(run, "picture", p, item, "edits", root=p) for p in _pictures(await run.request(request))]


async def _views(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    page = _page(run, node, key, item.get("kind") or "prop", item["name"])
    request = asset_studio.build_request(run.ws_dir, page, "views", source=item["path"], model=node["fields"]["model"])
    return [_made(run, "picture", p, item, "views", side=True) for p in _pictures(await run.request(request))]


async def _cutout(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    from forge.local_ai.cutout import cut_out

    target = _file(run, node, key, "edits", f"{_stem(item)}-cut.png")
    picture = _open(run, item["path"]).convert("RGBA")
    picture.save(target)
    if picture.getchannel("A").getextrema()[0] >= 16:  # not see-through yet
        removed, _ = await cut_out(target)
        if not removed:
            notes.append("The background is too busy to clear here, so it was left in. Use a plainer picture, or install BiRefNet in Settings → This PC.")
    return [_made(run, "picture", rel_to(run.ws_dir, target), item, "edits")]


HUES = {"Red": 0.0, "Orange": 0.075, "Yellow": 0.145, "Green": 0.34, "Teal": 0.49, "Blue": 0.61, "Purple": 0.76, "Pink": 0.9}


def recolour(image: Image.Image, colour: str) -> Image.Image:
    """The picture with its main colour turned into another; light, dark and greys stay as they are."""
    rgba = image.convert("RGBA")
    h, s, v = rgba.convert("RGB").convert("HSV").split()
    if colour not in HUES:
        out = Image.merge("HSV", (h, s.point(lambda p: p // 8), v))
    else:
        # The main hue: the circular average of what is visible, strong colours counting most.
        x = y = 0.0
        small = rgba.resize((48, 48))
        for px in range(48):
            for py in range(48):
                r, g, b, a = small.getpixel((px, py))
                if a >= 40:
                    hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                    x += math.cos(hh * 2 * math.pi) * ss * vv
                    y += math.sin(hh * 2 * math.pi) * ss * vv
        shift = round((HUES[colour] - (math.atan2(y, x) / (2 * math.pi)) % 1.0) * 255) % 256
        out = Image.merge("HSV", (h.point(lambda p: (p + shift) % 256), s, v))
    out = out.convert("RGB").convert("RGBA")
    out.putalpha(rgba.getchannel("A"))
    return out


async def _recolor(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    image = _open(run, item["path"])
    out = []
    for colour in node["fields"]["colours"]:
        target = _file(run, node, key, "variants", f"{_stem(item)}-{colour.lower()}.png")
        (await asyncio.to_thread(recolour, image, colour)).save(target)
        rel = rel_to(run.ws_dir, target)
        out.append(_made(run, "picture", rel, item, "variants", root=rel, label=colour))
    return out


async def _icons(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    from forge import game_tools

    page = _page(run, node, key, item.get("kind") or "item", item["name"])
    made = await asyncio.to_thread(game_tools.make_icons, run.ws_dir, page, item["path"], [int(s) for s in node["fields"]["sizes"]])
    return [_made(run, "picture", p, item, "icons", label=f"{Path(p).stem.rsplit('-', 1)[-1]} px") for p in made]


async def _split(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    from forge import game_tools

    boxes = await asyncio.to_thread(game_tools.detect_sheet_items, run.ws_dir, item["path"])
    if len(boxes) < 2:
        raise ValueError("Only one object was found. Use a picture with space between the objects, on a plain background.")
    image = _open(run, item["path"])
    out = []
    for i, box in enumerate(boxes, start=1):
        left, top = round(box["x"] * image.width), round(box["y"] * image.height)
        crop = image.crop((left, top, min(image.width, left + round(box["w"] * image.width)), min(image.height, top + round(box["h"] * image.height))))
        if min(crop.size) < 8:
            continue
        target = _file(run, node, key, "candidates", f"piece-{i}.png")
        game_tools._knock_out_background(crop).save(target)
        rel = rel_to(run.ws_dir, target)
        # Each piece is its own thing from here on: its own name, its own asset.
        out.append(_made(run, "picture", rel, {"name": f"{item['name']} {i}", "origin": f"{item['origin']}/{i}"}, "candidates", kind=node["fields"]["kind"]))
    return out


async def _tile(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    from forge import modular

    page = _page(run, node, key, "material", item["name"], winner=item["path"])
    made = await asyncio.to_thread(modular.build_material, run.ws_dir, page)
    return [_made(run, "surface", made[0], item, "textures", kind="material", maps=made)]


# ---------- 3D ----------

# The three words under Detail, for each 3D maker.
DETAIL: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "light": ({"should_remesh": True, "target_polycount": 3000}, {"face_limit": 3000}),
    "game": ({"should_remesh": True, "target_polycount": 12000}, {"face_limit": 12000}),
    "high": ({"should_remesh": True, "target_polycount": 100000}, {"face_limit": 0, "geometry_quality": "detailed"}),
}


async def _make3d(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    f = node["fields"]
    page = _page(run, node, key, item.get("kind") or "prop", item["name"], item.get("desc") or "", winner=item["path"])
    request = asset_studio.build_request(run.ws_dir, page, "make_3d", source=item["path"], model=f["model"])
    if f["model"].startswith("svc:"):
        request["model"] = f["model"]
    request["references"] = request["references"][:1] + [{"path": v["path"], "source": "Other side", "role": "view"} for v in others["sides"][:3]]
    meshy, tripo = DETAIL[f["detail"]]
    wanted = {**tripo, "texture": f["texture"]} if request.get("engine") == "tripo" else {**meshy, "should_texture": f["texture"]}
    request["settings"] = {**request["settings"], **wanted}
    made = [p for p in await run.request(request) if Path(p).suffix.lower() in (".glb", ".gltf", ".obj", ".fbx")]
    return [_made(run, "model", p, item, "3d") for p in made[:1]]


async def _rig(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    f = node["fields"]
    page = _page(run, node, key, item.get("kind") or "character", item["name"])
    request = asset_studio.build_request(run.ws_dir, page, "rig", source=item["path"])
    engine = flow_models.used(node, load_config())
    if f["body"] != "biped" and engine == "meshy" and not load_config().demo_mode:
        raise ValueError("Meshy gives skeletons to two-legged characters only. Choose Tripo as the AI model for four legs.")
    request.update(engine=engine, model=f"{engine}:rigging")
    request["settings"] = {**request["settings"], "engine": engine, "height_meters": float(f["height"]), "rig_type": f["body"]}
    made = [p for p in await run.request(request) if "/rig/" in p and p.lower().endswith((".glb", ".fbx"))]
    made.sort(key=lambda p: not p.lower().endswith(".glb"))
    meta = asset_studio.read_asset(run.ws_dir, page)[1]
    return [_made(run, "rig", p, item, "rig", rig={k: meta[k] for k in ("rig_task", "rig_model", "rig_provider") if meta.get(k)}) for p in made[:1]]


MOVE_WORDS = {"Idle": ("idle",), "Walk": ("walking", "walk"), "Run": ("running", "run"), "Jump": ("jump", "jumping"), "Attack": ("attack", "slash", "punch"),
              "Hurt": ("hit", "hurt"), "Wave": ("wave", "waving"), "Dance": ("dance", "dancing"), "Die": ("dead", "death", "die", "dying")}


def match_moves(wanted: list[str], library: list[dict[str, Any]]) -> tuple[list[Any], list[str], list[str]]:
    """(ids, names, moves this account doesn't have): the plainest animation for each word."""
    ids, names, missing = [], [], []
    for move in wanted:
        best: tuple[tuple[int, ...], Any] | None = None
        for a in library:
            tokens = re.findall(r"[a-z]+", str(a["name"]).lower())
            if a.get("rig_type") not in (None, "", "biped"):
                continue
            for rank, word in enumerate(MOVE_WORDS.get(move, (move.lower(),))):
                if word in tokens:
                    score = (len(tokens), tokens.index(word), rank)  # "Walk" beats "Monster walk with limp"
                    if best is None or score < best[0]:
                        best = (score, a["id"])
        if best is None:
            missing.append(move)
        else:
            ids.append(best[1])
            names.append(move)
    return ids, names, missing


async def _animate(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    from forge import game_tools

    moves = node["fields"]["moves"]
    page = _page(run, node, key, item.get("kind") or "character", item["name"], **(item.get("rig") or {}))
    request = asset_studio.build_request(run.ws_dir, page, "animate")
    ids, names, missing = [1], moves, []
    if not load_config().demo_mode:
        ids, names, missing = match_moves(moves, await game_tools.animation_library("", str(request.get("engine") or "")))
    if missing:
        notes.append(f"No ready-made move for {', '.join(missing)} with this account.")
    if not ids:
        raise ValueError(f"No ready-made move for {', '.join(moves)} with this account. Pick another one.")
    request.update(action_ids=ids, names=names)
    made = await run.request(request)
    glbs = [p for p in made if p.lower().endswith(".glb")] or [p for p in made if p.lower().endswith(".fbx")][:1]
    return [_made(run, "clip", p, item, "animations", moves=names, rig=item.get("rig")) for p in glbs]


# ---------- words and sound ----------

async def _vary(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    return [{"t": "text", "text": f"{item['text'].rstrip('. ')}, {line}", "name": f"{item['name']} {title_of(line).lower()}"[:80], "origin": f"{item['origin']}/{sha(line)[:8]}"}
            for line in lines_of(node["fields"]["lines"])]


async def _sound(run: Run, node: dict[str, Any], key: str, item: Value, others: Others, notes: list[str]) -> list[Value]:
    f = node["fields"]
    page = _page(run, node, key, f["kind"], item["name"], item["text"])
    request = asset_studio.build_request(run.ws_dir, page, "candidates", model=flow_models.chosen(node))
    request["count"] = f["count"]
    return [_made(run, "sound", p, item, "audio", kind=f["kind"]) for p in await run.request(request)]


STEPS: dict[str, Callable[..., Awaitable[list[Value]]]] = {
    "draw": _draw, "pixel": _pixel, "change": _change, "views": _views, "cutout": _cutout, "recolor": _recolor, "icons": _icons,
    "split": _split, "tile": _tile, "make3d": _make3d, "rig": _rig, "animate": _animate, "vary": _vary, "sound": _sound,
}


# ---------- saving into the project ----------

SECTION_WORDS = {
    "character": ("character", "cast", "hero"), "creature": ("creature", "enem", "monster"), "item": ("item", "pickup"), "weapon": ("weapon",),
    "prop": ("prop",), "vehicle": ("vehicle",), "environment": ("environment", "location", "scene"), "ui": ("ui", "interface", "hud"),
    "vfx": ("vfx", "effect"), "sfx": ("sound", "audio", "sfx"), "voice": ("voice", "sound", "audio"), "music": ("music", "sound", "audio"), "material": ("material", "texture"),
}
SECTION_NAMES = {"vfx": "vfx", "ui": "ui", "sfx": "sounds", "voice": "sounds", "music": "sounds"}


def auto_section(ws_dir: Path, kind: str) -> str:
    """The section an asset of this kind belongs in: one the project already has, else a new one named after it."""
    folders = [d for d in sorted(ws_dir.iterdir()) if d.is_dir() and not d.name.startswith((".", "_")) and d.name != asset_studio.PILLAR_DIR]
    for word in SECTION_WORDS.get(kind, (kind,)):
        for folder in folders:
            tokens = re.findall(r"[a-z]+", humanize(folder.name).lower())
            if word in tokens or (len(word) > 3 and any(t.startswith(word) for t in tokens)):
                return folder.name
    return SECTION_NAMES.get(kind, f"{kind}s")


def _digest(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def _copy_in(ws_dir: Path, rel: str, page: Path, folder: str) -> str:
    """Copy one result into an asset's own folder with its record; the same file is never added twice."""
    src = resolve_rel(ws_dir, rel)
    dest = page.with_suffix("") / folder
    dest.mkdir(parents=True, exist_ok=True)
    size, digest = src.stat().st_size, _digest(src)
    for other in dest.iterdir():
        if other.is_file() and other.suffix.lower() == src.suffix.lower() and other.stat().st_size == size and _digest(other) == digest:
            return rel_to(ws_dir, other)
    tail = re.sub(r"^[0-9a-f]{12}-?", "", src.stem)  # the hidden page's name
    stem = tail if tail.startswith(page.stem) else f"{page.stem}-{tail}" if tail else page.stem
    target, n = dest / f"{stem}{src.suffix.lower()}", 2
    while target.exists():
        target, n = dest / f"{stem}-{n}{src.suffix.lower()}", n + 1
    shutil.copy2(src, target)
    thumb = src.with_name(f"{src.stem}_thumb.png")
    if thumb.is_file():
        shutil.copy2(thumb, target.with_name(f"{target.stem}_thumb.png"))
    if src.suffix.lower() == ".glb":
        for twin in src.parent.glob(f"{src.stem}.*"):  # the other formats of the same model
            if twin.suffix.lower() in (".fbx", ".obj", ".usdz", ".stl"):
                shutil.copy2(twin, target.with_suffix(twin.suffix.lower()))
    # The record of how it was made goes along, so the asset's history (and the demo marker) stay true.
    out, history = rel_to(ws_dir, target), Layout.of_art(ws_dir).history
    try:
        record = json.loads((history / Path(rel_to(ws_dir, src)).with_suffix(".json")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return out
    write_json(history / Path(out).with_suffix(".json"), {**record, "asset": rel_to(ws_dir, page), "file": out})
    return out


def _new_page(ws_dir: Path, section: str, kind: str, name: str, desc: str) -> Path:
    folder = resolve_rel(ws_dir, section or auto_section(ws_dir, kind))
    if not folder.is_dir():
        folder.mkdir(parents=True)
        (folder / "README.md").write_text(f"# {humanize(folder.name)}\n", encoding="utf-8")
    slug = slugify(name)[:60] or "asset"
    page, n = folder / f"{slug}.md", 2
    while page.exists() or page.with_suffix("").exists():
        page, n = folder / f"{slug}-{n}.md", n + 1
    page.write_text(serialize_frontmatter({"kind": kind, "title": name, **({"prompt": desc} if desc else {})}, f"# {name}\n\nMade in Node Studio.\n"), encoding="utf-8")
    return page


def save_to_project(ws_dir: Path, node: dict[str, Any], values: list[Value], by_origin: dict[str, Any]) -> list[dict[str, Any]]:
    """One asset per idea, with everything made for it. Saving again adds to the same asset instead of making another."""
    rows: dict[str, list[Value]] = {}
    for v in values:
        if v.get("path"):
            rows.setdefault(v.get("origin") or v["path"], []).append(v)
    if not rows:
        raise ValueError("There was nothing to save.")
    wanted = str(node["fields"].get("name") or "").strip()
    assets = []
    for index, (origin, items) in enumerate(rows.items(), start=1):
        files = [x for v in items for x in [*(v.get("from") or []), v]]
        surface = any(v["t"] == "surface" for v in items)
        kind = "material" if surface else next((v["kind"] for v in items if v.get("kind")), "") or ("prop" if any(x["t"] == "model" for x in files) else "item")
        name = (wanted if len(rows) == 1 else f"{wanted} {index}") if wanted else next((v["name"] for v in items if v.get("name")), "Asset")
        known = by_origin.get(origin) or {}
        page = resolve_rel(ws_dir, known["asset"]) if known.get("asset") else None
        if page is None or not page.is_file():
            page = _new_page(ws_dir, str(node["fields"].get("section") or ""), kind, name, next((v["desc"] for v in items if v.get("desc")), ""))
        rel = rel_to(ws_dir, page)
        meta: dict[str, Any] = {}
        placed: dict[str, str] = {}
        winner = ""
        for x in files:
            if x["t"] == "surface":
                continue  # rebuilt on the saved asset below
            # A pixel sprite's full drawing is the candidate; its sprite is made from it, as in Pixel Studio.
            placed[x["path"]] = _copy_in(ws_dir, x.get("raw") or x["path"], page, x.get("folder") or "candidates")
            if x["t"] == "picture" and x.get("folder") in ("candidates", "edits") or x["t"] == "sound" and not winner:
                winner = placed[x["path"]]
            if x["t"] == "rig" and x.get("rig"):
                meta.update({**x["rig"], "rig_model": placed[x["path"]]})
        current = asset_studio.read_asset(ws_dir, rel)[1]
        loose = {v["path"] for v in items if v["t"] == "picture" and v.get("folder") == "candidates"}
        if len(loose) > 1 and all(v["t"] == "picture" for v in items):
            winner = ""  # several options and nothing chosen: the user picks on the asset page, as after any generation
        if winner and current.get("winner") in (None, "", known.get("winner")):
            meta["winner"] = winner  # never over a picture the user picked themselves
        pixel = next((x for x in reversed(files) if x.get("pixel")), None)
        if pixel:
            from forge import pixel_engine, sprites

            o = pixel_engine.defaults(pixel["pixel"])
            meta.update(pixel=o, aspect="1:1")
            for x in files:
                if x.get("pixel"):
                    pixel_engine.snap_candidate(ws_dir, rel, placed[x["path"]], o)
            if len(loose) <= 1 and not sprites.list_sets(ws_dir, rel):
                made = sprites.create_set(ws_dir, rel, placed[pixel["path"]], name="main", canvas=o["canvas"], palette=o["palette"],
                                          outline=o["outline"] != "none", fill=o["kind"] == "tile")
                meta["winner"] = f"{made['folder']}/ref.png"
        if meta:
            asset_studio.update_asset(ws_dir, rel, meta)
        if surface:
            from forge import modular

            modular.build_material(ws_dir, rel)
        current = asset_studio.read_asset(ws_dir, rel)[1]
        by_origin[origin] = {"asset": rel, "winner": str(current.get("winner") or "")}
        thumb = next((v.get("thumb") or v["path"] for v in reversed(items) if v.get("thumb") or v["t"] in ("picture", "surface")), "")
        assets.append({"asset": rel, "name": str(current.get("title") or name), "thumb": thumb})
    return assets
