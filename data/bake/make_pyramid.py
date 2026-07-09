#!/usr/bin/env python3
"""
Resolution pyramid bake for ridgeline heightfields.

For each body (Earth, Moon, Mars) reads the full-resolution little-endian int16
heightfield.bin and writes downsampled tiers at factors 4 and 16 via exact
area-mean block reduction.  The app derives tier dims as width/f, height/f from
the body's main meta.json — no extra meta files are written.

Output naming:
  data/<stem>_d4.bin   (1/4 linear, 1/16 area)
  data/<stem>_d16.bin  (1/16 linear, 1/256 area)

Usage:
  python3 make_pyramid.py
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(HERE, ".."))  # ridgeline/data/

BODIES = [
    ("meta.json",         "heightfield.bin",         "heightfield"),
    ("moon_meta.json",    "moon_heightfield.bin",    "moon_heightfield"),
    ("mars_meta.json",    "mars_heightfield.bin",    "mars_heightfield"),
    ("venus_meta.json",   "venus_heightfield.bin",   "venus_heightfield"),
    ("mercury_meta.json", "mercury_heightfield.bin", "mercury_heightfield"),
    ("sun_meta.json",     "sun_heightfield.bin",     "sun_heightfield"),
    ("ceres_meta.json",      "ceres_heightfield.bin",      "ceres_heightfield"),
    ("vesta_meta.json",      "vesta_heightfield.bin",      "vesta_heightfield"),
    ("enceladus_meta.json",  "enceladus_heightfield.bin",  "enceladus_heightfield"),
    ("pluto_meta.json",      "pluto_heightfield.bin",      "pluto_heightfield"),
    ("charon_meta.json",     "charon_heightfield.bin",     "charon_heightfield"),
]

FACTORS = [4, 16]


def block_reduce(arr, f):
    """Area-mean downscale by integer factor f in both axes."""
    h, w = arr.shape
    assert w % f == 0 and h % f == 0, f"dims {w}x{h} not divisible by {f}"
    return arr.reshape(h // f, f, w // f, f).mean(axis=(1, 3))


def load_heightfield(path, w, h):
    data = np.fromfile(path, dtype="<i2")
    if data.size != w * h:
        sys.exit(f"size mismatch in {path}: got {data.size}, expected {w*h}")
    return data.reshape(h, w)


def sanity_check(full, reduced, f):
    """Spot-check a handful of blocks: reduced value should be within a few metres
    of the area mean of the corresponding full-res block."""
    rng = np.random.default_rng(42)
    h_r, w_r = reduced.shape
    sample_rows = rng.integers(0, h_r, size=6)
    sample_cols = rng.integers(0, w_r, size=6)
    max_err = 0.0
    for r, c in zip(sample_rows, sample_cols):
        full_block = full[r * f:(r + 1) * f, c * f:(c + 1) * f].astype(np.float64)
        expected = full_block.mean()
        got = float(reduced[r, c])
        err = abs(got - expected)
        max_err = max(max_err, err)
    full_min, full_max = int(full.min()), int(full.max())
    out_min, out_max = int(reduced.min()), int(reduced.max())
    range_ok = out_min >= full_min and out_max <= full_max
    return max_err, range_ok, full_min, full_max, out_min, out_max


def main():
    rows = []      # for summary table
    sanity_rows = []

    for meta_file, hf_file, stem in BODIES:
        meta_path = os.path.join(DATA_DIR, meta_file)
        hf_path = os.path.join(DATA_DIR, hf_file)

        with open(meta_path) as f:
            meta = json.load(f)
        w, h = meta["width"], meta["height"]

        print(f"\n[{stem}]  full-res {w}x{h}")
        full = load_heightfield(hf_path, w, h)

        for f in FACTORS:
            reduced_f = block_reduce(full.astype(np.float64), f)
            reduced16 = np.round(reduced_f).astype("<i2")

            out_name = f"{stem}_d{f}.bin"
            out_path = os.path.join(DATA_DIR, out_name)
            reduced16.tofile(out_path)

            rw, rh = w // f, h // f
            mb = os.path.getsize(out_path) / 1024 / 1024
            rows.append((stem, f"d{f}", f"{rw}x{rh}", f"{mb:.2f} MiB", out_path))

            max_err, range_ok, full_min, full_max, out_min, out_max = \
                sanity_check(full, reduced16, f)
            sanity_rows.append((stem, f"d{f}", max_err, range_ok,
                                 full_min, full_max, out_min, out_max))
            print(f"  d{f}: {rw}x{rh}  {mb:.2f} MiB  written {out_path}")

    # Summary table
    print("\n=== pyramid summary ===")
    print(f"{'body':<20} {'tier':<5} {'dims':<14} {'size'}")
    print("-" * 56)
    for stem, tier, dims, size, path in rows:
        print(f"{stem:<20} {tier:<5} {dims:<14} {size}")

    # Sanity results
    print("\n=== sanity checks ===")
    all_ok = True
    for stem, tier, max_err, range_ok, full_min, full_max, out_min, out_max in sanity_rows:
        err_ok = max_err < 1.0  # area mean → round trip should be sub-metre
        ok = err_ok and range_ok
        all_ok = all_ok and ok
        status = "OK " if ok else "!!"
        print(f"  [{status}] {stem} {tier}: "
              f"max block err {max_err:.3f} m  "
              f"range [{out_min}..{out_max}] vs full [{full_min}..{full_max}]"
              f"{'  range-OK' if range_ok else '  RANGE-FAIL'}")
    print("all checks passed" if all_ok else "SOME CHECKS FAILED — inspect outputs")

    print("\n=== output files ===")
    for _, _, _, _, path in rows:
        print(f"  {path}")


if __name__ == "__main__":
    main()
