// Core data types for the gpx2real application

// ─── GPX Data Types ────────────────────────────────────────────────

export interface GPXPoint {
  lat: number;
  lon: number;
  ele: number;
  time?: Date;
}

export interface GPXWaypoint extends GPXPoint {
  name?: string;
  sym?: string;
}

export interface GPXTrack {
  name: string;
  points: GPXPoint[];
}

export interface GPXData {
  tracks: GPXTrack[];
  waypoints: GPXWaypoint[];
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

// ─── Settings Types ─────────────────────────────────────────────────

export type TerrainStyle = 'original' | 'lowpoly' | 'layers';
export type GridResolution = 16 | 32 | 64;
export type BaseShape = 'square' | 'hex' | 'round';
export type WaypointShape = 'sphere' | 'cylinder' | 'box';
export type TrackProfile = 'round' | 'square' | 'engraved';
export type ExportFormat = 'glb' | 'stl' | 'obj';
export type ExportScope = 'all' | 'terrain' | 'tracks' | 'waypoints';

export interface TerrainSettings {
  style: TerrainStyle;
  resolution: GridResolution;
  layerCount: number;
  verticalScale: number;
  wireframe: boolean;
  baseShape: BaseShape;
  baseDepth: number;
}

export interface TrackSettings {
  /**
   * Vertical offset from the terrain surface: 0 = resting on it, positive =
   * hovering above, negative = sunk in. In scene units, not elevation metres,
   * so it stays constant as `verticalScale` changes.
   */
  offset: number;
  /** Half-width of the track band in metres; also its height */
  width: number;
  profile: TrackProfile;
}

export interface WaypointSettings {
  shape: WaypointShape;
  size: number;
  showLabels: boolean;
}

export interface AppSettings {
  terrain: TerrainSettings;
  track: TrackSettings;
  waypoint: WaypointSettings;
}

// ─── App State ──────────────────────────────────────────────────────

export type LoadingState =
  | { status: 'idle' }
  | { status: 'parsing' }
  | { status: 'fetching'; progress: number; total: number }
  | { status: 'ready' }
  | { status: 'error'; message: string };

// ─── Elevation Grid ─────────────────────────────────────────────────

export interface ElevationGrid {
  /** Row-major: grid[row][col], row 0 = northernmost */
  values: number[][];
  gridSize: number;
  bbox: BoundingBox;
  minEle: number;
  maxEle: number;
}
