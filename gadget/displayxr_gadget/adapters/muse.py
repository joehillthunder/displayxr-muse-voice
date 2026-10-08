"""Muse source: Meta's Muse calls these commands on a Muse Linux gadget (a Raspberry Pi).

The Muse Linux Device SDK has no plugin API. Its documented way to add a command
(linux/AGENTS.md, "Adding a command") is: add a spec to ``COMMAND_SPECS`` in
``musegadget/executor.py`` and a branch in ``Executor.run``. Rather than fork that file, this
adapter does the same two things at startup, then hands over to the SDK's own CLI:

* ``COMMAND_SPECS.update(...)`` mutates the dict in place. ``service.py`` imported that same
  object (``from musegadget.executor import COMMAND_SPECS``) and sends it as ``commands_v2`` in
  ``link.register`` when each session starts, so Muse sees the new commands.
* ``Executor.run`` is wrapped: our command names go to the bridge, everything else
  (``system.run``, ``file.*``, ``device.health``) goes to the original method untouched.

The SDK runs each invoke on a worker thread (``run_in_executor``), so the blocking bridge call
is fine there. Our commands touch no files and run no processes; they only talk to the bridge.

    dxr-gadget muse run        what the systemd unit runs (via the drop-in setup-pi.sh writes)
    dxr-gadget muse pair|info  passed through to the SDK's CLI unchanged
"""

from __future__ import annotations

import logging
import sys
from typing import Callable

from displayxr_gadget.adapters.base import CommandSink, CommandSource
from displayxr_gadget.config import catalog_names, settings

log = logging.getLogger(__name__)

PREFIX = "displayxr."
LONG_TIMEOUT_MS = 60_000  # loading the engine + a multi-MB asset; the SDK default is 30 s


def command_specs(names: dict[str, list[str]]) -> dict:
    """Specs in the SDK's COMMAND_SPECS format. Muse reads the descriptions to pick a command."""
    models = ", ".join(names.get("models") or []) or "see the display's catalog"
    splats = ", ".join(names.get("splats") or []) or "see the display's catalog"
    source_params = lambda what: {  # noqa: E731
        "name": {"type": "string", "description": f"A {what} from the catalog. Give name or url, not both."},
        "url": {"type": "string", "description": f"An http(s) URL of a {what} file. Give name or url, not both."},
    }
    return {
        PREFIX + "show_model": {
            "description": (
                "Show a 3D model (glTF/GLB) on the glasses-free 3D display. "
                f"Catalog models: {models}. Replaces whatever is showing."
            ),
            "required": {},
            "optional": source_params("model"),
            "timeout_ms": LONG_TIMEOUT_MS,
        },
        PREFIX + "show_splat": {
            "description": (
                "Show a 3D Gaussian splat (.sog or .ply) on the glasses-free 3D display. "
                f"Catalog splats: {splats}. Replaces whatever is showing."
            ),
            "required": {},
            "optional": source_params("splat"),
            "timeout_ms": LONG_TIMEOUT_MS,
        },
        PREFIX + "set_mode": {
            "description": "Switch the 3D display between flat 2D and glasses-free 3D.",
            "required": {"mode": {"type": "string", "description": 'Either "2d" or "3d".'}},
            "optional": {},
        },
        PREFIX + "set_depth": {
            "description": (
                "Move the shown object toward the viewer (positive) or behind the screen "
                "(negative). 0 puts it on the screen plane."
            ),
            "required": {"percent": {"type": "integer", "description": "From -100 to 100."}},
            "optional": {},
        },
        PREFIX + "start_call": {
            "description": "Start a 3D video call on the display and return the invite link to share.",
            "required": {},
            "optional": {},
            "timeout_ms": LONG_TIMEOUT_MS,
        },
        PREFIX + "clear": {
            "description": "Clear the 3D display (removes the model, splat or call).",
            "required": {},
            "optional": {},
        },
    }


def to_bridge(command: str, params: dict) -> tuple[str, dict]:
    """Muse command + params -> bridge command + args."""
    cmd = command[len(PREFIX):]
    params = params if isinstance(params, dict) else {}
    if cmd in ("show_model", "show_splat"):
        return cmd, {k: params[k] for k in ("name", "url") if params.get(k) not in (None, "")}
    if cmd == "set_mode":
        mode = params.get("mode")
        return cmd, {"mode": mode.strip().lower() if isinstance(mode, str) else mode}
    if cmd == "set_depth":
        pct = params.get("percent")
        if isinstance(pct, (int, float)) and not isinstance(pct, bool):
            return cmd, {"value": max(-100, min(100, pct)) / 100}
        return cmd, {"value": pct}
    return cmd, {}


def install(sink_factory: Callable[[], CommandSink], executor_module=None) -> list[str]:
    """Add our commands to the Muse SDK's executor. Returns the names added. Idempotent."""
    if executor_module is None:
        from musegadget import executor as executor_module  # Linux only (imports pwd)
    ex = executor_module
    specs = command_specs(catalog_names(settings().catalog_path))
    ex.COMMAND_SPECS.update(specs)

    original = ex.Executor.run
    if getattr(original, "_displayxr_wrapped", False):
        return sorted(specs)

    def run(self, command, params, timeout_ms=None):
        if isinstance(command, str) and command in specs:
            cmd, args = to_bridge(command, params)
            try:
                ack = sink_factory().send(cmd, args)
            except Exception as exc:  # never let a bridge problem take down the SDK's invoke
                log.warning("%s failed: %s", command, type(exc).__name__)
                return ex.error(f"{type(exc).__name__}: {exc}")
            return ex.ok({"detail": ack.detail}) if ack.ok else ex.error(ack.error)
        return original(self, command, params, timeout_ms)

    run._displayxr_wrapped = True
    ex.Executor.run = run
    log.info("added %d DisplayXR commands", len(specs))
    return sorted(specs)


class MuseSource(CommandSource):
    name = "muse"

    def run(self, sink: CommandSink, argv: list[str]) -> int:
        from musegadget import cli as muse_cli

        added = install(lambda: sink)
        # The SDK's CLI configures logging only once it starts, so say this directly (journald
        # captures it: the unit sets PYTHONUNBUFFERED=1).
        print(f"displayxr: added {len(added)} DisplayXR commands: {', '.join(added)}", file=sys.stderr)
        return muse_cli.main(argv or ["run"])
