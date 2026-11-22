"""`tessera/ASSETS.md` and `tessera/ASSETS.json`: every asset of the project and its finished files, for the game's coding agent.

The coding agent never manages the workspace. It reads this index, copies the files it needs into the game's own
folders, and leaves `tessera/` alone. Tessera rewrites both files whenever the workspace changes. Next to the files the
index says how to place each model: its real height and the scale that gives it, which way its front faces, and
named points (where it stands, where a lantern hangs, where a hand grips). The one file in `tessera/` the coding agent
may write is `tessera/REQUESTS.md`, its list of what it still needs; Tessera shows that list to the user.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from forge.layout import GAME_FOLDERS, Layout

INDEX_NAME = "ASSETS.md"
JSON_NAME = "ASSETS.json"
REQUESTS_NAME = "REQUESTS.md"


def index_path(ws_dir: Path) -> Path:
    return ws_dir.parent / INDEX_NAME


def json_path(ws_dir: Path) -> Path:
    return ws_dir.parent / JSON_NAME


def requests_path(ws_dir: Path) -> Path:
    return ws_dir.parent / REQUESTS_NAME


GAME_SIZE_PX = 1024
GAME_SIZE_DIR = "game"  # inside the project's export folder (forge.layout)
ICON_PX = 256
ICON_DIR = "icons"
# Kinds that are a thing you could hold, place or meet: they get an inventory-style icon.
ICON_KINDS = ("item", "weapon", "prop", "character", "creature", "vehicle")
SOUND_KINDS = ("sfx", "voice", "music")
# Kinds that never get a 3D model: "not made yet" in the model column would send the reader after art that never comes.
NO_MODEL_KINDS = ("sfx", "voice", "music", "material", "ui")


def _game_size_copy(ws_dir: Path, winner: str, rel: str) -> str:
    """A copy of the picked image no bigger than GAME_SIZE_PX, for games that don't want 3 MB textures.

    Returns its path relative to the project folder (the game's tessera/ folder), or "" when the original is
    already small, isn't an image Pillow can read, or the copy can't be written. The original is never touched.
    """
    source = ws_dir / winner
    if not winner or source.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp") or not source.is_file():
        return ""
    target = Layout.of_art(ws_dir).export / GAME_SIZE_DIR / f"{Path(rel).with_suffix('').as_posix()}.png"
    try:
        from PIL import Image

        if target.is_file() and target.stat().st_mtime >= source.stat().st_mtime:
            return target.relative_to(ws_dir.parent).as_posix()
        with Image.open(source) as img:
            if max(img.size) <= GAME_SIZE_PX and source.stat().st_size < 600_000:
                return ""
            img.thumbnail((GAME_SIZE_PX, GAME_SIZE_PX), Image.LANCZOS)
            target.parent.mkdir(parents=True, exist_ok=True)
            img.save(target, optimize=True)
        return target.relative_to(ws_dir.parent).as_posix()
    except Exception:  # noqa: BLE001 — a bad image must never stop the index from being written
        return ""


def _icon_copy(ws_dir: Path, source_rel: str, rel: str) -> str:
    """A square, transparent, tightly cropped ICON_PX icon of the asset, for inventories and menus.

    Made from the model's preview when there is one (the same three-quarter camera for every model, so a set of
    icons matches), else from the picked image. Kept in the export folder's icons/, remade only when its source changes.
    """
    source = ws_dir / source_rel
    if not source_rel or source.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp") or not source.is_file():
        return ""
    target = Layout.of_art(ws_dir).export / ICON_DIR / f"{Path(rel).with_suffix('').as_posix()}.png"
    try:
        if target.is_file() and target.stat().st_mtime >= source.stat().st_mtime:
            return target.relative_to(ws_dir.parent).as_posix()
        from PIL import Image

        from forge.game_tools import _foreground_mask, _knock_out_background

        with Image.open(source) as opened:
            image = opened.convert("RGBA")
        if image.getchannel("A").getextrema()[0] >= 250:
            image = _knock_out_background(image)
        bbox = _foreground_mask(image).getbbox()
        if not bbox:
            return ""
        subject = image.crop(bbox)
        side = int(max(subject.size) * 1.12)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(subject, ((side - subject.width) // 2, (side - subject.height) // 2), subject)
        target.parent.mkdir(parents=True, exist_ok=True)
        canvas.resize((ICON_PX, ICON_PX), Image.LANCZOS).save(target, optimize=True)
        return target.relative_to(ws_dir.parent).as_posix()
    except Exception:  # noqa: BLE001 — a bad image must never stop the index from being written
        return ""


def _float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


_SIZE_RE = re.compile(r"^\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*(m|metres|meters)?\s*$", re.I)


def size_height(value: Any) -> float | None:
    """The height from a page's `size: width x height x depth` line (metres), as Tess writes it."""
    match = _SIZE_RE.match(str(value or ""))
    return _float(match.group(2)) if match else None


def _placement(ws_dir: Path, meta: dict[str, Any], kind: str, model_rel: str) -> dict[str, Any] | None:
    """How to put the asset's model in the game: measured size, real height, scale, front and points."""
    from forge import model_info
    from forge.showcase import KIND_HEIGHT

    info = model_info.describe(ws_dir / model_rel) if model_rel else None
    if not info:
        return None
    height = _float(meta.get("height_m"))
    height_source = "set in Tessera"
    if not height:
        height = size_height(meta.get("size"))
        height_source = "from the page's size line, not checked"
    if not height:
        height, height_source = KIND_HEIGHT.get(kind, 1.0), "default for its kind, not checked"
    try:
        front = model_info.clean_front(meta["front"]) if meta.get("front") else ""
    except ValueError:
        front = ""
    front_source = "set in Tessera" if front else "glTF default, not checked"
    points = dict(info["auto_points"])
    stale = False
    saved = meta.get("points") if isinstance(meta.get("points"), dict) else {}
    if saved:
        try:
            clean = model_info.clean_points(saved)
        except (TypeError, ValueError):
            clean = {}
        # Points clicked on an older model would land in the wrong place on a new one.
        if str(meta.get("points_for") or model_rel) == model_rel:
            points.update(clean)
        else:
            stale = bool(clean)
    model_height = info["size"][1]
    return {
        "model_size": info["size"],
        "height_m": round(height, 3),
        "height_source": height_source,
        "scale": round(height / model_height, 4) if model_height > 0 else 1.0,
        "front": front or model_info.DEFAULT_FRONT,
        "front_source": front_source,
        "points": points,
        "points_stale": stale,
    }


def _animations(ws_dir: Path, meta: dict[str, Any], outputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from forge import model_info, motion

    overrides = meta.get("anim_loops") if isinstance(meta.get("anim_loops"), dict) else {}
    clips = []
    for out in outputs:
        if out.get("type") != "model":
            continue
        stem = Path(out["path"]).stem
        info = model_info.describe(ws_dir / out["path"]) or {}
        seconds = max((c["seconds"] for c in info.get("clips") or []), default=0.0)
        if stem in overrides:
            loop, source = bool(overrides[stem]), "set in Tessera"
        else:
            loop, source = model_info.guess_loop(stem), "guessed from the name"
        clip = {"path": out["path"], "name": stem, "loop": loop, "loop_source": source if loop is not None else "not set", "seconds": seconds}
        baked = motion.baked_info(ws_dir / out["path"])
        if baked:  # made in Motion Studio: it knows the loop, how fast the root travels and the frame events
            if stem not in overrides:
                clip.update(loop=bool(baked.get("loop")), loop_source="set in Motion Studio")
            clip.update(root_speed=float(baked.get("root_speed") or 0), events=[e for e in baked.get("events") or [] if isinstance(e, dict) and e.get("name")])
        clips.append(clip)
    return clips


def _rows(ws_dir: Path) -> list[dict[str, Any]]:
    from forge import model_info
    from forge.asset_studio import assets_under, list_outputs, output_history, read_asset

    rows = []
    for rel in assets_under(ws_dir):
        try:
            path, meta, _ = read_asset(ws_dir, rel)
        except (OSError, ValueError):
            continue
        outputs = list_outputs(ws_dir, path)
        kind = str(meta.get("kind") or "")
        first = lambda key: next((o for o in outputs[key] if o["type"] == "model"), None)  # noqa: E731
        model_entry = (next((o for o in outputs["3d"] if o["type"] == "model" and Path(o["path"]).stem == path.stem), None)
                       if kind == "kit" else first("3d"))
        model = model_entry["path"] if model_entry else ""
        rig_entry = first("rig")
        rig_info = model_info.describe(ws_dir / rig_entry["path"]) if rig_entry else None
        winner = str(meta.get("winner") or "")
        icon_source = (model_entry or {}).get("thumb") or (winner if Path(winner).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp") else "")
        # Demo mode's placeholders look like finished files; the coding agent must not ship them as the game's art.
        demo_made = {f for f, h in output_history(ws_dir, rel).items() if h.get("provider") == "demo"}
        demo = [k for k, f in (("picked", winner), ("model", model)) if f and f in demo_made]
        if rig_entry and meta.get("rig_provider") == "demo":
            demo += ["rig", "animations"]
        rows.append({
            "rel": rel,
            "title": str(meta.get("title") or path.stem.replace("-", " ").replace("_", " ").title()),
            "kind": kind,
            "winner": winner,
            "takes": len(outputs["audio"]) if kind in SOUND_KINDS else 0,
            "candidates": sum(1 for o in outputs["candidates"] if o["type"] == "image"),
            "thumb": (model_entry or {}).get("thumb") or "",
            "preview": next((o["path"] for o in outputs["candidates"] if o["type"] == "image"), ""),
            "model": model,
            "kit_dir": f"{Path(rel).with_suffix('').as_posix()}/3d/" if kind == "kit" and outputs["3d"] else "",
            "maps_dir": f"{Path(rel).with_suffix('').as_posix()}/textures/" if kind == "material" and outputs["textures"] else "",
            "small": _game_size_copy(ws_dir, winner, rel) if kind not in ("kit", "material") else "",
            "icon": _icon_copy(ws_dir, icon_source, rel) if kind in ICON_KINDS else "",
            "icons_dir": f"{Path(rel).with_suffix('').as_posix()}/icons/" if outputs["icons"] else "",
            "placement": _placement(ws_dir, meta, kind, model) if kind != "kit" else None,
            "rig": rig_entry["path"] if rig_entry else "",
            "rig_info": {"size": rig_info["size"], "points": {**rig_info["auto_points"], **rig_info["bone_points"]}} if rig_info else None,
            "animations": _animations(ws_dir, meta, outputs["animations"]),
            "anim_dir": f"{Path(rel).with_suffix('').as_posix()}/animations/",
            "sprites": _sprite_sets(ws_dir, path),
            "demo": demo,
        })
    return rows


def _sprite_sets(ws_dir: Path, page: Path) -> list[dict[str, Any]]:
    """Pixel Studio sets next to the asset: frame size, fps, directions, loop, and the exported sheet if any."""
    root = page.with_suffix("") / "sprites"
    if not root.is_dir():
        return []
    sets = []
    for folder in sorted(root.iterdir()):
        try:
            data = json.loads((folder / "sprite.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rel = folder.relative_to(ws_dir).as_posix()
        sets.append({
            "name": folder.name, "dir": f"{rel}/", "frame_px": data.get("canvas"), "directions": data.get("directions", []),
            "animations": {n: {"fps": a.get("fps"), "loop": a.get("loop"), "frames": max((len(v) for v in a.get("frames", {}).values()), default=0)}
                           for n, a in data.get("animations", {}).items() if n != "base"},
            "sheet": f"{rel}/sheet.png" if (folder / "sheet.png").is_file() else "",
            "aseprite": f"{rel}/sheet.json" if (folder / "sheet.json").is_file() else "",
            "godot": f"{rel}/{folder.name}.tres" if (folder / f"{folder.name}.tres").is_file() else "",
        })
    return sets


def _num(value: float) -> str:
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def _xyz(p: list[float]) -> str:
    return f"({', '.join(_num(v) for v in p)})"


def _placement_cell(p: dict[str, Any] | None) -> str:
    if not p:
        return "—"
    parts = [
        f"{_num(p['height_m'])} m tall ({p['height_source']})",
        f"scale ×{_num(p['scale'])}",
        f"front {p['front']} ({p['front_source']})",
        "points " + ", ".join(f"{name} {_xyz(xyz)}" for name, xyz in p["points"].items()),
    ]
    if p["points_stale"]:
        parts.append("points were placed on an older model: ask the user to place them again in Tessera")
    return " · ".join(parts)


def _clip_text(clip: dict[str, Any]) -> str:
    how = {True: "loop", False: "once", None: "loop or once not set"}[clip["loop"]]
    seconds = f", {_num(clip['seconds'])} s" if clip["seconds"] else ""
    speed = f", root moves {_num(clip['root_speed'])} m/s" if clip.get("root_speed") else ""
    events = clip.get("events") or []
    marks = ", events: " + ", ".join(e["name"] + " @ " + _num(float(e.get("time") or 0)) + " s" for e in events) if events else ""
    return f"{clip['name']} ({how}{seconds}{speed}{marks})"


def _prefixes(ws_dir: Path) -> tuple[str, str]:
    # Paths are written from the game folder when the project lives in it (<game>/tessera/art, or <game>/glob/workspace
    # for a project not upgraded yet).
    home = ws_dir.parent.name
    in_game = home in GAME_FOLDERS
    return (f"{home}/{ws_dir.name}/" if in_game else f"{ws_dir.name}/", f"{home}/" if in_game else "")


DEMO_MARK = " (demo placeholder: keep your own placeholder until this is remade)"


def render(ws_dir: Path, title: str = "", rows: list[dict[str, Any]] | None = None, link: dict[str, Any] | None = None) -> str:
    """The index as Markdown. `link` is a `live_link.snapshot`: with it, copies in the game that are out of date are listed."""
    from forge.overview import humanize

    prefix, game_prefix = _prefixes(ws_dir)
    rows = _rows(ws_dir) if rows is None else rows
    done = sum(1 for r in rows if r["winner"] or r["model"])
    lines = [
        f"# {title.replace('_', ' ') + ': ' if title else ''}game art from Tessera",
        "",
        "Written by Tessera, the asset studio where this game's art is made. Tessera rewrites this file whenever the art changes.",
        "",
        "- Copy the files you need into the game's own asset folders, then use the copies.",
        f"- Tessera's picked images are full size (often 1-3 MB). Where a lighter copy exists it is listed under Other files as \"game-size copy\" ({GAME_SIZE_PX}px max): prefer it. Never resize the originals.",
        f"- Icons: \"icon\" under Other files is a {ICON_PX}px square, transparent and tightly cropped, made the same way for every asset so a set matches. Use it for inventories and menus.",
        "- Don't edit, move or delete anything inside `tessera/`: it is the user's Tessera workspace. The one exception is `tessera/REQUESTS.md` (below).",
        "- Art that isn't made yet: keep a placeholder and add it to `tessera/REQUESTS.md`. The user makes it in Tessera.",
        "- A 3D game whose asset only has a picked image (no 3D model yet): show that image as a flat sprite or camera-facing billboard now, and swap in the model when its row gets one. The image is a reference sheet, not the final look in the game.",
        "- Sounds have no 3D model: \"sound ready\" means the picked sound is the file to use.",
        f"- Paths are relative to the game folder. {done} of {len(rows)} assets have finished files.",
        "",
        "## Placing models",
        "",
        "- **Height** is the model's real size in the game, in metres. Import the model, then multiply its scale by **scale** to get that height. \"set in Tessera\" means the user chose it; \"not checked\" is a default, so look at it in the game.",
        "- **Front** is the direction the model's front faces in its own axes (Y is up). Turn the model so that axis points where its front should face.",
        "- **Points** are in the model's own units, as imported, before you scale it: scale and turn them with the model. `ground` is the middle of its base (stand it there) and `top` the middle of its top. Other points were placed by the user, for example `light` (where a lantern hangs), `grip` (where a hand holds it) or `muzzle`. A rig lists the bones it found: `head`, `hand_l`, `hand_r`, `foot_l`, `foot_r`.",
        "- **Animations** say whether each clip loops or plays once, and how long it is. Clips made in Motion Studio hold one animation named like the file, and also give the root's travel speed in m/s (move the character at that speed so its feet don't slide) and frame events as `name @ seconds` (fire sounds, hitboxes and effects at those times).",
        f"- The same data, ready to read in code: `{game_prefix}{JSON_NAME}`.",
        "",
        "## Asking for art",
        "",
        f"Write what's missing or needs changing to `{game_prefix}{REQUESTS_NAME}`, one line per request, as a checklist. Tessera shows the list to the user, who decides what gets made. Be specific about size, front and points, for example:",
        "",
        "```markdown",
        "- [ ] Stone Altar: new prop, 2.5 m tall, front +Z, point `offering` on top",
        "- [ ] Crewmate: taller and slimmer, about 1.8 m",
        "- [ ] Lantern Post: add point `light` where the lantern hangs",
        "```",
        "",
        "Tick a line (`- [x]`) once its art shows up here.",
    ]
    if link:
        from forge import live_link

        stale = live_link.out_of_date(link)
        if stale:
            lines += [
                "", "## Copies in the game that are out of date", "",
                "Tessera compared the game's files with its own. These are older versions of art that has changed since: copy the new file over each one.",
                "", "| File in the game | Asset | Copy this over it |", "|---|---|---|",
            ]
            lines += [f"| `{s['game_file']}` | {s['asset']} ({s['what'][:1].lower() + s['what'][1:]}) | `{s['replace_with']}` |" for s in stale]
    sections: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        top = row["rel"].split("/")[0] if "/" in row["rel"] else ""
        sections.setdefault(top, []).append(row)
    for top, items in sections.items():
        lines += ["", f"## {humanize(top) if top else 'Project'}", "",
                  "| Asset | Kind | Picked image or sound | 3D model | Size and placement | Other files |", "|---|---|---|---|---|---|"]
        for r in items:
            cell = lambda p: f"`{prefix}{p}`" if p else "not made yet"  # noqa: E731
            extra = []
            if r["rig"]:
                rig = f"rig `{prefix}{r['rig']}`"
                if r["rig_info"]:
                    rig += f" ({_num(r['rig_info']['size'][1])} units tall; points {', '.join(f'{n} {_xyz(p)}' for n, p in r['rig_info']['points'].items())})"
                extra.append(rig)
            if r["small"]:
                extra.append(f"game-size copy ({GAME_SIZE_PX}px max, lighter) `{game_prefix}{r['small']}`")
            if r["icon"]:
                extra.append(f"icon ({ICON_PX}px, transparent) `{game_prefix}{r['icon']}`")
            if r["icons_dir"]:
                extra.append(f"more icon sizes in `{prefix}{r['icons_dir']}`")
            if r["animations"]:
                count = len(r["animations"])
                extra.append(f"{count} clip{'s' if count != 1 else ''} in `{prefix}{r['anim_dir']}`: {', '.join(_clip_text(c) for c in r['animations'])}")
            for s in r.get("sprites") or []:
                anims = ", ".join(f"{n} {a['frames']}f@{a['fps']}fps{' loop' if a['loop'] else ' once'}" for n, a in s["animations"].items()) or "still only"
                where = f"sheet `{prefix}{s['sheet']}` + Aseprite `{prefix}{s['aseprite']}` + Godot `{prefix}{s['godot']}`" if s["sheet"] else f"frames in `{prefix}{s['dir']}` (not exported yet)"
                extra.append(f"pixel sprites '{s['name']}' {s['frame_px']}px, facing {'/'.join(s['directions'])}: {anims}; {where}")
            if r["kit_dir"]:
                extra.append(f"modular kit: read `{prefix}{r['kit_dir']}kit.json` for how the pieces fit")
            if r["maps_dir"]:
                extra.append(f"tiling maps (albedo, normal, roughness, height, orm) in `{prefix}{r['maps_dir']}`")
            if r["kind"] == "kit":
                picture = "—"
            elif r["kind"] in SOUND_KINDS:
                picture = (f"sound ready `{prefix}{r['winner']}`" if r["winner"]
                           else f"{r['takes']} take{'s' if r['takes'] != 1 else ''}, none picked yet" if r["takes"] else "not made yet")
            else:
                picture = cell(r["winner"])
            model = cell(r["model"]) if r["model"] or r["kind"] not in NO_MODEL_KINDS else "—"
            demo = r.get("demo") or []
            if "picked" in demo:
                picture += DEMO_MARK
            if "model" in demo:
                model += DEMO_MARK
            if "rig" in demo:
                extra = [e + DEMO_MARK if e.startswith(("rig ", f"{len(r['animations'])} clip")) else e for e in extra]
            lines.append(f"| {r['title']} | {r['kind']} | {picture} | {model} | {_placement_cell(r['placement'])} | {', '.join(extra) or '—'} |")
    return "\n".join(lines) + "\n"


def render_json(ws_dir: Path, title: str = "", rows: list[dict[str, Any]] | None = None, link: dict[str, Any] | None = None) -> str:
    prefix, game_prefix = _prefixes(ws_dir)
    rows = _rows(ws_dir) if rows is None else rows
    at = lambda p: f"{prefix}{p}" if p else ""  # noqa: E731
    # Copies of each asset found in the game folder, when the game is linked: "current", "stale" (an older version) or "edited".
    in_game = {a["path"]: [{"file": c["file"], "of": f["path"], "state": c["state"]} for f in a["files"] for c in f["copies"]]
               + [{"file": name, "of": "", "state": "edited"} for name in a["edited"]]
               for a in (link or {}).get("assets", [])}
    assets = []
    for r in rows:
        assets.append({
            "asset": r["rel"],
            "title": r["title"],
            "kind": r["kind"],
            "picked": at(r["winner"]),
            "sound_ready": bool(r["winner"]) if r["kind"] in SOUND_KINDS else None,
            "model": at(r["model"]),
            "placement": r["placement"],
            "rig": {"path": at(r["rig"]), **(r["rig_info"] or {})} if r["rig"] else None,
            "animations": [{**c, "path": at(c["path"])} for c in r["animations"]],
            "game_size_copy": f"{game_prefix}{r['small']}" if r["small"] else "",
            "icon": f"{game_prefix}{r['icon']}" if r["icon"] else "",
            "kit": f"{prefix}{r['kit_dir']}kit.json" if r["kit_dir"] else "",
            "material_maps": at(r["maps_dir"]),
            "demo_placeholders": r.get("demo") or [],
            "sprites": [{**s, "dir": at(s["dir"]), "sheet": at(s["sheet"]), "aseprite": at(s["aseprite"]), "godot": at(s["godot"])} for s in r.get("sprites") or []],
            **({"in_game": in_game.get(r["rel"], [])} if link and link["game"]["linked"] else {}),
        })
    data = {
        "title": title,
        "written_by": "Tessera Studio",
        "units": "Points and model_size are in the model's own units and axes (Y up). Multiply by placement.scale for metres.",
        "requests_file": f"{game_prefix}{REQUESTS_NAME}",
        "assets": assets,
    }
    return json.dumps(data, indent=1, ensure_ascii=False) + "\n"


def _write_if_changed(target: Path, text: str) -> bool:
    try:
        if target.is_file() and target.read_text(encoding="utf-8") == text:
            return True
        target.write_text(text, encoding="utf-8")
    except OSError:
        return False
    return True


def write(ws_dir: Path, title: str = "", game: Path | None = None, rows: list[dict[str, Any]] | None = None) -> Path | None:
    """Rewrite the index (and its JSON twin) when it changed. None when the workspace doesn't exist.

    `game` is the linked game folder when the caller knows it; otherwise it is found from where the project lives."""
    if not ws_dir.is_dir():
        return None
    rows = _rows(ws_dir) if rows is None else rows
    link = None
    try:
        from forge import live_link

        link = live_link.snapshot(ws_dir, game, rows)
    except Exception:  # noqa: BLE001 — the game folder can be anything; the index is written either way
        link = None
    target = index_path(ws_dir)
    if not _write_if_changed(target, render(ws_dir, title, rows, link)):
        return None
    _write_if_changed(json_path(ws_dir), render_json(ws_dir, title, rows, link))
    return target


# ---------- tessera/REQUESTS.md: the coding agent's list of what it still needs ----------

_ITEM_RE = re.compile(r"^\s*[-*+]\s+(?:\[(?P<mark>[ xX])\]\s+)?(?P<text>.+?)\s*$")


def read_requests(ws_dir: Path) -> dict[str, Any]:
    """The requests the game's coding agent wrote to tessera/REQUESTS.md: open ones first, then done ones."""
    path = requests_path(ws_dir)
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")[:100_000]
    except OSError:
        return {"path": REQUESTS_NAME, "exists": False, "open": [], "done": []}
    open_items, done_items = [], []
    for line in text.splitlines():
        match = _ITEM_RE.match(line)
        if not match:
            continue
        item = match.group("text")[:500]
        (done_items if (match.group("mark") or " ").lower() == "x" else open_items).append(item)
    return {"path": REQUESTS_NAME, "exists": True, "open": open_items[:200], "done": done_items[:200]}
