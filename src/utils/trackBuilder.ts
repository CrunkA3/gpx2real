import * as THREE from 'three';
import type { GPXTrack, ElevationGrid } from '../types';
import type { CoordSystem } from './coordTransform';
import { geoToLocal } from './coordTransform';
import { sampleGrid } from './elevationFetcher';

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

// ─── Minimal tube segments to avoid GC pressure ──────────────────────

const TUBE_SEGMENTS = 8;

/**
 * Builds a tube mesh for a single GPX track draped over the elevation grid.
 *
 * @param track      GPX track data
 * @param grid       Elevation grid for terrain height sampling
 * @param cs         Coordinate system (centre, scale)
 * @param offsetM    Vertical offset in metres (positive = above terrain)
 * @param widthM     Tube radius in metres
 * @param color      Hex colour; undefined = auto from palette
 * @param trackIndex Index in the track list (for auto-colour)
 */
export function buildTrackMesh(
  track: GPXTrack,
  grid: ElevationGrid,
  cs: CoordSystem,
  offsetM: number,
  widthM: number,
  trackIndex: number,
  color?: number,
): THREE.Mesh {
  const pts: THREE.Vector3[] = [];

  for (const pt of track.points) {
    // Terrain height at this lat/lon
    const terrainEle = sampleGrid(grid, pt.lat, pt.lon);
    const effectiveEle = terrainEle + offsetM;

    const [x, y, z] = geoToLocal(cs, pt.lat, pt.lon, effectiveEle);
    pts.push(new THREE.Vector3(x, y, z));
  }

  if (pts.length < 2) {
    // Fallback: return empty mesh
    return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  }

  // Downsample very long tracks to avoid excessive geometry
  const maxPoints = 2000;
  let sampledPts = pts;
  if (pts.length > maxPoints) {
    const step = Math.ceil(pts.length / maxPoints);
    sampledPts = pts.filter((_, i) => i % step === 0);
    // Always include last point
    if (sampledPts[sampledPts.length - 1] !== pts[pts.length - 1]) {
      sampledPts.push(pts[pts.length - 1]);
    }
  }

  const curve = new THREE.CatmullRomCurve3(sampledPts, false, 'catmullrom', 0.5);
  const tubeSegments = Math.min(sampledPts.length * 4, 4000);
  const geo = new THREE.TubeGeometry(curve, tubeSegments, widthM, TUBE_SEGMENTS, false);

  const c = color ?? TRACK_COLORS[trackIndex % TRACK_COLORS.length];
  const mat = new THREE.MeshPhongMaterial({
    color: c,
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
  grid: ElevationGrid,
  cs: CoordSystem,
  offsetM: number,
  widthM: number,
): THREE.Mesh[] {
  return tracks.map((track, i) => buildTrackMesh(track, grid, cs, offsetM, widthM, i));
}
