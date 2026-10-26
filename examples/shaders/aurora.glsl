// Aurora: curtains of light with vertical rays, drifting over a dark sky.
// Uniforms: uSky, uA, uB (colors), uSpeed.

// One curtain: a wavy lower edge, rays rising from it and fading out with height.
float curtain(vec2 p, float base, float seed, float t) {
  float x = p.x * 1.4 + seed;
  float edge = base + 0.12 * sin(x * 1.2 + t * 0.5) + 0.06 * sin(x * 2.7 - t * 0.8) + 0.1 * (fbm(vec2(x * 0.7, t * 0.12 + seed)) - 0.5);
  float d = p.y - edge;
  float lower = smoothstep(-0.015, 0.02, d);
  float height = 0.22 + 0.12 * fbm(vec2(x * 2.0, seed));
  float upper = exp(-max(d, 0.0) / height * 2.2);
  // Rays: thin vertical streaks that shimmer slowly.
  float rays = pow(fbm(vec2(x * 14.0, t * 0.35 + seed)), 1.5) * 1.6;
  float bright = 0.5 + 0.5 * fbm(vec2(x * 1.5 - t * 0.2, seed * 3.0));
  return lower * upper * rays * bright;
}

vec4 shade(vec2 uv) {
  float t = uTime * uSpeed;
  vec2 p = vec2((uv.x - 0.5) * uResolution.x / uResolution.y, uv.y);
  vec3 col = uSky * (0.6 + 0.6 * (1.0 - uv.y));
  float back = curtain(p, 0.62, 4.1, t * 0.8);
  float front = curtain(p, 0.48, 0.0, t);
  col += uB * back * 0.55;
  // The front curtain shifts toward the back color near its top, as real aurorae do.
  col += mix(uA, uB, smoothstep(0.5, 0.9, uv.y)) * front;
  // Faint stars where the sky is dark.
  vec2 cell = floor(uv * uResolution / 3.0);
  float star = step(0.998, hash12(cell)) * (0.6 + 0.4 * sin(t * 2.0 + hash12(cell + 7.0) * 30.0));
  col += vec3(star) * 0.45 * smoothstep(0.35, 0.9, uv.y) * (1.0 - min(1.0, front + back));
  return vec4(col, 1.0);
}
