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
