# esp32: depth dial and 2D/3D button (stretch goal)

A physical control for the demo: turn a rotary encoder to move the object toward you or behind
the screen (`set_depth`), press a button to switch the panel between 2D and 3D (`set_mode`).

> **Status: compiles in CI, not tested on hardware.** CI builds it into the Muse ESP32 SDK's
> default board (ESP32-C5 DevKitC-1) with ESP-IDF v6.0.1. Nobody has turned the knob yet.

It is an ESP-IDF component for the [Muse ESP32 Device SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/esp32),
so the same board is also your Muse gadget. The dial does **not** go through Muse: it talks to
the bridge directly over the LAN, because a knob needs to feel instant and the bridge already
accepts any source that knows the secret.

## Wiring

| Part | Pin (default, change in menuconfig) |
|---|---|
| Encoder A / CLK | GPIO 4 |
| Encoder B / DT | GPIO 5 |
| Encoder common / GND | GND |
| Button (to GND, internal pull-up) | GPIO 6 |

Any EC11-style quadrature encoder works; one detent moves depth by 0.05 (20 detents from the
screen plane to fully out). Pick pins your board leaves free: check its pinout and the SDK's
board file.

## Build

ESP-IDF builds on macOS or Linux (the SDK's README covers the toolchain; it uses v6.0.1).

```sh
git clone https://github.com/facebookincubator/muse-gadget-sdk
bash esp32/install-into-sdk.sh muse-gadget-sdk      # copies the component, applies muse-sdk.patch
cd muse-gadget-sdk/esp32
idf.py menuconfig    # ESP32 Device SDK > SDK token, and DisplayXR dial > enable, URL, secret, pins
idf.py build flash monitor
```

`muse-sdk.patch` is three small changes, all inert unless `CONFIG_DXR_DIAL_ENABLED`: include
the header and call `displayxr_dial_start()` in `main/main.c`, and add the component to
`main/CMakeLists.txt`. It is made against the SDK commit `setup-pi.sh` pins; a newer SDK may
need a manual merge.

The bridge URL and secret are compiled into the firmware and live in `sdkconfig`, which the SDK
already gitignores. Don't commit them.

## What it sends

```json
{"v":1,"type":"command","id":"dial-7","cmd":"set_depth","args":{"value":0.35}}
{"v":1,"type":"command","id":"dial-8","cmd":"set_mode","args":{"mode":"2d"}}
```

Dial turns are coalesced to at most ten sends a second. Errors from the display (for example
"no DisplayXR 3D display here") are logged on the serial console.
