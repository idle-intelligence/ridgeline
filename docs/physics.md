# Ridgeline flight physics

## Overview

The model replaces the old "speed = f(throttle mode)" with a proper throttle-and-momentum
system. The plane has a scalar **forward speed** that builds and decays under engine thrust
and aerodynamic drag. Velocity is always directed along the body forward axis, so turning
naturally redirects momentum.

## State variables

| Variable | Type | Description |
|---|---|---|
| `orientation` | `Quat` | Body-to-world rotation |
| `position` | `Vec3` | World-space position |
| `throttle` | `f32 ∈ [0, 1]` | Engine throttle (gas pedal) |
| `speed` | `f32 ≥ 0` | Current forward speed (wu/s) |

## Throttle dynamics

The `thrust` input axis (+1 = accelerate, −1 = decelerate) raises or lowers the effective
throttle target over time. The actual throttle follows a first-order lag so it doesn't snap:

```
throttle_target = clamp(thrust_axis * throttle_ceiling, 0, 1)
throttle += (throttle_target - throttle) * THROTTLE_RATE * dt
```

`THROTTLE_RATE = 2.0 s⁻¹` — throttle reaches ~86% of its target in 1 second.

The **throttle ceiling** is normally 1.0. With Shift (boost), the ceiling stays 1.0 but
the terminal speed is higher (see below). FTL multiplies the effective thrust directly.

## Speed dynamics (thrust + drag)

At each step:

```
thrust_force = throttle * MAX_THRUST * boost_scale * ftl_scale
drag_force   = DRAG * speed
accel        = thrust_force - drag_force
speed        = max(0, speed + accel * dt)
```

At steady state (d speed/dt = 0): `speed_cruise = MAX_THRUST * boost_scale / DRAG`.

Constants and derived terminal speeds:

| Constant | Value | Notes |
|---|---|---|
| `MAX_THRUST` | 500 wu/s² | Thrust at full throttle |
| `DRAG` | 2.0 s⁻¹ | Linear drag coefficient |
| `THROTTLE_RATE` | 2.0 s⁻¹ | Throttle lag |
| `IDLE_THROTTLE` | 0.1 | Minimum throttle when no input |
| Terminal (cruise) | ~250 wu/s | `MAX_THRUST / DRAG` |
| Boost scale | 2.8× | Terminal → ~700 wu/s |
| FTL scale | 10× | Terminal → ~2500 wu/s |

When the player releases the throttle the effective input is `IDLE_THROTTLE` (not zero),
so the plane decays gently to a low idle speed (~50 wu/s) rather than stopping abruptly.

## Motion integration

Velocity is always along the body forward axis (-Z in body space), so heading changes
redirect speed continuously:

```
body_velocity = Vec3(0, 0, -speed)
position += (orientation * body_velocity) * dt
```

Rotation is integrated in body space each step (yaw → pitch → roll) and normalised.

## Boost and FTL easing

Boost and FTL are passed as inputs each frame. Their effect on thrust is applied
multiplicatively to `MAX_THRUST`. Because speed builds via the thrust/drag equation
(not by setting speed directly), acceleration and deceleration always ease in and out
naturally with the drag time-constant τ = 1 / DRAG = 0.5 s.
