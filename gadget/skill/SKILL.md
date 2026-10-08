---
name: gadget-displayxr-display
description: >-
  Show 3D models and Gaussian splats on a glasses-free 3D display (DisplayXR, e.g. a Leia
  display) through a Muse Linux gadget that has displayxr-muse-voice installed. Use when the user
  asks to show, display, put up, or clear something on the 3D display, switch it between 2D and
  3D, move the object nearer or further, or start a 3D video call on it.
---

# DisplayXR 3D display: show models, splats and calls

Use this skill when the user asks for something on their 3D display and the Muse gadget reports
the `displayxr.*` commands, or, failing that, has the `dxr-gadget` program installed.

## Prefer the native commands

If the gadget registered `displayxr.show_model`, `displayxr.show_splat`, `displayxr.set_mode`,
`displayxr.set_depth`, `displayxr.start_call` and `displayxr.clear`, call those directly. Their
descriptions list the catalog names. Use this skill's shell fallback only when they are missing.

## Shell fallback (system.run)

Run one command per request. Each prints `ok <what happened>` and exits 0, or `x <reason>` and
exits 1.

| User asks | Run |
|---|---|
| "Show me the toy car" | `dxr-gadget mock show_model car` |
| "Show the torus knot splat" | `dxr-gadget mock show_splat knot` |
| A model at a URL they give you | `dxr-gadget mock show_model https://…/thing.glb` |
| "Make it flat" / "back to 3D" | `dxr-gadget mock set_mode 2d` / `set_mode 3d` |
| "Bring it closer" / "push it back" | `dxr-gadget mock set_depth 0.4` / `set_depth -0.4` (range -1 to 1, 0 is the screen) |
| "Start a 3D call" | `dxr-gadget mock start_call` (the output includes the invite link: read it back) |
| "Clear the display" | `dxr-gadget mock clear` |

Catalog names (lowercase): models `suzanne`, `vase`, `car`, `cube`; splat `knot`. The display
also accepts these aliases: monkey, flowers, glass vase, toy car, box, torus knot, rainbow. If a
name is unknown, the error lists the known ones: offer those.

## Verify the result

- Trust the exit code and the `ok`/`x` line; the display page answers each command after the
  content has loaded.
- `x no display connected to the bridge` means the display page is not open; tell the user to
  open it on the Windows PC (the setup script prints the URL).
- `x cannot reach the bridge` means the bridge on the Windows PC is not running or not reachable.

## Limits

- Only http(s) URLs are accepted, and the display must be able to fetch them (CORS).
- `set_mode` needs the DisplayXR Browser on a 3D display; in any other browser the page is 2D.
- Never print or repeat the bridge secret, and do not edit `/etc/displayxr-muse-voice.env`.

## Sources

- [displayxr-muse-voice](https://github.com/joehillthunder/displayxr-muse-voice)
- [DisplayXR inline-3D SDK](https://github.com/DisplayXR/displayxr-web)
