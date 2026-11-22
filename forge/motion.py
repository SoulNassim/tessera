"""Motion Studio: hand-made animation for rigged models.

A motion is a small JSON document next to its asset (`<asset>/motion/<name>.json`): keyframes in layers, IK chains,
modifiers and markers. It is the source of truth; the Studio page and Tess both edit it. Baking samples the final
pose in the browser and this module splices the samples into a copy of the source GLB as one standard animation.

The splice is lossless: meshes, skins, materials and textures keep their exact bytes. Only the animation list and the
accessors it needs are written; no dependency beyond the standard library.
"""

from __future__ import annotations

import json
import math
import re
import struct
from pathlib import Path
from typing import Any

MOTION_DIR = "motion"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
INTERPOLATIONS = ("smooth", "linear", "step")
LAYER_MODES = ("override", "additive")
CHANNELS = {"r": 4, "t": 3, "s": 3}  # rotation quaternion, translation, scale
PATHS = {"rotation": 4, "translation": 3, "scale": 3}
MAX_FRAMES = 6000
MAX_LAYERS = 16
MAX_KEYS = 4000  # per channel


def clean_name(value: Any) -> str:
    name = re.sub(r"[^a-z0-9_-]+", "_", str(value or "").strip().lower()).strip("_")
    if not NAME_RE.match(name):
        raise ValueError("Give the motion a name: letters, digits, _ or -, up to 48 characters.")
    return name


def _asset_dir(ws_dir: Path, asset: str) -> Path:
    from forge.asset_studio import output_dir, read_asset

    path, _, _ = read_asset(ws_dir, asset)
    return output_dir(path)


def _rel(ws_dir: Path, path: Path) -> str:
    return path.resolve().relative_to(ws_dir.resolve()).as_posix()


def _num(value: Any, low: float, high: float, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return min(high, max(low, number)) if math.isfinite(number) else default


def _floats(value: Any, count: int) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != count:
        raise ValueError(f"A key value needs {count} numbers.")
    out = [float(v) for v in value]
    if not all(math.isfinite(v) for v in out):
        raise ValueError("A key value has a number that isn't finite.")
    return [round(v, 6) for v in out]


def _clean_keys(value: Any, size: int, frames: int) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("A track channel must be a list of keys.")
    by_frame: dict[int, dict[str, Any]] = {}
    for key in value[:MAX_KEYS]:
        if not isinstance(key, dict):
            raise ValueError("A key must be an object with f (frame) and v (value).")
        frame = int(_num(key.get("f"), 0, frames, 0))
        numbers = _floats(key.get("v"), size)
        if size == 4:
            length = math.sqrt(sum(v * v for v in numbers))
            if length < 1e-9:
                raise ValueError("A rotation key can't be the zero quaternion.")
            numbers = [round(v / length, 6) for v in numbers]
        interp = str(key.get("i") or "smooth")
        by_frame[frame] = {"f": frame, "v": numbers, "i": interp if interp in INTERPOLATIONS else "smooth",
                           "eo": round(_num(key.get("eo"), 0, 1, 0), 3), "ei": round(_num(key.get("ei"), 0, 1, 0), 3)}
    return [by_frame[f] for f in sorted(by_frame)]


def _clean_tracks(value: Any, frames: int) -> dict[str, dict[str, list[dict[str, Any]]]]:
    if not isinstance(value, dict):
        return {}
    tracks: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for bone, channels in list(value.items())[:1024]:
        if not isinstance(channels, dict):
            continue
        clean = {ch: _clean_keys(channels[ch], size, frames) for ch, size in CHANNELS.items() if channels.get(ch)}
        clean = {ch: keys for ch, keys in clean.items() if keys}
        if clean:
            tracks[str(bone)[:200]] = clean
    return tracks


def clean_doc(doc: Any) -> dict[str, Any]:
    """A motion document with every field checked; unknown fields are dropped."""
    if not isinstance(doc, dict):
        raise ValueError("A motion must be a JSON object.")
    frames = int(_num(doc.get("frames"), 1, MAX_FRAMES, 60))
    source = str(doc.get("source") or "").strip()
    if not source:
        raise ValueError("A motion needs a source: the rigged GLB it animates.")
    layers = []
    for index, layer in enumerate((doc.get("layers") or [])[:MAX_LAYERS]):
        if not isinstance(layer, dict):
            continue
        mode = str(layer.get("mode") or "override")
        layers.append({
            "id": str(layer.get("id") or f"layer{index + 1}")[:40],
            "name": str(layer.get("name") or f"Layer {index + 1}")[:60],
            "mode": mode if mode in LAYER_MODES else "override",
            "weight": round(_num(layer.get("weight"), 0, 1, 1), 3),
            "mute": bool(layer.get("mute")),
            "tracks": _clean_tracks(layer.get("tracks"), frames),
        })
    if not layers:
        layers = [{"id": "layer1", "name": "Keys", "mode": "override", "weight": 1.0, "mute": False, "tracks": {}}]
    ik = doc.get("ik") if isinstance(doc.get("ik"), dict) else {}
    chains = []
    for chain in (ik.get("chains") or [])[:64]:
        if isinstance(chain, dict) and all(isinstance(chain.get(k), str) and chain.get(k) for k in ("root", "mid", "tip")):
            chains.append({"name": str(chain.get("name") or chain["tip"])[:60], "root": chain["root"][:200], "mid": chain["mid"][:200],
                           "tip": chain["tip"][:200], "flip": bool(chain.get("flip"))})
    markers = []
    for marker in (doc.get("markers") or [])[:500]:
        if isinstance(marker, dict) and str(marker.get("name") or "").strip():
            markers.append({"f": int(_num(marker.get("f"), 0, frames, 0)), "name": str(marker["name"]).strip()[:60],
                            "audio": str(marker.get("audio") or "")[:400]})
    modifiers = [m for m in map(clean_modifier, (doc.get("modifiers") or [])[:32]) if m]
    base_clip = doc.get("base_clip")
    lo = int(_num((doc.get("range") or [0, frames])[0], 0, frames - 1, 0)) if isinstance(doc.get("range"), list) and len(doc["range"]) == 2 else 0
    hi = int(_num(doc["range"][1], lo + 1, frames, frames)) if isinstance(doc.get("range"), list) and len(doc["range"]) == 2 else frames
    return {
        "version": 1,
        "source": source,
        "base_clip": int(base_clip) if isinstance(base_clip, int) and not isinstance(base_clip, bool) and base_clip >= 0 else None,
        "fps": int(_num(doc.get("fps"), 1, 120, 30)),
        "frames": frames,
        "range": [lo, hi],
        "loop": bool(doc.get("loop", True)),
        "ik": {"horror": bool(ik.get("horror")), "chains": chains},
        "layers": layers,
        "modifiers": modifiers,
        "markers": sorted(markers, key=lambda m: m["f"]),
        "baked": doc.get("baked") if isinstance(doc.get("baked"), dict) else None,
    }


def motion_path(ws_dir: Path, asset: str, name: str) -> Path:
    return _asset_dir(ws_dir, asset) / MOTION_DIR / f"{clean_name(name)}.json"


def read(ws_dir: Path, asset: str, name: str) -> dict[str, Any]:
    path = motion_path(ws_dir, asset, name)
    if not path.is_file():
        raise FileNotFoundError(f"No motion '{name}' on this asset.")
    return {"name": path.stem, **clean_doc(json.loads(path.read_text(encoding="utf-8")))}


def save(ws_dir: Path, asset: str, name: str, doc: Any) -> dict[str, Any]:
    path = motion_path(ws_dir, asset, name)
    clean = clean_doc(doc)
    if path.is_file() and clean["baked"] is None:  # a save from the page never forgets the last bake
        try:
            clean["baked"] = json.loads(path.read_text(encoding="utf-8")).get("baked")
        except (OSError, ValueError):
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(clean, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
    return {"name": path.stem, **clean}


def delete(ws_dir: Path, asset: str, name: str) -> None:
    path = motion_path(ws_dir, asset, name)
    if not path.is_file():
        raise FileNotFoundError(f"No motion '{name}' on this asset.")
    path.unlink()


def list_motions(ws_dir: Path, asset_dir: Path) -> list[dict[str, Any]]:
    folder = asset_dir / MOTION_DIR
    out = []
    for file in sorted(folder.glob("*.json")) if folder.is_dir() else []:
        try:
            doc = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        baked = doc.get("baked") if isinstance(doc.get("baked"), dict) else None
        out.append({"name": file.stem, "source": str(doc.get("source") or ""), "frames": doc.get("frames"), "fps": doc.get("fps"),
                    "seconds": round((doc.get("frames") or 0) / max(1, doc.get("fps") or 30), 3),
                    "baked": baked.get("clip") if baked else ""})
    return out


def baked_info(clip_path: Path) -> dict[str, Any] | None:
    """What Motion Studio recorded when it baked this clip (loop, root speed, events), or None for other clips."""
    doc_path = clip_path.parent.parent / MOTION_DIR / f"{clip_path.stem}.json"
    try:
        baked = json.loads(doc_path.read_text(encoding="utf-8")).get("baked")
    except (OSError, ValueError):
        return None
    return baked if isinstance(baked, dict) else None


def take_label(stem: str, asset_stem: str) -> str:
    """A take's name as a button says it: "lantern-knight-walking-20261116-011111" is "walking"."""
    name = re.sub(r"[-_]?\d{8}[-_]\d{6}(?:[-_]\d+)?$", "", stem)
    if name.lower().startswith(asset_stem.lower()) and len(name) > len(asset_stem):
        name = name[len(asset_stem):]
    return name.strip("-_ ").replace("-", " ").replace("_", " ") or stem


def home(ws_dir: Path, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every asset Motion Studio can open: its rig, its takes and the motions already made on it."""
    from forge import model_info

    rigs = []
    for row in rows:
        sources = []
        if row.get("rig", "").lower().endswith(".glb"):
            sources.append({"path": row["rig"], "label": "Bind pose", "kind": "rig", "seconds": 0.0})
        elif row.get("model", "").lower().endswith(".glb") and (model_info.describe(ws_dir / row["model"]) or {}).get("bones"):
            sources.append({"path": row["model"], "label": "Bind pose", "kind": "rig", "seconds": 0.0})
        for clip in row.get("animations") or []:
            if clip["path"].lower().endswith(".glb"):
                sources.append({"path": clip["path"], "label": take_label(clip["name"], Path(row["rel"]).stem), "kind": "take", "seconds": clip["seconds"]})
        if not sources:
            continue
        asset_dir = (ws_dir / row["rel"]).with_suffix("")
        motions = list_motions(ws_dir, asset_dir)
        made = {Path(m["baked"]).stem for m in motions if m["baked"]}
        for source in sources:
            source["made_here"] = source["kind"] == "take" and Path(source["path"]).stem in made
        rigs.append({"asset": row["rel"], "title": row["title"], "thumb": row.get("thumb") or row.get("preview") or "",
                     "scale": (row.get("placement") or {}).get("scale") or 1.0, "sources": sources, "motions": motions})
    return rigs


MODIFIERS = {
    # type -> {parameter: (low, high, default)}; "set"/"root" (which bones) and "on" are common to all
    "reverse": {},
    "quantize": {"step": (1, 30, 3)},
    "twitch": {"amount": (0, 180, 12), "speed": (0.1, 30, 8), "seed": (1, 9999, 1)},
    "stride": {"stride": (0, 3, 1), "speed": (0.1, 4, 1)},
    "clamp": {},
}
BONE_SETS = ("all", "legs", "arms", "branch")


def clean_modifier(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or value.get("type") not in MODIFIERS:
        return None
    kind = value["type"]
    out: dict[str, Any] = {"type": kind, "on": value.get("on") is not False}
    for name, (low, high, default) in MODIFIERS[kind].items():
        number = _num(value.get(name), low, high, default)
        out[name] = int(round(number)) if name in ("step", "seed") else round(number, 3)
    if kind in ("reverse", "quantize", "twitch"):
        chosen = str(value.get("set") or ("legs" if kind == "reverse" else "all"))
        out["set"] = chosen if chosen in BONE_SETS else "all"
        if out["set"] == "branch":
            out["root"] = str(value.get("root") or "")[:200]
    if kind == "clamp":
        out["lock"] = bool(value.get("lock"))
    return out


def list_sounds(ws_dir: Path) -> list[dict[str, str]]:
    """Every sound file in the project, for marker previews."""
    import os

    from forge.asset_studio import AUDIO_SUFFIXES

    found: list[dict[str, str]] = []
    for folder, dirs, files in os.walk(ws_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(files):
            if Path(name).suffix.lower() in AUDIO_SUFFIXES:
                found.append({"path": (Path(folder) / name).relative_to(ws_dir).as_posix(), "name": Path(name).stem})
                if len(found) >= 400:
                    return found
    return found


# ---------- the GLB splice ----------

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def split_glb(data: bytes) -> tuple[dict[str, Any], bytes]:
    """The glTF JSON and the binary chunk of a .glb."""
    if len(data) < 20 or struct.unpack_from("<I", data, 0)[0] != GLB_MAGIC:
        raise ValueError("This file is not a GLB. Motion Studio bakes into .glb models.")
    offset = 12
    gltf: dict[str, Any] | None = None
    binary = b""
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        body = data[offset + 8: offset + 8 + length]
        if kind == CHUNK_JSON and gltf is None:
            gltf = json.loads(body.decode("utf-8"))
        elif kind == CHUNK_BIN and not binary:
            binary = bytes(body)
        offset += 8 + length + (-length % 4)
    if not isinstance(gltf, dict):
        raise ValueError("This GLB has no glTF JSON chunk.")
    return gltf, binary


def join_glb(gltf: dict[str, Any], binary: bytes) -> bytes:
    text = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    text += b" " * (-len(text) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(text) + (8 + len(binary) if binary else 0)
    out = struct.pack("<III", GLB_MAGIC, 2, total) + struct.pack("<II", len(text), CHUNK_JSON) + text
    if binary:
        out += struct.pack("<II", len(binary), CHUNK_BIN) + binary
    return out


def _views_in_use(node: Any, found: set[int]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "bufferView" and isinstance(value, int):
                found.add(value)
            else:
                _views_in_use(value, found)
    elif isinstance(node, list):
        for item in node:
            _views_in_use(item, found)


def _accessors_in_use(gltf: dict[str, Any]) -> set[int]:
    used: set[int] = set()

    def attributes(holder: Any) -> None:
        if isinstance(holder, dict):
            used.update(v for v in holder.values() if isinstance(v, int))

    for mesh in gltf.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            attributes(prim.get("attributes"))
            if isinstance(prim.get("indices"), int):
                used.add(prim["indices"])
            for target in prim.get("targets") or []:
                attributes(target)
    for skin in gltf.get("skins") or []:
        if isinstance(skin.get("inverseBindMatrices"), int):
            used.add(skin["inverseBindMatrices"])
    for node in gltf.get("nodes") or []:
        for ext in (node.get("extensions") or {}).values():
            if isinstance(ext, dict):
                attributes(ext.get("attributes"))
    return used


def _drop_animations(gltf: dict[str, Any], binary: bytes) -> bytes:
    """Remove the file's animations. Their data is cut only where it sits at the end of the file (where exporters
    write it), so no index anywhere else has to change; otherwise it stays behind as unused bytes."""
    animations = gltf.pop("animations", None) or []
    dead = {s.get(k) for a in animations for s in a.get("samplers") or [] for k in ("input", "output")}
    accessors = gltf.get("accessors") or []
    used = _accessors_in_use(gltf)
    while accessors and (len(accessors) - 1) in dead and (len(accessors) - 1) not in used:
        accessors.pop()
    views = gltf.get("bufferViews") or []
    live: set[int] = set()
    _views_in_use(gltf, live)
    cut = False
    while views and (len(views) - 1) not in live:
        views.pop()
        cut = True
    if cut:
        end = max((v.get("byteOffset", 0) + v.get("byteLength", 0) for v in views if v.get("buffer", 0) == 0), default=0)
        if end <= len(binary):
            binary = binary[: end + (-end % 4)]
    return binary


def _rest(node: dict[str, Any], path: str) -> list[float] | None:
    if "matrix" in node:
        return None
    default = {"rotation": [0.0, 0.0, 0.0, 1.0], "translation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}[path]
    value = node.get(path)
    return [float(v) for v in value] if isinstance(value, list) and len(value) == len(default) else default


def splice_clip(glb: bytes, name: str, times: list[float], tracks: list[dict[str, Any]]) -> tuple[bytes, int]:
    """A copy of `glb` whose only animation is `name`: one LINEAR sampler per track, all sharing `times`.

    tracks: [{"node": glTF node index, "path": "rotation" | "translation" | "scale", "values": flat floats}].
    Tracks that never move and equal the node's rest value are left out. Returns the new file and how many tracks
    it holds.
    """
    gltf, binary = split_glb(glb)
    nodes = gltf.get("nodes") or []
    count = len(times)
    if count < 2:
        raise ValueError("A clip needs at least two frames.")
    if any(not math.isfinite(t) for t in times) or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("Frame times must rise.")
    kept: list[tuple[int, str, list[float]]] = []
    fallback: tuple[int, str, list[float]] | None = None
    for track in tracks:
        node, path = track.get("node"), track.get("path")
        if not isinstance(node, int) or isinstance(node, bool) or not 0 <= node < len(nodes) or path not in PATHS:
            raise ValueError("A track points at a bone this model doesn't have.")
        size = PATHS[path]
        values = [float(v) for v in track.get("values") or []]
        if len(values) != count * size or not all(math.isfinite(v) for v in values):
            raise ValueError(f"The {path} track of node {node} has the wrong number of values.")
        if path == "rotation":
            for i in range(0, len(values), 4):
                length = math.sqrt(sum(v * v for v in values[i: i + 4])) or 1.0
                values[i: i + 4] = [v / length for v in values[i: i + 4]]
        first = values[:size]
        still = all(abs(values[i] - first[i % size]) < 1e-6 for i in range(len(values)))
        rest = _rest(nodes[node], path)
        if path == "rotation" and rest is not None and sum(a * b for a, b in zip(first, rest)) < 0:
            rest = [-v for v in rest]  # q and -q are the same rotation
        entry = (node, path, values)
        if still and rest is not None and all(abs(a - b) < 1e-5 for a, b in zip(first, rest)):
            fallback = fallback or entry
            continue
        kept.append(entry)
    if not kept:
        if fallback is None:
            raise ValueError("There is nothing to bake: the motion has no bones.")
        kept.append(fallback)  # a clip holding the bind pose is still a clip

    binary = _drop_animations(gltf, binary)
    binary += b"\0" * (-len(binary) % 4)
    buffers = gltf.setdefault("buffers", [])
    if not buffers:
        buffers.append({"byteLength": 0})
    if "uri" in buffers[0]:
        raise ValueError("This GLB keeps its data in a separate file, so it can't be baked into.")
    views = gltf.setdefault("bufferViews", [])
    accessors = gltf.setdefault("accessors", [])

    def add(numbers: list[float], kind: str, bounds: bool = False) -> int:
        nonlocal binary
        packed = struct.pack(f"<{len(numbers)}f", *numbers)
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(packed)})
        binary += packed
        size = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[kind]
        accessor: dict[str, Any] = {"bufferView": len(views) - 1, "componentType": 5126, "count": len(numbers) // size, "type": kind}
        if bounds:
            stored = struct.unpack(f"<{len(numbers)}f", packed)
            accessor["min"], accessor["max"] = [min(stored)], [max(stored)]
        accessors.append(accessor)
        return len(accessors) - 1

    time_accessor = add([float(t) for t in times], "SCALAR", bounds=True)
    samplers, channels = [], []
    for node, path, values in kept:
        samplers.append({"input": time_accessor, "output": add(values, "VEC4" if path == "rotation" else "VEC3"), "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": node, "path": path}})
    gltf["animations"] = [{"name": name, "samplers": samplers, "channels": channels}]
    buffers[0]["byteLength"] = len(binary)
    return join_glb(gltf, binary), len(kept)


def bake(ws_dir: Path, asset: str, name: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Write `<asset>/animations/<name>.glb` from the samples the page sends, and record the bake on the motion."""
    from forge.asset_studio import resolve_rel

    name = clean_name(name)
    doc_path = motion_path(ws_dir, asset, name)
    if not doc_path.is_file():
        raise FileNotFoundError("Save the motion before baking it.")
    doc = clean_doc(json.loads(doc_path.read_text(encoding="utf-8")))
    source = resolve_rel(ws_dir, doc["source"])
    if not source.is_file():
        raise FileNotFoundError(f"The source model '{doc['source']}' is gone.")
    times = [float(t) for t in payload.get("times") or []]
    tracks = payload.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError("Nothing to bake.")
    data, kept = splice_clip(source.read_bytes(), name, times, tracks)
    out = _asset_dir(ws_dir, asset) / "animations" / f"{name}.glb"
    if out.resolve() == source.resolve():
        raise ValueError("This motion is named like the take it starts from. Rename it, then bake.")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".glb.tmp")
    tmp.write_bytes(data)
    tmp.replace(out)
    fps = doc["fps"]
    seconds = round(times[-1] - times[0], 3)
    doc["baked"] = {
        "clip": _rel(ws_dir, out),
        "seconds": seconds,
        "fps": fps,
        "frames": len(times),
        "loop": doc["loop"],
        "root_speed": round(_num(payload.get("root_speed"), 0, 1000, 0), 3),
        "events": [{"name": m["name"], "time": round(m["f"] / fps, 3), **({"audio": m["audio"]} if m["audio"] else {})} for m in doc["markers"]],
        "tracks": kept,
    }
    doc_path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    return {"name": name, **doc, "bytes": len(data)}


# ---------- Tess: reading and editing a motion from chat ----------

def _bone_names(ws_dir: Path, source: str) -> list[str]:
    from forge import model_info
    from forge.asset_studio import resolve_rel

    gltf = model_info.read_gltf(resolve_rel(ws_dir, source)) or {}
    nodes = gltf.get("nodes") or []
    joints = sorted({j for skin in gltf.get("skins") or [] for j in skin.get("joints") or [] if isinstance(j, int) and j < len(nodes)})
    return [str(nodes[j].get("name") or f"node_{j}") for j in joints]


def _euler_quat(degrees: Any) -> list[float]:
    x, y, z = (math.radians(v) / 2 for v in _floats(degrees, 3))
    c1, c2, c3, s1, s2, s3 = math.cos(x), math.cos(y), math.cos(z), math.sin(x), math.sin(y), math.sin(z)
    return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]


def describe_motion(ws_dir: Path, asset: str, name: str) -> str:
    """What Tess needs to edit a motion: its length, bones, layers with their keyed bones, modifiers and markers."""
    doc = read(ws_dir, asset, name)
    lines = [f"Motion '{doc['name']}' on {asset}: {doc['frames']} frames at {doc['fps']} fps, {'loops' if doc['loop'] else 'plays once'}, source {doc['source']}.",
             "Bones: " + ", ".join(_bone_names(ws_dir, doc["source"]))]
    for index, layer in enumerate(doc["layers"]):
        keyed = ", ".join(f"{bone} ({'/'.join(f'{ch}:{len(keys)}' for ch, keys in track.items())})" for bone, track in layer["tracks"].items()) or "no keys"
        lines.append(f"Layer {index} '{layer['name']}' ({layer['mode']}, weight {layer['weight']}): {keyed}")
    lines.append("Modifiers: " + (json.dumps(doc["modifiers"]) if doc["modifiers"] else "none"))
    lines.append("Markers: " + (", ".join(f"{m['name']} @ frame {m['f']}" for m in doc["markers"]) or "none"))
    return "\n".join(lines)


def apply_ops(ws_dir: Path, asset: str, name: str, ops: list[Any], source: str = "") -> dict[str, Any]:
    """Edit a motion (creating it from `source` if it doesn't exist) with a list of small operations, then save it.

    set_key {bone, frame, euler: [x, y, z] degrees | rotation: [x, y, z, w] | position: [x, y, z], layer?, interp?}
    delete_keys {bone, layer?} · add_layer {name, mode} · add_modifier {type, …} · clear_modifiers
    add_marker {frame, name, audio?} · clear_markers · set {frames?, fps?, loop?}
    """
    from forge import model_info
    from forge.asset_studio import resolve_rel

    path = motion_path(ws_dir, asset, name)
    if path.is_file():
        doc = clean_doc(json.loads(path.read_text(encoding="utf-8")))
    elif source:
        clips = (model_info.describe(resolve_rel(ws_dir, source)) or {}).get("clips") or []
        doc = clean_doc({"source": source, "base_clip": 0 if clips else None, "frames": max(1, round(clips[0]["seconds"] * 30)) if clips else 60,
                         "layers": [{"name": "Tess", "mode": "additive" if clips else "override"}]})
    else:
        raise FileNotFoundError(f"No motion '{name}' on this asset. Pass \"source\" (a rigged .glb in the workspace) to create it.")
    bones = set(_bone_names(ws_dir, doc["source"]))
    for op in ops:
        if not isinstance(op, dict):
            raise ValueError("Each op must be an object with an \"op\" name.")
        kind = op.get("op")
        if kind == "set":
            doc.update({k: op[k] for k in ("frames", "fps", "loop") if k in op})
            doc.pop("range", None)
        elif kind == "add_layer":
            doc["layers"].append({"name": str(op.get("name") or "Layer"), "mode": op.get("mode") or "additive"})
        elif kind in ("set_key", "delete_keys"):
            bone = str(op.get("bone") or "")
            if bone not in bones:
                raise ValueError(f"No bone '{bone}'. Bones: {', '.join(sorted(bones))}")
            index = int(op.get("layer", len(doc["layers"]) - 1))
            if not 0 <= index < len(doc["layers"]):
                raise ValueError(f"No layer {index}.")
            tracks = doc["layers"][index].setdefault("tracks", {})
            if kind == "delete_keys":
                tracks.pop(bone, None)
                continue
            frame = int(op.get("frame", 0))
            if "position" in op:
                channel, value = "t", _floats(op["position"], 3)
            else:
                channel, value = "r", _euler_quat(op["euler"]) if "euler" in op else _floats(op.get("rotation"), 4)
            keys = [k for k in tracks.setdefault(bone, {}).setdefault(channel, []) if k.get("f") != frame]
            keys.append({"f": frame, "v": value, "i": str(op.get("interp") or "smooth")})
            tracks[bone][channel] = keys
        elif kind == "add_modifier":
            doc["modifiers"].append({k: v for k, v in op.items() if k != "op"})
        elif kind == "clear_modifiers":
            doc["modifiers"] = []
        elif kind == "add_marker":
            doc["markers"].append({"f": op.get("frame", 0), "name": op.get("name"), "audio": op.get("audio") or ""})
        elif kind == "clear_markers":
            doc["markers"] = []
        else:
            raise ValueError(f"Unknown op '{kind}'.")
    return save(ws_dir, asset, name, doc)
