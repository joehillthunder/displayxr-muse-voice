"""The adapter interface.

A source produces commands; a sink delivers them. Every source gets the same sink (in practice
BridgeClient), so adding a new way to talk to the display is one class with one method.
"""

from __future__ import annotations

import abc
from typing import Protocol

from displayxr_gadget.bridge_client import Ack


class CommandSink(Protocol):
    def send(self, cmd: str, args: dict | None = None) -> Ack:
        """Deliver one command (see protocol.py) and return the display's answer."""


class CommandSource(abc.ABC):
    #: Short name used on the command line: ``dxr-gadget <name>``.
    name: str = ""

    @abc.abstractmethod
    def run(self, sink: CommandSink, argv: list[str]) -> int:
        """Run until done (or forever) and return a process exit code."""
