"""Move, rename, trash and restore assets from the UI, each one undoable.

An asset is its page (`props/lamp.md`) plus its outputs folder (`props/lamp/`). They always move together,
and paths inside the page that point into the outputs folder (`winner: props/lamp/candidates/…`) are rewritten.
Deletes go to `.trash/` and come back with `restore`.
"""

from __future__ import annotations

from pathlib import Path

from forge.overview import inside, move_to_trash, resolve_rel, slugify


def _parts(ws_dir: Path, rel: str) -> tuple[Path, Path]:
    page = resolve_rel(ws_dir, rel)
    if not page.is_file() or page.suffix.lower() != ".md":
        raise ValueError(f"No asset page '{rel}'.")
    return page, page.with_suffix("")


def _rel(ws_dir: Path, path: Path) -> str:
    return path.resolve().relative_to(ws_dir.resolve()).as_posix()


def move_asset(ws_dir: Path, rel: str, folder: str | None = None, name: str | None = None) -> str:
    """Move an asset to `folder` and/or rename it to `name`. Returns the page's new workspace-relative path."""
    page, outputs = _parts(ws_dir, rel)
    target_dir = inside(ws_dir, ws_dir / folder) if folder is not None else page.parent
    if folder is not None and not target_dir.is_dir():
        raise ValueError(f"No folder '{folder}'.")
    stem = slugify(name) if name else page.stem
    if not stem:
        raise ValueError("The new name needs a letter or a number.")
    new_page = target_dir / f"{stem}.md"
    if new_page.resolve() == page.resolve():
        return _rel(ws_dir, page)
    new_outputs = new_page.with_suffix("")
    if new_page.exists() or new_outputs.exists():
        raise ValueError(f"'{_rel(ws_dir, new_page)}' already exists.")
    old_prefix, new_prefix = f"{_rel(ws_dir, outputs)}/", f"{_rel(ws_dir, new_outputs)}/"
    text = page.read_text(encoding="utf-8", errors="ignore")
    page.rename(new_page)
    if outputs.is_dir():
        outputs.rename(new_outputs)
    if old_prefix in text:
        new_page.write_text(text.replace(old_prefix, new_prefix), encoding="utf-8")
    return _rel(ws_dir, new_page)


def trash_assets(ws_dir: Path, rels: list[str]) -> list[dict[str, str]]:
    """Move assets (page and outputs) to `.trash/`. Returns what `restore` needs to put them back."""
    moved: list[dict[str, str]] = []
    for rel in rels:
        page, outputs = _parts(ws_dir, rel)
        for part in (page, outputs):
            if part.exists():
                original = _rel(ws_dir, part)
                trashed = move_to_trash(ws_dir, part)
                if trashed:
                    moved.append({"from": trashed, "to": original})
    return moved


def restore(ws_dir: Path, items: list[dict[str, str]]) -> list[str]:
    """Put trashed files back where they were. Skips anything whose old place is taken."""
    restored: list[str] = []
    for item in items:
        source = resolve_rel(ws_dir, str(item.get("from") or ""))
        dest = resolve_rel(ws_dir, str(item.get("to") or ""))
        if not source.exists() or dest.exists() or not source.as_posix().count("/.trash/"):
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        source.rename(dest)
        restored.append(_rel(ws_dir, dest))
    return restored
