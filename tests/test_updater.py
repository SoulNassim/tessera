"""Update checks against GitHub releases."""

from __future__ import annotations

import pytest

from forge import updater


def test_versions_compare_numerically() -> None:
    assert updater.parse_version("v1.10.0") > updater.parse_version("1.9.3")
    assert updater.parse_version("1.2.0-dev") == (1, 2, 0)
    assert updater.parse_version("nonsense") == (0,)


async def test_check_reports_a_newer_release(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    release = {"version": "9.0.0", "tag": "v9.0.0", "name": "", "notes": "Shiny", "url": "https://example.test/r", "published": "",
               "assets": {"TesseraStudio-Setup-Windows.exe": "https://example.test/setup.exe",
                          "tessera_studio-9.0.0-py3-none-any.whl": "https://example.test/tessera_studio-9.0.0-py3-none-any.whl"}}

    async def fake_latest(force: bool = False) -> dict:
        return release

    monkeypatch.setattr(updater, "latest_release", fake_latest)
    monkeypatch.setattr(updater, "install_kind", lambda: "windows-app")
    info = await updater.check()
    assert info["available"] and info["latest"] == "9.0.0" and info["can_install"]

    monkeypatch.setattr(updater, "install_kind", lambda: "source")
    monkeypatch.chdir(tmp_path)  # not a git checkout
    info = await updater.check()
    assert info["available"] and not info["can_install"]
    assert info["command"] == "uv tool install --force --python 3.12 https://example.test/tessera_studio-9.0.0-py3-none-any.whl"

    monkeypatch.setattr(updater, "install_kind", lambda: "uv-tool")
    monkeypatch.setattr(updater.shutil, "which", lambda name: "/bin/uv")
    assert (await updater.check())["can_install"]
    del release["assets"]["tessera_studio-9.0.0-py3-none-any.whl"]
    assert not (await updater.check())["can_install"]
    monkeypatch.setattr(updater, "install_kind", lambda: "source")
    assert (await updater.check())["command"] == f"Download it from {updater.brand.SITE}"
    (tmp_path / ".git").mkdir()
    assert (await updater.check())["command"] == "git pull && uv sync"

    release["version"] = updater.__version__
    assert not (await updater.check())["available"]


async def test_a_broken_install_reports_why_instead_of_failing(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(force: bool = False) -> dict:
        raise FileNotFoundError("certifi/cacert.pem")

    monkeypatch.setattr(updater, "latest_release", broken)
    info = await updater.check(force=True)
    assert info["available"] is False and "certifi/cacert.pem" in info["error"]


def test_a_dev_checkout_is_not_an_app() -> None:
    assert updater.install_kind() == "source"


def test_update_file_uses_the_tessera_names_only():
    from forge.updater import release_asset

    both = {"assets": {"Glob-Setup-Windows.exe": "old", "TesseraStudio-Setup-Windows.exe": "new"}}
    assert release_asset(both, "windows-app") == "TesseraStudio-Setup-Windows.exe"
    assert release_asset({"assets": {"Glob-macOS.dmg": "x"}}, "mac-app") is None
    assert release_asset({"assets": {"Glob-Setup-Windows.exe": "x"}}, "windows-app") is None
    assert release_asset({"assets": {"TesseraStudio-macOS.dmg": "x"}}, "mac-app") == "TesseraStudio-macOS.dmg"
    assert release_asset({"assets": {}}, "windows-app") is None and release_asset(both, "source") is None


def test_uv_tool_install_picks_the_wheel():
    from forge.updater import release_asset

    release = {"assets": {"TesseraStudio-Setup-Windows.exe": "a", "forge_assets-1.0-py3-none-any.whl": "b",
                          "tessera_studio-0.2.0-py3-none-any.whl": "c"}}
    assert release_asset(release, "uv-tool") == "tessera_studio-0.2.0-py3-none-any.whl"
    assert release_asset({"assets": {"TesseraStudio-Setup-Windows.exe": "a"}}, "uv-tool") is None
