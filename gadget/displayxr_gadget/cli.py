"""dxr-gadget: pick a command source and connect it to the bridge.

    dxr-gadget mock [command ...]     typed commands (no Muse needed)
    dxr-gadget muse [run|pair|info]   the Muse gadget (on the Pi, via systemd)
    dxr-gadget mcp | local-model      stubs (not implemented yet)
"""

from __future__ import annotations

import sys

from displayxr_gadget.adapters.local_model_stub import LocalModelSource
from displayxr_gadget.adapters.mcp_stub import McpSource
from displayxr_gadget.adapters.mock import MockSource
from displayxr_gadget.adapters.muse import MuseSource
from displayxr_gadget.bridge_client import BridgeClient
from displayxr_gadget.config import settings

SOURCES = {s.name: s for s in (MockSource, MuseSource, McpSource, LocalModelSource)}


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help") or argv[0] not in SOURCES:
        print(__doc__.strip())
        return 0 if argv and argv[0] in ("-h", "--help") else 2
    source = SOURCES[argv[0]]()
    s = settings()
    try:
        sink = BridgeClient(s.bridge_url, s.bridge_secret, name=f"{source.name}-gadget")
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    try:
        return source.run(sink, argv[1:])
    except NotImplementedError as exc:
        print(exc, file=sys.stderr)
        return 3
