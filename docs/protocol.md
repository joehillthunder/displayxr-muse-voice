# Bridge protocol (v1)

JSON text frames over one WebSocket endpoint, `/ws`, on the bridge. The bridge accepts only
loopback and private-network (LAN) peers, and frames up to 16 KB.

The validator lives in [`display/protocol.js`](../display/protocol.js) (used by the page and the
bridge) and [`gadget/displayxr_gadget/protocol.py`](../gadget/displayxr_gadget/protocol.py).
Both are tested against [`test-fixtures/protocol-cases.json`](../test-fixtures/protocol-cases.json).

## Handshake

The first frame from every client must arrive within 5 s, or the bridge closes the socket:

    {"v":1,"type":"hello","role":"display"|"source","name":"pi-gadget","secret":"<BRIDGE_SECRET>"}

The bridge replies `{"v":1,"type":"welcome","displays":<n>}`, or closes with code 4401 (bad
secret) or 4400 (malformed). Browsers cannot set WebSocket headers, so the secret travels in
this frame; the display page reads it once from `#secret=` and keeps it in `sessionStorage`.

## Commands (source → bridge → every display)

    {"v":1,"type":"command","id":"<uuid>","cmd":"show_model","args":{"name":"car"}}

| cmd | args | effect on the display page |
|---|---|---|
| `show_model` | exactly one of `name` (catalog key or alias) or `url` (http/https glTF/GLB) | `addModel()` on a fresh, covered canvas |
| `show_splat` | exactly one of `name` or `url` (.sog / .ply) | `addSplat()` (PlayCanvas); splat → splat uses `handle.setSource()` |
| `set_mode` | `mode`: `"2d"` or `"3d"` | `wall.setStereoEnabled()`, eased; fails where there is no DisplayXR display |
| `set_depth` | `value`: number from -1 to 1 | `viewer.depthOffset = value × 0.08 m` (+ is out of the glass) |
| `start_call` | none | `addCall()` from `@displayxr/inline3d/call`, auto-joins; the ack carries the invite link |
| `clear` | none | removes the current window or call |

Names match `^[a-z0-9][a-z0-9_-]{0,39}$`. Any other command, or arguments that fail
validation, are answered by the bridge with `ok:false` and never reach the display.

## Acks (display → bridge → the source that sent the command)

    {"v":1,"type":"ack","id":"<uuid>","ok":true,"detail":"showing Toy car"}
    {"v":1,"type":"ack","id":"<uuid>","ok":false,"error":"no model called \"ufo\" (known: suzanne, vase, car, cube)"}

The display acks once the content has **loaded** (not when the 3D weave settles). The bridge
acks `ok:false` itself when no display is connected, or when the display has not answered
within 45 s. If several displays are connected, the first ack wins.

## Status (display → bridge → every source)

    {"v":1,"type":"status","state":{"content":{"kind":"model","label":"Toy car"},"woven":true,"hardware":"3d","depth":0}}

Sent after every command. Sources may ignore it.

## The Muse view of the same commands

Registered with Muse in the SDK's `COMMAND_SPECS` format, with dotted names like the SDK's own
`system.run`:

| Muse command | Parameters | Bridge command |
|---|---|---|
| `displayxr.show_model` | `name` or `url` (string) | `show_model` |
| `displayxr.show_splat` | `name` or `url` (string) | `show_splat` |
| `displayxr.set_mode` | `mode` (string) | `set_mode` |
| `displayxr.set_depth` | `percent` (integer, -100 to 100) | `set_depth` with `value = percent / 100` |
| `displayxr.start_call` | none | `start_call` |
| `displayxr.clear` | none | `clear` |

`set_depth` takes an integer percent for Muse because the SDK's own specs only use the types
`string`, `integer` and `boolean`. `show_*` and `start_call` declare `timeout_ms: 60000`.
