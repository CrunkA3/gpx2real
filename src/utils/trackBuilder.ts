import * as THREE from 'three';
import type { GPXTrack, TrackProfile } from '../types';
import type { CoordSystem } from './coordTransform';
import { cleanCenterLine, type Vec2 } from './trackCorridor';
import type { TerrainSurface } from './terrainBuilder';

// ─── Colour palette for multiple tracks ──────────────────────────────

const TRACK_COLORS = [
  0xff4444, // red
  0x4488ff, // blue
  0xffcc00, // yellow
  0x44cc44, // green
  0xff8800, // orange
  0xcc44cc, // purple
  0x00cccc, // cyan
  0xff4499, // pink
];

// ─── Geometry tuning ─────────────────────────────────────────────────

/**
 * Everything below is in *scene* units. They equal metres on the horizontal
 * axes, and — unlike anything routed through `geoToLocal`'s elevation argument
 * — they are unaffected by `verticalScale`, so a band keeps its proportions and
 * keeps resting on the terrain when the exaggeration is changed.
 */

/** Upper bound on the gap between two cross-sections. */
const MAX_STATION_SPACING = 20;
/** Keeps the vertex count bounded on very long tracks. */
const MAX_STATIONS = 4000;
/** Lateral subdivisions of a cross-section; the underside follows these. */
const CROSS_SEGMENTS_FLAT = 4;
const CROSS_SEGMENTS_ROUND = 8;
/** Cap on how far a corner vertex is pushed out on tight switchbacks. */
const MAX_MITER = 2;
/** Underside sinks this fraction of the half-width below the terrain. */
const EMBED_FACTOR = 0.05;
/** How far below the surface an engraved groove begins, in band heights. */
const GROOVE_DEPTH_FACTOR = 0.5;

// ─── Centre line ─────────────────────────────────────────────────────

/**
 * Inserts the cross-section positions.
 *
 * Besides a plain spacing cap, this samples every point where the centre line
 * *or either outer rail* crosses an edge of the terrain triangulation. The
 * terrain is planar between those crossings, so a polyline through them lies on
 * the surface exactly instead of cutting across ridges and bridging valleys.
 */
function buildStations(center: Vec2[], surface: TerrainSurface, halfWidth: number): Vec2[] {
  let total = 0;
  for (let i = 1; i < center.length; i++) {
    total += Math.hypot(center[i].x - center[i - 1].x, center[i].z - center[i - 1].z);
  }

  const maxSpacing = Math.max(
    Math.min(MAX_STATION_SPACING, surface.cellSize / 3),
    total / MAX_STATIONS,
    0.1,
  );

  // ── Pass 1: uniform subdivision ──
  // Also keeps every piece short enough for edgeCrossings to stay cheap.
  const coarse: Vec2[] = [center[0]];
  for (let i = 1; i < center.length; i++) {
    const a = center[i - 1];
    const b = center[i];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / maxSpacing);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      coarse.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
    coarse.push(b);
  }

  // ── Pass 2: land a station on every terrain edge the band walks over ──
  const stations: Vec2[] = [coarse[0]];
  for (let i = 1; i < coarse.length; i++) {
    const a = coarse[i - 1];
    const b = coarse[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);

    const ts: number[] = [];
    if (len > 1e-9) {
      // The rails are a rigid translation of the segment, so a crossing at
      // parameter t on a rail is at parameter t on the centre line too.
      const nx = -dz / len;
      const nz = dx / len;
      for (const offset of [0, halfWidth, -halfWidth]) {
        ts.push(
          ...surface.edgeCrossings(
            a.x + nx * offset,
            a.z + nz * offset,
            b.x + nx * offset,
            b.z + nz * offset,
          ),
        );
      }
      ts.sort((p, q) => p - q);
    }

    const eps = 1e-6;
    let last = 0;
    for (const t of ts) {
      if (t - last < eps || t > 1 - eps) continue;
      stations.push({ x: a.x + dx * t, z: a.z + dz * t });
      last = t;
    }
    stations.push(b);
  }

  return stations;
}

/**
 * Unit-ish lateral vector per station, in the horizontal plane only — this is
 * what keeps the band from rolling with the slope. Magnitude carries the miter
 * scale so corners keep their width.
 */
function lateralFrames(stations: Vec2[]): Vec2[] {
  const dirs: Vec2[] = [];
  for (let i = 1; i < stations.length; i++) {
    const dx = stations[i].x - stations[i - 1].x;
    const dz = stations[i].z - stations[i - 1].z;
    const len = Math.hypot(dx, dz) || 1;
    dirs.push({ x: dx / len, z: dz / len });
  }

  return stations.map((_, i) => {
    const dIn = dirs[Math.max(i - 1, 0)];
    const dOut = dirs[Math.min(i, dirs.length - 1)];
    const inN = { x: -dIn.z, z: dIn.x };
    const outN = { x: -dOut.z, z: dOut.x };

    let mx = inN.x + outN.x;
    let mz = inN.z + outN.z;
    const mLen = Math.hypot(mx, mz);
    if (mLen < 1e-6) return outN; // 180° switchback — no usable bisector

    mx /= mLen;
    mz /= mLen;
    const miter = Math.min(1 / Math.max(mx * inN.x + mz * inN.z, 1e-3), MAX_MITER);
    return { x: mx * miter, z: mz * miter };
  });
}

// ─── Cross-section ───────────────────────────────────────────────────

/**
 * Lateral position of subdivision `j`, as a fraction of the half-width.
 *
 * Runs from +1 to -1: the outline has to walk the cross-section in the
 * direction that makes the strip triangles wind outwards, and the lateral
 * vector from `lateralFrames` points at the +1 side.
 */
function lateralParam(j: number, K: number): number {
  return 1 - (2 * j) / K;
}

/**
 * Ring layout for `K` lateral subdivisions, walking the outline as a closed
 * loop: `B0 → T0 … TK → BK → B(K-1) … B1`.
 */
function ringSlots(K: number): { size: number; top: (j: number) => number; bottom: (j: number) => number } {
  const size = 2 * K + 2;
  return {
    size,
    top: (j) => 1 + j,
    bottom: (j) => (j === 0 ? 0 : size - j),
  };
}

/**
 * Splits the outline into shading arcs. Vertices are duplicated between arcs,
 * so the top stays smooth along its own curvature while the edges against the
 * side walls remain crisp.
 */
function ringArcs(K: number): number[][] {
  const size = 2 * K + 2;
  const top: number[] = [];
  for (let j = 0; j <= K; j++) top.push(1 + j);
  const bottom: number[] = [];
  for (let k = K + 2; k < size; k++) bottom.push(k);
  bottom.push(0);
  return [[0, 1], top, [K + 1, K + 2], bottom];
}

/**
 * One closed outline per station, in scene space.
 *
 * The top of every cross-section is level (a single height across the width, or
 * a symmetric dome for `round`); the bottom is sampled per lateral position, so
 * it beds into the slope. Nothing here is derived from the travel direction's
 * pitch, which is why the band no longer banks.
 */
function buildRings(
  stations: Vec2[],
  frames: Vec2[],
  surface: TerrainSurface,
  profile: TrackProfile,
  halfWidth: number,
  height: number,
  offset: number,
): THREE.Vector3[][] {
  const K = profile === 'round' ? CROSS_SEGMENTS_ROUND : CROSS_SEGMENTS_FLAT;
  const slots = ringSlots(K);
  const engraved = profile === 'engraved';
  const crown = profile === 'round' ? Math.min(halfWidth, height * 0.6) : 0;
  const embed = Math.max(0.05, halfWidth * EMBED_FACTOR);
  const minThickness = Math.max(0.05, height * 0.02);

  return stations.map((st, i) => {
    const frame = frames[i];

    // ── Sample the rendered terrain across the width ──
    const xs: number[] = [];
    const zs: number[] = [];
    const groundY: number[] = [];
    for (let j = 0; j <= K; j++) {
      const s = lateralParam(j, K);
      const x = st.x + frame.x * halfWidth * s;
      const z = st.z + frame.z * halfWidth * s;
      xs.push(x);
      zs.push(z);
      groundY.push(surface.sampleY(x, z));
    }

    // ── One level reference height for the whole cross-section ──
    // Raised profiles clear the highest ground under the band; the groove hangs
    // off the lowest, so it stays visible as a recess everywhere.
    const apexY = engraved
      ? Math.min(...groundY) + offset - height * GROOVE_DEPTH_FACTOR
      : Math.max(...groundY) + offset + height;

    const ring: THREE.Vector3[] = new Array(slots.size);
    for (let j = 0; j <= K; j++) {
      const s = lateralParam(j, K);
      const topY = crown > 0 ? apexY - crown + crown * Math.sqrt(Math.max(0, 1 - s * s)) : apexY;

      const rawBottomY = engraved
        ? groundY[j] + offset - height * (GROOVE_DEPTH_FACTOR + 1)
        : groundY[j] - embed;
      // Steep cross-slopes (or a strongly negative offset) could otherwise push
      // the underside through the top and invert the winding.
      const bottomY = Math.min(rawBottomY, topY - minThickness);

      ring[slots.top(j)] = new THREE.Vector3(xs[j], topY, zs[j]);
      ring[slots.bottom(j)] = new THREE.Vector3(xs[j], bottomY, zs[j]);
    }
    return ring;
  });
}

// ─── Mesh assembly ───────────────────────────────────────────────────

function emptyMesh(trackIndex: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = `track_${trackIndex}`;
  return mesh;
}

function buildGeometry(rings: THREE.Vector3[][], K: number): THREE.BufferGeometry {
  const arcs = ringArcs(K);
  const ringSize = 2 * K + 2;
  const perStation = arcs.reduce((sum, arc) => sum + arc.length, 0);
  const stationCount = rings.length;

  const capBase = stationCount * perStation;
  const vertexCount = capBase + 2 * ringSize;
  const positions = new Float32Array(vertexCount * 3);

  const write = (slot: number, v: THREE.Vector3) => {
    positions[slot * 3] = v.x;
    positions[slot * 3 + 1] = v.y;
    positions[slot * 3 + 2] = v.z;
  };

  for (let i = 0; i < stationCount; i++) {
    let local = 0;
    for (const arc of arcs) {
      for (const r of arc) write(i * perStation + local++, rings[i][r]);
    }
  }
  for (let r = 0; r < ringSize; r++) {
    write(capBase + r, rings[0][r]);
    write(capBase + ringSize + r, rings[stationCount - 1][r]);
  }

  const indices: number[] = [];

  // ── Skin: one strip per arc, between consecutive stations ──
  for (let i = 0; i < stationCount - 1; i++) {
    const base = i * perStation;
    const next = (i + 1) * perStation;
    let local = 0;
    for (const arc of arcs) {
      for (let q = 0; q < arc.length - 1; q++) {
        const p = local + q;
        indices.push(base + p, next + p, base + p + 1);
        indices.push(base + p + 1, next + p, next + p + 1);
      }
      local += arc.length;
    }
  }

  // ── End caps, wound outwards ──
  const endBase = capBase + ringSize;
  for (let k = 1; k < ringSize - 1; k++) {
    indices.push(capBase, capBase + k, capBase + k + 1);
    indices.push(endBase, endBase + k + 1, endBase + k);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(
    vertexCount > 65535 ? new THREE.BufferAttribute(new Uint32Array(indices), 1) : new THREE.BufferAttribute(new Uint16Array(indices), 1),
  );
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds a solid band for a single GPX track, bedded onto the terrain.
 *
 * The band's underside follows the surface across its full width, its top stays
 * level, and both are measured against the mesh the terrain builder actually
 * produced — so it neither sinks into slopes nor floats above them.
 *
 * @param track      GPX track data
 * @param surface    Sampler for the rendered terrain (see `buildTerrainMesh`)
 * @param cs         Coordinate system (centre, scale)
 * @param offset     Vertical offset in scene units (0 = resting on the terrain)
 * @param width      Half-width of the band in scene units; also its height
 * @param color      Hex colour; undefined = auto from palette
 * @param trackIndex Index in the track list (for auto-colour)
 */
export function buildTrackMesh(
  track: GPXTrack,
  surface: TerrainSurface,
  cs: CoordSystem,
  offset: number,
  width: number,
  trackIndex: number,
  profile: TrackProfile,
  color?: number,
): THREE.Mesh {
  const halfWidth = Math.max(width, 0.1);
  const height = halfWidth;

  const center = cleanCenterLine(track, cs);
  if (center.length < 2) return emptyMesh(trackIndex);

  const stations = buildStations(center, surface, halfWidth);
  if (stations.length < 2) return emptyMesh(trackIndex);

  const frames = lateralFrames(stations);
  const rings = buildRings(stations, frames, surface, profile, halfWidth, height, offset);

  const K = profile === 'round' ? CROSS_SEGMENTS_ROUND : CROSS_SEGMENTS_FLAT;
  const geo = buildGeometry(rings, K);

  const c = color ?? TRACK_COLORS[trackIndex % TRACK_COLORS.length];
  const mat = new THREE.MeshPhongMaterial({
    color: profile === 'engraved' ? 0x552222 : c,
    shininess: 80,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `track_${trackIndex}`;
  mesh.castShadow = true;
  return mesh;
}

/** Build meshes for all tracks. */
export function buildAllTrackMeshes(
  tracks: GPXTrack[],
  surface: TerrainSurface,
  cs: CoordSystem,
  offset: number,
  width: number,
  profile: TrackProfile,
): THREE.Mesh[] {
  return tracks.map((track, i) => buildTrackMesh(track, surface, cs, offset, width, i, profile));
}
