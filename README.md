# deePDF

A browser-only editor for the **values a PDF is made of** — indirect objects, dictionaries, streams,
content-stream operators and metadata. It is not a visual "click & type" PDF editor: you edit the
structure, and a live preview shows the result.

Everything runs locally in the browser (no server), so it can be hosted as a static site on
Cloudflare Pages.

## Features

| Area | What you can do |
| --- | --- |
| **Pages** | Thumbnails, multi-select, drag-and-drop reorder, move up/down, reverse, delete, rotate. Edit `MediaBox` / `CropBox` / `BleedBox` / `TrimBox` / `ArtBox`, `Rotate`, `UserUnit`, `Tabs`, or the full page dictionary. |
| **Elements** | The page content stream parsed into a tree (`q…Q` groups, `BT…ET` text, paths, images, marked content, inline images). Select one or many → duplicate (with optional dx/dy offset), move up/down, bring to front / send to back, delete, edit any operator inline, or edit the whole stream as raw text. Click a shape in the preview to find it in the tree. Annotations: duplicate / reorder / delete / edit. XObjects and fonts: inspect and export. |
| **Objects** | Tree from the trailer, or a flat filterable list of all objects. Typed editors for every value (number, name, string/hex string, date, rectangle, boolean, reference, null), change type, add/delete keys and array items, reorder items, make indirect / inline. Streams are decoded in the background, edited as operators / text / hex, and re-encoded on save (`/Length` and filters adjusted). Duplicate or delete objects, find who references an object, validate. |
| **Metadata** | `/Info` (all standard keys + custom ones, date/time editor with time zone), XMP (structured property editor + raw XML, sync from `/Info`, create/remove), catalog settings (`PageLayout`, `PageMode`, `Lang`, `Version`, `MarkInfo`), every viewer preference, header version and trailer `/ID`. |
| **Export** | Compression: keep / compress all (Flate) / no compression. Optional object streams + xref stream. Remove unreferenced objects, replace dangling references, renumber objects 1…n, update `ModDate`. The written cross-reference index is verified entry-by-entry and the output is re-parsed before download. |
| **JSON** | Export the complete document description as JSON (streams as readable text when possible, otherwise base64) and load it back with *Open…* — useful for external editing and as a work file. Element selections can be exported as PDF syntax or JSON; images in their original encoding (JPEG → `.jpg`, JPEG 2000 → `.jp2`, JBIG2 → `.jb2`, raw pixels → `.png`); embedded fonts as `.ttf` / `.otf` / `.cff` / `.pfb`. |
| **Signatures** | Signed documents show a warning; exports are written without the signature (signature values, `/Perms`, `/DSS` removed; empty fields kept). |
| **Other** | Undo/redo (Ctrl+Z / Ctrl+Shift+Z), drafts saved in the browser (IndexedDB), hover explanations for keys and operators, focus-to-locate animation in the preview, responsive layout. |

### Quick editing

* **Text**: double-click text in the preview (or select a text element) and a quick-edit field with the readable
  text opens and is focused. Enter applies; the text is encoded through the font, with feedback for characters
  the (subset) font lacks. In `TJ` arrays kerning is kept when the number of characters is unchanged.
* **Move**: selected drawings, images, text objects and groups can be moved with arrow buttons / keys (Shift = ×10),
  exact dx/dy, or by dragging the dashed selection box in the preview. The move is written as
  `q 1 0 0 1 dx dy cm … Q` (an existing translation wrapper is updated instead of nesting), converted into the
  element's local coordinate system so the distance is exact in page points. Parts inside a `BT…ET` text object
  cannot be moved on their own (the whole text object can). Annotations move by shifting `Rect`, `QuadPoints`,
  `Vertices`, `InkList`, `L` and their popup.
* **Links**: clicking a link in the preview opens its target editor: URL (`/A << /S /URI >>`), a page of this
  document with a fit mode (`/Dest [page /Fit|/XYZ …]`), or a named destination (with suggestions from the catalog).

### Editing content streams

* Every operation line shows **operand chips** with a tooltip explaining what that operand does *in this line*
  (e.g. “Fill blue component (0–1) → resulting colour #1a4d8f”, “e – x position of the text origin”,
  “Position adjustment −200: moves the next glyph right by 0.2 em = 6.4 units at 32pt”, decoded font name…).
* The **caret is followed on the preview**: the locate animation highlights exactly the part under the caret —
  a single glyph inside a string, a TJ kerning gap, a path point, a rectangle edge, the box an image lands in.
  Colour / line / font / matrix operators highlight everything they affect.
* Strings are **decoded through the font** (ToUnicode CMaps, encodings, `Differences`, multi-byte CID fonts),
  so Hebrew and other scripts are readable. You can type replacement text: it is encoded back through the font
  and you get immediate feedback about characters the (subset) font does not contain. Text stored in visual
  order (`/ReversedChars`) is detected. Glyph chips allow duplicating or deleting single characters.
* **Glyphs**: each font can show its glyph outlines (via pdf.js font conversion + opentype.js) and export them as
  individual SVG, an SVG sheet or JSON, or copy a glyph's PDF code for pasting into a string.

### HTML export

Self-contained, print-faithful HTML: every page is an inline SVG in which each vector drawing is its own `<path>`,
text is `<text>` (real Unicode — the embedded fonts get a rebuilt cmap — rendered with the embedded fonts as
`@font-face` data URIs), and raster images stay `<image>`. pdf.js does the PDF interpretation; its drawing calls are
recorded as SVG. Each page is then rasterised and compared pixel by pixel with the pdf.js rendering; the dialog
shows the match per page and a diff map, and lists anything that had to be approximated (e.g. soft-mask groups and
tiling patterns, which pdf.js itself rasterises). Named `@page` rules keep each page's size when printing.

### Memory

Large binary streams (images, font programs, embedded files) are never copied into memory: after parsing they
remain disk-backed `Blob` slices of the opened file (or Blobs in IndexedDB for drafts and replaced data) and are
read on demand through a small LRU cache. The PDF writer produces a `Blob` that references those slices, the preview
of large documents is fed to pdf.js by byte ranges, and export verification reads only the bytes it checks. The
header shows how much stream data is in RAM versus on disk. Content streams, CMaps and XMP stay in memory because
they are edited interactively.

Focusing any input that belongs to something on a page (an element, an operator, an annotation, a page box,
an image XObject …) scrolls the preview to it and plays a converging ring animation around it.

## Stack

* [Vue 3](https://vuejs.org/) (SFC, Composition API) + [Tailwind CSS 4](https://tailwindcss.com/), built with Vite
* [pdf-lib](https://pdf-lib.js.org/) – low-level object model, parser and writer
* [pdf.js](https://mozilla.github.io/pdf.js/) – rendering of the preview
* [pako](https://github.com/nodeca/pako) – Flate compression
* [opentype.js](https://opentype.js.org/) – glyph outlines and cmap rebuilding for glyph / HTML export

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/
npm run sample       # writes sample.pdf for testing
npm run selftest -- sample.pdf   # node smoke test of the core (parse, edit, export, verify, JSON round-trip)
```

## Deploying to Cloudflare Pages

* Build command: `npm run build`
* Build output directory: `dist`
* Node version: 22 (see `.nvmrc`)

## Limitations

* Very large files are limited by browser memory.
* Encrypted PDFs cannot be decrypted; they can be inspected but content edits will not render correctly.
* Element bounding boxes are computed by a lightweight content-stream interpreter (approximate text widths
  when fonts have no `/Widths`).
* Duplicated form widgets are not added to the AcroForm field list.
* Undo history keeps references to replaced stream data, so replaced large streams stay in memory until they leave
  the undo history (40 steps).
* HTML export: soft-mask groups, tiling patterns and mesh shadings are drawn by pdf.js into bitmaps and therefore
  appear as images; the verification report shows them.
