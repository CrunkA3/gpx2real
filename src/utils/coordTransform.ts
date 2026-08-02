import type { BaseShape, BoundingBox } from '../types';

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
  bbox: BoundingBox;
  halfWidthM: number;
  halfDepthM: number;
  baseShape: BaseShape;
}

export function buildCoordSystem(
  centerLat: number,
  centerLon: number,
  minEle: number,
  verticalScale: number,
  bbox: BoundingBox,
  baseShape: BaseShape,
): CoordSystem {
  const mPerDegLat = 110540;
  const mPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const halfWidthM = ((bbox.maxLon - bbox.minLon) * mPerDegLon) / 2 || 1;
  const halfDepthM = ((bbox.maxLat - bbox.minLat) * mPerDegLat) / 2 || 1;
  return {
    centerLat,
    centerLon,
    mPerDegLat,
    mPerDegLon,
    minEle,
    verticalScale,
    bbox,
    halfWidthM,
    halfDepthM,
    baseShape,
  };
}

function boundaryScaleForHex(angle: number): number {
  const sector = Math.PI / 3;
  const shifted = ((angle + Math.PI) % sector + sector) % sector - sector / 2;
  return Math.cos(Math.PI / 6) / Math.max(Math.cos(shifted), 1e-9);
}

function projectToBaseShape(nx: number, nz: number, shape: BaseShape): [number, number] {
  if (shape === 'square') return [nx, nz];

  const radial = Math.max(Math.abs(nx), Math.abs(nz));
  if (radial < 1e-6) return [0, 0];

  const angle = Math.atan2(nz, nx);
  const boundaryScale = shape === 'round' ? 1 : boundaryScaleForHex(angle);
  const r = radial * boundaryScale;
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

/** Convert geographic coordinates to Three.js XYZ. */
export function geoToLocal(
  cs: CoordSystem,
  lat: number,
  lon: number,
  ele: number,
): [number, number, number] {
  const nx = ((lon - cs.centerLon) * cs.mPerDegLon) / cs.halfWidthM;
  const nz = (-(lat - cs.centerLat) * cs.mPerDegLat) / cs.halfDepthM; // North = negative Z
  const [sx, sz] = projectToBaseShape(nx, nz, cs.baseShape);
  const x = sx * cs.halfWidthM;
  const z = sz * cs.halfDepthM;
  const y = (ele - cs.minEle) * cs.verticalScale;
  return [x, y, z];
}
