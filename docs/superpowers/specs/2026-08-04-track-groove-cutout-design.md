# Cutting the track out of the terrain on a negative offset

**Date:** 2026-08-04
**Status:** approved

## Problem

A negative track offset currently sinks the track band below the terrain surface,
where the solid terrain hides it completely. Nothing is cut; the band is simply
invisible. The `engraved` profile has the same defect for the same reason.

The intent behind a negative offset is to engrave the route into the model. That
requires removing material from the terrain, which nothing in the codebase does.

## Constraint that shapes the design

The terrain is a heightfield on a 16/32/64 sample grid. For a 10 km bounding box
at resolution 32 one cell is ~320 m wide, while the default track band is 20 m —
the groove is roughly 16x finer than the mesh it has to be cut into.

Three ways out were considered:

- **Refine the mesh and emboss the groove into the heightfield.** No dependency,
  robust against the self-intersecting bands that hairpins produce, one watertight
  body. The groove cannot be narrower than about two refined cells.
- **CSG subtraction** (`three-bvh-csg`). Exact width and vertical walls, but two
  new dependencies, and CSG needs non-self-intersecting input — precisely what the
  miter clamp violates at switchbacks, which are routine in mountain tracks.
- **Clip the corridor out of the affected cells.** Exact and dependency-free, but
  needs per-cell polygon clipping, Earcut triangulation and crack-free boundary
  points. By far the most code and risk.

**Refinement + embossing was chosen.** Beyond the effort argument: on a 200 mm
print of a 10 km area the exact 20 m groove the other two deliver is 0.4 mm wide —
the width of an FDM nozzle, effectively invisible. The coarser groove is the one
worth printing.

## Semantics

Cut mode is active when `settings.track.offset < 0`. Then:

| Quantity | Value |
| --- | --- |
| Groove depth | `abs(offset)` scene units below the surface, constant, so the floor follows the slope |
| Corridor half-width | `settings.track.width`, floored at the refined node spacing |
| Track mesh | not built — the groove is an empty channel and the model stays a single body |
| Waypoints | keep draping onto the *carved* surface, so they sit in the groove where the track runs |

The `engraved` track profile is removed from `TrackProfile`, the control panel and
`trackBuilder`. Engraving runs through the negative offset alone; two mechanisms
doing the same thing is what caused the confusion. Existing state falls back to
`square`.

## Components

### `src/utils/trackCorridor.ts` (new)

Describes the corridor independently of any geometry.

```ts
export interface Corridor {
  /** Half-width actually used, after the mesh-resolution floor. */
  readonly halfWidth: number;
  /** Width of the taper from floor to untouched surface. */
  readonly wallWidth: number;
  /** 1 inside the corridor, 0 outside, ramped across the wall. */
  sink(x: number, z: number): number;
}

export function buildCorridor(
  tracks: GPXTrack[],
  cs: CoordSystem,
  halfWidth: number,
  wallWidth: number,
): Corridor | null;
```

`sink` is backed by a uniform spatial hash of the centre-line segments so a lookup
stays O(1) — it is called once per refined terrain vertex, up to ~66k times.

The centre-line cleaning currently living in `trackBuilder` moves here, and
`trackBuilder` imports it. Both features need the same notion of "where the track
runs", and having two would let them drift.

Station densification stays in `trackBuilder`. It exists to land points on terrain
triangle edges and therefore depends on `TerrainSurface` — which does not exist yet
at the moment the corridor is needed, since the corridor is an *input* to building
that surface. Distance to a polyline needs no densification anyway.

### `src/utils/terrainBuilder.ts`

**Refinement plan**, exported because both the mesh builder and the UI need the
same numbers:

```ts
export interface RefinementPlan {
  /** Grid size of the refined top surface. */
  gridSize: number;
  /** Largest node spacing in scene units. */
  spacing: number;
  /** Corridor half-width after the resolution floor. */
  grooveHalfWidth: number;
}

export function planRefinement(
  grid: ElevationGrid,
  settings: TerrainSettings,
  requestedHalfWidth: number,
): RefinementPlan;
```

with

- `span = 2 * max(halfWidthM, halfDepthM)`
- `gridSize = clamp(ceil(span / requestedHalfWidth) + 1, effectiveN, 257)`
- `spacing = span / (gridSize - 1)`
- `grooveHalfWidth = max(requestedHalfWidth, spacing)`

A single `gridSize` for both axes matches how the builder already treats
non-square bounding boxes. The 257 cap puts the refined top at ~66k vertices and
~132k triangles, which keeps a rebuild interactive.

**Build order.** The coarse pass computes the styled node arrays as today, but in
cut mode it produces *sampling data only* — no geometry is emitted from it. A
`sampleY` sampler is created over those coarse nodes, the refined M×M top surface
is sampled through it, and the emitted geometry is built from the refined nodes.
Refined nodes therefore lie exactly on the already-rendered coarse surface, so
`original`, `lowpoly` and `layers` look unchanged — there are only more triangles.
The final `TerrainSurface` returned to callers is built from the refined **and
carved** nodes, so anything draping on the terrain sees the groove.

Refinement runs only in cut mode. Without a cut the current path is untouched.

**Embossing.** Per refined vertex, `y -= depth * corridor.sink(x, z)`. The wall
taper is one refined cell wide — the steepest the mesh can express.

**Colour.** Taken from the *original* elevation, then scaled by
`1 - 0.45 * sink(x, z)` inside the corridor. Deriving it from the lowered elevation
would change the hue of the groove; the shading makes the channel read as a channel
on screen, and ramping it with `sink` keeps the wall from showing a hard colour
seam.

**Fan bottom.** The underside is already a flat plate built from N² points. It
becomes a fan from one centre vertex at `(0, baseY, 0)` over the perimeter ring:
identical shape, half the triangles, and the saving is what makes the refinement
affordable. All three base shapes are convex about the origin, so a fan is valid.
This applies in both modes rather than adding a second code path.

### `src/utils/trackBuilder.ts`

`buildAllTrackMeshes` returns `[]` when `offset < 0`. The `engraved` branches go
away with the profile.

### UI

- `TrackProfile` loses `'engraved'`; the control panel select loses the option.
- The width row shows the effective groove width whenever the resolution floor
  raises it. Without this, setting 10 and getting 39 has no visible explanation.
- `App` owns `grid` and `settings`, so it calls `planRefinement` and passes the
  effective width to `ControlPanel` as a prop. No callback plumbing through
  `Viewer3D`.

## Data flow

`buildCoordSystem` runs inside `buildTerrainMesh`, but the corridor needs the
coordinate system — so `Viewer3D` cannot build the corridor first. `buildTerrainMesh`
instead takes the intent and derives the rest itself:

```ts
buildTerrainMesh(
  grid: ElevationGrid,
  settings: TerrainSettings,
  cut?: { tracks: GPXTrack[]; halfWidth: number; depth: number },
): TerrainBuildResult
```

This keeps one entry point and removes any chance of two coordinate systems
diverging.

## Error handling and edge cases

| Case | Behaviour |
| --- | --- |
| `offset >= 0` | No refinement, no carving — today's path exactly |
| No tracks | No corridor, no refinement |
| Track shorter than two points | Contributes nothing to the corridor |
| `gridSize` clamped by the 257 cap | Groove widens; the UI reports the effective width |
| Requested half-width below the spacing | Same — floored, and reported |
| Overlapping or self-crossing tracks | Corridor is the union; `sink` takes the maximum |

## Testing

Two scripts alongside the existing drape script, sharing its ray-casting approach:

- `scripts/verify-corridor.ts` (`verify:corridor`) — pure geometry checks on
  `Corridor.sink`, which needs no mesh.
- `scripts/verify-terrain-solid.ts` (`verify:terrain`) — the mesh-level checks
  below. Named for the solid rather than the groove because the manifold check
  applies with and without a cut.

1. **Depth.** Down the corridor centre, the carved surface sits `abs(offset)`
   below the uncarved surface, within 1e-3 scene units.
2. **Containment.** Beyond `grooveHalfWidth + spacing` the carved surface matches
   the uncarved one within 1e-3. Both are ray-cast against meshes built from the
   same refined grid, so the comparison isolates the carving rather than the
   refinement.
3. **No band.** `buildAllTrackMeshes` returns `[]` when `offset < 0`.
4. **Manifold.** Every edge of the terrain geometry belongs to exactly two
   triangles. This is the printability condition and the thing embossing most
   often breaks. If the *uncarved* baseline already fails it, that is fixed as part
   of this work — it is the same code path, and printing is the stated purpose.

Run across all three terrain styles, both fan-bottom paths, and the square, hex
and round base shapes.

## Out of scope

- Exact-width grooves with vertical walls (the clipping approach). The interface
  boundary — `Corridor` plus `planRefinement` — is narrow enough that a clipper
  could replace the embossing later without touching the rest.
- A separate depth control. Depth is `abs(offset)`.
- Coloured inlays sitting in the groove.
