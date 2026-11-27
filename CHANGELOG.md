# What's new in STL Painter

## What's new in 1.0.13

[Watch the eight painting tool demos in the README](README.md#painting-tools).

- **Fill Lasso (L)** paints the visible surface inside a smooth curve. Position the camera, then click to place nodes. Backspace removes the last node, even from a closed preview. Click the first node to close the loop and press Enter to apply.
- **Fill Band (H)** paints between two positions along X, Y, or Z. Click the bounds in either order, including beyond the model, or enter exact millimeters. Inspect the preview before applying.
- **Fill Gaps (G)** finds small patches surrounded by one color or mix. Set a maximum size in millimeters and enable **Include thin seams** to look for narrow strips with matching paint on both sides. Apply the preview in one undoable edit.
- **See how much subdivision you’re using.** The status bar shows the paint triangle count against the new **2,000,000** limit. When a stroke ends or you apply paint, matching subdivisions along the edited edge merge. One Undo restores both color and detail.
- **Switch and protect colors.** Press **1–9** or **0** for the first ten swatches, Alt-click the model to pick a solid or mix, and lock swatches to protect their paint. Opening another STL keeps your palette. Each three-filament combination gets one balanced mix suggestion.
- **Keyboard and project controls.** Either Enter key applies a ready preview. In Fill, tap or hold **[** and **]** to adjust the edge angle in 1° steps. **Clear all paint** is under **Project**, and **Save As** updates the displayed project name. [Printable hotkey cheat sheet (PDF)](docs/STL-Painter-Hotkeys.pdf)

## What's new in 1.0.12

- **Reuse a filament palette.** Choose **Save palette** to keep the base color, filaments, and mixed-color recipes in a `.stlpalette` file. Choose **Load palette** in another project to apply it. One **Undo** restores the previous palette and artwork.
- **See where Fill will paint.** Press **F** and hover over the model. The highlight follows the current edge angle and paint-boundary setting. Click to fill the highlighted region.
- **Adjust Fill without moving the mouse.** Press **[** to lower the edge angle by 5° or **]** to raise it by 5°. The preview updates under the pointer.

## What's new in 1.0.11

- **Resize stamps live.** Drag the pixel-width slider to watch the artwork grow or shrink on the model. With edge refinement enabled, the final subdivision runs once when you release the slider.
- **Pick a mix by color.** Click a suggested swatch to set its filaments and percentages. The picker shows up to 90 suggestions across the palette, and you can still enter a custom recipe.
- **Start painting again from the base color.** Click **Clear all paint** to erase the model, including applied stamps and lettering. One **Undo** restores the painting.
- Opening large models, saving projects, exporting 3MFs, and matching stamp colors now run in the background. Refined strokes and undo update the affected mesh sections, and Fill reuses connectivity across edits.

## What's new in 1.0.9

- Preview mixes for every pair or trio of filaments in your palette. Select a suggested swatch, adjust its percentages if needed, then click **Add mix** to paint with it.
- Browse saved mixes in a collapsible list. Each row shows the name, hex code, and full recipe, including when the sidebar is narrow.
- Match image stamps to existing spools and mixes by perceived color. The importer can also suggest new mixes from the filaments you already have.
- Preview blends using a model calibrated on printed PLA. **Add Color** suggests a spool that expands the range of colors your palette can produce.
- Save recipes in your painter project and export them with painted faces in a 3MF. The horizontal slice check counts the physical filaments each mix uses.
- Fixed a JavaScript error that could appear when a title update arrived after the app window closed.

## What's new in 1.0.8

- Set brush diameter, text size, and stamp width in **millimeters** for repeatable measurements across models and zoom levels.
- Use **Align to face** to look straight at any visible polygon with one click, then continue painting.
- Reopen a saved project with its camera, active tool, selected color, and size settings restored. Older projects gain these settings the next time you save them.
- Open a project by passing its path to **STL Painter.exe**. The title and header show the active project filename, and Export suggests a matching 3MF filename.
- Each palette color has a unique RGB value. Opening older projects merges duplicate colors while preserving their appearance on the model and in saved stamps.
