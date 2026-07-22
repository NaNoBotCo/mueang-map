#!/usr/bin/env node
// build.mjs — compile data/canonical/*.json → per-lens GeoJSON + self-contained map.html
// Deterministic: same inputs → same output (version = content hash, builtAt = date).
// Usage: node build.mjs [--pull]   (--pull folds the sync worker's live store, see worker/)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePoint, inBbox, findNearDuplicates, isPointFile, CM_BBOX } from './lib/schema.mjs'

// MM_ROOT lets the test suite point the build at a fixture tree (the fixture
// must contain data/ + viewer/ + vendor/, typically symlinked).
const ROOT = process.env.MM_ROOT || dirname(fileURLToPath(import.meta.url))
const rd = (p) => readFileSync(join(ROOT, p), 'utf8')

const registry = JSON.parse(rd('data/lenses.json'))
const lensIds = registry.lenses.map((l) => l.id)
const config = existsSync(join(ROOT, 'config.json'))
  ? JSON.parse(rd('config.json'))
  : {}

// ---- load canonical ------------------------------------------------------
const canonicalDir = join(ROOT, 'data/canonical')
mkdirSync(canonicalDir, { recursive: true })
const points = []
const invalid = []
for (const f of readdirSync(canonicalDir).filter(isPointFile).sort()) {
  const doc = JSON.parse(rd(join('data/canonical', f)))
  const arr = Array.isArray(doc) ? doc : doc.points
  if (!Array.isArray(arr)) {
    console.error(`✗ ${f}: expected an array (or {points: []})`)
    process.exitCode = 1
    continue
  }
  for (const p of arr) {
    const errs = validatePoint(p, lensIds)
    if (!inBbox(p, CM_BBOX)) errs.push(`outside Lanna bbox (${p.lat}, ${p.lng})`)
    if (errs.length) invalid.push({ file: f, id: p?.id ?? null, errors: errs })
    else points.push(p)
  }
}

// ---- pull from sync worker (opt-in) --------------------------------------
if (process.argv.includes('--pull')) {
  if (!config.workerUrl) {
    console.error('✗ --pull requires workerUrl in config.json')
    process.exit(1)
  }
  const res = await fetch(`${config.workerUrl}/delta?since=0`)
  if (!res.ok) { console.error(`✗ pull failed: http ${res.status}`); process.exit(1) }
  const delta = await res.json()
  const staged = []
  for (const p of delta.points ?? []) {
    const errs = validatePoint(p, lensIds)
    if (!inBbox(p)) errs.push('outside bbox')
    if (errs.length) invalid.push({ file: '(worker)', id: p?.id ?? null, errors: errs })
    else staged.push(p)
  }
  // KV is a buffer, not the system of record: pulled points land in a staging
  // file for diff review, and are used for this build; fold into canonical
  // by committing the staging file after review.
  writeFileSync(join(canonicalDir, '..', 'pulled-staging.json'),
    JSON.stringify(staged, null, 2))
  const known = new Set(points.map((p) => p.id))
  const fresh = staged.filter((p) => !known.has(p.id))
  const overlap = staged.filter((p) => known.has(p.id))
  console.log(`pulled ${staged.length} live points: ${fresh.length} new, ${overlap.length} overlap canonical (canonical wins this build — review data/pulled-staging.json)`)
  points.push(...fresh)
}

// ---- sanity: duplicates flagged, never auto-merged -----------------------
points.sort((a, b) => a.id.localeCompare(b.id))
// Ids must be unique across the WHOLE corpus. Each harvester only de-duplicates
// within its own crawl run, so two regions can mint the same slug independently
// — there are many temples called Wat Chedi Luang. This check existed but only
// noted the collision in `invalid` while leaving both records in `points`, so
// everything keyed on id downstream (place pages, /api/place/<id>.json, #place=
// deep links) silently kept whichever was written last. /place/wat-chedi-luang/
// served Chiang Rai; the Chiang Mai temple had no permalink at all.
const ids = new Set()
const dupIds = new Set()
for (const p of points) {
  if (ids.has(p.id)) { dupIds.add(p.id); invalid.push({ file: '(merge)', id: p.id, errors: ['duplicate id'] }) }
  ids.add(p.id)
}
if (dupIds.size) {
  console.error(`\n✗ ${dupIds.size} duplicate id(s) across canonical — records WILL overwrite`)
  console.error(`  each other in place pages, per-place JSON and deep links.`)
  console.error(`  e.g. ${[...dupIds].slice(0, 5).join(', ')}`)
  console.error(`  Fix:  node merge.mjs uniquify\n`)
  process.exitCode = 2
}
const dupPairs = findNearDuplicates(points)

// ---- per-lens GeoJSON ----------------------------------------------------
mkdirSync(join(ROOT, 'dist/data'), { recursive: true })
for (const lens of lensIds) {
  const fc = {
    type: 'FeatureCollection',
    features: points
      .filter((p) => p.lens.includes(lens))
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { ...p, lat: undefined, lng: undefined },
      })),
  }
  writeFileSync(join(ROOT, 'dist/data', `${lens}.geojson`), JSON.stringify(fc))
}

// ---- embed into map.html -------------------------------------------------
const dataBlob = {
  points,
  buildInvalid: invalid.map((i) => ({ id: i.id, reason: i.errors.join('; '), file: i.file })),
}
const hash = createHash('sha256')
  .update(JSON.stringify({ points, registry }))
  .digest('hex')
  .slice(0, 10)
const meta = {
  version: hash,
  builtAt: new Date().toISOString().slice(0, 10),
  pointCount: points.length,
  workerUrl: config.workerUrl ?? null,
}

// JSON inside <script type=application/json>: escape < to keep </script> inert.
const jsonSafe = (o) => JSON.stringify(o).replace(/</g, '\\u003c')
// JS source inlined into <script>: neutralize any literal </script.
const jsSafe = (s) => s.replace(/<\/script/gi, '<\\/script')

const html = rd('viewer/template.html')
  .replace('/*@MAPLIBRE_CSS@*/', () => rd('vendor/maplibre-gl.css'))
  .replace('/*@MAPLIBRE_JS@*/', () => jsSafe(rd('vendor/maplibre-gl.js')))
  .replace('/*@LOGIC_JS@*/', () =>
    // logic.mjs is ESM for the test suite; inlined as classic script here.
    jsSafe(rd('viewer/logic.mjs').replaceAll('export function', 'function').replaceAll('export const', 'const')))
  .replace('/*@APP_JS@*/', () => jsSafe(rd('viewer/app.js')))
  .replace('/*@LENSES_JSON@*/', () => jsonSafe(registry))
  .replace('/*@DATA_JSON@*/', () => jsonSafe(dataBlob))
  .replace('/*@META_JSON@*/', () => jsonSafe(meta))
writeFileSync(join(ROOT, 'map.html'), html)

// ---- report --------------------------------------------------------------
const report = { version: hash, points: points.length, invalid, nearDuplicates: dupPairs }
writeFileSync(join(ROOT, 'dist/build-report.json'), JSON.stringify(report, null, 2))
const perLens = Object.fromEntries(
  lensIds.map((l) => [l, points.filter((p) => p.lens.includes(l)).length]))
console.log(`map.html built · data ${hash} · ${points.length} points`)
console.log('per lens:', JSON.stringify(perLens))
if (invalid.length) {
  console.warn(`⚠ ${invalid.length} invalid feature(s) EXCLUDED (see dist/build-report.json):`)
  for (const i of invalid.slice(0, 10)) console.warn(`  - ${i.file} ${i.id}: ${i.errors.join('; ')}`)
}
if (dupPairs.length) {
  console.warn(`⚠ ${dupPairs.length} near-duplicate pair(s) <25 m — review, not auto-merged:`)
  for (const d of dupPairs.slice(0, 10)) console.warn(`  - ${d.a} ↔ ${d.b} (${d.meters} m)`)
}
