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

Output: data/aircraft.json  {"positions": [[x,y,z],...], "lines": [[i,j],...]}
"""

import json
import math
from pathlib import Path

import numpy as np

# ── Planform parameters ────────────────────────────────────────────────────────
SPAN_HALF   = 0.6    # half-wingspan (symmetric, so full span = 1.2)
NOSE_Z      = -1.0   # nose tip (normalized; length from nose to deepest TE = 1.4)
TIP_Z       = -0.05  # z position of wingtips (swept back from nose)
TE_MAX_Z    = 0.35   # trailing edge bow-back at centerline
MAX_THICK   = 0.07   # max half-thickness of lens profile
THICK_PEAK  = 0.40   # fraction of chord where thickness is maximum

# ── Grid density ──────────────────────────────────────────────────────────────
N_RIBS      = 14     # spanwise constant-z slices (tip to tip)
N_LONG      = 11     # longitudinal stringers per side (top + bottom surface)

# ── Winglet ───────────────────────────────────────────────────────────────────
TIP_DIHEDRAL = 0.06  # upward flick at tips (y offset added near |x|=SPAN_HALF)
TIP_FRAC     = 0.30  # outermost fraction of span where dihedral ramps up


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(t):
    """Smooth cubic for tip dihedral ramp."""
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def planform_le_z(x_abs):
    """Leading-edge z at lateral position |x|.  Concave (recurved) sweep.
    Nose at x=0, z=NOSE_Z; wingtip at x=SPAN_HALF, z=TIP_Z.
    Concave = curve bows toward nose in between.
    """
    t = x_abs / SPAN_HALF               # 0..1 spanwise
    # concave: z deeper (more negative) near mid-span, then comes back
    # achieved with a quadratic that dips below the straight line
    z_straight = lerp(NOSE_Z, TIP_Z, t)
    z_concave  = -0.25 * math.sin(math.pi * t)  # dip at mid-span
    return z_straight + z_concave


def planform_te_z(x_abs):
    """Trailing-edge z at lateral position |x|.  Convex bow backward."""
    t = x_abs / SPAN_HALF               # 0..1
    # convex: max bow at centerline, tip value = TIP_Z
    return lerp(TE_MAX_Z, TIP_Z, t * t)  # quadratic, bows at t=0


def chord_frac(z, le_z, te_z):
    """Fractional chord position (0=LE, 1=TE) for a given z within the local chord."""
    chord = te_z - le_z
    if abs(chord) < 1e-9:
        return 0.5
    return (z - le_z) / chord


def lens_thickness(cf):
    """Half-thickness of lens profile at chord fraction cf (0=LE,1=TE)."""
    # Peaked at THICK_PEAK, zero at both ends
    if cf <= 0.0 or cf >= 1.0:
        return 0.0
    return MAX_THICK * math.sin(math.pi * cf / (2 * THICK_PEAK)) \
        if cf < THICK_PEAK else \
        MAX_THICK * math.sin(math.pi * (1 - cf) / (2 * (1 - THICK_PEAK)))


def tip_dihedral_y(x_abs):
    """Extra y added near wingtips — winglet flick."""
    t = (x_abs / SPAN_HALF - (1.0 - TIP_FRAC)) / TIP_FRAC
    return TIP_DIHEDRAL * smoothstep(t)


# ── Build positions + lines ────────────────────────────────────────────────────

positions = []
lines     = []


def add_pt(x, y, z):
    idx = len(positions)
    positions.append([round(x, 5), round(y, 5), round(z, 5)])
    return idx


# ── 1. Longitudinal stringers (top + bottom surface) ──────────────────────────
# For each of N_LONG x-values (symmetric), trace a stringer front-to-back.
# x_vals cover 0..SPAN_HALF (then mirrored to -SPAN_HALF)

x_stringer_vals = np.linspace(0.0, SPAN_HALF, N_LONG)

for side in (-1, 1):
    for xi, x_abs in enumerate(x_stringer_vals):
        x = side * x_abs
        le_z = planform_le_z(x_abs)
        te_z = planform_te_z(x_abs)
        chord = te_z - le_z

        # sample N_RIBS z-values within this stringer's chord
        z_vals = np.linspace(le_z, te_z, N_RIBS)

        top_pts = []
        bot_pts = []
        for z in z_vals:
            cf = chord_frac(z, le_z, te_z)
            th = lens_thickness(cf)
            dy = tip_dihedral_y(x_abs)
            top_pts.append(add_pt(x,  th + dy, z))
            bot_pts.append(add_pt(x, -th + dy, z))

        # connect consecutive points along each surface
        for k in range(len(top_pts) - 1):
            lines.append([top_pts[k], top_pts[k+1]])
            lines.append([bot_pts[k], bot_pts[k+1]])

        # skip duplicate centerline: only one pass for x=0
        if side == -1 and xi == 0:
            # still add stringer but don't double-add; we'll just skip the mirrored x=0
            pass


# ── 2. Spanwise ribs (constant-z slices, tip-to-tip) ─────────────────────────
# For each rib z, sample the cross-section tip-to-tip.

N_SPAN_PTS = 13  # points per rib, per surface

# We use z values sampled across the bounding chord range
z_rib_vals = np.linspace(NOSE_Z, TE_MAX_Z, N_RIBS)

for z_rib in z_rib_vals:
    top_rib = []
    bot_rib = []

    # Scan x from -SPAN_HALF to +SPAN_HALF
    x_vals = np.linspace(-SPAN_HALF, SPAN_HALF, 2 * N_SPAN_PTS - 1)
    for x in x_vals:
        x_abs = abs(x)
        le_z  = planform_le_z(x_abs)
        te_z  = planform_te_z(x_abs)
        if z_rib < le_z or z_rib > te_z:
            # outside the planform at this x — skip
            top_rib.append(None)
            bot_rib.append(None)
            continue
        cf = chord_frac(z_rib, le_z, te_z)
        th = lens_thickness(cf)
        dy = tip_dihedral_y(x_abs)
        top_rib.append(add_pt(x,  th + dy, z_rib))
        bot_rib.append(add_pt(x, -th + dy, z_rib))

    # Connect consecutive valid points on each rib surface
    def connect_strip(pts):
        for k in range(len(pts) - 1):
            if pts[k] is not None and pts[k+1] is not None:
                lines.append([pts[k], pts[k+1]])

    connect_strip(top_rib)
    connect_strip(bot_rib)


# ── 3. Leading edge line ──────────────────────────────────────────────────────
# Trace the leading edge from left tip → nose → right tip on top surface.
le_x = np.linspace(-SPAN_HALF, SPAN_HALF, 33)
le_top_pts = []
for x in le_x:
    x_abs = abs(x)
    le_z = planform_le_z(x_abs)
    dy   = tip_dihedral_y(x_abs)
    le_top_pts.append(add_pt(x, dy, le_z))   # y≈0 at LE (thickness=0 at LE)

for k in range(len(le_top_pts) - 1):
    lines.append([le_top_pts[k], le_top_pts[k+1]])


# ── 4. Trailing edge line ─────────────────────────────────────────────────────
te_x = np.linspace(-SPAN_HALF, SPAN_HALF, 33)
te_top_pts = []
for x in te_x:
    x_abs = abs(x)
    te_z  = planform_te_z(x_abs)
    dy    = tip_dihedral_y(x_abs)
    te_top_pts.append(add_pt(x, dy, te_z))

for k in range(len(te_top_pts) - 1):
    lines.append([te_top_pts[k], te_top_pts[k+1]])


# ── 5. Top spine (centerline top surface, LE→TE) ─────────────────────────────
z_spine = np.linspace(NOSE_Z, TE_MAX_Z, 25)
spine_pts = []
for z in z_spine:
    le_z = planform_le_z(0.0)
    te_z = planform_te_z(0.0)
    if z < le_z or z > te_z:
        continue
    cf = chord_frac(z, le_z, te_z)
    th = lens_thickness(cf)
    spine_pts.append(add_pt(0.0, th, z))

for k in range(len(spine_pts) - 1):
    lines.append([spine_pts[k], spine_pts[k+1]])


# ── Normalize: center origin at mean z, keep y centered, x already symmetric ──
pos_arr = np.array(positions)
# The "reference length" is nose-to-tip (along z axis): NOSE_Z to TE_MAX_Z = 1.35
# We want nose-to-tail ≈ 1.0; scale so that range equals 1.0
z_range = pos_arr[:, 2].max() - pos_arr[:, 2].min()
if z_range > 0:
    scale = 1.0 / z_range
    pos_arr *= scale

# Center so nose is at roughly z = -0.5
z_mid = (pos_arr[:, 2].max() + pos_arr[:, 2].min()) / 2
pos_arr[:, 2] -= z_mid
# Center y on 0
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
