"""Tessera Studio's mark: an isometric cube built from tiles, one tile lifting off the top.

Writes, into forge/ui/:
  tessera-mark.svg        the mark (header, favicon, onboarding)
  tessera-mark-live.svg   the same, with the loose tile floating (Tess is working)
  tessera-icon.png / tessera.ico   app icon for the desktop window, tray and installer
and the installer's wizard images into packaging/windows/.

Run: uv run python tools/make_brand_art.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "forge" / "ui"
WIN = ROOT / "packaging" / "windows"

# Cube in a 100x100 box: top vertex, right, bottom, left, centre.
TOP, RIGHT_UP, RIGHT_DN, BOTTOM, LEFT_DN, LEFT_UP, CENTRE = (50, 6), (88, 28), (88, 72), (50, 94), (12, 72), (12, 28), (50, 50)
GAP = 0.07  # gap between tiles, as a share of a face edge
LIFT = 13  # how far the loose tile floats above the top face

# Each face: origin and two edge vectors; tiles are its 2x2 cells. Colours per cell, light from the top left.
FACES = {
    "top": (LEFT_UP, (TOP[0] - LEFT_UP[0], TOP[1] - LEFT_UP[1]), (CENTRE[0] - LEFT_UP[0], CENTRE[1] - LEFT_UP[1]),
            [["#d9c7ff", "#c7abff"], ["#c7abff", "#b48dff"]]),
    "left": (LEFT_UP, (CENTRE[0] - LEFT_UP[0], CENTRE[1] - LEFT_UP[1]), (LEFT_DN[0] - LEFT_UP[0], LEFT_DN[1] - LEFT_UP[1]),
             [["#9d5cff", "#8a47f5"], ["#8a47f5", "#7633e0"]]),
    "right": (CENTRE, (RIGHT_UP[0] - CENTRE[0], RIGHT_UP[1] - CENTRE[1]), (BOTTOM[0] - CENTRE[0], BOTTOM[1] - CENTRE[1]),
              [["#5b2bb8", "#4a2399"], ["#4a2399", "#3a1c7a"]]),
}
LOOSE = ("top", 1, 0)  # the back tile, at the top corner, lifts off into free space


def tile(face: str, i: int, j: int, lift: float = 0.0) -> list[tuple[float, float]]:
    (ox, oy), (ux, uy), (vx, vy), _ = FACES[face]
    a0, a1 = i / 2 + GAP / 2, (i + 1) / 2 - GAP / 2
    b0, b1 = j / 2 + GAP / 2, (j + 1) / 2 - GAP / 2
    return [(ox + a * ux + b * vx, oy + a * uy + b * vy - lift) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))]


def tiles(lift: float = LIFT):
    """Every tile, the loose one last so it is drawn over the rest."""
    loose_one = None
    for face, (_, _, _, colours) in FACES.items():
        for i in range(2):
            for j in range(2):
                if (face, i, j) == LOOSE:
                    loose_one = (tile(face, i, j, lift), colours[i][j], True)
                else:
                    yield tile(face, i, j), colours[i][j], False
    yield loose_one


def _pts(poly) -> str:
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in poly)


def svg(live: bool) -> str:
    parts = []
    for poly, colour, loose in tiles():
        if loose:
            # The loose tile's empty slot shows as a dark socket under it.
            parts.append(f'<polygon points="{_pts(tile(*LOOSE))}" fill="#160b2e"/>')
            anim = ('<animateTransform attributeName="transform" type="translate" values="0 0;0 -4;0 0" dur="1.6s" '
                    'repeatCount="indefinite" calcMode="spline" keySplines=".4 0 .6 1;.4 0 .6 1"/>') if live else ""
            parts.append(f'<g><polygon points="{_pts(poly)}" fill="{colour}" stroke="#f1e9ff" stroke-width=".8"/>{anim}</g>')
        else:
            parts.append(f'<polygon points="{_pts(poly)}" fill="{colour}"/>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -10 100 110" role="img" aria-label="Tessera Studio">'
            + "".join(parts) + "</svg>\n")


def raster(size: int, background: str | None = None) -> Image.Image:
    """The mark drawn with Pillow at 4x, then scaled down for clean edges."""
    big = size * 4
    img = Image.new("RGBA", (big, big), background or (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = 0.08 if background else 0.0
    scale = big * (1 - 2 * pad) / 110

    def place(poly):
        return [(big * pad + x * scale, big * pad + (y + 10) * scale) for x, y in poly]

    for poly, colour, loose in tiles():
        if loose:
            draw.polygon(place(tile(*LOOSE)), fill="#160b2e")
        draw.polygon(place(poly), fill=colour)
    return img.resize((size, size), Image.LANCZOS)


def wizard(width: int, height: int, mark: int) -> Image.Image:
    """Installer art: charcoal with a faint tile grid, a violet glow and the mark."""
    img = Image.new("RGB", (width, height), "#08080b")
    draw = ImageDraw.Draw(img)
    step = max(8, width // 10)
    for x in range(0, width, step):
        draw.line([(x, 0), (x, height)], fill="#13131a")
    for y in range(0, height, step):
        draw.line([(0, y), (width, y)], fill="#13131a")
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([width * 0.1, height * 0.35 - width * 0.4, width * 0.9, height * 0.35 + width * 0.4], fill=(157, 92, 255, 70))
    img.paste(glow.filter(ImageFilter.GaussianBlur(width // 5)), (0, 0), glow.filter(ImageFilter.GaussianBlur(width // 5)))
    m = raster(mark)
    img.paste(m, ((width - mark) // 2, int(height * 0.35 - mark / 2)), m)
    return img


def main() -> None:
    (UI / "tessera-mark.svg").write_text(svg(live=False), encoding="utf-8")
    (UI / "tessera-mark-live.svg").write_text(svg(live=True), encoding="utf-8")
    icon = raster(512, background="#0e0e12")
    # Rounded square app icon.
    mask = Image.new("L", icon.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *icon.size], radius=112, fill=255)
    icon.putalpha(mask)
    icon.save(UI / "tessera-icon.png")
    icon.save(UI / "tessera.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    # Inno Setup 6.6 picks the size that fits the DPI: 100%, 125%, 150%.
    for n, (w, h) in enumerate([(164, 314), (205, 393), (246, 471)]):
        wizard(w, h, int(w * 0.6)).save(WIN / f"wizard-{n}.png")
    for n, s in enumerate([55, 69, 83]):
        raster(s, background="#08080b").convert("RGB").save(WIN / f"wizard-small-{n}.png")
    print("wrote", UI / "tessera-mark.svg", UI / "tessera-icon.png", "and the installer art")


if __name__ == "__main__":
    main()
