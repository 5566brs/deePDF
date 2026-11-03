// Copies pdf.js standard fonts and CMaps into public/pdfjs so they are served as static files.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'pdfjs-dist')
const dst = join(root, 'public', 'pdfjs')
mkdirSync(dst, { recursive: true })
for (const d of ['standard_fonts', 'cmaps']) cpSync(join(src, d), join(dst, d), { recursive: true })
console.log('pdf.js assets copied to public/pdfjs')
