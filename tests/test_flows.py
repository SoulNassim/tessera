"""Node Studio: workflows are checked, never pay for the same thing twice, wait to be chosen from, and save as assets."""

import json
import time
from pathlib import Path
from typing import Any

import pytest
from PIL import Image, ImageDraw

from forge import asset_studio, flow_draft, flow_models, flow_nodes, flow_steps, flows
from forge.blueprint_contract import split_frontmatter


def _picture(path: Path, colour: str = "red", size: int = 96) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    ImageDraw.Draw(im).ellipse((size // 4, size // 4, size * 3 // 4, size * 3 // 4), fill=colour)
    im.save(path)
    return path


def _doc(*steps: tuple, wires: list[tuple[str, str, str]] = ()) -> dict[str, Any]:
    return flows.from_steps("Test", list(steps), list(wires))


class Studio:
    """Stands in for the generators: draws a new picture for every request and remembers what was asked."""

    def __init__(self, ws: Path) -> None:
        self.ws, self.requests, self.fail = ws, [], ""

    async def __call__(self, request: dict[str, Any]) -> list[str]:
        self.requests.append(request)
        if self.fail and self.fail in request["prompt"]:
            raise RuntimeError("The artist said no.")
        folder = (self.ws / request["asset"]).with_suffix("") / "candidates"
        made = []
        for _ in range(request.get("count") or 1):
            made.append(flows.rel_to(self.ws, _picture(folder / f"c{len(list(folder.glob('*'))) if folder.is_dir() else 0}.png")))
        return made


async def _run(ws: Path, flow_id: str, doc: dict[str, Any], studio: Studio, target: str = "") -> tuple[str, dict[str, dict[str, Any]]]:
    said: dict[str, dict[str, Any]] = {}

    async def notify(event: dict[str, Any]) -> None:
        said[event["node"]] = event["step"]

    return await flows.Run(ws, flow_id, doc, studio, notify, target).go(), said


# ---------- documents ----------

def test_clean_doc_drops_what_cannot_be_right() -> None:
    doc = flows.clean_doc({"name": "  ", "nodes": [
        {"id": "a", "type": "idea", "x": "nan", "fields": {"text": "frog", "evil": 1}}, {"id": "a", "type": "idea"}, {"id": "b", "type": "draw", "fields": {"count": 99, "kind": "spaceship"}},
        {"id": "c", "type": "cutout"}, {"id": "d", "type": "cutout"}, {"id": "x y", "type": "idea"}, {"id": "z", "type": "nope"}, "junk"],
        "edges": [{"from": "a", "to": "b", "in": "text"}, {"from": "a", "to": "c", "in": "picture"}, {"from": "b", "to": "c", "in": "picture"},
                  {"from": "c", "to": "d", "in": "picture"}, {"from": "d", "to": "c", "in": "picture"}, {"from": "gone", "to": "b", "in": "text"}, {"from": "b", "to": "d", "in": "picture"}]})
    assert [n["id"] for n in doc["nodes"]] == ["a", "b", "c", "d"] and doc["name"] == "Workflow"
    assert doc["nodes"][0]["fields"] == {"text": "frog"} and doc["nodes"][0]["x"] == 0
    assert doc["nodes"][1]["fields"]["count"] == 4 and doc["nodes"][1]["fields"]["kind"] == "auto"
    # The wrong kind and the loop are gone; the newer wire into a one-wire input replaced the older.
    assert {(e["from"], e["to"]) for e in doc["edges"]} == {("a", "b"), ("b", "c"), ("b", "d")}
    with pytest.raises(ValueError):
        flows.clean_doc([])


def test_every_template_is_whole_and_every_step_is_described() -> None:
    for t in flow_nodes.TEMPLATES:
        doc = flows.from_template(t["id"])
        assert len(doc["nodes"]) == len(t["steps"]) and len(doc["edges"]) == len(t["wires"]), t["id"]
        assert doc["nodes"][-1]["type"] == "save"
    runnable = {k for k, n in flow_nodes.NODES.items() if n["inputs"]} - {"pick", "save"}
    assert runnable == set(flow_steps.STEPS)
    for kind, node in flow_nodes.NODES.items():
        assert node["blurb"] and node["help"] and node["label"], kind
        assert flow_nodes.clean_fields(kind, flow_nodes.default_fields(kind)) == flow_nodes.default_fields(kind)


def test_save_list_duplicate_delete_restore(tmp_path: Path) -> None:
    made = flows.create(tmp_path, {"name": "Frog Knight!", "nodes": [{"id": "a", "type": "idea", "fields": {"text": "frog"}}]})
    assert made["id"] == "frog-knight" and flows.create(tmp_path, {"name": "Frog knight"})["id"] == "frog-knight-2"
    assert "out" in (tmp_path / ".flows" / ".gitignore").read_text()
    assert flows.read(tmp_path, "frog-knight")["nodes"][0]["fields"]["text"] == "frog"
    assert flows.duplicate(tmp_path, "frog-knight")["name"] == "Frog Knight! copy"
    trashed = flows.delete(tmp_path, "frog-knight")
    assert "frog-knight" not in [f["id"] for f in flows.list_flows(tmp_path)]
    flows.restore(tmp_path, "frog-knight", trashed)
    assert flows.read(tmp_path, "frog-knight")["name"] == "Frog Knight!"
    with pytest.raises(ValueError):
        flows.restore(tmp_path, "other", "chars/hero")
    for bad in ("../etc", "", "A b"):
        with pytest.raises(ValueError):
            flows.flow_dir(tmp_path, bad)


def test_own_files_are_checked(tmp_path: Path) -> None:
    flow = flows.create(tmp_path, {"name": "f"})["id"]
    data = _picture(tmp_path / "p.png").read_bytes()
    first = flows.add_file(tmp_path, flow, "../My Frog.PNG", data)
    assert first == ".flows/f/in/My-Frog.png" and flows.add_file(tmp_path, flow, "My Frog.png", data) == first
    for name, junk in (("x.png", b"nope"), ("x.glb", b"nope"), ("x.exe", data)):
        with pytest.raises(ValueError):
            flows.add_file(tmp_path, flow, name, junk)


# ---------- a sentence ----------

@pytest.mark.parametrize(("text", "steps"), [
    ("make a 3d knight that walks and attacks", ["idea", "draw", "pick", "make3d", "rig", "animate", "save"]),
    ("item icons: sword, shield and bow", ["list", "draw", "icons", "save"]),
    ("turn my drawing into a 3d model", ["my_picture", "cutout", "make3d", "save"]),
    ("a pixel art slime", ["idea", "pixel", "pick", "save"]),
    ("seamless mossy stone texture", ["idea", "draw", "tile", "save"]),
    ("the sound of a creaky door", ["idea", "sound", "save"]),
    ("a dragon in different versions", ["idea", "vary", "draw", "save"]),
])
def test_a_sentence_becomes_a_workflow(text: str, steps: list[str]) -> None:
    doc = flow_draft.guess(text)
    assert [n["type"] for n in doc["nodes"]] == steps
    assert len(doc["edges"]) >= len(steps) - 1


def test_the_list_in_a_sentence_becomes_the_lines() -> None:
    doc = flow_draft.guess("item icons: sword, shield and bow")
    assert doc["nodes"][0]["fields"]["lines"] == "sword\nshield\nbow"
    moves = next(n for n in flow_draft.guess("a 3d orc that runs and attacks")["nodes"] if n["type"] == "animate")
    assert moves["fields"]["moves"] == ["Run", "Attack"]


@pytest.mark.asyncio
async def test_a_bad_answer_from_the_model_falls_back_to_the_words() -> None:
    async def good(**_: Any) -> dict[str, Any]:
        return {"text": 'Sure: {"name": "Frog", "steps": [{"id": "a", "type": "idea", "fields": {"text": "a frog"}}, {"id": "b", "type": "draw"}], "wires": [["a", "b", "text"]]}'}

    async def bad(**_: Any) -> dict[str, Any]:
        return {"text": "I would rather not."}

    assert (await flow_draft.draft("a frog", good))["by"] == "tess"
    assert (await flow_draft.draft("a frog", bad))["by"] == "words"
    with pytest.raises(ValueError):
        await flow_draft.draft("  ", None)


@pytest.mark.parametrize(("words", "kind"), [("a frog knight", "character"), ("a dragon chest", "prop"), ("red health potion", "item"), ("a slime with a tiny crown", "creature"),
                                              ("a knight holding a sword", "character"), ("blob", "")])
def test_the_words_say_what_kind_of_thing_it_is(words: str, kind: str) -> None:
    assert flow_nodes.kind_of(words) == kind


# ---------- checking ----------

def test_problems_are_sentences_with_a_fix(tmp_path: Path) -> None:
    doc = _doc(("a", "idea", {}), ("d", "draw", {}), ("m", "make3d", {}), ("s", "save", {}), wires=[("a", "d", "text"), ("m", "s", "any")])
    flow = flows.create(tmp_path, doc)["id"]
    seen = flows.check(tmp_path, flow, doc)
    fixes = {p["node"]: p for p in seen["problems"]}
    assert fixes["a"]["fix"] == "field" and fixes["a"]["field"] == "text"
    assert fixes["m"] == {"node": "m", "text": "Needs a picture.", "fix": "input", "input": "picture", "type": "picture"}
    assert seen["steps"]["s"]["status"] == "blocked" and seen["steps"]["d"]["status"] == "blocked"
    # Only what leads to a step counts when it is run on its own.
    assert [p["node"] for p in flows.check(tmp_path, flow, doc, "d")["problems"]] == ["a"]


def test_the_price_counts_every_line_and_only_what_is_left(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(flows, "job_cost", lambda node: (0.1 * node["fields"].get("count", 1), ""))
    doc = _doc(("a", "list", {"lines": "- frog\n- toad\nfrog"}), ("d", "draw", {"count": 2}), ("m", "make3d", {}), wires=[("a", "d", "text"), ("d", "m", "picture")])
    flow = flows.create(tmp_path, doc)["id"]
    seen = flows.check(tmp_path, flow, doc)
    assert seen["counts"] == {"image": 4, "3d": 4} and seen["usd"] == pytest.approx(0.8)
    assert seen["steps"]["m"]["advice"]["fix"] == "pick"


def test_without_an_account_the_step_says_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = flows.load_config()
    cfg.demo_mode = False
    monkeypatch.setattr(flows, "load_config", lambda: cfg)
    doc = _doc(("a", "idea", {"text": "frog"}), ("d", "draw", {}), wires=[("a", "d", "text")])
    flow = flows.create(tmp_path, doc)["id"]
    monkeypatch.setattr(asset_studio, "default_image_model", lambda cfg: "gemini")
    monkeypatch.setattr(asset_studio, "list_image_models", lambda: [{"id": "gemini", "available": False, "price": 1}])
    assert flows.check(tmp_path, flow, doc)["problems"][0]["fix"] == "settings"


# ---------- the AI model of a step ----------

def _real(monkeypatch: pytest.MonkeyPatch, **keys: str) -> Any:
    """Settings outside demo mode with only these keys; nothing is ever sent."""
    from forge import game_tools

    cfg = flows.load_config().model_copy(update={"demo_mode": False, "default_3d_provider": "meshy", "default_3d_service_model": ""})
    monkeypatch.setattr(type(cfg), "get_key", lambda self, name, logins=True: keys.get(name, ""))
    for module in (flows, asset_studio, flow_steps, game_tools):
        monkeypatch.setattr(module, "load_config", lambda: cfg)
    return cfg


def test_every_paid_step_has_its_model_on_the_card() -> None:
    for kind, spec in flow_nodes.NODES.items():
        own = [f for f in spec["fields"] if f["kind"] == "maker"]
        # Moves come from whoever made the skeleton, so that step has no choice of its own.
        assert bool(own) == (bool(spec.get("paid")) and kind != "animate"), kind
        assert not any(f.get("more") for f in own)


def test_results_made_before_a_step_had_its_model_are_still_there() -> None:
    doc = flows.clean_doc(_doc(("p", "my_picture", {}), ("m", "make3d", {}), wires=[("p", "m", "picture")]))
    node = doc["nodes"][1]
    before = {"detail": "game", "texture": True}  # all the step had in 1.1.0
    assert node["fields"]["model"] == "" and flow_nodes.key_fields(node) == before
    node["fields"]["model"] = "tripo:v3.1-20260211"
    assert flow_nodes.key_fields(node) == {**before, "model": "tripo:v3.1-20260211"}
    # Drawing always had one, so its empty choice was always part of the key.
    assert flow_nodes.key_fields(flows.clean_doc(_doc(("d", "draw", {})))["nodes"][0])["model"] == ""


@pytest.mark.asyncio
async def test_the_chosen_model_makes_it_and_going_back_is_free(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FORGE_DEMO_MODE", "1")
    studio = Studio(tmp_path)

    def doc(model: str) -> dict[str, Any]:
        return _doc(("a", "idea", {"text": "frog"}), ("d", "draw", {"model": model}), ("v", "views", {}), wires=[("a", "d", "text"), ("d", "v", "picture")])

    flow = flows.create(tmp_path, doc(""))["id"]
    await _run(tmp_path, flow, doc("meshy:nano-banana-pro"), studio)
    assert [r["action"] for r in studio.requests] == ["candidates", "views"]
    assert studio.requests[0]["model"] == "meshy:nano-banana-pro" != studio.requests[1]["model"]
    assert flows.check(tmp_path, flow, doc("gemini-3-pro-image"))["counts"]["image"]
    assert flows.check(tmp_path, flow, doc("meshy:nano-banana-pro"))["left"] == 0


@pytest.mark.asyncio
async def test_each_step_sends_its_own_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FORGE_DEMO_MODE", "1")
    studio = Studio(tmp_path)
    picture = flows.rel_to(tmp_path, _picture(tmp_path / "pics" / "frog.png"))
    doc = _doc(("p", "my_picture", {"path": picture}), ("c", "change", {"idea": "a red cape", "model": "gemini-3-pro-image"}),
               ("v", "views", {"model": "gemini-3.1-flash-image"}), ("x", "pixel", {"idea": "slime", "model": "meshy:gpt-image-2"}),
               ("m", "make3d", {"model": "tripo:P1-20260311"}), ("s", "sound", {"idea": "a door", "kind": "sfx", "model": "stability_audio:sfx"}),
               ("t", "sound", {"idea": "a song", "kind": "music", "model": "stability_audio:sfx"}),
               wires=[("p", "c", "picture"), ("p", "v", "picture"), ("p", "m", "picture")])
    flow = flows.create(tmp_path, doc)["id"]
    await _run(tmp_path, flow, doc, studio)
    sent = {}
    for r in studio.requests:
        sent[r["kind"] if r.get("audio") else "pixel" if "slime" in r["prompt"] else r["action"]] = r
    assert (sent["edit"]["model"], sent["views"]["model"], sent["pixel"]["model"]) == ("gemini-3-pro-image", "gemini-3.1-flash-image", "meshy:gpt-image-2")
    assert sent["make_3d"]["model"] == "tripo:P1-20260311" and sent["make_3d"]["engine"] == "tripo"
    assert sent["make_3d"]["settings"]["model"] == "P1-20260311" and sent["make_3d"]["settings"]["face_limit"] == 12000
    assert sent["sfx"]["model"] == "stability_audio:sfx"
    assert sent["music"]["model"].endswith(":music")  # a model for another kind of sound doesn't count


@pytest.mark.asyncio
async def test_a_skeleton_comes_from_the_chosen_service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _real(monkeypatch, meshy="k", tripo="k")
    studio = Studio(tmp_path)
    (tmp_path / "frog.glb").write_bytes(b"glTF" + b"\0" * 40)
    for body, model in (("biped", "tripo"), ("biped", ""), ("quadruped", "meshy")):
        doc = _doc(("m", "my_model", {"path": "frog.glb"}), ("r", "rig", {"model": model, "body": body}), wires=[("m", "r", "model")])
        _, said = await _run(tmp_path, flows.create(tmp_path, doc)["id"], doc, studio)
    assert [(r["engine"], r["settings"]["engine"], r["model"]) for r in studio.requests] == [("tripo", "tripo", "tripo:rigging"), ("meshy", "meshy", "meshy:rigging")]
    assert "Choose Tripo" in said["r"]["error"]  # nothing is sent that can't work


@pytest.mark.asyncio
async def test_a_picked_3d_model_goes_to_its_own_service(monkeypatch: pytest.MonkeyPatch) -> None:
    from forge.server.app import _ws_dir, actions

    ws = _ws_dir("makers")
    (ws / "frog.md").write_text("---\nkind: creature\n---\n# Frog\n", encoding="utf-8")
    source = flows.rel_to(ws, _picture(ws / "frog" / "candidates" / "frog.png"))
    asked: list[tuple[str, dict[str, Any]]] = []

    async def generate(**kw: Any) -> Any:
        asked.append((kw["provider_id"], kw["params"]))
        raise RuntimeError("enough")

    monkeypatch.setattr(actions.get_executor("makers"), "_generate_single_asset", generate)
    for model in ("tripo:P1-20260311", "meshy:meshy-6", "", "meshy:nano-banana-pro"):
        with pytest.raises(RuntimeError, match="enough"):
            await asset_studio.run_action(actions, "makers", asset_studio.build_request(ws, "frog.md", "make_3d", source=source, model=model))
    assert [(who, p.get("model") or p.get("ai_model")) for who, p in asked] == [
        ("tripo", "P1-20260311"), ("meshy", "meshy-6"), ("meshy", "meshy-7.1"), ("meshy", "meshy-7.1")]  # an image model is not a 3D one


def test_a_model_without_its_account_says_so_and_the_price_follows_the_choice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _real(monkeypatch, meshy="k")

    def seen(model: str, count: int = 1) -> dict[str, Any]:
        doc = _doc(("a", "idea", {"text": "frog"}), ("d", "draw", {"model": model, "count": count}), wires=[("a", "d", "text")])
        return flows.check(tmp_path, flows.create(tmp_path, doc)["id"], doc)

    assert seen("gemini-3-pro-image")["problems"][0] == {"node": "d", "text": "Connect Gemini, or choose another AI model.", "fix": "settings"}
    assert seen("svc:higgsfield/soul")["problems"][0]["text"] == "Sign in to Higgsfield, or choose another AI model."
    assert seen("local:gone")["problems"][0]["fix"] == "field"
    cheap, dear = seen("meshy:nano-banana", 2), seen("meshy:nano-banana-pro", 2)
    assert not cheap["problems"] and (cheap["usd"], dear["usd"]) == (0.06, 0.18)
    node = {"type": "make3d", "fields": {**flow_nodes.default_fields("make3d"), "model": "tripo:v3.1-20260211"}}
    assert flows.job_cost(node)[0] == pytest.approx(0.4) and flows.setup_problem(node)["fix"] == "settings"
    rig = {"type": "rig", "fields": {**flow_nodes.default_fields("rig"), "model": "tripo"}}
    assert flows.job_cost(rig)[0] == pytest.approx(0.25) and "Tripo" in flows.setup_problem(rig)["text"]


def test_the_page_is_given_every_choice(monkeypatch: pytest.MonkeyPatch) -> None:
    from forge import service_gen

    cfg = _real(monkeypatch, meshy="secret-key")
    monkeypatch.setattr(service_gen, "catalog", lambda kind: [{"id": f"svc:higgsfield/{kind}", "label": "Higgsfield · Soul"}])
    book = flow_models.book(cfg)
    assert book["automatic"]["image"].startswith("meshy:") and book["automatic"]["3d"] == "meshy:meshy-7.1" and book["automatic"]["rig"] == "meshy"
    ready = {kind: {o["who"] for o in options if o["ready"]} for kind, options in book["options"].items()}
    assert ready == {"image": {"Meshy", "Higgsfield"}, "3d": {"Meshy", "Higgsfield"}, "rig": {"Meshy"}, "sound": set()}
    assert all(o["name"] and o["who"] for options in book["options"].values() for o in options)
    assert "secret-key" not in json.dumps(book)
    # Demo mode never asks a signed-in service for anything.
    monkeypatch.setattr(service_gen, "catalog", lambda kind: pytest.fail("asked"))
    demo = flow_models.book(cfg.model_copy(update={"demo_mode": True}))
    assert demo["demo"] and not any(o["id"].startswith("svc:") for options in demo["options"].values() for o in options)


# ---------- running ----------

@pytest.mark.asyncio
async def test_a_new_line_is_the_only_thing_made_again(tmp_path: Path) -> None:
    studio = Studio(tmp_path)
    steps = [("a", "list", {"lines": "frog\ntoad"}), ("y", "style", {"preset": "hand_painted"}), ("d", "draw", {})]
    wires = [("a", "d", "text"), ("y", "d", "style")]
    flow = flows.create(tmp_path, _doc(*steps, wires=wires))["id"]
    result, said = await _run(tmp_path, flow, _doc(*steps, wires=wires), studio)
    assert result == "done" and said["d"]["status"] == "done" and len(said["d"]["values"]) == 2 and len(studio.requests) == 2
    assert all("painted" in r["prompt"].lower() for r in studio.requests)
    await _run(tmp_path, flow, _doc(*steps, wires=wires), studio)
    assert len(studio.requests) == 2  # nothing is paid for twice
    more = _doc(("a", "list", {"lines": "frog\nnewt\ntoad"}), *steps[1:], wires=wires)
    assert flows.check(tmp_path, flow, more)["counts"] == {"image": 1}
    result, said = await _run(tmp_path, flow, more, studio)
    assert len(studio.requests) == 3 and [v["name"] for v in said["d"]["values"]] == ["Frog", "Newt", "Toad"]
    # Asking for new ones makes new ones; going back brings the old result, free.
    again = json.loads(json.dumps(more))
    again["nodes"][2]["take"] = 1
    assert flows.check(tmp_path, flow, again)["counts"] == {"image": 3}
    assert flows.check(tmp_path, flow, more)["left"] == 0
    # Neither does a step added after it.
    further = json.loads(json.dumps(more))
    further["nodes"].append({"id": "m", "type": "make3d", "x": 0, "y": 0, "fields": {}})
    further["edges"].append({"from": "d", "to": "m", "in": "picture"})
    assert flows.check(tmp_path, flow, further)["counts"] == {"3d": 3}


@pytest.mark.asyncio
async def test_one_failure_does_not_stop_the_rest(tmp_path: Path) -> None:
    studio = Studio(tmp_path)
    studio.fail = "toad"
    doc = _doc(("a", "list", {"lines": "frog\ntoad"}), ("d", "draw", {}), ("c", "recolor", {"colours": ["Blue"]}), wires=[("a", "d", "text"), ("d", "c", "picture")])
    flow = flows.create(tmp_path, doc)["id"]
    result, said = await _run(tmp_path, flow, doc, studio)
    assert result == "failed" and said["d"]["status"] == "failed" and "Toad: The artist said no." in said["d"]["error"]
    assert len(said["c"]["values"]) == 1  # the frog carried on
    assert "said no" in flows.check(tmp_path, flow, doc)["steps"]["d"]["error"]
    studio.fail = ""
    assert (await _run(tmp_path, flow, doc, studio))[0] == "done" and len(studio.requests) == 3


@pytest.mark.asyncio
async def test_it_waits_to_be_chosen_from_then_saves_one_asset_per_idea(tmp_path: Path) -> None:
    studio = Studio(tmp_path)
    doc = _doc(("a", "list", {"lines": "frog\ntoad"}), ("d", "draw", {"kind": "creature", "count": 2}), ("p", "pick", {}), ("c", "cutout", {}), ("s", "save", {}),
               wires=[("a", "d", "text"), ("d", "p", "picture"), ("p", "c", "picture"), ("c", "s", "any")])
    (tmp_path / "enemies").mkdir()
    flow = flows.create(tmp_path, doc)["id"]
    result, said = await _run(tmp_path, flow, doc, studio)
    assert result == "choose" and said["c"]["status"] == "blocked" and len(said["p"]["groups"]) == 2
    assert flows.check(tmp_path, flow, doc)["choose"] == ["p"]
    doc["nodes"][2]["picked"] = {g["group"]: g["options"][1]["path"] for g in said["p"]["groups"]}
    result, said = await _run(tmp_path, flow, doc, studio)
    assert result == "done" and len(studio.requests) == 2
    assets = said["s"]["saved"]
    assert [a["asset"] for a in assets] == ["enemies/frog.md", "enemies/toad.md"]
    meta = split_frontmatter((tmp_path / "enemies/frog.md").read_text(encoding="utf-8"))[0]
    assert meta["kind"] == "creature" and meta["prompt"] == "frog" and (tmp_path / meta["winner"]).is_file() and "/edits/" in meta["winner"]
    assert len(list((tmp_path / "enemies/frog/candidates").glob("*.png"))) == 1  # the picked one, not the rest
    # Saving again adds to the same asset, and never over a picture the user chose.
    _picture(tmp_path / "enemies/frog/candidates/mine.png", "blue")
    asset_studio.update_asset(tmp_path, "enemies/frog.md", {"winner": "enemies/frog/candidates/mine.png"})
    doc["nodes"][2]["picked"] = {g["group"]: g["options"][0]["path"] for g in said["p"]["groups"]}
    _, said = await _run(tmp_path, flow, doc, studio)
    assert [a["asset"] for a in said["s"]["saved"]] == ["enemies/frog.md", "enemies/toad.md"]
    assert split_frontmatter((tmp_path / "enemies/frog.md").read_text(encoding="utf-8"))[0]["winner"].endswith("mine.png")
    assert flows.check(tmp_path, flow, doc)["left"] == 0


@pytest.mark.asyncio
async def test_free_steps_work_on_own_pictures(tmp_path: Path) -> None:
    sheet = Image.new("RGBA", (300, 150), (255, 255, 255, 255))
    ImageDraw.Draw(sheet).ellipse((20, 30, 110, 120), fill="red")
    ImageDraw.Draw(sheet).rectangle((190, 30, 280, 120), fill="green")
    sheet.save(tmp_path / "sheet.png")
    flow = flows.create(tmp_path, {"name": "f"})["id"]
    path = flows.add_file(tmp_path, flow, "sheet.png", (tmp_path / "sheet.png").read_bytes())
    doc = _doc(("i", "my_picture", {"path": path, "name": "Gems"}), ("x", "split", {"kind": "item"}), ("k", "icons", {"sizes": ["64", "32"]}), ("s", "save", {"section": "loot"}),
               wires=[("i", "x", "picture"), ("x", "k", "picture"), ("k", "s", "any")])
    studio = Studio(tmp_path)
    result, said = await _run(tmp_path, flow, doc, studio)
    assert result == "done" and not studio.requests
    assert len(said["x"]["values"]) == 2 and len(said["k"]["values"]) == 4 and len({v["path"] for v in said["k"]["values"]}) == 4
    assert [a["asset"] for a in said["s"]["saved"]] == ["loot/gems-1.md", "loot/gems-2.md"]
    for a in said["s"]["saved"]:
        folder = (tmp_path / a["asset"]).with_suffix("")
        assert len(list((folder / "icons").glob("*.png"))) == 2 and len(list((folder / "candidates").glob("*.png"))) == 1


def test_recolour_changes_the_main_colour_only() -> None:
    im = Image.new("RGBA", (40, 40), (200, 20, 20, 255))
    ImageDraw.Draw(im).rectangle((0, 0, 9, 39), fill=(90, 90, 90, 0))
    blue = flow_steps.recolour(im, "Blue")
    r, g, b, a = blue.getpixel((30, 30))
    assert b > 150 and b > r + 60 and a == 255 and blue.getpixel((2, 2))[3] == 0
    assert max(flow_steps.recolour(im, "Grey").getpixel((30, 30))[:3]) - min(flow_steps.recolour(im, "Grey").getpixel((30, 30))[:3]) < 40


def test_the_plainest_move_wins() -> None:
    library = [{"id": 5, "name": "Monster Walk With Limp"}, {"id": 1, "name": "Walking_Woman"}, {"id": 2, "name": "Idle"}, {"id": 9, "name": "Casual_Walk"}, {"id": 4, "name": "Horse Run", "rig_type": "quadruped"}]
    ids, names, missing = flow_steps.match_moves(["Idle", "Walk", "Run"], library)
    assert ids == [2, 1] and names == ["Idle", "Walk"] and missing == ["Run"]


def test_trial_results_stay_out_of_the_project(tmp_path: Path) -> None:
    from forge import overview

    page = tmp_path / ".flows" / "f" / "out" / "d" / "abc.md"
    page.parent.mkdir(parents=True)
    page.write_text("---\nkind: character\ntitle: Trial\n---\n# Trial\n", encoding="utf-8")
    (tmp_path / "chars").mkdir()
    (tmp_path / "chars" / "hero.md").write_text("---\nkind: character\n---\n# Hero\n", encoding="utf-8")
    assert "Trial" not in json.dumps(overview.build_overview(tmp_path, "p"), default=str)
    assert overview.build_overview(tmp_path, "p")["folders"][0]["assets"] == 1
    assert not asset_studio.key_art_asset(tmp_path, "T", "").startswith(".")


# ---------- the whole thing, in demo mode ----------

@pytest.mark.parametrize("template", ["character-3d", "item-set", "pixel-sprite", "ground", "sounds", "picture-3d", "versions"])
def test_templates_run_from_start_to_saved_assets(template: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    monkeypatch.setenv("FORGE_DEMO_MODE", "1")
    from forge.server.app import _ws_dir, app

    with TestClient(app, base_url="http://127.0.0.1:8420") as client:
        q = {"project": "flowtest"}
        home = client.get("/api/flows/home", params=q).json()
        assert home["flows"] == [] and len(home["catalogue"]["templates"]) == len(flow_nodes.TEMPLATES)
        doc = client.post("/api/flows/create", params=q, json={"template": template}).json()
        flow = doc["id"]
        for n in doc["nodes"]:
            if n["type"] == "idea":
                n["fields"]["text"] = "a grumpy frog knight"
            elif n["type"] == "list":
                n["fields"]["lines"] = "red potion\nblue potion"
            elif n["type"] == "vary":
                n["fields"]["lines"] = "on fire\nfrozen"
            elif n["type"] == "my_picture":
                up = client.post("/api/flows/upload", params={**q, "id": flow}, files={"file": ("frog.png", _picture(tmp_path / "frog.png").read_bytes())})
                n["fields"]["path"] = up.json()["path"]
        for _ in range(2):  # the second time round, what was asked has been chosen
            seen = client.post("/api/flows/save", params=q, json={"id": flow, "doc": doc}).json()["check"]
            assert not seen["problems"] and seen["demo"] and seen["usd"] == 0
            assert client.post("/api/flows/run", params=q, json={"id": flow}).json()["started"]
            while (read := client.get("/api/flows", params={**q, "id": flow}).json())["live"] is not None:
                time.sleep(0.05)
            errors = {k: v["error"] for k, v in read["check"]["steps"].items() if v.get("error")}
            assert not errors
            if not read["check"]["left"] and not read["check"]["choose"]:
                break
            for n in doc["nodes"]:
                if n["id"] in read["check"]["choose"]:
                    n["picked"] = {g["group"]: g["options"][0]["path"] for g in read["check"]["steps"][n["id"]]["groups"]}
        assert read["check"]["left"] == 0 and not read["check"]["choose"]
        saved = read["check"]["steps"]["save"]["saved"]
        assert saved
        ws_dir = _ws_dir("flowtest")
        for a in saved:
            assert (ws_dir / a["asset"]).is_file()
            files = [p for p in (ws_dir / a["asset"]).with_suffix("").rglob("*") if p.is_file()]
            assert files
            if template == "character-3d":
                assert {"candidates", "3d", "rig", "animations"} <= {p.parent.name for p in files}
        assert client.get("/api/flows/home", params=q).json()["flows"][0]["steps"]
        assert client.post("/api/flows/delete", params=q, json={"id": flow}).json()["trashed"]
