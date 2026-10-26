// Plasma rings: glowing concentric rings that ripple out from the center.
// Uniforms: uA, uB, uBg (colors), uRings (count), uSpeed.

vec4 shade(vec2 uv) {
  float t = uTime * uSpeed;
  vec2 p = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  float r = length(p);
  float ang = atan(p.y, p.x);
  // Rings bend a little with angle and time, like plasma.
  // The bend fades out toward the center, so the middle stays round.
  float warp = (0.035 * sin(ang * 5.0 + t * 1.3) + 0.02 * sin(ang * 3.0 - t * 0.7)) * smoothstep(0.0, 0.35, r);
  float phase = (r + warp) * uRings - t;
  float ring = pow(0.5 + 0.5 * cos(phase * TAU), 10.0);
  float glow = pow(0.5 + 0.5 * cos(phase * TAU), 2.0) * 0.35;
  vec3 tint = mix(uA, uB, 0.5 + 0.5 * sin(phase * 0.9 + ang));
  float fade = smoothstep(0.75, 0.05, r);
  vec3 col = uBg + tint * (ring + glow) * fade;
  col += tint * 0.25 * exp(-r * 9.0);
  return vec4(col, 1.0);
}
