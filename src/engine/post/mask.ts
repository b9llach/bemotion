import * as THREE from 'three';

/**
 * Masks for the `mask` transition: the next scene shows through a word (or a logo shape), then the
 * view dives into the solid part of one letter until it covers the frame.
 *
 * The mask is drawn once on a canvas. A distance transform finds the point deepest inside the shape;
 * the dive zooms into that point, and stops growing once the letter's interior around it is larger
 * than the frame, so the reveal always ends fully on the next scene.
 */
export interface MaskInfo {
  texture: THREE.CanvasTexture;
  /** Canvas aspect (width / height). */
  aspect: number;
  /** Deepest interior point, in mask uv (y up). */
  point: [number, number];
  /** Distance from that point to the nearest edge, as a fraction of the mask width. */
  depth: number;
  /** Where the letters (or shape) sit in the image, in uv: [u0, v0, u1, v1]. */
  ink: [number, number, number, number];
}

const W = 2048;

async function loadFont(url: string, weight: number): Promise<string> {
  const family = `bm-mask-${weight}-${Math.abs([...url].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7))}`;
  if (![...document.fonts].some((f) => f.family === family)) {
    const face = new FontFace(family, `url(${url})`, { weight: String(weight) });
    await face.load();
    document.fonts.add(face);
  }
  return family;
}

/** Two-pass chamfer distance transform (3-4 weights) on an inside/outside grid; returns the deepest cell. */
function deepest(inside: Uint8Array, w: number, h: number): { x: number; y: number; d: number } {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  let best = { x: 0, y: 0, d: 0 };
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
      if (d[i] > best.d) best = { x, y, d: d[i] };
    }
  return { x: best.x, y: best.y, d: best.d / 3 };
}

export async function buildMask(opts: { text?: string; fontUrl?: string; weight?: number; letterSpacing?: number; svg?: { d: string; viewBox: [number, number, number, number] } }): Promise<MaskInfo> {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  let ink: [number, number, number, number] = [0.04, 0.04, 0.96, 0.96];
  if (opts.svg) {
    const [vx, vy, vw, vh] = opts.svg.viewBox;
    const pad = 0.04;
    canvas.width = W;
    canvas.height = Math.max(8, Math.round((W * vh) / vw));
    const k = (W * (1 - pad * 2)) / vw;
    g.translate(W * pad, canvas.height * pad);
    g.scale(k, (canvas.height * (1 - pad * 2)) / vh);
    g.translate(-vx, -vy);
    g.fillStyle = '#fff';
    g.fill(new Path2D(opts.svg.d));
  } else {
    const text = opts.text ?? 'GO';
    const weight = opts.weight ?? 800;
    const family = opts.fontUrl ? await loadFont(opts.fontUrl, weight) : 'sans-serif';
    const px = 400;
    const spacing = `${(opts.letterSpacing ?? 0) * px}px`;
    const setFont = () => {
      g.font = `${weight} ${px}px "${family}"`;
      (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = spacing;
    };
    setFont();
    const m = g.measureText(text);
    // Laid out by the ink (the drawn letters), so the image lines up with the same text on screen.
    const left = m.actualBoundingBoxLeft;
    const tw = left + m.actualBoundingBoxRight;
    const asc = m.actualBoundingBoxAscent;
    const desc = m.actualBoundingBoxDescent;
    const pad = px * 0.08;
    const scale = W / (tw + pad * 2);
    canvas.width = W;
    canvas.height = Math.max(8, Math.round((asc + desc + pad * 2) * scale));
    g.scale(scale, scale);
    setFont();
    g.fillStyle = '#fff';
    g.textBaseline = 'alphabetic';
    g.fillText(text, pad + left, pad + asc);
    const pu = pad / (tw + pad * 2);
    const pv = (pad * scale) / canvas.height;
    ink = [pu, pv, 1 - pu, 1 - pv];
  }
  // Distance transform on a quarter-resolution grid is plenty to find a deep point.
  const sw = 512;
  const sh = Math.max(2, Math.round((canvas.height * sw) / canvas.width));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sg = small.getContext('2d', { willReadFrequently: true })!;
  sg.drawImage(canvas, 0, 0, sw, sh);
  const px = sg.getImageData(0, 0, sw, sh).data;
  const inside = new Uint8Array(sw * sh);
  for (let i = 0; i < inside.length; i++) inside[i] = px[i * 4 + 3] > 127 || px[i * 4] > 127 ? 1 : 0;
  const best = deepest(inside, sw, sh);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  return {
    texture,
    aspect: canvas.width / canvas.height,
    point: [(best.x + 0.5) / sw, 1 - (best.y + 0.5) / sh],
    depth: Math.max(1, best.d) / sw,
    ink,
  };
}
