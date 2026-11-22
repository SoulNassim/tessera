"""Motion Studio: motion documents are validated, and baking splices a clip into the GLB without touching the model."""

import json
import math
import struct
from pathlib import Path

import pytest

from forge import asset_index, model_info, motion
from tests.rig_fixture import BONES, rigged_glb

NAMES = [b[0] for b in BONES]


def _workspace(tmp_path: Path, clip: bool = False) -> Path:
    ws = tmp_path
    (ws / "chars" / "ghoul" / "rig").mkdir(parents=True)
    (ws / "chars" / "ghoul.md").write_text("---\nkind: character\n---\n# Ghoul\n", encoding="utf-8")
    (ws / "chars" / "ghoul" / "rig" / "ghoul.glb").write_bytes(rigged_glb(clip))
    return ws


def _doc(**extra) -> dict:
    return {"source": "chars/ghoul/rig/ghoul.glb", "fps": 30, "frames": 30, "layers": [{"tracks": {
        "LeftArm": {"r": [{"f": 0, "v": [0, 0, 0, 2]}, {"f": 30, "v": [0, 0, 0.5, 0.5], "i": "step", "eo": 3}]}}}], **extra}


def _samples(frames: int = 31, fps: int = 30) -> tuple[list[float], list[dict]]:
    times = [i / fps for i in range(frames)]
    arm, hips, still = [], [], []
    for i in range(frames):
        angle = math.pi / 2 * i / (frames - 1)
        arm += [0, 0, math.sin(angle / 2), math.cos(angle / 2)]
        hips += [0, 1.0, i * 0.05]
        still += [0, 0, 0, 1]
    return times, [
        {"node": NAMES.index("LeftArm"), "path": "rotation", "values": arm},
        {"node": NAMES.index("Hips"), "path": "translation", "values": hips},
        {"node": NAMES.index("Head"), "path": "rotation", "values": still},
    ]


def test_clean_doc_normalises_keys() -> None:
    doc = motion.clean_doc(_doc(markers=[{"f": 99, "name": " footstep "}, {"f": 3, "name": ""}], ik={"horror": 1, "chains": [{"root": "a", "mid": "b", "tip": "c"}, {"root": "a"}]}))
    keys = doc["layers"][0]["tracks"]["LeftArm"]["r"]
    assert keys[0]["v"] == [0, 0, 0, 1]  # normalised
    assert keys[1]["i"] == "step" and keys[1]["eo"] == 1  # ease clamped to 0..1
    assert math.isclose(sum(v * v for v in keys[1]["v"]), 1, abs_tol=1e-5)
    assert doc["markers"] == [{"f": 30, "name": "footstep", "audio": ""}]  # clamped into the clip; the unnamed one is dropped
    assert doc["ik"] == {"horror": True, "chains": [{"name": "c", "root": "a", "mid": "b", "tip": "c", "flip": False}]}
    with pytest.raises(ValueError):
        motion.clean_doc({"frames": 10})
    with pytest.raises(ValueError):
        motion.clean_doc(_doc(layers=[{"tracks": {"x": {"r": [{"f": 0, "v": [0, 0, 0, 0]}]}}}]))


def test_save_read_and_list(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    saved = motion.save(ws, "chars/ghoul.md", "Creepy Walk", _doc())
    assert saved["name"] == "creepy_walk"
    assert (ws / "chars" / "ghoul" / "motion" / "creepy_walk.json").is_file()
    assert motion.read(ws, "chars/ghoul.md", "creepy_walk")["frames"] == 30
    rigs = motion.home(ws, asset_index._rows(ws))
    assert [r["asset"] for r in rigs] == ["chars/ghoul.md"]
    assert rigs[0]["sources"][0] == {"path": "chars/ghoul/rig/ghoul.glb", "label": "Bind pose", "kind": "rig", "seconds": 0.0, "made_here": False}
    assert rigs[0]["motions"][0]["name"] == "creepy_walk"
    motion.delete(ws, "chars/ghoul.md", "creepy_walk")
    with pytest.raises(FileNotFoundError):
        motion.read(ws, "chars/ghoul.md", "creepy_walk")


def test_splice_keeps_the_model_bytes_and_drops_still_tracks() -> None:
    source = rigged_glb()
    times, tracks = _samples()
    out, kept = motion.splice_clip(source, "lurch", times, tracks)
    assert kept == 2  # the head never leaves its rest pose
    before, bin_before = motion.split_glb(source)
    after, bin_after = motion.split_glb(out)
    assert bin_after[: len(bin_before)] == bin_before  # mesh, skin and weights are byte-identical
    for key in ("meshes", "materials", "skins", "nodes", "scenes"):
        assert after[key] == before[key]
    assert after["accessors"][: len(before["accessors"])] == before["accessors"]
    (anim,) = after["animations"]
    assert anim["name"] == "lurch"
    assert {(c["target"]["node"], c["target"]["path"]) for c in anim["channels"]} == {(NAMES.index("LeftArm"), "rotation"), (NAMES.index("Hips"), "translation")}
    time_acc = after["accessors"][anim["samplers"][0]["input"]]
    assert time_acc["count"] == 31 and time_acc["min"] == [0.0] and math.isclose(time_acc["max"][0], 1.0, abs_tol=1e-6)
    view = after["bufferViews"][after["accessors"][anim["samplers"][0]["output"]]["bufferView"]]
    last = struct.unpack_from("<4f", bin_after, view["byteOffset"] + view["byteLength"] - 16)
    assert math.isclose(last[2], math.sin(math.pi / 4), abs_tol=1e-5)
    assert after["buffers"][0]["byteLength"] == len(bin_after)
    assert struct.unpack_from("<I", out, 8)[0] == len(out)


def test_splice_replaces_an_existing_clip_without_leaving_its_data() -> None:
    plain, with_clip = rigged_glb(), rigged_glb(clip=True)
    times, tracks = _samples()
    a, _ = motion.splice_clip(plain, "lurch", times, tracks)
    b, _ = motion.splice_clip(with_clip, "lurch", times, tracks)
    assert a == b  # the old "wave" clip and its accessors are gone, not orphaned
    assert [x["name"] for x in motion.split_glb(b)[0]["animations"]] == ["lurch"]


def test_splice_rejects_bad_tracks() -> None:
    times, tracks = _samples()
    with pytest.raises(ValueError):
        motion.splice_clip(rigged_glb(), "x", times, [{"node": 999, "path": "rotation", "values": tracks[0]["values"]}])
    with pytest.raises(ValueError):
        motion.splice_clip(rigged_glb(), "x", times, [{"node": 0, "path": "rotation", "values": [0, 0, 0, 1]}])
    with pytest.raises(ValueError):
        motion.splice_clip(b"not a glb at all, sorry", "x", times, tracks)


def test_bake_writes_the_clip_and_the_index_lists_it(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    motion.save(ws, "chars/ghoul.md", "lurch", _doc(loop=False, markers=[{"f": 15, "name": "footstep"}]))
    times, tracks = _samples()
    result = motion.bake(ws, "chars/ghoul.md", "lurch", {"times": times, "tracks": tracks, "root_speed": 1.5})
    clip = ws / "chars" / "ghoul" / "animations" / "lurch.glb"
    assert clip.is_file() and result["baked"]["clip"] == "chars/ghoul/animations/lurch.glb"
    assert model_info.describe(clip)["clips"] == [{"name": "lurch", "seconds": 1.0}]
    assert (ws / "chars" / "ghoul" / "rig" / "ghoul.glb").read_bytes() == rigged_glb()  # the rig is never written to
    row = next(r for r in asset_index._rows(ws) if r["rel"] == "chars/ghoul.md")
    (entry,) = row["animations"]
    assert entry["loop"] is False and entry["loop_source"] == "set in Motion Studio"
    assert entry["root_speed"] == 1.5 and entry["events"] == [{"name": "footstep", "time": 0.5}]
    assert asset_index._clip_text(entry) == "lurch (once, 1 s, root moves 1.5 m/s, events: footstep @ 0.5 s)"
    assert json.loads((ws / "chars" / "ghoul" / "motion" / "lurch.json").read_text())["baked"]["frames"] == 31
    # Saving again from the page keeps the record of the bake.
    assert motion.save(ws, "chars/ghoul.md", "lurch", _doc())["baked"]["root_speed"] == 1.5


def test_modifiers_are_checked_and_sounds_are_listed(tmp_path: Path) -> None:
    doc = motion.clean_doc(_doc(modifiers=[
        {"type": "twitch", "amount": 999, "set": "branch", "root": "Head"}, {"type": "reverse"}, {"type": "quantize", "step": 0, "on": False},
        {"type": "stride", "stride": 1.5}, {"type": "clamp", "lock": 1}, {"type": "explode"}, "nope"]))
    assert doc["modifiers"] == [
        {"type": "twitch", "on": True, "amount": 180, "speed": 8, "seed": 1, "set": "branch", "root": "Head"},
        {"type": "reverse", "on": True, "set": "legs"},
        {"type": "quantize", "on": False, "step": 1, "set": "all"},
        {"type": "stride", "on": True, "stride": 1.5, "speed": 1},
        {"type": "clamp", "on": True, "lock": True},
    ]
    ws = _workspace(tmp_path)
    (ws / "sfx").mkdir()
    (ws / "sfx" / "bone_crack.wav").write_bytes(b"RIFF")
    (ws / ".trash").mkdir()
    (ws / ".trash" / "old.mp3").write_bytes(b"x")
    assert motion.list_sounds(ws) == [{"path": "sfx/bone_crack.wav", "name": "bone_crack"}]


def test_tess_ops_create_and_edit_a_motion(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    doc = motion.apply_ops(ws, "chars/ghoul.md", "creep", [
        {"op": "set_key", "bone": "Head", "frame": 0, "euler": [90, 0, 0]},
        {"op": "add_modifier", "type": "twitch", "set": "branch", "root": "Head", "amount": 40},
        {"op": "add_modifier", "type": "reverse"}, {"op": "add_marker", "frame": 12, "name": "footstep"}], source="chars/ghoul/rig/ghoul.glb")
    key = doc["layers"][0]["tracks"]["Head"]["r"][0]
    assert math.isclose(key["v"][0], math.sin(math.pi / 4), abs_tol=1e-5) and math.isclose(key["v"][3], math.cos(math.pi / 4), abs_tol=1e-5)
    assert [m["type"] for m in doc["modifiers"]] == ["twitch", "reverse"] and doc["markers"][0]["name"] == "footstep"
    text = motion.describe_motion(ws, "chars/ghoul.md", "creep")
    assert "LeftForeArm" in text and "Head (r:1)" in text
    with pytest.raises(ValueError):
        motion.apply_ops(ws, "chars/ghoul.md", "creep", [{"op": "set_key", "bone": "Tentacle", "frame": 0, "euler": [0, 0, 0]}])
    with pytest.raises(FileNotFoundError):
        motion.apply_ops(ws, "chars/ghoul.md", "missing", [{"op": "clear_markers"}])


def test_tess_reaches_the_motion_tool_through_the_chat(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from forge.agent.workspace_agent import CHAT_PROTOCOL, WorkspaceAgent

    ws = _workspace(tmp_path)
    agent = WorkspaceAgent.__new__(WorkspaceAgent)
    monkeypatch.setattr(agent, "_ws", lambda project: ws, raising=False)
    out = agent.run_tool("p", {"tool": "motion", "asset": "chars/ghoul.md", "name": "creep", "source": "chars/ghoul/rig/ghoul.glb",
                               "ops": [{"op": "set_key", "bone": "LeftArm", "frame": 10, "euler": [0, 0, 45]}]})
    assert out["changed"] is True and "LeftArm (r:1)" in out["result"]
    read = agent.run_tool("p", {"tool": "motion", "asset": "chars/ghoul.md", "name": "creep"})
    assert read["changed"] is False and "60 frames" in read["result"]
    assert '"tool": "motion"' in CHAT_PROTOCOL
