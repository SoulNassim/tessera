"""Tess's art for the app and the landing page, cut out so she sits on the page itself (no box, no background).

    .venv/Scripts/python.exe tools/make_tess_art.py

Sources in brand/source/ (generated renders on pure black, and their background-removed cutouts):
    tess-<shot>-src.png   the render       tess-<shot>-cut.png   the same render with the background removed

A background remover keeps the character but drops what glows around her (the tile cube, the pixels, light
streaks). So the alpha used here is the larger of the cutout's alpha and a key on the render's brightness, and the
colour is un-premultiplied: laid over black it is exactly the render; over anything else the glow stays a glow.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageMath

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "source"
ART = SRC / "art"  # newer shots: <name>-src.jpg + <name>-mask.png, cut with BiRefNet
UI = ROOT / "forge" / "ui"
LANDING = ROOT / "docs" / "landing"

# Shots from brand/source/art/ and where they go. App moments and studio art go to forge/ui/art/ (Tess beside
# empty pages, errors and onboarding steps); a few also to the landing page.
APP_SHOTS = ["empty", "empty-b", "welcome", "welcome-b", "connect", "generating", "pick", "success", "error", "budget",
             "offline", "update", "idle", "pixel", "model", "rig", "motion", "sound", "drops", "settings", "step-1"]
CAST = ["drops", "step-1", "pixel", "connect", "pick", "success"]  # also onboarding / setup poses (app.js TESS_POSES)
LANDING_SHOTS = ["404"]
FACES = ["happy", "thinking", "surprised", "proud", "apologetic", "focused", "laughing", "sleepy"]


def cut(shot: str, glow: bool = True) -> Image.Image:
    """The render with a transparent background, glow kept (see the module docstring)."""
    src = Image.open(SRC / f"tess-{shot}-src.png").convert("RGB")
    alpha = Image.open(SRC / f"tess-{shot}-cut.png").convert("RGBA").getchannel("A")
    return keyed(src, alpha, glow)


def cut_art(name: str, glow: bool = True) -> Image.Image:
    """The same cut for the newer shots in brand/source/art/: <name>-src.jpg and <name>-mask.png (BiRefNet's alpha)."""
    src = Image.open(ART / f"{name}-src.jpg").convert("RGB")
    alpha = Image.open(ART / f"{name}-mask.png").convert("L")
    return keyed(src, alpha, glow)


def keyed(src: Image.Image, alpha: Image.Image, glow: bool) -> Image.Image:
    r, g, b = src.split()
    if glow:
        bright = ImageChops.lighter(r, ImageChops.lighter(g, b))
        # Dim haze around her is the generator's background, not glow: kept, it shows as a faint box over anything
        # lighter than black. Only real light (the cube, the pixels, the streaks) counts, with its own falloff.
        floor = 42
        key = bright.point(lambda v: 0 if v < floor else min(255, int(((v - floor) / (255 - floor)) ** 0.7 * 255)))
        alpha = ImageChops.lighter(alpha, key)
    channels = [
        ImageMath.lambda_eval(lambda e: e["convert"](e["min"](e["float"](e["c"]) * 255 / (e["float"](e["a"]) + 0.0001), 255), "L"), c=c, a=alpha)
        for c in (r, g, b)
    ]
    # Pixels the alpha barely covers carry amplified noise once un-premultiplied: drop them.
    return Image.merge("RGBA", (*channels, alpha.point(lambda v: 0 if v < 6 else v)))


def bbox(img: Image.Image) -> tuple[int, int, int, int]:
    return img.getchannel("A").point(lambda v: 255 if v > 12 else 0).getbbox() or (0, 0, img.width, img.height)


def trim(img: Image.Image, pad: int = 12) -> Image.Image:
    left, top, right, bottom = bbox(img)
    return img.crop((max(0, left - pad), max(0, top - pad), min(img.width, right + pad), min(img.height, bottom + pad)))


def save(img: Image.Image, path: Path, quality: int = 90) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".webp":
        img.save(path, "WEBP", quality=quality, alpha_quality=95, method=6)
    else:
        img.save(path, optimize=True)
    print(f"{path.relative_to(ROOT)}  {img.size}  {path.stat().st_size // 1024} KB")


def main() -> None:
    save(trim(cut("hero")), LANDING / "tess-hero.webp")
    save(trim(cut("work")), LANDING / "tess-work.webp")
    bust = trim(cut("bust"))
    save(bust, UI / "tess-bust.webp")
    save(bust, LANDING / "tess-bust.webp")
    # Avatar: a square around her face. No glow key: at 28 px a halo only blurs the silhouette.
    face = cut("face", glow=False)
    left, _, right, _ = bbox(face)
    side = face.height
    x = max(0, min(face.width - side, (left + right) // 2 - side // 2))
    avatar = face.crop((x, 0, x + side, side)).resize((160, 160), Image.LANCZOS)
    save(avatar, UI / "tess-avatar.png")
    save(avatar, LANDING / "tess-avatar.png")
    art()


def fit(img: Image.Image, height: int) -> Image.Image:
    return img if img.height <= height else img.resize((round(img.width * height / img.height), height), Image.LANCZOS)


def face_square(img: Image.Image, size: int = 160) -> Image.Image:
    """A square around her face: the top of the cut-out, centred on her head."""
    a = img.getchannel("A").point(lambda v: 255 if v > 40 else 0)
    left, top, right, _ = a.getbbox() or (0, 0, img.width, img.height)
    # The head is the opaque run on the row a little below the top of her hair.
    row = min(img.height - 1, top + (right - left) // 6)
    xs = [x for x in range(left, right) if a.getpixel((x, row))]
    cx = (xs[0] + xs[-1]) // 2 if xs else (left + right) // 2
    side = round((right - left) * 0.62)
    x = max(0, min(img.width - side, cx - side // 2))
    y = max(0, top - side // 14)
    return img.crop((x, y, x + side, y + side)).resize((size, size), Image.LANCZOS)


def art() -> None:
    """The newer shots: app moments, studio art, landing extras and the chat avatar's faces."""
    for name in APP_SHOTS:
        save(fit(trim(cut_art(name)), 1100), UI / "art" / f"tess-{name}.webp")  # full size: shown up to ~420 px tall, sharp on 2x screens
    for name in LANDING_SHOTS:
        save(fit(trim(cut_art(name)), 900), LANDING / f"tess-{name}.webp")
    for name in FACES:
        # Faces: no glow key, the halo only blurs a 28 px silhouette (same as the main avatar).
        save(face_square(cut_art(f"face-{name}", glow=False)), UI / "art" / f"face-{name}.png")


if __name__ == "__main__":
    main()
