"""
make_aircraft.py — procedural manta/flying-wing wireframe for ridgeline.

Coordinate convention (matches core):
  x = right, y = up, z = BACK  (nose is at -z)

Planform (top view):
  - Sharp nose at (0, 0, -1)
  - Leading edges: concave (recurved) curves sweeping back to wingtips at ±span_half, z ~ -0.05
  - Trailing edge: convex bow backward (max z = +0.4) between tips

Cross-section (lens/almond, back view):
  - Body bulges above and below; thickness peaks at ~40% chord
  - Wingtips flick upward (dihedral ramp near tips)

Slice scheme: FORE-AFT sections only (constant-x planes).
  - N_STATIONS slices across the full span (-SPAN_HALF to +SPAN_HALF)
  - Each slice = one closed loop: top surface LE→TE, then bottom TE→LE
  - No spanwise ribs, no cross-grid — just stacked fore-aft contours

Output: data/aircraft.json  {"positions": [[x,y,z],...], "lines": [[i,j],...]}
"""

import json
import math
from pathlib import Path

import numpy as np

# ── Planform parameters ────────────────────────────────────────────────────────
SPAN_HALF   = 0.6    # half-wingspan (symmetric, full span = 1.2)
NOSE_Z      = -1.0   # nose tip
TIP_Z       = -0.05  # z at wingtips (swept back from nose)
TE_MAX_Z    = 0.35   # trailing edge bow-back at centerline
MAX_THICK   = 0.07   # max half-thickness of lens profile
THICK_PEAK  = 0.40   # chord fraction of peak thickness

# ── Slice density ──────────────────────────────────────────────────────────────
N_STATIONS  = 50     # fore-aft section planes across the full span
N_LOOP_PTS  = 24     # points per surface (top or bottom) per section loop

# ── Winglet ───────────────────────────────────────────────────────────────────
TIP_DIHEDRAL = 0.06  # upward flick at tips
TIP_FRAC     = 0.30  # outermost fraction of span where dihedral ramps up


def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def planform_le_z(x_abs):
    """Leading-edge z at |x|. Concave (recurved) sweep."""
    t = x_abs / SPAN_HALF
    z_straight = NOSE_Z + (TIP_Z - NOSE_Z) * t
    z_concave  = -0.25 * math.sin(math.pi * t)  # dip at mid-span
    return z_straight + z_concave


def planform_te_z(x_abs):
    """Trailing-edge z at |x|. Convex bow backward."""
    t = x_abs / SPAN_HALF
    return TE_MAX_Z + (TIP_Z - TE_MAX_Z) * t * t  # quadratic bow


def lens_thickness(cf):
    """Half-thickness at chord fraction cf (0=LE, 1=TE)."""
    if cf <= 0.0 or cf >= 1.0:
        return 0.0
    if cf < THICK_PEAK:
        return MAX_THICK * math.sin(math.pi * cf / (2 * THICK_PEAK))
    return MAX_THICK * math.sin(math.pi * (1 - cf) / (2 * (1 - THICK_PEAK)))


def tip_dihedral_y(x_abs):
    """Extra y added near wingtips."""
    t = (x_abs / SPAN_HALF - (1.0 - TIP_FRAC)) / TIP_FRAC
    return TIP_DIHEDRAL * smoothstep(t)


# ── Build positions + lines ────────────────────────────────────────────────────

positions = []
lines     = []


def add_pt(x, y, z):
    idx = len(positions)
    positions.append([round(x, 5), round(y, 5), round(z, 5)])
    return idx


# ── Fore-aft section loops (constant-x slices) ────────────────────────────────
# For each spanwise station x_i, produce one closed loop:
#   top surface sampled LE→TE (N_LOOP_PTS points)
#   bottom surface sampled TE→LE (N_LOOP_PTS points)
# Stations near the tips become thin slivers — that's fine.

x_stations = np.linspace(-SPAN_HALF, SPAN_HALF, N_STATIONS)

for x in x_stations:
    x_abs = abs(x)
    le_z  = planform_le_z(x_abs)
    te_z  = planform_te_z(x_abs)
    chord = te_z - le_z
    if chord < 1e-6:
        continue

    dy = tip_dihedral_y(x_abs)

    # Sample top surface: LE → TE (cf = 0 → 1)
    top_pts = []
    for cf in np.linspace(0.0, 1.0, N_LOOP_PTS):
        z  = le_z + cf * chord
        th = lens_thickness(cf)
        top_pts.append(add_pt(x, th + dy, z))

    # Sample bottom surface: TE → LE (cf = 1 → 0)
    bot_pts = []
    for cf in np.linspace(1.0, 0.0, N_LOOP_PTS):
        z  = le_z + cf * chord
        th = lens_thickness(cf)
        bot_pts.append(add_pt(x, -th + dy, z))

    # Close the loop: top LE→TE, then bottom TE→LE, then close back to top[0]
    loop = top_pts + bot_pts
    for k in range(len(loop) - 1):
        lines.append([loop[k], loop[k + 1]])
    lines.append([loop[-1], loop[0]])  # closing edge (LE seam)


# ── Normalize: scale so nose-to-tail ≈ 1.0, center on origin ─────────────────
pos_arr = np.array(positions)
z_range = pos_arr[:, 2].max() - pos_arr[:, 2].min()
if z_range > 0:
    scale = 1.0 / z_range
    pos_arr *= scale

z_mid = (pos_arr[:, 2].max() + pos_arr[:, 2].min()) / 2
pos_arr[:, 2] -= z_mid
y_mid = (pos_arr[:, 1].max() + pos_arr[:, 1].min()) / 2
pos_arr[:, 1] -= y_mid

positions = [[round(float(v), 5) for v in p] for p in pos_arr]

# ── Write output ──────────────────────────────────────────────────────────────
out_path = Path(__file__).parent.parent / "aircraft.json"
data = {"positions": positions, "lines": lines}
out_path.write_text(json.dumps(data, separators=(",", ":")))

print(f"Written {out_path}")
print(f"  vertices : {len(positions)}")
print(f"  lines    : {len(lines)}")
nose_z = min(p[2] for p in positions)
tail_z = max(p[2] for p in positions)
print(f"  z range  : {nose_z:.3f} (nose) .. {tail_z:.3f} (tail)")
print(f"  x range  : {min(p[0] for p in positions):.3f} .. {max(p[0] for p in positions):.3f}")
