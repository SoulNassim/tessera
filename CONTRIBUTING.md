# Contributing to Tessera

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs and ideas:** open an issue first. Say what you did, what you expected and what happened, and add a screenshot if it's visual.
- **Bigger changes:** open an issue before you write a lot of code, so we can agree on the shape first.
- **Codebase map:** [`AGENTS.md`](AGENTS.md) explains how the code is organized and what the conventions are. It's written for AI coding agents, and it works for people too.

## Run it

```sh
uv run forge                    # the studio at http://127.0.0.1:8420
uv run --extra dev pytest -v    # the tests
```

Keep each pull request to one change, and make sure the tests pass.

## Licensing of contributions

Tessera is released under the [PolyForm Shield License 1.0.0](LICENSE). When you open a pull request, you agree that:

1. the contribution is your own work, or you have the right to submit it, and
2. you license it to the maintainer (SoulNassim) under the same terms, and you also let the maintainer release it under other licenses, commercial ones included, as part of Tessera.

This keeps the project in one hand, so it can stay free to use now and still get a commercial edition later.
