#!/usr/bin/env node
// harvest/wikipedia.mjs — a real, readable paragraph for each temple that has a
// Wikipedia article. Zero deps, snapshot-first (cache/wikipedia/).
//
//   node harvest/wikipedia.mjs --fetch
//   node harvest/wikipedia.mjs --fetch --center="99.9 19.2" --radius=250
//
// Why this exists: Wikidata's schema:description is CC0 but almost always
// boilerplate ("Buddhist temple in Chiang Rai province, Thailand"). Wikipedia's
// intro paragraph actually tells you something. The trade is licensing —
// Wikipedia is CC BY-SA 4.0, so every extract MUST carry its article title, URL
// and licence, and that attribution has to survive all the way to the rendered
// page. We store it per-extract rather than as a site-wide footnote for exactly
// that reason: a share-alike licence attaches to the specific text, not the site.
//
// Sitelinks come from Wikidata (so the join stays on QID, like the photos), then
// one REST summary call per article. Thai is preferred where present — this is a
// Thai subject — with English kept alongside.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'cache/wikipedia')
mkdirSync(CACHE, { recursive: true })
const UA = 'mueang-map/1.0 (Chiang Mai niche-lens atlas; contact: skunkhaus@gmail.com)'
const SPARQL = 'https://query.wikidata.org/sparql'
const doFetch = process.argv.includes('--fetch')
const argVal = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`))
  return a ? a.slice(n.length + 3) : d
}
const CENTER = argVal('center', '99.9 19.2')
const RADIUS = argVal('radius', '250')
const QV = 'v2-sections'                    // bump when QUERY changes shape
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cached(name, url, asJson = true) {
  const f = join(CACHE, name)
  if (existsSync(f)) { const t = readFileSync(f, 'utf8'); return asJson ? JSON.parse(t) : t }
  if (!doFetch) return null
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
      if (r.ok) { const t = await r.text(); writeFileSync(f, t); await sleep(220); return asJson ? JSON.parse(t) : t }
      if (r.status === 404) { writeFileSync(f, '{}'); return {} }   // no article — cache the absence
    } catch { /* retry */ }
    await sleep(3000 * (i + 1))
  }
  return null
}

const QUERY = `
SELECT ?item ?en ?th WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${CENTER})"^^geo:wktLiteral ; wikibase:radius "${RADIUS}" .
  }
  ?item wdt:P31 wd:Q427287 .
  OPTIONAL { ?a schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?en . }
  OPTIONAL { ?b schema:about ?item ; schema:isPartOf <https://th.wikipedia.org/> ; schema:name ?th . }
  FILTER(BOUND(?en) || BOUND(?th))
}`.trim()

const doc = await cached(`sitelinks_${QV}_${CENTER.replace(/[^0-9.\-]+/g, '_')}_r${RADIUS}.json`,
  `${SPARQL}?format=json&query=${encodeURIComponent(QUERY)}`)
if (!doc) { console.error('✗ no sitelink cache — run with --fetch'); process.exit(1) }

const items = new Map()
for (const b of doc.results.bindings) {
  const qid = b.item.value.split('/').pop()
  const it = items.get(qid) || { qid, en: null, th: null }
  it.en ||= b.en?.value || null
  it.th ||= b.th?.value || null
  items.set(qid, it)
}
console.log(`temples with a Wikipedia article: ${items.size}`)

const clean = (s) => (s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

// Sections worth keeping, and what they are. Thai Wikipedia articles on these
// temples are genuinely substantial (Wat Phra That Lampang Luang runs to 14 k
// characters across 14 sections) and it is in those sections — not in Wikidata,
// which has an architectural style for 1 temple out of 707 — that the
// architecture and the points of interest actually live.
const SECTION_KINDS = [
  ['architecture', /สถาปัตยกรรม|ศิลปกรรม|ลักษณะ|architecture|architectural|art and architecture/i],
  ['history',      /ประวัติ|ตำนาน|history|legend|origin/i],
  ['interest',     /น่าสนใจ|ปูชนีย|สิ่งสำคัญ|โบราณวัตถุ|พระประธาน|visiting|highlights|features|notable/i],
  ['heritage',     /ขึ้นทะเบียน|โบราณสถาน|heritage|registration/i],
]
// Apparatus, not content: references, external links, galleries, navigation.
const SECTION_DROP = /อ้างอิง|แหล่งข้อมูล|ดูเพิ่ม|รูปภาพ|ระเบียงภาพ|บรรณานุกรม|references|external links|see also|gallery|notes|bibliography|further reading|sources/i

function sectionsOf(extract) {
  // exsectionformat=wiki keeps "== Heading ==" markers in the plain text.
  const parts = String(extract || '').split(/^==+ *(.+?) *=+$/m)
  const out = []
  const lead = clean(parts[0])
  if (lead) out.push({ heading: null, kind: 'lead', text: lead })
  for (let i = 1; i < parts.length; i += 2) {
    const heading = clean(parts[i])
    const body = clean(parts[i + 1])
    if (!heading || !body || SECTION_DROP.test(heading)) continue
    if (body.length < 40) continue              // stubs and one-liners
    const kind = (SECTION_KINDS.find(([, re]) => re.test(heading)) || [null])[0]
    out.push({ heading, kind, text: body.length > 2200 ? body.slice(0, 2200).replace(/\s+\S*$/, '') + '…' : body })
  }
  return out
}

const out = []
let nEn = 0, nTh = 0, nArch = 0, nSections = 0
for (const it of items.values()) {
  const got = {}
  for (const [lang, title] of [['th', it.th], ['en', it.en]]) {
    if (!title) continue
    // Full plain text WITH section markers — the REST summary endpoint only ever
    // returns the lead paragraph, which is what we were previously storing.
    const api = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1` +
      `&exsectionformat=wiki&format=json&formatversion=2&titles=${encodeURIComponent(title)}`
    const d = await cached(`${lang}-full-${it.qid}.json`, api)
    const page = d?.query?.pages?.[0]
    const extract = page?.extract
    if (!extract) continue
    const secs = sectionsOf(extract)
    if (!secs.length) continue
    const lead = secs.find((x) => x.kind === 'lead')
    got[lang] = {
      lang, title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      // short lead kept for the map payload; sections carry the depth
      text: lead ? (lead.text.length > 700 ? lead.text.slice(0, 700).replace(/\s+\S*$/, '') + '…' : lead.text) : '',
      sections: secs.filter((x) => x.kind !== 'lead'),
      chars: extract.length,
    }
    nSections += got[lang].sections.length
    if (got[lang].sections.some((x) => x.kind === 'architecture')) nArch++
  }
  if (!got.en && !got.th) continue
  if (got.en) nEn++
  if (got.th) nTh++
  out.push({
    qid: it.qid,
    summary: got.th || got.en,          // preferred language for the card
    summaryEn: got.en || null,
    article: { th: got.th || null, en: got.en || null },   // both, in full
  })
}
mkdirSync(join(ROOT, 'data/crawled'), { recursive: true })
writeFileSync(join(ROOT, 'data/crawled/wikipedia.json'), JSON.stringify(out, null, 2))
console.log(`  ${out.length} articles (${nTh} Thai, ${nEn} English) · ${nSections} sections kept · ${nArch} with an architecture section`)
console.log('  every extract carries its article title, URL and CC BY-SA 4.0')
console.log('→ data/crawled/wikipedia.json (fold with: node merge.mjs summary wikipedia)')
