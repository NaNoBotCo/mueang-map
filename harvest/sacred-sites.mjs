#!/usr/bin/env node
// harvest/sacred-sites.mjs — notable places of spiritual significance in the
// Lanna north that are NOT wats: city pillars (lak mueang), the sunken cities,
// sacred and prehistoric caves, monumental Buddha images, mosques, churches,
// Chinese shrines. Zero deps, snapshot-first (cache/sacred/).
//
//   node harvest/sacred-sites.mjs --fetch
//
// Wikidata-first, deliberately. "Notable" is the whole selection criterion here,
// and having a Wikidata item is a reasonable proxy for it — but the decisive
// reason is that a QID is what lets us attach a correctly-credited Commons
// photograph. OSM would give more points and no provenance for imagery.
//
// Three filters keep the set honest:
//   1. Geography — a radius query centred on the north still reaches Sukhothai,
//      whose historical park would otherwise flood the list with 50+ ruins from
//      a different kingdom. Bounded to the Lanna provinces by bbox.
//   2. "Not exactly a wat" — anything literally named Wat X is a temple (a
//      ruined one is still one), so it is dropped unless its class is a
//      genuinely different kind of site (cave, city pillar, ancient city…).
//   3. Not-spiritual denylist — the class lists catch a few civic statues.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slugify } from '../lib/schema.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'cache/sacred')
mkdirSync(CACHE, { recursive: true })
const UA = 'mueang-map/1.0 (Chiang Mai niche-lens atlas; contact: skunkhaus@gmail.com)'
const SPARQL = 'https://query.wikidata.org/sparql'
const COMMONS = 'https://commons.wikimedia.org/w/api.php'
const TODAY = new Date().toISOString().slice(0, 10)
const doFetch = process.argv.includes('--fetch')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Classes confirmed to actually exist in the region (discovered by querying
// Wikidata for what is here, rather than guessing at QIDs).
const CLASSES = {
  Q974127: 'city pillar',        // lak mueang — the mueang's spirit anchor
  Q839954: 'ancient city',       // archaeological site
  Q35509: 'cave',
  Q1000809: 'buddha image',      // buddharupa
  Q32815: 'mosque',
  Q16970: 'church',
  Q13217298: 'chinese temple',
  Q184657: 'stupa',
  Q179700: 'statue',
}
// The Lanna sphere: Chiang Mai, Chiang Rai, Lamphun, Lampang, Nan, Phayao,
// Mae Hong Son. Deliberately excludes Sukhothai / Si Satchanalai / Uttaradit.
const BOX = { lat: [17.8, 20.6], lng: [97.2, 101.4] }
// Civic monuments the class filter drags in; not places of spiritual practice.
const DENY = /queen victoria|ram khamhaeng|king rama|democracy monument/i

async function cachedJson(name, url) {
  const f = join(CACHE, name)
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  if (!doFetch) return null
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json,application/sparql-results+json' } })
      if (r.ok) { const t = await r.text(); writeFileSync(f, t); await sleep(300); return JSON.parse(t) }
    } catch { /* retry */ }
    await sleep(4000 * (i + 1))
  }
  console.warn(`  ! ${name}: fetch failed`)
  return null
}

const vals = Object.keys(CLASSES).map((q) => 'wd:' + q).join(' ')
const QUERY = `
SELECT ?item ?itemLabel ?thLabel ?cls ?coord ?img ?cat ?siteLabel WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(99.9 19.2)"^^geo:wktLiteral ; wikibase:radius "250" .
  }
  ?item wdt:P17 wd:Q869 ; wdt:P31 ?cls .
  VALUES ?cls { ${vals} }
  OPTIONAL { ?item wdt:P18 ?img . }
  OPTIONAL { ?item wdt:P373 ?cat . }
  OPTIONAL { ?item wdt:P1435 ?site . ?site rdfs:label ?siteLabel . FILTER(LANG(?siteLabel)="en") }
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)="en") }
  OPTIONAL { ?item rdfs:label ?thLabel . FILTER(LANG(?thLabel)="th") }
}`.trim()

const doc = await cachedJson('sparql.json', `${SPARQL}?format=json&query=${encodeURIComponent(QUERY)}`)
if (!doc) { console.error('✗ no cache/sacred/sparql.json — run with --fetch'); process.exit(1) }

const byQid = new Map()
for (const b of doc.results.bindings) {
  const qid = b.item.value.split('/').pop()
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord?.value || '')
  if (!m) continue
  const it = byQid.get(qid) || { qid, en: null, th: null, kinds: new Set(), lng: +m[1], lat: +m[2], img: null, cat: null, heritage: null }
  it.en ||= b.itemLabel?.value || null
  it.th ||= b.thLabel?.value || null
  it.kinds.add(CLASSES[b.cls.value.split('/').pop()])
  if (b.img) it.img = b.img.value
  if (b.cat) it.cat = b.cat.value
  if (b.siteLabel) it.heritage = b.siteLabel.value
  byQid.set(qid, it)
}

const DISTINCT = new Set(['cave', 'city pillar', 'ancient city', 'mosque', 'church', 'chinese temple', 'stupa'])
const kept = [...byQid.values()].filter((v) => {
  if (v.lat < BOX.lat[0] || v.lat > BOX.lat[1] || v.lng < BOX.lng[0] || v.lng > BOX.lng[1]) return false
  const name = v.en || v.th || ''
  if (DENY.test(name)) return false
  const watNamed = /^\s*(wat|วัด)\b/i.test(name)
  return !watNamed || [...v.kinds].some((k) => DISTINCT.has(k))
})
console.log(`${byQid.size} candidates → ${kept.length} non-wat sacred sites in the Lanna north`)

// ---- imagery: same QID join as the wat photos, same credit discipline -------
const EXTRA = 'iiprop=url%7Cextmetadata&iiurlwidth=800&format=json&formatversion=2'
const strip = (s) => (s == null ? null : String(s).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim() || null)
const FREE = /^(cc[ -]|public domain|pd[ -]|no restrictions|copyrighted free use|gfdl|fal\b)/i
function readImage(page) {
  const ii = page.imageinfo?.[0]; if (!ii) return null
  const m = ii.extmetadata || {}
  const license = strip(m.LicenseShortName?.value) || strip(m.UsageTerms?.value)
  if (!license || !FREE.test(license)) return null
  return {
    type: 'image', title: page.title, url: ii.url, thumb: ii.thumburl || ii.url,
    author: strip(m.Artist?.value) || 'Unknown (see source page)',
    license, licenseUrl: strip(m.LicenseUrl?.value) || null,
    description: strip(m.ImageDescription?.value),
    capturedAt: (strip(m.DateTimeOriginal?.value) || '').slice(0, 10) || null,
    source: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
    publicDomain: /public domain|^pd[ -]|no restrictions/i.test(license),
    credit: null,
  }
}
const pages = (d) => d?.query?.pages ?? []

const out = []
let nImg = 0, nPD = 0
for (const v of kept) {
  const media = new Map()
  if (v.cat) {
    const d = await cachedJson(`cat-${v.qid}.json`,
      `${COMMONS}?action=query&generator=categorymembers&gcmtitle=${encodeURIComponent('Category:' + v.cat)}&gcmtype=file&gcmlimit=4&prop=imageinfo&${EXTRA}`)
    for (const p of pages(d)) { const im = readImage(p); if (im) media.set(p.title, im) }
  }
  if (v.img) {
    const title = 'File:' + decodeURIComponent(v.img.split('/').pop()).replace(/_/g, ' ')
    const d = await cachedJson(`lead-${v.qid}.json`,
      `${COMMONS}?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&${EXTRA}`)
    for (const p of pages(d)) { const im = readImage(p); if (im) { im.lead = true; media.set(p.title, im) } }
  }
  // public domain first (the ask), then the designated lead image
  const list = [...media.values()].sort((a, b) =>
    (b.publicDomain ? 1 : 0) - (a.publicDomain ? 1 : 0) || (b.lead ? 1 : 0) - (a.lead ? 1 : 0)).slice(0, 3)
  for (const im of list) {
    im.credit = `${im.description ? im.description + ' — ' : ''}${im.author}, ${im.license}, via Wikimedia Commons`
    delete im.lead
  }
  nImg += list.length
  nPD += list.filter((i) => i.publicDomain).length

  const kinds = [...v.kinds]
  out.push({
    id: slugify(v.en || v.th || v.qid) || `wd-${v.qid.toLowerCase()}`,
    lens: ['sacred'],
    kind: 'sacred',
    name: v.th || v.en,
    nameRoman: v.en || null,
    lat: v.lat, lng: v.lng,
    geoPrecision: 'block',
    attrs: { siteType: kinds.join('; '), heritage: v.heritage || '' },
    media: list,
    sources: [{ type: 'wikidata', ref: v.qid, fetched: TODAY }],
    confidence: 'crawled',
    updatedAt: TODAY,
  })
}
out.sort((a, b) => (b.media.length - a.media.length) || (a.nameRoman || a.name || '').localeCompare(b.nameRoman || b.name || ''))
mkdirSync(join(ROOT, 'data/crawled'), { recursive: true })
writeFileSync(join(ROOT, 'data/crawled/sacred-sites.json'), JSON.stringify(out, null, 2))
const byKind = {}
for (const o of out) for (const k of o.attrs.siteType.split('; ')) byKind[k] = (byKind[k] || 0) + 1
console.log(`  imagery: ${nImg} images (${nPD} public domain) across ${out.filter((o) => o.media.length).length} sites`)
console.log(`  kinds: ${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}`)
console.log('→ data/crawled/sacred-sites.json')
