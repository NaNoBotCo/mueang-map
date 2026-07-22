#!/usr/bin/env node
// harvest/osm-landmarks.mjs — coords for the old-city gates, jaeng (corner
// bastions) and center monuments, used by scripts/gen-auspicious.mjs.
// Coordinates come from OSM (sourced), never from memory. Snapshot-first:
// cached in cache/osm/landmarks.json; --fetch to (re)fetch.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'cache/osm')
mkdirSync(CACHE, { recursive: true })
const FILE = join(CACHE, 'landmarks.json')

const UA = 'mueang-map/1.0 (Chiang Mai niche-lens atlas; contact: skunkhaus@gmail.com)'
const ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
// Old-city bbox with margin
const BBOX = '18.77,98.97,18.80,99.00'
const NAME_RE = 'ประตูช้างเผือก|ประตูท่าแพ|ประตูเชียงใหม่|ประตูแสนปุง|ประตูสวนปรุง|ประตูสวนดอก|แจ่งศรีภูมิ|แจ่งกะต๊ำ|แจ่งก๊ะต๊ำ|แจ่งขะต๊ำ|แจ่งกู่เฮือง|แจ่งหัวลิน|อนุสาวรีย์สามกษัตริย์|วัดอินทขีล|วัดเจดีย์หลวง'

if (process.argv.includes('--fetch') || !existsSync(FILE)) {
  const query = `[out:json][timeout:60];(nwr["name"~"${NAME_RE}"](${BBOX}); nwr["name:th"~"${NAME_RE}"](${BBOX}); nwr["name:en"~"Tha Phae Gate|Chang Phueak Gate|Chang Puak Gate|Chiang Mai Gate|Suan Dok Gate|Suan Prung Gate|Saen Pung|Si Phum Corner|Sri Poom|Katam Corner|Ka Tam|Ku Hueang|Ku Huang|Hua Lin|Three Kings Monument|Wat Chedi Luang",i](${BBOX}););out center tags;`
  let body = null, lastErr = null
  for (let attempt = 0; attempt < 4 && body == null; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: 'data=' + encodeURIComponent(query),
      })
      if (res.ok) body = await res.text()
      else {
        lastErr = `http ${res.status} from ${new URL(url).host}`
        await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)))
      }
    } catch (e) {
      lastErr = String(e)
      await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)))
    }
  }
  if (body == null) { console.error(`✗ landmarks fetch failed: ${lastErr}`); process.exit(1) }
  writeFileSync(FILE, body)
  console.log(`cached ${FILE}`)
}

const doc = JSON.parse(readFileSync(FILE, 'utf8'))
console.log(`landmarks in cache: ${doc.elements?.length ?? 0} elements`)
for (const el of doc.elements ?? []) {
  const t = el.tags || {}
  const pos = el.type === 'node' ? [el.lat, el.lon] : el.center ? [el.center.lat, el.center.lon] : null
  console.log(` - ${el.type}/${el.id} ${t.name || t['name:en'] || '?'} @ ${pos}`)
}
