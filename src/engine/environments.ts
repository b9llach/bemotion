import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

/**
 * Dark photo studio: black room lit by a few long softbox strips. Gives polished metal (gold, chrome)
 * deep shadows and crisp highlights instead of the flat look of a bright room.
 */
function studioScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020202);
  const strip = (w: number, h: number, intensity: number, pos: [number, number, number], rot: [number, number, number], tint = 0xffffff) => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(intensity), side: THREE.DoubleSide });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    scene.add(m);
  };
  // Key: a long overhead strip angled toward the subject.
  strip(10, 1.2, 9, [0, 5, 2], [Math.PI / 2.4, 0, 0]);
  // Rim lights left and right.
  strip(1.0, 8, 6, [-6, 0.5, -1], [0, Math.PI / 2.2, 0]);
  strip(1.0, 8, 4, [6, 0.5, -2], [0, -Math.PI / 2.2, 0]);
  // Large softbox behind the camera: what a face-on metal surface mirrors. Split so the face shows a gradient.
  strip(14, 3.5, 1.05, [0, 3.2, 8], [Math.PI / 9, Math.PI, 0]);
  strip(14, 2.5, 0.35, [0, -0.8, 8], [0, Math.PI, 0], 0xffe2b0);
  // A floor bounce so undersides are not pure black.
  strip(14, 14, 0.12, [0, -6, 0], [-Math.PI / 2, 0, 0]);
  return scene;
}

/**
 * Bright product studio: light gray sweep with big softboxes overhead and upper right. Metals read
 * rich on white backgrounds, and the upper-right box gives a natural glare on tilted surfaces.
 */
function softboxScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8a8a90);
  const panel = (w: number, h: number, intensity: number, pos: [number, number, number], look: [number, number, number] = [0, 0, 0], tint = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(...look);
    scene.add(m);
  };
  panel(9, 5, 1.05, [0, 6, 2]);
  panel(3.5, 3.5, 3.2, [5.5, 4.5, 4.5]);
  panel(3, 7, 0.9, [-7, 1, 2]);
  panel(12, 4, 0.85, [0, 1.5, 8], [0, 0, 0], 0xfff6ea);
  panel(30, 30, 0.5, [0, -5, 0], [0, 0, 0]);
  panel(30, 12, 0.25, [0, 2, -10]);
  return scene;
}

export type EnvironmentName = 'room' | 'studio' | 'softbox';

/** Loads an equirectangular .hdr/.exr photo and prefilters it for physically based reflections. */
export async function loadHdriEnvironment(renderer: THREE.WebGLRenderer, url: string): Promise<THREE.Texture> {
  const loader = /\.exr($|\?)/i.test(url) ? new EXRLoader() : new HDRLoader();
  const tex = await loader.loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

export function buildEnvironment(renderer: THREE.WebGLRenderer, name: EnvironmentName = 'room'): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = name === 'studio' ? studioScene() : name === 'softbox' ? softboxScene() : new RoomEnvironment();
  const tex = pmrem.fromScene(scene, name === 'room' ? 0.04 : 0.02).texture;
  pmrem.dispose();
  return tex;
}
