"""Stub: a fully local voice path, with no cloud assistant.

Not implemented. The shape, for whoever picks it up:

* Speech to text on the device (for example a whisper.cpp build on the Pi 5).
* A small local model with tool calling, given the same tool list as adapters/muse.py's
  COMMAND_SPECS and the catalog names, decides which command to send.
* Each tool call becomes ``sink.send(cmd, args)``; speak or print ``ack.detail``.

Nothing else in the repo changes: the bridge and the display already accept commands from any
authenticated source.
"""

from __future__ import annotations

from displayxr_gadget.adapters.base import CommandSink, CommandSource


class LocalModelSource(CommandSource):
    name = "local-model"

    def run(self, sink: CommandSink, argv: list[str]) -> int:
        raise NotImplementedError(
            "The local-model adapter is a stub. See the docstring in adapters/local_model_stub.py."
        )
