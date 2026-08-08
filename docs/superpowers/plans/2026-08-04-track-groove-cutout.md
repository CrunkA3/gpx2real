# Track Groove Cut-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A negative track offset engraves the route into the terrain as a real
groove in a single watertight body, instead of hiding the track band inside the
solid.

**Architecture:** When cutting, the terrain top surface is re-tessellated finer by
sampling the *already rendered* coarse surface, then the nodes inside the track
corridor are lowered. The corridor is a standalone module with a spatial hash so
the per-vertex query stays O(1). The underside becomes a centre fan, which is what
makes the finer top affordable.

**Tech Stack:** TypeScript 5.4, React 18, three 0.167, Vite 6. Verification is
plain Node scripts — there is no test runner.

Spec: `docs/superpowers/specs/2026-08-04-track-groove-cutout-design.md`

## Global Constraints

- **No new runtime dependencies.** Everything uses `three` and the existing code.
- **All track and groove sizes are scene units.** Never route them through
  `geoToLocal`'s elevation argument — that multiplies by `verticalScale` on Y only
  and is the bug class this codebase just finished fixing.
- `MAX_REFINED_GRID = 257`.
- Groove shading factor: colour is scaled by `1 - 0.45 * sink`.
- Groove depth is `abs(settings.track.offset)`; there is no separate depth control.
- Verification scripts run as `node --import ./scripts/register-ts.mjs <script>`,
  wired through `package.json` scripts.
- **`tsconfig.json` has `include: ["src"]`, so `scripts/` is NOT typechecked.**
  Type errors there surface only at runtime. Every task must actually *run* its
  script, not just typecheck.
- After every task: `npm run typecheck` and `npm run verify:track` must pass.
  `verify:track` is the regression guard for the draping work already in the tree.
- Node is not on `PATH` in this environment. Prefix commands with
  `$env:PATH = "C:\Program Files\nodejs;$env:PATH";` in PowerShell.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/utils/trackCorridor.ts` (new) | Where the track runs, as a scene-space distance field. Owns centre-line cleaning. |
| `src/utils/terrainBuilder.ts` (modify) | Refinement plan, refined top surface, embossing, fan underside. |
| `src/utils/trackBuilder.ts` (modify) | Imports the centre line; drops `engraved`; produces nothing when cutting. |
| `src/types.ts` (modify) | `TrackProfile` loses `'engraved'`. |
| `src/components/ControlPanel.tsx` (modify) | Drops the option; reports effective groove width and depth. |
| `src/components/Viewer3D.tsx` (modify) | Passes the cut intent into `buildTerrainMesh`. |
| `src/App.tsx` (modify) | Computes the effective groove width for the panel. |
| `scripts/verify-corridor.ts` (new) | Distance-field checks; no mesh needed. |
| `scripts/verify-terrain-solid.ts` (new) | Manifold, underside coverage, refinement fidelity, groove depth. |

---

### Task 1: Track corridor as a distance field

**Files:**
- Create: `src/utils/trackCorridor.ts`
- Modify: `src/utils/trackBuilder.ts` (lines 45-63 — remove `Vec2` and `cleanCenterLine`, import them instead)
- Create: `scripts/verify-corridor.ts`
- Modify: `package.json` (add the `verify:corridor` script)

**Interfaces:**
- Consumes: `buildCoordSystem`, `geoToLocal`, `CoordSystem` from `./coordTransform`; `GPXTrack` from `../types`.
- Produces:
  - `interface Vec2 { x: number; z: number }`
  - `function cleanCenterLine(track: GPXTrack, cs: CoordSystem): Vec2[]`
  - `interface Corridor { readonly halfWidth: number; readonly wallWidth: number; sink(x: number, z: number): number }`
  - `function buildCorridor(tracks: GPXTrack[], cs: CoordSystem, halfWidth: number, wallWidth: number): Corridor | null`

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-corridor.ts`:

```ts
/**
 * Checks Corridor.sink — the distance field the groove is embossed from.
 * Needs no mesh, so it runs before any terrain work.
 */
import type { BoundingBox, GPXTrack } from '../src/types.ts';
import { buildCoordSystem, geoToLocal } from '../src/utils/coordTransform.ts';
import { buildCorridor } from '../src/utils/trackCorridor.ts';

const BBOX: BoundingBox = { minLat: 47.2, maxLat: 47.25, minLon: 11.3, maxLon: 11.36 };
const cs = buildCoordSystem(
  (BBOX.minLat + BBOX.maxLat) / 2,
  (BBOX.minLon + BBOX.maxLon) / 2,
  0,
  1,
  BBOX,
  'square',
);

const HALF = 12;
const WALL = 5;
const LAT = 47.225;

let failures = 0;

function check(label: string, actual: number, expected: number, tol = 1e-6): void {
  if (Math.abs(actual - expected) > tol) {
    console.error(`  FAIL  ${label}: got ${actual}, expected ${expected}`);
    failures++;
  } else {
    console.log(`  ok    ${label} = ${actual.toFixed(4)}`);
  }
}

/** Constant latitude → a straight line at constant z in scene space. */
function eastWestTrack(lat: number): GPXTrack {
  const points = [];
  for (let i = 0; i <= 10; i++) {
    points.push({ lat, lon: BBOX.minLon + 0.01 + (i / 10) * 0.04, ele: 0 });
  }
  return { name: `ew@${lat}`, points };
}

console.log('Corridor distance field\n');

const corridor = buildCorridor([eastWestTrack(LAT)], cs, HALF, WALL);
if (!corridor) {
  console.error('  FAIL  corridor was null for a real track');
  process.exit(1);
}

const [cx, , cz] = geoToLocal(cs, LAT, BBOX.minLon + 0.03, 0);

check('on the centre line', corridor.sink(cx, cz), 1);
check('just inside the floor edge', corridor.sink(cx, cz + HALF - 1e-3), 1);
check('mid-wall', corridor.sink(cx, cz + HALF + WALL / 2), 0.5, 1e-9);
check('at the wall top', corridor.sink(cx, cz + HALF + WALL), 0);
check('well outside', corridor.sink(cx, cz + 500), 0);
check('mirrored mid-wall', corridor.sink(cx, cz - HALF - WALL / 2), 0.5, 1e-9);

// The field is the union over all tracks.
const two = buildCorridor([eastWestTrack(LAT), eastWestTrack(LAT + 0.01)], cs, HALF, WALL);
if (!two) {
  console.error('  FAIL  corridor was null for two tracks');
  process.exit(1);
}
const [, , cz2] = geoToLocal(cs, LAT + 0.01, BBOX.minLon + 0.03, 0);
check('second track floor', two.sink(cx, cz2), 1);
check('first track still floor', two.sink(cx, cz), 1);

// Degenerate inputs produce no corridor at all, rather than an empty one.
if (buildCorridor([], cs, HALF, WALL) !== null) {
  console.error('  FAIL  no tracks should give null');
  failures++;
} else {
  console.log('  ok    no tracks → null');
}

const onePoint: GPXTrack = { name: 'p', points: [{ lat: LAT, lon: BBOX.minLon + 0.02, ele: 0 }] };
if (buildCorridor([onePoint], cs, HALF, WALL) !== null) {
  console.error('  FAIL  single-point track should give null');
  failures++;
} else {
  console.log('  ok    single-point track → null');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
```

Add to `package.json` scripts, after `verify:track`:

```json
    "verify:corridor": "node --import ./scripts/register-ts.mjs scripts/verify-corridor.ts"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:corridor`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/utils/trackCorridor.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/trackCorridor.ts`:

```ts
import type { GPXTrack } from '../types';
import { geoToLocal, type CoordSystem } from './coordTransform';

/** A point on the horizontal plane of the scene. */
export interface Vec2 {
  x: number;
  z: number;
}

/** GPS points closer than this to their predecessor are jitter, not detail. */
const MIN_POINT_SPACING = 0.75;

/** Track points as scene XZ, with GPS jitter removed. */
export function cleanCenterLine(track: GPXTrack, cs: CoordSystem): Vec2[] {
  const out: Vec2[] = [];
  for (const p of track.points) {
    const [x, , z] = geoToLocal(cs, p.lat, p.lon, 0);
    const prev = out[out.length - 1];
    if (prev && Math.hypot(x - prev.x, z - prev.z) < MIN_POINT_SPACING) continue;
    out.push({ x, z });
  }
  return out;
}

/**
 * Where the tracks run, as a scene-space field the terrain builder can emboss.
 *
 * Deliberately independent of any mesh: the corridor is an *input* to building
 * the terrain surface, so it cannot depend on one.
 */
export interface Corridor {
  /** Half-width of the flat floor. */
  readonly halfWidth: number;
  /** Width of the ramp from floor level back up to untouched terrain. */
  readonly wallWidth: number;
  /** 1 on the floor, 0 outside, linear across the wall. */
  sink(x: number, z: number): number;
}

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

function distanceSqToSegment(px: number, pz: number, s: Segment): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const lenSq = dx * dx + dz * dz;
  const raw = lenSq > 0 ? ((px - s.ax) * dx + (pz - s.az) * dz) / lenSq : 0;
  const t = Math.max(0, Math.min(1, raw));
  const ex = s.ax + dx * t - px;
  const ez = s.az + dz * t - pz;
  return ex * ex + ez * ez;
}

export function buildCorridor(
  tracks: GPXTrack[],
  cs: CoordSystem,
  halfWidth: number,
  wallWidth: number,
): Corridor | null {
  const reach = halfWidth + wallWidth;
  // One bucket per query radius: a segment within `reach` of a point is then
  // always in that point's 3x3 bucket neighbourhood.
  const bucketSize = Math.max(reach, 1e-3);
  const buckets = new Map<string, Segment[]>();
  let segmentCount = 0;

  const add = (seg: Segment) => {
    const minC = Math.floor(Math.min(seg.ax, seg.bx) / bucketSize);
    const maxC = Math.floor(Math.max(seg.ax, seg.bx) / bucketSize);
    const minR = Math.floor(Math.min(seg.az, seg.bz) / bucketSize);
    const maxR = Math.floor(Math.max(seg.az, seg.bz) / bucketSize);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const key = `${c},${r}`;
        const list = buckets.get(key);
        if (list) list.push(seg);
        else buckets.set(key, [seg]);
      }
    }
    segmentCount++;
  };

  for (const track of tracks) {
    const line = cleanCenterLine(track, cs);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      // Split long pieces, so no bucket holds a segment whose bounding box
      // reaches far past the segment itself.
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / bucketSize));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        add({
          ax: a.x + (b.x - a.x) * t0,
          az: a.z + (b.z - a.z) * t0,
          bx: a.x + (b.x - a.x) * t1,
          bz: a.z + (b.z - a.z) * t1,
        });
      }
    }
  }

  if (segmentCount === 0) return null;

  return {
    halfWidth,
    wallWidth,

    sink(x, z) {
      const c0 = Math.floor(x / bucketSize);
      const r0 = Math.floor(z / bucketSize);
      let bestSq = Infinity;
      for (let r = r0 - 1; r <= r0 + 1; r++) {
        for (let c = c0 - 1; c <= c0 + 1; c++) {
          const list = buckets.get(`${c},${r}`);
          if (!list) continue;
          for (const seg of list) {
            const d2 = distanceSqToSegment(x, z, seg);
            if (d2 < bestSq) bestSq = d2;
          }
        }
      }
      if (bestSq === Infinity) return 0;

      const d = Math.sqrt(bestSq);
      if (d <= halfWidth) return 1;
      if (d >= reach) return 0;
      return 1 - (d - halfWidth) / wallWidth;
    },
  };
}
```

- [ ] **Step 4: Point trackBuilder at the shared centre line**

In `src/utils/trackBuilder.ts`, delete the `MIN_POINT_SPACING` constant, the
`Vec2` interface and the `cleanCenterLine` function (the block currently spanning
the `/** GPS points closer than this... */` comment through the end of
`cleanCenterLine`), and change the imports at the top of the file to:

```ts
import * as THREE from 'three';
import type { GPXTrack, TrackProfile } from '../types';
import type { CoordSystem } from './coordTransform';
import { cleanCenterLine, type Vec2 } from './trackCorridor';
import type { TerrainSurface } from './terrainBuilder';
```

`geoToLocal` is no longer used in `trackBuilder` — remove its import. Keep the
`// ─── Centre line ───` section header above `buildStations`.

- [ ] **Step 5: Run the tests**

Run: `npm run verify:corridor`
Expected: PASS — `all checks passed`

Run: `npm run typecheck`
Expected: no output (clean)

Run: `npm run verify:track`
Expected: PASS — `all checks passed`, unchanged from before this task

- [ ] **Step 6: Commit**

```bash
git add src/utils/trackCorridor.ts src/utils/trackBuilder.ts scripts/verify-corridor.ts package.json
git commit -m "Add track corridor distance field"
```

---

### Task 2: Fan underside

Replaces the N² underside grid with a centre fan. Identical shape, and the saved
triangles are what pays for the finer top surface in Task 3.

**Files:**
- Modify: `src/utils/terrainBuilder.ts` (vertex counts around line 286, the bottom
  vertex writes in the node loop, the bottom-face loop at 359-368, and the wall
  loop at 370-383)
- Create: `scripts/verify-terrain-solid.ts`
- Modify: `package.json` (add `verify:terrain`)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports. Behavioural contract — the terrain geometry has
  `4 * (N - 1)` underside triangles instead of `2 * (N - 1)²`, stays manifold, and
  still covers the whole footprint at `baseY`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-terrain-solid.ts`:

```ts
/**
 * Mesh-level checks on the terrain solid: it must be manifold (the printability
 * condition), its underside must cover the whole footprint, and its top must
 * agree with the TerrainSurface sampler that everything else drapes against.
 */
import * as THREE from 'three';
import type { BoundingBox, ElevationGrid, TerrainSettings } from '../src/types.ts';
import { buildTerrainMesh } from '../src/utils/terrainBuilder.ts';

const BBOX: BoundingBox = { minLat: 47.2, maxLat: 47.25, minLon: 11.3, maxLon: 11.36 };
const GRID_SIZE = 16;

let failures = 0;

function fail(label: string, detail: string): void {
  failures++;
  console.error(`  FAIL  ${label}\n        ${detail}`);
}

function makeGrid(): ElevationGrid {
  const values: number[][] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    const r: number[] = [];
    for (let col = 0; col < GRID_SIZE; col++) {
      r.push(
        1400 +
          600 * Math.sin(col * 0.9) * Math.cos(row * 0.7) +
          300 * Math.sin((row + col) * 1.3),
      );
    }
    values.push(r);
  }
  const flat = values.flat();
  return {
    values,
    gridSize: GRID_SIZE,
    bbox: BBOX,
    minEle: Math.min(...flat),
    maxEle: Math.max(...flat),
  };
}

function settingsFor(style: TerrainSettings['style'], baseShape: TerrainSettings['baseShape']): TerrainSettings {
  return {
    style,
    resolution: GRID_SIZE as TerrainSettings['resolution'],
    layerCount: 8,
    verticalScale: 1.5,
    wireframe: false,
    baseShape,
    baseDepth: 120,
  };
}

/** Every edge must belong to exactly two triangles. */
function checkManifold(label: string, mesh: THREE.Mesh): void {
  const idx = mesh.geometry.getIndex();
  if (!idx) return fail(label, 'geometry has no index');
  const vertexCount = mesh.geometry.getAttribute('position').count;

  const counts = new Map<number, number>();
  const bump = (a: number, b: number) => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    const b = idx.getX(i + 1);
    const c = idx.getX(i + 2);
    bump(a, b);
    bump(b, c);
    bump(c, a);
  }

  let bad = 0;
  for (const n of counts.values()) if (n !== 2) bad++;
  if (bad > 0) fail(label, `${bad} of ${counts.size} edges are not shared by exactly two triangles`);
  else console.log(`  ok    ${label} manifold (${counts.size} edges, ${idx.count / 3} triangles)`);
}

const HIGH = 1e6;
const raycaster = new THREE.Raycaster();

function castDown(mesh: THREE.Mesh, x: number, z: number): number | null {
  raycaster.set(new THREE.Vector3(x, HIGH, z), new THREE.Vector3(0, -1, 0));
  return raycaster.intersectObject(mesh, false)[0]?.point.y ?? null;
}

function castUp(mesh: THREE.Mesh, x: number, z: number): number | null {
  raycaster.set(new THREE.Vector3(x, -HIGH, z), new THREE.Vector3(0, 1, 0));
  return raycaster.intersectObject(mesh, false)[0]?.point.y ?? null;
}

console.log('Terrain solid\n');

for (const style of ['original', 'lowpoly', 'layers'] as const) {
  for (const baseShape of ['square', 'hex', 'round'] as const) {
    const label = `${style} / ${baseShape}`;
    const grid = makeGrid();
    const settings = settingsFor(style, baseShape);
    const { mesh, surface, coordSystem: cs } = buildTerrainMesh(grid, settings);
    mesh.updateMatrixWorld(true);

    checkManifold(label, mesh);

    // ── Underside budget: a fan over the perimeter, not a second grid ──
    const n = style === 'lowpoly' ? Math.max(8, Math.floor(GRID_SIZE / 4)) : GRID_SIZE;
    const topTriangles = (n - 1) * (n - 1) * 2;
    const ringLength = 4 * n - 4;
    const budget = topTriangles + ringLength + ringLength * 2;
    const actual = mesh.geometry.getIndex()!.count / 3;
    if (actual > budget) fail(label, `${actual} triangles, budget ${budget} — underside is not a fan`);
    else console.log(`  ok    ${label} triangle budget (${actual} <= ${budget})`);

    // ── Underside coverage and top/sampler agreement ──
    const baseY = -Math.max(settings.baseDepth, 1) * settings.verticalScale;
    let worstBottom = 0;
    let worstTop = 0;
    for (let i = 1; i < 12; i++) {
      for (let j = 1; j < 12; j++) {
        // Stay well inside the footprint so hex/round corners never miss.
        const x = (i / 12 - 0.5) * 2 * cs.halfWidthM * 0.5;
        const z = (j / 12 - 0.5) * 2 * cs.halfDepthM * 0.5;
        const under = castUp(mesh, x, z);
        const top = castDown(mesh, x, z);
        if (under === null || top === null) {
          fail(label, `ray missed the solid at (${x.toFixed(1)}, ${z.toFixed(1)})`);
          i = j = 99;
          break;
        }
        worstBottom = Math.max(worstBottom, Math.abs(under - baseY));
        worstTop = Math.max(worstTop, Math.abs(top - surface.sampleY(x, z)));
      }
    }
    if (worstBottom > 1e-3) fail(label, `underside off baseY by ${worstBottom.toFixed(4)}`);
    else console.log(`  ok    ${label} underside flat at baseY (<=${worstBottom.toExponential(1)})`);
    if (worstTop > 1e-3) fail(label, `top disagrees with sampler by ${worstTop.toFixed(4)}`);
    else console.log(`  ok    ${label} top matches sampler (<=${worstTop.toExponential(1)})`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
```

Add to `package.json` scripts:

```json
    "verify:terrain": "node --import ./scripts/register-ts.mjs scripts/verify-terrain-solid.ts"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:terrain`
Expected: FAIL on every combination with "underside is not a fan" — the current
mesh has `2*(n-1)²` bottom triangles, far over budget. The manifold, coverage and
sampler checks should already pass; they are guards, not the new behaviour.

- [ ] **Step 3: Replace the vertex counts and perimeter**

In `src/utils/terrainBuilder.ts`, move the perimeter computation *above* the
vertex allocation and replace the count block. Delete the existing perimeter block
at lines 370-376 and replace lines 285-289 with:

```ts
  const N = effectiveN;
  const topVertexCount = N * N;

  // ── Perimeter ring, walked clockwise seen from above ──
  const perimeter: number[] = [];
  for (let col = 0; col < N; col++) perimeter.push(col);
  for (let row = 1; row < N; row++) perimeter.push(row * N + (N - 1));
  for (let col = N - 2; col >= 0; col--) perimeter.push((N - 1) * N + col);
  for (let row = N - 2; row > 0; row--) perimeter.push(row * N);

  const bottomRingStart = topVertexCount;
  const bottomCenter = bottomRingStart + perimeter.length;
  const totalVertexCount = bottomCenter + 1;

  const positions = new Float32Array(totalVertexCount * 3);
  const colors = new Float32Array(totalVertexCount * 3);
```

- [ ] **Step 4: Stop writing a bottom vertex per node**

Inside the `for (let row...) for (let col...)` node loop, delete these lines:

```ts
      const bottomIdx = idx + topVertexCount;
      const bottomPos = bottomIdx * 3;
```

```ts
      positions[bottomPos] = x;
      positions[bottomPos + 1] = baseY;
      positions[bottomPos + 2] = z;
```

```ts
      colors[bottomPos] = c.r * 0.45;
      colors[bottomPos + 1] = c.g * 0.45;
      colors[bottomPos + 2] = c.b * 0.45;
```

- [ ] **Step 5: Emit the fan underside**

Immediately after the node loop closes (before `const indexValues: number[] = [];`),
insert:

```ts
  // ── Underside: one fan from the centre over the perimeter ring ──
  // All three base shapes are convex about the origin, so a fan is valid, and it
  // costs 4N triangles where a second full grid would cost 2N².
  for (let i = 0; i < perimeter.length; i++) {
    const top = perimeter[i];
    const idx = bottomRingStart + i;
    positions[idx * 3] = positions[top * 3];
    positions[idx * 3 + 1] = baseY;
    positions[idx * 3 + 2] = positions[top * 3 + 2];
    colors[idx * 3] = colors[top * 3] * 0.45;
    colors[idx * 3 + 1] = colors[top * 3 + 1] * 0.45;
    colors[idx * 3 + 2] = colors[top * 3 + 2] * 0.45;
  }
  positions[bottomCenter * 3] = 0;
  positions[bottomCenter * 3 + 1] = baseY;
  positions[bottomCenter * 3 + 2] = 0;
  colors[bottomCenter * 3] = 0.2;
  colors[bottomCenter * 3 + 1] = 0.2;
  colors[bottomCenter * 3 + 2] = 0.2;
```

- [ ] **Step 6: Replace the bottom faces and rewire the walls**

Delete the whole `// ── Bottom faces (reversed winding) ──` loop and replace the
side-wall loop body. The two blocks together become:

```ts
  // ── Bottom faces ──
  // (centre, ring[i], ring[i+1]) with the ring clockwise from above gives -Y.
  for (let i = 0; i < perimeter.length; i++) {
    const a = bottomRingStart + i;
    const b = bottomRingStart + ((i + 1) % perimeter.length);
    indexValues.push(bottomCenter, a, b);
  }

  // ── Side walls along the outer ring ──
  for (let i = 0; i < perimeter.length; i++) {
    const aTop = perimeter[i];
    const bTop = perimeter[(i + 1) % perimeter.length];
    const aBottom = bottomRingStart + i;
    const bBottom = bottomRingStart + ((i + 1) % perimeter.length);
    indexValues.push(aTop, bTop, aBottom, bTop, bBottom, aBottom);
  }
```

- [ ] **Step 7: Run the tests**

Run: `npm run verify:terrain`
Expected: PASS — `all checks passed`, all nine combinations green

Run: `npm run typecheck`
Expected: no output

Run: `npm run verify:track` and `npm run verify:corridor`
Expected: both PASS

- [ ] **Step 8: Commit**

```bash
git add src/utils/terrainBuilder.ts scripts/verify-terrain-solid.ts package.json
git commit -m "Build the terrain underside as a centre fan"
```

---

### Task 3: Refinement plan and refined top surface

Adds the `cut` parameter. It refines the top surface but does **not** carve yet —
so the observable contract is that refining changes nothing you can see.

**Files:**
- Modify: `src/utils/terrainBuilder.ts` (extract helpers, add `planRefinement`, add
  the `cut` parameter and the refined node path)
- Modify: `scripts/verify-terrain-solid.ts` (add the refinement-fidelity case)

**Interfaces:**
- Consumes: `buildCorridor`, `Corridor` from `./trackCorridor`; `GPXTrack` from `../types`.
- Produces:
  - `interface RefinementPlan { gridSize: number; spacing: number; grooveHalfWidth: number }`
  - `function planRefinement(grid: ElevationGrid, settings: TerrainSettings, requestedHalfWidth: number): RefinementPlan`
  - `buildTerrainMesh(grid, settings, cut?: { tracks: GPXTrack[]; halfWidth: number })` — third parameter is new and optional.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-terrain-solid.ts`, immediately before the final
`console.log('')` / exit block:

```ts
// ── Refinement fidelity ──
// The refined *nodes* are sampled from the coarse surface, so at a node the two
// agree exactly. They do NOT agree everywhere: a fine triangle straddling a
// coarse fold cuts the corner off it, by up to the fine spacing times the change
// in slope. What must hold is node-exactness plus containment — the refined
// surface interpolates the coarse one and so can never leave its height range.
console.log('');
console.log('Refinement fidelity\n');

/** Half-width chosen so the refined grid is ~93², well under the 257 cap. */
const REFINE_HALF_WIDTH = 60;

const REFINE_TRACK: GPXTrack = {
  name: 'traverse',
  points: Array.from({ length: 40 }, (_, i) => ({
    lat: BBOX.minLat + 0.004 + (i / 39) * 0.042,
    lon: BBOX.minLon + 0.005 + (i / 39) * 0.05,
    ele: 0,
  })),
};

/** Y range of the top surface only — the underside sits at baseY and would swamp it. */
function topYRange(mesh: THREE.Mesh, baseY: number): [number, number] {
  const pos = mesh.geometry.getAttribute('position');
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y <= baseY + 1e-6) continue;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return [lo, hi];
}

for (const style of ['original', 'lowpoly', 'layers'] as const) {
  for (const baseShape of ['square', 'hex', 'round'] as const) {
    const label = `refined ${style} / ${baseShape}`;
    const grid = makeGrid();
    const settings = settingsFor(style, baseShape);

    const plain = buildTerrainMesh(grid, settings);
    const refined = buildTerrainMesh(grid, settings, {
      tracks: [REFINE_TRACK],
      halfWidth: REFINE_HALF_WIDTH,
    });
    refined.mesh.updateMatrixWorld(true);

    const plainTris = plain.mesh.geometry.getIndex()!.count / 3;
    const refinedTris = refined.mesh.geometry.getIndex()!.count / 3;
    if (refinedTris <= plainTris) {
      fail(label, `refined mesh has ${refinedTris} triangles, not more than ${plainTris}`);
      continue;
    }

    checkManifold(label, refined.mesh);

    // ── Node-exactness ──
    const plan = planRefinement(grid, settings, REFINE_HALF_WIDTH);
    const m = plan.gridSize;
    const cs = refined.coordSystem;
    let worstNode = 0;
    let nodeSamples = 0;
    for (let row = 2; row < m - 2; row += 7) {
      for (let col = 2; col < m - 2; col += 7) {
        const lat = BBOX.maxLat - (row / (m - 1)) * (BBOX.maxLat - BBOX.minLat);
        const lon = BBOX.minLon + (col / (m - 1)) * (BBOX.maxLon - BBOX.minLon);
        const [x, , z] = geoToLocal(cs, lat, lon, 0);
        const hit = castDown(refined.mesh, x, z);
        if (hit === null) continue;
        worstNode = Math.max(worstNode, Math.abs(hit - plain.surface.sampleY(x, z)));
        nodeSamples++;
      }
    }
    if (nodeSamples < 20) fail(label, `only ${nodeSamples} node samples hit the mesh`);
    else if (worstNode > 1e-3) fail(label, `refined nodes off the coarse surface by ${worstNode.toFixed(4)}`);
    else console.log(`  ok    ${label} nodes exact (${nodeSamples} samples, <=${worstNode.toExponential(1)})`);

    // ── Containment: interpolation cannot exceed the source range ──
    const baseY = -Math.max(settings.baseDepth, 1) * settings.verticalScale;
    const [plainLo, plainHi] = topYRange(plain.mesh, baseY);
    const [refLo, refHi] = topYRange(refined.mesh, baseY);
    if (refLo < plainLo - 1e-3 || refHi > plainHi + 1e-3) {
      fail(label, `refined Y range [${refLo.toFixed(2)}, ${refHi.toFixed(2)}] escapes [${plainLo.toFixed(2)}, ${plainHi.toFixed(2)}]`);
    } else {
      console.log(`  ok    ${label} Y range contained (${refinedTris} tris)`);
    }
  }
}

// ── The resolution cap ──
// A half-width far below the cell size must widen the groove, not vanish.
{
  const grid = makeGrid();
  const settings = settingsFor('original', 'square');
  const capped = planRefinement(grid, settings, 5);
  if (capped.gridSize !== 257) fail('cap', `gridSize ${capped.gridSize}, expected the 257 ceiling`);
  else if (!(capped.grooveHalfWidth > 5)) fail('cap', `grooveHalfWidth ${capped.grooveHalfWidth} was not raised above 5`);
  else console.log(`  ok    cap holds (grid 257, groove half-width ${capped.grooveHalfWidth.toFixed(1)})`);
}
```

Add these imports at the top of the script:

```ts
import type { BoundingBox, ElevationGrid, GPXTrack, TerrainSettings } from '../src/types.ts';
import { buildTerrainMesh, planRefinement } from '../src/utils/terrainBuilder.ts';
import { geoToLocal } from '../src/utils/coordTransform.ts';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:terrain`
Expected: FAIL — `buildTerrainMesh` takes two arguments at runtime, so the third is
ignored and `refined mesh has N triangles, not more than N` fires for every case.

- [ ] **Step 3: Extract the shared helpers**

In `src/utils/terrainBuilder.ts`, add these three functions above
`buildTerrainMesh`. This step only adds them — Step 7 rewrites `buildTerrainMesh`
to call them and deletes the inline versions. In between they are unused, so
`npm run typecheck` would flag them under `noUnusedLocals`; that is expected and
resolves at Step 7.

```ts
function terrainCoordSystem(grid: ElevationGrid, settings: TerrainSettings): CoordSystem {
  const { bbox, minEle } = grid;
  return buildCoordSystem(
    (bbox.minLat + bbox.maxLat) / 2,
    (bbox.minLon + bbox.maxLon) / 2,
    minEle,
    settings.verticalScale,
    bbox,
    settings.baseShape,
  );
}

function effectiveResolution(grid: ElevationGrid, settings: TerrainSettings): number {
  return settings.style === 'lowpoly'
    ? Math.max(8, Math.floor(grid.gridSize / 4))
    : grid.gridSize;
}

/**
 * Geographic position of grid node (row, col) on an `m`-by-`m` grid over the
 * bounding box. Row 0 is the northernmost. Both the coarse and the refined node
 * loops go through this, so their grids can never drift apart.
 */
function nodeLatLon(bbox: BoundingBox, row: number, col: number, m: number): [number, number] {
  return [
    bbox.maxLat - (row / (m - 1)) * (bbox.maxLat - bbox.minLat),
    bbox.minLon + (col / (m - 1)) * (bbox.maxLon - bbox.minLon),
  ];
}

function styledElevations(grid: ElevationGrid, settings: TerrainSettings, n: number): number[] {
  const { values, gridSize: src, minEle, maxEle } = grid;
  const raw: number[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const srcRow = Math.round((row / (n - 1)) * (src - 1));
      const srcCol = Math.round((col / (n - 1)) * (src - 1));
      raw.push(values[srcRow][srcCol]);
    }
  }
  return settings.style === 'layers'
    ? applyLayersStyle(raw, minEle, maxEle, settings.layerCount)
    : raw;
}
```

- [ ] **Step 4: Add the refinement plan**

Add below those helpers:

```ts
/** Ceiling on the refined top surface: ~66k vertices, which keeps a rebuild interactive. */
const MAX_REFINED_GRID = 257;

export interface RefinementPlan {
  /** Grid size of the refined top surface. */
  gridSize: number;
  /** Largest node spacing in scene units. */
  spacing: number;
  /** Corridor half-width after the resolution floor. */
  grooveHalfWidth: number;
}

/**
 * How finely the top surface has to be tessellated to express a groove of the
 * requested width, and how wide that groove ends up.
 *
 * A groove needs roughly two nodes across it, so the target spacing is the
 * requested half-width. Where the cap bites, the groove widens rather than
 * disappearing — the UI reports the result.
 */
export function planRefinement(
  grid: ElevationGrid,
  settings: TerrainSettings,
  requestedHalfWidth: number,
): RefinementPlan {
  const cs = terrainCoordSystem(grid, settings);
  const span = 2 * Math.max(cs.halfWidthM, cs.halfDepthM);
  const wanted = Math.ceil(span / Math.max(requestedHalfWidth, 1e-6)) + 1;
  const gridSize = Math.min(
    MAX_REFINED_GRID,
    Math.max(effectiveResolution(grid, settings), wanted),
  );
  const spacing = span / (gridSize - 1);
  return { gridSize, spacing, grooveHalfWidth: Math.max(requestedHalfWidth, spacing) };
}
```

- [ ] **Step 5: Build the refined nodes**

Add above `buildTerrainMesh`:

```ts
interface TerrainNodes {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** Grid size; arrays are size × size, row-major, row 0 = northernmost. */
  size: number;
}

/**
 * Re-samples the surface `coarse` describes onto an m × m grid.
 *
 * The nodes land exactly on the already-rendered coarse surface, so `original`,
 * `lowpoly` and `layers` all look unchanged — there are only more triangles to
 * emboss into.
 */
function refineNodes(
  grid: ElevationGrid,
  cs: CoordSystem,
  coarse: TerrainSurface,
  m: number,
): TerrainNodes {
  const { bbox } = grid;
  const x = new Float64Array(m * m);
  const y = new Float64Array(m * m);
  const z = new Float64Array(m * m);

  for (let row = 0; row < m; row++) {
    for (let col = 0; col < m; col++) {
      const idx = row * m + col;
      const [lat, lon] = nodeLatLon(bbox, row, col, m);
      const [px, , pz] = geoToLocal(cs, lat, lon, 0);
      x[idx] = px;
      z[idx] = pz;
      y[idx] = coarse.sampleY(px, pz);
    }
  }
  return { x, y, z, size: m };
}
```

- [ ] **Step 6: Make elevationColor fill a target**

At 66k vertices, allocating a `THREE.Color` per node is the dominant cost. Change
the signature to write into a caller-owned instance — the returned colours are
identical. Do this before Step 7, which calls the new form:

```ts
// Endpoints of the high-altitude ramp, hoisted so the hot path allocates nothing.
const ROCK_COLOR = new THREE.Color(0.55, 0.4, 0.3);
const SNOW_COLOR = new THREE.Color(0.95, 0.95, 0.95);

/** Maps a normalised value [0,1] to a terrain colour (low→high: green→brown→white). */
function elevationColor(t: number, target: THREE.Color): THREE.Color {
  if (t < 0.3) {
    // green → yellow-green
    return target.setHSL(0.28 - t * 0.1, 0.6, 0.35 + t * 0.2);
  } else if (t < 0.7) {
    // brown range
    return target.setHSL(0.08 - (t - 0.3) * 0.05, 0.5, 0.4 + (t - 0.3) * 0.1);
  }
  // brown → white
  return target.lerpColors(ROCK_COLOR, SNOW_COLOR, (t - 0.7) / 0.3);
}
```

Without hoisting these two, the branch above `t = 0.7` would still allocate two
colours per vertex and the refactor would miss most of its point on snowy terrain.

- [ ] **Step 7: Rework buildTerrainMesh to emit from a node set**

Extend the imports at the top of the file:

```ts
import type { BoundingBox, ElevationGrid, GPXTrack, TerrainSettings } from '../types';
import { buildCorridor } from './trackCorridor';
```

(`BoundingBox` is needed by the `nodeLatLon` helper added in Step 3, so add the
type import there if Step 3 has not already.)

Replace everything from the `export function buildTerrainMesh(` line down to and
including `const topVertexCount = N * N;` — that is, the line immediately above the
`// ── Perimeter ring ──` block added in Task 2. The perimeter block and everything
after it stays, and now reads `N` from the node set:

```ts
export function buildTerrainMesh(
  grid: ElevationGrid,
  settings: TerrainSettings,
  cut?: { tracks: GPXTrack[]; halfWidth: number },
): TerrainBuildResult {
  const { minEle, maxEle } = grid;
  const cs = terrainCoordSystem(grid, settings);
  const coarseN = effectiveResolution(grid, settings);
  const styledEle = styledElevations(grid, settings, coarseN);

  // ── Coarse nodes: the surface every style renders ──
  const coarse: TerrainNodes = {
    x: new Float64Array(coarseN * coarseN),
    y: new Float64Array(coarseN * coarseN),
    z: new Float64Array(coarseN * coarseN),
    size: coarseN,
  };
  for (let row = 0; row < coarseN; row++) {
    for (let col = 0; col < coarseN; col++) {
      const idx = row * coarseN + col;
      const [lat, lon] = nodeLatLon(grid.bbox, row, col, coarseN);
      const [x, y, z] = geoToLocal(cs, lat, lon, styledEle[idx]);
      coarse.x[idx] = x;
      coarse.y[idx] = y;
      coarse.z[idx] = z;
    }
  }

  // ── Refine only when there is something to cut ──
  let nodes = coarse;
  if (cut) {
    const plan = planRefinement(grid, settings, cut.halfWidth);
    const corridor = buildCorridor(cut.tracks, cs, plan.grooveHalfWidth, plan.spacing);
    if (corridor) {
      const coarseSurface = createTerrainSurface(coarse.x, coarse.y, coarse.z, coarseN, cs);
      nodes = refineNodes(grid, cs, coarseSurface, plan.gridSize);
    }
  }

  const N = nodes.size;
  const topVertexCount = N * N;
```

Then replace the `eleRange`/`baseY` declarations together with the whole
`for (let row...) for (let col...)` node loop. The loop no longer computes
`lat`/`lon`/`ele` — it reads from `nodes` and derives the colour parameter from Y:

```ts
  const eleRange = maxEle - minEle || 1;
  const baseY = -Math.max(settings.baseDepth, 1) * settings.verticalScale;
  // y = (ele - minEle) * verticalScale, so this is the same t the coarse path
  // used to compute from `ele` directly.
  const yRange = eleRange * settings.verticalScale || 1;
  const scratch = new THREE.Color();

  for (let idx = 0; idx < topVertexCount; idx++) {
    const topPos = idx * 3;
    positions[topPos] = nodes.x[idx];
    positions[topPos + 1] = nodes.y[idx];
    positions[topPos + 2] = nodes.z[idx];

    const t = Math.max(0, Math.min(1, nodes.y[idx] / yRange));
    if (settings.style === 'layers') {
      const layerIdx = Math.floor(t * settings.layerCount);
      scratch.set(LAYER_PALETTE[Math.min(layerIdx, LAYER_PALETTE.length - 1)]);
    } else {
      elevationColor(t, scratch);
    }

    colors[topPos] = scratch.r;
    colors[topPos + 1] = scratch.g;
    colors[topPos + 2] = scratch.b;
  }
```

The old `nodeX`/`nodeY`/`nodeZ` arrays and their writes are gone with that loop;
the final return uses `nodes` instead:

```ts
  return {
    mesh,
    coordSystem: cs,
    surface: createTerrainSurface(nodes.x, nodes.y, nodes.z, N, cs),
  };
```

- [ ] **Step 8: Run the tests**

Run: `npm run verify:terrain`
Expected: PASS — the nine solid cases plus six `refined ... unchanged` lines

Run: `npm run typecheck`
Expected: no output

Run: `npm run verify:track` and `npm run verify:corridor`
Expected: both PASS

- [ ] **Step 9: Commit**

```bash
git add src/utils/terrainBuilder.ts scripts/verify-terrain-solid.ts
git commit -m "Refine the terrain top surface when a cut is requested"
```

---

### Task 4: Emboss the groove

**Files:**
- Modify: `src/utils/terrainBuilder.ts` (accept `depth`, carve the nodes, shade the corridor)
- Modify: `scripts/verify-terrain-solid.ts` (add the groove case)

**Interfaces:**
- Consumes: `Corridor.sink` from Task 1, `RefinementPlan` from Task 3.
- Produces: `buildTerrainMesh(grid, settings, cut?: { tracks: GPXTrack[]; halfWidth: number; depth: number })` — `depth` is new and required within `cut`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-terrain-solid.ts`, before the final exit block:

```ts
// ── The groove itself ──
// The carved and uncarved meshes come from the same refined grid, so outside the
// corridor they are bit-identical and the comparison isolates the carving.
//
// The groove is about two nodes wide by design, so there is no dependable flat
// floor between nodes: asserting a fixed depth at the centre line would be
// asserting something false. The real contract is that the surface only ever
// moves down, never past the requested depth, and does reach it.
console.log('');
console.log('Groove\n');

const DEPTH = 8;

for (const style of ['original', 'lowpoly', 'layers'] as const) {
  for (const baseShape of ['square', 'hex', 'round'] as const) {
    const label = `groove ${style} / ${baseShape}`;
    const grid = makeGrid();
    const settings = settingsFor(style, baseShape);
    const plan = planRefinement(grid, settings, REFINE_HALF_WIDTH);

    const uncut = buildTerrainMesh(grid, settings, {
      tracks: [REFINE_TRACK],
      halfWidth: REFINE_HALF_WIDTH,
      depth: 0,
    });
    const cut = buildTerrainMesh(grid, settings, {
      tracks: [REFINE_TRACK],
      halfWidth: REFINE_HALF_WIDTH,
      depth: DEPTH,
    });
    uncut.mesh.updateMatrixWorld(true);
    cut.mesh.updateMatrixWorld(true);

    checkManifold(label, cut.mesh);

    const cs = cut.coordSystem;
    const corridor = buildCorridor([REFINE_TRACK], cs, plan.grooveHalfWidth, plan.spacing);
    if (!corridor) {
      fail(label, 'corridor was null for the test track');
      continue;
    }

    // Lateral direction of the (straight) test track, in scene XZ.
    const first = REFINE_TRACK.points[0];
    const last = REFINE_TRACK.points[REFINE_TRACK.points.length - 1];
    const [fx, , fz] = geoToLocal(cs, first.lat, first.lon, 0);
    const [lx, , lz] = geoToLocal(cs, last.lat, last.lon, 0);
    const len = Math.hypot(lx - fx, lz - fz);
    const nx = -(lz - fz) / len;
    const nz = (lx - fx) / len;

    const reach = plan.grooveHalfWidth + plan.spacing;
    let maxDrop = 0;
    let worstLift = 0;
    let worstOvershoot = 0;
    let worstOutside = 0;
    let inside = 0;
    let outside = 0;

    for (let i = 4; i < 36; i++) {
      const p = REFINE_TRACK.points[i];
      const [cx, , cz] = geoToLocal(cs, p.lat, p.lon, 0);

      for (let k = -24; k <= 24; k++) {
        const off = (k / 24) * (reach + 120);
        const x = cx + nx * off;
        const z = cz + nz * off;

        const a = castDown(uncut.mesh, x, z);
        const b = castDown(cut.mesh, x, z);
        if (a === null || b === null) continue;
        const drop = a - b;

        if (corridor.sink(x, z) > 0) {
          maxDrop = Math.max(maxDrop, drop);
          worstLift = Math.max(worstLift, -drop);
          worstOvershoot = Math.max(worstOvershoot, drop - DEPTH);
          inside++;
        } else if (Math.abs(off) > reach + 20) {
          worstOutside = Math.max(worstOutside, Math.abs(drop));
          outside++;
        }
      }
    }

    if (inside < 50) fail(label, `only ${inside} samples landed in the corridor`);
    else if (worstLift > 1e-3) fail(label, `terrain rose by ${worstLift.toFixed(4)} inside the corridor`);
    else if (worstOvershoot > 1e-3) fail(label, `groove overshot the depth by ${worstOvershoot.toFixed(4)}`);
    else if (maxDrop < DEPTH - 1e-3) fail(label, `groove only reached ${maxDrop.toFixed(4)} of ${DEPTH}`);
    else console.log(`  ok    ${label} depth ${maxDrop.toFixed(3)}/${DEPTH} (${inside} samples)`);

    if (outside < 20) fail(label, `only ${outside} samples landed outside the corridor`);
    else if (worstOutside > 1e-3) fail(label, `terrain outside moved by ${worstOutside.toFixed(4)}`);
    else console.log(`  ok    ${label} untouched outside (${outside} samples, <=${worstOutside.toExponential(1)})`);
  }
}
```

Add the corridor import at the top of the script:

```ts
import { buildCorridor } from '../src/utils/trackCorridor.ts';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:terrain`
Expected: FAIL — `depth` is ignored, so `floor off depth by 8.0000` on every
groove case. The refinement and solid sections stay green.

- [ ] **Step 3: Carve the nodes**

In `src/utils/terrainBuilder.ts`, add above `buildTerrainMesh`:

```ts
/** How much darker the groove is drawn, at full depth. */
const GROOVE_SHADE = 0.45;

/**
 * Lowers the nodes inside the corridor and returns how far each one sank.
 *
 * The returned field is also what shades the groove, so the colour ramp and the
 * geometry ramp cannot drift apart.
 */
function carveNodes(nodes: TerrainNodes, corridor: Corridor, depth: number): Float64Array {
  const sink = new Float64Array(nodes.size * nodes.size);
  for (let i = 0; i < sink.length; i++) {
    const s = corridor.sink(nodes.x[i], nodes.z[i]);
    sink[i] = s;
    nodes.y[i] -= depth * s;
  }
  return sink;
}
```

and extend the corridor import:

```ts
import { buildCorridor, type Corridor } from './trackCorridor';
```

- [ ] **Step 4: Wire depth through buildTerrainMesh**

Change the signature and the refinement block:

```ts
export function buildTerrainMesh(
  grid: ElevationGrid,
  settings: TerrainSettings,
  cut?: { tracks: GPXTrack[]; halfWidth: number; depth: number },
): TerrainBuildResult {
```

```ts
  // ── Refine only when there is something to cut ──
  let nodes = coarse;
  let sink: Float64Array | null = null;
  let depth = 0;
  if (cut) {
    const plan = planRefinement(grid, settings, cut.halfWidth);
    const corridor = buildCorridor(cut.tracks, cs, plan.grooveHalfWidth, plan.spacing);
    if (corridor) {
      const coarseSurface = createTerrainSurface(coarse.x, coarse.y, coarse.z, coarseN, cs);
      nodes = refineNodes(grid, cs, coarseSurface, plan.gridSize);
      depth = cut.depth;
      sink = carveNodes(nodes, corridor, depth);
    }
  }
```

- [ ] **Step 5: Shade the groove and colour from the original height**

In the node loop, the colour must come from the *pre-carve* height — adding the
sink back recovers it exactly. Replace the colour computation (everything from
`const t = ...` to the three `colors[...]` writes) with:

```ts
    const s = sink ? sink[idx] : 0;
    const t = Math.max(0, Math.min(1, (nodes.y[idx] + depth * s) / yRange));
    if (settings.style === 'layers') {
      const layerIdx = Math.floor(t * settings.layerCount);
      scratch.set(LAYER_PALETTE[Math.min(layerIdx, LAYER_PALETTE.length - 1)]);
    } else {
      elevationColor(t, scratch);
    }

    const shade = 1 - GROOVE_SHADE * s;
    colors[topPos] = scratch.r * shade;
    colors[topPos + 1] = scratch.g * shade;
    colors[topPos + 2] = scratch.b * shade;
```

- [ ] **Step 6: Run the tests**

Run: `npm run verify:terrain`
Expected: PASS — solid, refinement and groove sections all green

Run: `npm run typecheck`
Expected: no output

Run: `npm run verify:track` and `npm run verify:corridor`
Expected: both PASS

- [ ] **Step 7: Commit**

```bash
git add src/utils/terrainBuilder.ts scripts/verify-terrain-solid.ts
git commit -m "Emboss the track groove into the refined terrain"
```

---

### Task 5: Remove the engraved profile

**Files:**
- Modify: `src/types.ts` (the `TrackProfile` union)
- Modify: `src/utils/trackBuilder.ts` (drop every `engraved` branch)
- Modify: `src/components/ControlPanel.tsx` (drop the option)

**Interfaces:**
- Consumes: nothing new.
- Produces: `type TrackProfile = 'round' | 'square'`.

- [ ] **Step 1: Narrow the type**

In `src/types.ts`:

```ts
export type TrackProfile = 'round' | 'square';
```

- [ ] **Step 2: Run typecheck to see the failures**

Run: `npm run typecheck`
Expected: FAIL — errors in `trackBuilder.ts` where `'engraved'` is compared
against the narrowed union, and in `ControlPanel.tsx` for the option value.

- [ ] **Step 3: Strip the engraved branches from trackBuilder**

Delete the `GROOVE_DEPTH_FACTOR` constant and its comment. In `buildRings`, delete
the `engraved` local and simplify the two expressions that used it:

```ts
  const K = profile === 'round' ? CROSS_SEGMENTS_ROUND : CROSS_SEGMENTS_FLAT;
  const slots = ringSlots(K);
  const crown = profile === 'round' ? Math.min(halfWidth, height * 0.6) : 0;
  const embed = Math.max(0.05, halfWidth * EMBED_FACTOR);
  const minThickness = Math.max(0.05, height * 0.02);
```

```ts
    // ── One level reference height for the whole cross-section ──
    // The band clears the highest ground under it, so a cross-slope cannot poke
    // through the top.
    const apexY = Math.max(...groundY) + offset + height;
```

```ts
      const rawBottomY = groundY[j] - embed;
```

And in `buildTrackMesh`, the material colour loses its conditional:

```ts
  const c = color ?? TRACK_COLORS[trackIndex % TRACK_COLORS.length];
  const mat = new THREE.MeshPhongMaterial({ color: c, shininess: 80 });
```

- [ ] **Step 4: Drop the option from the panel**

In `src/components/ControlPanel.tsx`, delete this line:

```tsx
            <option value="engraved">Engraved groove</option>
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck`
Expected: no output

Run: `npm run verify:track`, `npm run verify:corridor`, `npm run verify:terrain`
Expected: all three PASS

Run: `npm run build`
Expected: `✓ built in ...`

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/utils/trackBuilder.ts src/components/ControlPanel.tsx
git commit -m "Remove the engraved profile in favour of a negative offset"
```

---

### Task 6: Wire the cut into the app

**Files:**
- Modify: `src/utils/trackBuilder.ts` (`buildAllTrackMeshes` produces nothing when cutting)
- Modify: `src/components/Viewer3D.tsx` (lines 163-179 — pass the cut intent)
- Modify: `src/App.tsx` (compute the effective groove width)
- Modify: `src/components/ControlPanel.tsx` (report depth and effective width)

**Interfaces:**
- Consumes: `planRefinement` from Task 3, the three-argument `buildTerrainMesh` from Task 4.
- Produces: `ControlPanel` gains an optional prop `grooveHalfWidth: number | null`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-terrain-solid.ts`, before the final exit block:

```ts
// ── A negative offset produces no band ──
console.log('');
console.log('Track suppression\n');
{
  const grid = makeGrid();
  const settings = settingsFor('original', 'square');
  const { coordSystem, surface } = buildTerrainMesh(grid, settings);

  const raised = buildAllTrackMeshes([REFINE_TRACK], surface, coordSystem, 4, 10, 'square');
  const cutAway = buildAllTrackMeshes([REFINE_TRACK], surface, coordSystem, -4, 10, 'square');

  if (raised.length !== 1) fail('suppression', `positive offset produced ${raised.length} meshes, expected 1`);
  else console.log('  ok    positive offset still builds a band');

  if (cutAway.length !== 0) fail('suppression', `negative offset produced ${cutAway.length} meshes, expected 0`);
  else console.log('  ok    negative offset builds no band');
}
```

Add the import at the top of the script:

```ts
import { buildAllTrackMeshes } from '../src/utils/trackBuilder.ts';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:terrain`
Expected: FAIL — `negative offset produced 1 meshes, expected 0`

- [ ] **Step 3: Suppress the band when cutting**

In `src/utils/trackBuilder.ts`, replace the body of `buildAllTrackMeshes`:

```ts
/** Build meshes for all tracks. */
export function buildAllTrackMeshes(
  tracks: GPXTrack[],
  surface: TerrainSurface,
  cs: CoordSystem,
  offset: number,
  width: number,
  profile: TrackProfile,
): THREE.Mesh[] {
  // A negative offset engraves the route into the terrain instead. The groove is
  // an empty channel, so there is no band to build and the model stays one body.
  if (offset < 0) return [];
  return tracks.map((track, i) => buildTrackMesh(track, surface, cs, offset, width, i, profile));
}
```

- [ ] **Step 4: Pass the cut intent from the viewer**

In `src/components/Viewer3D.tsx`, replace the `buildTerrainMesh` call:

```tsx
    const cutting = settings.track.offset < 0;
    const { mesh: terrainMesh, coordSystem: cs, surface } = buildTerrainMesh(
      grid,
      settings.terrain,
      cutting
        ? {
            tracks: gpxData.tracks,
            halfWidth: settings.track.width,
            depth: -settings.track.offset,
          }
        : undefined,
    );
```

Nothing else in that effect changes — `buildAllTrackMeshes` already returns `[]`
on its own.

- [ ] **Step 5: Report depth and effective width in the panel**

In `src/components/ControlPanel.tsx`, extend the props:

```tsx
interface Props {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  /** Groove half-width after the mesh-resolution floor; null when not cutting. */
  grooveHalfWidth: number | null;
}
```

```tsx
export default function ControlPanel({ settings, onChange, grooveHalfWidth }: Props) {
```

Replace the offset and width rows:

```tsx
        <Row
          label={
            settings.track.offset < 0
              ? `Groove depth: ${-settings.track.offset} m`
              : `Offset: ${settings.track.offset > 0 ? '+' : ''}${settings.track.offset} m`
          }
        >
          <input
            type="range"
            min={-50}
            max={50}
            step={1}
            value={settings.track.offset}
            onChange={(e) => setTrack({ offset: Number(e.target.value) })}
          />
        </Row>

        <Row
          label={
            grooveHalfWidth != null && grooveHalfWidth > settings.track.width
              ? `Width: ${settings.track.width} m (groove ${Math.round(grooveHalfWidth)} m)`
              : `Width: ${settings.track.width} m`
          }
        >
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={settings.track.width}
            onChange={(e) => setTrack({ width: Number(e.target.value) })}
          />
        </Row>
```

- [ ] **Step 6: Compute the effective width in App**

In `src/App.tsx`, add the import:

```tsx
import { planRefinement } from './utils/terrainBuilder';
```

and above the `return`:

```tsx
  // The mesh resolution puts a floor under the groove width; surface it rather
  // than silently widening what the user asked for.
  const grooveHalfWidth =
    grid && settings.track.offset < 0
      ? planRefinement(grid, settings.terrain, settings.track.width).grooveHalfWidth
      : null;
```

then pass it down:

```tsx
            <ControlPanel settings={settings} onChange={setSettings} grooveHalfWidth={grooveHalfWidth} />
```

- [ ] **Step 7: Run the tests**

Run: `npm run verify:terrain`
Expected: PASS — including both suppression lines

Run: `npm run typecheck`
Expected: no output

Run: `npm run verify:track` and `npm run verify:corridor`
Expected: both PASS

Run: `npm run build`
Expected: `✓ built in ...`

- [ ] **Step 8: Commit**

```bash
git add src/utils/trackBuilder.ts src/components/Viewer3D.tsx src/components/ControlPanel.tsx src/App.tsx scripts/verify-terrain-solid.ts
git commit -m "Cut the groove when the track offset goes negative"
```

---

## Manual check after Task 6

The verification scripts cover geometry, not appearance. Load a GPX file in
`npm run dev` and confirm by eye:

1. Offset `0` — the band rests on the terrain, unchanged from today.
2. Drag the offset negative — the band disappears and a darkened channel appears
   along the route.
3. The width slider widens the channel, and the label reports the effective width
   once the floor bites.
4. Switch terrain style to `layers` and `lowpoly` — the channel follows the
   stepped and faceted surfaces without floating or detaching.
5. Switch base shape to `hex` and `round` — the channel stays on the route.

## Known follow-up

The 257 cap means a long, narrow bounding box gets anisotropic cells, because one
`gridSize` serves both axes. That matches how the builder already treats
non-square bounding boxes, so it is not a regression, but separate `Mx`/`Mz` would
be the fix if it shows.
