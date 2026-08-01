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
  const cs = buildCoordSystem(centerLat, centerLon, minEle, settings.verticalScale);

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
  const vertexCount = N * N;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  const eleRange = maxEle - minEle || 1;

  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      const lat = bbox.maxLat - (row / (N - 1)) * (bbox.maxLat - bbox.minLat);
      const lon = bbox.minLon + (col / (N - 1)) * (bbox.maxLon - bbox.minLon);
      const ele = styledEle[idx];

      const [x, y, z] = geoToLocal(cs, lat, lon, ele);

      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;

      uvs[idx * 2] = col / (N - 1);
      uvs[idx * 2 + 1] = 1 - row / (N - 1);

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

      colors[idx * 3] = c.r;
      colors[idx * 3 + 1] = c.g;
      colors[idx * 3 + 2] = c.b;
    }
  }

  // ── Indices ──
  const faceCount = (N - 1) * (N - 1) * 2;
  const indices = new Uint32Array(faceCount * 3);
  let fi = 0;
  for (let row = 0; row < N - 1; row++) {
    for (let col = 0; col < N - 1; col++) {
      const tl = row * N + col;
      const tr = tl + 1;
      const bl = tl + N;
      const br = bl + 1;
      // Two triangles per quad (wound consistently)
      indices[fi++] = tl;
      indices[fi++] = bl;
      indices[fi++] = tr;
      indices[fi++] = tr;
      indices[fi++] = bl;
      indices[fi++] = br;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
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
