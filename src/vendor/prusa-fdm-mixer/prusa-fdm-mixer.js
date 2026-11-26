// Upstream: https://raw.githubusercontent.com/prusa3d/prusa-fdm-mixer/67d81954bfef541f9d3a53766f1a4b88d8403607/src/prusa-fdm-mixer.ts (MIT).
import {
  hexToRgb,
  rgbToHex,
  hexToLab,
  labToHex,
  chroma,
  hueDegrees
} from "./color.js";
import { yuleNielsenMix } from "./yule-nielsen.js";
const DEFAULT_V7_PARAMS = {
  YN_N: 3,
  L_BASE_SLOPE: -0.0477,
  L_BASE_INTERCEPT: -2.112,
  L_KNEE: 15,
  L_KNEE_SLOPE: -0.06,
  C_SLOPE: 0.278,
  C_INTERCEPT: -15.58,
  HUE_CENTER: 210,
  HUE_FALLOFF: 30,
  HUE_PEAK: 10.38,
  PEAK_STRENGTH: 1.375
};
function mixFilaments(parts) {
  return mixFilamentsWithParams(parts, DEFAULT_V7_PARAMS);
}
function mixFilamentsWithParams(parts, params) {
  if (parts.length === 0) {
    throw new Error("mixFilaments: parts must not be empty");
  }
  const total = parts.reduce((s, p) => s + p.ratio, 0);
  if (total <= 0) {
    throw new Error("mixFilaments: ratios must sum to a positive value");
  }
  const normalized = parts.map((p) => {
    if (p.ratio < 0) {
      throw new Error(`mixFilaments: negative ratio for ${p.hex}`);
    }
    return { hex: p.hex, ratio: p.ratio / total };
  });
  for (const p of normalized) {
    if (p.ratio >= 0.9999) {
      const lab2 = hexToLab(p.hex);
      const rgb2 = hexToRgb(p.hex);
      return { hex: rgbToHex(rgb2), lab: lab2, rgb: rgb2 };
    }
  }
  const baseRgb = yuleNielsenMix(normalized, params.YN_N);
  const baseLab = hexToLab(rgbToHex(baseRgb));
  const Ls = normalized.map((p) => hexToLab(p.hex).L);
  const lGap = Math.max(...Ls) - Math.min(...Ls);
  const N = normalized.length;
  const ratioProduct = normalized.reduce((s, p) => s * p.ratio, 1);
  const wRaw = Math.pow(N, N) * ratioProduct;
  const w = Math.max(0, Math.min(1, wRaw)) * params.PEAK_STRENGTH;
  let dL = params.L_BASE_SLOPE * lGap + params.L_BASE_INTERCEPT;
  if (lGap > params.L_KNEE) {
    dL += params.L_KNEE_SLOPE * (lGap - params.L_KNEE);
  }
  const newL = baseLab.L + dL * w;
  const baseC = chroma(baseLab);
  let aOut = baseLab.a;
  let bOut = baseLab.b;
  if (baseC >= 0.01) {
    const targetDC = (params.C_SLOPE * newL + params.C_INTERCEPT) * w;
    const newC2 = Math.max(0, baseC + targetDC);
    const scale = newC2 / baseC;
    aOut = baseLab.a * scale;
    bOut = baseLab.b * scale;
  }
  const newC = Math.hypot(aOut, bOut);
  if (newC >= 1) {
    const predHue = (Math.atan2(bOut, aOut) * 180 / Math.PI + 360) % 360;
    const distFromCenter = Math.abs(predHue - params.HUE_CENTER);
    const inBand = distFromCenter < params.HUE_FALLOFF;
    if (inBand) {
      const hCorr = params.HUE_PEAK * (1 - distFromCenter / params.HUE_FALLOFF) * w;
      const newHueRad = (predHue + hCorr) % 360 * Math.PI / 180;
      aOut = newC * Math.cos(newHueRad);
      bOut = newC * Math.sin(newHueRad);
    }
  }
  const lab = { L: newL, a: aOut, b: bOut };
  const hex = labToHex(lab);
  const rgb = hexToRgb(hex);
  return { hex, lab, rgb };
}
export {
  DEFAULT_V7_PARAMS,
  chroma,
  hueDegrees,
  mixFilaments,
  mixFilamentsWithParams
};
