#!/usr/bin/env node
// harvest/commons-images.mjs — freely-licensed temple photography from
// Wikimedia Commons. Zero deps. Snapshot-first: every API response is cached
// under cache/commons/; re-running extracts from cache and hits nothing unless
// --fetch is passed and a cache file is missing.
//
//   node harvest/commons-images.mjs            # extract from cache only
//   node harvest/commons-images.mjs --fetch    # fetch missing, then extract
//   node harvest/commons-images.mjs --fetch --per-temple=8
//
// Join key is the Wikidata QID, NOT proximity+name: our canonical points already
// carry sources[{type:'wikidata',ref:'Q…'}], so images attach to exactly the
// right temple with no fuzzy matching. Two image sources per temple:
//   P18  — the item's designated lead image
//   P373 — its Commons category, which usually holds many more
//
// Every image keeps author + licence + source URL. Commons hosts only freely
// licensed or public-domain files, but we still drop anything whose licence
// doesn't parse as free — an unattributable image is worse than no image.
//
// Output data/crawled/commons-images.json is NOT canonical.
//   fold with:  node merge.mjs media commons-images

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'cache/commons')
mkdirSync(CACHE, { recursive: true })

const UA = 'mueang-map/1.0 (Chiang Mai niche-lens atlas; contact: skunkhaus@gmail.com)'
const SPARQL = 'https://query.wikidata.org/sparql'
const COMMONS = 'https://commons.wikimedia.org/w/api.php'
const TODAY = new Date().toISOString().slice(0, 10)

const argVal = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`))
  return a ? a.slice(n.length + 3) : d
}
const doFetch = process.argv.includes('--fetch')
const PER_TEMPLE = Math.max(1, Math.min(20, Number(argVal('per-temple', 6))))
const CENTER = argVal('center', '98.99 18.79')
const RADIUS = argVal('radius', '25')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

// Cached GET returning parsed JSON. Never refetches an existing cache file.
async function cachedJson(cacheName, url) {
  const file = join(CACHE, cacheName)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  if (!doFetch) return null
  let body = null, lastErr = null
  for (let attempt = 0; attempt < 3 && body == null; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
      if (res.ok) body = await res.text()
      else { lastErr = `http ${res.status}`; await sleep(4000 * (attempt + 1)) }
    } catch (e) { lastErr = String(e); await sleep(4000 * (attempt + 1)) }
  }
  if (body == null) { console.warn(`  ! ${cacheName}: ${lastErr}`); return null }
  writeFileSync(file, body)
  await sleep(300) // polite gap
  return JSON.parse(body)
}

// ---- 1. which temples, and what image hooks do they carry? ---------------
const QUERY = `
SELECT ?item ?enLabel ?thLabel ?enDesc ?thDesc ?img ?cat WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${CENTER})"^^geo:wktLiteral ; wikibase:radius "${RADIUS}" .
  }
  ?item wdt:P31 wd:Q427287 .
  OPTIONAL { ?item wdt:P18 ?img . }
  OPTIONAL { ?item wdt:P373 ?cat . }
  OPTIONAL { ?item rdfs:label ?enLabel . FILTER(LANG(?enLabel)="en") }
  OPTIONAL { ?item rdfs:label ?thLabel . FILTER(LANG(?thLabel)="th") }
  OPTIONAL { ?item schema:description ?enDesc . FILTER(LANG(?enDesc)="en") }
  OPTIONAL { ?item schema:description ?thDesc . FILTER(LANG(?thDesc)="th") }
}`.trim()

// Cache key MUST encode the query parameters. It used to be a fixed filename,
// which meant changing --center/--radius silently replayed the previous region's
// cached answer — the widened crawl looked like it ran and returned the old
// 25 km Chiang Mai result. Snapshot-first only works if the key is the query.
const QV = 'v2-desc'   // bump whenever QUERY changes shape
const sparqlKey = `sparql-images_${QV}_${CENTER.replace(/[^0-9.\-]+/g, '_')}_r${RADIUS}.json`
const sparql = await cachedJson(sparqlKey, `${SPARQL}?format=json&query=${encodeURIComponent(QUERY)}`)
if (!sparql) { console.error(`✗ no cache/commons/${sparqlKey} — run with --fetch`); process.exit(1) }

const temples = new Map() // qid → {qid,en,th,leadFiles:Set,cat}
for (const b of sparql.results.bindings) {
  const qid = b.item.value.split('/').pop()
  if (!temples.has(qid)) temples.set(qid, { qid, en: b.enLabel?.value || null, th: b.thLabel?.value || null, enDesc: null, thDesc: null, leadFiles: new Set(), cat: null })
  const t = temples.get(qid)
  t.enDesc ||= b.enDesc?.value || null
  t.thDesc ||= b.thDesc?.value || null
  if (b.img) t.leadFiles.add('File:' + decodeURIComponent(b.img.value.split('/').pop()).replace(/_/g, ' '))
  if (b.cat) t.cat = b.cat.value
}
console.log(`temples in Wikidata: ${temples.size} (${[...temples.values()].filter((t) => t.leadFiles.size).length} with a lead image, ${[...temples.values()].filter((t) => t.cat).length} with a Commons category)`)

// ---- 2. Commons: category members + imageinfo in ONE request per temple ---
// generator=categorymembers + prop=imageinfo returns files AND their licence
// metadata together, so a temple costs a single API call.
const EXTRA = 'iiprop=url%7Cextmetadata&iiurlwidth=800&format=json&formatversion=2'
function pagesOf(doc) { return doc?.query?.pages ?? [] }

const stripHtml = (s) => (s == null ? null : String(s)
  .replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim() || null)

// A licence is usable only if we can name it. Commons is free-only, but a file
// with unparseable terms gets dropped rather than published unattributed.
const FREE = /^(cc[ -]|public domain|pd[ -]|no restrictions|copyrighted free use|gfdl|fal\b)/i
function readImage(page) {
  const ii = page.imageinfo?.[0]
  if (!ii) return null
  const m = ii.extmetadata || {}
  const license = stripHtml(m.LicenseShortName?.value) || stripHtml(m.UsageTerms?.value)
  if (!license || !FREE.test(license)) return null
  const author = stripHtml(m.Artist?.value)
  return {
    type: 'image',
    title: page.title,
    url: ii.url,
    thumb: ii.thumburl || ii.url,
    width: ii.thumbwidth ?? null,
    author: author || 'Unknown (see source page)',
    license,
    licenseUrl: stripHtml(m.LicenseUrl?.value) || null,
    description: stripHtml(m.ImageDescription?.value),
    capturedAt: (stripHtml(m.DateTimeOriginal?.value) || '').slice(0, 10) || null,
    source: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
    credit: null, // filled below — one ready-to-print attribution string
  }
}
const creditLine = (img) => `${img.description ? img.description + ' — ' : ''}${img.author}, ${img.license}, via Wikimedia Commons`

const out = []
let nImg = 0, nTemples = 0, fetched = 0
for (const t of temples.values()) {
  const media = new Map() // title → image (dedupes lead image vs category member)

  if (t.cat) {
    const url = `${COMMONS}?action=query&generator=categorymembers&gcmtitle=${encodeURIComponent('Category:' + t.cat)}` +
      `&gcmtype=file&gcmlimit=${PER_TEMPLE}&prop=imageinfo&${EXTRA}`
    const doc = await cachedJson(`cat-${t.qid}.json`, url)
    if (doc) { fetched++; for (const p of pagesOf(doc)) { const im = readImage(p); if (im) media.set(p.title, im) } }
  }
  if (t.leadFiles.size) {
    const titles = [...t.leadFiles].join('|')
    const url = `${COMMONS}?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&${EXTRA}`
    const doc = await cachedJson(`lead-${t.qid}.json`, url)
    if (doc) {
      fetched++
      for (const p of pagesOf(doc)) {
        const im = readImage(p)
        if (im) { im.lead = true; media.set(p.title, im) }
      }
    }
  }
  if (!media.size) continue
  // lead image first, then the rest — the card shows media[0]
  const list = [...media.values()].sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0)).slice(0, PER_TEMPLE)
  for (const im of list) { im.credit = creditLine(im); delete im.lead }
  // Wikidata descriptions are CC0 — safe to reproduce verbatim with no
  // attribution burden, unlike the photographs they sit beside.
  out.push({ qid: t.qid, nameRoman: t.en, name: t.th,
             description: t.enDesc, descriptionTh: t.thDesc, media: list })
  nTemples++; nImg += list.length
}

mkdirSync(join(ROOT, 'data/crawled'), { recursive: true })
out.sort((a, b) => a.qid.localeCompare(b.qid))
writeFileSync(join(ROOT, 'data/crawled/commons-images.json'), JSON.stringify(out, null, 2))
console.log(`commons: ${nTemples} temples → ${nImg} freely-licensed images (${fetched} API calls this run)`)
console.log('→ data/crawled/commons-images.json (fold with: node merge.mjs media commons-images)')
if (!doFetch && fetched === 0) console.log('  (cache-only run — pass --fetch to fill gaps)')
