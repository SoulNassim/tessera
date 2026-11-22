"""The product's names live in forge/brand.py and forge/ui/brand.js; the two must never drift apart."""

import re
from pathlib import Path

from forge import brand

ROOT = Path(__file__).resolve().parents[1]


def test_brand_js_mirrors_brand_py():
    js = (ROOT / "forge" / "ui" / "brand.js").read_text(encoding="utf-8")
    found = dict(re.findall(r'(\w+): "([^"]*)"', js))
    assert found == brand.as_dict()


def test_page_titles_use_the_brand():
    for page in ("index.html", "loading.html"):
        html = (ROOT / "forge" / "ui" / page).read_text(encoding="utf-8")
        assert f"<title>{brand.NAME}</title>" in html
