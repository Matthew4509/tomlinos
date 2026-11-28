# Photo Editor review: tools and features compared with GIMP and Photoshop

Date: 28 November 2026. Report only; no code was changed.

How this was checked: by reading `src/apps/photoedit.ts` (about 2,500 lines) and the 14 files in
`src/apps/photoedit/` (about 3,800 lines), plus the names of the tests in `test/`. The app was not run and the tests
were not run for this review.

## The short answer

Photo Editor is a good, careful **"light GIMP"** for everyday jobs: crop, resize, straighten by turning, fix the
colour, clone out a blemish, put text or a meme on a photo, and stack a few layers with masks and blend modes. Its
undo, safety on save and file checks are better than most web editors.

It is **not a replacement for GIMP or Photoshop** for serious photo or design work. The four biggest reasons:

1. **Everything is destructive.** There are no adjustment layers, smart objects, live filters or layer effects.
   A colour change or filter is baked into the pixels at once. Photoshop is built round non-destructive editing; GIMP
   3 now has non-destructive filters too.
2. **8 bits per channel, sRGB only.** No 16-bit or 32-bit colour, no colour profiles, no CMYK, no RAW. Heavy
   levels or curves will band, and print work is not possible.
3. **Very few filters.** Blur and sharpen are a single 3 × 3 pass, with no strength or radius; there is no Gaussian
   blur, unsharp mask, noise reduction, distort, lens, or artistic filters. GIMP has well over 100 filters and
   Photoshop has a similar number.
4. **No paths, no perspective or warp, and no smart selection.** There is no pen tool, no Bézier curves, no
   perspective or warp transform, and no edge-aware selection such as Select Subject, Quick Select or Refine Edge.

## 1. What it really has

### Selection
- Rectangle, ellipse (with a soft one-pixel rim), lasso (drag freely, or click corner by corner).
- Magic wand with tolerance and "Joined areas only". It reads the **active layer only**; there is no option to sample
  all layers.
- Replace, add (Shift), take away (Alt), intersect (Shift+Alt).
- Select all, none, invert, soften the edge (feather, 1 to 500 pixels), crop to selection.
- Selections are real soft masks (0 to 255), and painting, fills, filters and colour changes all stay inside them.
- Missing: select by colour across the picture from a menu, grow or shrink, border, quick mask, Select Subject or
  Quick Select, Refine Edge, saving a selection, and paths turned into selections.

### Painting and retouching
- Brush and eraser: size (1 to 400), hardness, opacity, spacing, and pen pressure (on size).
- Fill bucket with tolerance; gradient (straight or round, two colours); colour picker (reads the picture as seen;
  Alt picks the second colour); two colours with a swap (X).
- Clone stamp and heal (Alt+click for the source). Heal matches the colour round the edge; it is a simple heal, not
  Photoshop's content-aware heal.
- Smudge, dodge or burn, and blur or sharpen as brushes. Overlapping dabs never go past the chosen strength.
- Missing: brush shapes or presets (only round), a pencil (hard, no smoothing), an airbrush, brush smoothing or
  stabiliser, symmetry painting, history brush, content-aware fill, a spot-healing brush, red-eye, colour replace.

### Layers, masks and blend modes
- Up to 100 layers: add, copy, delete, rename, drag to reorder, show or hide, opacity, lock, merge down, flatten.
- 16 blend modes (the 16 the browser canvas offers: Normal, Multiply, Screen, Overlay, Darken, Lighten, Colour dodge,
  Colour burn, Hard light, Soft light, Difference, Exclusion, Hue, Saturation, Colour, Luminosity).
- Layer masks: white, black or from a selection; paint on them with every tool; invert, apply, delete.
- Editable text layers (they become pixels when painted on or filtered).
- Missing: layer groups, adjustment layers, clipping masks, layer effects (shadow, glow, stroke, bevel), vector or
  shape layers, linked layers, partial locks (pixels, position, alpha), and blend modes outside the canvas's 16
  (Linear burn, Vivid light, Linear light, Pin light, Divide, Subtract, Grain extract and merge). A layer is always
  the size of the picture; GIMP and Photoshop allow layers bigger or smaller than the canvas.

### Adjustments and filters
- Colour windows, each with a live preview: brightness and contrast, levels (with a histogram and Auto), curves (per
  channel), hue / saturation / lightness, colour balance (shadows, midtones, highlights), threshold, posterise,
  desaturate (three ways), invert colours.
- Filters: greyscale, sepia, blur a little and sharpen a little (one fixed 3 × 3 pass each).
- Added after this review: ten filters with settings and a live preview (see "Since this review" at the end).
- Missing: lens and surface blur, vibrance, exposure, shadows and highlights, white balance, gradient map, channel
  mixer, replace colour, photo filter, every distort filter (ripple, twirl, spherise, displace), artistic filters,
  lighting, and a filter gallery. Adjustments and filters cannot be saved as presets.

### Transform and crop
- Move, stretch (Shift keeps the shape) and turn a layer or a selection, with 15-degree steps; Enter applies.
- Crop tool, crop to selection, resize picture (smooth scaling, high quality), canvas size (anchor), rotate 90 degrees
  either way, flip the whole picture or one layer.
- Missing: perspective, skew and distort handles, warp and puppet warp, liquify, content-aware scale, a straighten
  (level a horizon) tool, a crop with a set ratio or guides, choice of resampling method, and transforms that stay
  editable (each turn or stretch resamples the pixels again).

### Text and shapes
- Text tool: 12 font names (only fonts already on the computer), size, colour, bold, italic, left, centre or right,
  an outline (colour and width). Text stays editable in .ora.
- Meme panel: top or bottom bars, text boxes whose words fit the box, drag and stretch.
- Shapes: line, arrow, rectangle, ellipse (filled or outlined). They become pixels at once.
- Missing: text on a path, letter spacing and line spacing, mixed styles in one text box, web or uploaded fonts,
  text shadow, vector shapes that stay editable, rounded rectangles, polygons and stars, a pen tool.

### Colour management and bit depth
- 8 bits per channel RGBA, sRGB only (the browser canvas).
- On save over a file it warns when the file holds what would be lost: a colour profile, 16-bit or CMYK colour,
  camera details (EXIF), print size, more frames.
- Missing: 16-bit and 32-bit (float) work, colour profiles (ICC) in or out, soft proofing, CMYK, Lab, indexed colour,
  and a choice of colour picker models (only the browser's own colour box).

### File formats in and out
- Opens: PNG, JPEG, GIF (first frame only), WebP, AVIF, BMP, SVG (drawn flat), ICO, OpenRaster (.ora, with layers).
- Saves: PNG, JPEG and WebP (flat), and .ora with layers, text and masks. GIMP and Krita open the .ora.
- Paste from the clipboard as a layer or a new picture; copy to the system clipboard as PNG.
- Missing: GIMP .xcf and Photoshop .psd (in or out), TIFF, camera RAW, PDF, HEIC, animated GIF or WebP, ICO and
  AVIF out. JPEG and WebP are always saved at quality 0.92, with no slider, and EXIF is not kept.

### History and undo
- Undo and redo up to about 256 MB. It keeps only the 64 × 64 tiles each step touched, so many strokes on a big photo
  fit. The undo and redo buttons name the step. Undoing back to the saved point counts as saved again.
- Recovery: a copy of unsaved work every two minutes, offered back if the page stops.
- Missing: a History panel (a list of steps to jump back to), snapshots, and a history brush.

### Non-destructive editing
- Only three things stay live: layer masks, editable text layers and layer settings (opacity, blend mode, show or
  hide).
- Missing: adjustment layers, smart objects, smart or live filters, layer effects, editable transforms, vector
  layers. This is the largest single gap with Photoshop.

### Performance limits
- Largest picture: 50 million pixels and 20,000 on a side; file up to 60 MB.
- All layers together: about 150 million pixels (about 600 MB); for example 12 layers of 12 megapixels. A mask counts
  as a layer.
- All pixel work runs on the main thread in plain JavaScript on the 2D canvas: no workers, no WebGL or WebGPU. A
  filter or colour change on a 40-megapixel layer will freeze the window while it runs.
- GIMP and Photoshop handle pictures of hundreds of megapixels, with tiles on disk and the graphics card.

### Keyboard and UI
- Classic menu bar (File, Edit, View, Image, Layer, Select, Tools, Colours, Filters, Help), Standard and Tools
  toolbars and a Tool options bar, kept per person.
- A key for each of the 22 tools (close to GIMP and Photoshop: V, M, W, C, B, E, G, T, I, S, J and so on), Space to
  move round, + and - to zoom, 0 fit, 1 actual size, [ and ] brush size, X swap colours, F7 Layers panel, and Ctrl+Z,
  Y, X, C, V, A, I, E, L, M, U, S, O.
- Zoom from 5% to 1,600%, with pixels shown sharp at 200% and above.
- Missing: rulers, guides, a grid and snapping; a Navigator panel; Info panel (cursor position, colour values);
  a Swatches or palette panel; dockable panels that can be moved; custom key settings; actions, macros or batch work;
  scripts and plug-ins.

## 2. Comparison table

Have = as good as or close to what the others do for common work. Partial = the basics are there, with gaps.
Missing = not there.

| Group | Photo Editor | GIMP 3 | Photoshop | What Photo Editor lacks (for Partial) |
|---|---|---|---|---|
| Selection | Partial | Have | Have | No grow, shrink or border; no quick mask; no smart or edge-aware selection; no saved selections; the wand reads one layer only |
| Painting | Partial | Have | Have | Round brush only; no presets, smoothing, pencil or airbrush; pressure changes size only |
| Retouching | Partial | Have | Have | Clone, heal, smudge, dodge, burn are there; no content-aware fill, spot heal, patch tool, red-eye |
| Layers | Partial | Have | Have | No groups, clipping masks, layer effects or layers of their own size; 100 layers at most |
| Masks | Have | Have | Have | (Missing only vector masks and quick mask) |
| Blend modes | Partial | Have | Have | 16 modes, against about 38 in GIMP and 27 in Photoshop |
| Adjustments | Partial | Have | Have | The core eight are there; no vibrance, exposure, shadows and highlights, channel mixer, gradient map, presets |
| Filters | Partial (was Missing) | Have | Have | Since this review: blurs, sharpen, noise, pixelate, emboss, edges and vignette with settings; still no distort, lens, artistic or lighting filters |
| Transform and crop | Partial | Have | Have | Move, scale, turn, crop, resize, canvas size are there; no perspective, skew, warp, liquify, straighten, crop ratio |
| Text | Partial | Have | Have | Basic text with outline; no spacing controls, mixed styles, text on a path, or fonts other than the computer's |
| Shapes and paths | Missing | Partial | Have | Shapes are flat pixels; no pen tool, paths or vector shapes |
| Colour management and bit depth | Missing | Have | Have | 8-bit sRGB only; no profiles, 16 or 32-bit, CMYK |
| File formats | Partial | Have | Have | PNG, JPEG, WebP, .ora are good; no .psd, .xcf, TIFF, RAW, PDF, animated GIF; no JPEG quality choice; EXIF dropped |
| History and undo | Partial | Have | Have | Strong undo; no History panel or snapshots |
| Non-destructive editing | Missing | Partial | Have | Only masks, text and layer settings stay live |
| Performance | Partial | Have | Have | 50 megapixels at most; main-thread work only, so big filters freeze the window |
| Keyboard and UI | Partial | Have | Have | Good keys and menus; no rulers, guides, grid, navigator, info or swatches panels; no actions or scripts |
| Automation and plug-ins | Missing | Have | Have | None |
| Animation | Missing | Partial | Partial | None |
| Recovery after a crash | Have | Partial | Have | (Saves a copy every two minutes) |

Where it is ahead of a typical web editor: tile-based undo that stays small; soft selections that every tool keeps
to; heal that matches the edge; careful checks of a file's size before it is opened; warnings before a save drops a
colour profile or camera details; .ora so layers move to and from GIMP and Krita.

## 3. Where it sits

A good quick editor for crops, resizes, simple colour fixes, layers with masks, text and memes. It is about where
Paint.NET or a simple web editor sits, with a better undo and better masks than most. It is not a pro replacement,
and the help window already says so honestly.

The gaps that stop it being one, most important first:

1. No non-destructive editing (adjustment layers, live filters, layer effects).
2. Only 8-bit sRGB, with no colour profiles.
3. Almost no filters, and blur and sharpen have no settings.
4. No paths, no pen tool and no perspective or warp transform.
5. No smart or edge-aware selection.
6. No .psd or .xcf, so work cannot pass to and from the big two with layers except through .ora.
7. All work on the main thread, so big pictures freeze the window.

## 4. Next features worth adding, ranked

Ranked by how much they close the gap for normal users, against the effort. Sizes: small (a day or two), medium (about
a week), large (several weeks).

| Rank | Feature | Size | Why |
|---|---|---|---|
| 1 | **Gaussian blur and unsharp mask with a radius and strength** (and a live preview, as the colour windows have) | Small | The most-used filters in any editor. The box-blur code in `selection.ts` (feather) is already a fast Gaussian; it only needs to run on colour. Fixes the "blur does almost nothing" problem. |
| 2 | **JPEG and WebP quality slider, and keep EXIF on save** | Small | Every photo save goes through this. Quality is fixed at 0.92 now. Copying the EXIF block back into the JPEG is plain byte work, and the app already reads it. |
| 3 | **Do filters and colour work in a Web Worker** | Medium | The pixel code is already plain functions on arrays (made to test in Node), so it moves to a worker easily. Stops the window freezing on big photos and allows a progress bar and Cancel. |
| 4 | **Adjustment layers** (levels, curves, hue, brightness and contrast to start) | Large | The biggest step towards Photoshop. The adjustments already exist as table and pixel functions, and masks already exist, so an adjustment layer is "a layer that holds settings and a mask, run on what is below it" at draw time. Needs care for speed (cache the result). |
| 5 | **More filters, in a set**: noise reduction (median), add noise, vignette, pixelate, emboss, edge detect, motion blur, high pass | Medium | Cheap one by one, and they fill the "Filters" menu that looks thin. Each is a plain function with a test. |
| 6 | **Perspective and skew handles on the Move tool, and a straighten tool** | Medium | Perspective is the most asked-for transform after rotate (fixing a photo of a document or building). The box sums are in `transform.ts`; a perspective draw needs a small mesh of triangles on the canvas or WebGL. Straighten is a line drawn then a turn, mostly done already. |
| 7 | **Selection extras**: grow, shrink, border, select by colour from a menu, sample all layers for the wand, quick mask | Small to medium | Each is a short mask function (grow and shrink are a dilate and erode of the mask). Makes selections far more usable without any AI. |
| 8 | **History panel** | Small | The history already holds named steps. A list to click back to is mostly UI. |
| 9 | **Layer groups and clipping masks** | Medium | Needed once a picture has more than a handful of layers, and .ora already has groups (they are flattened on open today). |
| 10 | **Layer effects: drop shadow, outer glow and stroke** | Medium | The most used Photoshop "live" features for text and cut-outs. The canvas has `shadowBlur` and `shadowColor`, so a first version is cheap. |
| 11 | **Rulers, guides, grid and an Info panel** (cursor position and colour value) | Small to medium | Expected in any serious editor; helps line things up and check colours. |
| 12 | **Open .psd (flattened first, layers later) and TIFF** | Medium to large | The single most common "I cannot open this" complaint. A reader for .psd layers in plain TypeScript is real work, but flattened .psd (the merged picture in the file) is small. |
| 13 | **16-bit colour** | Large | The 2D canvas is 8-bit. It needs the picture kept in arrays (or WebGL float textures) and drawn to the screen from them, which touches every tool. Only worth it if the app aims at photographers. |
| 14 | **Paths and a pen tool** | Large | Needed for clean cut-outs and vector shapes; a big design job. Leave until the above are done. |
| 15 | **Smart selection** (Select Subject) | Large | Needs a model in the browser (for example a small segmentation model run with WebGPU). Impressive, but heavy and slow to load. Leave until last. |

A sensible order for a next round: 1, 2, 7 and 8 together (all small), then 3, then 4. After those, the app would
fairly be called a "light Photoshop" for photo fixes, though still not a pro replacement until 13 and 14.

## Since this review (29 November 2026)

Ranks 1 and 5 are done (not committed). Filters menu, each with a settings window that previews on the picture and
becomes one undo step:

- Gaussian blur (radius 0.5 to 100) and motion blur (length and angle).
- Sharpen (unsharp mask: amount, radius, threshold) and high pass.
- Reduce noise (median, radius 1 to 5) and add noise (strength, grey or coloured grain).
- Pixelate, emboss (light angle, depth, keep the colours), find edges (strength, or dark lines on white), vignette
  (darken or lighten, where it starts, softness).

The old quick Blur and Sharpen are still there, renamed "Blur a little" and "Sharpen a little". Filters stay inside
the selection and read the pixels just outside it, so a blurred selection has no hard seam.

Speed, timed in Node on this PC (an i7-6700K) on a 12-megapixel picture: pixelate, vignette, add noise and emboss take
under a second; find edges about 1.5 seconds; Gaussian blur, sharpen and high pass about 3 seconds at any radius;
reduce noise about 4 seconds at radius 3; motion blur about 6 seconds. The window freezes while a filter runs. On
pictures over 3 megapixels the preview waits until a slider is let go, and says "Working...". Rank 3 (a Web Worker)
is the fix for the freeze.
