"""A small rigged GLB made in code: a blocky biped with Mixamo-style bone names, one box skinned to each bone.

Demo mode rigs with it (no account, nothing spent), so Rig, Animate and Motion Studio can be tried for free; the tests use it too."""

from __future__ import annotations

import json
import struct

# name, parent, position relative to the parent (metres, +Y up, the figure faces +Z; its left is +X)
BONES = [
    ("Hips", None, (0, 1.0, 0)),
    ("Spine", "Hips", (0, 0.25, 0)),
    ("Head", "Spine", (0, 0.35, 0)),
    ("LeftArm", "Spine", (0.2, 0.25, 0)),
    ("LeftForeArm", "LeftArm", (0.28, 0, 0)),
    ("LeftHand", "LeftForeArm", (0.26, 0, 0)),
    ("RightArm", "Spine", (-0.2, 0.25, 0)),
    ("RightForeArm", "RightArm", (-0.28, 0, 0)),
    ("RightHand", "RightForeArm", (-0.26, 0, 0)),
    ("LeftUpLeg", "Hips", (0.1, -0.05, 0)),
    ("LeftLeg", "LeftUpLeg", (0, -0.45, 0.02)),
    ("LeftFoot", "LeftLeg", (0, -0.45, -0.02)),
    ("RightUpLeg", "Hips", (-0.1, -0.05, 0)),
    ("RightLeg", "RightUpLeg", (0, -0.45, 0.02)),
    ("RightFoot", "RightLeg", (0, -0.45, -0.02)),
]


def _box(lo: tuple[float, float, float], hi: tuple[float, float, float]) -> tuple[list[tuple[float, float, float]], list[int]]:
    corners = [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return corners, [i for a, b, c, d in faces for i in (a, b, c, a, c, d)]


def rigged_glb(clip: bool = False) -> bytes:
    """The biped as a .glb. With `clip`, it carries one animation ("wave") written at the end of the file."""
    names = [b[0] for b in BONES]
    world: dict[str, tuple[float, float, float]] = {}
    for name, parent, pos in BONES:
        base = world[parent] if parent else (0.0, 0.0, 0.0)
        world[name] = (base[0] + pos[0], base[1] + pos[1], base[2] + pos[2])
    positions: list[tuple[float, float, float]] = []
    joints: list[int] = []
    indices: list[int] = []
    for index, (name, _parent, _pos) in enumerate(BONES):
        child = next((world[n] for n, p, _ in BONES if p == name), None)
        a = world[name]
        b = child or (a[0], a[1] + (0.2 if name == "Head" else -0.08 if "Foot" in name else 0), a[2] + (0.15 if "Foot" in name else 0) + (0.08 if "Hand" in name else 0))
        pad = 0.05
        lo = tuple(min(a[i], b[i]) - pad for i in range(3))
        hi = tuple(max(a[i], b[i]) + pad for i in range(3))
        corners, tris = _box(lo, hi)  # type: ignore[arg-type]
        indices += [len(positions) + i for i in tris]
        positions += corners
        joints += [index] * len(corners)

    binary = b""
    views, accessors = [], []

    def add(data: bytes, component: int, kind: str, count: int, extra: dict | None = None, target: int | None = None) -> int:
        nonlocal binary
        binary += b"\0" * (-len(binary) % 4)
        view = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)}
        if target:
            view["target"] = target
        views.append(view)
        binary += data
        accessors.append({"bufferView": len(views) - 1, "componentType": component, "count": count, "type": kind, **(extra or {})})
        return len(accessors) - 1

    flat = [v for p in positions for v in p]
    bounds = {"min": [min(p[i] for p in positions) for i in range(3)], "max": [max(p[i] for p in positions) for i in range(3)]}
    a_pos = add(struct.pack(f"<{len(flat)}f", *flat), 5126, "VEC3", len(positions), bounds, 34962)
    a_joint = add(b"".join(struct.pack("<4B", j, 0, 0, 0) for j in joints), 5121, "VEC4", len(joints), None, 34962)
    a_weight = add(b"".join(struct.pack("<4f", 1, 0, 0, 0) for _ in joints), 5126, "VEC4", len(joints), None, 34962)
    a_index = add(struct.pack(f"<{len(indices)}H", *indices), 5123, "SCALAR", len(indices), None, 34963)
    inverse = b"".join(struct.pack("<16f", 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -world[n][0], -world[n][1], -world[n][2], 1) for n in names)
    a_ibm = add(inverse, 5126, "MAT4", len(names))

    nodes = []
    for name, _parent, pos in BONES:
        node = {"name": name, "translation": list(pos)}
        children = [names.index(n) for n, p, _ in BONES if p == name]
        if children:
            node["children"] = children
        nodes.append(node)
    nodes.append({"name": "Body", "mesh": 0, "skin": 0})
    gltf = {
        "asset": {"version": "2.0", "generator": "tessera-demo-rig"},
        "scene": 0,
        "scenes": [{"nodes": [0, len(BONES)]}],
        "nodes": nodes,
        "meshes": [{"name": "Body", "primitives": [{"attributes": {"POSITION": a_pos, "JOINTS_0": a_joint, "WEIGHTS_0": a_weight}, "indices": a_index, "material": 0}]}],
        "materials": [{"name": "Clay", "pbrMetallicRoughness": {"baseColorFactor": [0.72, 0.7, 0.78, 1], "metallicFactor": 0, "roughnessFactor": 0.8}, "extras": {"keep": "me"}}],
        "skins": [{"joints": list(range(len(BONES))), "inverseBindMatrices": a_ibm, "skeleton": 0}],
    }
    if clip:
        times = add(struct.pack("<3f", 0, 0.5, 1), 5126, "SCALAR", 3, {"min": [0], "max": [1]})
        s = 0.3826834
        c = 0.9238795
        values = add(struct.pack("<12f", 0, 0, 0, 1, 0, 0, s, c, 0, 0, 0, 1), 5126, "VEC4", 3)
        gltf["animations"] = [{"name": "wave", "samplers": [{"input": times, "output": values, "interpolation": "LINEAR"}],
                               "channels": [{"sampler": 0, "target": {"node": names.index("LeftArm"), "path": "rotation"}}]}]
    binary += b"\0" * (-len(binary) % 4)
    gltf["bufferViews"] = views
    gltf["accessors"] = accessors
    gltf["buffers"] = [{"byteLength": len(binary)}]
    text = json.dumps(gltf, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    return struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(binary), 0x004E4942) + binary
