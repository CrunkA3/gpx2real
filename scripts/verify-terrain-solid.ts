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
