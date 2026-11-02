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

Focusing any input that belongs to something on a page (an element, an operator, an annotation, a page box,
an image XObject …) scrolls the preview to it and plays a converging ring animation around it.

## Stack

* [Vue 3](https://vuejs.org/) (SFC, Composition API) + [Tailwind CSS 4](https://tailwindcss.com/), built with Vite
* [pdf-lib](https://pdf-lib.js.org/) – low-level object model, parser and writer
* [pdf.js](https://mozilla.github.io/pdf.js/) – rendering of the preview
* [pako](https://github.com/nodeca/pako) – Flate compression

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
