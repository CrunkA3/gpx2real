/**
 * Verifies the two properties the track geometry has to hold, by ray-casting
 * against the meshes that actually get rendered — not against the builders'
 * internals.
 *
 *   A) It beds onto the terrain: the underside is never above the terrain
 *      surface and never further below it than the deliberate embed.
 *   B) It does not bank: the top is level across the track width.
 *
 * Run with `npm run verify:track`.
 */
import * as THREE from 'three';
import type { BoundingBox, ElevationGrid, GPXTrack, TerrainSettings, TrackProfile } from '../src/types.ts';
import { buildTerrainMesh } from '../src/utils/terrainBuilder.ts';
import { buildTrackMesh } from '../src/utils/trackBuilder.ts';
import { geoToLocal, type CoordSystem } from '../src/utils/coordTransform.ts';

// ─── Fixtures ────────────────────────────────────────────────────────

const BBOX: BoundingBox = { minLat: 47.2, maxLat: 47.25, minLon: 11.3, maxLon: 11.36 };
const GRID_SIZE = 16;
const WIDTH_M = 10;
/** Mirrors EMBED_FACTOR * halfWidth in trackBuilder. */
const EMBED = Math.max(0.05, WIDTH_M * 0.05);

/** Steep, folded relief — flat terrain would hide every draping defect. */
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

/** A diagonal traverse plus a lateral wiggle, so it crosses folds at angles. */
function makeWindingTrack(): GPXTrack {
  const points = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    points.push({
      lat: BBOX.minLat + 0.004 + t * 0.042,
      lon: BBOX.minLon + 0.005 + t * 0.05 + 0.004 * Math.sin(t * 7),
      ele: 0,
    });
  }
  return { name: 'traverse', points };
}

/**
 * A dead-straight diagonal. Levelness is measured on this one: the top strip is
 * a ruled surface between cross-sections, so on a *curved* track a probe line
 * perpendicular to the GPX direction is not parallel to the mesh's own
 * cross-section and picks up a small height difference that is not roll.
 */
function makeStraightTrack(): GPXTrack {
  const points = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    points.push({
      lat: BBOX.minLat + 0.004 + t * 0.042,
      lon: BBOX.minLon + 0.005 + t * 0.05,
      ele: 0,
    });
  }
  return { name: 'straight', points };
}

/** A hairpin, to make sure miter clamping never inverts the geometry. */
function makeSwitchbackTrack(): GPXTrack {
  const points = [];
  for (let i = 0; i <= 20; i++) {
    points.push({ lat: BBOX.minLat + 0.01 + i * 0.0015, lon: BBOX.minLon + 0.02, ele: 0 });
  }
  for (let i = 1; i <= 20; i++) {
    points.push({ lat: BBOX.maxLat - 0.01 - i * 0.0015, lon: BBOX.minLon + 0.0202, ele: 0 });
  }
  return { name: 'hairpin', points };
}

// ─── Ray-cast helpers ────────────────────────────────────────────────

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

/** Scene XZ of a point `offset` to the side of the track at parameter `t`. */
function lateralPoint(track: GPXTrack, cs: CoordSystem, t: number, offset: number) {
  const i = Math.min(Math.floor(t * (track.points.length - 1)), track.points.length - 2);
  const a = track.points[i];
  const b = track.points[i + 1];
  const [ax, , az] = geoToLocal(cs, a.lat, a.lon, 0);
  const [bx, , bz] = geoToLocal(cs, b.lat, b.lon, 0);
  const len = Math.hypot(bx - ax, bz - az) || 1;
  const nx = -(bz - az) / len;
  const nz = (bx - ax) / len;

  const frac = t * (track.points.length - 1) - i;
  return {
    x: ax + (bx - ax) * frac + nx * offset,
    z: az + (bz - az) * frac + nz * offset,
  };
}

// ─── Checks ──────────────────────────────────────────────────────────

/**
 * The two end caps fan across the whole outline, so a handful of their
 * triangles legitimately have no level edge. Everything else must.
 */
const CAP_TRIANGLE_ALLOWANCE = 40;

/**
 * Counts upward-facing triangles that lack a horizontal edge.
 *
 * Every quad of the flat-topped band spans two cross-sections, and both of its
 * triangles therefore have an edge joining two vertices of the *same*
 * cross-section. Level tops mean that edge is horizontal. A Frenet-framed
 * profile rolls with the slope and has no such edge anywhere — so this counts
 * roll exactly, with no probe geometry to introduce artefacts.
 */
function countRolledTopFaces(mesh: THREE.Mesh): number {
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.getIndex()!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  let rolled = 0;

  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i));
    b.fromBufferAttribute(pos, idx.getX(i + 1));
    c.fromBufferAttribute(pos, idx.getX(i + 2));
    n.copy(b).sub(a).cross(c.clone().sub(a));
    if (n.lengthSq() < 1e-18 || n.y <= 1e-9) continue; // not an upward face

    const level =
      Math.abs(a.y - b.y) < 1e-4 || Math.abs(b.y - c.y) < 1e-4 || Math.abs(a.y - c.y) < 1e-4;
    if (!level) rolled++;
  }
  return rolled;
}

let failures = 0;

function fail(label: string, detail: string): void {
  failures++;
  console.error(`  FAIL  ${label}\n        ${detail}`);
}

function checkCase(
  style: TerrainSettings['style'],
  verticalScale: number,
  profile: TrackProfile,
  baseShape: TerrainSettings['baseShape'],
): void {
  const label = `${style} / vScale=${verticalScale} / ${profile} / ${baseShape}`;
  const grid = makeGrid();
  const settings: TerrainSettings = {
    style,
    resolution: GRID_SIZE as TerrainSettings['resolution'],
    layerCount: 8,
    verticalScale,
    wireframe: false,
    baseShape,
    baseDepth: 120,
  };

  const { mesh: terrain, coordSystem: cs, surface } = buildTerrainMesh(grid, settings);
  terrain.updateMatrixWorld(true);

  let worstGap = 0;
  let worstSink = 0;
  let worstTilt = 0;
  let worstCurvedTilt = 0;
  let samples = 0;

  for (const track of [makeWindingTrack(), makeStraightTrack()]) {
    const straight = track.name === 'straight';
    const trackMesh = buildTrackMesh(track, surface, cs, 0, WIDTH_M, 0, profile);
    trackMesh.updateMatrixWorld(true);

    for (let s = 1; s < 200; s++) {
      const t = s / 200;
      const centre = lateralPoint(track, cs, t, 0);

      // ── A) underside bedded onto the terrain ──
      const groundY = castDown(terrain, centre.x, centre.z);
      const underY = castUp(trackMesh, centre.x, centre.z);
      if (groundY === null || underY === null) {
        fail(label, `no ray hit at ${track.name} t=${t.toFixed(3)} (ground=${groundY}, under=${underY})`);
        return;
      }
      samples++;
      worstGap = Math.max(worstGap, underY - groundY); // >0 means floating
      worstSink = Math.max(worstSink, groundY - underY); // how deep it is buried

      // ── B) top level across the width ──
      const left = lateralPoint(track, cs, t, WIDTH_M * 0.6);
      const right = lateralPoint(track, cs, t, -WIDTH_M * 0.6);
      const topL = castDown(trackMesh, left.x, left.z);
      const topR = castDown(trackMesh, right.x, right.z);
      if (topL === null || topR === null) {
        fail(label, `top ray missed the band at ${track.name} t=${t.toFixed(3)}`);
        return;
      }
      // Mirrored positions must match: level for `square`, symmetric for `round`.
      let tilt = Math.abs(topL - topR);

      if (profile === 'square') {
        const topC = castDown(trackMesh, centre.x, centre.z);
        if (topC === null) {
          fail(label, `top ray missed the centre at ${track.name} t=${t.toFixed(3)}`);
          return;
        }
        tilt = Math.max(tilt, Math.abs(topC - topL));
      }

      if (straight) worstTilt = Math.max(worstTilt, tilt);
      else worstCurvedTilt = Math.max(worstCurvedTilt, tilt);
    }

    // On the winding track a probe line is not parallel to the mesh's own
    // cross-section, so ray-casting picks up a ruled-surface difference that
    // is not roll. Check the invariant on the triangles directly instead.
    if (!straight && profile === 'square') {
      const rolled = countRolledTopFaces(trackMesh);
      if (rolled > CAP_TRIANGLE_ALLOWANCE) {
        fail(label, `${rolled} upward faces have no level cross-track edge`);
        return;
      }
    }
  }

  const gapTol = 1e-3;
  const sinkTol = EMBED + 1e-2;
  const tiltTol = 1e-3;

  if (worstGap > gapTol) fail(label, `underside floats up to ${worstGap.toFixed(3)} above the terrain`);
  if (worstSink > sinkTol) fail(label, `underside sinks ${worstSink.toFixed(3)} (allowed ${sinkTol.toFixed(3)})`);
  if (worstTilt > tiltTol) fail(label, `top tilts across the width by ${worstTilt.toFixed(4)}`);

  if (worstGap <= gapTol && worstSink <= sinkTol && worstTilt <= tiltTol) {
    console.log(
      `  ok    ${label}  (${samples} samples, gap<=${worstGap.toExponential(1)}, ` +
        `sink<=${worstSink.toFixed(3)}, tilt<=${worstTilt.toExponential(1)}, ` +
        `probe on curves<=${worstCurvedTilt.toFixed(3)})`,
    );
  }
}

function checkSwitchback(): void {
  const grid = makeGrid();
  const { coordSystem: cs, surface } = buildTerrainMesh(grid, {
    style: 'original',
    resolution: GRID_SIZE as TerrainSettings['resolution'],
    layerCount: 8,
    verticalScale: 1,
    wireframe: false,
    baseShape: 'square',
    baseDepth: 120,
  });
  const mesh = buildTrackMesh(makeSwitchbackTrack(), surface, cs, 0, WIDTH_M, 0, 'square');
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.getIndex();
  if (!idx) return fail('hairpin', 'geometry has no index');

  let degenerate = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i));
    b.fromBufferAttribute(pos, idx.getX(i + 1));
    c.fromBufferAttribute(pos, idx.getX(i + 2));
    if (!Number.isFinite(a.x + b.x + c.x + a.y + b.y + c.y)) {
      return fail('hairpin', `non-finite vertex in triangle ${i / 3}`);
    }
    if (b.clone().sub(a).cross(c.clone().sub(a)).length() < 1e-9) degenerate++;
  }
  const ratio = degenerate / (idx.count / 3);
  if (ratio > 0.05) fail('hairpin', `${(ratio * 100).toFixed(1)}% degenerate triangles`);
  else console.log(`  ok    hairpin  (${idx.count / 3} triangles, ${degenerate} degenerate)`);
}

// ─── Run ─────────────────────────────────────────────────────────────

console.log('Track draping / levelness checks\n');
for (const style of ['original', 'lowpoly', 'layers'] as const) {
  for (const verticalScale of [1, 2.5]) {
    for (const profile of ['square', 'round'] as const) {
      checkCase(style, verticalScale, profile, 'square');
    }
  }
}
checkCase('original', 1.5, 'square', 'round');
checkCase('original', 1.5, 'square', 'hex');
checkSwitchback();

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
