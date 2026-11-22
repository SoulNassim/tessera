"""Background removal for local images, with Pillow only.

Local models are asked for the subject on a plain light background; this clears the background connected to the
image's edges when it really is plain, and leaves the image alone when it isn't (a busy background stays opaque
rather than getting chewed up).
"""

from __future__ import annotations

from PIL import Image, ImageChops, ImageDraw, ImageFilter

TOLERANCE = 34  # how far (0-255, summed light) a pixel may be from the background colour and still count as it
UNIFORM_SHARE = 0.7  # this share of the border must be the background colour, or nothing is removed


def _border(img: Image.Image) -> list[tuple[int, int]]:
    w, h = img.size
    step = max(1, min(w, h) // 128)
    points = [(x, 0) for x in range(0, w, step)] + [(x, h - 1) for x in range(0, w, step)]
    points += [(0, y) for y in range(0, h, step)] + [(w - 1, y) for y in range(0, h, step)]
    return points


def remove_plain_background(img: Image.Image) -> tuple[Image.Image, bool]:
    """(RGBA image, whether a background was removed)."""
    rgb = img.convert("RGB")
    border = _border(rgb)
    colours = [rgb.getpixel(p) for p in border]
    # The background colour: the median of each channel along the border.
    bg = tuple(sorted(c[i] for c in colours)[len(colours) // 2] for i in range(3))
    near = sum(1 for c in colours if sum(abs(c[i] - bg[i]) for i in range(3)) <= TOLERANCE)
    if near < UNIFORM_SHARE * len(colours):
        return img.convert("RGBA"), False
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    # 255 where a pixel looks like background, 0 elsewhere; then mark (128) the background reachable from the edges.
    mask = diff.point(lambda v: 255 if v * 3 <= TOLERANCE * 2 else 0)
    for point in border:
        if mask.getpixel(point) == 255:
            ImageDraw.floodfill(mask, point, 128, thresh=0)
    alpha = mask.point(lambda v: 0 if v == 128 else 255)
    # A soft edge instead of a jagged one; shrink by a pixel first so no light fringe is left.
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out, True


# ---------- who cuts out: the maker's own remover, BiRefNet on this PC, or the plain-background cut above ----------

def has_own_cutout(model_id: str) -> bool:
    """Image makers that return a transparent picture themselves (Meshy's remover, GPT Image, a signed-in service)."""
    model = str(model_id or "")
    return model.startswith(("meshy:", "svc:", "elevenlabs:gpt-image"))


def cutter_name(cfg=None) -> str:  # noqa: ANN001
    """"birefnet" or "simple": what cuts out an image whose maker can't, as chosen in New art."""
    from forge.config import load_config
    from forge.local_ai import runtime

    choice = str(getattr(cfg or load_config(), "cutout_with", "auto") or "auto")
    ready = "birefnet" in runtime.installed_ids() and not runtime.missing_deps(runtime.catalog.BY_ID["birefnet"])
    if choice == "simple" or not ready:
        return "simple"
    return "birefnet"


async def cut_out(path, cfg=None) -> tuple[bool, str]:  # noqa: ANN001
    """Cut the background out of an image file in place. (removed, label of what did it)."""
    from pathlib import Path

    path = Path(path)
    if cutter_name(cfg) == "birefnet":
        from forge.local_ai import catalog, runtime
        from forge.local_ai.engine import ENGINE

        tmp = path.with_name(f"{path.stem}.cut.png")
        try:
            await ENGINE.cutout(str(path), str(tmp), str(runtime.repo_dir(next(iter(catalog.BY_ID["birefnet"].files)))))
            tmp.replace(path)
            return True, "BiRefNet on this PC"
        except Exception:  # noqa: BLE001
            tmp.unlink(missing_ok=True)  # fall back to the plain cut rather than failing the whole image
    img = Image.open(path)
    img.load()
    cut, removed = remove_plain_background(img)
    if removed:
        cut.save(path, format="PNG")
    return removed, "plain-background cut"
