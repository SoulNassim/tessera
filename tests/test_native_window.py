"""Tessera's native window: which window opens, how its process starts, and the fallback when it can't."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from forge import appwindow, native_window


def test_browser_setting_turns_the_native_window_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FORGE_WINDOW", "browser")
    assert native_window.available() is False


def test_open_window_prefers_the_native_window(monkeypatch: pytest.MonkeyPatch) -> None:
    started: list[list[str]] = []
    monkeypatch.setattr(native_window, "available", lambda: True)
    monkeypatch.setattr(appwindow, "spawn_detached", lambda command, **kw: started.append(command))
    monkeypatch.setattr(appwindow, "open_browser_window", lambda url: pytest.fail("the native window should open"))
    assert appwindow.open_window("http://127.0.0.1:9/?project=a") is True
    assert started == [native_window.command("http://127.0.0.1:9/?project=a")]
    assert started[0][-1] == "http://127.0.0.1:9/?project=a"


def test_open_window_falls_back_to_the_browser_window(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(native_window, "available", lambda: False)
    monkeypatch.setattr(appwindow, "open_browser_window", lambda url: opened.append(url) or True)
    assert appwindow.open_window("http://127.0.0.1:9/") is True
    assert opened == ["http://127.0.0.1:9/"]


def test_browser_window_gets_its_own_profile(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    started: list[list[str]] = []
    monkeypatch.setattr(appwindow, "find_browser", lambda: "edge.exe")
    monkeypatch.setattr(appwindow, "spawn_detached", lambda command, **kw: started.append(command))
    monkeypatch.setattr("forge.config.get_config_dir", lambda: tmp_path)
    assert appwindow.open_browser_window("http://127.0.0.1:9/") is True
    args = started[0]
    assert args[0] == "edge.exe" and "--app=http://127.0.0.1:9/" in args
    assert f"--user-data-dir={tmp_path / 'browser'}" in args and "--disable-extensions" in args


def test_installed_app_opens_a_window_with_its_own_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert native_window.command("http://x/") == [sys.executable, "--window", "http://x/"]


def test_source_install_runs_the_module(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    command = native_window.command("http://x/")
    assert command[1:] == ["-m", "forge.native_window", "http://x/"]


def test_window_that_cannot_open_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []

    def fail(url: str) -> None:
        raise native_window.NativeUnavailable("no WebView2")

    monkeypatch.setattr(native_window, "run", fail)
    monkeypatch.setattr(appwindow, "open_browser_window", lambda url: opened.append(url) or True)
    native_window.main(["http://127.0.0.1:9/"])
    assert opened == ["http://127.0.0.1:9/"]


class FakeWindow:
    def __init__(self, url: str) -> None:
        self.url, self.loaded, self.closed = url, [], False

    def get_current_url(self) -> str:
        return self.url

    def load_url(self, url: str) -> None:
        self.loaded.append(url)
        self.url = url

    def destroy(self) -> None:
        self.closed = True


class Stop(Exception):
    pass


def _ticks(n: int):
    calls = {"n": 0}

    def sleep(_: float) -> None:
        calls["n"] += 1
        if calls["n"] > n:
            raise Stop

    return sleep


def test_studio_base_reads_the_loading_page() -> None:
    assert native_window.studio_base("http://127.0.0.1:8420/?project=a") == "http://127.0.0.1:8420"
    assert native_window.studio_base("file:///x/loading.html#http%3A%2F%2F127.0.0.1%3A8421%2F") == "http://127.0.0.1:8421"
    assert native_window.studio_base("https://example.com/") is None


def test_a_dead_studio_is_started_again(monkeypatch: pytest.MonkeyPatch) -> None:
    from forge import launcher

    started: list[bool] = []
    monkeypatch.setattr(launcher, "_health", lambda base: None)
    monkeypatch.setattr(launcher, "quit_since", lambda moment: False)
    monkeypatch.setattr(launcher, "ensure_running", lambda *a, **k: started.append(True))
    window = FakeWindow("http://127.0.0.1:8420/?project=a")
    with pytest.raises(Stop):
        native_window.watch(window, window.url, sleep=_ticks(2))
    assert started == [True]
    assert window.loaded and window.loaded[0].startswith("file:") and window.loaded[0].endswith("project%3Da")
    assert not window.closed


def test_a_studio_quit_on_purpose_closes_the_window(monkeypatch: pytest.MonkeyPatch) -> None:
    from forge import launcher

    monkeypatch.setattr(launcher, "_health", lambda base: None)
    monkeypatch.setattr(launcher, "quit_since", lambda moment: True)
    monkeypatch.setattr(launcher, "ensure_running", lambda *a, **k: pytest.fail("quit on purpose: don't restart"))
    window = FakeWindow("http://127.0.0.1:8420/")
    native_window.watch(window, window.url, sleep=_ticks(5))
    assert window.closed


def test_a_live_studio_is_left_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    from forge import launcher

    monkeypatch.setattr(launcher, "_health", lambda base: {"ok": True})
    monkeypatch.setattr(launcher, "quit_since", lambda moment: False)
    monkeypatch.setattr(launcher, "ensure_running", lambda *a, **k: pytest.fail("it is up"))
    window = FakeWindow("http://127.0.0.1:8420/")
    with pytest.raises(Stop):
        native_window.watch(window, window.url, sleep=_ticks(5))
    assert window.loaded == []


def test_quit_marker_counts_only_after_the_window_opened(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import time

    from forge import launcher

    monkeypatch.setattr(launcher, "get_config_dir", lambda: tmp_path)
    opened = time.time()
    assert launcher.quit_since(opened) is False
    launcher.mark_quit()
    assert launcher.quit_since(opened) is True
    assert launcher.quit_since(time.time() + 60) is False
