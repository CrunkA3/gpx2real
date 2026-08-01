/**
 * Coordinate transformation utilities.
 *
 * Local coordinate system:
 *   origin  = centre of the bounding box
 *   X axis  = East (metres)
 *   Y axis  = Up / Elevation (metres above minEle)
 *   Z axis  = South (metres, so northward = negative Z)
 */

export interface CoordSystem {
  centerLat: number;
  centerLon: number;
  /** metres per degree of latitude */
  mPerDegLat: number;
  /** metres per degree of longitude */
  mPerDegLon: number;
  minEle: number;
  verticalScale: number;
}

export function buildCoordSystem(
  centerLat: number,
  centerLon: number,
  minEle: number,
  verticalScale: number,
): CoordSystem {
  const mPerDegLat = 110540;
  const mPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return { centerLat, centerLon, mPerDegLat, mPerDegLon, minEle, verticalScale };
}

/** Convert geographic coordinates to Three.js XYZ. */
export function geoToLocal(
  cs: CoordSystem,
  lat: number,
  lon: number,
  ele: number,
): [number, number, number] {
  const x = (lon - cs.centerLon) * cs.mPerDegLon;
  const z = -(lat - cs.centerLat) * cs.mPerDegLat; // North = negative Z
  const y = (ele - cs.minEle) * cs.verticalScale;
  return [x, y, z];
}
