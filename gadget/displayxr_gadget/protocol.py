"""The command vocabulary. Mirrors display/protocol.js (the canonical copy) and docs/protocol.md."""

from __future__ import annotations

import math
import re
from urllib.parse import urlparse

PROTOCOL_VERSION = 1

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")

COMMAND_NAMES = ("show_model", "show_splat", "set_mode", "start_call", "clear", "set_depth")


def _source(args: dict) -> str | None:
    has_name = isinstance(args.get("name"), str)
    has_url = isinstance(args.get("url"), str)
    if has_name == has_url:
        return "give exactly one of name or url"
    if has_name and not NAME_RE.match(args["name"]):
        return "name must be lowercase letters, digits, - or _"
    if has_url:
        url = args["url"]
        if len(url) > 2048:
            return "url too long"
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return "url must be http or https"
    return None


def _mode(args: dict) -> str | None:
    return None if args.get("mode") in ("2d", "3d") else 'mode must be "2d" or "3d"'


def _depth(args: dict) -> str | None:
    v = args.get("value")
    ok = isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and -1 <= v <= 1
    return None if ok else "value must be a number from -1 to 1"


_VALIDATORS = {
    "show_model": _source,
    "show_splat": _source,
    "set_mode": _mode,
    "start_call": lambda a: None,
    "clear": lambda a: None,
    "set_depth": _depth,
}


def validate(cmd: str, args: dict | None = None) -> str | None:
    """None when valid, else a message (same messages as the JS validator)."""
    if cmd not in _VALIDATORS:
        return f"unknown command: {cmd}"
    if args is None:
        args = {}
    if not isinstance(args, dict):
        return "args must be an object"
    return _VALIDATORS[cmd](args)


def parse_line(line: str) -> tuple[str, dict]:
    """'show_model duck' -> ('show_model', {'name': 'duck'}). Same grammar as bridge/mock.js."""
    parts = line.split()
    if not parts:
        return "", {}
    cmd, rest = parts[0], parts[1:]
    args: dict = {}
    for tok in rest:
        if "=" in tok and tok.index("=") > 0:
            k, v = tok.split("=", 1)
            args[k] = _number(v) if k == "value" else v
        elif cmd in ("show_model", "show_splat"):
            args["url" if re.match(r"^https?://", tok) else "name"] = tok
        elif cmd == "set_mode":
            args["mode"] = tok.lower()
        elif cmd == "set_depth":
            args["value"] = _number(tok)
    return cmd, args


def _number(text: str):
    try:
        return float(text)
    except ValueError:
        return text
