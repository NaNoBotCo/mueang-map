#!/usr/bin/env node
// build-wats-visual.mjs — generate wats.html, the dedicated wats-only visual.
//
// Reads the built wat lens (dist/data/wat.geojson), the vendored MapLibre lib,
// and the MapLibre CSS (extracted from map.html's first <style> block), then
// fills viewer/wats-template.html and writes a single self-contained wats.html.
//
// The dataset stays the product; this is just a lens onto it. Re-run after any
// data refresh:  node scripts/build-wats-visual.mjs
//
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const bail = (m) => { console.error(`✗ ${m}`); process.exit(1) }

const watPath = join(ROOT, 'dist/data/wat.geojson')
if (!existsSync(watPath)) bail('dist/data/wat.geojson missing — run `node build.mjs` first')
const geo = JSON.parse(readFileSync(watPath, 'utf8'))

// Fold in the non-wat sacred sites (city pillars, sunken cities, sacred caves,
// mosques, churches, monumental Buddha images) as a THIRD marker class. They
// belong on the same map — they are the same religious landscape — but they are
// not wats and must never be counted as such, so `_kind` keeps them separate in
// every count, filter and legend.
const sacredPath = join(ROOT, 'dist/data/sacred.geojson')
let nSacred = 0
if (existsSync(sacredPath)) {
  const sg = JSON.parse(readFileSync(sacredPath, 'utf8'))
  for (const f of sg.features || []) { f.properties._kind = 'sacred'; geo.features.push(f) }
  nSacred = (sg.features || []).length
}
for (const f of geo.features) if (!f.properties._kind) f.properties._kind = 'wat'

const maplibreJs = readFileSync(join(ROOT, 'map.html'), 'utf8') // maplibre lib is inlined in map.html
// pull the maplibre <script> body (the AMD bundle) out of map.html
const jsMatch = [...maplibreJs.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).find((s) => s.includes('maplibregl') && s.includes('define('))
if (!jsMatch) bail('could not extract MapLibre JS from map.html')
// maplibre CSS is the FIRST <style> block in map.html
const cssMatch = maplibreJs.match(/<style>([\s\S]*?)<\/style>/)
if (!cssMatch || !cssMatch[1].includes('maplibregl')) bail('could not extract MapLibre CSS from map.html')
const maplibreCss = cssMatch[1]

// ---- old-city centroid, for an always-honest directional bucket ----
const OC = { lat: 18.7888, lng: 98.9853 }
const CENTRAL_KM = 3.0
function bucket(lng, lat) {
  const dLat = lat - OC.lat, dLng = (lng - OC.lng) * Math.cos((OC.lat * Math.PI) / 180)
  const km = Math.hypot(dLat, dLng) * 111.32
  if (km <= CENTRAL_KM) return 'C'
  // bearing → dominant compass direction
  return Math.abs(dLat) >= Math.abs(dLng) ? (dLat > 0 ? 'N' : 'S') : (dLng > 0 ? 'E' : 'W')
}

let heritage = 0
let photos = 0
for (const f of geo.features) {
  const p = f.properties
  const a = p.attrs || {}
  p._heritage = !!(a.heritage && a.heritage !== 'unknown')
  if (p._heritage && p._kind === 'wat') heritage++
  p._siteType = a.siteType || ''
  p._photos = (p.media || []).filter((m) => m.type === 'image' && m.thumb).length
  if (p._photos) photos++
  const [lng, lat] = f.geometry.coordinates
  p._dir = bucket(lng, lat)
  p._label = p.nameRoman || p.name || p.id
  p._search = [p.name, p.nameRoman, p.id].filter(Boolean).join(' ').toLowerCase()
}

const meta = {
  count: geo.features.filter((f) => f.properties._kind === 'wat').length,
  sacred: nSacred,
  heritage,
  photos,
  images: geo.features.reduce((n, f) => n + (f.properties._photos || 0), 0),
  builtAt: new Date === undefined ? '' : (geo.builtAt || ''), // avoid Date.now in tooling
  version: geo.version || '',
}
// builtAt: prefer the build-report stamp so we don't call Date here
try {
  const rep = JSON.parse(readFileSync(join(ROOT, 'dist/build-report.json'), 'utf8'))
  meta.version = rep.version || meta.version
} catch {}
meta.builtAt = readFileSync(watPath, 'utf8').match(/"builtAt":"([^"]+)"/)?.[1] || '2026'

const tpl = readFileSync(join(ROOT, 'viewer/wats-template.html'), 'utf8')
const out = tpl
  .replace('__MAPLIBRE_CSS__', () => maplibreCss)
  .replace('__MAPLIBRE_JS__', () => jsMatch)
  .replace('__WATS_DATA__', () => JSON.stringify(geo))
  .replace('__META__', () => JSON.stringify(meta))

const dest = join(ROOT, 'wats.html')
writeFileSync(dest, out)
const kb = (Buffer.byteLength(out) / 1024).toFixed(0)
console.log(`wats.html built · ${meta.count} wats + ${nSacred} sacred sites (${heritage} heritage, ${photos} with photos / ${meta.images} images) · ${kb} KB · self-contained`)
