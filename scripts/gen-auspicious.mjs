#!/usr/bin/env node
// scripts/gen-auspicious.mjs — generate the structural auspiciousness layer.
// ONE source of truth: data/canonical/auspicious-rules.json (valences, cited
// basis refs) + OSM landmark coords (cache/osm/landmarks.json). Output
// data/canonical/auspicious-structural.json is GENERATED — never hand-edit.
// Nodes whose landmark can't be found in OSM are SKIPPED with a warning
// (no invented coordinates), listed for manual coord sourcing.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rules = JSON.parse(readFileSync(join(ROOT, 'data/canonical/auspicious-rules.json'), 'utf8'))
const cache = JSON.parse(readFileSync(join(ROOT, 'cache/osm/landmarks.json'), 'utf8'))
const fetched = new Date().toISOString().slice(0, 10)

const landmarks = (cache.elements ?? [])
  .map((el) => ({
    ref: `${el.type}/${el.id}`,
    names: [el.tags?.name, el.tags?.['name:th'], el.tags?.['name:en']].filter(Boolean),
    lat: el.type === 'node' ? el.lat : el.center?.lat,
    lng: el.type === 'node' ? el.lon : el.center?.lon,
  }))
  .filter((l) => l.lat != null)

function findLandmark(node) {
  for (const cand of node.osmNames) {
    const hit = landmarks.find((l) =>
      l.names.some((n) => n === cand || n.includes(cand) || cand.includes(n)))
    if (hit) return hit
  }
  return null
}

const points = []
const missing = []
for (const node of rules.nodes) {
  const lm = findLandmark(node)
  if (!lm) { missing.push(node.key); continue }
  const basis =
    `taksa ${node.taksa.roman} (${node.taksa.th} — ${node.taksa.en}), direction ${node.direction}; ` +
    `functions: ${node.functions.join(', ')}; rating: ${node.rating}; ` +
    `see auspicious-basis.md ${node.basisRefs.join(', ')}` +
    (node.caveat ? `; CAVEAT: ${node.caveat}` : '') +
    `; scheme caveat: ${rules.schemeCaveat}`
  points.push({
    id: `ausp-${node.key}`,
    lens: ['auspicious'],
    name: node.th,
    nameRoman: node.roman,
    lat: lm.lat,
    lng: lm.lng,
    geoPrecision: 'exact',
    address: null,
    attrs: { basis, polarity: node.polarity, strength: node.strength },
    media: [],
    sources: [
      { type: 'basis', ref: `auspicious-basis.md ${node.basisRefs.join(', ')}` },
      { type: 'osm', ref: lm.ref, fetched },
    ],
    confidence: 'heuristic',
    notes: node.caveat || '',
    updatedAt: fetched,
  })
}

writeFileSync(
  join(ROOT, 'data/canonical/auspicious-structural.json'),
  JSON.stringify(
    { _generated: 'by scripts/gen-auspicious.mjs from auspicious-rules.json — do not hand-edit', points },
    null, 2))
console.log(`auspicious-structural.json: ${points.length}/${rules.nodes.length} nodes generated`)
if (missing.length) console.warn(`⚠ no OSM landmark found (skipped, no invented coords): ${missing.join(', ')}`)
