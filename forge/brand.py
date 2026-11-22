"""The product's names in one place. forge/ui/brand.js mirrors these for the pages (a test keeps them equal).

The Python package stays `forge` (an internal name nobody types). Everything a person or another program sees
comes from here: the app's name, its chat persona, the command, the folder it keeps inside a game.
"""

from __future__ import annotations

NAME = "Tessera Studio"  # the product
SHORT = "Tessera"  # in sentences: "Tessera keeps…"
AGENT = "Tess"  # the chat persona: the studio's art director
CLI = "tessera"  # the command; `glob` and `forge` still work and say it was renamed
APP_CLI = "tessera-app"
MCP_NAME = "tessera"  # MCP serverInfo name and the prompt a coding agent loads
TAGLINE = "Your game's art department"

# Where people get Tessera: the source, the installers (GitHub releases), the update feed and the website (GitHub
# Pages) all live in this one public repo.
PUBLIC_REPO = "SoulNassim/tessera"
SITE = "https://soulnassim.github.io/tessera/"

# Older names that keep working, so nothing a user already set up breaks.
OLD_CLIS = ("glob", "forge")
OLD_MCP_PROMPTS = ("glob",)


def as_dict() -> dict[str, str]:
    return {"name": NAME, "short": SHORT, "agent": AGENT, "cli": CLI, "tagline": TAGLINE}
