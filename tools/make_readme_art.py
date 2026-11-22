"""Banners for the README, built from the website's art in docs/landing/.

Writes docs/readme/*.webp. The display font is Bahnschrift (ships with Windows), the closest local match to
the website's Barlow Condensed.

Run: uv run python tools/make_readme_art.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
LANDING = ROOT / "docs" / "landing"
OUT = ROOT / "docs" / "readme"
FONT = "C:/Windows/Fonts/bahnschrift.ttf"

BG = (11, 9, 16)
VIOLET = (139, 92, 246)
PINK = (255, 92, 178)
WHITE = (250, 250, 252)
MUTED = (161, 161, 178)


def font(size: int, style: str = "Bold Condensed") -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_name(style)
    return f


def canvas(w: int, h: int) -> Image.Image:
    """Near-black with a soft violet floor glow, like the website."""
    im = Image.new("RGBA", (w, h), (*BG, 255))
    glow(im, (int(w * 0.7), int(h * 0.55)), int(w * 0.45), VIOLET, 70)
    return im


def glow(im: Image.Image, center: tuple[int, int], radius: int, color: tuple[int, int, int], strength: int) -> None:
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for r in range(radius, 0, -6):
        a = int(strength * (1 - r / radius) ** 2)
        d.ellipse([center[0] - r, center[1] - r * 0.6, center[0] + r, center[1] + r * 0.6], fill=(*color, a))
    im.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius // 6)))


def load(name: str, height: int) -> Image.Image:
    im = Image.open(LANDING / name).convert("RGBA")
    return im.resize((round(im.width * height / im.height), height), Image.LANCZOS)


def fade(im: Image.Image, left: int = 0, right: int = 0, top: int = 0, bottom: int = 0) -> Image.Image:
    """Fade an image's edges to transparent so it sinks into the background."""
    mask = Image.new("L", im.size, 255)
    px = mask.load()
    w, h = im.size
    for x in range(w):
        for y in range(h):
            k = 1.0
            if left and x < left:
                k *= x / left
            if right and x > w - right:
                k *= (w - x) / right
            if top and y < top:
                k *= y / top
            if bottom and y > h - bottom:
                k *= (h - y) / bottom
            px[x, y] = int(255 * k)
    out = im.copy()
    out.putalpha(Image.composite(im.getchannel("A"), Image.new("L", im.size, 0), mask))
    return out


def rounded(im: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.width - 1, im.height - 1], radius, fill=255)
    out = im.convert("RGBA")
    out.putalpha(Image.composite(out.getchannel("A"), mask, mask))
    return out


def chip(im: Image.Image, xy: tuple[int, int], text: str, color: tuple[int, int, int], size: int = 28) -> int:
    """A small translucent pill with a label; returns its width."""
    f = font(size, "SemiBold SemiCondensed")
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = int(d.textlength(text, font=f)) + size * 2
    h = int(size * 1.75)
    d.rounded_rectangle([xy[0], xy[1], xy[0] + w, xy[1] + h], h // 2, fill=(*color, 46), outline=(*color, 200), width=2)
    im.alpha_composite(layer)
    ImageDraw.Draw(im).text((xy[0] + w // 2, xy[1] + h // 2 + 1), text, font=f, fill=(*WHITE, 255), anchor="mm")
    return w


def save(im: Image.Image, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    im.convert("RGB").save(OUT / name, "WEBP", quality=90, method=6)
    print("wrote", OUT / name)


def hero() -> None:
    w, h = 2000, 760
    im = canvas(w, h)
    glow(im, (int(w * 0.74), int(h * 0.5)), 700, PINK, 45)
    tess = load("tess-reach.webp", h)
    im.alpha_composite(fade(tess, left=520, bottom=90), (w - tess.width + 120, 0))
    d = ImageDraw.Draw(im)
    icon = Image.open(ROOT / "forge" / "ui" / "tessera-icon.png").convert("RGBA").resize((96, 96), Image.LANCZOS)
    im.alpha_composite(icon, (110, 120))
    d.text((222, 168), "TESSERA STUDIO", font=font(46, "SemiBold Condensed"), fill=(*MUTED, 255), anchor="lm")
    d.text((104, 250), "YOUR GAME'S", font=font(150), fill=(*WHITE, 255))
    d.text((104, 395), "ART STUDIO.", font=font(150), fill=(*VIOLET, 255))
    d.text((110, 585), "The agentic workspace for AI game development.", font=font(42, "SemiBold SemiCondensed"), fill=(*WHITE, 230))
    x = 110
    for text, color in (("2D art", PINK), ("3D models", VIOLET), ("rigs + motion", PINK), ("sound", VIOLET), ("level kits", PINK)):
        x += chip(im, (x, 650), text, color) + 14
    save(im, "hero.webp")


def greybox() -> None:
    w, h = 2000, 760
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    d.text((w // 2, 70), "ONE SENTENCE IN.  THE WHOLE GAME OUT.", font=font(70), fill=(*WHITE, 255), anchor="mm")
    pw, ph = 900, 499
    grey = rounded(Image.open(LANDING / "game-grey.webp").convert("RGBA").resize((pw, ph), Image.LANCZOS), 26)
    art = rounded(Image.open(LANDING / "game-art.webp").convert("RGBA").resize((pw, ph), Image.LANCZOS), 26)
    top = 150
    im.alpha_composite(grey, (70, top))
    glow(im, (w - 70 - pw // 2, top + ph // 2), 620, PINK, 40)
    im.alpha_composite(art, (w - 70 - pw, top))
    # A "Tessera" pill with an arrow between the two pictures (not a round play button: it isn't a video).
    cx, cy = w // 2, top + ph // 2
    f = font(30, "Bold SemiCondensed")
    d.rounded_rectangle([cx - 95, cy - 34, cx + 95, cy + 34], 34, fill=(*VIOLET, 255), outline=(*WHITE, 255), width=3)
    d.text((cx - 14, cy + 1), "TESSERA", font=f, fill=(*WHITE, 255), anchor="mm")
    d.line([(cx + 44, cy), (cx + 72, cy)], fill=(*WHITE, 255), width=5)
    d.polygon([(cx + 66, cy - 11), (cx + 80, cy), (cx + 66, cy + 11)], fill=(*WHITE, 255))
    label = font(36, "SemiBold SemiCondensed")
    d.text((70 + pw // 2, top + ph + 48), "the greybox your agent built", font=label, fill=(*MUTED, 255), anchor="mm")
    d.text((w - 70 - pw // 2, top + ph + 48), "the art Tessera made for it", font=label, fill=(*WHITE, 255), anchor="mm")
    save(im, "greybox.webp")


def forms() -> None:
    w, h = 2000, 560
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    d.text((w // 2, 64), "ONE ASSET.  EVERY FORM YOUR GAME NEEDS.", font=font(64), fill=(*WHITE, 255), anchor="mm")
    items = [("art.webp", "Concept art"), ("pixel.webp", "Pixel sprite"), ("3d.webp", "3D model"),
             ("anim.webp", "Rig + motion"), ("level.webp", "Level kit"), ("sound.webp", "Sound")]
    size, gap = 300, 26
    x = (w - (size * 6 + gap * 5)) // 2
    for name, text in items:
        tile = Image.open(LANDING / "forms" / name).convert("RGBA").resize((size, size), Image.LANCZOS)
        im.alpha_composite(tile, (x, 120))
        d.text((x + size // 2, 120 + size + 44), text, font=font(36, "SemiBold SemiCondensed"), fill=(*WHITE, 240), anchor="mm")
        x += size + gap
    save(im, "forms.webp")


def agent() -> None:
    w, h = 2000, 640
    im = canvas(w, h)
    glow(im, (int(w * 0.28), int(h * 0.55)), 560, PINK, 50)
    tess = load("tess-work.webp", 600)
    im.alpha_composite(fade(tess, right=160, bottom=60), (40, h - 600))
    d = ImageDraw.Draw(im)
    x = 1120
    d.text((x, 120), "TESS MAKES IT.", font=font(104), fill=(*WHITE, 255))
    d.text((x, 235), "YOUR AGENT PUTS IT IN.", font=font(104), fill=(*VIOLET, 255))
    body = font(36, "SemiLight SemiCondensed")
    for i, line in enumerate(("Tessera keeps one list of every finished file.",
                              "Claude Code, Codex, Cursor or any agent that",
                              "reads files copies what it needs.")):
        d.text((x + 4, 395 + i * 48), line, font=body, fill=(*MUTED, 255))
    save(im, "agent.webp")


def start() -> None:
    w, h = 2000, 520
    im = canvas(w, h)
    glow(im, (int(w * 0.72), int(h * 0.5)), 520, PINK, 40)
    # tess-present has a wide black margin on its left: crop to Tess and her glowing hand.
    src = Image.open(LANDING / "tess-present.webp").convert("RGBA").crop((420, 0, 1376, 768))
    tess = src.resize((round(src.width * h / src.height), h), Image.LANCZOS)
    im.alpha_composite(fade(tess, left=120, right=30, top=50), (w - tess.width - 40, 0))
    d = ImageDraw.Draw(im)
    d.text((110, 140), "START WITH", font=font(130), fill=(*WHITE, 255))
    d.text((110, 270), "ONE SENTENCE.", font=font(130), fill=(*VIOLET, 255))
    d.text((114, 430), "Free to use. About a minute to install.", font=font(38, "SemiBold SemiCondensed"), fill=(*MUTED, 255))
    save(im, "start.webp")


if __name__ == "__main__":
    hero()
    greybox()
    forms()
    agent()
    start()
