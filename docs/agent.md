# Set up Tessera Studio (instructions for coding agents)

You are a coding agent (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Copilot…). The user wants **Tessera Studio**, a free asset studio that runs on their own computer as an app. Tessera makes the game's art, 3D models, animations and sounds. You copy the finished files into the game.

Follow these steps exactly. Run the commands from the user's **game folder** (the project you are working in). Don't ask for API keys, and don't let the user paste keys into this chat: they enter keys in Tessera's own window.

## 1. Already connected?

If `tessera/ASSETS.md` exists in the game folder, Tessera is set up. Skip to step 4. (A game connected back when Tessera was called Glob has `glob/ASSETS.md` instead; it still works, and `tessera migrate` upgrades it to the new folder layout. Run `tessera migrate --dry-run` first to see what would move.)

## 2. Install Tessera Studio

Tessera installs as a [uv](https://docs.astral.sh/uv/) tool and takes about a minute. The installer adds uv first when it is missing. Before you run anything, tell the user in one sentence what you are about to install (Tessera Studio, the free asset studio, from its release page on GitHub) and that they may be asked to approve it.

- Windows (PowerShell, cmd or Git Bash): `powershell -ExecutionPolicy ByPass -NoProfile -c "irm https://soulnassim.github.io/tessera/install.ps1 | iex"`
- macOS / Linux: `curl -LsSf https://soulnassim.github.io/tessera/install.sh | sh`

The user can also download the Windows installer or the macOS app from <https://soulnassim.github.io/tessera/>.

**If your permission system blocks or denies the install, that is expected:** installing software is the user's call. Don't look for another way to run it. Stop, show the user the exact command, and ask them to approve it or run it themselves in a terminal in the game folder. Continue with step 3 once they say it's done.

## 3. Connect this game and open Tessera

Run this in the game folder. Your shell may not see the new `tessera` command yet, so use its full path (`uv tool dir --bin` prints the folder it is in):

- Windows: `"%USERPROFILE%\.local\bin\tessera.exe" connect` (PowerShell: `& "$env:USERPROFILE\.local\bin\tessera.exe" connect`, Git Bash: `"$USERPROFILE/.local/bin/tessera.exe" connect`)
- macOS / Linux: `~/.local/bin/tessera connect`

`tessera connect`:

1. makes the game's Tessera project (its files go in `tessera/` inside the game folder), or finds the one made before;
2. writes `tessera/ASSETS.md` and a short note into `AGENTS.md` and `CLAUDE.md` (and `GEMINI.md` when the game has one) telling coding agents where the finished art is;
3. creates the **Tessera Studio** shortcut on the desktop and in the Start menu;
4. opens Tessera's window on this game.

No restart is needed, and no MCP server needs approving.

## 4. Hand over to the user

Tell the user, in about these words:

> Tessera Studio is open (any time later: the Tessera Studio shortcut on your desktop). Make your art there. When you want it in the game, tell me — I'll copy it from tessera/.

Setup is finished. Don't write into `tessera/` by hand.

## 5. Using the art later

When the user asks for art in the game, or for placeholders to be swapped:

1. Read `tessera/ASSETS.md`. It lists each asset with its name, kind, page, the picked image or sound (`winner:`), and any 3D model, rig and animation files. `tessera/ASSETS.json` holds the same data for scripts.
2. For each asset you need, copy the picked files into the game's own folders and point your code at the copies. `tessera/export/` holds engine-ready copies (game-size images, icons).
3. Keep the placeholder for anything with no `winner:` yet, and tell the user what's missing so they can make it in Tessera. You may list art you still need in `tessera/REQUESTS.md`, the one file in `tessera/` you may write.

Never edit, move or delete anything else inside `tessera/`. Making and picking art happens in Tessera, not here.

To open Tessera again, run `tessera open` in the game folder, or use the **Tessera Studio** shortcut.
