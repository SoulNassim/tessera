"""Which AI model makes what in the Node Studio: the choices on a step's card, and the one it uses when left on Automatic.

A step keeps its choice in its `model` field; empty means Automatic, which follows Settings like the rest of Tessera
(and the best connected model for pixel art on a pixel step). Ids are the ones Tessera uses everywhere: an image model,
`meshy:<model>` / `tripo:<model>` / `svc:<service>/<model>` for 3D, the engine's name for a skeleton, a sound model.
"""

from __future__ import annotations

from typing import Any

from forge import asset_studio, flow_nodes, game_tools, section_view, service_gen, services, tripo

MESHY_NAMES = {"meshy-7.1": ("Meshy 7.1", "Best detail"), "meshy-6": ("Meshy 6", ""), "meshy-6-lite": ("Meshy 6 Lite", ""),
               "meshy-t2.5": ("Meshy T2.5", "Low-poly"), "meshy-t2": ("Meshy T2", "Low-poly")}


def makes(node_type: str) -> str:
    """What a step's AI model makes ("" when it uses none of its own): image, pixel, 3d, rig or sound."""
    return next((f["makes"] for f in flow_nodes.NODES[node_type]["fields"] if f["kind"] == "maker"), "")


def _price(usd: Any) -> str:
    return f"about ${f'{float(usd):.3f}'.rstrip('0').ljust(4, '0')}" if usd else ""


def _option(mid: str, who: str, name: str, ready: bool, **more: Any) -> dict[str, Any]:
    return {"id": mid, "who": who, "name": name, "ready": ready, "price": "", "note": "", "kinds": [], **more}


def _split(label: str) -> tuple[str, str]:
    who, _, name = label.partition(" · ")
    return (who, name) if name else ("", label)


def _service(kind: str, cfg: Any, models: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if cfg.demo_mode:  # a signed-in service is a real account: demo mode has nothing to do with it
        return []
    out = []
    for m in service_gen.cached_catalog(kind) if models is None else models:
        who, name = _split(m["label"])
        out.append(_option(m["id"], who, name, True, price=f"{who} credits"))
    return out


def options(kind: str, cfg: Any, from_services: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Every model that can make `kind`, connected or not. `from_services` replaces what is remembered of their lists."""
    if kind in ("image", "pixel"):
        out = []
        for m in asset_studio.list_image_models():
            who, name = _split(str(m.get("label") or m["id"]))
            out.append(_option(m["id"], who, name, bool(m["available"]), price="Free" if m.get("local") else _price(m.get("price")),
                               note="Can't see other pictures" if m.get("local") else ""))
        return out + _service("image", cfg, from_services)
    meshy, has_tripo = bool(cfg.get_key("meshy")), bool(cfg.get_key("tripo"))
    if kind == "3d":
        out = [_option(f"meshy:{mid}", "Meshy", MESHY_NAMES.get(mid, (mid, ""))[0], meshy, note=MESHY_NAMES.get(mid, ("", ""))[1], price=_price(0.3))
               for mid in asset_studio.MESH_CHOICES["ai_model"]]
        for mid, label in tripo.MODELS.items():
            name, _, note = label.partition(" · ")
            out.append(_option(f"tripo:{mid}", "Tripo", name, has_tripo, note=note[:1].upper() + note[1:],
                               price=_price(tripo.estimate_credits("image", {}) * tripo.USD_PER_CREDIT)))
        return out + _service("3d", cfg, from_services)
    if kind == "rig":
        return [_option("meshy", "Meshy", "Meshy", meshy, note="Two legs", price=_price(game_tools.RIG_CREDITS / 100)),
                _option("tripo", "Tripo", "Tripo", has_tripo, note="Two or four legs", price=_price(tripo.CREDITS["rig"] * tripo.USD_PER_CREDIT))]
    out = []
    for m in asset_studio.list_audio_models():
        if cfg.demo_mode and "service" in m:
            continue
        who, name = _split(m["label"].replace(" (signed in)", ""))
        out.append(_option(m["id"], who, name[:1].upper() + name[1:], bool(m["available"]), kinds=m["kinds"],
                           note="Signed in" if "service" in m else "", price=f"{who} credits"))
    return out


def automatic(kind: str, cfg: Any, sound: str = "sfx") -> str:
    """The model a step left on Automatic uses."""
    if kind == "pixel" and not cfg.demo_mode:
        from forge import pixel_engine

        return pixel_engine.recommended_model(asset_studio.list_image_models()) or asset_studio.default_image_model(cfg)
    if kind in ("image", "pixel"):
        return asset_studio.default_image_model(cfg)
    if kind == "3d":
        if cfg.default_3d_service_model and not cfg.demo_mode:
            return cfg.default_3d_service_model
        return f"tripo:{cfg.tripo_model}" if cfg.default_3d_provider == "tripo" else f"meshy:{asset_studio.mesh_settings(cfg)['ai_model']}"
    if kind == "rig":
        return game_tools.rig_engine()
    mine = [m for m in asset_studio.list_audio_models() if sound in m["kinds"]]
    return next((m["id"] for m in mine if m["available"]), next((m["id"] for m in mine if "service" not in m), ""))


def chosen(node: dict[str, Any]) -> str:
    """The model picked on the step itself, "" for Automatic. A sound model only counts for the sound it makes."""
    model = str(node["fields"].get("model") or "")
    if model and makes(node["type"]) == "sound":
        return model if any(m["id"] == model and node["fields"]["kind"] in m["kinds"] for m in asset_studio.AUDIO_MODELS) else ""
    return model


def used(node: dict[str, Any], cfg: Any) -> str:
    kind = makes(node["type"])
    return chosen(node) or (automatic(kind, cfg, str(node["fields"].get("kind") or "sfx")) if kind else "")


def missing(node: dict[str, Any], cfg: Any) -> dict[str, Any] | None:
    """What is wrong with the model picked on this step: gone, or its account isn't connected."""
    model = chosen(node)
    if not model:
        return None
    if model.startswith(service_gen.PREFIX) and makes(node["type"]) != "sound":
        # A service's list may not be loaded yet, so only its sign-in is checked.
        service = model[len(service_gen.PREFIX):].split("/")[0]
        if service in services.connected():
            return None
        if service in services.SERVICES:
            return {"text": f"Sign in to {services.SERVICES[service]['label']}, or choose another AI model.", "fix": "settings"}
    hit = next((o for o in options(makes(node["type"]), cfg) if o["id"] == model), None)
    if hit is None:
        return {"text": f"{section_view.model_label(model)} isn't available any more. Choose another AI model.", "fix": "field", "field": "model"}
    return None if hit["ready"] else {"text": f"Connect {hit['who']}, or choose another AI model.", "fix": "settings"}


def book(cfg: Any) -> dict[str, Any]:
    """Every choice and every Automatic, for the page. Asks signed-in services for their lists, so never on the event loop."""
    live = {} if cfg.demo_mode else {kind: service_gen.catalog(kind) for kind in ("image", "3d")}
    return {"demo": bool(cfg.demo_mode),
            "options": {kind: options(kind, cfg, live.get(kind, [])) for kind in ("image", "3d", "rig", "sound")},
            "automatic": {**{kind: automatic(kind, cfg) for kind in ("image", "pixel", "3d", "rig")},
                          **{kind: automatic("sound", cfg, kind) for kind in asset_studio.AUDIO_KINDS}}}
