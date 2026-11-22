"""A section as one page: the section's own assets, then each sub-folder as a subsection under its own heading.

Folders stay real folders on disk (paths in ASSETS.md and the game link never change); only the studio shows a
section's sub-folders on one scrolling page. Each asset also says what made it ("Nano Banana 2 + Tripo v3.0")
and what that cost, read from the generation records.
"""

from __future__ import annotations

import re
import shutil
import time
from pathlib import Path
from typing import Any

from forge.overview import PILLAR_DIR, describe_folder, inside, resolve_rel

# How deep a section page goes: section → subsection → one more level shown as small labels. Deeper still is
# folded into that last level.
MAX_DEPTH = 3

_labels: dict[str, str] = {}
_labels_at = 0.0


def _catalog_labels() -> dict[str, str]:
    """Every known model id with the name the user sees, cached for a minute."""
    global _labels, _labels_at
    if _labels and time.time() - _labels_at < 60:
        return _labels
    labels: dict[str, str] = {}
    try:
        from forge import asset_studio

        labels.update({m["id"]: m["label"] for m in asset_studio.list_image_models()})
    except Exception:  # noqa: BLE001 - a missing provider must not break a folder page
        pass
    try:
        from forge import service_gen

        for kind in ("image", "3d"):
            labels.update({m["id"]: m["label"] for m in service_gen.cached_catalog(kind)})
    except Exception:  # noqa: BLE001
        pass
    _labels, _labels_at = labels, time.time()
    return labels


def model_label(model: str) -> str:
    """A short model name for a card: 'svc:elevenlabs/gemini-nano-banana-2.1' → 'Gemini nano banana 2.1'."""
    model = str(model or "").strip()
    if not model:
        return ""
    label = _catalog_labels().get(model, "")
    if label:
        label = re.sub(r"\s*\(.*?\)\s*$", "", label)
        return label.split(" · ", 1)[-1].strip()
    provider, _, rest = model.partition(":")
    if not rest:
        provider, rest = "", model
    rest = rest.split("/")[-1]
    if rest in ("rigging", "animation"):
        return f"{provider.title()} {rest}".strip()
    words = [w for w in re.split(r"[_\s-]+", rest) if w]
    if len(words) > 1 and words[0].lower() in ("gemini", "google", "openai", "fal"):
        words = words[1:]  # "gemini-nano-banana-2.1" is known as Nano Banana 2.1
    upper = {"gpt": "GPT", "flux": "FLUX", "sdxl": "SDXL", "ai": "AI", "3d": "3D"}
    name = " ".join(upper.get(w.lower(), w if re.match(r"v\d", w) else w[:1].upper() + w[1:]) for w in words)
    if provider in ("tripo", "meshy", "hunyuan", "rodin") and provider not in name.lower():
        name = f"{provider.title()} {name}"
    return name


def made_with(ws_dir: Path, rel: str, winner: str, model: str) -> dict[str, Any]:
    """What made the asset's picked picture (or sound) and its 3D model, and what both cost."""
    from forge.asset_studio import output_history

    try:
        history = output_history(ws_dir, rel)
    except (OSError, ValueError):
        return {"made_with": "", "cost_usd": 0.0}
    steps, cost = [], 0.0
    for file in (winner, model):
        record = history.get(file) if file else None
        if not record:
            continue
        label = model_label(str(record.get("model") or ""))
        if label and label not in steps:
            steps.append(label)
        try:
            cost += float(record.get("cost_usd") or 0)
        except (TypeError, ValueError):
            pass
    return {"made_with": " + ".join(steps), "cost_usd": round(cost, 4)}


def _winner_of(ws_dir: Path, rel: str) -> str:
    from forge.blueprint_contract import read_frontmatter

    try:
        meta, _, _ = read_frontmatter(resolve_rel(ws_dir, rel))
    except (OSError, ValueError):
        return ""
    return str(meta.get("winner") or "")


def describe_section(ws_dir: Path, rel: str) -> dict[str, Any]:
    """The whole section on one page: the folder as describe_folder lists it, each sub-folder nested in
    `subsections` (up to MAX_DEPTH levels), and every asset with `made_with` and `cost_usd`."""

    def walk(path: str, depth: int) -> dict[str, Any]:
        folder = describe_folder(ws_dir, path)
        for entry in folder["files"]:
            if entry.get("kind") == "asset":
                winner = _winner_of(ws_dir, entry["path"])
                entry.update(made_with(ws_dir, entry["path"], winner, entry.get("model") or ""))
        folder["depth"] = depth
        children = [walk(f["path"], depth + 1) for f in folder["folders"]]
        if depth + 1 >= MAX_DEPTH - 1:
            # The last level shown: anything deeper is listed with it, so nothing is hidden.
            for child in children:
                child["files"] += [f for grand in child.pop("subsections", []) for f in _flatten(grand)]
                child["subsections"] = []
        folder["subsections"] = children
        return folder

    return walk(rel, 0)


def _flatten(folder: dict[str, Any]) -> list[dict[str, Any]]:
    return folder["files"] + [f for sub in folder.get("subsections", []) for f in _flatten(sub)]


def promote_folder(ws_dir: Path, rel: str, parent: str = "") -> str:
    """Move a sub-folder up to `parent` (the top, by default, which makes it a section of its own).
    Paths inside its pages that point into it (`winner: props/vehicles/cart/…`) are rewritten, and its
    generation records move with it. Returns the new workspace-relative path."""
    from forge.layout import Layout

    source = resolve_rel(ws_dir, rel)
    if not source.is_dir() or source.name == PILLAR_DIR:
        raise ValueError(f"No folder '{rel}'.")
    root = ws_dir.resolve()
    target_parent = inside(ws_dir, ws_dir / parent) if parent else root
    target = target_parent / source.name
    if target.resolve() == source.resolve():
        return rel
    if target.exists():
        raise ValueError(f"'{target.relative_to(root).as_posix()}' already exists.")
    old_prefix = f"{source.relative_to(root).as_posix()}/"
    new_prefix = f"{target.relative_to(root).as_posix()}/"
    source.rename(target)
    for page in target.rglob("*.md"):
        try:
            text = page.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if old_prefix in text:
            page.write_text(text.replace(old_prefix, new_prefix), encoding="utf-8")
    try:
        history = Layout.of_art(ws_dir).history
        old_records, new_records = history / old_prefix.rstrip("/"), history / new_prefix.rstrip("/")
        if old_records.is_dir() and not new_records.exists():
            new_records.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old_records), str(new_records))
            for record in new_records.rglob("*.json"):
                text = record.read_text(encoding="utf-8", errors="ignore")
                if old_prefix in text:
                    record.write_text(text.replace(old_prefix, new_prefix), encoding="utf-8")
    except (OSError, ValueError):
        pass  # the records are a nicety; the art itself has moved
    return target.relative_to(root).as_posix()
