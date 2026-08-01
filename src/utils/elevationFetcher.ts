import type { BoundingBox, ElevationGrid, GridResolution } from '../types';

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || 'https://api.opentopodata.org/v1/srtm30m';
const BATCH_SIZE = 100;
const RATE_LIMIT_MS = 1100; // 1 request/second + buffer

interface ApiResult {
  elevation: number | null;
  location: { lat: number; lng: number };
}

function isPlaceholderApiBase(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.hostname === 'api.example.com';
  } catch {
    return false;
  }
}

// ─── Fetch a single batch of up to 100 locations ─────────────────────

async function fetchBatch(points: { lat: number; lon: number }[]): Promise<number[]> {
  if (isPlaceholderApiBase(API_BASE)) {
    throw new Error(
      'VITE_API_BASE_URL points to the placeholder api.example.com. Configure a real elevation API endpoint.',
    );
  }

  const locations = points.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join('|');
  const base = new URL(API_BASE, window.location.origin);
  base.searchParams.set('locations', locations);
  const url = base.toString();

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Elevation API request failed for ${API_BASE}: ${reason}. Check network/CORS and VITE_API_BASE_URL.`,
    );
  }

  if (!res.ok) {
    const responseText = await res.text();
    const detail = responseText.trim();
    throw new Error(
      `Elevation API error: ${res.status} ${res.statusText}${
        detail ? ` (${detail.slice(0, 200)})` : ''
      }`,
    );
  }

  const json = (await res.json()) as { results: ApiResult[]; status: string };
  if (json.status !== 'OK') {
    throw new Error(`Elevation API returned status: ${json.status}`);
  }

  return json.results.map((r) => r.elevation ?? 0);
}

// ─── Sleep helper ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── Fetch elevation grid ─────────────────────────────────────────────

/**
 * Fetches a gridSize×gridSize elevation grid covering `bbox` from Open-Topo-Data.
 * Calls `onProgress(fetched, total)` after each batch.
 */
export async function fetchElevationGrid(
  bbox: BoundingBox,
  gridSize: GridResolution,
  onProgress?: (fetched: number, total: number) => void,
): Promise<ElevationGrid> {
  const n = gridSize as number;
  const total = n * n;

  // Build grid points (row 0 = northernmost = maxLat)
  const points: { lat: number; lon: number }[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const lat = bbox.maxLat - (row / (n - 1)) * (bbox.maxLat - bbox.minLat);
      const lon = bbox.minLon + (col / (n - 1)) * (bbox.maxLon - bbox.minLon);
      points.push({ lat, lon });
    }
  }

  // Fetch in batches with rate limiting
  const elevations: number[] = [];
  let fetched = 0;

  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    const results = await fetchBatch(batch);
    elevations.push(...results);
    fetched += batch.length;
    onProgress?.(fetched, total);

    // Rate-limit between batches
    if (i + BATCH_SIZE < points.length) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Reshape to 2D array [row][col]
  const values: number[][] = [];
  for (let row = 0; row < n; row++) {
    values.push(elevations.slice(row * n, (row + 1) * n));
  }

  const flat = elevations.filter((e) => e > 0);
  const minEle = flat.length > 0 ? Math.min(...flat) : 0;
  const maxEle = flat.length > 0 ? Math.max(...flat) : 1;

  return { values, gridSize: n, bbox, minEle, maxEle };
}

// ─── Bilinear interpolation ───────────────────────────────────────────

/**
 * Returns the interpolated elevation at (lat, lon) using the grid.
 * Returns minEle if the point is outside the grid.
 */
export function sampleGrid(grid: ElevationGrid, lat: number, lon: number): number {
  const { values, gridSize: n, bbox } = grid;

  // Normalised grid coords [0..n-1]
  const col = ((lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * (n - 1);
  const row = ((bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat)) * (n - 1);

  if (col < 0 || col > n - 1 || row < 0 || row > n - 1) {
    return grid.minEle;
  }

  const c0 = Math.floor(col);
  const c1 = Math.min(c0 + 1, n - 1);
  const r0 = Math.floor(row);
  const r1 = Math.min(r0 + 1, n - 1);

  const tc = col - c0;
  const tr = row - r0;

  const h00 = values[r0][c0];
  const h10 = values[r0][c1];
  const h01 = values[r1][c0];
  const h11 = values[r1][c1];

  return h00 * (1 - tc) * (1 - tr) + h10 * tc * (1 - tr) + h01 * (1 - tc) * tr + h11 * tc * tr;
}
