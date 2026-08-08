import * as THREE from 'three';
import type { BoundingBox, ElevationGrid, GPXTrack, TerrainSettings } from '../types';
import {
  buildCoordSystem,
  geoToLocal,
  localToNormalized,
  type CoordSystem,
} from './coordTransform';
import { buildCorridor } from './trackCorridor';

// ─── Colour helpers ───────────────────────────────────────────────────

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

/** Palette for layered terrain (10 distinct colours). */
const LAYER_PALETTE = [
  0x1a6b2c, 0x2d9140, 0x55a82d, 0x9dc43b, 0xd4b54e,
  0xb8864e, 0x9c6e3c, 0x7a5430, 0xaaaaaa, 0xdde4ea,
];

// ─── Apply elevation styles to a raw elevation array ─────────────────

function applyLayersStyle(values: number[], minEle: number, maxEle: number, layerCount: number): number[] {
  const range = maxEle - minEle || 1;
  return values.map((e) => {
    const t = (e - minEle) / range;
    const layer = Math.floor(t * layerCount);
    const clamped = Math.min(layer, layerCount - 1);
    return minEle + (clamped / layerCount) * range;
  });
}

// ─── Sampling the surface that actually gets rendered ────────────────

/**
 * Read access to the exact surface `buildTerrainMesh` produced, in scene space.
 *
 * Anything that has to sit on the terrain must sample through this rather than
 * interpolating the raw elevation grid. The rendered mesh differs from that
 * grid on four counts, each of which on its own makes a draped track sink or
 * float:
 * `layers` quantises the elevations, `lowpoly` quarters the resolution, the
 * surface is triangulated rather than bilinear, and non-square base shapes warp
 * XZ non-linearly — so even the barycentric weights differ. Interpolating the
 * rendered triangles in scene space is the only thing that gets all four right.
 */
export interface TerrainSurface {
  /** Rendered grid spacing in scene units — the scale at which relief changes. */
  readonly cellSize: number;
  /** Scene-space Y of the rendered surface at (x, z). */
  sampleY(x: number, z: number): number;
  /**
   * Parameters in (0,1) where the short segment (x0,z0)→(x1,z1) crosses an edge
   * of the triangulation. A polyline that includes these lies *on* the surface
   * instead of cutting corners off ridges and bridging valleys.
   *
   * Cheap only for segments no longer than a cell or two — the caller is
   * expected to have subdivided already.
   */
  edgeCrossings(x0: number, z0: number, x1: number, z1: number): number[];
}

/**
 * Where the ray `p0 + t·d` meets the segment `a → b`, or null if they miss.
 * Both parameters must land strictly inside their segment.
 */
function segmentHit(
  x0: number,
  z0: number,
  dx: number,
  dz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number | null {
  const ex = bx - ax;
  const ez = bz - az;
  const det = ex * dz - dx * ez;
  if (Math.abs(det) < 1e-12) return null; // parallel

  const rx = ax - x0;
  const rz = az - z0;
  const t = (ex * rz - rx * ez) / det;
  const u = (dx * rz - rx * dz) / det;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return t;
}

/** How far out from the guessed cell to look for the containing triangle. */
const CELL_SEARCH_RADIUS = 3;

function createTerrainSurface(
  nodeX: Float64Array,
  nodeY: Float64Array,
  nodeZ: Float64Array,
  n: number,
  cs: CoordSystem,
): TerrainSurface {
  const clampCell = (v: number) => Math.min(Math.max(v, 0), n - 2);

  /** Scene XZ → fractional grid coordinates (col, row). */
  const gridCoords = (x: number, z: number): [number, number] => {
    const [nx, nz] = localToNormalized(cs, x, z);
    return [((nx + 1) / 2) * (n - 1), ((nz + 1) / 2) * (n - 1)];
  };

  /**
   * Barycentric interpolation over one triangle. Returns the interpolated Y
   * plus how far outside the triangle the point is (0 = inside).
   */
  const evalTriangle = (
    x: number,
    z: number,
    ia: number,
    ib: number,
    ic: number,
  ): { y: number; outside: number } => {
    const ax = nodeX[ia];
    const az = nodeZ[ia];
    const bx = nodeX[ib] - ax;
    const bz = nodeZ[ib] - az;
    const cx = nodeX[ic] - ax;
    const cz = nodeZ[ic] - az;

    const det = bx * cz - bz * cx;
    if (Math.abs(det) < 1e-12) return { y: nodeY[ia], outside: Infinity };

    const px = x - ax;
    const pz = z - az;
    const wb = (px * cz - pz * cx) / det;
    const wc = (bx * pz - bz * px) / det;
    const wa = 1 - wb - wc;

    // Clamp before blending, don't "simplify" this away: sampleY's fallback
    // below calls this on the *nearest* triangle even when the search never
    // finds one the point is strictly inside, and an unclamped barycentric
    // blend extrapolates that triangle's plane — which can overshoot its own
    // vertex range, arbitrarily far if the triangle happens to be thin or
    // ill-conditioned. Task 4 carves against this sampler, so it must never
    // hand back a height outside the range it was asked to interpolate. This
    // is a no-op for points genuinely inside the triangle, where the weights
    // are already >= 0.
    const cwa = Math.max(0, wa);
    const cwb = Math.max(0, wb);
    const cwc = Math.max(0, wc);
    const wSum = cwa + cwb + cwc || 1;

    return {
      y: (cwa * nodeY[ia] + cwb * nodeY[ib] + cwc * nodeY[ic]) / wSum,
      outside: -Math.min(wa, wb, wc, 0),
    };
  };

  return {
    cellSize: Math.min((2 * cs.halfWidthM) / (n - 1), (2 * cs.halfDepthM) / (n - 1)),

    sampleY(x, z) {
      const [fCol, fRow] = gridCoords(x, z);
      const guessCol = clampCell(Math.floor(fCol));
      const guessRow = clampCell(Math.floor(fRow));

      // The base-shape warp bends grid lines away from the mesh's straight
      // edges, so the guessed cell can be off by a little — widen until the
      // containing triangle turns up, and otherwise take the nearest one.
      let best = { y: 0, outside: Infinity };
      for (let radius = 0; radius <= CELL_SEARCH_RADIUS; radius++) {
        for (let dr = -radius; dr <= radius; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            // Only the newly added ring on each pass.
            if (radius > 0 && Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
            const r0 = guessRow + dr;
            const c0 = guessCol + dc;
            if (r0 < 0 || c0 < 0 || r0 > n - 2 || c0 > n - 2) continue;

            const tl = r0 * n + c0;
            const tr = tl + 1;
            const bl = tl + n;
            const br = bl + 1;

            // Same two triangles the index buffer emits for this quad.
            for (const tri of [
              [tl, bl, tr],
              [tr, bl, br],
            ]) {
              const hit = evalTriangle(x, z, tri[0], tri[1], tri[2]);
              if (hit.outside <= 1e-9) return hit.y;
              if (hit.outside < best.outside) best = hit;
            }
          }
        }
        if (best.outside <= 1e-9) break;
      }
      return best.y;
    },

    edgeCrossings(x0, z0, x1, z1) {
      const [c0, r0] = gridCoords(x0, z0);
      const [c1, r1] = gridCoords(x1, z1);

      // Grid coordinates only narrow the search; the crossings themselves are
      // solved against the mesh's straight scene-space edges, which under a
      // warped base shape are not the same curves as the grid lines.
      const cLo = clampCell(Math.floor(Math.min(c0, c1)) - 1);
      const cHi = clampCell(Math.ceil(Math.max(c0, c1)));
      const rLo = clampCell(Math.floor(Math.min(r0, r1)) - 1);
      const rHi = clampCell(Math.ceil(Math.max(r0, r1)));

      const dx = x1 - x0;
      const dz = z1 - z0;
      const ts: number[] = [];

      for (let r = rLo; r <= rHi; r++) {
        for (let c = cLo; c <= cHi; c++) {
          const tl = r * n + c;
          const tr = tl + 1;
          const bl = tl + n;
          // Top edge, left edge and the bl–tr diagonal; taken over every cell
          // this covers each interior edge of the triangulation once.
          for (const [ia, ib] of [
            [tl, tr],
            [tl, bl],
            [bl, tr],
          ]) {
            const t = segmentHit(x0, z0, dx, dz, nodeX[ia], nodeZ[ia], nodeX[ib], nodeZ[ib]);
            if (t !== null) ts.push(t);
          }
        }
      }

      ts.sort((a, b) => a - b);
      return ts;
    },
  };
}

// ─── Build terrain geometry ───────────────────────────────────────────

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

interface TerrainBuildResult {
  mesh: THREE.Mesh;
  coordSystem: CoordSystem;
  surface: TerrainSurface;
}

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

  const indexValues: number[] = [];

  // ── Top faces ──
  for (let row = 0; row < N - 1; row++) {
    for (let col = 0; col < N - 1; col++) {
      const tl = row * N + col;
      const tr = tl + 1;
      const bl = tl + N;
      const br = bl + 1;
      indexValues.push(tl, bl, tr, tr, bl, br);
    }
  }

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

  const indexArray =
    totalVertexCount > 65535
      ? new Uint32Array(indexValues)
      : new Uint16Array(indexValues);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geo.computeVertexNormals();

  const flatShading = settings.style === 'lowpoly' || settings.style === 'layers';
  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    wireframe: settings.wireframe,
    flatShading,
    side: THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;

  return {
    mesh,
    coordSystem: cs,
    surface: createTerrainSurface(nodes.x, nodes.y, nodes.z, N, cs),
  };
}
