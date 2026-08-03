import { useState, useRef, useCallback } from 'react';
import Viewer3D, { type Viewer3DHandle } from './components/Viewer3D';
import ControlPanel from './components/ControlPanel';
import ExportPanel from './components/ExportPanel';
import { parseGPX, computeBoundingBox } from './utils/gpxParser';
import { fetchElevationGrid } from './utils/elevationFetcher';
import { exportScene } from './utils/exporter';
import type {
  AppSettings,
  ElevationGrid,
  LoadingState,
  ExportFormat,
  ExportScope,
  GPXData,
} from './types';
import './App.css';

// ─── Default settings ─────────────────────────────────────────────────

const DEFAULT_SETTINGS: AppSettings = {
  terrain: {
    style: 'original',
    resolution: 32,
    layerCount: 8,
    verticalScale: 1.0,
    wireframe: false,
    baseShape: 'square',
    baseDepth: 120,
  },
  track: {
    offset: 0,
    width: 10,
    profile: 'square',
  },
  waypoint: {
    shape: 'sphere',
    size: 30,
    showLabels: true,
  },
};

// ─── App ──────────────────────────────────────────────────────────────

export default function App() {
  const [gpxData, setGpxData] = useState<GPXData | null>(null);
  const [grid, setGrid] = useState<ElevationGrid | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState<LoadingState>({ status: 'idle' });
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const viewerRef = useRef<Viewer3DHandle>(null);

  // ── File upload ──
  const handleFile = useCallback(async (file: File) => {
    setLoading({ status: 'parsing' });
    setGpxData(null);
    setGrid(null);

    try {
      const text = await file.text();
      const data = parseGPX(text);
      setGpxData(data);

      const bbox = computeBoundingBox(data);

      setLoading({ status: 'fetching', progress: 0, total: settings.terrain.resolution ** 2 });

      const elevGrid = await fetchElevationGrid(bbox, settings.terrain.resolution, (prog, tot) => {
        setLoading({ status: 'fetching', progress: prog, total: tot });
      });

      setGrid(elevGrid);
      setLoading({ status: 'ready' });
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      console.error('[gpx2real] Failed to load GPX file', {
        fileName: file.name,
        fileSize: file.size,
        resolution: settings.terrain.resolution,
        error: err,
      });
      setLoading({ status: 'error', message });
    }
  }, [settings.terrain.resolution]);

  // ── Re-fetch terrain with new resolution ──
  const handleReloadTerrain = useCallback(async () => {
    if (!gpxData) return;
    const bbox = computeBoundingBox(gpxData);
    setLoading({ status: 'fetching', progress: 0, total: settings.terrain.resolution ** 2 });
    try {
      const elevGrid = await fetchElevationGrid(bbox, settings.terrain.resolution, (p, t) => {
        setLoading({ status: 'fetching', progress: p, total: t });
      });
      setGrid(elevGrid);
      setLoading({ status: 'ready' });
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      console.error('[gpx2real] Failed to reload terrain', {
        resolution: settings.terrain.resolution,
        error: err,
      });
      setLoading({ status: 'error', message });
    }
  }, [gpxData, settings.terrain.resolution]);

  // ── Export ──
  const handleExport = useCallback(
    async (format: ExportFormat, scope: ExportScope) => {
      if (!viewerRef.current) return;
      const { getTerrainGroup, getTracksGroup, getWaypointsGroup } = viewerRef.current;
      await exportScene(getTerrainGroup(), getTracksGroup(), getWaypointsGroup(), format, scope);
    },
    [],
  );

  // ── Drop zone ──
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const isReady = loading.status === 'ready';
  const isBusy = loading.status === 'parsing' || loading.status === 'fetching';

  return (
    <div className="app">
      {/* ── Top bar ── */}
      <header className="top-bar">
        <div className="brand">
          <span className="brand-icon">🗺</span>
          <span className="brand-name">gpx2real</span>
          <span className="brand-sub">3D GPX Terrain Viewer</span>
        </div>

        <div className="top-bar-actions">
          <label className="upload-btn" aria-disabled={isBusy}>
            {isBusy ? 'Loading…' : '📂 Open GPX'}
            <input
              type="file"
              accept=".gpx"
              style={{ display: 'none' }}
              disabled={isBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
            />
          </label>

          {isReady && (
            <button
              className="reload-btn"
              onClick={handleReloadTerrain}
              title="Re-fetch elevation at current resolution"
            >
              🔄 Reload Terrain
            </button>
          )}

          <button
            className="toggle-btn"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Toggle sidebar"
          >
            {sidebarOpen ? '⟨' : '⟩'}
          </button>
        </div>
      </header>

      {/* ── Main layout ── */}
      <div className="main-layout">
        {/* ── Sidebar ── */}
        {sidebarOpen && (
          <aside className="sidebar">
            <ControlPanel settings={settings} onChange={setSettings} />
            <ExportPanel onExport={handleExport} disabled={!isReady} />
          </aside>
        )}

        {/* ── 3D Viewport ── */}
        <main
          className="viewport"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <Viewer3D ref={viewerRef} gpxData={gpxData} grid={grid} settings={settings} />

          {/* ── Overlay states ── */}
          {loading.status === 'idle' && (
            <div className="overlay">
              <div className="drop-zone">
                <div className="drop-icon">🗺</div>
                <p>Drop a <strong>.gpx</strong> file here</p>
                <p className="hint">or use the "Open GPX" button above</p>
              </div>
            </div>
          )}

          {loading.status === 'parsing' && (
            <div className="overlay">
              <div className="spinner-box">
                <div className="spinner" />
                <p>Parsing GPX…</p>
              </div>
            </div>
          )}

          {loading.status === 'fetching' && (
            <div className="overlay">
              <div className="spinner-box">
                <div className="spinner" />
                <p>Fetching elevation data…</p>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${(loading.progress / loading.total) * 100}%` }}
                  />
                </div>
                <p className="hint">{loading.progress} / {loading.total} points</p>
              </div>
            </div>
          )}

          {loading.status === 'error' && (
            <div className="overlay">
              <div className="error-box">
                <p>⚠ Error</p>
                <p className="error-msg">{loading.message}</p>
                <button onClick={() => setLoading({ status: 'idle' })}>Dismiss</button>
              </div>
            </div>
          )}

          {/* ── Camera hint ── */}
          {isReady && (
            <div className="camera-hint">
              🖱 Drag to orbit · Scroll to zoom · Right-drag to pan
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
