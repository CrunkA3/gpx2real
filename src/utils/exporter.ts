import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import type { ExportFormat, ExportScope } from '../types';

// ─── Helper: trigger browser download ────────────────────────────────

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ─── Build export scene from scope ───────────────────────────────────

function buildExportScene(
  terrainGroup: THREE.Group,
  tracksGroup: THREE.Group,
  waypointsGroup: THREE.Group,
  scope: ExportScope,
): THREE.Group {
  const exportGroup = new THREE.Group();

  if (scope === 'all' || scope === 'terrain') {
    exportGroup.add(terrainGroup.clone());
  }
  if (scope === 'all' || scope === 'tracks') {
    exportGroup.add(tracksGroup.clone());
  }
  if (scope === 'all' || scope === 'waypoints') {
    exportGroup.add(waypointsGroup.clone());
  }

  return exportGroup;
}

// ─── Main export function ────────────────────────────────────────────

export async function exportScene(
  terrainGroup: THREE.Group,
  tracksGroup: THREE.Group,
  waypointsGroup: THREE.Group,
  format: ExportFormat,
  scope: ExportScope,
): Promise<void> {
  const root = buildExportScene(terrainGroup, tracksGroup, waypointsGroup, scope);
  const filename = `gpx2real_${scope}`;

  switch (format) {
    case 'glb': {
      const exporter = new GLTFExporter();
      const result = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(
          root,
          (gltf) => resolve(gltf as ArrayBuffer),
          (err) => reject(err),
          { binary: true },
        );
      });
      downloadBlob(new Blob([result], { type: 'model/gltf-binary' }), `${filename}.glb`);
      break;
    }

    case 'stl': {
      const exporter = new STLExporter();
      const stlString = exporter.parse(root, { binary: false });
      downloadBlob(new Blob([stlString], { type: 'model/stl' }), `${filename}.stl`);
      break;
    }

    case 'obj': {
      const exporter = new OBJExporter();
      const objString = exporter.parse(root);
      downloadBlob(new Blob([objString], { type: 'model/obj' }), `${filename}.obj`);
      break;
    }
  }
}
