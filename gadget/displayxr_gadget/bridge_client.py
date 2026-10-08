"""A small synchronous client for the bridge: one connection per command, wait for the ack.

Synchronous on purpose: the Muse SDK calls Executor.run() on a worker thread
(run_in_executor), and the mock CLI is a plain loop. A connection per command keeps it
stateless, and costs a few milliseconds on a LAN.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass

from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidURI
from websockets.sync.client import connect

from displayxr_gadget.protocol import PROTOCOL_VERSION, validate

DEFAULT_TIMEOUT_S = 50.0  # the bridge gives up on a display after 45 s


@dataclass(frozen=True)
class Ack:
    ok: bool
    detail: str = ""
    error: str = ""


class BridgeClient:
    def __init__(self, url: str, secret: str, name: str = "gadget") -> None:
        if not secret:
            raise ValueError("BRIDGE_SECRET is not set (copy .env.example to .env)")
        self.url = url
        self.secret = secret
        self.name = name

    def send(self, cmd: str, args: dict | None = None, timeout_s: float = DEFAULT_TIMEOUT_S) -> Ack:
        args = dict(args or {})
        problem = validate(cmd, args)
        if problem:
            return Ack(False, error=problem)
        command_id = str(uuid.uuid4())
        deadline = time.monotonic() + timeout_s
        try:
            with connect(self.url, open_timeout=5, close_timeout=2, max_size=64 * 1024) as ws:
                ws.send(json.dumps({"v": PROTOCOL_VERSION, "type": "hello", "role": "source",
                                    "name": self.name, "secret": self.secret}))
                self._wait_for(ws, deadline, lambda m: m.get("type") == "welcome")
                ws.send(json.dumps({"v": PROTOCOL_VERSION, "type": "command", "id": command_id,
                                    "cmd": cmd, "args": args}))
                msg = self._wait_for(ws, deadline,
                                     lambda m: m.get("type") == "ack" and m.get("id") == command_id)
        except ConnectionClosed as exc:
            if exc.rcvd is not None and exc.rcvd.code == 4401:
                return Ack(False, error="the bridge rejected BRIDGE_SECRET")
            return Ack(False, error=f"bridge closed the connection ({exc})")
        except TimeoutError:
            return Ack(False, error="timed out waiting for the bridge")
        except (OSError, InvalidHandshake, InvalidURI) as exc:
            return Ack(False, error=f"cannot reach the bridge at {self.url}: {exc}")
        if msg.get("ok"):
            return Ack(True, detail=str(msg.get("detail") or ""))
        return Ack(False, error=str(msg.get("error") or "failed"))

    @staticmethod
    def _wait_for(ws, deadline: float, match) -> dict:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            raw = ws.recv(timeout=remaining)
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict) and match(msg):
                return msg
