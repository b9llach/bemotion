// Halftone wipe: dots grow across the frame as uProgress goes from 0 to 1, until they cover it.
// Uniforms: uColor, uCell (dot pitch in px), uAngle (wipe direction, degrees).

vec4 shade(vec2 uv) {
  vec2 px = uv * uResolution;
  vec2 cell = (floor(px / uCell) + 0.5) * uCell;
  // Where the cell sits along the wipe direction, 0 to 1.
  float a = radians(uAngle);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 c = cell / uResolution - 0.5;
  float span = 0.5 * (abs(dir.x) + abs(dir.y));
  float along = dot(c, dir) / span * 0.5 + 0.5;
  // A band sweeps across; behind it every dot is full size (0.72 of the pitch covers the cell).
  float p = uProgress * 1.6 - 0.3;
  float k = clamp((p - along) / 0.3 + 0.5, 0.0, 1.0);
  k = k * k * (3.0 - 2.0 * k);
  float d = length(px - cell) - k * uCell * 0.72;
  float alpha = 1.0 - smoothstep(-1.0, 1.0, d);
  return vec4(uColor, alpha * step(0.001, k));
}
