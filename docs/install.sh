#!/bin/sh
# Install Tessera Studio on macOS or Linux:
#   curl -LsSf https://soulnassim.github.io/tessera/install.sh | sh
# Installs uv if needed, then Tessera Studio as a uv tool. Then run `tessera connect` in your game folder.
set -eu

API="https://api.github.com/repos/SoulNassim/tessera/releases/latest"
SITE="https://soulnassim.github.io/tessera/"

if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv (Python package manager from astral.sh)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  PATH="$HOME/.local/bin:$PATH"
fi

echo "Finding the latest Tessera Studio release..."
WHEEL="$(curl -fsSL -H 'User-Agent: tessera-installer' "$API" 2>/dev/null \
  | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*tessera_studio-[^"]*\.whl"' \
  | head -n 1 \
  | sed 's/.*:[[:space:]]*"\(.*\)"/\1/' || true)"
if [ -z "$WHEEL" ]; then
  echo "Could not find a Tessera Studio download in the latest release." >&2
  echo "Get the installer from $SITE and try again." >&2
  exit 1
fi

echo "Installing Tessera Studio..."
uv tool install --force --python 3.12 "$WHEEL"
uv tool update-shell >/dev/null 2>&1 || true
"$HOME/.local/bin/tessera" shortcut || true

echo
echo "Tessera Studio is installed. Open it any time with the Tessera shortcut (desktop on macOS, app menu on Linux) or: tessera open"
echo "To connect a game, run this in its folder:"
echo "  tessera connect     # connect your coding agents and open Tessera Studio in the browser"
echo "(New terminal needed for 'tessera' to be found; until then use ~/.local/bin/tessera)"
echo "Or just tell your agent: Set up Tessera for this game: read ${SITE}agent.md"
