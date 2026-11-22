"""Live Link: where every asset stands between a request and the copy that sits in the game.

The coding agent copies finished files out of `tessera/` into the game's own folders. From then on nobody
knows which copies are still the newest. Live Link answers that without touching the game: it fingerprints
every finished file Tessera has made (and remembers the older versions), reads the game folder, and matches
by content. A copy identical to the current file is *current*; one identical to an older version is *stale*;
a file merely named like the asset is an *edited* copy.

It only ever reads the game folder. What it learns is shown on the Pipeline page, and stale copies are listed
in `ASSETS.md` / `ASSETS.json` so the coding agent knows what to copy again.

Its own memory is `.studio/live_link.json`: hash caches (so a rescan only hashes what changed) and the
version history of each asset's files.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

from forge.layout import GAME_FOLDERS, Layout

STATE_FILE = "live_link.json"
HISTORY_KEEP = 16  # versions remembered per file of an asset
MAX_GAME_FILES = 40_000  # media files looked at in the game folder
MAX_HASH_BYTES = 400 * 1024 * 1024

IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
MODEL = {".glb", ".gltf", ".fbx", ".obj"}
AUDIO = {".wav", ".mp3", ".ogg", ".flac"}
MEDIA = IMAGE | MODEL | AUDIO
# Engine caches, build output and tooling: never where a hand-copied asset lives.
SKIP_DIRS = {
    ".git", ".godot", ".import", ".svn", ".hg", "node_modules", "library", "temp", "obj", "logs", "build", "builds",
    "binaries", "intermediate", "saved", "deriveddatacache", ".venv", "venv", "__pycache__", ".idea", ".vs", ".vscode",
}

MODEL_ROLES = ("model", "rig")
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(ws_dir: Path) -> threading.Lock:
    key = str(ws_dir)
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def _state_path(ws_dir: Path) -> Path:
    return Layout.of_art(ws_dir).studio / STATE_FILE


def _load(ws_dir: Path) -> dict[str, Any]:
    try:
        data = json.loads(_state_path(ws_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    for key in ("files", "history", "game"):
        if not isinstance(data.get(key), dict):
            data[key] = {}
    return data


def _save(ws_dir: Path, data: dict[str, Any]) -> None:
    path = _state_path(ws_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass  # a read-only project still gets its answer, just without the cache


def _hash(path: Path) -> str:
    digest = hashlib.blake2b(digest_size=16)
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _cached_hash(cache: dict[str, Any], key: str, path: Path, stat: os.stat_result | None = None) -> tuple[str, int] | None:
    """(hash, size) of a file, hashed again only when its size or modified time changed."""
    try:
        stat = stat or path.stat()
    except OSError:
        return None
    if stat.st_size > MAX_HASH_BYTES:
        return None
    hit = cache.get(key)
    if isinstance(hit, list) and len(hit) == 3 and hit[0] == stat.st_size and hit[1] == stat.st_mtime_ns:
        return str(hit[2]), stat.st_size
    try:
        sha = _hash(path)
    except OSError:
        return None
    cache[key] = [stat.st_size, stat.st_mtime_ns, sha]
    return sha, stat.st_size


def game_dir_for(ws_dir: Path) -> Path | None:
    """The game folder of the project around this art folder: the one it lives in, or the one it is linked to."""
    from forge import game_link

    home = ws_dir.parent
    if home.name in GAME_FOLDERS and home.parent.is_dir():
        return home.parent
    folder = game_link.game_folder(home.name, home.parent)
    return folder if folder and folder.is_dir() else None


# ---------- what Tessera has made: every finished file of every asset ----------

def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(text).lower())


def deliverables(ws_dir: Path, row: dict[str, Any]) -> list[dict[str, Any]]:
    """The finished files of one asset (a row of `asset_index._rows`), each with its role and where it is."""
    from forge.asset_index import SOUND_KINDS

    home = ws_dir.parent
    found: list[dict[str, Any]] = []

    def add(role: str, label: str, base: Path, rel: str) -> None:
        if rel and (base / rel).is_file():
            found.append({"role": role, "label": label, "file": base / rel, "rel": rel, "in_art": base == ws_dir})

    add("picked", "Picked sound" if row["kind"] in SOUND_KINDS else "Picked image", ws_dir, row["winner"])
    add("small", "Game-size copy", home, row.get("small") or "")
    add("icon", "Icon", home, row.get("icon") or "")
    add("model", "3D model", ws_dir, row["model"])
    add("rig", "Rigged model", ws_dir, row["rig"])
    for clip in row.get("animations") or []:
        add(f"anim:{clip['name']}", f"Animation · {clip['name']}", ws_dir, clip["path"])
    for sprite in row.get("sprites") or []:
        add(f"sprite:{sprite['name']}", f"Sprite sheet · {sprite['name']}", ws_dir, sprite.get("sheet") or "")
    return found


def _record(ws_dir: Path, rows: list[dict[str, Any]], data: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Fingerprint every finished file and add new versions to the history. Returns the files per asset."""
    from forge.asset_index import _prefixes

    prefix, game_prefix = _prefixes(ws_dir)
    now = int(time.time())
    seen_keys: set[str] = set()
    per_asset: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        versions = data["history"].setdefault(row["rel"], {})
        files = []
        for item in deliverables(ws_dir, row):
            key = ("art:" if item["in_art"] else "home:") + item["rel"]
            seen_keys.add(key)
            hashed = _cached_hash(data["files"], key, item["file"])
            if not hashed:
                continue
            sha, size = hashed
            past = versions.setdefault(item["role"], [])
            if not past or past[-1].get("sha") != sha:
                # Picking an older take again is that take, current again: not a new version.
                past[:] = [v for v in past if v.get("sha") != sha]
                past.append({"sha": sha, "size": size, "at": now, "name": Path(item["rel"]).name})
                del past[:-HISTORY_KEEP]
            files.append({
                "role": item["role"], "label": item["label"], "sha": sha, "size": size,
                "path": (prefix if item["in_art"] else game_prefix) + item["rel"],
                "name": Path(item["rel"]).name, "versions": len(past),
            })
        per_asset[row["rel"]] = files
    for key in [k for k in data["files"] if k not in seen_keys]:
        del data["files"][key]
    return per_asset


# ---------- what the game has: media files, hashed only when one could be a copy ----------

def _walk_game(game: Path, skip: set[Path]) -> list[tuple[str, Path, os.stat_result]]:
    found: list[tuple[str, Path, os.stat_result]] = []
    stack = [game]
    while stack and len(found) < MAX_GAME_FILES:
        folder = stack.pop()
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir():
                    path = Path(entry.path)
                    at_root = folder == game
                    if entry.name.lower() in SKIP_DIRS or (at_root and entry.name in GAME_FOLDERS) or path.resolve() in skip:
                        continue
                    stack.append(path)
                elif Path(entry.name).suffix.lower() in MEDIA:
                    path = Path(entry.path)
                    found.append((path.relative_to(game).as_posix(), path, entry.stat()))
            except OSError:
                continue
    return found


def _media_class(suffix: str) -> str:
    suffix = suffix.lower()
    return "image" if suffix in IMAGE else "model" if suffix in MODEL else "audio" if suffix in AUDIO else ""


def _scan(ws_dir: Path, game: Path, data: dict[str, Any], per_asset: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Match the game's media files against every version Tessera made. Returns copies per asset and scan numbers."""
    started = time.perf_counter()
    by_sha: dict[str, tuple[str, str, bool]] = {}  # hash -> (asset, role, is the current version)
    sizes: set[int] = set()
    for rel, roles in data["history"].items():
        current = {f["role"]: f["sha"] for f in per_asset.get(rel, [])}
        if rel not in per_asset:
            continue  # the asset is gone; its old files are nobody's copy
        for role, versions in roles.items():
            for version in versions:
                sha = version.get("sha")
                if not sha:
                    continue
                is_current = current.get(role) == sha
                # A file that is the current version of anything wins over being an old version of something else.
                if sha not in by_sha or is_current:
                    by_sha[sha] = (rel, role, is_current)
                sizes.add(int(version.get("size") or 0))
    # Names an edited copy could carry: the asset's own name, per kind of file it has.
    by_name: dict[tuple[str, str], str] = {}
    for rel, files in per_asset.items():
        slug = _slug(Path(rel).stem)
        if len(slug) < 4:
            continue
        for f in files:
            by_name.setdefault((slug, _media_class(Path(f["name"]).suffix)), rel)

    skip = {ws_dir.parent.resolve()}
    files = _walk_game(game, skip)
    copies: dict[str, list[dict[str, Any]]] = {}
    hashed = 0
    live_keys = set()
    for rel, path, stat in files:
        live_keys.add(rel)
        match = None
        if stat.st_size in sizes:
            before = data["game"].get(rel)
            result = _cached_hash(data["game"], rel, path, stat)
            if result:
                if before != data["game"].get(rel):
                    hashed += 1
                match = by_sha.get(result[0])
        if match:
            asset, role, is_current = match
            copies.setdefault(asset, []).append({"file": rel, "role": role, "state": "current" if is_current else "stale"})
            continue
        asset = by_name.get((_slug(Path(rel).stem), _media_class(Path(rel).suffix)))
        if asset:
            copies.setdefault(asset, []).append({"file": rel, "role": "", "state": "edited"})
    for key in [k for k in data["game"] if k not in live_keys]:
        del data["game"][key]
    for items in copies.values():
        items.sort(key=lambda c: ({"stale": 0, "current": 1, "edited": 2}[c["state"]], c["file"]))
    return {
        "copies": copies,
        "files": len(files),
        "hashed": hashed,
        "truncated": len(files) >= MAX_GAME_FILES,
        "ms": round((time.perf_counter() - started) * 1000),
    }


# ---------- one asset's place in the pipeline ----------

STAGES = (
    ("concept", "Concept", "Candidates to choose from"),
    ("picked", "Picked", "A winner is chosen"),
    ("model", "3D", "The model is made"),
    ("motion", "Motion", "Rigged and animated"),
    ("game", "In game", "The newest files are in the game"),
)
RIGGABLE = ("character", "creature")


def _stages(row: dict[str, Any], dimension: str, copies: list[dict[str, Any]], linked: bool) -> dict[str, Any]:
    from forge.asset_index import NO_MODEL_KINDS, SOUND_KINDS

    kind = row["kind"]
    sound = kind in SOUND_KINDS
    kit = kind == "kit"
    options = int(row.get("takes") or 0) if sound else int(row.get("candidates") or 0)
    has_model = bool(row["model"])
    wants_model = kit or has_model or (kind not in NO_MODEL_KINDS and dimension != "2d")
    wants_motion = bool(row["rig"] or row.get("animations")) or (wants_model and kind in RIGGABLE)
    states = {c["state"] for c in copies}
    # With a model, the model is what the game needs: its picture alone being in is only half way.
    main = [c for c in copies if c["state"] == "current" and (not has_model or c["role"] in MODEL_ROLES or c["role"].startswith("anim:"))]
    game = "stale" if "stale" in states else "current" if main else "partial" if "current" in states else "edited" if "edited" in states else "none"

    stage = {
        "concept": "na" if kit else "done" if (options or row["winner"]) else "todo",
        "picked": "na" if kit else "done" if row["winner"] else "todo",
        "model": "na" if not wants_model else "done" if has_model else "todo",
        "motion": "na" if not wants_motion else "done" if row["rig"] else "todo",
        "game": "na" if not linked else {"current": "done", "stale": "stale", "partial": "partial", "edited": "edited", "none": "todo"}[game],
    }
    ready = has_model if kit else bool(row["winner"]) and (has_model or not wants_model)
    # Where it waits: an old copy in the game comes first, then the first step that is still to do.
    # Motion is a bonus, never a blocker.
    if linked and game == "stale":
        at = "stale"
    elif stage["concept"] == "todo":
        at = "concept"
    elif stage["picked"] == "todo":
        at = "picked"
    elif stage["model"] == "todo":
        at = "model"
    elif not linked:
        at = "ready"
    elif game == "current":
        at = "shipped"
    else:
        at = "game"
    return {"stages": stage, "at": at, "ready": ready, "options": options, "clips": len(row.get("animations") or [])}


def _match_request(text: str, names: list[tuple[str, str]]) -> str:
    """The asset a request line is about: the name before its colon, matched against asset titles and file names."""
    head = _slug(re.split(r"[:—–]| - ", text, maxsplit=1)[0])
    whole = _slug(text)
    best = ""
    best_len = 0
    for slug, rel in names:
        if len(slug) < 3:
            continue
        hit = slug == head or (len(slug) >= 4 and (slug in head or (head and len(head) >= 4 and head in slug))) or (len(slug) >= 6 and slug in whole)
        if hit and len(slug) > best_len:
            best, best_len = rel, len(slug)
    return best


def snapshot(ws_dir: Path, game: Path | None = None, rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Every asset's stage, its finished files, their copies in the game, and the open requests. Reads only."""
    from forge import asset_index
    from forge.overview import humanize, project_dimension

    if rows is None:
        rows = asset_index._rows(ws_dir)
    if game is None:
        game = game_dir_for(ws_dir)
    linked = bool(game and game.is_dir())
    dimension = project_dimension(ws_dir)
    with _lock(ws_dir):
        data = _load(ws_dir)
        before = json.dumps(data, sort_keys=True)
        per_asset = _record(ws_dir, rows, data)
        for gone in [rel for rel in data["history"] if rel not in per_asset]:
            del data["history"][gone]
        scan = _scan(ws_dir, game, data, per_asset) if linked else {"copies": {}, "files": 0, "hashed": 0, "truncated": False, "ms": 0}
        if json.dumps(data, sort_keys=True) != before:
            _save(ws_dir, data)

    assets = []
    for row in rows:
        copies = scan["copies"].get(row["rel"], [])
        files = per_asset.get(row["rel"], [])
        by_role: dict[str, list[dict[str, Any]]] = {}
        for copy in copies:
            by_role.setdefault(copy["role"], []).append(copy)
        for f in files:
            mine = by_role.get(f["role"], [])
            f["copies"] = [{"file": c["file"], "state": c["state"]} for c in mine]
            f["state"] = "stale" if any(c["state"] == "stale" for c in mine) else "current" if mine else "none"
        top = row["rel"].split("/")[0] if "/" in row["rel"] else ""
        picture = row["winner"] if Path(row["winner"]).suffix.lower() in IMAGE else ""
        assets.append({
            "path": row["rel"], "title": row["title"], "kind": row["kind"],
            "section": top, "section_title": humanize(top) if top else "Project",
            "image": picture or row.get("thumb") or row.get("preview") or "",
            "sound": row["kind"] in asset_index.SOUND_KINDS,
            "files": [{k: f[k] for k in ("role", "label", "path", "name", "size", "versions", "state", "copies")} for f in files],
            "edited": [c["file"] for c in copies if c["state"] == "edited"],
            **_stages(row, dimension, copies, linked),
        })

    names = sorted({(_slug(a["title"]), a["path"]) for a in assets} | {(_slug(Path(a["path"]).stem), a["path"]) for a in assets})
    by_path = {a["path"]: a for a in assets}
    raw = asset_index.read_requests(ws_dir)
    requests = []
    for done, items in ((False, raw["open"]), (True, raw["done"][:20])):
        for text in items:
            rel = _match_request(text, names)
            asset = by_path.get(rel)
            state = "done" if done else "new" if not asset else "ready" if asset["ready"] else "making"
            requests.append({"text": text, "state": state, "asset": rel, "title": asset["title"] if asset else ""})

    count = lambda at: sum(1 for a in assets if a["at"] == at)  # noqa: E731
    engine = ("", "", "")
    if linked:
        from forge.game_import import _engine

        try:
            engine = _engine(game)
        except OSError:
            pass
    return {
        "game": {
            "linked": linked, "folder": str(game) if linked else "", "name": (engine[2] or game.name) if linked else "",
            "engine": engine[1] if linked else "", "files": scan["files"], "hashed": scan["hashed"],
            "truncated": scan["truncated"], "ms": scan["ms"], "at": int(time.time()),
        },
        "dimension": dimension,
        "stages": [{"id": sid, "label": label, "hint": hint} for sid, label, hint in STAGES],
        "totals": {
            "assets": len(assets),
            "concept": count("concept"), "picked": count("picked"), "model": count("model"),
            "ready": count("ready"), "game": count("game"), "stale": count("stale"), "shipped": count("shipped"),
            "stale_files": sum(1 for a in assets for f in a["files"] for c in f["copies"] if c["state"] == "stale"),
            "requests": sum(1 for r in requests if r["state"] != "done"),
            "requests_ready": sum(1 for r in requests if r["state"] == "ready"),
        },
        "assets": assets,
        "requests": requests,
        "requests_file": raw["path"],
    }


def signature(snap: dict[str, Any]) -> str:
    """Changes whenever what the index says about the game would change."""
    lines = sorted(f"{a['path']}|{f['role']}|{c['file']}|{c['state']}" for a in snap["assets"] for f in a["files"] for c in f["copies"])
    return hashlib.blake2b("\n".join(lines).encode("utf-8"), digest_size=8).hexdigest()


# ---------- words for the coding agent ----------

def out_of_date(snap: dict[str, Any]) -> list[dict[str, str]]:
    """Every copy in the game that is an older version: the game file, the asset, and the file to copy over it."""
    return [
        {"game_file": c["file"], "asset": a["title"], "what": f["label"], "replace_with": f["path"]}
        for a in snap["assets"] for f in a["files"] for c in f["copies"] if c["state"] == "stale"
    ]


def _lower(label: str) -> str:
    return label[:1].lower() + label[1:]


def agent_note(snap: dict[str, Any], asset: str = "") -> str:
    """A message for the game's coding agent: what to copy again, what is new, which requests are answered."""
    chosen = [a for a in snap["assets"] if not asset or a["path"] == asset]
    stale = out_of_date({"assets": chosen})
    fresh = [a for a in chosen if a["at"] in ("game", "ready") and a["ready"]]
    answered = [r for r in snap["requests"] if r["state"] == "ready" and (not asset or r["asset"] == asset)]
    lines = ["Tessera has newer art than the game. Paths starting with tessera/ (or art/) are Tessera's; the others are in the game."]
    if stale:
        lines += ["", "Copy these again: the game still has an older version."]
        lines += [f"- `{s['game_file']}` ← `{s['replace_with']}` ({s['asset']}, {_lower(s['what'])})" for s in stale]
    if fresh:
        lines += ["", "Finished and not in the game yet: copy what you need and swap out the placeholder."]
        for a in fresh:
            main = [f for f in a["files"] if f["role"] in ("picked", "small", "model", "rig")] or a["files"]
            lines.append(f"- {a['title']} ({a['kind']}): " + ", ".join(f"{_lower(f['label'])} `{f['path']}`" for f in main))
    if answered:
        lines += ["", f"These lines in {snap['requests_file']} have finished art; tick each one once it is in the game and covers what you asked:"]
        lines += [f"- {r['text']}" for r in answered]
    if len(lines) == 1:
        return "The game is up to date with Tessera: nothing to copy."
    lines += ["", "Sizes, fronts and points for each model are in ASSETS.md. Don't edit anything inside Tessera's folder."]
    return "\n".join(lines)
