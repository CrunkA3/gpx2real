import { useState } from 'react';
import type { ExportFormat, ExportScope } from '../types';

interface Props {
  onExport: (format: ExportFormat, scope: ExportScope) => Promise<void>;
  disabled: boolean;
}

export default function ExportPanel({ onExport, disabled }: Props) {
  const [format, setFormat] = useState<ExportFormat>('glb');
  const [scope, setScope] = useState<ExportScope>('all');
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      await onExport(format, scope);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="export-panel">
      <h3 className="section-title">📦 Export</h3>

      <div className="control-row">
        <label>Format</label>
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportFormat)}
          disabled={disabled || exporting}
        >
          <option value="glb">GLB (GLTF binary)</option>
          <option value="stl">STL (3D printing)</option>
          <option value="obj">OBJ (universal)</option>
        </select>
      </div>

      <div className="control-row">
        <label>Include</label>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as ExportScope)}
          disabled={disabled || exporting}
        >
          <option value="all">Everything</option>
          <option value="terrain">Terrain only</option>
          <option value="tracks">Tracks only</option>
          <option value="waypoints">Waypoints only</option>
        </select>
      </div>

      <button
        className="export-btn"
        onClick={handleExport}
        disabled={disabled || exporting}
      >
        {exporting ? 'Exporting…' : '⬇ Download'}
      </button>
    </div>
  );
}
