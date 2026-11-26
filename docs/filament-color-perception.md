# Choosing filament blends in STL Painter

**Recommendation, 26 November 2026.** Keep the 33% minimum and three-filament limit. I would change how the image stamp chooses a color first, then test a better preview against printed samples. For the example with beige, white, turquoise and cream, keep the 50/50 beige–white recipe as a pale highlight. If the stamp needs cream, compare the existing cream spool before suggesting that extra recipe. For a design needing dark outlines, the three pale spools leave little room for contrast. Substituting a dark spool for one pale spool would help that particular design.

## Choosing a stamp color

For an optional new spool, charcoal `#242629` gives this example palette the most extra separation, followed by berry `#AD4159`. To get that ranking, compare each of the 16 existing Add Color suggestions with the four base colors and their current legal mix previews in Oklab, then pick the suggestion whose nearest neighbor is farthest away. For artwork with a specific target color, choose the candidate that best fills that image’s need. [Add Color suggestions](../src/app.js) · [W3C’s Oklab color difference](https://www.w3.org/TR/css-color-4/#color-difference-OK)

The current matcher compares red, green and blue channel differences with fixed weights. It uses that score both to suggest a new blend and to assign each pixel. I would rank solids and estimated mixes by distance in Oklab, a fast calculation suitable for per-pixel matching. Use CIEDE2000 to evaluate close contenders and to score the printed results. It accounts for how sensitivity changes with lightness, chroma and hue. Replace the current cutoff of `9` with a tolerance tested against printed samples in the new units. For close matches, favor an existing solid, then an existing mix, before adding a recipe. Keep manual selection available for subtle highlights. [Stamp matching](../src/stamps.js) · [W3C’s Oklab color difference](https://www.w3.org/TR/css-color-4/#color-difference-OK) · [CIE color-difference standard](https://www.cie.co.at/publications/colorimetry-part-6-ciede2000-colour-difference-formula-1)

The app already considers every whole-percent two-filament recipe from 33/67 to 67/33. With three filaments the legal split is 34/33/33, with a choice of which filament gets the extra point. For a compact set of suggestions, show 33/67, 50/50 and 67/33 first and group nearly identical previews. The full search can still find an intermediate recipe for a specific image. Decide whether adjacent ratios merit separate suggestions from measured color differences and print comparisons. [Recipe generation](../src/mixes.js)

## What a blend looks like

Mullen’s visual experiments found that sensitivity to red–green and blue–yellow patterns decreases as the bands get finer in the viewer’s field of vision. On a print, standing farther back can make separate layer colors appear to merge. On a wall with alternating black and white, a small displacement can also expose more of one filament. Reiner and colleagues observed this on a printed cylinder. Kuipers and colleagues measured how the apparent tone of printed bands changes with viewing angle. Layer height, slope and filament translucency can all affect whether a particular mix looks smooth. A solid preview can be accompanied by a strip showing the component colors and their proportions. [Mullen’s vision experiment](https://doi.org/10.1113/jphysiol.1985.sp015591) · [Reiner et al., dual-color FDM](https://cg.ivd.kit.edu/publications/2014/DCM/DualColorMixing.pdf) · [Kuipers et al., FDM hatching](https://arxiv.org/abs/1805.01375) · [Snapmaker’s printed examples](https://www.snapmaker.com/blog/getting-started-with-full-spectrum-slicing/)

STL Painter averages the stored sRGB bytes for its solid preview. As an idealized baseline, consider fine opaque patches under the same lighting, each supplying its stated share of visible area. Convert the swatches to linear-light sRGB, average their light by area and encode the result for display. The examples below were calculated at 50/50. The first pair comes from the example project and the second from the starter palette. Both columns are screen calculations. [Current blend calculation](../src/mixes.js) · [Starter palette](../src/mesh.js) · [W3C color interpolation](https://www.w3.org/TR/css-color-4/#interpolation-space)

| Filaments | Current swatch | Idealized equal-area swatch |
| --- | --- | --- |
| Beige `#E7DDC8` and white `#FFFFFF` | `#F3EEE4` | `#F3EFE6` |
| Terracotta `#DE7248` and teal `#386D67` | `#8B7058` | `#A77059` |

Switching the arithmetic makes little difference for beige and white and a larger difference for terracotta and teal. For a print preview, compare both baselines with Prusa’s model for interleaved filament. It fits corrections to measured Prusament PLA prints and publishes a separate held-out batch. Its authors describe three-color predictions as extrapolations with limited validation. In a layered print, exposed bands reflect light side by side, and translucent layers can pass light into the plastic underneath. A pigment-mixing formula alone misses that geometry. [Prusa’s model, validation and limitations](https://github.com/prusa3d/prusa-fdm-mixer#caveats) · [Snapmaker’s optical examples](https://www.snapmaker.com/blog/getting-started-with-full-spectrum-slicing/)

## What the public measurements show

On 42 held-out measurements within the project’s ratio limits, Prusa’s calibrated model gave a closer match on 33. The median improvement was larger for pairs than for triples. Each number below is a median CIEDE2000 color error, where smaller is better. [Held-out measurements at the tested revision](https://github.com/prusa3d/prusa-fdm-mixer/blob/67d81954bfef541f9d3a53766f1a4b88d8403607/data/holdout-set.jsonl) · [Model at the tested revision](https://github.com/prusa3d/prusa-fdm-mixer/tree/67d81954bfef541f9d3a53766f1a4b88d8403607/src)

| Held-out measurements | STL Painter | Prusa model |
| --- | ---: | ---: |
| All 42 | 10.49 | 8.96 |
| 23 two-filament measurements | 10.67 | 8.85 |
| 19 three-filament measurements | 10.32 | 10.20 |

To reproduce the comparison, use revision `67d81954bfef541f9d3a53766f1a4b88d8403607`. Include every measured row with two or three ingredients and a fraction of at least 0.33 for each ingredient. Use the recorded fractions, treating equal thirds as a proxy for the app’s 34/33/33 split. Give each model only the ingredient hexes and fractions, round the predicted color to an eight-bit hex, then use the reference implementation’s `hexToLab` and `deltaE2000` against `row.lab`. For the example beige/white pair, the calibrated model predicts `#F1E3C0` at 50/50. Only a sample printed with those spools can settle which preview is closer. [Reference implementation and measurements](https://github.com/prusa3d/prusa-fdm-mixer/tree/67d81954bfef541f9d3a53766f1a4b88d8403607)

## A print comparison that would settle the choice

Print solid controls plus the three suggested pair ratios for beige/white, a dark/light pair, and terracotta/teal. Include one 34/33/33 sample. Put the same recipes on a vertical wall and a shallow slope, and repeat with two layer heights that the intended printer and spools support. Check the samples up close and at their intended viewing distance under consistent light. Record which recipe looks closest to each target and which shows visible bands. If a colorimeter is available, measure the solids and blends, compare each model’s median and worst color errors, and reserve a few recipes or spool pairs to check the result after choosing a model. This would give STL Painter evidence for a preview default and a practical tolerance for adding a new stamp color. [FDM angle measurements](https://arxiv.org/abs/1805.01375) · [Prusa’s measurement harness](https://prusa3d.github.io/prusa-fdm-mixer/apps/harness/)
