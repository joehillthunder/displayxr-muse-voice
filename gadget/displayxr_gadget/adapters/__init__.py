"""Command sources. Each turns some input (voice, keyboard, an agent) into bridge commands.

    muse         Meta's Muse, through the Muse Linux Device SDK (adapters/muse.py)
    mock         typed commands, no account or token needed (adapters/mock.py)
    mcp          stub: expose the commands as MCP tools (adapters/mcp_stub.py)
    local-model  stub: on-device speech + a small tool-calling model (adapters/local_model_stub.py)
"""

from displayxr_gadget.adapters.base import CommandSink, CommandSource

__all__ = ["CommandSink", "CommandSource"]
