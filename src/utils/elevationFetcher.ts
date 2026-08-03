import type { BoundingBox, ElevationGrid, GridResolution } from '../types';

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || '/elevation/v1/srtm30m';
const BATCH_SIZE = 100;
const RATE_LIMIT_MS = 1100; // 1 request/second + buffer
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_STORAGE_KEY = 'gpx2real:elevation-cache:v1';

interface ApiResult {
  elevation: number | null;
  location: { lat: number; lng: number };
}

interface CachedElevation {
  elevation: number;
  timestamp: number;
}

function getPointKey(lat: number, lon: number): string {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function loadCache(): Map<string, CachedElevation> {
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, CachedElevation>;
    const now = Date.now();
    const entries = Object.entries(parsed).filter(([, value]) => (
      Number.isFinite(value?.timestamp)
      && Number.isFinite(value?.elevation)
      && now - value.timestamp < CACHE_TTL_MS
    ));
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function saveCache(cache: Map<string, CachedElevation>): void {
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache.entries())));
  } catch {
    // Ignore storage write failures
  }
}

function isPlaceholderApiBase(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.hostname === 'api.example.com';
  } catch {
    return false;
  }
}

function isValidApiBase(url: string): boolean {
  if (url.startsWith('/')) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── Fetch a single batch of up to 100 locations ─────────────────────

async function fetchBatch(
  points: { lat: number; lon: number }[],
  cache: Map<string, CachedElevation>,
): Promise<number[]> {
  const now = Date.now();
  const cachedValues: (number | null)[] = new Array(points.length).fill(null);
  const missingPoints: { lat: number; lon: number }[] = [];
  const missingIndexes: number[] = [];

  points.forEach((point, index) => {
    const key = getPointKey(point.lat, point.lon);
    const cached = cache.get(key);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      cachedValues[index] = cached.elevation;
      return;
    }
    missingPoints.push(point);
    missingIndexes.push(index);
  });

  if (missingPoints.length === 0) {
    return cachedValues.map((value) => value ?? 0);
  }

  if (isPlaceholderApiBase(API_BASE)) {
    throw new Error(
      'VITE_API_BASE_URL points to the placeholder api.example.com. Configure a real elevation API endpoint.',
    );
  }
  if (!isValidApiBase(API_BASE)) {
    throw new Error(
      'VITE_API_BASE_URL must be an absolute URL (scheme://) or a root-relative path starting with "/".',
    );
  }

  const locations = missingPoints.map((p) => getPointKey(p.lat, p.lon)).join('|');
  const base = new URL(API_BASE, window.location.origin);
  base.searchParams.set('locations', locations);
  const url = base.toString();

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Elevation API request failed for ${API_BASE}: ${reason}. Check network/proxy and VITE_API_BASE_URL.`,
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

  if (json.results.length !== missingPoints.length) {
    throw new Error(
      `Elevation API returned ${json.results.length} points, expected ${missingPoints.length}.`,
    );
  }

  json.results.forEach((result, idx) => {
    const missingPoint = missingPoints[idx];
    const elevation = result.elevation ?? 0;
    const key = getPointKey(missingPoint.lat, missingPoint.lon);
    cachedValues[missingIndexes[idx]] = elevation;
    cache.set(key, { elevation, timestamp: now });
  });

  return cachedValues.map((value) => value ?? 0);
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
  const cache = loadCache();

  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    const results = await fetchBatch(batch, cache);
    elevations.push(...results);
    fetched += batch.length;
    onProgress?.(fetched, total);

    // Rate-limit between batches
    if (i + BATCH_SIZE < points.length) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Persist the pruned cache even when all points were served from cache
  saveCache(cache);

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

// Note: there is deliberately no sampler for the raw grid here. Anything that
// has to sit on the terrain must go through `TerrainSurface` in terrainBuilder,
// which samples the surface that is actually rendered.
