"""Drag and drop into a project: files, folders, .zip packs, pictures dragged from a web page, and pastes.

A drop is staged first in ``.studio/drops/<id>/`` (zips unpacked there), then turned into a plan: one row per
asset to make or fill. A row joins the files that belong together: frames of one animation (``run_01.png``,
``run_02.png``), a model with its textures, and a preview picture named like its model. Each row is matched to an
existing asset with exactly the same name, or proposes a new one with a kind and a folder. Dropped on a section, the
section decides the folder and the kind. Tess can look at the files and fill in names, kinds and folders
(:func:`tess_sort`). Applying the plan writes the assets and keeps an undo record, so one Undo takes it all back.

Nothing is generated and no credits are spent: this only copies the user's own files into the workspace.
"""

from __future__ import annotations

import base64
import io
import json
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from forge import asset_studio, game_tools
from forge.asset_studio import ASSET_KINDS, AUDIO_KINDS, AUDIO_SUFFIXES, output_dir, read_asset, update_asset
from forge.blueprint_contract import serialize_frontmatter
from forge.game_import import clean_title
from forge.layout import Layout
from forge.overview import IMAGE_SUFFIXES, MODEL_SUFFIXES, move_to_trash, resolve_rel, slugify

MAX_FILE_BYTES = 200 * 1024 * 1024
MAX_DROP_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILES = 2000
KEEP_SECONDS = 24 * 3600
SIDECAR_SUFFIXES = {".bin", ".mtl"}
TEXTURE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".tga", ".bmp"}
# Things a pack carries that are never art: licences, engine metadata, OS clutter.
SKIP_NAMES = {"thumbs.db", "desktop.ini", ".ds_store"}
SKIP_SUFFIXES = {".import", ".meta", ".uid", ".tmp", ".txt", ".md", ".url", ".html", ".pdf", ".json", ".xml", ".ini", ".psd", ".kra", ".aseprite", ".blend", ".blend1"}
# A texture map's name ends in what it is (knight_normal.png); it belongs to a model, not to a new asset.
TEXTURE_WORDS = {"normal", "normals", "nrm", "roughness", "rough", "metallic", "metalness", "metal", "ao", "occlusion", "basecolor",
                 "base", "albedo", "diffuse", "emissive", "emission", "height", "displacement", "orm", "specular", "gloss", "opacity", "mask",
                 "colormap", "texture", "textures", "atlas", "palette", "tex", "uv"}
# A picture named like this shows the model; it is the asset's picture, not a texture.
PREVIEW_WORDS = {"preview", "previews", "thumb", "thumbnail", "render", "renders", "screenshot", "icon"}
FRAME_RE = re.compile(r"^(.*?)[\s_\-.]*\(?(\d{1,4})\)?$")

# Words in a file's name or folders that say what it is. The first kind that matches wins.
KIND_WORDS: list[tuple[str, tuple[str, ...]]] = [
    ("music", ("music", "theme", "bgm", "soundtrack", "ost", "ambience", "ambient")),
    ("voice", ("voice", "vo", "dialog", "dialogue", "line", "bark")),
    ("sfx", ("sfx", "sound", "sounds", "hit", "click", "footstep", "whoosh", "impact")),
    ("ui", ("ui", "hud", "icon", "icons", "button", "buttons", "cursor", "panel", "menu", "gui")),
    ("weapon", ("weapon", "weapons", "sword", "axe", "bow", "dagger", "spear", "gun", "rifle", "pistol", "staff", "hammer", "shield")),
    ("item", ("item", "items", "potion", "coin", "gem", "key", "loot", "pickup", "food", "scroll", "ring", "amulet")),
    ("creature", ("creature", "creatures", "enemy", "enemies", "monster", "monsters", "mob", "slime", "goblin", "skeleton", "zombie", "beast", "boss", "dragon")),
    ("character", ("character", "characters", "hero", "heroes", "player", "npc", "npcs", "knight", "wizard", "mage", "rogue", "villager", "portrait")),
    ("vehicle", ("vehicle", "vehicles", "car", "cart", "ship", "boat", "tank", "plane")),
    ("vfx", ("vfx", "fx", "effect", "effects", "particle", "particles", "spark", "sparks", "smoke", "explosion", "slash")),
    ("environment", ("environment", "environments", "background", "backgrounds", "bg", "tile", "tiles", "tileset", "terrain", "parallax", "sky", "landscape")),
    ("prop", ("prop", "props", "furniture", "barrel", "crate", "chest", "table", "chair", "door", "torch", "rock", "tree", "bush")),
]


def _drops_root(ws_dir: Path) -> Path:
    return Layout.of_art(ws_dir).studio / "drops"


def _drop_dir(ws_dir: Path, drop_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", drop_id or ""):
        raise ValueError("Unknown drop.")
    return _drops_root(ws_dir) / drop_id


def file_type(name: str) -> str:
    suffix = PurePosixPath(name).suffix.lower()
    if suffix in MODEL_SUFFIXES:
        return "model"
    if suffix in AUDIO_SUFFIXES:
        return "audio"
    if suffix in IMAGE_SUFFIXES or suffix in TEXTURE_SUFFIXES:
        return "image"
    if suffix in SIDECAR_SUFFIXES:
        return "sidecar"
    return "other"


def _clean_rel(name: str) -> str:
    """A dropped file's path inside the drop: forward slashes, no drive, no '..', no hidden parts."""
    parts = [p for p in re.split(r"[\\/]+", str(name or "")) if p and p not in (".", "..") and not re.fullmatch(r"[A-Za-z]:", p)]
    parts = [re.sub(r'[\x00-\x1f<>:"|?*]', "_", p)[:120] for p in parts]
    return "/".join(parts) or "file"


def _skipped(rel: str) -> str:
    """Why a file in a drop is left out, or '' when it is kept."""
    path = PurePosixPath(rel)
    if any(part.startswith(".") or part == "__MACOSX" for part in path.parts) or path.name.lower() in SKIP_NAMES:
        return "hidden"
    if path.suffix.lower() in SKIP_SUFFIXES:
        return "not art"
    if file_type(rel) == "other" and path.suffix.lower() != ".zip":
        return "not art"
    return ""


def cleanup(ws_dir: Path) -> None:
    """Forget drops nobody applied within a day."""
    root = _drops_root(ws_dir)
    if not root.is_dir():
        return
    for folder in root.iterdir():
        try:
            if folder.is_dir() and time.time() - folder.stat().st_mtime > KEEP_SECONDS:
                shutil.rmtree(folder, ignore_errors=True)
        except OSError:
            continue


def _manifest(folder: Path) -> dict[str, Any]:
    try:
        return json.loads((folder / "drop.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"files": [], "skipped": [], "bytes": 0, "created": time.time()}


def _save_manifest(folder: Path, data: dict[str, Any]) -> None:
    (folder / "drop.json").write_text(json.dumps(data, indent=1), encoding="utf-8")


def _unique_rel(files: list[str], rel: str) -> str:
    if rel not in files:
        return rel
    path = PurePosixPath(rel)
    n = 2
    while (candidate := str(path.with_name(f"{path.stem}-{n}{path.suffix}"))) in files:
        n += 1
    return candidate


def stage(ws_dir: Path, uploads: list[tuple[str, bytes]], drop_id: str = "") -> dict[str, Any]:
    """Add files to a drop (a new one unless ``drop_id`` names one). Zips are unpacked, keeping their folders.
    Returns the drop's id, its kept files and what was skipped and why."""
    cleanup(ws_dir)
    drop_id = drop_id or uuid.uuid4().hex[:12]
    folder = _drop_dir(ws_dir, drop_id)
    (folder / "files").mkdir(parents=True, exist_ok=True)
    data = _manifest(folder)

    def keep(rel: str, payload: bytes) -> None:
        rel = _clean_rel(rel)
        reason = _skipped(rel)
        if not reason and len(payload) > MAX_FILE_BYTES:
            reason = "over 200 MB"
        if not reason and data["bytes"] + len(payload) > MAX_DROP_BYTES:
            reason = "the drop is over 2 GB"
        if not reason and len(data["files"]) >= MAX_FILES:
            reason = f"more than {MAX_FILES} files"
        if reason:
            data["skipped"].append({"name": rel, "why": reason})
            return
        if PurePosixPath(rel).suffix.lower() == ".zip":
            return unzip(rel, payload)
        rel = _unique_rel(data["files"], rel)
        target = folder / "files" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        data["files"].append(rel)
        data["bytes"] += len(payload)

    def unzip(rel: str, payload: bytes) -> None:
        base = str(PurePosixPath(rel).with_suffix(""))
        try:
            archive = zipfile.ZipFile(io.BytesIO(payload))
        except zipfile.BadZipFile:
            data["skipped"].append({"name": rel, "why": "not a readable zip"})
            return
        with archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                if info.file_size > MAX_FILE_BYTES:
                    data["skipped"].append({"name": f"{base}/{info.filename}", "why": "over 200 MB"})
                    continue
                inner = f"{base}/{info.filename}"
                if PurePosixPath(info.filename).suffix.lower() == ".zip":
                    data["skipped"].append({"name": inner, "why": "a zip inside a zip"})
                    continue
                keep(inner, archive.read(info))

    for name, payload in uploads:
        keep(name, payload)
    _save_manifest(folder, data)
    return {"id": drop_id, "files": data["files"], "skipped": data["skipped"]}


# ---------- the plan ----------

def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", clean_title(text).lower()))


def _frame_key(stem: str) -> tuple[str, int | None]:
    """'knight_run_03' → ('knight_run', 3). A name that is only a number keeps it."""
    match = FRAME_RE.match(stem)
    if match and match.group(1).strip(" _-."):
        return match.group(1).strip(" _-."), int(match.group(2))
    return stem, None


def _is_texture(rel: str) -> bool:
    words = set(re.findall(r"[a-z0-9]+", PurePosixPath(rel).stem.lower()))
    return bool(words & TEXTURE_WORDS)


def _is_preview(rel: str) -> bool:
    return bool(set(re.findall(r"[a-z]+", PurePosixPath(rel).stem.lower())) & PREVIEW_WORDS)


def _title_of(stem: str) -> str:
    """A file's name as an asset title, without the words that only say it is a preview."""
    kept = [w for w in re.split(r"[\s_\-.]+", stem) if w and w.lower() not in PREVIEW_WORDS]
    return clean_title("_".join(kept) or stem)


def _section_kind(folder: str) -> str:
    """The kind a section stands for, from its folder names: 03-characters/enemies → creature."""
    for part in reversed([p for p in folder.lower().split("/") if p]):
        word = re.sub(r"^\d+[-_ ]*", "", part)
        for kind, words in KIND_WORDS:
            if word in words or word.rstrip("s") == kind or word == kind:
                return kind
    return ""


def guess_kind(rel: str, ftype: str, folder: str = "") -> str:
    """A kind from the target folder, then the file's own folders and name, then what sort of file it is."""
    from_folder = _section_kind(folder)
    if from_folder and (ftype != "audio" or from_folder in AUDIO_KINDS):
        return from_folder
    words = re.findall(r"[a-z0-9]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", rel).lower())
    for kind, keys in KIND_WORDS:
        if (kind in AUDIO_KINDS) != (ftype == "audio"):
            continue
        if any(w in keys for w in words):
            return kind
    if ftype == "audio":
        return "sfx"
    return from_folder or "prop"


def _asset_index(ws_dir: Path) -> list[dict[str, Any]]:
    found = []
    for rel in asset_studio.assets_under(ws_dir):
        try:
            path, meta, body = read_asset(ws_dir, rel)
        except (OSError, ValueError):
            continue
        heading = next((line[2:].strip() for line in body.splitlines() if line.startswith("# ")), "")
        found.append({"path": rel, "title": heading or clean_title(path.stem), "kind": str(meta.get("kind") or ""),
                      "winner": str(meta.get("winner") or ""), "words": _words(path.stem) | (_words(heading) if heading else set())})
    return found


def _match(index: list[dict[str, Any]], title: str) -> str:
    """The one asset whose name has exactly the same words as the file's. A near match could be wrong, so it is left out."""
    words = _words(title)
    if not words:
        return ""
    same = [a["path"] for a in index if words == _words(a["title"]) or words == _words(PurePosixPath(a["path"]).stem)]
    return same[0] if len(same) == 1 else ""


def _sections(ws_dir: Path) -> list[dict[str, str]]:
    """Top-level folders and their direct sub-folders, as places a new asset can go."""
    out = []
    root = ws_dir.resolve()
    for top in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith((".", "_")) and p.name not in ("pillars",)):
        out.append({"path": top.name, "kind": _section_kind(top.name)})
        for sub in sorted(p for p in top.iterdir() if p.is_dir() and not p.name.startswith((".", "_")) and (p / "README.md").is_file()):
            out.append({"path": f"{top.name}/{sub.name}", "kind": _section_kind(f"{top.name}/{sub.name}")})
    return out


def _home_for(kind: str, sections: list[dict[str, str]], index: list[dict[str, Any]]) -> str:
    """Where a new asset of this kind goes: a section named for it, else where most assets of that kind live."""
    named = [s["path"] for s in sections if s["kind"] == kind]
    if named:
        return max(named, key=lambda p: p.count("/"))  # the most specific one: characters/enemies over characters
    counts: dict[str, int] = {}
    for a in index:
        if a["kind"] == kind:
            parent = str(PurePosixPath(a["path"]).parent)
            counts[parent] = counts.get(parent, 0) + 1
    if counts:
        return max(counts, key=lambda p: counts[p])
    return ""


DROP_FOLDER = "dropped-in"


def plan(ws_dir: Path, drop_id: str, target: str = "") -> dict[str, Any]:
    """Rows for a staged drop. ``target`` is the folder it was dropped on ('' for anywhere), or an asset page
    (``…/name.md``), in which case every file goes onto that asset."""
    folder = _drop_dir(ws_dir, drop_id)
    data = _manifest(folder)
    files = list(data["files"])
    index = _asset_index(ws_dir)
    sections = _sections(ws_dir)
    target = target.strip("/")
    onto_asset = target.endswith(".md")
    target_folder = "" if onto_asset else target

    # 1. Models take the textures and buffers next to them.
    models = [f for f in files if file_type(f) == "model"]
    taken: set[str] = set()
    model_rows: dict[str, dict[str, Any]] = {}
    shared: set[str] = set()
    for model in models:
        parent = str(PurePosixPath(model).parent)
        stem = PurePosixPath(model).stem.lower()
        siblings = [m for m in models if str(PurePosixPath(m).parent) == parent]
        others = [PurePosixPath(m).stem.lower() for m in siblings if m != model]
        mine = []
        for f in files:
            ftype = file_type(f)
            if f in taken or ftype not in ("sidecar", "image") or str(PurePosixPath(f).parent) != parent:
                continue
            fstem = PurePosixPath(f).stem.lower()
            if ftype == "image" and (_is_preview(f) or fstem == stem):
                continue  # the model's picture: grouped with it by name below
            texture = ftype == "sidecar" or _is_texture(f) or len(siblings) == 1
            if not texture:
                continue
            if fstem.startswith(stem) or len(siblings) == 1:
                mine.append(f)
            elif not any(fstem.startswith(o) for o in others):
                mine.append(f)  # a texture every model in the folder shares (Kenney's colormap.png)
                shared.add(f)
        taken.update(f for f in mine if f not in shared)
        taken.add(model)
        model_rows[model] = {"model": model, "textures": mine}
    taken.update(shared)

    # 2. Everything else groups by name: animation frames together, a preview picture with its model.
    groups: dict[str, dict[str, Any]] = {}
    order: list[str] = []

    def group_for(key: str, title: str, source: str) -> dict[str, Any]:
        if key not in groups:
            groups[key] = {"title": title, "files": [], "source": source}
            order.append(key)
        return groups[key]

    for model, row in model_rows.items():
        title = _title_of(PurePosixPath(model).stem)
        g = group_for(f"name:{slugify(title)}", title, model)
        g["files"] += [model, *row["textures"]]
    for f in files:
        if f in taken:
            continue
        ftype = file_type(f)
        if ftype in ("sidecar", "other"):
            continue
        path = PurePosixPath(f)
        base, frame = _frame_key(path.stem)
        title = _title_of(base if frame is not None else path.stem)
        key = f"name:{slugify(title)}"
        if ftype == "audio" and key in groups and any(file_type(x) != "audio" for x in groups[key]["files"]):
            key = f"audio:{key}"  # a sound named like a model is its own asset
        group_for(key, title, f)["files"].append(f)

    rows = []
    for n, key in enumerate(order, start=1):
        g = groups[key]
        types = [file_type(f) for f in g["files"]]
        main = "model" if "model" in types else "audio" if "audio" in types else "image"
        if onto_asset:
            match, kind, dest = target, "", str(PurePosixPath(target).parent)
        else:
            match = _match(index, g["title"])
            kind = guess_kind(g["source"], main, target_folder)
            dest = str(PurePosixPath(match).parent) if match else target_folder or _home_for(kind, sections, index) or DROP_FOLDER
            dest = "" if dest == "." else dest
        existing = next((a for a in index if a["path"] == match), None)
        rows.append({
            "id": n,
            "title": existing["title"] if existing else g["title"],
            "files": g["files"],
            "type": main,
            "counts": {t: types.count(t) for t in ("image", "model", "audio") if types.count(t)},
            "match": match,
            "kind": existing["kind"] if existing else kind,
            "folder": dest,
            "action": "add" if match else "new",
            "has_winner": bool(existing and existing["winner"]),
            "textures": [f for f in g["files"] if f in taken and file_type(f) != "model" and not (_is_preview(f) and file_type(f) == "image")],
        })
    sidecars_alone = [f for f in files if f not in taken and file_type(f) == "sidecar"]
    return {
        "id": drop_id,
        "target": target,
        "rows": rows,
        "skipped": data["skipped"] + [{"name": f, "why": "a model's file without its model"} for f in sidecars_alone],
        "sections": [s["path"] for s in sections],
        "kinds": list(ASSET_KINDS),
    }


def preview_path(ws_dir: Path, drop_id: str, rel: str) -> Path:
    """A staged file, for the review sheet's thumbnails."""
    folder = _drop_dir(ws_dir, drop_id) / "files"
    path = (folder / _clean_rel(rel)).resolve()
    if folder.resolve() not in path.parents or not path.is_file():
        raise FileNotFoundError(rel)
    return path


# ---------- Tess sorts it ----------

def _contact_sheet(ws_dir: Path, drop_id: str, rows: list[dict[str, Any]]) -> tuple[bytes, list[int]] | None:
    """One picture with every row's first image in a numbered cell, for Tess to look at."""
    from PIL import Image, ImageDraw

    cells = []
    for row in rows:
        image = next((f for f in row["files"] if file_type(f) == "image"), "")
        if image and PurePosixPath(image).suffix.lower() != ".svg":
            cells.append((row["id"], image))
    if not cells:
        return None
    cells = cells[:48]
    cols = min(8, len(cells))
    size = 160
    sheet = Image.new("RGB", (cols * size, ((len(cells) + cols - 1) // cols) * size), (40, 40, 46))
    draw = ImageDraw.Draw(sheet)
    for i, (row_id, rel) in enumerate(cells):
        x, y = (i % cols) * size, (i // cols) * size
        try:
            with Image.open(preview_path(ws_dir, drop_id, rel)) as img:
                img = img.convert("RGBA")
                img.thumbnail((size - 12, size - 30))
                sheet.paste(img, (x + (size - img.width) // 2, y + 24 + (size - 30 - img.height) // 2), img)
        except OSError:
            pass
        draw.rectangle((x, y, x + 30, y + 20), fill=(255, 0, 90))
        draw.text((x + 6, y + 4), str(row_id), fill=(255, 255, 255))
    buffer = io.BytesIO()
    sheet.save(buffer, "PNG")
    return buffer.getvalue(), [c[0] for c in cells]


async def tess_sort(ws_dir: Path, current: dict[str, Any], model_call: Any) -> dict[str, Any]:
    """Ask Tess's model to name each row, pick its kind and folder, and spot rows that are existing assets.
    Returns the plan with Tess's answers filled in (rows she skipped keep their guesses) and a note when she couldn't."""
    rows = current["rows"]
    if not rows:
        return {**current, "sorted_by": "names"}
    index = _asset_index(ws_dir)
    sheet = _contact_sheet(ws_dir, current["id"], rows)
    listing = "\n".join(f"{r['id']}. files: {', '.join(r['files'][:4])}{' …' if len(r['files']) > 4 else ''} (type: {r['type']})" for r in rows)
    assets = "\n".join(f"- {a['path']} ({a['kind']})" for a in index[:300]) or "(none yet)"
    prompt = (
        "The user dropped files into their game's asset studio. Sort each numbered row.\n"
        f"Rows:\n{listing}\n\n"
        f"Existing assets:\n{assets}\n\n"
        f"Folders: {', '.join(current['sections']) or '(none yet)'}\n"
        f"Kinds: {', '.join(ASSET_KINDS)}\n\n"
        + ("The picture shows the first image of the rows that have one, in cells numbered by row.\n" if sheet else "")
        + "For every row answer: a short title for a game asset list (2-4 words, Title Case, from what it shows, not the "
        "file name's noise), its kind (one of the kinds), the folder it belongs in (one of the folders, or a new short "
        "lowercase folder like 'characters' when none fits), and match: the path of an existing asset when the row is "
        "clearly more art for that very asset, else \"\".\n"
        'Answer ONLY JSON: {"rows": [{"id": 1, "title": "...", "kind": "...", "folder": "...", "match": ""}, ...]}'
    )
    images = [("image/png", base64.b64encode(sheet[0]).decode("ascii"))] if sheet else []
    try:
        result = await model_call(prompt=prompt, system_prompt="You sort game art into a project and answer with JSON only.",
                                  images_b64=images, effort="low")
        match = re.search(r"\{.*\}", str(result.get("text") or ""), re.S)
        answers = {int(a.get("id")): a for a in (json.loads(match.group(0)).get("rows") or []) if str(a.get("id", "")).isdigit()} if match else {}
    except Exception as exc:  # noqa: BLE001 — no chat model, no vision, a timeout or bad JSON: the guesses stay
        return {**current, "sorted_by": "names", "note": f"Tess couldn't sort these ({(str(exc).strip() or type(exc).__name__)[:160]}). The names were matched instead."}
    if not answers:
        return {**current, "sorted_by": "names", "note": "Tess didn't answer in a way Tessera could read. The names were matched instead."}
    known = {a["path"]: a for a in index}
    sorted_rows = []
    for row in rows:
        a = answers.get(row["id"])
        if not a or current.get("target", "").endswith(".md"):
            sorted_rows.append(row)
            continue
        row = dict(row)
        title = re.sub(r"\s+", " ", str(a.get("title") or "")).strip()[:60]
        if title:
            row["title"] = title
        kind = str(a.get("kind") or "").strip().lower()
        if kind in ASSET_KINDS:
            row["kind"] = kind
        folder_answer = "/".join(slugify(p) for p in str(a.get("folder") or "").split("/") if slugify(p))
        if folder_answer and not current.get("target"):
            row["folder"] = folder_answer
        hit = str(a.get("match") or "").strip()
        if hit in known:
            row.update(match=hit, action="add", kind=known[hit]["kind"], title=known[hit]["title"], has_winner=bool(known[hit]["winner"]))
        elif row["action"] == "add" and not row.get("match"):
            row["action"] = "new"
        row["tess"] = True
        sorted_rows.append(row)
    return {**current, "rows": sorted_rows, "sorted_by": "tess"}


# ---------- apply ----------

def _new_asset(ws_dir: Path, folder: str, title: str, kind: str) -> tuple[str, Path]:
    base = resolve_rel(ws_dir, folder) if folder else ws_dir.resolve()
    if not base.exists():
        base.mkdir(parents=True)
        (base / "README.md").write_text(f"# {clean_title(base.name)}\n", encoding="utf-8")
    slug = slugify(title) or "asset"
    name, n = slug, 2
    while (base / f"{name}.md").exists() or (base / name).exists():
        name, n = f"{slug}-{n}", n + 1
    page = base / f"{name}.md"
    fields = {"kind": kind if kind in ASSET_KINDS else "prop", "prompt": title, "imported": True}
    page.write_text(serialize_frontmatter(fields, f"# {title}\n\nDropped in from your own files.\n"), encoding="utf-8")
    return page.relative_to(ws_dir.resolve()).as_posix(), page


def apply(ws_dir: Path, drop_id: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Write the rows the user kept: new assets, and files onto existing ones. Pictures become candidates and the
    winner only when the asset had none. Returns what changed and keeps an undo record for :func:`undo`."""
    folder = _drop_dir(ws_dir, drop_id)
    staged = folder / "files"
    if not staged.is_dir():
        raise ValueError("This drop is gone. Drop the files again.")
    data = _manifest(folder)
    allowed = set(data["files"])
    record: dict[str, Any] = {"created": [], "files": [], "folders": [], "winners": {}}
    created, updated, problems = [], [], []
    root = ws_dir.resolve()
    for row in rows:
        if row.get("action") == "skip":
            continue
        files = [f for f in row.get("files", []) if f in allowed]
        if not files:
            continue
        title = re.sub(r"\s+", " ", str(row.get("title") or "")).strip()[:60] or clean_title(PurePosixPath(files[0]).stem)
        try:
            match = str(row.get("match") or "")
            if row.get("action") == "add" and match:
                rel = match
                page, meta, _ = read_asset(ws_dir, rel)
                updated.append(rel)
            else:
                dest = "/".join(slugify(p) for p in str(row.get("folder") or "").split("/") if slugify(p))
                parts = dest.split("/") if dest else []
                fresh = next(("/".join(parts[:i]) for i in range(1, len(parts) + 1) if not (root / "/".join(parts[:i])).exists()), "")
                if fresh and fresh not in record["folders"]:
                    record["folders"].append(fresh)
                rel, page = _new_asset(ws_dir, dest, title, str(row.get("kind") or ""))
                meta = {}
                record["created"].append(rel)
                created.append(rel)
            before = str(meta.get("winner") or "")
            textures = set(row.get("textures") or []) & set(files)
            images = [f for f in files if file_type(f) == "image" and f not in textures]
            models = [f for f in files if file_type(f) == "model"]
            sounds = [f for f in files if file_type(f) == "audio"]
            if models:
                parts = [f for f in files if file_type(f) == "model" or f in textures]
                record["files"] += game_tools.save_model_files(ws_dir, rel, [(PurePosixPath(f).name, (staged / f).read_bytes()) for f in parts])
            if images:
                candidates = output_dir(page) / "candidates"
                candidates.mkdir(parents=True, exist_ok=True)
                first = ""
                for f in images:
                    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", PurePosixPath(f).stem).strip("-")[:60] or "image"
                    target = candidates / f"{stem}{PurePosixPath(f).suffix.lower()}"
                    n = 2
                    while target.exists():
                        target, n = candidates / f"{stem}-{n}{PurePosixPath(f).suffix.lower()}", n + 1
                    shutil.copyfile(staged / f, target)
                    saved_rel = target.relative_to(root).as_posix()
                    record["files"].append(saved_rel)
                    first = first or saved_rel
                if first and (not before or row.get("pick")):  # dropped on the picked image itself: it replaces it
                    update_asset(ws_dir, rel, {"winner": first})
                    record["winners"].setdefault(rel, before)
            for f in sounds:
                had = str(read_asset(ws_dir, rel)[1].get("winner") or "")
                saved_rel = asset_studio.save_audio(ws_dir, rel, PurePosixPath(f).name, (staged / f).read_bytes())
                record["files"].append(saved_rel)
                if not had:
                    record["winners"].setdefault(rel, "")
        except (OSError, ValueError) as exc:
            problems.append({"title": title, "why": str(exc)[:200]})
    record["at"] = time.time()
    (folder / "undo.json").write_text(json.dumps(record, indent=1), encoding="utf-8")
    shutil.rmtree(staged, ignore_errors=True)
    return {"created": created, "updated": sorted(set(updated)), "problems": problems, "undo": drop_id}


def undo(ws_dir: Path, drop_id: str) -> dict[str, Any]:
    """Take an applied drop back: new assets and added files go to the trash, and winners it set are cleared."""
    folder = _drop_dir(ws_dir, drop_id)
    try:
        record = json.loads((folder / "undo.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("There is nothing to undo for this drop.") from exc
    root = ws_dir.resolve()
    for rel, before in record.get("winners", {}).items():
        if rel in record.get("created", []):
            continue
        try:
            update_asset(ws_dir, rel, {"winner": before})
        except (OSError, ValueError):
            pass
    for rel in record.get("files", []):
        try:
            move_to_trash(ws_dir, root / rel)
        except (OSError, ValueError):
            pass
    for rel in record.get("created", []):
        page = root / rel
        for target in (output_dir(page), page):
            try:
                move_to_trash(ws_dir, target)
            except (OSError, ValueError):
                pass
    for rel in record.get("folders", []):
        path = root / rel
        try:
            if path.is_dir() and not any(p.is_file() and p.name != "README.md" for p in path.rglob("*")):
                move_to_trash(ws_dir, path)
        except (OSError, ValueError):
            pass
    shutil.rmtree(folder, ignore_errors=True)
    return {"undone": len(record.get("created", [])) + len(record.get("files", []))}
