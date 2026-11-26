// Upstream: https://raw.githubusercontent.com/prusa3d/prusa-fdm-mixer/67d81954bfef541f9d3a53766f1a4b88d8403607/src/color.ts (MIT).
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16)
  };
}
function rgbToHex(rgb) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + c(rgb.r) + c(rgb.g) + c(rgb.b);
}
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  const x = Math.max(0, Math.min(1, c));
  const v = x <= 31308e-7 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return v * 255;
}
function rgbToXyz(rgb) {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return {
    x: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    y: r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    z: r * 0.0193339 + g * 0.119192 + b * 0.9503041
  };
}
function xyzToLab(x, y, z) {
  const xn = 0.95047;
  const yn = 1;
  const zn = 1.08883;
  const f = (t) => t > 8856e-6 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}
function labToXyz(lab) {
  const xn = 0.95047;
  const yn = 1;
  const zn = 1.08883;
  const fy = (lab.L + 16) / 116;
  const fx = lab.a / 500 + fy;
  const fz = fy - lab.b / 200;
  const finv = (t) => Math.pow(t, 3) > 8856e-6 ? Math.pow(t, 3) : (t - 16 / 116) / 7.787;
  return { x: xn * finv(fx), y: yn * finv(fy), z: zn * finv(fz) };
}
function xyzToRgb(x, y, z) {
  return {
    r: linearToSrgb(x * 3.2404542 + y * -1.5371385 + z * -0.4985314),
    g: linearToSrgb(x * -0.969266 + y * 1.8760108 + z * 0.041556),
    b: linearToSrgb(x * 0.0556434 + y * -0.2040259 + z * 1.0572252)
  };
}
function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  const xyz = rgbToXyz(rgb);
  return xyzToLab(xyz.x, xyz.y, xyz.z);
}
function labToHex(lab) {
  const xyz = labToXyz(lab);
  const rgb = xyzToRgb(xyz.x, xyz.y, xyz.z);
  return rgbToHex(rgb);
}
function chroma(lab) {
  return Math.hypot(lab.a, lab.b);
}
function hueDegrees(lab) {
  if (chroma(lab) < 0.01) return 0;
  return (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
}
export {
  chroma,
  hexToLab,
  hexToRgb,
  hueDegrees,
  labToHex,
  labToXyz,
  linearToSrgb,
  rgbToHex,
  rgbToXyz,
  srgbToLinear,
  xyzToLab,
  xyzToRgb
};
