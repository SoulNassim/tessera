"""The server's per-project listing cache: a write forgets only its own project's listings."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FORGE_PROJECTS_DIR", str(tmp_path))
    from forge.server import app as server_app

    monkeypatch.setattr(server_app, "_view_cache", {})
    monkeypatch.setattr(server_app, "_project_gen", {})
    monkeypatch.setattr(server_app.workspace_watcher, "signatures", {"a": (0, 0), "b": (0, 0)})
    return server_app


def _counting(server, project: str, calls: list[str]):
    return server._cached_view(project, "listing", lambda: calls.append(project) or project)


def test_a_write_in_one_project_keeps_the_others(server) -> None:
    calls: list[str] = []
    _counting(server, "a", calls), _counting(server, "b", calls)
    server._views_changed("a")
    _counting(server, "a", calls), _counting(server, "b", calls)
    assert calls == ["a", "b", "a"]


def test_a_write_without_a_project_forgets_every_project(server) -> None:
    calls: list[str] = []
    _counting(server, "a", calls), _counting(server, "b", calls)
    server._views_changed()
    _counting(server, "a", calls), _counting(server, "b", calls)
    assert calls == ["a", "b", "a", "b"]


def test_an_unwatched_project_is_never_answered_from_memory(server) -> None:
    calls: list[str] = []
    _counting(server, "c", calls), _counting(server, "c", calls)
    assert calls == ["c", "c"]
