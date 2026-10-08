"""Mock source: type commands instead of speaking. No Muse account or token needed.

    dxr-gadget mock                      interactive prompt
    dxr-gadget mock show_model car       one command; exit code 1 if it failed
"""

from __future__ import annotations

from displayxr_gadget.adapters.base import CommandSink, CommandSource
from displayxr_gadget.protocol import COMMAND_NAMES, parse_line, validate


def run_line(sink: CommandSink, line: str, out=print) -> bool:
    cmd, args = parse_line(line)
    problem = validate(cmd, args)
    if problem:
        out(f"  x {problem}")
        return False
    ack = sink.send(cmd, args)
    out(f"  ok {ack.detail}" if ack.ok else f"  x {ack.error}")
    return ack.ok


class MockSource(CommandSource):
    name = "mock"

    def run(self, sink: CommandSink, argv: list[str]) -> int:
        if argv:
            return 0 if run_line(sink, " ".join(argv)) else 1
        print(f"commands: {', '.join(COMMAND_NAMES)}  (Ctrl+D or Ctrl+C to quit)")
        try:
            while True:
                line = input("dxr> ")
                if line.strip():
                    run_line(sink, line)
        except (EOFError, KeyboardInterrupt):
            print()
        return 0
