#!/usr/bin/env python3
"""Generate the demo's procedural Gaussian splat: a rainbow (3,7) torus knot in a dust halo.

Writes a standard 3D Gaussian Splatting PLY (binary little-endian, SH degree 0), the layout
the original 3DGS code writes and PlayCanvas/Spark read:

    x y z  nx ny nz  f_dc_0..2  opacity  scale_0..2  rot_0..3

with the usual encodings: f_dc = (rgb - 0.5) / SH_C0, opacity is a logit, scales are
natural logs, rot is a unit quaternion (w, x, y, z).

Our own work, so it carries this repo's Apache-2.0 license. Deterministic (fixed seed).

    python assets/tools/make_splat.py assets/splats/knot.ply
"""

from __future__ import annotations

import colorsys
import math
import random
import struct
import sys

SH_C0 = 0.28209479177387814
PROPS = ("x y z nx ny nz f_dc_0 f_dc_1 f_dc_2 opacity "
         "scale_0 scale_1 scale_2 rot_0 rot_1 rot_2 rot_3").split()


def logit(p: float) -> float:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def knot_point(t: float, p: int = 3, q: int = 7, r: float = 0.35, tube: float = 0.12):
    """Point on a (p,q) torus knot, unit-ish scale."""
    phi = p * t
    rr = r + tube * math.cos(q * t)
    return rr * math.cos(phi), tube * math.sin(q * t), rr * math.sin(phi)


def splats(seed: int = 7, knot_n: int = 36000, halo_n: int = 6000):
    rng = random.Random(seed)
    for i in range(knot_n):
        t = (i / knot_n) * 2 * math.pi
        cx, cy, cz = knot_point(t)
        # Scatter around the curve inside a thin tube.
        a = rng.uniform(0, 2 * math.pi)
        d = abs(rng.gauss(0, 0.018))
        x = cx + d * math.cos(a)
        y = cy + d * math.sin(a)
        z = cz + rng.gauss(0, 0.012)
        r, g, b = colorsys.hsv_to_rgb((t / (2 * math.pi) * 2) % 1.0, 0.75, 1.0)
        s = rng.uniform(0.004, 0.009)
        yield x, y, z, (r, g, b), 0.85, (s, s, s * 0.6), rng
    for _ in range(halo_n):
        # Faint blue-white dust on a sphere shell.
        u, v = rng.uniform(-1, 1), rng.uniform(0, 2 * math.pi)
        rad = rng.uniform(0.5, 0.62)
        k = math.sqrt(1 - u * u)
        x, y, z = rad * k * math.cos(v), rad * u * 0.6, rad * k * math.sin(v)
        c = rng.uniform(0.7, 1.0)
        s = rng.uniform(0.002, 0.005)
        yield x, y, z, (c * 0.8, c * 0.9, c), 0.35, (s, s, s), rng


def random_quat(rng: random.Random):
    u1, u2, u3 = rng.random(), rng.random(), rng.random()
    a, b = math.sqrt(1 - u1), math.sqrt(u1)
    return (b * math.cos(2 * math.pi * u3), a * math.sin(2 * math.pi * u2),
            a * math.cos(2 * math.pi * u2), b * math.sin(2 * math.pi * u3))


def write_ply(path: str) -> int:
    rows = []
    for x, y, z, (r, g, b), alpha, (s0, s1, s2), rng in splats():
        w, qx, qy, qz = random_quat(rng)
        rows.append(struct.pack(
            "<17f", x, y, z, 0.0, 0.0, 0.0,
            (r - 0.5) / SH_C0, (g - 0.5) / SH_C0, (b - 0.5) / SH_C0,
            logit(alpha), math.log(s0), math.log(s1), math.log(s2), w, qx, qy, qz,
        ))
    header = "ply\nformat binary_little_endian 1.0\n"
    header += f"comment displayxr-muse-voice procedural torus knot (Apache-2.0)\n"
    header += f"element vertex {len(rows)}\n"
    header += "".join(f"property float {p}\n" for p in PROPS)
    header += "end_header\n"
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(b"".join(rows))
    return len(rows)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "knot.ply"
    print(f"wrote {write_ply(out)} splats to {out}")
