import type { AppSettings, GridResolution, TerrainStyle, WaypointShape } from '../types';

interface Props {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
}

// ─── Small helper components ─────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel-section">
      <h3 className="section-title">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="control-row">
      <label>{label}</label>
      {children}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────

export default function ControlPanel({ settings, onChange }: Props) {
  const set = <K extends keyof AppSettings>(key: K) =>
    (next: Partial<AppSettings[K]>) =>
      onChange({ ...settings, [key]: { ...settings[key], ...next } });

  const setTerrain = set('terrain');
  const setTrack = set('track');
  const setWaypoint = set('waypoint');

  return (
    <div className="control-panel">
      {/* ── Terrain ── */}
      <Section title="🏔 Terrain">
        <Row label="Style">
          <select
            value={settings.terrain.style}
            onChange={(e) => setTerrain({ style: e.target.value as TerrainStyle })}
          >
            <option value="original">Original (smooth)</option>
            <option value="lowpoly">Low-poly</option>
            <option value="layers">Layers / Contour</option>
          </select>
        </Row>

        {settings.terrain.style === 'layers' && (
          <Row label={`Layers: ${settings.terrain.layerCount}`}>
            <input
              type="range"
              min={3}
              max={20}
              step={1}
              value={settings.terrain.layerCount}
              onChange={(e) => setTerrain({ layerCount: Number(e.target.value) })}
            />
          </Row>
        )}

        <Row label="Resolution">
          <select
            value={settings.terrain.resolution}
            onChange={(e) => setTerrain({ resolution: Number(e.target.value) as GridResolution })}
          >
            <option value={16}>16×16 (fast)</option>
            <option value={32}>32×32 (default)</option>
            <option value={64}>64×64 (detailed)</option>
          </select>
        </Row>

        <Row label={`V-Scale: ${settings.terrain.verticalScale.toFixed(1)}×`}>
          <input
            type="range"
            min={0.1}
            max={5}
            step={0.1}
            value={settings.terrain.verticalScale}
            onChange={(e) => setTerrain({ verticalScale: Number(e.target.value) })}
          />
        </Row>

        <Row label="Wireframe">
          <input
            type="checkbox"
            checked={settings.terrain.wireframe}
            onChange={(e) => setTerrain({ wireframe: e.target.checked })}
          />
        </Row>
      </Section>

      {/* ── Tracks ── */}
      <Section title="🛤 Tracks">
        <Row label={`Offset: ${settings.track.offset > 0 ? '+' : ''}${settings.track.offset} m`}>
          <input
            type="range"
            min={-50}
            max={50}
            step={1}
            value={settings.track.offset}
            onChange={(e) => setTrack({ offset: Number(e.target.value) })}
          />
        </Row>

        <Row label={`Width: ${settings.track.width} m`}>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={settings.track.width}
            onChange={(e) => setTrack({ width: Number(e.target.value) })}
          />
        </Row>
      </Section>

      {/* ── Waypoints ── */}
      <Section title="📍 Waypoints">
        <Row label="Shape">
          <select
            value={settings.waypoint.shape}
            onChange={(e) => setWaypoint({ shape: e.target.value as WaypointShape })}
          >
            <option value="sphere">Sphere / Circle</option>
            <option value="cylinder">Cylinder / Pin</option>
            <option value="box">Box / Square</option>
          </select>
        </Row>

        <Row label={`Size: ${settings.waypoint.size} m`}>
          <input
            type="range"
            min={5}
            max={200}
            step={5}
            value={settings.waypoint.size}
            onChange={(e) => setWaypoint({ size: Number(e.target.value) })}
          />
        </Row>

        <Row label="Labels">
          <input
            type="checkbox"
            checked={settings.waypoint.showLabels}
            onChange={(e) => setWaypoint({ showLabels: e.target.checked })}
          />
        </Row>
      </Section>
    </div>
  );
}
