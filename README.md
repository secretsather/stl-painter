# STL Painter

STL Painter is an offline Windows desktop app for preparing multicolor 3D prints. Open an STL, paint the surface, add a logo or lettering, and export a color-painted 3MF for your slicer. Save a painter project if you want to come back and edit it later.

**[Download STL Painter 1.0.6 for Windows (64-bit ZIP)](https://github.com/secretsather/stl-painter/releases/download/v1.0.6/STL-Painter-1.0.6-Windows-x64.zip)**

![STL Painter showing the sample fluted vessel with an orange surface and cream stripe, the view cube, and the four-color palette](assets/stl-painter-workspace.png)

## Install on Windows

Use **64-bit Windows** with graphics support for WebGL 2.

1. Download the Windows ZIP using the link above.
2. Right-click the ZIP and choose **Extract All**.
3. Open the extracted folder and double-click **STL Painter.exe**. Keep the executable with the accompanying files.

Keep your saved projects in a separate folder. To update a portable copy, extract the new ZIP into its own folder and open your existing projects from there.

## Paint your first model

1. **Open a model.** Click **Open** and choose a binary or ASCII `.stl`, or try the sample vessel. The upper-left readout shows X, Y, and Z dimensions in millimeters.
2. **Choose a color.** Click a palette row to paint with that color. Click its colored square to change the color itself. **Color 1** is the base exposed by the eraser.
3. **Paint the surface.** Choose **Brush** and left-drag across the model. Right-drag to orbit, hold the mouse wheel and drag to pan, and scroll to zoom. Click a face of the view cube to work straight on.
4. **Save your work.** Click **Save** to write a self-contained `.stlp` with the model, paint, palette, and stamp library. Use **Ctrl+Shift+S** to save a separate copy.
5. **Export for printing.** Apply any pending stamp or text, then click **Export (3MF)**. To keep your current printer settings, open your slicer first and import the 3MF into your plate. Check the filament assignments before slicing. Used palette entries are exported in palette order.

## Painting tools

| Tool | How to use it |
| --- | --- |
| **Brush** | Drag to paint the visible surface. Adjust **Diameter**, or zoom in for finer strokes. |
| **Fill** | Click to fill across connected faces. **Edge angle** controls how sharp an edge the fill can cross. **Respect paint boundaries** stops the fill at an existing color change. |
| **Eraser** | Drag to restore the base color. Brush and Eraser share the **Refine stroke edges** setting. |
| **Stamps** | Select **Import artwork** for a PNG, JPEG, WebP, or BMP. Choose existing palette colors or add colors from the image, then click **Add to stamps**. Adjust width and rotation, drag into position, and click **Apply stamp**. |
| **Text** | Type a label, choose an installed font and palette color, and set size, bold, italic, or multiline alignment. Position it and click **Apply text**. The project stores applied lettering as surface paint. |

**Edge refinement** starts on. It subdivides the painted surface along a boundary to smooth strokes, stamp outlines, and lettering. Stamps and text use a quick preview while you drag and refine when you release. **Esc** cancels placement and returns to Brush.

**Stamp transparency.** In the import preview, scroll over a detail to zoom and drag to pan. Adjust **Opacity cutoff** to remove a faint halo or recover thin lines. **Show removed pixels** highlights what the cutoff excludes. The checkerboard marks areas where the model’s existing paint will show through. Select **Fit image** to see the whole stamp again.

**Reusing artwork.** When you return to Stamps, click an imported thumbnail to start a placement. The dotted outline shows its position, including over empty space in the viewport. Click **×** beside a stamp to remove it from the library. Copies already applied to the model keep their paint.

## Palette and printer color limits

A project can have **1–16 palette colors**. Use **+** to add one or **×** to remove one. If the color is in use, choose a replacement for the model and saved stamps. Removing the base color lets you choose a new base. The last color stays in the palette. **Ctrl+Z** restores a removed color or stamp during the current editing session.

For a four-filament printer, click **Slice colors** in the lower-left of the viewport and set **Colors per horizontal slice** to **4**. A fifth color at the same height triggers a red warning triangle. Click it to see the colors involved and an example height. You can use more than four colors across the whole model if each horizontal slice stays within your limit.

The limit defaults to four, accepts 1–16 or **Off**, and is remembered on this computer. The check uses committed surface paint, including the base color. Your slicer determines the final tool changes, infill, and supports.

## Controls

| Action | Control |
| --- | --- |
| Brush / Fill / Eraser / Stamps / Text | B / F / E / S / T |
| Orbit / pan / zoom | Right-drag / middle-drag / scroll |
| Fit the model in the studio view | Home |
| Change brush or eraser diameter | [ and ] |
| Apply a positioned stamp or text from the viewport | Enter |
| Cancel placement and return to Brush | Esc |
| Undo / redo | Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z |
| Open / save / save as | Ctrl+O / Ctrl+S / Ctrl+Shift+S |

Click **Perspective** to switch to orthographic projection. Drag the left edge of the sidebar to resize it, or double-click the edge to restore its default width. The **?** button opens the in-app controls guide.

## Model and artwork limits

- STL Painter supports up to **1,500,000 source triangles** and warns before opening a model above **1,000,000**.
- A stamp image can be up to **32 MB** and **16 megapixels**. Palette mapping samples up to **512 pixels** along the longest side. Each project has a **96 MB** embedded artwork budget.
- Export preserves the usable source triangles and encodes the refined paint boundaries in the 3MF. Undo history lasts for the current editing session.

## Run from source

On Windows, install **Node.js 24** with npm. Download or clone this repository, open PowerShell in the folder containing `package.json`, and run the following commands. The first two install the locked dependencies and the Electron runtime.

```powershell
npm.cmd ci
npx.cmd install-electron
npm.cmd start
```

### Test and package

| Command | Result |
| --- | --- |
| `npm.cmd test` | Runs the model, paint, and file-format tests. |
| `npm.cmd run test:app` | Builds the app and exercises painting, undo, saving, reopening, and export in an offline desktop session. |
| `npm.cmd run build` followed by `node --test test/release-edges.mjs` | Checks release regressions, including same-file saves, triangle limits, and stamp dragging. |
| `npm.cmd run dist:portable` | Builds the Windows x64 portable ZIP in `release/`. |
| `npm.cmd run dist` | Builds the Windows x64 installer in `release/`. |

Set `PAINTER_EXE` to the path of an extracted or installed **STL Painter.exe** to run the desktop tests against that build. To test a slicer round-trip, set `SLICER_EXE` to a slicer executable that supports the `--export-3mf` option and painted 3MF files.
