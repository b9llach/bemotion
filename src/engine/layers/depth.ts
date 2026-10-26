import * as THREE from 'three';

/**
 * 2.5D photos: an image drawn as a relief, a grid displaced toward the camera by a depth map (white =
 * near). Camera moves and layer rotations then show real parallax.
 *
 * Depth discontinuities (a subject's outline against the background) make the classic stretched
 * "rubber sheet" triangles when seen from an angle. Three things keep them out of sight:
 *  - the depth map is smoothed a little before displacing, which limits slopes;
 *  - each vertex measures how much larger the surface there looks than the image it carries, from
 *    the depth slope and the direction to the camera, and stretched slopes fade out; seen head-on
 *    nothing fades;
 *  - a back plate that follows the background (the depth with near things worn away) fills what
 *    the fading uncovers with the background around it (the farthest of samples in rings), instead
 *    of a hole or a smeared copy of the subject.
 * Triangles are sorted far to near once, so the relief hides itself correctly without writing depth,
 * and keeps the painter's order of flat layers.
 */

/** Grayscale depth samples, 0 far to 1 near, row 0 at the top. */
export interface DepthImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** Reads a depth map image (red channel) into 0-1 samples. */
export async function readDepthImage(url: string): Promise<DepthImage> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load depth map (${res.status}): ${(await res.text()).slice(0, 400)}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
  const data = new Float32Array(bmp.width * bmp.height);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4] / 255;
  bmp.close();
  return { width: canvas.width, height: canvas.height, data };
}

function sample(d: DepthImage, u: number, v: number): number {
  // u, v in 0-1 with v = 0 at the bottom (texture convention); rows are stored top first.
  const x = Math.min(d.width - 1, Math.max(0, u * d.width - 0.5));
  const y = Math.min(d.height - 1, Math.max(0, (1 - v) * d.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(d.width - 1, x0 + 1);
  const y1 = Math.min(d.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = d.data[y0 * d.width + x0] * (1 - fx) + d.data[y0 * d.width + x1] * fx;
  const b = d.data[y1 * d.width + x0] * (1 - fx) + d.data[y1 * d.width + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/** Separable box blur of a grid, `r` cells each way, twice (close to a Gaussian). */
function smooth(g: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return g;
  let src = g;
  const tmp = new Float32Array(g.length);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(g.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          s += src[y * w + xx];
          n++;
        }
        tmp[y * w + x] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          s += tmp[yy * w + x];
          n++;
        }
        out[y * w + x] = s / n;
      }
    }
    src = out;
  }
  return src;
}

/** Grayscale erosion: each cell becomes the minimum (the farthest) within `r` cells. */
function erode(g: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(g.length);
  const out = new Float32Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.min(m, g[y * w + k]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.min(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

const vert = /* glsl */ `
attribute float aDepth;
attribute vec2 aGrad;
uniform float uAmount;
uniform float uBack;
uniform vec3 uCamLocal;
varying vec2 vLocal;
varying float vStretch;
void main() {
  vLocal = position.xy;
  float z = aDepth * uAmount;
  // How much larger the surface here looks than the image it carries: 1 head-on, large on a steep
  // slope (an outline) turned toward the camera. Smooth across the mesh, unlike the triangles.
  vec3 v = uCamLocal - vec3(position.xy, z);
  vStretch = 1.0 + uAmount * abs(dot(aGrad, v.xy)) / max(abs(v.z), 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, z, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
varying vec2 vLocal;
varying float vStretch;
uniform sampler2D uMap;
uniform sampler2D uDepthTex;
uniform vec4 uMapTransform;
uniform vec2 uSize;
uniform float uRadius;
uniform float uOpacity;
uniform float uDiscard;
uniform float uBack;
uniform float uMapBias;

float sdRoundBox(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec2 mapUv(vec2 uv) { return uv * uMapTransform.xy + uMapTransform.zw; }

void main() {
  vec2 uv = vLocal / uSize + 0.5;
  vec3 col;
  float a = 1.0;
  if (uBack > 0.5) {
    // Background around this point: samples in rings, weighted toward the farthest.
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    float aspect = uSize.x / uSize.y;
    for (int ring = 0; ring < 3; ring++) {
      float r = 0.015 + 0.03 * float(ring * ring + ring);
      for (int k = 0; k < 12; k++) {
        float ang = 6.28318530718 * (float(k) + 0.5 * float(ring)) / 12.0;
        vec2 o = clamp(uv + vec2(cos(ang), sin(ang) * aspect) * r, vec2(0.0), vec2(1.0));
        float d = texture2D(uDepthTex, o).r;
        float w = exp(-d * 10.0);
        acc += texture2D(uMap, mapUv(o), 2.0).rgb * w;
        wsum += w;
      }
    }
    col = acc / max(wsum, 1e-5);
  } else {
    col = texture2D(uMap, mapUv(uv), uMapBias).rgb;
    // Stretched slopes fade out and the back plate shows through.
    a = 1.0 - smoothstep(1.6, 3.2, vStretch);
  }
  float d = sdRoundBox(vLocal, uSize * 0.5, uRadius);
  float aa = max(fwidth(d), 1e-4);
  a *= 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);
  a *= uOpacity;
  gl_FragColor = vec4(col * a, a);
  if (gl_FragColor.a < uDiscard) discard;
}
`;

export interface ReliefOptions {
  /** Image size in px. */
  width: number;
  height: number;
  /** Map scale.xy, offset.xy (cover/contain fit), as for flat images. */
  mapTransform: [number, number, number, number];
  /** Depth that stays in the layer plane, 0-1. */
  focus: number;
}

export class DepthRelief extends THREE.Group {
  readonly main: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly back: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private depthTex: THREE.DataTexture;
  readonly focus: number;

  constructor(map: THREE.Texture, depth: DepthImage, o: ReliefOptions) {
    super();
    this.focus = o.focus;
    const { width: w, height: h } = o;
    // About one vertex per 7 px, at most 260 across.
    const cols = Math.max(24, Math.min(260, Math.round(w / 7)));
    const rows = Math.max(16, Math.min(260, Math.round((cols * h) / w)));
    const gw = cols + 1;
    const gh = rows + 1;
    const [sx, sy, ox, oy] = o.mapTransform;
    const grid = new Float32Array(gw * gh);
    // Grid row 0 is the top of the image.
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const u = i / cols;
        const v = 1 - j / rows;
        grid[j * gw + i] = sample(depth, u * sx + ox, v * sy + oy);
      }
    }
    const sm = smooth(grid, gw, gh, 1);

    // Non-indexed triangles, sorted far to near.
    const tris: { z: number; v: number[]; idx: number[] }[] = [];
    const vx = (i: number) => (i / cols - 0.5) * w;
    const vy = (j: number) => (0.5 - j / rows) * h;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * gw + i;
        const b = a + 1;
        const c = a + gw;
        const d = c + 1;
        const corner = (k: number) => [vx(k % gw), vy(Math.floor(k / gw)), sm[k] - o.focus];
        // Split along the diagonal with the smaller depth change, so edges follow outlines.
        const quads = Math.abs(sm[a] - sm[d]) < Math.abs(sm[b] - sm[c]) ? [[a, c, d], [a, d, b]] : [[a, c, b], [b, c, d]];
        for (const q of quads) {
          const p = q.map(corner);
          tris.push({ z: (p[0][2] + p[1][2] + p[2][2]) / 3, v: p.flat(), idx: q });
        }
      }
    }
    tris.sort((p, q) => p.z - q.z);
    // Depth slope at each grid point (normalized depth per layer px, +y up), from central differences.
    const cw = w / cols;
    const ch = h / rows;
    const grad = new Float32Array(gw * gh * 2);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const l = sm[j * gw + Math.max(0, i - 1)];
        const r = sm[j * gw + Math.min(gw - 1, i + 1)];
        const up = sm[Math.max(0, j - 1) * gw + i];
        const dn = sm[Math.min(gh - 1, j + 1) * gw + i];
        grad[(j * gw + i) * 2] = (r - l) / (cw * (Math.min(gw - 1, i + 1) - Math.max(0, i - 1)));
        grad[(j * gw + i) * 2 + 1] = (up - dn) / (ch * (Math.min(gh - 1, j + 1) - Math.max(0, j - 1)));
      }
    }
    const pos = new Float32Array(tris.length * 9);
    const dep = new Float32Array(tris.length * 3);
    const gr = new Float32Array(tris.length * 6);
    tris.forEach((t, k) => {
      for (let m = 0; m < 3; m++) {
        pos[k * 9 + m * 3] = t.v[m * 3];
        pos[k * 9 + m * 3 + 1] = t.v[m * 3 + 1];
        pos[k * 9 + m * 3 + 2] = 0;
        dep[k * 3 + m] = t.v[m * 3 + 2];
        const gi = t.idx[m] * 2;
        gr[k * 6 + m * 2] = grad[gi];
        gr[k * 6 + m * 2 + 1] = grad[gi + 1];
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(dep, 1));
    geo.setAttribute('aGrad', new THREE.BufferAttribute(gr, 2));
    // Bounds for culling: the relief can come forward or go back by the full amount.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(w, h) * 2);

    // The smoothed grid on the GPU, for the back plate's fill (rows bottom first for texture v).
    const bytes = new Uint8Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) bytes[(gh - 1 - j) * gw + i] = Math.round(sm[j * gw + i] * 255);
    this.depthTex = new THREE.DataTexture(bytes, gw, gh, THREE.RedFormat, THREE.UnsignedByteType);
    this.depthTex.minFilter = THREE.LinearFilter;
    this.depthTex.magFilter = THREE.LinearFilter;
    this.depthTex.needsUpdate = true;

    const uniforms = () => ({
      uMap: { value: map },
      uDepthTex: { value: this.depthTex },
      uMapTransform: { value: new THREE.Vector4(sx, sy, ox, oy) },
      uSize: { value: new THREE.Vector2(w, h) },
      uRadius: { value: 0 },
      uOpacity: { value: 1 },
      uDiscard: { value: 0 },
      uAmount: { value: 0 },
      uBack: { value: 0 },
      uMapBias: { value: 0 },
      uCamLocal: { value: new THREE.Vector3(0, 0, 2000) },
    });
    const material = (back: boolean) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: uniforms(),
        transparent: true,
        depthWrite: false,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
      });
      m.uniforms.uBack.value = back ? 1 : 0;
      return m;
    };
    // The back plate follows the background: the depth with near things worn away (a minimum over
    // about 3% of the width), smoothed. It meets the relief wherever there is no outline, so it only
    // shows through the faded slopes, also at the image's edges.
    const reach = Math.max(2, Math.round(cols * 0.03));
    const bg = smooth(erode(sm, gw, gh, reach), gw, gh, reach);
    const bpos = new Float32Array(gw * gh * 3);
    const bdep = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        bpos[k * 3] = vx(i);
        bpos[k * 3 + 1] = vy(j);
        // Never in front of the relief, so it cannot cover it where they meet.
        bdep[k] = Math.min(bg[k], sm[k]) - o.focus - 0.004;
      }
    }
    const index: number[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * gw + i;
        index.push(a, a + gw, a + 1, a + 1, a + gw, a + gw + 1);
      }
    }
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
    bgeo.setAttribute('aDepth', new THREE.BufferAttribute(bdep, 1));
    bgeo.setAttribute('aGrad', new THREE.BufferAttribute(new Float32Array(gw * gh * 2), 2));
    bgeo.setIndex(index);
    this.back = new THREE.Mesh(bgeo, material(true));
    this.main = new THREE.Mesh(geo, material(false));
    this.main.frustumCulled = false;
    // The camera in the relief's own space, for the stretch measure.
    const inv = new THREE.Matrix4();
    this.main.onBeforeRender = (_r, _s, camera) => {
      inv.copy(this.main.matrixWorld).invert();
      (this.main.material.uniforms.uCamLocal.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    };
    this.back.frustumCulled = false;
    this.add(this.back, this.main);
  }

  /** Paint order: the plate just before the relief. */
  setOrder(order: number): void {
    this.back.renderOrder = order - 0.001;
    this.main.renderOrder = order;
  }

  update(p: { amount: number; opacity: number; radius: number; mapBias: number }): void {
    for (const m of [this.main.material, this.back.material]) {
      const u = m.uniforms;
      u.uAmount.value = p.amount;
      u.uOpacity.value = p.opacity;
      u.uRadius.value = p.radius;
      u.uMapBias.value = p.mapBias;
    }
  }

  dispose(): void {
    this.depthTex.dispose();
  }
}

/** Map transform (scale.xy, offset.xy) that fits an image of aspect `ta` into a box of aspect `sa`. */
export function fitTransform(ta: number, sa: number, fit: 'cover' | 'contain' | 'fill'): [number, number, number, number] {
  let sx = 1;
  let sy = 1;
  if (fit === 'cover') {
    if (ta > sa) sx = sa / ta;
    else sy = ta / sa;
  } else if (fit === 'contain') {
    if (ta > sa) sy = ta / sa;
    else sx = sa / ta;
  }
  return [sx, sy, (1 - sx) / 2, (1 - sy) / 2];
}

/**
 * Where an estimated depth map for `src` comes from: the local server makes it (and caches it) for
 * images next to the spec. Elsewhere there is no estimator, so the spec must name a map.
 */
export function estimatedDepthUrl(assetUrl: string, src: string): string {
  const direct = new URL(assetUrl, location.href);
  const local = '/__bemotion/assets/';
  if (direct.origin !== location.origin || !direct.pathname.startsWith(local)) {
    throw new Error(`depth for "${src}" can only be estimated for an image next to the spec; give a depth map with depth.map`);
  }
  return `${direct.origin}/__bemotion/depth?src=${encodeURIComponent(decodeURIComponent(direct.pathname.slice(local.length)))}`;
}
