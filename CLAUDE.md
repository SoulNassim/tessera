# CLAUDE.md — Instructions for Claude Code

Read `AGENTS.md` for the codebase map and conventions. It covers working on Tessera itself.

Tessera is your game's asset studio. Tessera makes the art; your coding agent copies it from `tessera/` using `tessera/ASSETS.md`. See the `README.md` and `.claude/skills/tessera-assets/SKILL.md`.

## Quick Commands
- **Run Tessera Studio**: `uv run forge` (UI and HTTP API at `http://127.0.0.1:8420`)
- **Run the MCP server (stdio)**: `uv run forge --mcp --project <name>`
- **Run tests**: `uv run --extra dev pytest -v`
