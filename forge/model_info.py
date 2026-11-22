"""What a game needs to place a model, read straight from its GLB / glTF: size, rig points and clip lengths.

No dependencies: only the JSON chunk is read. glTF stores the bounding box of every POSITION accessor (it is
required by the spec), so the model's size comes from those boxes moved through the node transforms. Skin joints
give named points for free on rigged characters (head, hands, feet), and animation samplers give clip lengths.

All coordinates are in the model's own units and axes, exactly as a game engine sees the file when it imports it.
"""

from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

# Which way the front of a model points, in the model's own axes (glTF: +Y up, front towards +Z).
FRONTS = ("+Z", "-Z", "+X", "-X")
DEFAULT_FRONT = "+Z"
# Names a user picks most when clicking points on a model; anything else is allowed too.
POINT_NAMES = ("light", "grip", "muzzle", "head", "hat", "seat", "socket", "spawn", "hinge", "flame")
POINT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

Matrix = tuple[float, ...]  # 16 numbers, column-major like glTF
IDENTITY: Matrix = (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)


def read_gltf(path: Path) -> dict[str, Any] | None:
    """The glTF JSON of a .glb (its first chunk) or a .gltf file, or None if it can't be read."""
    try:
        if path.suffix.lower() == ".gltf":
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        with path.open("rb") as handle:
            header = handle.read(20)
            if len(header) < 20 or header[:4] != b"glTF" or header[16:20] != b"JSON":
                return None
            length = int.from_bytes(header[12:16], "little")
            data = json.loads(handle.read(length))
            return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _multiply(a: Matrix, b: Matrix) -> Matrix:
    return tuple(sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4)) for col in range(4) for row in range(4))


def _local(node: dict[str, Any]) -> Matrix:
    matrix = node.get("matrix")
    if isinstance(matrix, list) and len(matrix) == 16:
        return tuple(float(v) for v in matrix)
    tx, ty, tz = (list(node.get("translation") or [0, 0, 0]) + [0, 0, 0])[:3]
    x, y, z, w = (list(node.get("rotation") or [0, 0, 0, 1]) + [0, 0, 0, 1])[:4]
    sx, sy, sz = (list(node.get("scale") or [1, 1, 1]) + [1, 1, 1])[:3]
    return (
        (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
        (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
        (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1,
    )


def _apply(m: Matrix, p: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = p
    return (m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14])


def _world_matrices(gltf: dict[str, Any]) -> dict[int, Matrix]:
    """World matrix of every node reachable from the default scene (or every root, if no scene is set)."""
    nodes = gltf.get("nodes") or []
    scenes = gltf.get("scenes") or []
    if scenes:
        scene = scenes[gltf.get("scene", 0)] if isinstance(gltf.get("scene", 0), int) and gltf.get("scene", 0) < len(scenes) else scenes[0]
        roots = list(scene.get("nodes") or [])
    else:
        children = {c for n in nodes for c in (n.get("children") or [])}
        roots = [i for i in range(len(nodes)) if i not in children]
    out: dict[int, Matrix] = {}
    stack = [(int(i), IDENTITY) for i in roots if isinstance(i, int) and 0 <= i < len(nodes)]
    while stack:
        index, parent = stack.pop()
        if index in out:
            continue  # a malformed file with a cycle
        world = _multiply(parent, _local(nodes[index]))
        out[index] = world
        stack.extend((c, world) for c in (nodes[index].get("children") or []) if isinstance(c, int) and 0 <= c < len(nodes))
    return out


def _r(value: float) -> float:
    return round(value, 4) + 0.0  # + 0.0 turns -0.0 into 0.0


def _point(p: tuple[float, float, float]) -> list[float]:
    return [_r(v) for v in p]


# Bone names differ per rigger (Meshy, Tripo, Mixamo, Blender), so each point is a pattern on the cleaned name.
_SIDE_R = re.compile(r"(^|[^a-z])r([^a-z]|$)|right")
_SIDE_L = re.compile(r"(^|[^a-z])l([^a-z]|$)|left")
_FINGERS = ("thumb", "index", "middle", "ring", "pinky", "little", "finger")


def _bone_role(name: str) -> str:
    low = name.lower().split(":")[-1].split("|")[-1]
    flat = re.sub(r"[^a-z]", "", low)
    if flat.endswith("head") and not any(w in flat for w in ("top", "end", "fore", "nub")):
        return "head"
    side = "r" if _SIDE_R.search(low) else "l" if _SIDE_L.search(low) else ""
    if not side:
        return ""
    if "hand" in flat and not any(w in flat for w in _FINGERS):
        return f"hand_{side}"
    if "foot" in flat or flat.endswith("ankle"):
        return f"foot_{side}"
    return ""


def _clip_seconds(gltf: dict[str, Any]) -> list[dict[str, Any]]:
    accessors = gltf.get("accessors") or []
    clips = []
    for index, anim in enumerate(gltf.get("animations") or []):
        length = 0.0
        for sampler in anim.get("samplers") or []:
            source = sampler.get("input")
            if isinstance(source, int) and source < len(accessors):
                top = accessors[source].get("max") or [0]
                length = max(length, float(top[0] if top else 0))
        clips.append({"name": str(anim.get("name") or f"clip {index + 1}"), "seconds": round(length, 3)})
    return clips


@lru_cache(maxsize=1024)
def _describe_cached(path: str, _mtime: int, _size: int) -> dict[str, Any] | None:
    gltf = read_gltf(Path(path))
    if gltf is None:
        return None
    accessors = gltf.get("accessors") or []
    meshes = gltf.get("meshes") or []
    nodes = gltf.get("nodes") or []
    worlds = _world_matrices(gltf)
    low = [math.inf] * 3
    high = [-math.inf] * 3
    for index, world in worlds.items():
        mesh = nodes[index].get("mesh")
        if not isinstance(mesh, int) or mesh >= len(meshes):
            continue
        # A skinned mesh is placed by its bones, not by its node; its bind pose is the file's own space.
        matrix = IDENTITY if "skin" in nodes[index] else world
        for prim in meshes[mesh].get("primitives") or []:
            source = (prim.get("attributes") or {}).get("POSITION")
            if not isinstance(source, int) or source >= len(accessors):
                continue
            lo, hi = accessors[source].get("min"), accessors[source].get("max")
            if not (isinstance(lo, list) and isinstance(hi, list) and len(lo) >= 3 and len(hi) >= 3):
                continue
            for corner in ((x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])):
                moved = _apply(matrix, tuple(float(v) for v in corner))  # type: ignore[arg-type]
                for axis in range(3):
                    low[axis] = min(low[axis], moved[axis])
                    high[axis] = max(high[axis], moved[axis])
    if math.isinf(low[0]):
        return None
    size = [high[i] - low[i] for i in range(3)]
    centre = [(high[i] + low[i]) / 2 for i in range(3)]
    joints = {j for skin in gltf.get("skins") or [] for j in (skin.get("joints") or []) if isinstance(j, int)}
    bones: dict[str, list[float]] = {}
    for joint in sorted(joints):
        if joint >= len(nodes) or joint not in worlds:
            continue
        role = _bone_role(str(nodes[joint].get("name") or ""))
        if role and role not in bones:
            m = worlds[joint]
            bones[role] = _point((m[12], m[13], m[14]))
    return {
        "size": [_r(v) for v in size],
        "min": [_r(v) for v in low],
        "max": [_r(v) for v in high],
        # Points every model gets: where it stands on the ground and the middle of its top.
        "auto_points": {"ground": _point((centre[0], low[1], centre[2])), "top": _point((centre[0], high[1], centre[2]))},
        "bone_points": bones,
        "bones": len(joints),
        "clips": _clip_seconds(gltf),
    }


def describe(path: Path) -> dict[str, Any] | None:
    """Size, bounds, automatic points, rig points and clips of a GLB / glTF model, or None if it can't be read."""
    try:
        stat = path.stat()
    except OSError:
        return None
    if path.suffix.lower() not in (".glb", ".gltf"):
        return None
    return _describe_cached(str(path.resolve()), stat.st_mtime_ns, stat.st_size)


# ---------- validation of what the viewer saves ----------

def clean_front(value: Any) -> str:
    text = str(value or "").strip().upper()
    if text in ("Z", "X"):
        text = "+" + text
    if text not in FRONTS:
        raise ValueError(f"front must be one of {', '.join(FRONTS)}.")
    return text


def clean_points(value: Any) -> dict[str, list[float]]:
    """{name: [x, y, z]} with lower-case names and finite numbers, at most 32 points."""
    if not isinstance(value, dict):
        raise ValueError("points must be a mapping of name to [x, y, z].")
    out: dict[str, list[float]] = {}
    for raw_name, coords in list(value.items())[:32]:
        name = str(raw_name).strip().lower().replace(" ", "_")
        if not POINT_NAME_RE.match(name):
            raise ValueError(f"'{raw_name}' is not a point name: use letters, digits, _ or -, up to 32 characters.")
        if name in ("ground", "top"):
            raise ValueError(f"'{name}' is measured by Tessera; pick another name.")
        if not (isinstance(coords, (list, tuple)) and len(coords) == 3):
            raise ValueError(f"Point '{name}' needs three numbers.")
        numbers = [float(v) for v in coords]
        if not all(math.isfinite(v) for v in numbers):
            raise ValueError(f"Point '{name}' has a number that isn't finite.")
        out[name] = [_r(v) for v in numbers]
    return out


# Clip names that loop in nearly every game, and ones that play once. Anything else is left for the user to say.
_LOOP_WORDS = ("idle", "walk", "run", "jog", "sprint", "strafe", "crouch", "swim", "fly", "hover", "breath", "loop",
               "cycle", "climb", "sneak", "march", "patrol", "dance", "float", "glide", "crawl", "drive")
_ONCE_WORDS = ("attack", "hit", "death", "die", "dead", "jump", "land", "shoot", "fire", "cast", "throw", "open",
               "close", "hurt", "damage", "dodge", "roll", "slash", "punch", "kick", "emote", "wave", "equip",
               "reload", "spawn", "fall", "stab", "swing", "block", "stun", "knock", "pickup", "pick", "use", "interact", "taunt", "victory")


def guess_loop(name: str) -> bool | None:
    # "walk_forward", "Attack01", "mixamo.com|Run": split into words, and a word may carry a suffix (walking, attack2).
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", name.split(":")[-1].split("|")[-1])
    tokens = re.sub(r"[^a-z]+", " ", spaced.lower()).split()
    if any(t.startswith(w) for t in tokens for w in _ONCE_WORDS):
        return False
    if any(t.startswith(w) for t in tokens for w in _LOOP_WORDS):
        return True
    return None


def clean_loops(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict):
        raise ValueError("anim_loops must be a mapping of clip file name to true or false.")
    return {str(k)[:120]: bool(v) for k, v in list(value.items())[:200]}
