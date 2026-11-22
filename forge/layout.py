"""Where everything in a project lives. One object owns every path, so the layout is decided in one place.

A project folder (inside a game it is `<game>/tessera/`):

    ASSETS.md  ASSETS.json  REQUESTS.md  README.md   what the game's coding agent reads
    art/        the asset pages and everything made for them (the only folder you browse)
    export/     engine-ready copies (game-size images, icons, vault exports)
    .studio/    the studio's own files: project.json, studio.db, jobs, logs, history, cache, thumbnails

Projects made before Tessera Studio 4 use the old layout (`workspace/`, `vault/`, `assets/`, `exports/`,
`manifest.db`, ... side by side, inside `<game>/glob/`). They keep working unchanged: `Layout.of(root)` sees which
layout a folder has. `forge.migrate` moves an old project to the new layout, with a dry run and an undo.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

GAME_FOLDER = "tessera"  # a project inside a game folder lives in <game>/tessera/
LEGACY_GAME_FOLDER = "glob"  # ... and before Tessera Studio 4 in <game>/glob/
GAME_FOLDERS = (GAME_FOLDER, LEGACY_GAME_FOLDER)

STUDIO = ".studio"

# Every place that moved, old name -> new name, relative to the project folder. The migration follows this list,
# and file requests for an old path (stored in a database row, an old link) are answered from the new place.
MOVES: tuple[tuple[str, str], ...] = (
    ("workspace", "art"),
    ("exports", "export"),
    ("vault", f"{STUDIO}/history"),
    ("assets", f"{STUDIO}/cache"),
    (".thumbs", f"{STUDIO}/thumbs"),
    ("inbox_watch", f"{STUDIO}/watch"),
    ("logs", f"{STUDIO}/logs"),
    ("project.json", f"{STUDIO}/project.json"),
    ("manifest.json", f"{STUDIO}/manifest.json"),
    ("manifest.db", f"{STUDIO}/studio.db"),
    ("manifest.db-wal", f"{STUDIO}/studio.db-wal"),
    ("manifest.db-shm", f"{STUDIO}/studio.db-shm"),
    ("studio_jobs.json", f"{STUDIO}/jobs.json"),
    ("game_profile.json", f"{STUDIO}/game_profile.json"),
)

# The game's git keeps the art and the studio's records (project.json, history); not its caches and database.
GAME_IGNORE = (
    "# Tessera Studio's own files. art/, export/, ASSETS.md and .studio's project.json and history/ are your project.\n"
    f"{STUDIO}/*\n!{STUDIO}/project.json\n!{STUDIO}/history/\n"
)
LEGACY_GAME_IGNORE = (
    "# Tessera's own records; workspace/, vault/ and ASSETS.md are your project.\n"
    "manifest.db*\nstudio_jobs.json\nlogs/\ninbox_watch/\nassets/\n.thumbs/\n"
)


@dataclass(frozen=True)
class Layout:
    root: Path
    legacy: bool

    @classmethod
    def of(cls, root: Path) -> "Layout":
        """The layout a project folder has: the new one, unless the folder was made by an older version."""
        root = Path(root)
        legacy = not (root / STUDIO).is_dir() and any(
            (root / old).exists() for old in ("workspace", "manifest.db", "project.json")
        )
        return cls(root, legacy)

    @classmethod
    def of_art(cls, art_dir: Path) -> "Layout":
        """The layout around an art (workspace) folder: most functions are handed that folder."""
        return cls.of(Path(art_dir).parent)

    def _at(self, old: str) -> Path:
        if self.legacy:
            return self.root / old
        return self.root / dict(MOVES)[old]

    # The project folder's parts.
    @property
    def art(self) -> Path:
        return self._at("workspace")

    @property
    def export(self) -> Path:
        return self._at("exports")

    @property
    def studio(self) -> Path:
        return self.root if self.legacy else self.root / STUDIO

    @property
    def history(self) -> Path:
        return self._at("vault")

    @property
    def cache(self) -> Path:
        return self._at("assets")

    @property
    def thumbs(self) -> Path:
        return self._at(".thumbs")

    @property
    def watch(self) -> Path:
        return self._at("inbox_watch")

    @property
    def logs(self) -> Path:
        return self._at("logs")

    @property
    def project_json(self) -> Path:
        return self._at("project.json")

    @property
    def manifest_json(self) -> Path:
        return self._at("manifest.json")

    @property
    def db(self) -> Path:
        return self._at("manifest.db")

    @property
    def jobs(self) -> Path:
        return self._at("studio_jobs.json")

    @property
    def game_profile(self) -> Path:
        return self._at("game_profile.json")

    @property
    def readme(self) -> Path:
        return self.root / "README.md"

    def resolve(self, rel: str) -> Path:
        """A path relative to the project folder, where an old-layout path (`workspace/…`, `assets/…`) now is."""
        clean = str(rel).replace("\\", "/").lstrip("/")
        if not self.legacy:
            for old, new in MOVES:
                if clean == old or clean.startswith(old + "/"):
                    return self.root / new / clean[len(old):].lstrip("/")
        else:
            for old, new in MOVES:
                if clean == new or clean.startswith(new + "/"):
                    return self.root / old / clean[len(new):].lstrip("/")
        return self.root / clean

    def ignore_text(self) -> str:
        return LEGACY_GAME_IGNORE if self.legacy else GAME_IGNORE


def readme_text(name: str) -> str:
    """The one-screen map written into a new project folder."""
    return f"""# {name}: Tessera Studio project

Tessera Studio keeps this game's art here.

| Where | What |
|---|---|
| `ASSETS.md`, `ASSETS.json` | Every finished asset and its files: what a coding agent reads to put art into the game. |
| `REQUESTS.md` | Art the game still needs, written by the coding agent; Tessera Studio shows it as a to-do list. |
| `art/` | The asset pages (one `.md` per asset) and everything made for them: images, sprites, 3D, rigs, sounds. |
| `export/` | Engine-ready copies: images at game size, icons. |
| `.studio/` | The studio's own files (settings, history, caches). Leave it alone. |

Open the project with the Tessera Studio shortcut, or `tessera open` in the game folder.
Copy files from here into the game; don't edit or move them in place.
"""
