"""Stub: expose the display commands as MCP tools, so any MCP client (an agent, a desktop
assistant) can drive the display the way Muse does.

Not implemented. The shape, for whoever picks it up:

* One MCP tool per command in protocol.COMMAND_NAMES, with the parameter schema from
  adapters/muse.py's COMMAND_SPECS (they describe the same arguments).
* Each tool call becomes ``sink.send(cmd, args)``; return ``ack.detail`` as the tool result, or
  ``ack.error`` as a tool error.
* Run it over stdio so a client can launch it as a local server; keep the bridge secret in the
  environment, never in tool arguments.
"""

from __future__ import annotations

from displayxr_gadget.adapters.base import CommandSink, CommandSource


class McpSource(CommandSource):
    name = "mcp"

    def run(self, sink: CommandSink, argv: list[str]) -> int:
        raise NotImplementedError(
            "The MCP adapter is a stub. See the docstring in adapters/mcp_stub.py for the design."
        )
