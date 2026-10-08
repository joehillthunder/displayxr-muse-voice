# Bridge protocol (v1)

JSON text frames over one WebSocket endpoint, `/ws`, on the bridge (LAN only).

## Handshake
First frame from every client, within 5 s, or the bridge closes the socket:

    {"v":1,"type":"hello","role":"display"|"source","name":"pi-gadget","secret":"<BRIDGE_SECRET>"}

Bridge replies `{"v":1,"type":"welcome"}` or closes with code 4401. Browsers cannot set
WebSocket headers, so the secret travels in this frame; the display page reads it from `#secret=`.

## Commands (source -> bridge -> every display)

    {"v":1,"type":"command","id":"<uuid>","cmd":"show_model","args":{"name":"duck"}}

| cmd | args | effect |
|---|---|---|
| `show_model` | `name` (catalog) or `url` (http/https glTF/GLB) | `addModel()` on a fresh covered canvas |
| `show_splat` | `name` or `url` (.sog/.ply) | `addSplat()`; splat->splat uses `handle.setSource()` |
| `set_mode` | `mode`: `"2d"`/`"3d"` | `wall.setStereoEnabled()` |
| `start_call` | none | `addCall()` from `@displayxr/inline3d/call` |
| `clear` | none | removes the current window |
| `set_depth` | `value` -1..1 (ESP32 dial) | `viewer.depthOffset` (scaled to metres) |

## Acks (display -> bridge -> originating source)

    {"v":1,"type":"ack","id":"<uuid>","ok":true,"detail":"showing duck"}
    {"v":1,"type":"ack","id":"<uuid>","ok":false,"error":"no display connected"}

The bridge itself acks `ok:false` when no display is connected.

On the Muse side these are registered as `displayxr.show_model` etc. (the SDK's dotted naming).
