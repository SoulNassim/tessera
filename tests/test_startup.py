"""The server starts (its lifespan runs) and warms the overview of recent projects in the background."""

from __future__ import annotations

import asyncio


def test_server_starts_and_warms_recent_overviews():
    from fastapi.testclient import TestClient

    from forge.server import app as server

    with TestClient(server.app, base_url="http://127.0.0.1:8420") as client:  # `with` runs the lifespan
        project = client.post("/api/projects", json={"name": "warm", "unique": True}).json()["project"]
        server._view_cache.clear()
        asyncio.run(server._warm_views())
        assert (project, "overview") in server._view_cache
        assert client.get("/api/overview", params={"project": project}).status_code == 200
