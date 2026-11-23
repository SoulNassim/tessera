"""A Node Studio workflow from a sentence: Tess's model when one is connected, else the words themselves."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Awaitable, Callable

from forge.flow_nodes import NODES, kind_of
from forge.flow_steps import MOVE_WORDS
from forge.flows import from_steps, title_of

def _word(*words: str) -> re.Pattern[str]:
    return re.compile(rf"\b(?:{'|'.join(words)})\b", re.I)


SOUND = _word("sounds?", "sfx", "music", "voices?", "voice ?lines?", "song", "noises?", "audio", "footsteps?")
PIXEL = _word(r"pixel(?:ated)?(?:[ -]?art)?", "8-?bit", "16-?bit", "sprites?")
TEXTURE = _word("textures?", "tileable", "seamless", "materials?")
MINE = re.compile(r"\b(?:my|this|an? existing|the) (?:own )?(?:\w+ )?(?:picture|photo|drawing|sketch|image|concept|art|painting|sheet)\b|\bupload", re.I)
THREE_D = _word("3d", "3-d", "models?", "mesh", "glb")
MOVE = _word(r"animat\w*", "rig(?:ged)?", "skeleton", "walks?", "walking", "runs?", "running", "danc(?:es?|ing)", "attack(?:s|ing)?", "moves?", "moving")
ICON = _word("icons?", "inventory")
MANY = _word(r"\d+", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "set of", "pack of", "list of", "several", "some", "bunch of")
VERSIONS = re.compile(r"\b(?:versions?|variants?|variations?|(?:different|other|team|more) colou?rs?|recolou?r\w*)\b", re.I)
CUTOUT = re.compile(r"\b(?:remove|without|no|clear)\b.{0,12}\bbackground\b|\bcut ?out\b|\btransparent\b", re.I)
LEAD = re.compile(r"^(?:please |can you |could you |i want(?: to)? |i need |i'd like(?: to)? |help me )*(?:make|create|generate|build|draw|design|give|turn)?\s*(?:me |us )?"
                  r"(?:a workflow (?:that|to|for|which)\s*(?:makes?|creates?|turns?|draws?)?\s*)?(?:an? |some |the )?", re.I)
TAIL = re.compile(r"\s*(?:,|\band\b|\bthen\b|\bthat (?:can|is|walks?|runs?|moves?|attacks?|dances?)\b|\bwhich\b|\bas (?:a |an )?3d\b|\bin 3d\b|\binto\b|\bwith (?:a )?(?:skeleton|rig|animations?)\b|\bin (?:different|several|many)\b).*$", re.I)
OF = re.compile(r"^(?:(?:an? )?(?:3d(?: model| character| prop)?|model|picture|sounds?(?: effects?)?|icons?|textures?|pixel[ -]?art|sprites?)\s+(?:of|for)\s+|(?:(?:animated|rigged|3d|pixel[ -]?art)\s+)+)(?:an? |the )?", re.I)


def guess(text: str) -> dict[str, Any]:
    """The words say which steps are wanted, and the steps go in the one order that works."""
    text = text.strip()
    if not text:
        raise ValueError("Say what you want to make.")
    head, _, listed = text.partition(":")
    parts = [p for p in (p.strip(" .") for p in re.split(r",|;|\band\b|\n", listed)) if p]
    subject = LEAD.sub("", head if len(parts) > 1 else text).strip(" .")
    subject = TAIL.sub("", subject).strip(" .") or subject
    subject = OF.sub("", subject).strip() or text
    sound, pixel, mine = bool(SOUND.search(text)), bool(PIXEL.search(text)), bool(MINE.search(text))
    texture, icons, versions = bool(TEXTURE.search(text)), bool(ICON.search(text)), bool(VERSIONS.search(text))
    moving = bool(MOVE.search(text)) and not sound
    wants_3d = (bool(THREE_D.search(text)) or moving) and not pixel
    # The thing itself says what kind it is; the whole sentence decides only when the thing doesn't.
    kind = "auto" if len(parts) > 1 and not icons else kind_of(subject, text) or ("prop" if wants_3d and not moving else "character")
    many = len(parts) > 1 or bool(MANY.search(re.sub(r"\b(?:3|2)-?d\b|\b(?:8|16)-?bit\b", "", text, flags=re.I)))
    steps: list[tuple[str, str, dict[str, Any]]] = []
    wires: list[tuple[str, str, str]] = []

    def then(sid: str, node_type: str, fields: dict[str, Any] | None = None, port: str = "picture") -> None:
        if steps:
            wires.append((steps[-1][0], sid, port))
        steps.append((sid, node_type, fields or {}))

    def start() -> None:
        if many:
            then("list", "list", {"lines": "\n".join(parts) if len(parts) > 1 else ""})
        else:
            then("idea", "idea", {"text": subject})

    keep: list[str] = []
    if sound and not wants_3d and not mine:
        start()
        then("sound", "sound", {"kind": "music" if _word("music", "song").search(text) else "voice" if _word("voices?", "voice ?lines?").search(text) else "sfx"}, "text")
    else:
        if mine:
            then("pic", "my_picture")
        else:
            start()
            if versions and not many:
                then("vary", "vary", {}, "text")
            choose = not many and not versions and not texture
            if pixel:
                then("pixel", "pixel", {"kind": kind if kind in ("creature", "item", "weapon", "prop", "auto") else "character", "count": 4 if choose else 1}, "text")
            else:
                then("draw", "draw", {"kind": "material" if texture and not wants_3d else kind, "count": 3 if choose else 1}, "text")
            if choose:
                then("pick", "pick")
        if mine and (wants_3d or CUTOUT.search(text) or versions):
            then("cut", "cutout")
        elif CUTOUT.search(text) and not wants_3d:
            then("cut", "cutout")
        if texture and not wants_3d:
            then("tile", "tile")
        elif wants_3d:
            then("make3d", "make3d")
            if moving:
                moves = [m for m, words in MOVE_WORDS.items() if any(re.search(rf"\b{w}", text, re.I) for w in (*words, m.lower()))]
                then("rig", "rig", {}, "model")
                then("move", "animate", {"moves": moves or ["Idle", "Walk"]}, "rig")
        elif icons:
            keep.append(steps[-1][0])
            then("icons", "icons")
        elif versions and mine:
            then("recolor", "recolor")
    then("save", "save", {}, "any")
    return from_steps(title_of(subject), steps, wires + [(k, "save", "any") for k in keep])


def prompt(text: str) -> str:
    lines = []
    for kind, spec in NODES.items():
        if kind == "note":
            continue
        takes = ", ".join(f"{i['id']}:{i['type']}{'' if i.get('required') else ' (optional)'}" for i in spec["inputs"]) or "nothing"
        fields = []
        for f in spec["fields"]:
            values = [c["value"] for c in f.get("choices", [])]
            if f["kind"] in ("image_model", "picture", "model", "section"):
                continue
            fields.append(f["id"] + {"choice": f" (one of {values})", "multi": f" (list, any of {values})", "number": f" ({f.get('min')}-{f.get('max')})",
                                     "lines": " (text, one per line)", "toggle": " (true/false)"}.get(f["kind"], " (text)"))
        lines.append(f"- {kind}: {spec['blurb']} Takes {takes}. Gives {spec['out'] or 'nothing'}." + (f" Fields: {'; '.join(fields)}." if fields else ""))
    return (f"Build a workflow for this request:\n\n{text.strip()[:2000]}\n\nThe steps you can use:\n" + "\n".join(lines)
            + "\n\nRules: a wire goes from a step to one input of a later step, and the kinds must match exactly. Start with idea (one thing), list (several: write "
            "real, concrete lines) or my_picture / my_model (the user brings a file). When 3D follows and there is one idea, draw 3 options and put pick between. "
            "Characters that move need make3d, then rig, then animate. End with save, wired from everything worth keeping. Write the idea or list text from the "
            "request, concrete and visual. Use only the steps that are needed.\n\n"
            'Answer ONLY JSON: {"name": "short name", "steps": [{"id": "a", "type": "idea", "fields": {"text": "..."}}], "wires": [["a", "b", "text"]]}')


def from_answer(answer: str) -> dict[str, Any]:
    """The document in a model's answer. Raises ValueError when it isn't a usable workflow."""
    match = re.search(r"\{.*\}", str(answer or ""), re.S)
    try:
        data = json.loads(match.group(0)) if match else {}
        steps = [(str(s["id"])[:24], str(s["type"]), dict(s.get("fields") or {})) for s in data.get("steps") or []]
        wires = [(str(w[0]), str(w[1]), str(w[2])) for w in data.get("wires") or []]
    except (ValueError, KeyError, TypeError, IndexError, AttributeError):
        raise ValueError("The answer wasn't a workflow.") from None
    doc = from_steps(str(data.get("name") or "Workflow"), steps, wires)
    if len(doc["nodes"]) < 2 or not doc["edges"]:
        raise ValueError("The answer wasn't a workflow.")
    return doc


async def draft(text: str, model_call: Callable[..., Awaitable[dict[str, Any]]] | None) -> dict[str, Any]:
    plain = guess(text)
    if model_call is not None:
        try:
            result = await asyncio.wait_for(model_call(prompt=prompt(text), system_prompt="You lay out simple game-art workflows and answer with JSON only.", effort="low"), 60)
            return {"doc": from_answer(str(result.get("text") or "")), "by": "tess"}
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — no chat model, a timeout, bad JSON: the words are enough
            pass
    return {"doc": plain, "by": "words"}
