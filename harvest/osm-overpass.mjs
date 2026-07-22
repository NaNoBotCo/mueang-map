#!/usr/bin/env node
// harvest/osm-overpass.mjs — OSM seed crawl via Overpass API. Zero deps.
// Snapshot-first: every query result is cached in cache/osm/; re-running
// extracts from cache and does NOT hit the API unless --fetch is passed
// and the cache file is missing. One bbox query per element class, sequential,
// polite pause between requests.
//
//   node harvest/osm-overpass.mjs                     # extract city cache
//   node harvest/osm-overpass.mjs --fetch             # fetch missing city classes
//   node harvest/osm-overpass.mjs --region=cm-province --only=wat --fetch
//   node harvest/osm-overpass.mjs --region=nan --only=wat --print-query   # dry run
//
// Regions wider than the city use a precise OSM admin-area (admin_level=4 =
// Thai province/changwat), NOT a bbox, so they don't overshoot into neighbours.
// Region-scoped runs write cache/osm-<region>/ and data/crawled/osm-<region>.json,
// so a province sweep never clobbers the city seed. Merge each into its own
// canonical file:  node merge.mjs crawled osm-<region>  (+ promote / enrich).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slugify } from '../lib/schema.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const UA = 'mueang-map/1.0 (Chiang Mai niche-lens atlas; contact: skunkhaus@gmail.com)'
// Ordered by observed health; de/kumi were 504-overloaded on 2026-07-18.
const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

// ---- region selection ----------------------------------------------------
// `bbox` regions are (south,west,north,east). `area` regions resolve an OSM
// administrative boundary by its English name at admin_level=4 (province).
// Provinces are selected by ISO3166-2 code, NOT by name. OSM tags these
// boundaries name:en="Lamphun Province" (not "Lamphun"), so an exact name match
// silently resolves to no area and Overpass returns a perfectly valid response
// with zero elements — a failure that looks exactly like "there are no temples
// here". The ISO code is exact, stable and language-independent.
const REGIONS = {
  'cm-city':     { bbox: '18.68,98.90,18.90,99.08' },  // default: city + inner suburbs
  'cm-province': { iso: 'TH-50' },                     // whole changwat
  'chiang-rai':  { iso: 'TH-57' },                     // includes the Golden Triangle (Chiang Saen / Mae Sai)
  'lamphun':     { iso: 'TH-51' },
  'lampang':     { iso: 'TH-52' },
  'nan':         { iso: 'TH-55' },
  // Added 2026-07-22 after a gemba check: วัดศรีดอนมูล turned out to sit in
  // อำเภอแม่ใจ, Phayao — a province that was simply never in this list, so the
  // temple was never "dropped", it was never looked for. Mae Hong Son was the
  // same omission. Both are Lanna; the eight-province set is the honest scope.
  'phayao':      { iso: 'TH-56' },
  'mae-hong-son':{ iso: 'TH-58' },
}
const argVal = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : dflt
}
const REGION = argVal('region', 'cm-city')
if (!REGIONS[REGION]) { console.error(`✗ unknown --region=${REGION}. Known: ${Object.keys(REGIONS).join(', ')}`); process.exit(1) }
const REGION_DEF = REGIONS[REGION]
const SUFFIX = REGION === 'cm-city' ? '' : `-${REGION}`
const CACHE = join(ROOT, `cache/osm${SUFFIX}`)
mkdirSync(CACHE, { recursive: true })

// Spatial filter injected into every class query. For an area region we prepend
// an area definition (.rg) and filter members with (area.rg); a bbox region
// filters with the raw bounding box. TIMEOUT is higher for province-scale areas.
const AREA_PREAMBLE = REGION_DEF.iso
  ? `area["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"="${REGION_DEF.iso}"]->.rg;`
  : ''
const SPATIAL = REGION_DEF.iso ? '(area.rg)' : `(${REGION_DEF.bbox})`
const TIMEOUT = REGION_DEF.iso ? 300 : 60
const TODAY = new Date().toISOString().slice(0, 10)

// One query per element class. nwr = nodes+ways+relations; out center gives
// a representative point for ways/relations.
const CLASSES = {
  wat: `nwr["amenity"="place_of_worship"]["religion"="buddhist"]${SPATIAL};`,
  library: `nwr["amenity"="library"]${SPATIAL};`,
  tattoo: `nwr["shop"="tattoo"]${SPATIAL};`,
  'art-studio': `(nwr["tourism"="gallery"]${SPATIAL}; nwr["craft"="pottery"]${SPATIAL}; nwr["amenity"="studio"]["studio"="art"]${SPATIAL}; nwr["leisure"="arts_centre"]${SPATIAL}; nwr["amenity"="arts_centre"]${SPATIAL};);`,
  restaurant: `nwr["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"thai",i]${SPATIAL};`,
  'spirit-house': `nwr["historic"="wayside_shrine"]${SPATIAL};`,
}
// --only=wat[,library,...] restricts which classes run (a province-wide Lanna
// wat sweep wants wats only, not tattoo shops across three changwat).
const ONLY = argVal('only', '')
const ACTIVE_CLASSES = ONLY ? ONLY.split(',').map((s) => s.trim()).filter((c) => CLASSES[c]) : Object.keys(CLASSES)

// Province is derivable with certainty from which regional crawl a point came
// from — far better coverage (100%) than addr:province (6.7%).
const REGION_PROVINCE = {
  'cm-city': 'Chiang Mai', 'cm-province': 'Chiang Mai', 'chiang-rai': 'Chiang Rai',
  'lamphun': 'Lamphun', 'lampang': 'Lampang', 'nan': 'Nan',
  'phayao': 'Phayao', 'mae-hong-son': 'Mae Hong Son',
}
const buildQuery = (cls) => `[out:json][timeout:${TIMEOUT}];${AREA_PREAMBLE}(${CLASSES[cls]});out center tags;`

async function fetchClass(cls) {
  const file = join(CACHE, `${cls}.json`)
  if (existsSync(file)) return
  const query = buildQuery(cls)
  process.stdout.write(`fetching ${cls}… `)
  // Retry across endpoints with polite backoff; Overpass 504s when busy.
  let body = null, lastErr = null
  for (let attempt = 0; attempt < 4 && body == null; attempt++) {
    const url = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length]
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: 'data=' + encodeURIComponent(query),
      })
      if (res.ok) body = await res.text()
      else {
        lastErr = `http ${res.status} from ${new URL(url).host}`
        process.stdout.write(`[${lastErr}, retrying] `)
        await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)))
      }
    } catch (e) {
      lastErr = String(e)
      await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)))
    }
  }
  if (body == null) throw new Error(`overpass failed for ${cls}: ${lastErr}`)
  // Do NOT cache an empty area result. Overpass answers 200 with zero elements
  // when the area filter matched no boundary, which is indistinguishable from a
  // genuinely empty region — and snapshot-first would then freeze that mistake
  // permanently, because a cached file is never refetched.
  if (REGION_DEF.iso) {
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* fall through to the throw */ }
    if (!parsed || !Array.isArray(parsed.elements) || parsed.elements.length === 0)
      throw new Error(`overpass returned 0 elements for ${cls} in ${REGION} — area ${REGION_DEF.iso} did not resolve; NOT caching`)
  }
  writeFileSync(file, body)
  console.log(`${(body.length / 1024).toFixed(0)} kB cached`)
  await new Promise((r) => setTimeout(r, 3000)) // polite gap between queries
}

// ---- extraction (cache → canonical schema) -------------------------------

function pointOf(el) {
  if (el.type === 'node') return { lat: el.lat, lng: el.lon, precision: 'exact' }
  if (el.center) return { lat: el.center.lat, lng: el.center.lon, precision: 'block' }
  return null
}

function baseName(tags) {
  // Prefer Thai name; keep roman from name:en / name:romanized if present.
  const th = tags['name:th'] || (tags.name && /[฀-๿]/.test(tags.name) ? tags.name : null)
  const en = tags['name:en'] || (tags.name && !/[฀-๿]/.test(tags.name) ? tags.name : null)
  return { name: th || en || null, nameRoman: en }
}

function extract(cls, elements, seenIds) {
  const out = []
  for (const el of elements) {
    const pos = pointOf(el)
    const tags = el.tags || {}
    const { name, nameRoman } = baseName(tags)
    if (!pos || !name) continue

    let lens, attrs = {}
    switch (cls) {
      case 'wat': {
        // temple grounds only; skip shrines misc tagged buddhist
        if (tags.amenity !== 'place_of_worship') continue
        lens = ['wat']
        attrs = { status: 'active' } // OSM has active temples; ruins are historic=*
        if (tags.denomination === 'theravada' || !tags.denomination) attrs.sect = 'unknown'
        // Contact + hours, where a mapper bothered. Coverage is thin (phone ~0.2%,
        // opening_hours ~0.9%) because Thai wats are open dawn-to-dusk and simply
        // don't publish hours — so these are recorded when present and NEVER
        // inferred when absent. A filter built on them must say how few there are.
        const pick = (...k) => { for (const x of k) if (tags[x]) return tags[x]; return null }
        const phone = pick('phone', 'contact:phone')
        const website = pick('website', 'contact:website')
        const email = pick('email', 'contact:email')
        const hours = tags.opening_hours || null
        if (phone) attrs.phone = phone
        if (website) attrs.website = website
        if (email) attrs.email = email
        if (hours) attrs.openingHours = hours
        if (tags['contact:facebook']) attrs.facebook = tags['contact:facebook']
        // Locality: the province is known for certain from the crawl region;
        // district/subdistrict only when tagged.
        // addr:province arrives as จังหวัดเชียงราย / เชียงราย / Chiang Rai — three
        // spellings of one place, which would split the facet three ways. Map the
        // Thai forms onto the single English label; anything unrecognised falls
        // back to the region-derived value, which is right by construction.
        if (REGION_PROVINCE[REGION]) attrs.province = REGION_PROVINCE[REGION]
        const raw = (tags['addr:province'] || '').replace(/^จังหวัด/, '').trim()
        const TH = { 'เชียงใหม่': 'Chiang Mai', 'เชียงราย': 'Chiang Rai', 'ลำพูน': 'Lamphun',
                     'ลำปาง': 'Lampang', 'น่าน': 'Nan', 'พะเยา': 'Phayao', 'แม่ฮ่องสอน': 'Mae Hong Son' }
        if (TH[raw]) attrs.province = TH[raw]
        else if (raw && !/[฀-๿]/.test(raw)) attrs.province = raw
        if (tags['addr:district']) attrs.district = tags['addr:district']
        if (tags['addr:subdistrict']) attrs.subdistrict = tags['addr:subdistrict']
        const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
        if (street) attrs.street = street
        break
      }
      case 'library': {
        lens = ['library']
        const t = tags.operator?.match(/university|มหาวิทยาลัย/i) || /university|มหาวิทยาลัย/i.test(name)
          ? 'university' : 'public'
        attrs = { type: tags['library:type'] === 'little_free_library' ? 'little-free' : t }
        if (tags.opening_hours) attrs.hours = tags.opening_hours
        if (tags.internet_access && tags.internet_access !== 'no') attrs.wifi = 'yes'
        break
      }
      case 'tattoo':
        // Decision (CLAUDE.md): OSM shop points only — name+location. attrs
        // (style, artist) stay EMPTY until field input. Never from crawls.
        lens = ['tattoo']
        attrs = {}
        break
      case 'art-studio':
        lens = ['art-studio']
        if (tags.craft) attrs.discipline = tags.craft
        else if (tags.tourism === 'gallery') attrs.discipline = 'gallery'
        attrs.openToVisitors = tags.tourism === 'gallery' ? 'yes' : 'unknown'
        break
      case 'restaurant': {
        // pad-krapow CANDIDATES only: Thai-cuisine places whose name signals
        // krapow/rice-fast food. Ratings/attrs are field-only by policy.
        const sig = /กะเพรา|กระเพรา|krapow|kaprao|kra ?pao|ตามสั่ง/i
        if (!sig.test(name) && !sig.test(nameRoman || '') && !sig.test(tags.description || '')) continue
        lens = ['pad-krapow']
        attrs = {}
        break
      }
      case 'spirit-house':
        // wayside_shrine in OSM mixes Buddhist shrines and spirit houses; keep
        // only explicit spirit-house tagging to avoid polluting the flagship
        // field lens with crawled noise.
        if (!/spirit_house|ศาลพระภูมิ|ศาลเจ้าที่/i.test(JSON.stringify(tags))) continue
        lens = ['spirit-house']
        attrs = {}
        break
      default:
        continue
    }

    const osmRef = `${el.type}/${el.id}`
    let id = slugify(nameRoman || name) || `osm-${el.type}-${el.id}`
    if (seenIds.has(id)) id = `${id}-${el.id}`
    seenIds.add(id)

    out.push({
      id,
      lens,
      name,
      nameRoman: nameRoman || null,
      lat: pos.lat,
      lng: pos.lng,
      geoPrecision: pos.precision,
      address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:subdistrict']]
        .filter(Boolean).join(' ') || null,
      attrs,
      media: [],
      sources: [{ type: 'osm', ref: osmRef, fetched: TODAY }],
      confidence: 'crawled',
      notes: '',
      updatedAt: TODAY,
    })
  }
  return out
}

// ---- main ----------------------------------------------------------------
// --print-query: dry run — show exactly what would be sent, hit nothing.
if (process.argv.includes('--print-query')) {
  console.log(`region=${REGION}  classes=${ACTIVE_CLASSES.join(', ')}  →  data/crawled/osm${SUFFIX}.json`)
  for (const cls of ACTIVE_CLASSES) console.log(`\n# ${cls}\n${buildQuery(cls)}`)
  process.exit(0)
}

const doFetch = process.argv.includes('--fetch')
const all = []
const seenIds = new Set()
const failed = []
for (const cls of ACTIVE_CLASSES) {
  const file = join(CACHE, `${cls}.json`)
  if (!existsSync(file)) {
    if (doFetch) {
      // A single class 504-ing must NOT lose the classes that already
      // extracted. Snapshot-first means partial progress is real progress —
      // warn, record, and keep going; re-run --fetch fills the gap from where
      // it left off (cached classes are skipped).
      try {
        await fetchClass(cls)
      } catch (e) {
        console.warn(`- ${cls}: fetch failed (${e.message}); skipping this run`)
        failed.push(cls)
        continue
      }
    } else {
      console.warn(`- ${cls}: no cache (run with --fetch)`)
      failed.push(cls)
      continue
    }
  }
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const pts = extract(cls, doc.elements || [], seenIds)
  console.log(`${cls}: ${doc.elements?.length ?? 0} elements → ${pts.length} points`)
  all.push(...pts)
}

mkdirSync(join(ROOT, 'data/crawled'), { recursive: true })
all.sort((a, b) => a.id.localeCompare(b.id))
const outName = `osm${SUFFIX}.json`
writeFileSync(join(ROOT, 'data/crawled', outName), JSON.stringify(all, null, 2))
console.log(`→ data/crawled/${outName} (${all.length} points, confidence:crawled)`)
console.log('  (crawled output is NOT canonical — review + merge with merge.mjs)')
if (failed.length) {
  console.warn(`\n⚠ ${failed.length} class(es) not harvested: ${failed.join(', ')}`)
  console.warn('  Re-run `node harvest/osm-overpass.mjs --fetch` to fetch the gaps (cached classes are skipped).')
  process.exitCode = 2 // signal partial success without discarding written output
}
