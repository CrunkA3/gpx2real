import * as THREE from 'three';
import type { GPXWaypoint, WaypointSettings } from '../types';
import type { CoordSystem } from './coordTransform';
import { geoToLocal } from './coordTransform';
import type { TerrainSurface } from './terrainBuilder';

// ─── Waypoint Mesh Builder ────────────────────────────────────────────

const WAYPOINT_COLOR = 0xffd700; // gold

function makeGeometry(shape: WaypointSettings['shape'], size: number): THREE.BufferGeometry {
  switch (shape) {
    case 'sphere':
      return new THREE.SphereGeometry(size, 16, 12);
    case 'cylinder':
      return new THREE.CylinderGeometry(size * 0.5, size * 0.5, size * 2, 12);
    case 'box':
      return new THREE.BoxGeometry(size * 1.5, size * 1.5, size * 1.5);
    default: {
      const _exhaustive: never = shape;
      throw new Error(`Unsupported waypoint shape: ${_exhaustive}`);
    }
  }
}

/** Distance from a shape's origin to its underside, so it rests on the ground. */
function halfHeight(shape: WaypointSettings['shape'], size: number): number {
  switch (shape) {
    case 'sphere':
      return size;
    case 'cylinder':
      return size;
    case 'box':
      return size * 0.75;
    default: {
      const _exhaustive: never = shape;
      throw new Error(`Unsupported waypoint shape: ${_exhaustive}`);
    }
  }
}

/**
 * Builds a Three.js group containing one mesh per waypoint.
 * Each mesh is placed on the terrain surface (+ small vertical offset for visibility).
 */
export function buildWaypointMeshes(
  waypoints: GPXWaypoint[],
  surface: TerrainSurface,
  cs: CoordSystem,
  settings: WaypointSettings,
  trackOffset: number,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'waypoints';

  const mat = new THREE.MeshPhongMaterial({
    color: WAYPOINT_COLOR,
    emissive: 0x886600,
    shininess: 100,
  });

  for (const wp of waypoints) {
    const [x, , z] = geoToLocal(cs, wp.lat, wp.lon, 0);
    // Sizes and the track offset are scene units, so they must not go through
    // geoToLocal — that would scale them by verticalScale on the Y axis alone.
    const y = surface.sampleY(x, z) + trackOffset + halfHeight(settings.shape, settings.size);

    const geo = makeGeometry(settings.shape, settings.size);
    const mesh = new THREE.Mesh(geo, mat.clone());
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.name = wp.name ?? 'waypoint';
    group.add(mesh);

    // ── Label (sprite) ──
    if (settings.showLabels && wp.name) {
      const label = makeTextSprite(wp.name, settings.size * 3);
      label.position.set(x, y + settings.size * 2.5, z);
      group.add(label);
    }
  }

  return group;
}

// ─── Sprite text label ────────────────────────────────────────────────

function makeTextSprite(text: string, scale: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(2, 2, 252, 60, 8);
  } else {
    ctx.rect(2, 2, 252, 60);
  }
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scale * 4, scale, 1);
  return sprite;
}
