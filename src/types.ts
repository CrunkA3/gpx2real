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
export type WaypointShape = 'sphere' | 'cylinder' | 'box';
export type ExportFormat = 'glb' | 'stl' | 'obj';
export type ExportScope = 'all' | 'terrain' | 'tracks' | 'waypoints';

export interface TerrainSettings {
  style: TerrainStyle;
  resolution: GridResolution;
  layerCount: number;
  verticalScale: number;
  wireframe: boolean;
}

export interface TrackSettings {
  /** Offset in metres: positive = above terrain, negative = below */
  offset: number;
  /** Tube radius in metres */
  width: number;
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
