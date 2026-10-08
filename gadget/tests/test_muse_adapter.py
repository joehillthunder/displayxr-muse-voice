"""The Muse adapter against a stand-in for musegadget.executor, and against the real SDK when
it is importable (Linux with the pinned SDK installed; CI does this)."""

import types

import pytest

from displayxr_gadget.adapters import muse
from displayxr_gadget.bridge_client import Ack


def fake_executor_module():
    """The parts of musegadget.executor the adapter touches, same shapes as the SDK."""
    calls = []

    class Executor:
        def __init__(self, account=None):
            self.account = account

        def run(self, command, params, timeout_ms=None):
            calls.append((command, params, timeout_ms))
            return {"ok": True, "payload": {"original": command}}

    mod = types.SimpleNamespace(
        COMMAND_SPECS={"system.run": {"description": "x", "required": {}, "optional": {}}},
        Executor=Executor,
        ok=lambda payload: {"ok": True, "payload": payload},
        error=lambda message: {"ok": False, "error": message},
    )
    return mod, calls


class RecordingSink:
    def __init__(self, ack=Ack(True, detail="done")):
        self.sent = []
        self.ack = ack

    def send(self, cmd, args=None):
        self.sent.append((cmd, args))
        return self.ack


def test_specs_follow_the_sdk_format():
    specs = muse.command_specs({"models": ["car", "vase"], "splats": ["knot"]})
    assert set(specs) == {f"displayxr.{c}" for c in
                          ("show_model", "show_splat", "set_mode", "set_depth", "start_call", "clear")}
    allowed_types = {"string", "integer", "boolean"}  # the only types the SDK's own specs use
    for name, spec in specs.items():
        assert isinstance(spec["description"], str) and spec["description"]
        for group in ("required", "optional"):
            for param in spec[group].values():
                assert param["type"] in allowed_types, name
                assert param["description"]
    assert "car, vase" in specs["displayxr.show_model"]["description"]
    assert "knot" in specs["displayxr.show_splat"]["description"]


def test_install_extends_specs_in_place_and_routes_commands():
    mod, calls = fake_executor_module()
    specs_obj = mod.COMMAND_SPECS  # what service.py holds a reference to
    sink = RecordingSink()
    added = muse.install(lambda: sink, executor_module=mod)

    assert mod.COMMAND_SPECS is specs_obj
    assert "system.run" in specs_obj and "displayxr.show_model" in specs_obj
    assert set(added) <= set(specs_obj)

    ex = mod.Executor()
    assert ex.run("displayxr.show_model", {"name": "car"}) == {"ok": True, "payload": {"detail": "done"}}
    assert ex.run("displayxr.set_depth", {"percent": 40}) == {"ok": True, "payload": {"detail": "done"}}
    assert ex.run("displayxr.set_mode", {"mode": " 3D "})["ok"]
    assert sink.sent == [("show_model", {"name": "car"}), ("set_depth", {"value": 0.4}),
                         ("set_mode", {"mode": "3d"})]

    # The SDK's own commands still reach the original method.
    assert ex.run("system.run", {"command": "true"}, 5000) == {"ok": True, "payload": {"original": "system.run"}}
    assert calls == [("system.run", {"command": "true"}, 5000)]


def test_install_is_idempotent():
    mod, _ = fake_executor_module()
    sink = RecordingSink()
    muse.install(lambda: sink, executor_module=mod)
    first = mod.Executor.run
    muse.install(lambda: sink, executor_module=mod)
    assert mod.Executor.run is first


def test_failures_come_back_as_sdk_errors():
    mod, _ = fake_executor_module()
    muse.install(lambda: RecordingSink(Ack(False, error="no display connected")), executor_module=mod)
    assert mod.Executor().run("displayxr.clear", {}) == {"ok": False, "error": "no display connected"}

    class Boom:
        def send(self, cmd, args=None):
            raise RuntimeError("socket on fire")

    mod2, _ = fake_executor_module()
    muse.install(lambda: Boom(), executor_module=mod2)
    result = mod2.Executor().run("displayxr.clear", {})
    assert result["ok"] is False and "socket on fire" in result["error"]


@pytest.mark.parametrize("command,params,expected", [
    ("displayxr.show_splat", {"url": "https://x.test/a.sog", "name": ""}, ("show_splat", {"url": "https://x.test/a.sog"})),
    ("displayxr.set_depth", {"percent": 250}, ("set_depth", {"value": 1.0})),
    ("displayxr.set_depth", {"percent": "lots"}, ("set_depth", {"value": "lots"})),
    ("displayxr.start_call", None, ("start_call", {})),
])
def test_to_bridge(command, params, expected):
    assert muse.to_bridge(command, params) == expected


def test_against_the_real_sdk():
    executor = pytest.importorskip("musegadget.executor")  # Linux only: it imports pwd
    service = pytest.importorskip("musegadget.service")
    sink = RecordingSink()
    muse.install(lambda: sink, executor_module=executor)
    # service.py registers whatever this dict holds when a session starts.
    assert service.COMMAND_SPECS is executor.COMMAND_SPECS
    assert "displayxr.show_model" in service.COMMAND_SPECS
    ex = executor.Executor(executor.Account.current())
    assert ex.run("displayxr.clear", {}) == executor.ok({"detail": "done"})
    assert ex.run("device.health", {})["ok"] is True
