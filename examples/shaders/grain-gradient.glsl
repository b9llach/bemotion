// Grain gradient: three colors that slowly swirl into each other, with film grain on top.
// Uniforms: uA, uB, uC (colors), uGrain (0-1), uSpeed.

vec4 shade(vec2 uv) {
  float t = uTime * uSpeed;
  vec2 p = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  // Domain warp gives the soft, liquid shapes.
  vec2 q = vec2(fbm(p * 1.4 + vec2(0.0, t * 0.12)), fbm(p * 1.4 + vec2(5.2, -t * 0.1)));
  vec2 r = vec2(fbm(p * 1.2 + q * 2.0 + vec2(1.7, 9.2) + t * 0.08), fbm(p * 1.2 + q * 2.0 + vec2(8.3, 2.8) - t * 0.06));
  float f = fbm(p + r * 1.6);
  vec3 col = mix(uA, uB, smoothstep(0.25, 0.65, f));
  col = mix(col, uC, smoothstep(0.45, 0.85, r.x));
  // Grain changes every frame but is the same for the same frame: it follows the scene clock.
  float g = hash12(uv * uResolution + floor(uTime * 30.0) * 17.0) - 0.5;
  col += g * uGrain * 0.18;
  return vec4(col, 1.0);
}
