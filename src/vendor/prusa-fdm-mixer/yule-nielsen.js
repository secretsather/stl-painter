// Upstream: https://raw.githubusercontent.com/prusa3d/prusa-fdm-mixer/67d81954bfef541f9d3a53766f1a4b88d8403607/src/yule-nielsen.ts (MIT).
import {
  hexToRgb,
  rgbToHex,
  srgbToLinear,
  linearToSrgb,
  hexToLab
} from "./color.js";
function yuleNielsenMix(parts, n = 3) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of parts) {
    const rgb = hexToRgb(p.hex);
    r += Math.pow(srgbToLinear(rgb.r), 1 / n) * p.ratio;
    g += Math.pow(srgbToLinear(rgb.g), 1 / n) * p.ratio;
    b += Math.pow(srgbToLinear(rgb.b), 1 / n) * p.ratio;
  }
  return {
    r: linearToSrgb(Math.pow(Math.max(0, r), n)),
    g: linearToSrgb(Math.pow(Math.max(0, g), n)),
    b: linearToSrgb(Math.pow(Math.max(0, b), n))
  };
}
function mixYuleNielsen(parts) {
  const rgb = yuleNielsenMix(parts, 3);
  const hex = rgbToHex(rgb);
  const lab = hexToLab(hex);
  return { hex, lab, rgb };
}
export {
  mixYuleNielsen,
  yuleNielsenMix
};
