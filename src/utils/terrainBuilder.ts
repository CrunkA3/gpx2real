import * as THREE from 'three';
import type { ElevationGrid, TerrainSettings } from '../types';
import {
  buildCoordSystem,
  geoToLocal,
  localToNormalized,
  type CoordSystem,
} from './coordTransform';

// ─── Colour helpers ───────────────────────────────────────────────────

/** Maps a normalised value [0,1] to a terrain colour (low→high: green→brown→white). */
function elevationColor(t: number): THREE.Color {
  if (t < 0.3) {
    // green → yellow-green
    return new THREE.Color().setHSL(0.28 - t * 0.1, 0.6, 0.35 + t * 0.2);
  } else if (t < 0.7) {
    // brown range
    return new THREE.Color().setHSL(0.08 - (t - 0.3) * 0.05, 0.5, 0.4 + (t - 0.3) * 0.1);
  } else {
    // brown → white
    const s = (t - 0.7) / 0.3;
    return new THREE.Color().lerpColors(
      new THREE.Color(0.55, 0.4, 0.3),
      new THREE.Color(0.95, 0.95, 0.95),
      s,
    );
  }
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

    return {
      y: wa * nodeY[ia] + wb * nodeY[ib] + wc * nodeY[ic],
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

interface TerrainBuildResult {
  mesh: THREE.Mesh;
  coordSystem: CoordSystem;
  surface: TerrainSurface;
}

export function buildTerrainMesh(
  grid: ElevationGrid,
  settings: TerrainSettings,
): TerrainBuildResult {
  const { values, gridSize: n, bbox, minEle, maxEle } = grid;

  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const cs = buildCoordSystem(
    centerLat,
    centerLon,
    minEle,
    settings.verticalScale,
    bbox,
    settings.baseShape,
  );

  // ── Choose effective resolution based on style ──
  const effectiveN = settings.style === 'lowpoly' ? Math.max(8, Math.floor(n / 4)) : n;

  // ── Sample elevation values at the effective resolution ──
  const rawEle: number[] = [];
  for (let row = 0; row < effectiveN; row++) {
    for (let col = 0; col < effectiveN; col++) {
      // Map effective grid coords back to original grid coords
      const srcRow = Math.round((row / (effectiveN - 1)) * (n - 1));
      const srcCol = Math.round((col / (effectiveN - 1)) * (n - 1));
      rawEle.push(values[srcRow][srcCol]);
    }
  }

  // ── Apply style-specific elevation modification ──
  const styledEle =
    settings.style === 'layers'
      ? applyLayersStyle(rawEle, minEle, maxEle, settings.layerCount)
      : rawEle;

  // ── Build BufferGeometry ──
  const N = effectiveN;
  const topVertexCount = N * N;
  const totalVertexCount = topVertexCount * 2;
  const positions = new Float32Array(totalVertexCount * 3);
  const colors = new Float32Array(totalVertexCount * 3);

  const eleRange = maxEle - minEle || 1;
const baseY = -Math.max(settings.baseDepth, 1) * settings.verticalScale;

  // Top-surface node positions, kept for TerrainSurface so it interpolates the
  // very same triangles that get drawn.
  const nodeX = new Float64Array(topVertexCount);
  const nodeY = new Float64Array(topVertexCount);
  const nodeZ = new Float64Array(topVertexCount);

  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      const lat = bbox.maxLat - (row / (N - 1)) * (bbox.maxLat - bbox.minLat);
      const lon = bbox.minLon + (col / (N - 1)) * (bbox.maxLon - bbox.minLon);
      const ele = styledEle[idx];

      const [x, y, z] = geoToLocal(cs, lat, lon, ele);

      const topPos = idx * 3;
      const bottomIdx = idx + topVertexCount;
      const bottomPos = bottomIdx * 3;

      positions[topPos] = x;
      positions[topPos + 1] = y;
      positions[topPos + 2] = z;

      nodeX[idx] = x;
      nodeY[idx] = y;
      nodeZ[idx] = z;

      positions[bottomPos] = x;
      positions[bottomPos + 1] = baseY;
      positions[bottomPos + 2] = z;

      // ── Per-vertex colour ──
      let c: THREE.Color;
      if (settings.style === 'layers') {
        const layerIdx = Math.floor(((ele - minEle) / eleRange) * settings.layerCount);
        const paletteIdx = Math.min(layerIdx, LAYER_PALETTE.length - 1);
        c = new THREE.Color(LAYER_PALETTE[paletteIdx]);
      } else {
        const t = Math.max(0, Math.min(1, (ele - minEle) / eleRange));
        c = elevationColor(t);
      }

      colors[topPos] = c.r;
      colors[topPos + 1] = c.g;
      colors[topPos + 2] = c.b;

      colors[bottomPos] = c.r * 0.45;
      colors[bottomPos + 1] = c.g * 0.45;
      colors[bottomPos + 2] = c.b * 0.45;
    }
  }

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

  // ── Bottom faces (reversed winding) ──
  for (let row = 0; row < N - 1; row++) {
    for (let col = 0; col < N - 1; col++) {
      const tl = row * N + col + topVertexCount;
      const tr = tl + 1;
      const bl = tl + N;
      const br = bl + 1;
      indexValues.push(tl, tr, bl, tr, br, bl);
    }
  }

  // ── Side walls along the outer ring ──
  const perimeter: number[] = [];
  for (let col = 0; col < N; col++) perimeter.push(col);
  for (let row = 1; row < N; row++) perimeter.push(row * N + (N - 1));
  for (let col = N - 2; col >= 0; col--) perimeter.push((N - 1) * N + col);
  for (let row = N - 2; row > 0; row--) perimeter.push(row * N);

  for (let i = 0; i < perimeter.length; i++) {
    const aTop = perimeter[i];
    const bTop = perimeter[(i + 1) % perimeter.length];
    const aBottom = aTop + topVertexCount;
    const bBottom = bTop + topVertexCount;
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
    surface: createTerrainSurface(nodeX, nodeY, nodeZ, N, cs),
  };
}
