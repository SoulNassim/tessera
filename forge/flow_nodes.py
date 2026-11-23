"""The steps of the Node Studio: what each one is called, what it takes, what it gives and the few choices it offers.

Everything here is written for someone who has never opened a node editor. A step is named after what it does, its
choices are words, and whatever an expert would set (model, size, pose, polygon count) has a good answer already.
The engine that runs them is `forge/flows.py`; the page is `forge/ui/flows.js`, which draws what this file describes.
"""

from __future__ import annotations

import re
from typing import Any

from forge.stylepacks.builtins import BUILTIN_STYLE_PACKS

# What can travel along a wire, with the word the page uses for it.
TYPES: dict[str, str] = {
    "text": "words", "style": "art style", "picture": "picture", "model": "3D model", "rig": "3D character",
    "clip": "animation", "sound": "sound", "surface": "texture",
}

GROUPS: tuple[tuple[str, str], ...] = (
    ("start", "Start with"), ("picture", "Pictures"), ("3d", "3D"), ("sound", "Sound"), ("finish", "Finish"),
)

DRAW_KINDS = (
    ("character", "Character"), ("creature", "Creature"), ("item", "Item"), ("weapon", "Weapon"), ("prop", "Prop"),
    ("vehicle", "Vehicle"), ("environment", "Scene"), ("material", "Texture"), ("ui", "UI art"), ("vfx", "Effect"),
)
AUTO = ("auto", "Decide for me")
KIND_WORDS = {
    "creature": ("creature", "monster", "enemy", "enemies", "dragon", "slime", "beast", "animal", "cat", "dog", "wolf", "spider"),
    "character": ("character", "hero", "knight", "npc", "person", "warrior", "wizard", "player", "man", "woman", "girl", "boy", "robot", "orc", "goblin", "elf", "king", "queen", "pirate", "soldier"),
    "weapon": ("weapon", "sword", "gun", "axe", "bow", "dagger", "spear", "rifle", "hammer"),
    "vehicle": ("vehicle", "car", "ship", "boat", "tank", "spaceship", "truck", "plane"),
    "item": ("item", "potion", "icon", "pickup", "coin", "loot", "gem", "food", "key", "scroll", "ring", "flask"),
    "environment": ("background", "scene", "landscape", "environment", "castle", "village", "forest", "city"),
    "prop": ("prop", "furniture", "chest", "barrel", "crate", "tree", "rock", "building", "house", "lantern", "lamp", "table", "chair"),
}
MOVES = ("Idle", "Walk", "Run", "Jump", "Attack", "Hurt", "Wave", "Dance", "Die")
COLOURS = ("Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple", "Pink", "Grey")


def kind_of(*texts: str) -> str:
    """What kind of asset the words describe ("" when they don't say). Of several words the last one is the thing:
    "a frog knight" is a knight, "a dragon chest" a chest."""
    for text in texts:
        thing = re.split(r"\b(?:with|in|on|holding|of)\b", text, maxsplit=1)[0] or text
        hits = [(m.start(), kind) for kind, words in KIND_WORDS.items() for m in re.finditer(rf"\b(?:{'|'.join(words)})s?\b", thing, re.I)]
        if hits:
            return max(hits)[1]
    return ""


def _choices(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    return [{"value": v, "label": label} for v, label in pairs]


STYLE_CHOICES = [{"value": "", "label": "My project's style"}] + [
    {"value": pack.id, "label": pack.name, "hint": pack.description}
    for pack in BUILTIN_STYLE_PACKS.values() if pack.id != "pixel_art"
] + [{"value": "own", "label": "My own words"}]


def style_text(fields: dict[str, Any]) -> str:
    """The words an Art style step adds to every picture it is connected to."""
    own = str(fields.get("words") or "").strip()
    pack = BUILTIN_STYLE_PACKS.get(str(fields.get("preset") or ""))
    return ". ".join(t for t in (f"{pack.prompt_prefix.strip(' ,')}, {pack.prompt_suffix}" if pack else "", own) if t)


# Each step: the fields the page shows (`more: True` hides one under "More options"), its inputs and its output.
# An input with `field` can be filled in on the card instead of wired. `many` takes several wires.
# `each` runs once per thing coming in on the first input, so a list of ten ideas makes ten of everything after it.
NODES: dict[str, dict[str, Any]] = {
    # ---------- start ----------
    "idea": {
        "label": "Idea", "group": "start", "icon": "idea", "out": "text",
        "blurb": "Say what you want in your own words.",
        "help": "Write one thing, the way you would describe it to an artist. “A grumpy frog knight in rusty armour” works better than one word.",
        "inputs": [],
        "fields": [{"id": "text", "kind": "text", "label": "What do you want to make?", "placeholder": "A grumpy frog knight in rusty armour", "required": True, "rows": 3}],
    },
    "list": {
        "label": "List of ideas", "group": "start", "icon": "list", "out": "text",
        "blurb": "One idea per line. Every step after it runs for each line.",
        "help": "Great for sets: ten potions, five enemies. Add a line later and only the new one is made.",
        "inputs": [],
        "fields": [{"id": "lines", "kind": "lines", "label": "One idea per line", "placeholder": "Red health potion\nBlue mana potion\nGreen poison flask", "required": True, "rows": 5}],
    },
    "my_picture": {
        "label": "My picture", "group": "start", "icon": "upload", "out": "picture",
        "blurb": "Use a picture from your computer or this project.",
        "help": "Drop a picture on this card, paste one, or pick one you already made in Tessera. Nothing is sent anywhere until a later step uses it.",
        "inputs": [],
        "fields": [{"id": "path", "kind": "picture", "label": "Picture", "required": True},
                   {"id": "name", "kind": "line", "label": "Call it", "placeholder": "Named after the file", "more": True}],
    },
    "my_model": {
        "label": "My 3D model", "group": "start", "icon": "cube", "out": "model",
        "blurb": "Use a 3D model from your computer or this project.",
        "help": "Works with .glb files. Use it to add a skeleton or animations to a model you already have.",
        "inputs": [],
        "fields": [{"id": "path", "kind": "model", "label": "3D model", "required": True}],
    },
    "style": {
        "label": "Art style", "group": "start", "icon": "palette", "out": "style",
        "blurb": "One look shared by every picture you connect it to.",
        "help": "Connect one Art style to several picture steps and everything matches. Your project's own style is always followed as well.",
        "inputs": [],
        "fields": [{"id": "preset", "kind": "choice", "label": "Look", "choices": STYLE_CHOICES, "default": "hand_painted"},
                   {"id": "words", "kind": "text", "label": "Anything to add?", "placeholder": "thick outlines, muted autumn colours", "rows": 2}],
    },
    "vary": {
        "label": "Make versions", "group": "start", "icon": "fork", "out": "text", "each": True,
        "blurb": "Turns one idea into several: red, blue, golden…",
        "help": "Every line is added to the idea. “Dragon” with the lines “fire”, “ice” and “poison” gives three dragons.",
        "inputs": [{"id": "text", "type": "text", "label": "Idea", "required": True}],
        "fields": [{"id": "lines", "kind": "lines", "label": "One version per line", "placeholder": "made of fire\nmade of ice\nmade of poison", "required": True, "rows": 4}],
    },
    # ---------- pictures ----------
    "draw": {
        "label": "Draw a picture", "group": "picture", "icon": "sparkle", "out": "picture", "each": True, "paid": "image",
        "blurb": "An AI artist draws your idea.",
        "help": "Tessera picks the artist, the shape and the background for you. If 3D comes next, it also asks for a full view and a neutral pose, so the model turns out well.",
        "inputs": [{"id": "text", "type": "text", "label": "Idea", "required": True, "field": "idea"},
                   {"id": "style", "type": "style", "label": "Art style"},
                   {"id": "like", "type": "picture", "label": "Look like this", "many": True}],
        "fields": [{"id": "idea", "kind": "text", "label": "What should it show?", "placeholder": "A grumpy frog knight in rusty armour", "rows": 3},
                   {"id": "kind", "kind": "choice", "label": "It's a…", "choices": _choices(AUTO, *DRAW_KINDS), "default": "auto"},
                   {"id": "count", "kind": "number", "label": "How many to choose from", "min": 1, "max": 4, "default": 1},
                   {"id": "background", "kind": "choice", "label": "Background", "choices": _choices(("auto", "Decide for me"), ("cutout", "None"), ("scene", "Keep it")), "default": "auto", "more": True},
                   {"id": "shape", "kind": "choice", "label": "Shape", "choices": _choices(("auto", "Decide for me"), ("1:1", "Square"), ("3:4", "Tall"), ("4:3", "Wide"), ("16:9", "Very wide")), "default": "auto", "more": True},
                   {"id": "model", "kind": "image_model", "label": "Artist", "default": "", "more": True}],
    },
    "pixel": {
        "label": "Draw pixel art", "group": "picture", "icon": "grid", "out": "picture", "each": True, "paid": "image",
        "blurb": "A real pixel sprite: exact size, limited colours.",
        "help": "Pixel Studio's own engine: drawn for the grid, then locked to it. Saved sprites open in Pixel Studio.",
        "inputs": [{"id": "text", "type": "text", "label": "Idea", "required": True, "field": "idea"}],
        "fields": [{"id": "idea", "kind": "text", "label": "What should it show?", "placeholder": "A slime with a tiny crown", "rows": 3},
                   {"id": "kind", "kind": "choice", "label": "It's a…", "choices": _choices(AUTO, ("character", "Character"), ("creature", "Creature"), ("item", "Item"), ("weapon", "Weapon"), ("prop", "Prop"), ("icon", "Icon"), ("tile", "Ground tile")), "default": "auto"},
                   {"id": "canvas", "kind": "choice", "label": "Size", "choices": _choices(("16", "16 tiny"), ("32", "32 classic"), ("48", "48"), ("64", "64 detailed")), "default": "32"},
                   {"id": "count", "kind": "number", "label": "How many to choose from", "min": 1, "max": 4, "default": 1},
                   {"id": "view", "kind": "choice", "label": "Seen from", "choices": _choices(("side", "The side"), ("top-down", "Above"), ("three-quarter", "Three-quarter"), ("isometric", "Isometric"), ("front", "The front")), "default": "side", "more": True},
                   {"id": "outline", "kind": "choice", "label": "Outline", "choices": _choices(("black", "Dark"), ("selective", "Coloured"), ("none", "None")), "default": "black", "more": True}],
    },
    "pick": {
        "label": "Let me choose", "group": "picture", "icon": "star", "out": "picture",
        "blurb": "Stops so you can pick your favourite.",
        "help": "The steps after this wait for you. Click the picture you like and they carry on. With a list, you choose one for each idea.",
        "inputs": [{"id": "picture", "type": "picture", "label": "Pictures", "required": True, "many": True}],
        "fields": [],
    },
    "change": {
        "label": "Change a picture", "group": "picture", "icon": "edit", "out": "picture", "each": True, "paid": "image",
        "blurb": "Describe an edit: “give it a red cape”.",
        "help": "The rest of the picture stays the same. Ask for one or two changes at a time.",
        "inputs": [{"id": "picture", "type": "picture", "label": "Picture", "required": True},
                   {"id": "text", "type": "text", "label": "What to change", "required": True, "field": "idea"}],
        "fields": [{"id": "idea", "kind": "text", "label": "What should change?", "placeholder": "Give it a red cape", "rows": 2},
                   {"id": "model", "kind": "image_model", "label": "Artist", "default": "", "more": True}],
    },
    "views": {
        "label": "Draw its other sides", "group": "picture", "icon": "turn", "out": "picture", "each": True, "paid": "image", "cost_count": 2,
        "blurb": "Draws the left side and the back of the same thing.",
        "help": "Connect it to “Other sides” on Make it 3D and the back of the model is drawn instead of guessed.",
        "inputs": [{"id": "picture", "type": "picture", "label": "Picture", "required": True}],
        "fields": [],
    },
    "cutout": {
        "label": "Remove background", "group": "picture", "icon": "scissors", "out": "picture", "each": True,
        "blurb": "Keeps the subject, clears everything behind it.",
        "help": "Made on your computer, free. Works best on plain backgrounds; with BiRefNet installed (Settings → This PC) it handles busy ones too.",
        "inputs": [{"id": "picture", "type": "picture", "label": "Picture", "required": True}],
        "fields": [],
    },
    "recolor": {
        "label": "Recolour", "group": "picture", "icon": "drop", "out": "picture", "each": True,
        "blurb": "The same picture in other colours.",
        "help": "Made on your computer, free. Handy for team colours, rarity tiers and enemy types.",
        "inputs": [{"id": "picture", "type": "picture", "label": "Picture", "required": True}],
        "fields": [{"id": "colours", "kind": "multi", "label": "Colours", "choices": _choices(*((c, c) for c in COLOURS)), "default": ["Red", "Green", "Blue"], "required": True}],
    },
    "icons": {
        "label": "Make icons", "group": "picture", "icon": "icons", "out": "picture", "each": True,
        "blurb": "Square, see-through icons, all framed the same way.",
        "help": "Made on your computer, free. Ready for inventories and menus.",
        "inputs": [{"id": "picture", "type": "picture", "label": "Picture", "required": True}],
        "fields": [{"id": "sizes", "kind": "multi", "label": "Sizes", "choices": _choices(("32", "32"), ("64", "64"), ("128", "128"), ("256", "256"), ("512", "512")), "default": ["128"], "required": True}],
    },
    "split": {
        "label": "Cut into pieces", "group": "picture", "icon": "cut", "out": "picture", "each": True,
        "blurb": "Finds every object on a sheet and cuts each one out.",
        "help": "Made on your computer, free. Best with objects spaced apart on a plain background.",
        "inputs": [{"id": "picture", "type": "picture", "label": "Sheet", "required": True}],
        "fields": [{"id": "kind", "kind": "choice", "label": "The pieces are…", "choices": _choices(("prop", "Props"), ("item", "Items"), ("weapon", "Weapons"), ("ui", "UI art")), "default": "prop"}],
    },
    "tile": {
        "label": "Make it repeat", "group": "picture", "icon": "material", "out": "surface", "each": True,
        "blurb": "A seamless texture for floors and walls.",
        "help": "Made on your computer, free: the colour plus the maps a game engine uses for light (normal, roughness, height).",
        "inputs": [{"id": "picture", "type": "picture", "label": "Picture", "required": True}],
        "fields": [],
    },
    # ---------- 3D ----------
    "make3d": {
        "label": "Make it 3D", "group": "3d", "icon": "cube", "out": "model", "each": True, "paid": "3d",
        "blurb": "Turns a picture into a textured 3D model.",
        "help": "Takes a few minutes. Best with one subject, fully in view, on a plain background.",
        "inputs": [{"id": "picture", "type": "picture", "label": "Picture", "required": True},
                   {"id": "sides", "type": "picture", "label": "Other sides", "many": True}],
        "fields": [{"id": "detail", "kind": "choice", "label": "Detail", "choices": [
                       {"value": "light", "label": "Light", "hint": "Mobile games, crowds, small props"},
                       {"value": "game", "label": "Game-ready", "hint": "Right for most games"},
                       {"value": "high", "label": "High", "hint": "Close-ups and hero pieces"}], "default": "game"},
                   {"id": "texture", "kind": "toggle", "label": "Paint it", "default": True, "more": True}],
    },
    "rig": {
        "label": "Add a skeleton", "group": "3d", "icon": "bones", "out": "rig", "each": True, "paid": "rig",
        "blurb": "Gives a character bones so it can move.",
        "help": "Works on characters with arms and legs, standing with a little space under the arms. Objects and vehicles don't need one.",
        "inputs": [{"id": "model", "type": "model", "label": "3D model", "required": True}],
        "fields": [{"id": "height", "kind": "choice", "label": "How tall is it?", "choices": _choices(("0.6", "Small"), ("1.1", "Child size"), ("1.7", "Person"), ("2.6", "Giant")), "default": "1.7"},
                   {"id": "body", "kind": "choice", "label": "Body", "choices": _choices(("biped", "Two legs"), ("quadruped", "Four legs")), "default": "biped", "more": True}],
    },
    "animate": {
        "label": "Make it move", "group": "3d", "icon": "film", "out": "clip", "each": True, "paid": "animate",
        "blurb": "Walk, run, attack: ready-made moves.",
        "help": "Pick as many moves as you like. They land in one file, ready for your game. Fine-tune them later in Motion Studio.",
        "inputs": [{"id": "rig", "type": "rig", "label": "3D character", "required": True}],
        "fields": [{"id": "moves", "kind": "multi", "label": "Moves", "choices": _choices(*((m, m) for m in MOVES)), "default": ["Idle", "Walk"], "required": True}],
    },
    # ---------- sound ----------
    "sound": {
        "label": "Make a sound", "group": "sound", "icon": "sound", "out": "sound", "each": True, "paid": "sound",
        "blurb": "Effects, music or a spoken line.",
        "help": "Describe the sound (“heavy wooden door creaks open”). For a voice, write exactly what should be said. Length and looping are worked out from your words.",
        "inputs": [{"id": "text", "type": "text", "label": "Idea", "required": True, "field": "idea"}],
        "fields": [{"id": "idea", "kind": "text", "label": "What should it sound like?", "placeholder": "A heavy wooden door creaks open", "rows": 2},
                   {"id": "kind", "kind": "choice", "label": "It's…", "choices": _choices(("sfx", "A sound effect"), ("music", "Music"), ("voice", "A voice")), "default": "sfx"},
                   {"id": "count", "kind": "number", "label": "How many takes", "min": 1, "max": 4, "default": 1}],
    },
    # ---------- finish ----------
    "save": {
        "label": "Save to project", "group": "finish", "icon": "save", "out": "",
        "blurb": "Puts the results in your project as assets.",
        "help": "Connect anything you want to keep. Pictures, models, animations and sounds of the same thing land on one asset page, and your game's coding agent sees them.",
        "inputs": [{"id": "any", "type": "any", "label": "Anything to keep", "required": True, "many": True}],
        "fields": [{"id": "name", "kind": "line", "label": "Name", "placeholder": "Named after your idea"},
                   {"id": "section", "kind": "section", "label": "Where", "default": ""}],
    },
    "note": {
        "label": "Note", "group": "finish", "icon": "note", "out": "",
        "blurb": "A reminder to yourself. Does nothing.",
        "help": "For leaving yourself or your team a hint.",
        "inputs": [],
        "fields": [{"id": "text", "kind": "text", "label": "Note", "placeholder": "Write anything", "rows": 3}],
    },
}

# The step that gets from one kind of thing to the next. The page chains these when a wire doesn't fit directly.
BRIDGES = {"text": "draw", "picture": "make3d", "model": "rig", "rig": "animate"}


def fits(out: str, accepts: str) -> bool:
    """Whether a wire may carry `out` into an input. Words and styles aren't things to keep, so "any" isn't for them."""
    return bool(out) and (out == accepts or accepts == "any" and out not in ("text", "style"))


def default_fields(node_type: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in NODES[node_type]["fields"]:
        default = f.get("default")
        if default is None:
            default = {"toggle": False, "multi": [], "number": f.get("min", 1)}.get(f["kind"], "")
        out[f["id"]] = list(default) if isinstance(default, list) else default
    return out


def clean_fields(node_type: str, fields: Any) -> dict[str, Any]:
    """Only the fields a step has, each a valid value."""
    given = fields if isinstance(fields, dict) else {}
    out = default_fields(node_type)
    for f in NODES[node_type]["fields"]:
        if f["id"] not in given:
            continue
        value, allowed = given[f["id"]], [c["value"] for c in f.get("choices", [])]
        if f["kind"] == "choice":
            out[f["id"]] = str(value) if str(value) in allowed else out[f["id"]]
        elif f["kind"] == "multi":
            picked = [str(v) for v in value] if isinstance(value, (list, tuple)) else []
            out[f["id"]] = [v for v in allowed if v in picked]
        elif f["kind"] == "number":
            try:
                out[f["id"]] = max(f["min"], min(f["max"], int(value)))
            except (TypeError, ValueError):
                pass
        elif f["kind"] == "toggle":
            out[f["id"]] = bool(value)
        else:
            out[f["id"]] = str(value or "")[:6000]
    return out


# ---------- ready-made workflows ----------
# (id, title, what you get, steps [(id, type, fields)], wires [(from, to, input)], tags shown on the card)

def _t(tid: str, title: str, blurb: str, steps: list[tuple[str, str, dict[str, Any]]], wires: list[tuple[str, str, str]], art: str) -> dict[str, Any]:
    return {"id": tid, "title": title, "blurb": blurb, "steps": steps, "wires": wires, "art": art}


TEMPLATES: list[dict[str, Any]] = [
    _t("character-3d", "Animated 3D character", "From one sentence to a character that walks.",
       [("idea", "idea", {}), ("draw", "draw", {"kind": "character", "count": 3}), ("pick", "pick", {}), ("make3d", "make3d", {}),
        ("rig", "rig", {}), ("move", "animate", {"moves": ["Idle", "Walk", "Attack"]}), ("save", "save", {})],
       [("idea", "draw", "text"), ("draw", "pick", "picture"), ("pick", "make3d", "picture"), ("make3d", "rig", "model"),
        ("rig", "move", "rig"), ("move", "save", "any")], "character"),
    _t("prop-3d", "3D prop", "A textured model for your scene.",
       [("idea", "idea", {}), ("draw", "draw", {"kind": "prop", "count": 2}), ("pick", "pick", {}), ("make3d", "make3d", {}), ("save", "save", {})],
       [("idea", "draw", "text"), ("draw", "pick", "picture"), ("pick", "make3d", "picture"), ("make3d", "save", "any")], "prop"),
    _t("item-set", "Matching item set", "A whole set of icons in one look.",
       [("list", "list", {}), ("style", "style", {}), ("draw", "draw", {"kind": "item"}), ("icons", "icons", {}), ("save", "save", {})],
       [("list", "draw", "text"), ("style", "draw", "style"), ("draw", "icons", "picture"), ("draw", "save", "any"), ("icons", "save", "any")], "item"),
    _t("picture-3d", "My picture to 3D", "Bring a drawing or photo, get a model.",
       [("pic", "my_picture", {}), ("cut", "cutout", {}), ("make3d", "make3d", {}), ("save", "save", {})],
       [("pic", "cut", "picture"), ("cut", "make3d", "picture"), ("make3d", "save", "any")], "environment"),
    _t("versions", "One thing, many versions", "Fire, ice and poison of the same idea.",
       [("idea", "idea", {}), ("vary", "vary", {}), ("style", "style", {}), ("draw", "draw", {"kind": "creature"}), ("save", "save", {})],
       [("idea", "vary", "text"), ("vary", "draw", "text"), ("style", "draw", "style"), ("draw", "save", "any")], "creature"),
    _t("pixel-sprite", "Pixel sprite", "A crisp sprite, ready for Pixel Studio.",
       [("idea", "idea", {}), ("pixel", "pixel", {"count": 4}), ("pick", "pick", {}), ("save", "save", {})],
       [("idea", "pixel", "text"), ("pixel", "pick", "picture"), ("pick", "save", "any")], "ui"),
    _t("ground", "Seamless texture", "Floors and walls that repeat without seams.",
       [("idea", "idea", {}), ("draw", "draw", {"kind": "material"}), ("tile", "tile", {}), ("save", "save", {})],
       [("idea", "draw", "text"), ("draw", "tile", "picture"), ("tile", "save", "any")], "level"),
    _t("sounds", "Sound pack", "A list of sounds, made in one go.",
       [("list", "list", {}), ("sound", "sound", {}), ("save", "save", {})],
       [("list", "sound", "text"), ("sound", "save", "any")], "sound"),
    _t("recolours", "Team colours", "Your picture in red, blue and green. Free.",
       [("pic", "my_picture", {}), ("cut", "cutout", {}), ("recolor", "recolor", {}), ("save", "save", {})],
       [("pic", "cut", "picture"), ("cut", "recolor", "picture"), ("recolor", "save", "any")], "vehicle"),
    _t("cut-sheet", "Cut up a sheet", "Every object on a picture as its own asset. Free.",
       [("pic", "my_picture", {}), ("split", "split", {}), ("icons", "icons", {}), ("save", "save", {})],
       [("pic", "split", "picture"), ("split", "icons", "picture"), ("split", "save", "any"), ("icons", "save", "any")], "weapon"),
]


def catalogue() -> dict[str, Any]:
    """Everything the page needs to draw steps, menus and templates."""
    return {
        "types": TYPES, "groups": [{"id": g, "label": label} for g, label in GROUPS], "bridges": BRIDGES,
        "nodes": {k: {"type": k, **v} for k, v in NODES.items()},
        "templates": [{"id": t["id"], "title": t["title"], "blurb": t["blurb"], "art": t["art"],
                       "steps": [s[1] for s in t["steps"] if s[1] != "note"],
                       "free": not any(NODES[s[1]].get("paid") for s in t["steps"])} for t in TEMPLATES],
    }
