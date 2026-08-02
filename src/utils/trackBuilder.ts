import * as THREE from 'three';
import type { GPXTrack, ElevationGrid, TrackProfile } from '../types';
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
const MIN_POINT_SPACING_M = 0.75;
const MAX_POINT_SPACING_M = 20;

function buildPolylinePath(points: THREE.Vector3[]): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < points.length - 1; i++) {
    path.add(new THREE.LineCurve3(points[i], points[i + 1]));
  }
  return path;
}

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
  profile: TrackProfile,
  color?: number,
): THREE.Mesh {
  const pts: THREE.Vector3[] = [];
  const profileCenterOffset = profile === 'engraved' ? -(widthM * 0.6) : widthM;
  const minSpacing = Math.max(MIN_POINT_SPACING_M, widthM * 0.5);
  const maxSpacing = Math.max(MAX_POINT_SPACING_M, widthM * 1.5);

  const toTrackPoint = (lat: number, lon: number) => {
    const terrainEle = sampleGrid(grid, lat, lon);
    const effectiveEle = terrainEle + offsetM + profileCenterOffset;
    const [x, y, z] = geoToLocal(cs, lat, lon, effectiveEle);
    return new THREE.Vector3(x, y, z);
  };

  if (track.points.length > 0) {
    pts.push(toTrackPoint(track.points[0].lat, track.points[0].lon));
  }

  for (let i = 1; i < track.points.length; i++) {
    const prevSrc = track.points[i - 1];
    const currSrc = track.points[i];
    const prev = toTrackPoint(prevSrc.lat, prevSrc.lon);
    const curr = toTrackPoint(currSrc.lat, currSrc.lon);
    const distance = prev.distanceTo(curr);

    if (distance < minSpacing) {
      pts[pts.length - 1] = curr;
      continue;
    }

    const inserts = Math.ceil(distance / maxSpacing) - 1;
    for (let j = 1; j <= inserts; j++) {
      const t = j / (inserts + 1);
      const lat = prevSrc.lat + (currSrc.lat - prevSrc.lat) * t;
      const lon = prevSrc.lon + (currSrc.lon - prevSrc.lon) * t;
      pts.push(toTrackPoint(lat, lon));
    }

    pts.push(curr);
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

  const path =
    sampledPts.length >= 3
      ? new THREE.CatmullRomCurve3(sampledPts, false, 'centripetal', 0.5)
      : buildPolylinePath(sampledPts);
  const steps = Math.min(sampledPts.length * 4, 4000);
  const geo =
    profile === 'round'
      ? new THREE.TubeGeometry(path, steps, widthM, TUBE_SEGMENTS, false)
      : new THREE.ExtrudeGeometry(
          new THREE.Shape([
            new THREE.Vector2(-widthM, -widthM),
            new THREE.Vector2(widthM, -widthM),
            new THREE.Vector2(widthM, widthM),
            new THREE.Vector2(-widthM, widthM),
          ]),
          {
            steps,
            bevelEnabled: false,
            extrudePath: path,
          },
        );

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
  grid: ElevationGrid,
  cs: CoordSystem,
  offsetM: number,
  widthM: number,
  profile: TrackProfile,
): THREE.Mesh[] {
  return tracks.map((track, i) => buildTrackMesh(track, grid, cs, offsetM, widthM, i, profile));
}
