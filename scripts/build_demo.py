"""Build the read-only live demo for the website (docs/demo/): the real Tessera UI on the Pocket Kaiju sample.

The sample is installed into a throwaway Tessera, every answer the UI reads is recorded into data.json, and
the UI is copied next to it with demo-shim.js in front: reads come from data.json, anything that would
change the project or spend credits says it's a demo instead.

    uv run python scripts/build_demo.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "demo"
UI = ROOT / "forge" / "ui"
PROJECT = "pocket_kaiju"

# Static answers the UI asks for at start or when a panel opens.
STATIC = [
    "/api/config", "/api/projects", "/api/projects/cards", "/api/overview", "/api/board", "/api/link", "/api/orders",
    "/api/agent/sessions", "/api/access", "/api/storage", "/api/connect", "/api/vault", "/api/studio/jobs",
    "/api/studio/options", "/api/studio/icons", "/api/studio/animations", "/api/budget", "/api/studio/credits",
    "/api/update/state", "/api/agent/endpoints", "/api/services", "/api/studio/service-models", "/api/studio/voices",
]

# A short scripted chat, so the left panel shows what talking to Tess looks like.
CHAT = [
    ("user", "Pocket Kaiju: a bite-sized 3D arcade brawler. You play Mochi, a pocket-sized pastel kaiju, defending a neon "
             "miniature Tokyo from clumsy tin-toy robots. Set the project up."),
    ("agent", "Done. The style bible asks for chunky vinyl-toy proportions, candy pastels with neon magenta and cyan, and a "
              "cel-shaded game look. I made sections for design, characters, locations, props, UI, sound and VFX, with first assets in each.",
     ["Wrote pillars/style-bible.md", "Created 02-characters/player/mochi.md", "Created 02-characters/invaders/tin-scout.md",
      "Created 06-sound/combat/mochi-roar.md"]),
    ("user", "Make the three tin robots and Mochi's roar."),
    ("agent", "Candidates are waiting on each robot page, and Mochi's roar is on its sound page. Pick a winner and I'll turn the robots into 3D.",
     ["Generated 02-characters/invaders/tin-scout.md", "Generated 02-characters/invaders/tin-brute.md",
      "Generated 02-characters/invaders/tin-titan.md", "Generated 06-sound/combat/mochi-roar.md"]),
]


def _key(path: str, params: dict[str, str]) -> str:
    """Same key demo-shim.js builds: the path plus its sorted query, without `project`."""
    query = urlencode(sorted((k, v) for k, v in params.items() if k != "project"))
    return f"{path}?{query}" if query else path


def record(client, ws: Path, scrub: list[str]) -> dict[str, dict]:
    from forge.blueprint_contract import split_frontmatter

    data: dict[str, dict] = {}

    def get(endpoint: str, **params: str) -> dict | None:
        res = client.get(endpoint, params={**params, "project": PROJECT})
        try:
            body = res.json()
        except ValueError:
            return None
        data[_key(endpoint, params)] = {"status": res.status_code, "body": body}
        return body

    for path in STATIC:
        get(path)
    for session in (get("/api/agent/sessions") or {}).get("sessions", []):
        get(f"/api/agent/sessions/{session['id']}")
    for folder in sorted(p for p in ws.rglob("*") if p.is_dir() and not p.name.startswith(".")):
        rel = folder.relative_to(ws).as_posix()
        if (folder / "README.md").is_file() or any(folder.glob("*.md")):
            get("/api/overview/folder", path=rel)
            get("/api/studio/batch", folder=rel)
            if "/" not in rel:  # a section's page shows all its sub-folders at once
                get("/api/overview/section", path=rel)
    for doc in sorted(ws.rglob("*.md")):
        rel = doc.relative_to(ws).as_posix()
        get("/api/overview/file", path=rel)
        if split_frontmatter(doc.read_text(encoding="utf-8"))[0].get("kind"):
            get("/api/studio/asset", path=rel)
            get("/api/studio/history", path=rel)
            # The send sheet builds its prompt with a POST that changes nothing; the shim keys it like a GET.
            for action in ("candidates", "make_3d", "views"):
                res = client.post("/api/studio/preview", params={"project": PROJECT}, json={"path": rel, "action": action})
                if res.status_code == 200:
                    data[_key("/api/studio/preview", {"action": action, "path": rel})] = {"status": 200, "body": res.json()}
    # This Tessera has no keys; show the generators as set up, the way a visitor's own Tessera would (sending stays blocked).
    for model in [*data["/api/studio/options"]["body"]["models"], *data["/api/studio/options"]["body"]["audio_models"]]:
        model["available"] = True
    # Only the sample, not the empty "default" project every Tessera starts with.
    data["/api/projects"]["body"]["projects"] = [PROJECT]
    data["/api/projects"]["body"]["default_project"] = PROJECT
    data["/api/projects/cards"]["body"]["projects"] = [c for c in data["/api/projects/cards"]["body"]["projects"] if c["project"] == PROJECT]
    # One chat model, so the composer looks connected; sending a message gets the read-only note.
    data["/api/agent/models"] = {"status": 200, "body": {"models": [{"id": "demo", "label": "Demo (read-only)", "ready": True, "provider": "demo"}], "selected": "demo"}}
    # Settings → This PC shows an example 12 GB card, never the build machine's own hardware or folders.
    from forge.local_ai import catalog
    from forge.local_ai.hardware import summarize
    from forge.local_ai.runtime import RUNTIME_GB

    pc = summarize([{"name": "NVIDIA GeForce RTX 4070", "vram_gb": 12.0, "compute_cap": 8.9, "driver": 581.0}], False, 32.0)
    best = {kind: catalog.recommended(pc, kind) for kind, _ in catalog.KINDS}

    def missing(model):  # nothing is installed in the demo: every model needs its dependencies, each after what it needs
        out = []
        for dep_id in model.deps:
            for need in (*catalog.DEP_BY_ID[dep_id].needs, dep_id):
                if need not in out:
                    out.append(need)
        return out

    data["/api/local-ai"] = {"status": 200, "body": {
        "hardware": pc, "preset": catalog.preset_name(pc), "recommended": best["image"],
        "models": [{**catalog.describe(m, pc), "installed": False, "recommended": m.id == best.get(m.kind), "missing_deps": missing(m),
                    "needed_gb": round(m.size_gb + sum(catalog.DEP_BY_ID[d].size_gb for d in missing(m)), 1)} for m in catalog.MODELS],
        "deps": [{"id": d.id, "label": d.label, "blurb": d.blurb, "size_gb": d.size_gb, "needs": list(d.needs), "installed": False, "used_by": []} for d in catalog.DEPS],
        "kinds": [list(k) for k in catalog.KINDS], "engine": {"running": False}, "ram_used_gb": 9.5,
        "runtime": {"ready": False, "size_gb": RUNTIME_GB}, "folder": "~/.forge/local-ai", "disk_free_gb": 240.0,
        "install": {"status": "idle", "model": "", "stage": "", "percent": 0, "error": "", "kind": "install"}, "uv": True}}

    text = json.dumps(data, separators=(",", ":"))
    for secret in scrub:
        text = text.replace(json.dumps(secret)[1:-1], "~/Tessera")
    return json.loads(text)


def record_flows(client, ws: Path, data: dict[str, dict]) -> None:
    """Node Studio: one finished workflow on Mochi, and every template and example as something to open and play with."""
    import asyncio

    from forge import flow_nodes, flows

    def post(endpoint: str, body: dict) -> dict:
        return client.post(endpoint, params={"project": PROJECT}, json=body).json()

    def keep(of: str, body: dict) -> str:
        made = post("/api/flows/create", body)
        data[f"/api/flows/create?{urlencode({'of': of})}"] = {"status": 200, "body": made}
        data[f"/api/flows?id={made['id']}"] = {"status": 200, "body": client.get("/api/flows", params={"project": PROJECT, "id": made["id"]}).json()}
        return made["id"]

    async def quiet(*_: object) -> list[str]:
        return []

    board = [a for g in data["/api/board"]["body"]["groups"] for a in g["assets"]]
    mochi = next(a for a in board if a["title"].lower() == "mochi" and a.get("image"))
    doc = flows.from_template("recolours")
    doc["name"] = "Mochi in new colours"
    doc["nodes"][0]["fields"] = {"path": mochi["image"], "name": "Mochi"}
    flow = post("/api/flows/create", {"doc": doc})["id"]
    asyncio.run(flows.Run(ws, flow, flows.read(ws, flow), quiet, quiet, target="recolor").go())  # free steps only
    data[f"/api/flows?id={flow}"] = {"status": 200, "body": client.get("/api/flows", params={"project": PROJECT, "id": flow}).json()}
    data["/api/flows/home"] = {"status": 200, "body": client.get("/api/flows/home", params={"project": PROJECT}).json()}
    for template in flow_nodes.catalogue()["templates"]:
        keep(template["id"], {"template": template["id"]})
    keep("My workflow", {"doc": {"name": "My workflow"}})  # the empty canvas
    examples = re.search(r"const EXAMPLES = (\[.*?\]);", (UI / "flows.js").read_text(encoding="utf-8"), re.S)
    for text in re.findall(r'"([^"]+)"', examples[1]):
        drafted = post("/api/flows/draft", {"text": text})
        data[f"/api/flows/draft?{urlencode({'text': text})}"] = {"status": 200, "body": drafted}
        keep(drafted["doc"]["name"], {"doc": drafted["doc"]})


def copy_ui() -> None:
    (OUT / "ui").mkdir(parents=True)
    for item in UI.iterdir():
        if item.name == "index.html":
            continue
        (shutil.copytree if item.is_dir() else shutil.copy2)(item, OUT / "ui" / item.name)
    app = (OUT / "ui" / "app.js").read_text(encoding="utf-8")
    # Pages live under /<repo>/demo/, so the app's root-absolute links become relative to the page.
    # Workspace files get an absolute path again (three.js resolves a relative model URL twice).
    files = '`${new URL("projects/", document.baseURI).pathname}${'
    fixed = app.replace('"/ui/', '"ui/').replace("`/projects/${", files)
    assert fixed.count(files) == 2, "fileUrl/projectFileUrl changed: update build_demo.py"
    (OUT / "ui" / "app.js").write_text(fixed, encoding="utf-8")
    for page in (OUT / "ui").glob("*.js"):
        page.write_bytes(page.read_bytes().replace(b'"/ui/', b'"ui/'))
    html = (UI / "index.html").read_text(encoding="utf-8").replace('"/ui/', '"ui/')
    head = ('<script src="demo-shim.js"></script>\n  <link rel="stylesheet" href="demo.css" />\n'
            '  <meta name="robots" content="noindex" />\n</head>')
    banner = ('<body>\n  <div class="demo-pill" role="note"><b>Live demo</b><span>Read-only · nothing is generated</span>'
              '<a href="../#install">Download Tessera</a></div>')
    # On a phone the demo opens on the project, not the chat.
    html = (html.replace('<div class="shell" data-active="chat">', '<div class="shell" data-active="workspace">')
            .replace('data-show="chat" class="active"', 'data-show="chat"').replace('data-show="workspace"', 'data-show="workspace" class="active"'))
    html = html.replace("<title>Tessera Studio</title>", "<title>Tessera Studio · Live demo</title>").replace("</head>", head, 1).replace("<body>", banner, 1)
    (OUT / "index.html").write_text(html, encoding="utf-8")
    for name in ("demo-shim.js", "demo.css"):
        shutil.copy2(ROOT / "scripts" / "demo" / name, OUT / name)


def main() -> None:
    for name in list(os.environ):
        if re.search(r"KEY|TOKEN|SECRET", name):
            os.environ.pop(name)
    tmp = Path(tempfile.mkdtemp(prefix="tessera-demo-"))
    os.environ["FORGE_CONFIG_DIR"] = str(tmp / "config")
    os.environ["FORGE_PROJECTS_DIR"] = str(tmp / "projects")
    os.environ["FORGE_DEMO_MODE"] = "1"
    os.environ["MESHY_CONFIG_DIR"] = str(tmp / "meshy")  # not this machine's Meshy sign-in
    sys.path.insert(0, str(ROOT))
    from fastapi.testclient import TestClient

    from forge import config as forge_config

    # Keys also come from the Windows user environment in the registry, which clearing os.environ doesn't reach.
    forge_config._read_win32_user_env = lambda _name: ""

    from forge import flows
    from forge.server.app import app, workspace_agent

    client = TestClient(app, base_url="http://127.0.0.1:8420")
    client.put("/api/config", json={"onboarded": True, "auto_update_check": False})
    assert client.post("/api/projects/sample", json={}).json()["project"] == PROJECT
    ws = Path(client.get("/api/storage", params={"project": PROJECT}).json()["workspace_dir"])
    now = time.time() - 3600
    messages = [{"role": m[0], "text": m[1], "actions": [{"tool": "workspace_write", "summary": s} for s in (m[2] if len(m) > 2 else [])],
                 "at": now + i * 60} for i, m in enumerate(CHAT)]
    workspace_agent.create_session(PROJECT, title="Set up Pocket Kaiju", messages=messages)

    if OUT.exists():
        shutil.rmtree(OUT)
    data = record(client, ws, [str(tmp.resolve()), str(tmp), str(Path.home())])
    record_flows(client, ws, data)
    copy_ui()
    shutil.copytree(ws, OUT / "projects" / PROJECT / "workspace", ignore=shutil.ignore_patterns(".*"))
    shutil.copytree(ws / flows.FLOWS_DIR, OUT / "projects" / PROJECT / "workspace" / flows.FLOWS_DIR, ignore=shutil.ignore_patterns("*.json", "*.md", ".gitignore"))
    text = json.dumps(data, separators=(",", ":"))
    # The demo is published: not even a masked key (its last four characters) may be in it.
    leaked = re.findall(r'"(\w+_api_key)":"([^"]+)"', text)
    if leaked or '"meshy_signed_in":true' in text:
        sys.exit(f"Refusing to publish the demo: it recorded a key or sign-in ({', '.join(k for k, _ in leaked) or 'meshy_signed_in'}).")
    (OUT / "data.json").write_text(text, encoding="utf-8")
    shutil.rmtree(tmp, ignore_errors=True)
    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"{OUT}: {len(data)} answers, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
