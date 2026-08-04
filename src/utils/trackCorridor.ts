import type { GPXTrack } from '../types';
import { geoToLocal, type CoordSystem } from './coordTransform';

/** A point on the horizontal plane of the scene. */
export interface Vec2 {
  x: number;
  z: number;
}

/** GPS points closer than this to their predecessor are jitter, not detail. */
const MIN_POINT_SPACING = 0.75;

/** Track points as scene XZ, with GPS jitter removed. */
export function cleanCenterLine(track: GPXTrack, cs: CoordSystem): Vec2[] {
  const out: Vec2[] = [];
  for (const p of track.points) {
    const [x, , z] = geoToLocal(cs, p.lat, p.lon, 0);
    const prev = out[out.length - 1];
    if (prev && Math.hypot(x - prev.x, z - prev.z) < MIN_POINT_SPACING) continue;
    out.push({ x, z });
  }
  return out;
}

/**
 * Where the tracks run, as a scene-space field the terrain builder can emboss.
 *
 * Deliberately independent of any mesh: the corridor is an *input* to building
 * the terrain surface, so it cannot depend on one.
 */
export interface Corridor {
  /** Half-width of the flat floor. */
  readonly halfWidth: number;
  /** Width of the ramp from floor level back up to untouched terrain. */
  readonly wallWidth: number;
  /** 1 on the floor, 0 outside, linear across the wall. */
  sink(x: number, z: number): number;
}

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

function distanceSqToSegment(px: number, pz: number, s: Segment): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const lenSq = dx * dx + dz * dz;
  const raw = lenSq > 0 ? ((px - s.ax) * dx + (pz - s.az) * dz) / lenSq : 0;
  const t = Math.max(0, Math.min(1, raw));
  const ex = s.ax + dx * t - px;
  const ez = s.az + dz * t - pz;
  return ex * ex + ez * ez;
}

export function buildCorridor(
  tracks: GPXTrack[],
  cs: CoordSystem,
  halfWidth: number,
  wallWidth: number,
): Corridor | null {
  const reach = halfWidth + wallWidth;
  // One bucket per query radius: a segment within `reach` of a point is then
  // always in that point's 3x3 bucket neighbourhood.
  const bucketSize = Math.max(reach, 1e-3);
  const buckets = new Map<string, Segment[]>();
  let segmentCount = 0;

  const add = (seg: Segment) => {
    const minC = Math.floor(Math.min(seg.ax, seg.bx) / bucketSize);
    const maxC = Math.floor(Math.max(seg.ax, seg.bx) / bucketSize);
    const minR = Math.floor(Math.min(seg.az, seg.bz) / bucketSize);
    const maxR = Math.floor(Math.max(seg.az, seg.bz) / bucketSize);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const key = `${c},${r}`;
        const list = buckets.get(key);
        if (list) list.push(seg);
        else buckets.set(key, [seg]);
      }
    }
    segmentCount++;
  };

  for (const track of tracks) {
    const line = cleanCenterLine(track, cs);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      // Split long pieces, so no bucket holds a segment whose bounding box
      // reaches far past the segment itself.
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / bucketSize));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        add({
          ax: a.x + (b.x - a.x) * t0,
          az: a.z + (b.z - a.z) * t0,
          bx: a.x + (b.x - a.x) * t1,
          bz: a.z + (b.z - a.z) * t1,
        });
      }
    }
  }

  if (segmentCount === 0) return null;

  return {
    halfWidth,
    wallWidth,

    sink(x, z) {
      const c0 = Math.floor(x / bucketSize);
      const r0 = Math.floor(z / bucketSize);
      let bestSq = Infinity;
      for (let r = r0 - 1; r <= r0 + 1; r++) {
        for (let c = c0 - 1; c <= c0 + 1; c++) {
          const list = buckets.get(`${c},${r}`);
          if (!list) continue;
          for (const seg of list) {
            const d2 = distanceSqToSegment(x, z, seg);
            if (d2 < bestSq) bestSq = d2;
          }
        }
      }
      if (bestSq === Infinity) return 0;

      const d = Math.sqrt(bestSq);
      if (d <= halfWidth) return 1;
      if (d >= reach) return 0;
      return 1 - (d - halfWidth) / wallWidth;
    },
  };
}
