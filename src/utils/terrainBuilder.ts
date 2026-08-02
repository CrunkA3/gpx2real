import * as THREE from 'three';
import type { ElevationGrid, TerrainSettings } from '../types';
import { buildCoordSystem, geoToLocal, type CoordSystem } from './coordTransform';

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

// ─── Build terrain geometry ───────────────────────────────────────────

interface TerrainBuildResult {
  mesh: THREE.Mesh;
  coordSystem: CoordSystem;
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
  const baseY = -Math.max(settings.baseDepth, 1);

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
    indexValues.push(aTop, aBottom, bTop, bTop, aBottom, bBottom);
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

  return { mesh, coordSystem: cs };
}
