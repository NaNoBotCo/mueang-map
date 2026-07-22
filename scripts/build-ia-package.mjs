#!/usr/bin/env node
// scripts/build-ia-package.mjs — stage an Internet Archive item for the wat
// catalogue. Builds files only; it NEVER uploads. Review dist/ia/, then run
// the printed `ia upload` command yourself.
//
//   node scripts/build-ia-package.mjs
//
// What goes up: the catalogue (which exists nowhere else) + a full attribution
// manifest for every photograph we reference. What does NOT go up: the photos
// themselves — Commons already preserves those, and re-hosting them would add
// nothing while multiplying the attribution surface.
//
// Licensing is not decoration here:
//   • point data is derived from OpenStreetMap → ODbL 1.0, share-alike
//   • Wikidata facts → CC0
//   • photo *metadata* we compiled → CC0; the photos stay under their own terms
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'dist/ia')
mkdirSync(OUT, { recursive: true })

const geo = JSON.parse(readFileSync(join(ROOT, 'dist/data/wat.geojson'), 'utf8'))
const report = JSON.parse(readFileSync(join(ROOT, 'dist/build-report.json'), 'utf8'))
const feats = geo.features
const IDENT = 'mueang-map-chiang-mai-wats'
const DATE = '2026-07-19'

const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (rows, cols) =>
  [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'

// ---- 1. the catalogue itself -------------------------------------------
writeFileSync(join(OUT, `${IDENT}.geojson`), JSON.stringify(geo, null, 2))

const flat = feats.map((f) => {
  const p = f.properties, a = p.attrs || {}
  return {
    id: p.id, name_th: p.name, name_roman: p.nameRoman,
    lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
    geo_precision: p.geoPrecision, status: a.status || '', sect: a.sect || '',
    founded: a.founded || '', heritage: a.heritage || '', chedi_style: a.chediStyle || '',
    confidence: p.confidence, photo_count: (p.media || []).length,
    sources: (p.sources || []).map((s) => `${s.type}:${s.ref || ''}`).join(' '),
    updated: p.updatedAt,
  }
})
writeFileSync(join(OUT, `${IDENT}.csv`), toCsv(flat, Object.keys(flat[0])))

// ---- 2. attribution manifest for every referenced photograph ------------
const credits = []
for (const f of feats) {
  const p = f.properties
  for (const m of p.media || []) {
    if (m.type !== 'image') continue
    credits.push({
      temple_id: p.id, temple: p.nameRoman || p.name,
      file: m.title, author: m.author, license: m.license,
      license_url: m.licenseUrl || '', captured: m.capturedAt || '',
      source_page: m.source, image_url: m.url,
    })
  }
}
writeFileSync(join(OUT, 'image-credits.csv'), toCsv(credits, Object.keys(credits[0])))
writeFileSync(join(OUT, 'image-credits.json'), JSON.stringify(credits, null, 2))

const licenseTally = {}
for (const c of credits) licenseTally[c.license] = (licenseTally[c.license] || 0) + 1
const heritageN = feats.filter((f) => (f.properties.attrs || {}).heritage).length
const withPhoto = feats.filter((f) => (f.properties.media || []).length).length

// ---- 3. README ----------------------------------------------------------
writeFileSync(join(OUT, 'README.md'), `# Mueang Map — Chiang Mai Wat Catalogue

An open, machine-readable catalogue of **${feats.length} Buddhist temples (wat / วัด)**
in and around Chiang Mai, northern Thailand, with provenance recorded for every
record. Compiled ${DATE}. Data version \`${report.version}\`.

## Contents

| file | what it is |
|---|---|
| \`${IDENT}.geojson\` | the catalogue as GeoJSON (one Feature per temple, full attributes) |
| \`${IDENT}.csv\` | the same records as a flat table |
| \`image-credits.csv\` / \`.json\` | attribution manifest: every referenced photograph with author, licence and source page |

## What's in a record

Each temple carries a stable slug id, Thai and romanised names, coordinates with
an honest \`geo_precision\` (\`exact\` / \`block\` / \`area\` — precision is never
faked), status, and a \`confidence\` value:

- \`verified\` — confirmed in the field
- \`crawled\` — machine-extracted, not yet visited
- \`heuristic\` — inferred

Every record lists its \`sources\`, so any fact can be traced back.
**${heritageN}** temples are flagged as registered Thai historic sites.
**${withPhoto}** link to freely-licensed photography (${credits.length} images total).

## Photographs

This item does **not** redistribute the images. It records where they are and
who made them. All referenced photographs live on Wikimedia Commons under free
licences; \`image-credits\` gives per-file author, licence and source page.
If you reuse a photograph, honour its own licence — most are share-alike.

Licences across the ${credits.length} referenced images:

${Object.entries(licenseTally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k} — ${v}`).join('\n')}

## Licensing (please read)

- **Point data is derived from OpenStreetMap** and is therefore published under the
  **Open Database License (ODbL) 1.0**. It is *share-alike*: a derived database
  must be released under ODbL too. Attribution: © OpenStreetMap contributors.
- **Facts sourced from Wikidata** are CC0.
- **The compilation, schema and attribution manifest** are released **CC0** by the
  compiler, to the extent they are separable from the ODbL data above.
- **Photographs are not covered by any of the above** — each keeps its own licence.

## Known limitations (stated, not hidden)

- Most records are \`crawled\` and unvisited; treat them as leads, not ground truth.
- OpenStreetMap contains a small number of duplicate temple entries (the same wat
  mapped twice). Known duplicates are flagged for review rather than auto-merged.
- Coverage is the Chiang Mai valley and immediate surroundings, not the whole
  province; a handful of records fall just over the Lamphun boundary.
- Founding dates are sparse — Wikidata rarely carries them for these temples.

## Source

Built by the Mueang Map project, a niche-lens participatory atlas of Chiang Mai.
`)

// ---- 4. IA item metadata + the upload command (not executed) ------------
const meta = {
  identifier: IDENT,
  mediatype: 'data',
  collection: 'opensource',
  title: 'Mueang Map — Chiang Mai Wat Catalogue (open geodata)',
  creator: 'Mueang Map project',
  date: DATE,
  language: ['eng', 'tha'],
  licenseurl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  rights: 'Point data derived from OpenStreetMap, licensed ODbL 1.0 (share-alike). Wikidata facts CC0. Referenced photographs remain under their own Commons licences; see image-credits.csv.',
  subject: ['Chiang Mai', 'Thailand', 'Buddhist temple', 'wat', 'Lanna',
    'open data', 'geodata', 'GeoJSON', 'OpenStreetMap', 'cultural heritage'],
  description: `Open, machine-readable catalogue of ${feats.length} Buddhist temples (wat) in and around Chiang Mai, Thailand, with per-record provenance and confidence. ${heritageN} are registered Thai historic sites. Includes an attribution manifest for ${credits.length} freely-licensed photographs of ${withPhoto} of the temples (images are referenced, not redistributed). Point data derived from OpenStreetMap under ODbL 1.0; facts from Wikidata under CC0. Data version ${report.version}.`,
}
writeFileSync(join(OUT, 'ia-metadata.json'), JSON.stringify(meta, null, 2))

const kv = Object.entries(meta)
  .filter(([k]) => k !== 'identifier')
  .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `  --metadata="${k}:${x}"`) : [`  --metadata="${k}:${String(v).replace(/"/g, "'")}"`]))
  .join(' \\\n')
writeFileSync(join(OUT, 'upload.sh'), `#!/bin/bash
# Review the files in this folder first. Then, with the Internet Archive CLI
# configured under your own account (\`pip install internetarchive && ia configure\`):
set -e
cd "$(dirname "$0")"
ia upload ${IDENT} \\
  ${IDENT}.geojson ${IDENT}.csv image-credits.csv image-credits.json README.md \\
${kv}
echo "→ https://archive.org/details/${IDENT}"
`)

console.log(`staged dist/ia/ — ${feats.length} temples, ${credits.length} image credits`)
console.log(`  ${IDENT}.geojson / .csv, image-credits.csv/.json, README.md, ia-metadata.json, upload.sh`)
console.log('  NOTHING UPLOADED. Review, then run dist/ia/upload.sh yourself.')
