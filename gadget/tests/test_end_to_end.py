"""Mock mode end to end: Python source -> the real Node bridge -> a stand-in display -> ack back.

Skipped when node is not installed or the bridge's dependencies are missing.
"""

import json
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from displayxr_gadget.adapters.mock import run_line
from displayxr_gadget.bridge_client import BridgeClient

REPO = Path(__file__).resolve().parents[2]
SECRET = "e2e-secret-0123456789abcdef"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    not NODE or not (REPO / "bridge" / "node_modules" / "ws").is_dir(),
    reason="needs node and `npm install` in bridge/",
)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def bridge():
    port = free_port()
    env = {**os.environ, "BRIDGE_SECRET": SECRET, "BRIDGE_PORT": str(port)}
    proc = subprocess.Popen([NODE, "server.js"], cwd=REPO / "bridge", env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    else:
        proc.kill()
        pytest.fail("bridge did not start")
    yield f"ws://127.0.0.1:{port}/ws"
    proc.kill()
    proc.wait()


class FakeDisplay(threading.Thread):
    """Answers every command like display/app.js would, and records what it got."""

    def __init__(self, url):
        super().__init__(daemon=True)
        self.url = url
        self.received = []
        self.ready = threading.Event()

    def run(self):
        try:
            self._serve()
        except ConnectionClosed:
            pass  # the fixture stopped the bridge

    def _serve(self):
        with connect(self.url) as ws:
            ws.send(json.dumps({"v": 1, "type": "hello", "role": "display", "secret": SECRET}))
            for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "welcome":
                    self.ready.set()
                elif msg["type"] == "command":
                    self.received.append((msg["cmd"], msg["args"]))
                    ok = msg["args"].get("name") != "missing"
                    ws.send(json.dumps({"v": 1, "type": "ack", "id": msg["id"], "ok": ok,
                                        **({"detail": f"did {msg['cmd']}"} if ok else {"error": "no such asset"})}))


def test_mock_source_through_the_bridge(bridge):
    display = FakeDisplay(bridge)
    display.start()
    assert display.ready.wait(5)

    client = BridgeClient(bridge, SECRET, name="pytest")
    out = []
    assert run_line(client, "show_model car", out.append)
    assert run_line(client, "set_depth -0.25", out.append)
    assert not run_line(client, "show_splat missing", out.append)
    assert not run_line(client, "set_mode vr", out.append)  # rejected locally, never sent
    assert display.received == [("show_model", {"name": "car"}), ("set_depth", {"value": -0.25}),
                                ("show_splat", {"name": "missing"})]
    assert out == ["  ok did show_model", "  ok did set_depth", "  x no such asset", '  x mode must be "2d" or "3d"']


def test_wrong_secret_is_reported(bridge):
    ack = BridgeClient(bridge, "not-the-secret-xxxxxxxx").send("clear")
    assert not ack.ok and "rejected" in ack.error


def test_no_display(bridge):
    ack = BridgeClient(bridge, SECRET).send("clear")
    assert not ack.ok and "no display" in ack.error


def test_bridge_down():
    ack = BridgeClient(f"ws://127.0.0.1:{free_port()}/ws", SECRET).send("clear", timeout_s=3)
    assert not ack.ok and "cannot reach" in ack.error
