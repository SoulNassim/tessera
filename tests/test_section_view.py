from pathlib import Path

import pytest

from forge import section_view


def _asset(path: Path, kind: str = "prop", extra: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nkind: {kind}\nprompt: thing\n{extra}---\n# {path.stem}\n", encoding="utf-8")


def _folder(path: Path, title: str, line: str = "") -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "README.md").write_text(f"# {title}\n\n{line}\n", encoding="utf-8")


def test_a_section_lists_its_subfolders_as_subsections(tmp_path: Path) -> None:
    _folder(tmp_path / "props", "Props")
    _asset(tmp_path / "props" / "crate.md")
    _folder(tmp_path / "props" / "landmarks", "Landmarks", "Make these first.")
    _asset(tmp_path / "props" / "landmarks" / "altar.md")
    _folder(tmp_path / "props" / "landmarks" / "big", "Big ones")
    _asset(tmp_path / "props" / "landmarks" / "big" / "statue.md")
    _folder(tmp_path / "props" / "landmarks" / "big" / "huge", "Huge")
    _asset(tmp_path / "props" / "landmarks" / "big" / "huge" / "colossus.md")

    sec = section_view.describe_section(tmp_path, "props")

    assert [f["name"] for f in sec["files"] if f["kind"] == "asset"] == ["crate.md"]
    landmarks = sec["subsections"][0]
    assert (landmarks["title"], landmarks["excerpt"], landmarks["depth"]) == ("Landmarks", "Make these first.", 1)
    big = landmarks["subsections"][0]
    assert big["depth"] == 2
    # The third level is the last one shown: anything deeper is listed with it, so nothing goes missing.
    assert big["subsections"] == []
    assert {f["name"] for f in big["files"] if f["kind"] == "asset"} == {"statue.md", "colossus.md"}


def test_each_asset_says_what_made_it_and_the_cost(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _folder(tmp_path / "props", "Props")
    _asset(tmp_path / "props" / "crate.md", extra="winner: props/crate/candidates/a.png\n")
    records = {
        "props/crate/candidates/a.png": {"model": "svc:elevenlabs/gemini-nano-banana-2.1", "cost_usd": 0.04},
    }
    monkeypatch.setattr("forge.asset_studio.output_history", lambda ws, rel: records)
    monkeypatch.setattr(section_view, "_catalog_labels", lambda: {})

    crate = section_view.describe_section(tmp_path, "props")["files"][0]

    assert crate["made_with"] == "Nano Banana 2.1"
    assert crate["cost_usd"] == 0.04


def test_model_labels_read_like_names() -> None:
    section_view._labels, section_view._labels_at = {"x": "y"}, 10**12  # no catalog lookups in a test
    assert section_view.model_label("svc:higgsfield/gpt-image-2") == "GPT Image 2"
    assert section_view.model_label("tripo:v3.0") == "Tripo v3.0"
    assert section_view.model_label("") == ""


def test_promoting_a_subfolder_makes_it_a_section_and_fixes_its_paths(tmp_path: Path) -> None:
    _folder(tmp_path / "props", "Props")
    _folder(tmp_path / "props" / "vehicles", "Vehicles")
    _asset(tmp_path / "props" / "vehicles" / "cart.md", extra="winner: props/vehicles/cart/candidates/a.png\n")

    new = section_view.promote_folder(tmp_path, "props/vehicles")

    assert new == "vehicles"
    assert not (tmp_path / "props" / "vehicles").exists()
    text = (tmp_path / "vehicles" / "cart.md").read_text(encoding="utf-8")
    assert "winner: vehicles/cart/candidates/a.png" in text


def test_promoting_refuses_to_overwrite(tmp_path: Path) -> None:
    _folder(tmp_path / "props" / "vehicles", "Vehicles")
    _folder(tmp_path / "vehicles", "Vehicles")
    with pytest.raises(ValueError):
        section_view.promote_folder(tmp_path, "props/vehicles")
