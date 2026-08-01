import type { GPXData, GPXPoint, GPXWaypoint, GPXTrack, BoundingBox } from '../types';

// ─── GPX Parser ─────────────────────────────────────────────────────

function parsePoint(el: Element): GPXPoint {
  const latStr = el.getAttribute('lat');
  const lonStr = el.getAttribute('lon');
  const lat = latStr != null ? Number(latStr) : NaN;
  const lon = lonStr != null ? Number(lonStr) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Invalid GPX file: point missing or invalid lat/lon');
  }
  const eleEl = el.querySelector('ele');
  const timeEl = el.querySelector('time');
  return {
    lat,
    lon,
    ele: eleEl ? parseFloat(eleEl.textContent ?? '0') : 0,
    time: timeEl && timeEl.textContent ? new Date(timeEl.textContent) : undefined,
  };
}

export function parseGPX(content: string): GPXData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid GPX file: ' + (parseError.textContent ?? 'unknown XML error'));
  }

  // ── Waypoints ──
  const waypoints: GPXWaypoint[] = Array.from(doc.querySelectorAll('wpt')).map((wpt) => ({
    ...parsePoint(wpt),
    name: wpt.querySelector('name')?.textContent ?? undefined,
    sym: wpt.querySelector('sym')?.textContent ?? undefined,
  }));

  // ── Tracks ──
  const tracks: GPXTrack[] = [];

  doc.querySelectorAll('trk').forEach((trk) => {
    const name = trk.querySelector('name')?.textContent ?? 'Track';
    const points: GPXPoint[] = Array.from(trk.querySelectorAll('trkpt')).map(parsePoint);
    if (points.length > 0) tracks.push({ name, points });
  });

  // ── Routes (treated as tracks) ──
  doc.querySelectorAll('rte').forEach((rte) => {
    const name = rte.querySelector('name')?.textContent ?? 'Route';
    const points: GPXPoint[] = Array.from(rte.querySelectorAll('rtept')).map(parsePoint);
    if (points.length > 0) tracks.push({ name, points });
  });

  if (tracks.length === 0 && waypoints.length === 0) {
    throw new Error('No tracks or waypoints found in GPX file.');
  }

  return { tracks, waypoints };
}

// ─── Bounding Box ────────────────────────────────────────────────────

export function computeBoundingBox(data: GPXData, paddingFraction = 0.1): BoundingBox {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;

  const all = [...data.tracks.flatMap((t) => t.points), ...data.waypoints];

  for (const pt of all) {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lon < minLon) minLon = pt.lon;
    if (pt.lon > maxLon) maxLon = pt.lon;
  }

  const latPad = (maxLat - minLat) * paddingFraction;
  const lonPad = (maxLon - minLon) * paddingFraction;
  const pad = Math.max(latPad, lonPad, 0.002); // minimum ~200m padding

  return {
    minLat: minLat - pad,
    maxLat: maxLat + pad,
    minLon: minLon - pad,
    maxLon: maxLon + pad,
  };
}

/** Returns the min/max elevation from all track points that have non-zero elevation */
export function getElevationRange(data: GPXData): { min: number; max: number } | null {
  const eles = [...data.tracks.flatMap((t) => t.points), ...data.waypoints]
    .map((p) => p.ele)
    .filter((e) => e > 0);
  if (eles.length === 0) return null;
  return { min: Math.min(...eles), max: Math.max(...eles) };
}
