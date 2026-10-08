# Hardware checklist

Everything below needs real hardware; none of it has been run yet. Mock mode, the bridge, the
2D display path and the Python/Node sources were tested on a Windows PC in plain Chrome.

## Leia SR display + DisplayXR Browser (Windows)

- [ ] The page detects inline-3D: the badge reads "DisplayXR 3D ready", the bar "3D panel".
- [ ] `show_model car` weaves to 3D, and no raw side-by-side pair flashes while it loads (the
      cover should hold until `firstWoven`).
- [ ] model → splat → model: each change cuts cleanly with no flash, and no tile ends up flat.
- [ ] splat → splat (`show_splat url=…`) swaps in place through `setSource`.
- [ ] `set_mode 2d` / `3d`: the panel flips, the eased ramp has no double image, and the bar
      shows the reported hardware state.
- [ ] `set_depth 0.5` brings the subject out of the glass, `-0.5` pushes it behind. Check the
      sign on an asymmetric model (the SDK notes +z is toward the viewer).
- [ ] The status badge stays crisp 2D over the woven tile (`data-inline3d-overlay` +
      `handle.exclude`).
- [ ] The ToyCar (transmission, clearcoat) and the vase (glass) look right through PlayCanvas.
- [ ] Comfort: is 8 cm of depth range (`DEPTH_RANGE_M`) right for this panel?
- [ ] Load time of a first `show_model` on the panel PC stays well under the 45 s ack timeout.
- [ ] The firewall rule lets the Pi reach `ws://<pc>:8791/ws` on a Private network.

## 3D call

- [ ] `start_call` mounts the call, joins a room, and returns an invite link.
- [ ] The invite link (`https://joehillthunder.github.io/displayxr-muse-voice/#room=…`) opens
      the call on a second device, and they connect.
- [ ] A stereo camera appears in 3D on the panel; a webcam peer is lifted 2D→3D.
- [ ] `clear` leaves the call cleanly.

## Raspberry Pi 5 + Muse

- [ ] `setup-pi.sh` runs clean on Raspberry Pi OS (Bookworm) and on Bullseye (Python 3.9).
- [ ] The journal shows `added 6 DisplayXR commands` and `registered with the Muse`.
- [ ] Muse accepts the `displayxr.*` names (dotted, like `system.run`) and the specs as written.
- [ ] Voice: "show the toy car on my 3D display" reaches `displayxr.show_model` with
      `name: car`. Also try aliases ("the monkey", "the flowers").
- [ ] "Make it 2D", "bring it closer", "start a 3D call" map to the right commands, and Muse
      reads back the invite link.
- [ ] `timeout_ms: 60000` on `show_*` / `start_call` is honoured (a slow first load doesn't
      fail at 30 s).
- [ ] With the native commands removed, the fallback skill (`gadget/skill/SKILL.md`) works
      through `system.run` + `dxr-gadget mock …`.
- [ ] The SDK's own commands (`system.run`, `device.health`) still work alongside ours.

## ESP32 dial

- [ ] It builds and flashes on a real board (CI only proves the ESP32-C5 build compiles).
- [ ] The default GPIOs 4/5/6 are free on the chosen board, or are changed in menuconfig.
- [ ] It connects after the Muse firmware brings Wi-Fi up, and reconnects after a bridge
      restart.
- [ ] Direction, detent size and the 10 Hz coalescing feel right.
- [ ] Button debounce, and the 2D/3D toggle matching the panel's actual state.
