# STL Painter performance review

November 26, 2026 · Review of the 1.0.10 working copy based on commit `6486cdf`, with results for 1.0.11

## Implemented changes and follow-up measurements

Version 1.0.11 includes the changes measured below. The original review and its measurements follow the updated results.

| Operation | Original | Updated |
| --- | ---: | ---: |
| Open a 180,000-triangle STL in Electron, total time | 358 ms | 177 ms |
| Longest renderer timer gap during Open | 334 ms | 15 ms |
| Export that grid in Electron, total time | 257 ms | 274 ms |
| Longest renderer timer gap during Export | 227 ms | 9 ms |
| Peak resident memory of a fresh million-triangle export process | 789 MiB | 123 MiB |
| Parse and initialize the million-triangle binary STL | 1,520 ms | 148 ms |
| Commit one refined cell on the sample, before the next frame | 39–41 ms | 1.0 ms |
| First 8 px-radius refined dab with a cached pick buffer | 23–25 ms | 3.3 ms |
| Color-buffer upload for one painted cell | 2,787,849 bytes | 9 bytes |
| Draw eight stamp thumbnails | 44 ms | 0.4 ms |
| Repeat a detailed 512 px stamp match with sixteen filaments and three additions | 402 ms | 80 ms |

UI and core timings use the original Windows machine and fixtures. Times are medians of three warm runs. The export memory figures are single fresh-process high-water measurements from comparable indexed meshes, starting at about 65 MiB. The new exporter streams to a local file. The thumbnail benchmark times drawing at the current sidebar size. Paint-only undo now skips the library entirely. The repeated stamp match reuses the open dialog’s image statistics and palette index. First-time matching still prepares those caches.

- **Files.** The desktop asks for the output path first. A background worker streams XML and compressed 3MF bytes to a temporary file, then the desktop atomically replaces the destination. Binary STL parsing uses numeric hashing with exact float32 coordinate checks. Opening a file also prepares its picking tree and display buffers off the renderer thread. The updated Export took 17 ms longer end to end on the 180,000-face fixture while keeping the window responsive.
- **Painting.** Surface sections retain their own geometry, colors and source-face offsets. Stroke commits, undo and redo replace affected sections. The flat paint buffers still copy unchanged byte ranges to preserve the on-disk leaf order. Refined brushes use the source-mesh spatial tree to find relevant faces. Preview masks cover touched sections, and WebGL receives dirty color ranges. Pixel-width dragging displays the stamp live and runs the final subdivision on release.
- **Fill and slice checks.** A persistent Fill worker caches connectivity per section and joins neighbors across differently subdivided boundaries. After a one-cell split, updating connectivity took 14 ms on the sample and 56 ms on the million-triangle grid in the core benchmark. Slice checks reuse section heights and cache results by geometry, paint revision, filament masks and limit. Paint snapshots wait until a worker can consume them, or until a new brush stroke would alter a pending snapshot.
- **Artwork and UI.** Matching runs in a worker with one pending request. A superseded result cannot enable Import. Stamp thumbnails reuse their DOM nodes and redraw when their source pixels or referenced colors change. Original PNG bytes go directly into the project. For a 2048 × 2048 synthetic PNG, storing the ZIP entry took 23 ms compared with 318 ms for recompression, at a cost of about 33 KiB in a 12.5 MiB archive. Native dirty-state notifications fire on transitions.

The updated working copy passed all 22 core tests, 19 desktop regression tests and the offline desktop workflow. On a fixture with nested splits and a three-filament mix, all five 3MF entries and all six project entries matched the previous writer byte for byte after decompression.

## Original review

The largest measured costs were 3MF export, synchronous image-stamp matching, and rebuilding geometry or connectivity for small edits. Painting a small area on the sample was generally quick once the camera and geometry caches were warm. Several common actions discard those caches.

## Findings in recommended order

| Priority | User action and evidence | Change to make |
| --- | --- | --- |
| 1 | **Open, Save As, or Export.** The Electron window’s 8 ms timer went **334 ms** between ticks during Open and **227 ms** during Export on the 180,000-triangle grid. The million-triangle export took **1.68 s** in the core benchmark. A separate fresh process with the mesh already resident went from **65 MiB** to **789 MiB peak** producing an 8.5 MiB 3MF. Export builds an array of XML strings, joins it, encodes it, then compresses it. The destination dialog also opens after serialization, so canceling still incurs that work. | Ask for a destination first. Run parsing and serialization in a worker and write XML and ZIP data in bounded chunks to the existing temporary-file workflow. Preserve the editable mesh buffers, atomic rename, and save revision semantics. Moving the existing exporter to a worker should improve responsiveness, while streaming addresses peak memory. [File commands](../src/app.js#L605) · [3MF writer](../src/files.js#L205) · [Destination handling](../desktop/main.cjs#L147) |
| 2 | **Adjust image-import opacity or requested colors with mixed matching enabled.** Every input event builds recipes, constructs a color-search tree, scans the artwork and redraws the preview. A detailed 512 × 512 synthetic image took **259 ms with four filaments** and **402 ms with sixteen** for mapping alone. Generating candidates separately took **1.5 ms** and **35 ms**. A flat three-color graphic took **18 ms** to map with sixteen filaments. | Update the slider value immediately. Cache the recipes and their search tree for the active palette, and reuse image statistics when only the requested color count changes. Run matching in a worker and apply only the latest requested result. Preserve the current perceptual matches, opacity handling, 33% floor and three-filament limit. The 90 visible suggestions and pixel-width slider already have separate controls. [Import handlers](../src/app.js#L1015) · [Matching](../src/stamps.js#L47) · [Recipes](../src/mixes.js#L39) |
| 3 | **Finish or undo a refined stroke.** Any split makes the app rewrite the complete paint tree and rebuild the display surface, including normals, colors and picking IDs. Committing **one split** on the sample took about **39–41 ms** in Electron before the next displayed frame. On the million-triangle grid, rebuilding just the CPU surface took **466 ms**. The main per-cell display arrays alone require about **163 MiB at the 1.8 million cell cap**, excluding the source mesh, history, picking caches and GPU storage. | Cache source-face normals across paint edits. Group display buffers and paint-tree offsets by ranges of source faces so a stroke and its undo can replace only the affected ranges. Keep the serialized ordering stable and test refinements across range boundaries. [Stroke commit](../src/app.js#L237) · [Tree rewrite](../src/paint-tree.js#L84) · [Surface construction](../src/mesh.js#L206) · [Display buffers](../src/viewport.js#L110) |
| 4 | **Use Fill for the first time or after refinement.** The first flood query took **203 ms** on the sample and **566 ms** on the million-triangle grid. Repeating with cached adjacency took **28 ms** and **43 ms** respectively. The graph belongs to the display surface and disappears when that surface is replaced. These timings exclude applying paint and recording undo. | First, return immediately when “Respect paint boundaries” is on and the seed already has the selected color. Prepare adjacency off the UI thread for the current topology and reuse it until topology changes. If fill remains slow after refinement, update the edited region and its neighboring edges. Preserve disconnected shells and coarse-to-fine edge behavior. [Fill handler](../src/app.js#L1170) · [Adjacency and flood](../src/mesh.js#L251) |
| 5 | **Paint immediately after orbiting or settle a stamp preview.** With picking already available, the first refined 8 px-radius dab took **23–25 ms** to build projected cell bounds and paint. A warm dab took **3–4 ms**. Every subsequent dab still tests every cell’s bounds. A 96 px two-color ring took **0.1 ms** for drag projection and **53 ms** for its settled, refined preview. Building the preview mask alone for a single-cell edit took about **2 ms**. | Index projected bounds into screen tiles or query candidate source-face groups through the existing spatial tree. Run exact clipping, occlusion, and subpixel checks on the resulting candidates. Retain the lightweight drag path and the deferred pixel-size preview. Reuse preview indices or update only affected mesh chunks if mask construction remains material. [Bounds](../src/refined-stroke.js#L51) · [Dab scan](../src/refined-stroke.js#L276) · [Preview mask](../src/viewport.js#L180) |
| 6 | **Paint a single unrefined cell or move an artwork preview.** On the sample with one additional split, changing one cell issued a **2,787,849-byte WebGL color-buffer update**. A cell occupies nine color bytes. Palette additions also recolor the entire surface even when the new slot has no painted cells. | Track and merge dirty color ranges per animation frame, with a full upload for broad fills or resets. Separate palette lookup changes from recoloring cells. A pure append can update the lookup alone. [Color updates](../src/viewport.js#L267) · [Add Color](../src/app.js#L695) |
| 7 | **Select a stamp or undo an ordinary brush edit with a populated library.** Both paths rebuild every thumbnail at its full indexed image resolution. Creating eight 512 × 512 thumbnails took **44 ms** in Electron, before rebuilding the list or laying it out. | Retain thumbnail canvases at sidebar display resolution, update selection in place, and invalidate previews when their pixels or referenced palette colors change. Paint-only undo can skip the stamp list. [Stamp list](../src/app.js#L422) · [Undo](../src/app.js#L291) · [Canvas generation](../src/stamps.js#L117) |

## Smaller opportunities

- **STL parsing.** Each binary triangle creates multiple arrays and converts three float triples to string keys. Parsing and initializing the million-triangle project took **1.52 s**. Once import runs off-thread, profile vertex deduplication separately. Reuse a nine-float scratch buffer and benchmark numeric hashing with exact float32 equality, including signed zero. Preserve face order and degenerate-facet handling. [STL reader](../src/mesh.js#L31)
- **Slice-color checks.** The conflict search already runs in a worker. Preparing fresh height ranges on the renderer took **5.3 ms** at one million cells. With enough physical filaments to enable checking, even a stamp-library-only history entry can copy the paint and schedule another scan. Track revisions for paint, topology, and filament masks, and take a snapshot when the next job can run. The isolated five-color search took **53 ms** on the large grid. [Scheduling](../src/color-limit.js#L31) · [History](../src/app.js#L123)
- **Dirty-state IPC.** Each brush dab rewrites document state and invokes the main process even after the unsaved flag has already changed. Send the native dirty notification on transitions, including transitions back to clean on save or undo. [State](../src/app.js#L110) · [Brush input](../src/app.js#L1139)
- **Original artwork storage.** Import makes a full-resolution canvas and PNG before downsampling to a maximum 512 px for painting. Retain the existing archival quality. An eligible PNG input could be stored directly, and existing compressed PNG entries could be benchmarked with ZIP storage instead of recompression. Time high-resolution artwork before changing this path. [Artwork loading](../src/stamps.js#L137) · [Project writer](../src/files.js#L9)

## Measurements

Windows, Core i7-12700K, RTX 3080 Ti with Direct3D 11, Node 24.15.0. Core timings below are milliseconds, median of three after one warm-up using the working-copy modules. Forced GC ran outside each timed core operation. File operations in this table use memory buffers. The two grids are gently sloped binary STLs, two triangles per square. They exercise many source faces. The sample exercises many paint cells per face.

| Core operation | Sample vessel, 12,544 faces / 309,760 cells | 300 × 300 grid, 180,000 faces / cells | 708 × 708 grid, 1,002,528 faces / cells |
| --- | ---: | ---: | ---: |
| Read binary STL and initialize project | — | 264 | 1,520 |
| Build CPU surface | 29 | 89 | 466 |
| Rewrite paint tree for one split | 8 | 9 | 25 |
| Flood with uncached adjacency | 203 | 121 | 566 |
| Flood with cached adjacency | 28 | 20 | 43 |
| Encode project ZIP | 8 | 103 | 400 |
| Decode and validate project ZIP | 6 | 79 | 181 |
| Encode 3MF ZIP | 61 | 400 | 1,678 |

The Electron Open and Export measurements used the actual UI commands, local temporary files, and automatic dialog answers. The median command times were **358 ms** and **257 ms** on the 180,000-face grid. An 8 ms renderer interval recorded the longest callback gap for each run. Separate viewport probes ran the working-copy classes in Electron at 900 × 600 CSS pixels in Studio view. Graphics timings measure synchronous work, including any blocking readback. They do not measure input-to-display latency. The cold pick-buffer readback and ID decoding varied from **2.8 to 33.6 ms** across runs.

For the core fill timings, the seed was cell zero, the edge angle was 180°, and paint protection was off. For file timings, models used base paint and had no attached stamps. For the image timings, the detailed workload was a seeded opaque RGB noise image with three new mixes requested. The flat comparison used three vertical color bands. For the peak-memory observation, a fresh Node process created indexed mesh arrays directly and performed a single export. The reading is process peak resident memory, including runtime and compressor allocations. These are single-machine results. Complex painted geometry, integrated GPUs and higher-resolution viewports warrant separate measurements.

## What to keep and how to verify improvements

Rendering is already scheduled on demand. The camera pick buffer, text mask and stamp footprint summaries are cached, stamp dragging has a cheaper projection path, and the slice-conflict worker coalesces requests. The sidebar, view cube, font selection and preview pan/zoom do not have the same model-wide costs as the paths above.

Re-run the same fixtures after each change. For file work, track the longest renderer gap and peak process memory as well as completion time. Compare decoded mesh data, paint trees and exported filament definitions. For drawing, compare preview, apply, undo and redo on thin triangles, partially occluded surfaces and disconnected shells. For stamp matching, compare the selected recipes and every output pixel across opacity settings, and check that an older worker response cannot replace a newer preview. The baseline build passed all 20 core tests.
