"""The engine of the Node Studio: workflow documents, what is left to do, and running them.

A workflow is a small JSON document (`.flows/<id>/flow.json` in the project's art folder): steps and the wires between
them. `forge/flow_nodes.py` says what each step is, `forge/flow_steps.py` does the work and `forge/flow_draft.py` makes
one from a sentence. What a workflow made lives next to it in `.flows/<id>/out/`, hidden from the project until a
"Save to project" step copies it into ordinary assets.

Two rules shape everything here:

* **Nothing is paid for twice.** Every result is kept under a key made of the step's choices and exactly what came in.
  Running again only makes what is missing: add a line to a list and only that line is new; undo a change and the old
  result is back for free.
* **Problems are sentences with a fix.** `check()` says what is missing in plain words and what to click, before
  anything runs. A step that fails never takes the rest of the list down with it.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import re
import shutil
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from PIL import Image

from forge import asset_studio, flow_models, flow_nodes
from forge.config import load_config
from forge.flow_nodes import NODES, TYPES, clean_fields, default_fields, fits, key_fields
from forge.overview import humanize, move_to_trash, resolve_rel, slugify

FLOWS_DIR = ".flows"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")
NODE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,24}$")
PICTURES = {".png", ".jpg", ".jpeg", ".webp"}
MAX_NODES = 80
MAX_LINES = 60
CACHE_PER_NODE = 120  # results kept per step, so going back to an earlier choice is free
PAID_AT_ONCE = {"image": 2, "3d": 4, "rig": 2, "animate": 2, "sound": 2}

Value = dict[str, Any]
RunRequest = Callable[[dict[str, Any]], Awaitable[list[str]]]
Notify = Callable[[dict[str, Any]], Awaitable[None]]


# ---------- documents ----------

def flows_root(ws_dir: Path) -> Path:
    return ws_dir / FLOWS_DIR


def flow_dir(ws_dir: Path, flow_id: str) -> Path:
    if not ID_RE.match(str(flow_id or "")):
        raise ValueError("That is not a workflow's id.")
    return flows_root(ws_dir) / flow_id


def rel_to(ws_dir: Path, path: Path) -> str:
    return path.resolve().relative_to(ws_dir.resolve()).as_posix()


def _number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return round(max(-100_000.0, min(100_000.0, number)), 1) if number == number else default


def _leads_to(edges: list[dict[str, str]], start: str, goal: str) -> bool:
    seen, stack = set(), [start]
    while stack:
        at = stack.pop()
        if at == goal:
            return True
        if at not in seen:
            seen.add(at)
            stack.extend(e["to"] for e in edges if e["from"] == at)
    return False


def clean_doc(doc: Any) -> dict[str, Any]:
    """A workflow with every step and wire checked. Anything that can't be right is dropped, never an error."""
    if not isinstance(doc, dict):
        raise ValueError("A workflow must be a JSON object.")
    nodes: list[dict[str, Any]] = []
    types: dict[str, str] = {}
    for raw in list(doc.get("nodes") or [])[:MAX_NODES]:
        if not isinstance(raw, dict) or raw.get("type") not in NODES:
            continue
        nid = str(raw.get("id") or "")
        if not NODE_ID_RE.match(nid) or nid in types:
            continue
        types[nid] = raw["type"]
        node = {"id": nid, "type": raw["type"], "x": _number(raw.get("x")), "y": _number(raw.get("y")),
                "fields": clean_fields(raw["type"], raw.get("fields")), "take": max(0, min(999, int(_number(raw.get("take")))))}
        if raw["type"] == "pick":
            picked = raw.get("picked")
            node["picked"] = {str(k)[:200]: str(v)[:400] for k, v in list(picked.items())[:400]} if isinstance(picked, dict) else {}
        if raw.get("more"):
            node["more"] = True
        nodes.append(node)
    edges: list[dict[str, str]] = []
    for raw in list(doc.get("edges") or [])[:400]:
        if not isinstance(raw, dict):
            continue
        a, b, port = str(raw.get("from") or ""), str(raw.get("to") or ""), str(raw.get("in") or "")
        if a not in types or b not in types or a == b:
            continue
        spec = next((i for i in NODES[types[b]]["inputs"] if i["id"] == port), None)
        edge = {"from": a, "to": b, "in": port}
        if spec is None or not fits(NODES[types[a]]["out"], spec["type"]) or edge in edges or _leads_to(edges, b, a):
            continue
        if not spec.get("many"):
            edges = [e for e in edges if not (e["to"] == b and e["in"] == port)]  # the newer wire replaces the older
        edges.append(edge)
    return {"name": str(doc.get("name") or "").strip()[:80] or "Workflow", "nodes": nodes, "edges": edges,
            "tidy": bool(doc.get("tidy")), "template": str(doc.get("template") or "")[:40]}


def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(_patient(lambda: path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _patient(work: Callable[[], Any]) -> Any:
    """Windows refuses a file for the moment another request has it open; wait it out instead of losing a save."""
    for wait in (0.01, 0.03, 0.1, 0.3):
        try:
            return work()
        except PermissionError:
            time.sleep(wait)
    return work()


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    _patient(lambda: tmp.replace(path))


def read(ws_dir: Path, flow_id: str) -> dict[str, Any]:
    path = flow_dir(ws_dir, flow_id) / "flow.json"
    if not path.is_file():
        raise FileNotFoundError("This workflow is gone.")
    return {**clean_doc(read_json(path)), "id": flow_id}


def save(ws_dir: Path, flow_id: str, doc: Any) -> dict[str, Any]:
    folder = flow_dir(ws_dir, flow_id)
    if not (folder / "flow.json").is_file():
        raise FileNotFoundError("This workflow is gone.")
    clean = clean_doc(doc)
    write_json(folder / "flow.json", {**clean, "updated": time.time()})
    return {**clean, "id": flow_id}


def create(ws_dir: Path, doc: Any) -> dict[str, Any]:
    clean = clean_doc(doc)
    base = slugify(clean["name"])[:40].strip("-")
    base = flow_id = base if ID_RE.match(base) else "workflow"
    n = 2
    while (flows_root(ws_dir) / flow_id).exists():
        flow_id, n = f"{base}-{n}", n + 1
    root = flows_root(ws_dir)
    root.mkdir(parents=True, exist_ok=True)
    ignore = root / ".gitignore"
    if not ignore.is_file():  # the workflows belong in the game's git; their trial results don't
        ignore.write_text("*/out/\n*/state.json\n", encoding="utf-8")
    write_json(root / flow_id / "flow.json", {**clean, "updated": time.time()})
    return {**clean, "id": flow_id}


def duplicate(ws_dir: Path, flow_id: str) -> dict[str, Any]:
    doc = read(ws_dir, flow_id)
    copy = create(ws_dir, {**doc, "name": f"{doc['name']} copy"})
    # What it already made is kept (the same files), so the copy starts where the original is. Saved assets are the
    # original's: the copy saves its own.
    state = load_state(ws_dir, flow_id)
    save_state(ws_dir, copy["id"], {**state, "saved": {}})
    return copy


def delete(ws_dir: Path, flow_id: str) -> str | None:
    return move_to_trash(ws_dir, flow_dir(ws_dir, flow_id))


def restore(ws_dir: Path, flow_id: str, trashed: str) -> None:
    """Undo of `delete`."""
    source, target = resolve_rel(ws_dir, trashed), flow_dir(ws_dir, flow_id)
    if source.parent.name != ".trash" or not (source / "flow.json").is_file() or target.exists():
        raise ValueError("That workflow can't be brought back.")
    target.parent.mkdir(parents=True, exist_ok=True)
    source.rename(target)


def list_flows(ws_dir: Path) -> list[dict[str, Any]]:
    out = []
    root = flows_root(ws_dir)
    for folder in root.iterdir() if root.is_dir() else []:
        data = read_json(folder / "flow.json")
        if not data:
            continue
        doc = clean_doc(data)
        state = load_state(ws_dir, folder.name)
        pics = []
        for node in reversed(_topological(doc)):
            for v in (state["nodes"].get(node["id"]) or {}).get("values") or []:
                pic = v.get("thumb") or (v.get("path") if v.get("t") in ("picture", "surface") else "")
                if pic and (ws_dir / pic).is_file():
                    pics.append(pic)
        out.append({"id": folder.name, "name": doc["name"], "updated": float(data.get("updated") or 0),
                    "steps": [n["type"] for n in _topological(doc) if n["type"] != "note"], "thumbs": list(dict.fromkeys(pics))[:4]})
    return sorted(out, key=lambda f: -f["updated"])


def from_steps(name: str, steps: list[tuple[str, str, dict[str, Any]]], wires: list[tuple[str, str, str]], template: str = "") -> dict[str, Any]:
    """A document from steps and wires, laid out left to right (the page tidies it again once it knows card sizes)."""
    nodes = [{"id": sid, "type": kind, "fields": {**default_fields(kind), **fields}} for sid, kind, fields in steps if kind in NODES]
    doc = clean_doc({"name": name, "nodes": nodes, "edges": [{"from": a, "to": b, "in": i} for a, b, i in wires], "tidy": True, "template": template})
    depth = _depths(doc)
    rows: dict[int, int] = {}
    for node in doc["nodes"]:
        column = depth[node["id"]]
        node["x"], node["y"] = column * 340.0, rows.get(column, 0) * 380.0
        rows[column] = rows.get(column, 0) + 1
    return doc


def from_template(template_id: str) -> dict[str, Any]:
    t = next((t for t in flow_nodes.TEMPLATES if t["id"] == template_id), None)
    if t is None:
        raise ValueError("That template is gone.")
    return from_steps(t["title"], t["steps"], t["wires"], template_id)


def add_file(ws_dir: Path, flow_id: str, filename: str, data: bytes) -> str:
    """A picture or model brought in for a "My picture" / "My 3D model" step."""
    suffix = Path(filename).suffix.lower()
    if suffix not in PICTURES | {".glb"}:
        raise ValueError("Use a PNG, JPG or WebP picture, or a .glb 3D model.")
    if len(data) > 200 * 1024 * 1024:
        raise ValueError("That file is larger than 200 MB.")
    folder = flow_dir(ws_dir, flow_id) / "in"
    if not folder.parent.is_dir():
        raise FileNotFoundError("This workflow is gone.")
    if suffix == ".glb":
        if data[:4] != b"glTF":
            raise ValueError("That isn't a .glb 3D model.")
    else:
        try:
            Image.open(io.BytesIO(data)).verify()
        except Exception:  # noqa: BLE001 — whatever Pillow dislikes about it
            raise ValueError("That file isn't a picture Tessera can read.") from None
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(filename).stem).strip("-")[:60] or "picture"
    target, n = folder / f"{stem}{suffix}", 2
    while target.exists() and target.read_bytes() != data:
        target, n = folder / f"{stem}-{n}{suffix}", n + 1
    target.write_bytes(data)
    return rel_to(ws_dir, target)


# ---------- the graph ----------

def _depths(doc: dict[str, Any]) -> dict[str, int]:
    into: dict[str, list[str]] = {}
    for e in doc["edges"]:
        into.setdefault(e["to"], []).append(e["from"])
    depth: dict[str, int] = {}

    def of(nid: str) -> int:
        if nid not in depth:
            depth[nid] = 1 + max((of(p) for p in into.get(nid, [])), default=-1)
        return depth[nid]

    for n in doc["nodes"]:
        of(n["id"])
    return depth


def _topological(doc: dict[str, Any]) -> list[dict[str, Any]]:
    depth = _depths(doc)
    return sorted(doc["nodes"], key=lambda n: depth[n["id"]])  # stable: cards keep the order they were added in


def _ancestors(doc: dict[str, Any], target: str) -> set[str]:
    keep, stack = set(), [target]
    while stack:
        at = stack.pop()
        if at not in keep:
            keep.add(at)
            stack.extend(e["from"] for e in doc["edges"] if e["to"] == at)
    return keep


def types_after(doc: dict[str, Any], start: str) -> set[str]:
    """The kinds of step that come anywhere after this one."""
    return {n["type"] for n in doc["nodes"] if n["id"] != start and _leads_to(doc["edges"], start, n["id"])}


def load_state(ws_dir: Path, flow_id: str) -> dict[str, Any]:
    data = read_json(flow_dir(ws_dir, flow_id) / "state.json")
    return {key: data.get(key) if isinstance(data.get(key), dict) else {} for key in ("nodes", "cache", "saved")}


def save_state(ws_dir: Path, flow_id: str, state: dict[str, Any]) -> None:
    for items in state["cache"].values():
        while len(items) > CACHE_PER_NODE:
            items.pop(next(iter(items)))
    folder = flow_dir(ws_dir, flow_id)
    if folder.is_dir():  # deleted while it ran: nothing to keep
        write_json(folder / "state.json", state)


def sha(*parts: Any) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def lines_of(text: Any) -> list[str]:
    found = [re.sub(r"^\s*(?:[-*•]|\d+[.)])\s+", "", line).strip() for line in str(text or "").splitlines()]
    return list(dict.fromkeys(line[:600] for line in found if line))[:MAX_LINES]


def title_of(text: str) -> str:
    from forge.pixel_engine import short_title

    return short_title(text)


def _signature(value: Value) -> list[Any]:
    """What makes two incoming things the same: the words, or the file."""
    return [value.get("t"), value.get("text"), value.get("path"), value.get("stamp"), value.get("origin"), (value.get("rig") or {}).get("rig_task")]


def text_value(nid: str, words: str) -> Value:
    return {"t": "text", "text": words, "name": title_of(words), "origin": f"{nid}:{sha(words)[:10]}"}


def source_values(ws_dir: Path, node: dict[str, Any]) -> list[Value]:
    """What a starting step gives. Free and instant, so it is never stored."""
    f, nid, kind = node["fields"], node["id"], node["type"]
    if kind == "idea":
        return [text_value(nid, f["text"].strip())] if f["text"].strip() else []
    if kind == "list":
        return [text_value(nid, line) for line in lines_of(f["lines"])]
    if kind == "style":
        return [{"t": "style", "text": flow_nodes.style_text(f), "name": "Art style", "origin": nid}]
    rel = str(f.get("path") or "")
    try:
        path = resolve_rel(ws_dir, rel) if rel else None
    except ValueError:
        path = None
    if not path or not path.is_file() or path.suffix.lower() not in (PICTURES if kind == "my_picture" else {".glb"}):
        return []
    stat = path.stat()
    value = {"t": "picture" if kind == "my_picture" else "model", "path": rel, "name": str(f.get("name") or "").strip() or humanize(path.name),
             "stamp": f"{stat.st_mtime_ns}-{stat.st_size}", "origin": f"{nid}:{sha(rel)[:10]}", "root": rel,
             "folder": "candidates" if kind == "my_picture" else "3d", "kind": "" if kind == "my_picture" else "prop"}
    thumb = path.with_name(f"{path.stem}_thumb.png")
    if kind == "my_model" and thumb.is_file():
        value["thumb"] = rel_to(ws_dir, thumb)
    return [value]


class Plan:
    """What every step of a document would work on, what is already made, and what is missing."""

    def __init__(self, ws_dir: Path, doc: dict[str, Any], state: dict[str, Any]) -> None:
        self.ws_dir, self.doc, self.state = ws_dir, doc, state
        self.nodes = {n["id"]: n for n in doc["nodes"]}
        self.values: dict[str, list[Value]] = {}
        self.estimate: dict[str, int] = {}
        self._exists: dict[str, bool] = {}

    def wired(self, nid: str, port: str) -> list[str]:
        return [e["from"] for e in self.doc["edges"] if e["to"] == nid and e["in"] == port]

    def inputs(self, node: dict[str, Any]) -> dict[str, list[Value]]:
        out = {}
        for spec in NODES[node["type"]]["inputs"]:
            sources = self.wired(node["id"], spec["id"])
            values = [v for src in sources for v in self.values.get(src, [])]
            words = str(node["fields"].get(spec["field"]) or "").strip() if spec.get("field") and not sources else ""
            out[spec["id"]] = [text_value(node["id"], words)] if words else values
        return out

    def jobs(self, node: dict[str, Any], inputs: dict[str, list[Value]]) -> list[tuple[str, Value, dict[str, list[Value]]]]:
        """(key, the thing to work on, the other inputs that go with it) for each run of this step."""
        first, *rest = [i["id"] for i in NODES[node["type"]]["inputs"]]
        out = []
        for index, item in enumerate(inputs[first]):
            others = {port: self._matching(item, inputs[port], index, len(inputs[first]), port) for port in rest}
            key = sha(node["type"], key_fields(node), node["take"], _signature(item), {p: [_signature(v) for v in vs] for p, vs in others.items()})
            out.append((key, item, others))
        return out

    @staticmethod
    def _matching(item: Value, values: list[Value], index: int, count: int, port: str) -> list[Value]:
        """Which of a second input's things go with this one: those made from it, else the one at the same place."""
        if port in ("like", "style") or count == 1:
            return values
        for link in ("root", "origin"):
            own = [v for v in values if v.get(link) and v.get(link) == item.get(link)]
            if own:
                return own
        if port == "sides":
            return []  # another subject's back would only confuse it
        return values if len(values) <= 1 else [values[index]] if len(values) == count else values[:1]

    def there(self, value: Value) -> bool:
        for rel in (value.get("path"), value.get("raw")):
            if rel and rel not in self._exists:
                self._exists[rel] = (self.ws_dir / rel).is_file()
            if rel and not self._exists[rel]:
                return False
        return True

    def cached(self, nid: str, key: str) -> list[Value] | None:
        hit = (self.state["cache"].get(nid) or {}).get(key)
        return hit["values"] if hit and all(self.there(v) for v in hit["values"]) else None

    def groups(self, node: dict[str, Any], values: list[Value]) -> list[dict[str, Any]]:
        """The options of a "Let me choose" step, one row per idea, and what is chosen in each."""
        rows: dict[str, dict[str, Any]] = {}
        for v in values:
            rows.setdefault(v.get("origin") or "", {"group": v.get("origin") or "", "name": v.get("name") or "", "options": []})["options"].append(v)
        for row in rows.values():
            picked = (node.get("picked") or {}).get(row["group"])
            row["chosen"] = next((v["path"] for v in row["options"] if v["path"] == picked), row["options"][0]["path"] if len(row["options"]) == 1 else "")
        return list(rows.values())

    def save_key(self, node: dict[str, Any], values: list[Value]) -> str:
        return sha("save", node["fields"], sorted(json.dumps(_signature(v), default=str) for v in values))

    def look(self) -> dict[str, dict[str, Any]]:
        """Per step: status, what is there, how much is left and what is wrong. Reads files, changes nothing."""
        report: dict[str, dict[str, Any]] = {}
        for node in _topological(self.doc):
            nid, spec = node["id"], NODES[node["type"]]
            row: dict[str, Any] = {"status": "note", "todo": 0, "done": 0, "problem": None, "values": []}
            report[nid] = row
            if node["type"] == "note":
                continue
            row["problem"] = self.problem(node)
            if not spec["inputs"]:
                row["values"] = self.values[nid] = source_values(self.ws_dir, node)
                self.estimate[nid] = row["done"] = len(row["values"])
                row["status"] = "problem" if row["problem"] else "done"
                continue
            ups = list(dict.fromkeys(e["from"] for e in self.doc["edges"] if e["to"] == nid))
            ready = all(report[u]["status"] == "done" for u in ups)
            inputs = self.inputs(node)
            first = spec["inputs"][0]["id"]
            items = inputs[first]
            if node["type"] == "pick":
                row["groups"] = self.groups(node, items)
                by_path = {v["path"]: v for v in items}
                values = [by_path[g["chosen"]] for g in row["groups"] if g["chosen"]]
                row["todo"] = len(row["groups"]) - len(values)
                row["done"] = len(values)
                status = "choose" if row["todo"] else "done" if values and ready else "todo"
                self.estimate[nid] = max(len(row["groups"]), self._expected_groups(nid))
            elif node["type"] == "save":
                kept = self.state["saved"].get(nid) or {}
                done = ready and bool(items) and kept.get("key") == self.save_key(node, items) and all((self.ws_dir / a["asset"]).is_file() for a in kept.get("assets") or [])
                row["saved"] = [a for a in kept.get("assets") or [] if (self.ws_dir / a["asset"]).is_file()]
                row["todo"], row["done"], values = int(not done), int(done), []
                status = "done" if done else "todo"
                self.estimate[nid] = 0
            else:
                wired = self.wired(nid, first)
                expected = sum(self.estimate.get(u, 0) for u in wired) if wired else len(items)
                hits = [self.cached(nid, key) for key, _, _ in self.jobs(node, inputs)]
                values = [v for hit in hits if hit for v in hit]
                row["done"] = sum(1 for h in hits if h is not None)
                row["todo"] = len(hits) - row["done"] + max(0, expected - len(hits))
                status = "done" if ready and hits and not row["todo"] else "todo"
                self.estimate[nid] = len(values) + row["todo"] * self.per_job(node)
            self.values[nid] = row["values"] = values
            if row["problem"]:
                status = "problem"
            elif status != "done" and any(report[u]["status"] in ("problem", "blocked") for u in ups):
                status = "blocked"
            row["status"] = status
        return report

    def _expected_groups(self, nid: str) -> int:
        """How many rows a choosing step will have: one per idea, however many options each has."""
        total = 0
        for src in self.wired(nid, "picture"):
            count = self.estimate.get(src, 0)
            per = self.per_job(self.nodes[src]) if NODES[self.nodes[src]["type"]]["inputs"] else 1
            total += max(1, round(count / max(1, per))) if count else 0
        return total

    @staticmethod
    def per_job(node: dict[str, Any]) -> int:
        """How many things one run of a step gives (a guess for cutting up a sheet)."""
        f = node["fields"]
        return {"views": 2, "split": 6, "vary": len(lines_of(f.get("lines"))), "recolor": len(f.get("colours") or []),
                "icons": len(f.get("sizes") or [])}.get(node["type"], int(f.get("count") or 1))

    def problem(self, node: dict[str, Any]) -> dict[str, Any] | None:
        """The one thing to fix on this step, in words, with what the page should offer."""
        spec = NODES[node["type"]]
        for field in spec["fields"]:
            value, kind = node["fields"].get(field["id"]), field["kind"]
            if not field.get("required"):
                continue
            if kind == "lines":
                value = lines_of(value)
            elif kind in ("text", "line"):
                value = str(value or "").strip()
            if not value:
                words = {"text": "Write your idea here.", "lines": "Write at least one line.", "picture": "Choose a picture.",
                         "model": "Choose a 3D model.", "multi": f"Pick at least one under {field['label']}."}
                return {"text": words.get(kind, f"Fill in {field['label']}."), "fix": "field", "field": field["id"]}
            if kind in ("picture", "model") and not source_values(self.ws_dir, node):
                return {"text": "That file is gone. Choose another one.", "fix": "field", "field": field["id"]}
        for port in spec["inputs"]:
            if not port.get("required") or self.wired(node["id"], port["id"]):
                continue
            if port.get("field"):
                if not str(node["fields"].get(port["field"]) or "").strip():
                    return {"text": "Write it here, or connect an idea.", "fix": "field", "field": port["field"]}
                continue
            what = "something to save" if port["type"] == "any" else f"{'words' if port['type'] == 'text' else 'a ' + TYPES[port['type']]}"
            return {"text": f"Needs {what}.", "fix": "input", "input": port["id"], "type": port["type"]}
        return setup_problem(node)


def setup_problem(node: dict[str, Any]) -> dict[str, Any] | None:
    """A step whose account isn't connected. Demo mode needs none: it makes placeholders."""
    paid = NODES[node["type"]].get("paid")
    cfg = load_config()
    if not paid or cfg.demo_mode:
        return None
    if flow_models.chosen(node):
        return flow_models.missing(node, cfg)
    say = ""
    if paid == "image":
        model = asset_studio.default_image_model(cfg)
        if not model.startswith("svc:") and not any(m["available"] for m in asset_studio.list_image_models()):
            say = "Connect an image account to draw."
    elif paid == "3d":
        if not (cfg.default_3d_service_model or cfg.get_key("meshy") or cfg.get_key("tripo")):
            say = "Connect Meshy or Tripo to make 3D."
    elif paid in ("rig", "animate"):
        if not (cfg.get_key("meshy") or cfg.get_key("tripo")):
            say = "Connect Meshy or Tripo for skeletons and moves."
    elif not any(m["available"] and node["fields"]["kind"] in m["kinds"] for m in asset_studio.list_audio_models()):
        say = "Connect a sound account to make sounds."
    return {"text": say, "fix": "settings"} if say else None


def job_cost(node: dict[str, Any]) -> tuple[float, str]:
    """(US dollars, "") for one run of a paid step, or (0, the credits it uses) when it has no price in dollars."""
    from forge import game_tools, tripo

    paid = NODES[node["type"]].get("paid")
    cfg = load_config()
    if not paid or cfg.demo_mode:
        return 0.0, ""
    model = flow_models.used(node, cfg)
    if model.startswith("svc:") and paid != "sound":
        return 0.0, f"{model[4:].split('/')[0].title()} credits"
    if paid == "image":
        price = next((m["price"] for m in asset_studio.list_image_models() if m["id"] == model), 0.0)
        return float(price or 0) * int(NODES[node["type"]].get("cost_count") or node["fields"].get("count") or 1), ""
    if paid == "3d":
        if model.startswith("tripo:"):
            return tripo.estimate_credits("image", {"texture": node["fields"]["texture"]}) * tripo.USD_PER_CREDIT, ""
        return 0.3 if node["fields"]["texture"] else 0.2, ""
    if paid in ("rig", "animate"):
        if (node["fields"].get("model") or game_tools.rig_engine()) == "tripo":
            return tripo.CREDITS["rig" if paid == "rig" else "retarget"] * tripo.USD_PER_CREDIT, ""
        return (game_tools.RIG_CREDITS if paid == "rig" else game_tools.ANIMATION_CREDITS) / 100, ""
    return 0.0, "sound credits"


def check(ws_dir: Path, flow_id: str, doc: Any, target: str = "") -> dict[str, Any]:
    """The document as the page shows it: each step's status and problem, and what Run would do and cost."""
    doc = clean_doc(doc)
    state = load_state(ws_dir, flow_id)
    plan = Plan(ws_dir, doc, state)
    report = plan.look()
    keep = _ancestors(doc, target) if target in plan.nodes else set(plan.nodes)
    usd, credits, counts = 0.0, [], {}
    for node in _topological(doc):
        nid, spec, row = node["id"], NODES[node["type"]], report[node["id"]]
        last = state["nodes"].get(nid) or {}
        row["error"] = str(last.get("error") or "") if row["status"] in ("todo", "blocked") else ""
        row["notes"] = list(last.get("notes") or []) if row["done"] else []
        if spec.get("paid") == "3d":  # several options straight into a dear step: offer to choose first
            src = next((plan.nodes[s] for s in plan.wired(nid, "picture")), None)
            if src and src["type"] in ("draw", "pixel") and src["fields"]["count"] > 1:
                row["advice"] = {"text": f"This makes {src['fields']['count']} models per idea, one for each picture.", "fix": "pick", "from": src["id"]}
        if nid in keep and spec.get("paid") and row["todo"] and not row["problem"]:
            rigged = next((plan.nodes[s] for s in plan.wired(nid, "rig")), None) if spec["paid"] == "animate" else None
            # Moves come from whoever made the skeleton.
            cost, why = job_cost({**node, "fields": {**node["fields"], "model": rigged["fields"].get("model") or ""}} if rigged else node)
            usd += cost * row["todo"]
            if why and why not in credits:
                credits.append(why)
            each = int(spec.get("cost_count") or node["fields"].get("count") or 1) if spec["paid"] in ("image", "sound") else 1
            counts[spec["paid"]] = counts.get(spec["paid"], 0) + row["todo"] * each
    return {"steps": report, "problems": [{"node": nid, **row["problem"]} for nid, row in report.items() if row["problem"] and nid in keep],
            "left": sum(1 for nid, row in report.items() if nid in keep and row["status"] in ("todo", "blocked")),
            "choose": [nid for nid, row in report.items() if row["status"] == "choose" and nid in keep],
            "usd": round(usd, 2), "credits": credits, "counts": counts, "demo": bool(load_config().demo_mode)}


# ---------- running ----------

class Run:
    """One press of Run. Steps run as soon as what they need is there; the page follows along through `notify`."""

    def __init__(self, ws_dir: Path, flow_id: str, doc: dict[str, Any], request: RunRequest, notify: Notify, target: str = "",
                 on_saved: Callable[[], Awaitable[None]] | None = None, gates: dict[str, asyncio.Semaphore] | None = None) -> None:
        self.ws_dir, self.flow_id, self.doc = ws_dir, flow_id, clean_doc(doc)
        self.request, self.notify, self.on_saved = request, notify, on_saved
        self.state = load_state(ws_dir, flow_id)
        self.plan = Plan(ws_dir, self.doc, self.state)
        self.keep = _ancestors(self.doc, target) if target in self.plan.nodes else set(self.plan.nodes)
        self.live: dict[str, dict[str, Any]] = {}
        self.gates = gates if gates is not None else {}
        self.result = "done"

    async def _say(self, nid: str, **fields: Any) -> None:
        row = self.live.setdefault(nid, {})
        row.update(fields)
        await self.notify({"node": nid, "step": dict(row)})

    async def go(self) -> str:
        nodes = [n for n in _topological(self.doc) if n["id"] in self.keep and n["type"] != "note"]
        done = {n["id"]: asyncio.Event() for n in nodes}
        for node in nodes:  # an old error is not the news once a new run starts
            row = self.state["nodes"].get(node["id"]) or {}
            row.pop("error", None)
            row.pop("notes", None)
            self.live[node["id"]] = {"status": "waiting"}
        try:
            await asyncio.gather(*(self._step(node, done) for node in nodes))
        finally:
            save_state(self.ws_dir, self.flow_id, self.state)
        return self.result

    def _worse(self, result: str) -> None:
        order = ("done", "choose", "problem", "failed")
        self.result = max(self.result, result, key=order.index)

    async def _step(self, node: dict[str, Any], done: dict[str, asyncio.Event]) -> None:
        nid, spec = node["id"], NODES[node["type"]]
        ups = list(dict.fromkeys(e["from"] for e in self.doc["edges"] if e["to"] == nid))
        try:
            for up in ups:
                await done[up].wait()
            problem = self.plan.problem(node)
            if problem:
                self._worse("problem")
                await self._say(nid, status="problem", error=problem["text"])
            elif any(not self.plan.values.get(up) for up in ups):
                # A list where some failed carries on with the ones that worked; a step with nothing to work on waits.
                await self._say(nid, status="blocked")
            elif not spec["inputs"]:
                self.plan.values[nid] = source_values(self.ws_dir, node)
                await self._say(nid, status="done", values=self.plan.values[nid])
            elif node["type"] == "pick":
                await self._pick(node)
            elif node["type"] == "save":
                await self._save(node)
            else:
                await self._each(node)
        except asyncio.CancelledError:
            self.live[nid] = {**self.live.get(nid, {}), "status": "stopped"}
            raise
        except Exception as exc:  # noqa: BLE001 — one broken step must not take the others down
            await self._fail(nid, str(exc).strip() or type(exc).__name__)
        finally:
            done[nid].set()

    async def _fail(self, nid: str, error: str) -> None:
        self.state["nodes"].setdefault(nid, {})["error"] = error[:400]
        self._worse("failed")
        await self._say(nid, status="failed", error=error[:400])

    async def _pick(self, node: dict[str, Any]) -> None:
        nid = node["id"]
        options = self.plan.inputs(node)["picture"]
        groups = self.plan.groups(node, options)
        by_path = {v["path"]: v for v in options}
        values = [by_path[g["chosen"]] for g in groups if g["chosen"]]
        self.state["nodes"].setdefault(nid, {})["values"] = values
        waiting = len(values) < len(groups)
        # Nothing after it starts until every idea has its favourite, so the next step runs once, not in dribs.
        self.plan.values[nid] = [] if waiting else values
        if waiting:
            self._worse("choose")
        await self._say(nid, status="choose" if waiting else "done", groups=groups, values=values)

    async def _each(self, node: dict[str, Any]) -> None:
        from forge.flow_steps import STEPS

        nid, spec = node["id"], NODES[node["type"]]
        jobs = self.plan.jobs(node, self.plan.inputs(node))
        results: list[list[Value] | None] = [self.plan.cached(nid, key) for key, _, _ in jobs]
        errors: list[str] = []
        notes: list[str] = []

        async def publish(status: str, **more: Any) -> None:
            values = [v for r in results if r for v in r]
            self.plan.values[nid] = values
            self.state["nodes"].setdefault(nid, {})["values"] = values
            await self._say(nid, status=status, values=values, done=sum(1 for r in results if r is not None), total=len(jobs), **more)

        async def one(index: int) -> None:
            key, item, others = jobs[index]
            async with gate:
                try:
                    made = await STEPS[node["type"]](self, node, key, item, others, notes)
                    if not made:
                        raise ValueError("Nothing came back. Try again.")
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 — the others in the list carry on
                    reason = str(exc).strip() or type(exc).__name__
                    errors.append(f"{item.get('name') or 'One of them'}: {reason}" if len(jobs) > 1 else reason)
                    return
            results[index] = made
            self.state["cache"].setdefault(nid, {})[key] = {"values": made, "at": time.time()}
            save_state(self.ws_dir, self.flow_id, self.state)  # a paid result is never lost to a crash
            await publish("running")

        if any(r is None for r in results):
            await publish("running")
            gate = self.gates.setdefault(spec.get("paid") or "local", asyncio.Semaphore(PAID_AT_ONCE.get(spec.get("paid") or "", 2)))
            await asyncio.gather(*(one(i) for i, r in enumerate(results) if r is None))
            self.state["nodes"].setdefault(nid, {})["notes"] = list(dict.fromkeys(notes))
        if errors:
            await publish("running")
            await self._fail(nid, " ".join(dict.fromkeys(errors)))
        else:
            await publish("done", notes=list(dict.fromkeys(notes)))

    async def _save(self, node: dict[str, Any]) -> None:
        from forge.flow_steps import save_to_project

        nid = node["id"]
        values = self.plan.inputs(node)["any"]
        key = self.plan.save_key(node, values)
        saved = self.state["saved"].setdefault(nid, {})
        if saved.get("key") != key or not all((self.ws_dir / a["asset"]).is_file() for a in saved.get("assets") or []):
            await self._say(nid, status="running")
            assets = await asyncio.to_thread(save_to_project, self.ws_dir, node, values, saved.setdefault("by_origin", {}))
            saved.update(key=key, assets=assets)
            if self.on_saved:
                await self.on_saved()
        await self._say(nid, status="done", saved=saved["assets"])
