import * as THREE from 'three';
import type { RGBA } from '../util/color';

const vert = /* glsl */ `
attribute float aDist;
attribute float aSide;
varying float vDist;
varying float vSide;
void main() {
  vDist = aDist;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
varying float vDist;
varying float vSide;
uniform vec4 uColor;
uniform float uOpacity;
uniform float uDiscard;
uniform float uProgress;
uniform float uTotal;
uniform float uSoft;
uniform float uIntensity;
uniform float uTail;
uniform float uBlurFrac;
uniform float uFrac;
uniform vec2 uDash;
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
void main() {
  float limit = uProgress * uTotal;
  if (vDist > limit) discard;
  if (uDash.x > 0.0 && mod(vDist, uDash.x + uDash.y) > uDash.x) discard;
  float tailFade = 1.0;
  if (uTail > 0.0) {
    float tailStart = limit - uTail * uTotal;
    if (vDist < tailStart) discard;
    tailFade = smoothstep(tailStart, limit, vDist);
  }
  // The geometry may be wider than the line (hairlines get room for antialiasing): uFrac is the
  // line's share of it. Coverage is computed in pixels, so lines thinner than two pixels stay solid.
  float edge = abs(vSide) / uFrac;
  float fw = max(fwidth(vSide), 1e-5) / uFrac;
  float a;
  if (uSoft > 0.0) a = pow(max(0.0, 1.0 - edge), 2.0);
  else if (uBlurFrac > 0.0) a = 1.0 - smoothstep(1.0 - max(fw * 1.2, 0.001) - uBlurFrac, 1.0, edge);
  else {
    float hw = 1.0 / fw;
    a = clamp(hw + 0.5 - edge * hw, 0.0, 1.0) * min(1.0, 2.0 * hw);
  }
  a *= uColor.a * uOpacity * tailFade / (1.0 + uBlurFrac * 1.5);
  gl_FragColor = vec4(toLinear(uColor.rgb) * uIntensity * a, a);
  if (a < uDiscard) discard;
}
`;

/** A flat polyline with constant pixel width and a draw-on `progress` uniform. */
export class Ribbon extends THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  total = 0;

  constructor(points: THREE.Vector2[], width: number, closed = false, soft = 0) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Vector4(1, 1, 1, 1) },
        uOpacity: { value: 1 },
        uProgress: { value: 1 },
        uTotal: { value: 1 },
        uSoft: { value: soft },
        uIntensity: { value: 1 },
        uTail: { value: 0 },
        uBlurFrac: { value: 0 },
        uFrac: { value: 1 },
        uDash: { value: new THREE.Vector2(0, 0) },
        uDiscard: { value: 0 },
      },
    });
    super(new THREE.BufferGeometry(), mat);
    this.build(points, width, closed);
    this.frustumCulled = false;
  }

  build(input: THREE.Vector2[], width: number, closed: boolean): void {
    const loop = closed && input.length > 2;
    const pts = loop ? [...input, input[0]] : input;
    const n = pts.length;
    const pos: number[] = [];
    const dist: number[] = [];
    const side: number[] = [];
    const idx: number[] = [];
    let acc = 0;
    // Hairlines are built at least 2.5 px wide; the shader draws the real width inside.
    const hw = Math.max(width / 2, this.material.uniforms.uSoft.value > 0 ? 0 : 1.25);
    this.material.uniforms.uFrac.value = Math.min(1, width / 2 / hw);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i > 0) acc += p.distanceTo(pts[i - 1]);
      // A closed loop joins its ends like any other corner, so the seam has no notch.
      const prev = loop && i === 0 ? pts[n - 2] : pts[Math.max(0, i - 1)];
      const next = loop && i === n - 1 ? pts[1] : pts[Math.min(n - 1, i + 1)];
      const dirIn = new THREE.Vector2().subVectors(p, prev);
      const dirOut = new THREE.Vector2().subVectors(next, p);
      if (dirIn.lengthSq() < 1e-8) dirIn.copy(dirOut);
      if (dirOut.lengthSq() < 1e-8) dirOut.copy(dirIn);
      dirIn.normalize();
      dirOut.normalize();
      const tangent = dirIn.clone().add(dirOut);
      if (tangent.lengthSq() < 1e-8) tangent.copy(dirOut);
      tangent.normalize();
      const normal = new THREE.Vector2(-tangent.y, tangent.x);
      const nIn = new THREE.Vector2(-dirIn.y, dirIn.x);
      const miter = Math.min(4, 1 / Math.max(0.25, normal.dot(nIn)));
      const off = normal.multiplyScalar(hw * miter);
      pos.push(p.x + off.x, p.y + off.y, 0, p.x - off.x, p.y - off.y, 0);
      dist.push(acc, acc);
      side.push(1, -1);
      if (i < n - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setIndex(idx);
    this.geometry.dispose();
    this.geometry = g;
    this.total = acc;
    this.material.uniforms.uTotal.value = Math.max(acc, 1e-4);
  }

  /** Dashes along the line: `on` px drawn, `off` px skipped (0 for a solid line). */
  setDash(on: number, off: number): void {
    this.material.uniforms.uDash.value.set(Math.max(0, on), Math.max(0, off));
  }

  /** Softens edges for blur; `frac` is blur relative to the half width. */
  setBlur(frac: number): void {
    this.material.uniforms.uBlurFrac.value = Math.min(1, Math.max(0, frac));
  }

  set(color: RGBA, opacity: number, progress: number, intensity = 1, tail = 0): void {
    const u = this.material.uniforms;
    u.uIntensity.value = intensity;
    u.uTail.value = tail;
    u.uColor.value.set(color.r, color.g, color.b, color.a);
    u.uOpacity.value = opacity;
    u.uProgress.value = progress;
  }
}

/** Samples a smooth curve through points. */
export function smoothPoints(points: THREE.Vector2[], samplesPerSegment = 16): THREE.Vector2[] {
  if (points.length < 3) return points;
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, p.y, 0)), false, 'centripetal', 0.5);
  return curve.getPoints((points.length - 1) * samplesPerSegment).map((v) => new THREE.Vector2(v.x, v.y));
}
