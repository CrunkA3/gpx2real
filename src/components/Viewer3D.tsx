import { useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ElevationGrid, AppSettings, GPXData } from '../types';
import { buildTerrainMesh } from '../utils/terrainBuilder';
import { buildAllTrackMeshes } from '../utils/trackBuilder';
import { buildWaypointMeshes } from '../utils/waypointBuilder';

// ─── Public handle exposed via ref ───────────────────────────────────

export interface Viewer3DHandle {
  getTerrainGroup: () => THREE.Group;
  getTracksGroup: () => THREE.Group;
  getWaypointsGroup: () => THREE.Group;
  resetCamera: () => void;
}

// ─── Props ────────────────────────────────────────────────────────────

interface Props {
  gpxData: GPXData | null;
  grid: ElevationGrid | null;
  settings: AppSettings;
}

// ─── Component ────────────────────────────────────────────────────────

const Viewer3D = forwardRef<Viewer3DHandle, Props>(({ gpxData, grid, settings }, ref) => {
  const mountRef = useRef<HTMLDivElement>(null);

  // Three.js objects kept across renders
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameIdRef = useRef<number>(0);

  // Scene groups
  const terrainGroupRef = useRef<THREE.Group>(new THREE.Group());
  const tracksGroupRef = useRef<THREE.Group>(new THREE.Group());
  const waypointsGroupRef = useRef<THREE.Group>(new THREE.Group());

  // ── Expose handles to parent ──
  useImperativeHandle(ref, () => ({
    getTerrainGroup: () => terrainGroupRef.current,
    getTracksGroup: () => tracksGroupRef.current,
    getWaypointsGroup: () => waypointsGroupRef.current,
    resetCamera: () => {
      if (controlsRef.current) controlsRef.current.reset();
    },
  }));

  // ── Initialise Three.js renderer ──
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x1a1a2e);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x1a1a2e, 0.000015);
    sceneRef.current = scene;

    // Lights
    const ambient = new THREE.AmbientLight(0x404060, 1.2);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff0d0, 2.5);
    sun.position.set(5000, 8000, 3000);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80000;
    sun.shadow.camera.left = -20000;
    sun.shadow.camera.right = 20000;
    sun.shadow.camera.top = 20000;
    sun.shadow.camera.bottom = -20000;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x8090b0, 0.8);
    fill.position.set(-3000, 4000, -2000);
    scene.add(fill);

    // Camera
    const camera = new THREE.PerspectiveCamera(
      55,
      mount.clientWidth / mount.clientHeight,
      1,
      200000,
    );
    camera.position.set(0, 5000, 8000);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 10;
    controls.maxDistance = 100000;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controlsRef.current = controls;

    // Groups
    scene.add(terrainGroupRef.current);
    scene.add(tracksGroupRef.current);
    scene.add(waypointsGroupRef.current);

    // Render loop
    const animate = () => {
      frameIdRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (!mount) return;
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
    });
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(frameIdRef.current);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // ── Helper: dispose a group's children ──
  const clearGroup = useCallback((group: THREE.Group) => {
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
        child.geometry?.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((m) => {
          const anyM = m as unknown as { map?: THREE.Texture };
          anyM.map?.dispose();
          m.dispose();
        });
      }
    }
  }, []);

  // ── Rebuild scene whenever data or settings change ──
  useEffect(() => {
    if (!gpxData || !grid) return;

    const { mesh: terrainMesh, coordSystem: cs } = buildTerrainMesh(grid, settings.terrain);

    // ── Terrain ──
    clearGroup(terrainGroupRef.current);
    terrainGroupRef.current.add(terrainMesh);

    // ── Tracks ──
    clearGroup(tracksGroupRef.current);
    const trackMeshes = buildAllTrackMeshes(
      gpxData.tracks,
      grid,
      cs,
      settings.track.offset,
      settings.track.width,
    );
    trackMeshes.forEach((m) => tracksGroupRef.current.add(m));

    // ── Waypoints ──
    clearGroup(waypointsGroupRef.current);
    if (gpxData.waypoints.length > 0) {
      const wpGroup = buildWaypointMeshes(
        gpxData.waypoints,
        grid,
        cs,
        settings.waypoint,
        settings.track.offset,
      );
      waypointsGroupRef.current.add(...wpGroup.children);
    }

    // ── Fit camera to terrain ──
    fitCameraToTerrain(terrainMesh, cameraRef.current, controlsRef.current);
  }, [gpxData, grid, settings, clearGroup]);

  return (
    <div
      ref={mountRef}
      style={{ width: '100%', height: '100%', position: 'relative', background: '#1a1a2e' }}
    />
  );
});

Viewer3D.displayName = 'Viewer3D';
export default Viewer3D;

// ─── Camera fit ──────────────────────────────────────────────────────

function fitCameraToTerrain(
  mesh: THREE.Mesh,
  camera: THREE.PerspectiveCamera | null,
  controls: OrbitControls | null,
) {
  if (!camera || !controls) return;

  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox!;
  const centre = new THREE.Vector3();
  box.getCenter(centre);

  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.z);

  const dist = maxDim * 0.8;
  camera.position.set(centre.x, centre.y + dist * 0.6, centre.z + dist * 0.8);
  camera.near = maxDim * 0.0001;
  camera.far = maxDim * 5;
  camera.updateProjectionMatrix();

  controls.target.copy(centre);
  controls.update();
}
