# Overnight plan — 2026-05-27

Autonomous session. Lead works the task list **one at a time** via background sub-agents,
verifying + committing each before the next, idling ~15 min between tasks (background `sleep`)
to pace usage. `main` must stay flyable at every commit. Risky WebGPU work stays a prototype
(separate files / behind a flag) until proven equal-or-better, then switch.

## Loop procedure (re-read this each wake; context may be summarized)
1. `git log --oneline -5` + `TaskList` to see where we are.
2. If a sub-agent just finished: verify (build/test/screenshot), confirm its commit, mark task done.
3. Idle ~15 min: run `sleep 900` in the background (it re-invokes on exit).
4. On wake: pick the next pending task (lowest id), launch ONE background sub-agent with the
   no-convergence guardrail + "commit only your files, no `git add -A`".
5. Repeat until tasks exhausted. Keep `main` working.

## Context (current state)
- Earth globe of latitude rings; global ETOPO 8192×4096 (~5 km/cell), LFS.
- Render: WebGL2, per-frame WASM geometry (rings + occluder), per-distance LOD + sub-ring
  interpolation (6/4/2 near), horizon + sight cull, strength/elev brightness, starfield.
- Physics: arcade fly-by-nose (atmo) / Newtonian (space), hard V_CAP=10000 wu/s, capture/
  planetary assist, altitude-coupled VE (VE_NEAR 2.75 → VE_FAR 8), modes SPACE/PLANETARY/ATMO.
- Known-good: low-altitude density over land (img 27). Known-bad: tears at ~1000 km & poles,
  occlusion bleed, ~32 fps near surface + advancing LOD "shadow", flight feel unphysical.

## Ordered task list
1. Fix rendering "missing parts" (torn wedges/seams at ~1000 km & near poles) — cull/interp edge cases.
2. Fix "lines through lines" occlusion bleed (occluder/depth).
3. Research: arcade flight-game physics & flight modes (drag, orbit, mode transitions, AGL
   terrain-following autopilot, banking) → docs/reports/.
4. Physics: flight-mode system ATMO / ORBIT / INTERPLANETARY with per-mode speed caps; more
   atmo drag (slower, harder to leave); even slower atmo min. (informed by #3)
5. Physics: AGL terrain-following altitude hold (maintain ~target above GROUND via look-ahead
   terrain sampling) + HUD altitude shown relative to ground. (informed by #3)
6. Research: performance approaches for line-heavy web 3D (draw-call batching, persistent/
   mapped buffers, transform feedback, GPU geometry, WebGPU) → docs/reports/.
7. Perf (WebGL2, safe win): batch the ~752 line draws into few; cut per-frame upload; reduce/
   hide the advancing LOD "shadow". (informed by #6)
8. Research: WebGPU for games — browser support 2026, perf vs WebGL2, compute-driven geometry,
   line rendering, migration path → docs/reports/.
9. Research: wgpu (Rust) → WASM/WebGPU feasibility vs JS+WebGPU for our core → docs/reports/.
10. WebGPU/wgpu: prototype a GPU-driven renderer (compute geometry / minimal upload), keep
    WebGL2 as fallback, verify perf + quality before any switch. (big; informed by #8/#9)

## Reorder (2026-05-27, after #40/#41)
#40 (tears) + #41 (occlusion) DONE on main. #41's per-ring fills ~doubled near/mid geometry
→ gen ~77-80 ms (≈12 fps near surface). PERF is now the priority → run #45 (perf research)
then #46 (perf impl: cut fill/sub-ring vert count, batch draws) BEFORE the physics tasks.
New order: 45 → 46 → 42 → 43 → 44 → 47 → 48 → 49.

## Hard geometry budget (2026-05-28)
Trace (docs/reports/trace-20260528.md) proved `eng.step()` geometry gen was ~99% of frame
time and ballooned 42→208 ms as the camera CLIMBS (more hemisphere visible; per-distance LOD
coarsened with distance but never capped TOTAL work). Fix in `core/src/geometry.rs`: a
power-of-two GLOBAL `lod_boost` multiplied onto ALL per-distance strides, chosen from the
QUANTIZED camera altitude (`lod_boost_for_altitude`: <1500 wu →1, <6000 →2, else →4), plus a
`subring_cap` that forces sub-ring interpolation off above 1500 wu. Index-anchored & quantized
→ no swimming/crawl. Near surface (boost 1) detail is unchanged; high altitude is coarser
(fine — you're far). Measured gen-ms / total verts (fast Mac, tangential framing) BEFORE→AFTER:
low ~500: 10.1 ms / 79k → 10.1 ms / 79k (unchanged, preserved); mid ~5000: 7.9 / 108k →
2.0 / 27k; orbit ~10000: 8.4 / 110k → 0.6 / 7k; far ~18000: 8.7 / 113k → 0.6 / 7k. The climb
no longer balloons — every above-surface frame is now BOUNDED below the near-surface cost, so
the trace's 208 ms peak (≈110k verts) is now ~7k verts. Cost is now ~constant & independent of
data resolution. clippy clean, `cargo test --lib` 38/38, headless "All checks passed",
motion-stable (no swimming).

## Notes / deferred
- Higher-res re-bake (2.5 km ≈ 384 MB / native 1.85 km ≈ 670 MB) — offered, user to decide.
- Atlas/terrain collision — undecided.
- HUD is Earth-centric (speed km/h, lat/lon) — planet-agnostic later (see memory).
