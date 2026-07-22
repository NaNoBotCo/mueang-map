#!/usr/bin/env node
// harvest/wikidata.mjs — enrichment crawl (CC0) for wats & monuments in
// Chiang Mai province. Wikidata carries the facts OSM usually lacks: founding
// (inception) dates, heritage designation, the vernacular/roman name pair.
// Zero deps. Snapshot-first: the SPARQL result is cached in cache/wikidata/;
// re-running extracts from cache and does NOT hit the endpoint unless --fetch
// is passed and the cache file is missing.
//
//   node harvest/wikidata.mjs           # extract from cache only
//   node harvest/wikidata.mjs --fetch   # fetch if cache missing, then extract
//
// Output data/crawled/wikidata.json is NOT canonical. It is designed to be
// FOLDED IN as enrichment: `node merge.mjs enrich wikidata` matches each point
// to an existing canonical point by proximity + name and fills only EMPTY
// attrs (never overwriting field or OSM facts), appending the wikidata source.
// Points with no canonical match are recorded for review, never auto-added —
// an unvisited Wikidata monument does not silently become a map pin.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slugify } from '../lib/schema.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Region = a geospatial centre + radius (km). Wikidata's located-in (P131) data
// for northern-Thai temples is sparse, so we bound by geography, not admin chain.
// Radii are generous enough to blanket each changwat from its mueang centre.
const REGIONS = {
  'cm':         { center: '98.99 18.79', radius: 25, out: 'cm-heritage.json' },
  'cm-province':{ center: '98.95 18.85', radius: 90, out: 'cm-province.json' },
  'nan':        { center: '100.77 18.78', radius: 90, out: 'nan.json' },
  'chiang-rai': { center: '99.83 19.91', radius: 90, out: 'chiang-rai.json' },
  'lamphun':    { center: '99.01 18.58', radius: 55, out: 'lamphun.json' },
  'lampang':    { center: '99.49 18.29', radius: 90, out: 'lampang.json' },
  'phayao':     { center: '99.90 19.17', radius: 70, out: 'phayao.json' },
  'mae-hong-son': { center: '98.00 19.30', radius: 110, out: 'mae-hong-son.json' },
}
const argVal = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : dflt
}
const REGION = argVal('region', 'cm')
if (!REGIONS[REGION]) { console.error(`✗ unknown --region=${REGION}. Known: ${Object.keys(REGIONS).join(', ')}`); process.exit(1) }
const REGION_DEF = REGIONS[REGION]
const SUFFIX = REGION === 'cm' ? '' : `-${REGION}`
const CACHE = join(ROOT, 'cache/wikidata')
mkdirSync(CACHE, { recursive: true })
const FILE = join(CACHE, REGION_DEF.out)

const UA = 'mueang-map/1.0 (Chiang Mai niche-lens atlas; contact: skunkhaus@gmail.com)'
const ENDPOINT = 'https://query.wikidata.org/sparql'
const TODAY = new Date().toISOString().slice(0, 10)

// Wats within 25 km of the old city that are instance-of "wat" (Q427287 —
// the Thai/Cambodian temple class; NOT the generic Buddhist-temple type, which
// almost no CM temple carries). Bounded GEOSPATIALLY via wikibase:around rather
// than by the P131 admin chain, because Wikidata's located-in data for CM
// temples is sparse — geography is complete, administrative links are not.
// Coordinates are required. Optional: inception (P571), heritage designation
// (P1435), English & Thai labels. Founding dates are thin in Wikidata; the
// heritage flag ("registered Thai historic site") is the real enrichment win.
const QUERY = `
SELECT ?item ?enLabel ?thLabel ?coord ?inception ?heritageLabel WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${REGION_DEF.center})"^^geo:wktLiteral ;
                    wikibase:radius "${REGION_DEF.radius}" .
  }
  ?item wdt:P31 wd:Q427287 .
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P1435 ?heritage . ?heritage rdfs:label ?heritageLabel . FILTER(LANG(?heritageLabel) = "en") }
  OPTIONAL { ?item rdfs:label ?enLabel . FILTER(LANG(?enLabel) = "en") }
  OPTIONAL { ?item rdfs:label ?thLabel . FILTER(LANG(?thLabel) = "th") }
}
`.trim()

async function fetchOnce() {
  if (existsSync(FILE)) return
  process.stdout.write('fetching wikidata (SPARQL)… ')
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(QUERY)}`
  let body = null, lastErr = null
  for (let attempt = 0; attempt < 3 && body == null; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/sparql-results+json', 'user-agent': UA } })
      if (res.ok) body = await res.text()
      else {
        lastErr = `http ${res.status}`
        process.stdout.write(`[${lastErr}, retrying] `)
        await new Promise((r) => setTimeout(r, 10000 * (attempt + 1)))
      }
    } catch (e) {
      lastErr = String(e)
      await new Promise((r) => setTimeout(r, 10000 * (attempt + 1)))
    }
  }
  if (body == null) throw new Error(`wikidata fetch failed: ${lastErr}`)
  writeFileSync(FILE, body)
  console.log(`${(body.length / 1024).toFixed(0)} kB cached`)
}

// ---- extraction ----------------------------------------------------------

function parseCoord(wkt) {
  // "Point(98.9865 18.7869)" → { lat, lng }
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(wkt || '')
  if (!m) return null
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) }
}

function extract(doc) {
  const rows = doc.results?.bindings ?? []
  const byItem = new Map()
  for (const r of rows) {
    const item = r.item?.value
    if (!item) continue
    const pos = parseCoord(r.coord?.value)
    if (!pos) continue
    // A single item can repeat across heritage/instance combos — fold to one.
    const prev = byItem.get(item) ?? { item, pos, th: null, en: null, inception: null, heritage: null }
    const th = r.thLabel?.value && /[฀-๿]/.test(r.thLabel.value) ? r.thLabel.value : prev.th
    const en = r.enLabel?.value ?? (r.itemLabel?.value && !/[฀-๿]/.test(r.itemLabel.value) ? r.itemLabel.value : prev.en)
    byItem.set(item, {
      ...prev,
      th: th ?? prev.th,
      en: en ?? prev.en,
      inception: r.inception?.value ?? prev.inception,
      heritage: r.heritageLabel?.value ?? prev.heritage,
    })
  }

  const out = []
  const seen = new Set()
  for (const e of byItem.values()) {
    const name = e.th || e.en
    if (!name) continue
    const qid = e.item.split('/').pop() // Q12345
    let id = slugify(e.en || e.th) || `wd-${qid.toLowerCase()}`
    if (seen.has(id)) id = `${id}-${qid.toLowerCase()}`
    seen.add(id)

    const attrs = { status: 'active', sect: 'unknown' }
    // Region is known for certain here, so promoted pins get a province too —
    // otherwise the 195 Wikidata-only temples would have no locality facet.
    // Must list EVERY region in REGIONS above — a region added there but missed
    // here silently yields pins with no province facet (36 Mae Hong Son pins did
    // exactly that). Derived from REGIONS so the two cannot drift apart.
    const RP = { cm: 'Chiang Mai', 'cm-province': 'Chiang Mai', 'chiang-rai': 'Chiang Rai',
                 lamphun: 'Lamphun', lampang: 'Lampang', nan: 'Nan',
                 phayao: 'Phayao', 'mae-hong-son': 'Mae Hong Son' }
    for (const k of Object.keys(REGIONS)) if (!RP[k]) console.warn(`  ! no province label for region '${k}'`)
    if (RP[REGION]) attrs.province = RP[REGION]
    if (e.inception) {
      // ISO like "1296-04-12T00:00:00Z" or "+1296-01-01..." → year.
      const ym = /([+-]?\d{3,4})-\d{2}-\d{2}/.exec(e.inception)
      if (ym) attrs.founded = String(parseInt(ym[1], 10))
    }
    if (e.heritage) attrs.heritage = e.heritage

    out.push({
      id,
      lens: ['wat'],
      name,
      nameRoman: e.en || null,
      lat: e.pos.lat,
      lng: e.pos.lng,
      geoPrecision: 'block', // Wikidata coords are centroid-ish; not surveyed
      address: null,
      attrs,
      media: [],
      sources: [{ type: 'wikidata', ref: qid, fetched: TODAY }],
      confidence: 'crawled',
      notes: '',
      updatedAt: TODAY,
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

// ---- main ----------------------------------------------------------------
const doFetch = process.argv.includes('--fetch')
if (!existsSync(FILE)) {
  if (doFetch) await fetchOnce()
  else { console.warn('- no cache (run with --fetch)'); process.exit(0) }
}
const doc = JSON.parse(readFileSync(FILE, 'utf8'))
const points = extract(doc)
mkdirSync(join(ROOT, 'data/crawled'), { recursive: true })
const outName = `wikidata${SUFFIX}.json`
writeFileSync(join(ROOT, 'data/crawled', outName), JSON.stringify(points, null, 2))
const withFounded = points.filter((p) => p.attrs.founded).length
console.log(`wikidata: ${doc.results?.bindings?.length ?? 0} rows → ${points.length} points (${withFounded} with founding date)`)
console.log(`→ data/crawled/${outName} (enrichment; fold with: node merge.mjs enrich wikidata${SUFFIX})`)
