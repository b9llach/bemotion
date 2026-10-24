import * as THREE from 'three';

/** Screen rectangle of a layer in render-target pixels (origin bottom-left): center and size. */
export interface ScreenBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Render channels: 0 is the normal scene, FLYING hides a shared element from it, SOLO renders one alone. */
export const FLYING = 1;
export const SOLO = 2;

const corner = new THREE.Vector3();

/** Projected bounds of everything visible under `root`, or null when nothing is on screen. */
export function screenBox(root: THREE.Object3D, camera: THREE.Camera, width: number, height: number): ScreenBox | null {
  root.updateWorldMatrix(true, true);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  root.traverseVisible((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g || (o as THREE.InstancedMesh).isInstancedMesh) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb || bb.isEmpty()) return;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
      corner.applyMatrix4(o.matrixWorld).project(camera);
      if (corner.z > 1) continue;
      const px = (corner.x * 0.5 + 0.5) * width;
      const py = (corner.y * 0.5 + 0.5) * height;
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
  });
  if (!(x1 > x0 && y1 > y0)) return null;
  // Off screen entirely: nothing to fly.
  if (x1 < 0 || y1 < 0 || x0 > width || y0 > height) return null;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/**
 * Projected bounds of the drawn letters under `root` (text uses its glyph bounds, not its line box;
 * other meshes their geometry), or null when nothing is visible.
 */
export function inkBox(root: THREE.Object3D, camera: THREE.Camera, width: number, height: number): ScreenBox | null {
  root.updateWorldMatrix(true, true);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  root.traverseVisible((o) => {
    const vb = (o as { textRenderInfo?: { visibleBounds?: number[] } }).textRenderInfo?.visibleBounds;
    let b: number[] | null = null;
    if (vb && Number.isFinite(vb[0])) b = [vb[0], vb[1], 0, vb[2], vb[3], 0];
    else {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (!g || (o as THREE.InstancedMesh).isInstancedMesh || vb) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb || bb.isEmpty()) return;
      b = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z];
    }
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]);
      corner.applyMatrix4(o.matrixWorld).project(camera);
      if (corner.z > 1) continue;
      const px = (corner.x * 0.5 + 0.5) * width;
      const py = (corner.y * 0.5 + 0.5) * height;
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
  });
  if (!(x1 > x0 && y1 > y0)) return null;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/** Puts every object under `root` on one render channel. */
export function setChannel(root: THREE.Object3D, channel: number): void {
  root.traverse((o) => o.layers.set(channel));
}

/** Lights must light shared elements on every channel. */
export function lightAllChannels(scene: THREE.Scene): void {
  scene.traverse((o) => {
    if ((o as THREE.Light).isLight) o.layers.enableAll();
  });
}
