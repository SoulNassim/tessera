"""Cut the six "Mochi as ..." pictures out of their black backgrounds for the landing page hero.

Sources: brand/source/cube/<name>.webp, renders on pure black with soft glows.
Output:  docs/landing/forms/<name>.webp, with alpha, so each one can float over the hero picture.

The alpha is a key on brightness (so a glow stays a glow over any colour), except that dark details enclosed by
the subject (pupils, a mouth, a road between buildings) are kept solid: they cannot be reached from the picture's
edge through dark pixels.

Run: .venv/Scripts/python.exe tools/make_form_art.py
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageMath

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "source" / "cube"
OUT = ROOT / "docs" / "landing" / "forms"
SIZE = 720
DARK = 84      # below this a pixel can be background
FULL = 150     # at this brightness a pixel is fully solid
FLOOR = 20     # at or below this, nothing


def cut(path: Path) -> Image.Image:
    img = Image.open(path).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    r, g, b = img.split()
    lum = ImageChops.lighter(ImageChops.lighter(r, g), b)

    # Background: dark pixels connected to the edge.
    padded = Image.new("L", (SIZE + 2, SIZE + 2), 0)
    padded.paste(lum.point(lambda v: 0 if v < DARK else 255), (1, 1))
    ImageDraw.floodfill(padded, (0, 0), 128)
    inside = padded.crop((1, 1, SIZE + 1, SIZE + 1)).point(lambda v: 0 if v == 128 else 255)
    soft = inside.filter(ImageFilter.GaussianBlur(1.2))

    # The renders are not on pure black (about 5 to 12 out of 255), so the key starts above that floor;
    # otherwise the whole square stays faintly visible.
    key = lum.point(lambda v: 0 if v <= FLOOR else round(min(1, (v - FLOOR) / (FULL - FLOOR)) ** 0.85 * 255))
    alpha = ImageChops.lighter(key, soft)
    # And the outermost pixels fade out, so no edge can show whatever the picture does there.
    edge = Image.new("L", (SIZE, SIZE), 0)
    edge.paste(255, (24, 24, SIZE - 24, SIZE - 24))
    alpha = ImageChops.multiply(alpha, edge.filter(ImageFilter.GaussianBlur(10)))
    # Un-premultiply where the key decided, so over black it is exactly the render.
    lift = [ImageMath.lambda_eval(lambda _: _["convert"](_["min"](_["c"] * 255 / _["max"](_["a"], 6), 255), "L"), c=c, a=key) for c in (r, g, b)]
    colour = Image.composite(img, Image.merge("RGB", lift), inside)
    colour.putalpha(alpha)
    return colour


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for path in sorted(SRC.glob("*.webp")):
        out = OUT / path.name
        cut(path).save(out, "WEBP", quality=80, method=6)
        print(f"{out.relative_to(ROOT)}  {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
