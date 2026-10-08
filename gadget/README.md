# gadget: command sources

Python package `displayxr_gadget`. Every source turns some input into bridge commands
(see [`../docs/protocol.md`](../docs/protocol.md)).

| Source | Run | Status |
|---|---|---|
| `mock` | `dxr-gadget mock` (prompt) or `dxr-gadget mock show_model car` | works anywhere; no Muse needed |
| `muse` | `dxr-gadget muse run` (systemd runs this on the Pi) | needs the Muse Linux SDK, a token, pairing |
| `mcp` | `dxr-gadget mcp` | stub ([design notes](displayxr_gadget/adapters/mcp_stub.py)) |
| `local-model` | `dxr-gadget local-model` | stub ([design notes](displayxr_gadget/adapters/local_model_stub.py)) |

Settings come from the environment or a `.env` file: `BRIDGE_URL`, `BRIDGE_SECRET`, and
optionally `DXR_CATALOG` (path to `assets/catalog.json`, so Muse is told the asset names) and
`DXR_ENV_FILE` (which `.env` to read).

## How the Muse adapter works

The Muse Linux SDK has no plugin API; its documented way to add a command is to extend
`COMMAND_SPECS` and `Executor.run` in `musegadget/executor.py`. The adapter does exactly that
at startup, then runs the SDK's own CLI, so Meta's code is not forked or edited:

- `COMMAND_SPECS.update(...)` adds `displayxr.show_model`, `displayxr.show_splat`,
  `displayxr.set_mode`, `displayxr.set_depth`, `displayxr.start_call` and `displayxr.clear`.
  The SDK sends that dict to Muse in `link.register`.
- `Executor.run` is wrapped: those names go to the bridge; `system.run`, `file.*` and
  `device.health` go to the SDK's original method.
- `setup-pi.sh` installs this package into the SDK's venv and adds a systemd drop-in so the
  `musegadget` service runs `dxr-gadget muse run` instead of `musegadget run`.

The command names use the SDK's dotted style (`system.run`). Parameter types are limited to the
ones the SDK's own specs use (`string`, `integer`), so depth is an integer percent for Muse.

[`skill/SKILL.md`](skill/SKILL.md) is a fallback in the format of the SDK's community skills: it
tells Muse to run `dxr-gadget mock …` through the built-in `system.run`, for when the native
commands are not registered.

## Develop

```sh
python -m venv .venv && .venv/bin/pip install -e ".[test]"     # Windows: .venv\Scripts\pip
.venv/bin/pytest
```

`tests/test_end_to_end.py` starts the real Node bridge (needs `node` and `npm install` in
`../bridge`). `test_against_the_real_sdk` runs only where `musegadget` imports (Linux); CI
installs the SDK at the pinned commit for it.
