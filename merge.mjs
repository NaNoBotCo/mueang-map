#!/usr/bin/env node
// merge.mjs — the reviewed step between crawled/field data and canonical.
// Nothing writes to data/canonical/ except this script (and the auspicious
// generator). Field truth beats crawled truth. Idempotent: re-applying the
// same patch changes nothing. Never silently drops a field point — anything
// not applied is written to data/canonical/merge-conflicts.json with a reason.
//
//   node merge.mjs crawled osm          # fold data/crawled/osm.json → canonical
//   node merge.mjs patch patches/patch-20260718.json
//
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePoint, inBbox, isPointFile, distanceM } from './lib/schema.mjs'

// MM_ROOT lets the test suite point merge at a fixture tree.
const ROOT = process.env.MM_ROOT || dirname(fileURLToPath(import.meta.url))
const CANON = join(ROOT, 'data/canonical')
const lensIds = JSON.parse(readFileSync(join(ROOT, 'data/lenses.json'), 'utf8'))
  .lenses.map((l) => l.id)

const loadJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback)
const pointsOf = (doc) => (Array.isArray(doc) ? doc : doc.points ?? [])
const save = (p, points) => writeFileSync(p, JSON.stringify(points.sort((a, b) => a.id.localeCompare(b.id)), null, 2))

function allCanonical() {
  const files = {}
  for (const f of readdirSync(CANON).filter(isPointFile))
    files[f] = pointsOf(loadJson(join(CANON, f), []))
  return files
}
const hasFieldSource = (p) => (p.sources || []).some((s) => s.type === 'field')

const conflicts = loadJson(join(CANON, 'merge-conflicts.json'), [])
const addConflict = (reason, entry) => conflicts.push({ date: new Date().toISOString().slice(0, 10), reason, entry })

const [, , mode, arg] = process.argv

if (mode === 'crawled') {
  // Fold a crawl refresh into its canonical file, with a printed review diff.
  const src = arg
  const crawled = pointsOf(loadJson(join(ROOT, 'data/crawled', `${src}.json`), null) ?? bail(`no data/crawled/${src}.json`))
  const canonFile = join(CANON, `${src}.json`)
  const existing = pointsOf(loadJson(canonFile, []))
  const byId = new Map(existing.map((p) => [p.id, p]))
  // Field-touched ids across ALL canonical files are protected from crawl overwrite.
  const fieldIds = new Set()
  for (const pts of Object.values(allCanonical()))
    for (const p of pts) if (hasFieldSource(p)) fieldIds.add(p.id)

  let added = 0, updated = 0, protectedN = 0, invalid = 0
  for (const p of crawled) {
    const errs = validatePoint(p, lensIds)
    if (!inBbox(p)) errs.push('outside bbox')
    if (errs.length) { addConflict(`invalid crawled point: ${errs.join('; ')}`, p); invalid++; continue }
    if (fieldIds.has(p.id)) {
      // field truth beats crawled truth — refresh goes to review, not overwrite
      addConflict('crawl refresh for field-touched point (review manually)', p)
      protectedN++
      continue
    }
    const prev = byId.get(p.id)
    if (!prev) { byId.set(p.id, p); added++ }
    else {
      // A crawl refresh updates what the CRAWL knows. It must not delete what
      // other sources contributed — heritage flags, founding dates, Wikipedia
      // summaries and Commons photographs all arrive later via enrich/media/
      // summary, and a naive wholesale replace silently wiped them (founding
      // dates fell 30→4 the first time this ran). So: crawl attrs win where the
      // crawl has a value, enrichment survives where it doesn't, and media plus
      // non-crawl sources are carried across.
      const merged = {
        ...p,
        attrs: { ...prev.attrs, ...p.attrs },
        media: (p.media && p.media.length) ? p.media : (prev.media || []),
        sources: [...(p.sources || [])],
      }
      for (const sc of prev.sources || [])
        if (!merged.sources.some((x) => x.type === sc.type && x.ref === sc.ref)) merged.sources.push(sc)
      if (JSON.stringify({ ...prev, updatedAt: 0 }) !== JSON.stringify({ ...merged, updatedAt: 0 })) {
        byId.set(p.id, merged); updated++
      }
    }
  }
  const removed = existing.filter((p) => !crawled.some((c) => c.id === p.id) && !hasFieldSource(p))
  save(canonFile, [...byId.values()])
  writeFileSync(join(CANON, 'merge-conflicts.json'), JSON.stringify(conflicts, null, 2))
  console.log(`${src}: +${added} new, ~${updated} updated, ${protectedN} field-protected → conflicts, ${invalid} invalid → conflicts`)
  if (removed.length)
    console.log(`  note: ${removed.length} canonical point(s) no longer in crawl (kept; remove manually if gone): ${removed.slice(0, 5).map((p) => p.id).join(', ')}${removed.length > 5 ? '…' : ''}`)
} else if (mode === 'enrich') {
  // Fold a crawled ENRICHMENT source (e.g. Wikidata) onto existing canonical
  // points: fill only EMPTY attrs, append the source for traceability, never
  // touch coordinates or names (OSM/field truth owns location + identity), and
  // never create a pin — an enrichment point with no confident canonical match
  // is a candidate temple written to merge-conflicts.json for human review.
  // Idempotent: a second run fills nothing new and re-adds no source.
  const src = arg
  const enrich = pointsOf(loadJson(join(ROOT, 'data/crawled', `${src}.json`), null) ?? bail(`no data/crawled/${src}.json`))
  // The candidate review queue is regenerable: drop this source's prior
  // enrich candidates so a re-run replaces rather than duplicates them
  // (canonical points are already idempotent; keep the queue idempotent too).
  for (let i = conflicts.length - 1; i >= 0; i--)
    if (typeof conflicts[i].reason === 'string' && conflicts[i].reason.startsWith(`enrich ${src}:`))
      conflicts.splice(i, 1)
  const canonFiles = allCanonical()
  const flat = []
  for (const [fname, pts] of Object.entries(canonFiles))
    for (const p of pts) flat.push({ fname, p })

  const MATCH_M = 150 // Wikidata coords are centroid-ish; allow generous slack
  // Normalized name key: drop the "wat/วัด" prefix and non-alphanum so
  // "Wat Chedi Luang" ↔ "Chedi Luang" ↔ "วัดเจดีย์หลวง"(vs its roman) compare.
  const nk = (s) => (s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/wat|วัด/g, '')
    .replace(/[^a-z0-9฀-๿]+/g, '')
  // Two normalized names are "the same temple" when identical, when one fully
  // contains the other (formal vs common name: พระธาตุดอยสุเทพ ⊂ พระธาตุดอยสุเทพราชวรวิหาร),
  // or when they are a documented romanization variant of each other. The
  // containment/alias tests only fire on names ≥5 chars so short tokens can't
  // false-match. ALIASES holds verified same-temple name pairs the phonetic
  // transliteration splits (e.g. Chet Yot / Jed Yod, ช/จ and ต/ด variance).
  const ALIASES = [['chetyot', 'jedyod']].map((p) => p.map(nk).sort().join('|'))
  const sameName = (a, b) => {
    a = nk(a); b = nk(b)
    if (!a || !b) return false
    if (a === b) return true
    if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return true
    return ALIASES.includes([a, b].sort().join('|'))
  }

  let enriched = 0, filled = 0, unmatched = 0, already = 0
  const touched = new Set()
  for (const e of enrich) {
    const cands = flat.filter(({ p }) =>
      p.lens.some((l) => e.lens.includes(l)) && distanceM(p, e) <= MATCH_M)
    let best = null, bestNameMatch = false, bestDist = Infinity
    for (const c of cands) {
      const nameMatch =
        (nk(c.p.nameRoman) && nk(e.nameRoman) && sameName(c.p.nameRoman, e.nameRoman)) ||
        (nk(c.p.name) && nk(e.name) && sameName(c.p.name, e.name))
      const d = distanceM(c.p, e)
      // prefer a name match; among equals, prefer the nearer point
      if ((nameMatch && !bestNameMatch) || (nameMatch === bestNameMatch && d < bestDist)) {
        best = c; bestNameMatch = nameMatch; bestDist = d
      }
    }
    // Accept a name match at any distance within MATCH_M, or a very-close
    // point (<40 m) even without a name match. Otherwise it's a candidate.
    if (!best || (!bestNameMatch && bestDist >= 40)) {
      addConflict(`enrich ${src}: no confident match for ${e.id} (${e.nameRoman || e.name}) — candidate for review`, e)
      unmatched++
      continue
    }
    const t = best.p
    const ref = e.sources[0]
    const hasSrc = (t.sources || []).some((s) => s.type === ref.type && s.ref === ref.ref)
    let changed = false
    for (const [k, v] of Object.entries(e.attrs || {})) {
      if (v == null || v === '' || v === 'unknown') continue // never fill a non-fact
      const cur = t.attrs[k]
      if (cur == null || cur === '' || cur === 'unknown') { t.attrs[k] = v; filled++; changed = true }
    }
    if (!hasSrc) { t.sources.push(ref); changed = true }
    if (changed) { t.updatedAt = e.updatedAt; enriched++; touched.add(best.fname) }
    else already++
  }
  for (const f of touched) save(join(CANON, f), canonFiles[f])
  writeFileSync(join(CANON, 'merge-conflicts.json'), JSON.stringify(conflicts, null, 2))
  console.log(`enrich ${src}: ${enriched} points enriched (${filled} attrs filled), ${already} already-current, ${unmatched} unmatched → merge-conflicts.json`)
} else if (mode === 'promote') {
  // Promote reviewed ENRICH candidates (enrichment points that matched no
  // existing pin) into canonical as their own pins. This is the human-reviewed
  // sibling of `enrich`: enrich fills existing temples, promote adds the
  // temples the primary crawl (OSM) missed entirely. Distance-gated so it never
  // plants a second pin on a temple canonical already has — anything closer than
  // --min-dist to an existing same-lens pin stays in the queue as a likely dup.
  // Writes promoted pins to data/canonical/<src>.json. Idempotent: an id already
  // in canonical is skipped, and promoted entries leave the conflict queue.
  //   node merge.mjs promote wikidata            # default 75 m dup gate
  //   node merge.mjs promote wikidata --min-dist=120
  const src = arg
  const minDist = Number((process.argv.find((a) => a.startsWith('--min-dist=')) || '=75').split('=')[1])
  const prefix = `enrich ${src}:`
  const canonFiles = allCanonical()
  const canonIds = new Set()
  const sameLensPins = []
  for (const pts of Object.values(canonFiles))
    for (const p of pts) { canonIds.add(p.id); sameLensPins.push(p) }
  const destFile = join(CANON, `${src}.json`)
  const dest = pointsOf(loadJson(destFile, []))
  const destIds = new Set(dest.map((p) => p.id))

  let promoted = 0, tooClose = 0, invalid = 0, dupId = 0
  const kept = []
  for (const c of conflicts) {
    if (typeof c.reason !== 'string' || !c.reason.startsWith(prefix)) { kept.push(c); continue }
    const e = c.entry
    const errs = validatePoint(e, lensIds)
    if (!inBbox(e)) errs.push('outside bbox')
    if (errs.length) { addConflict(`promote ${src}: invalid — ${errs.join('; ')}`, e); invalid++; continue }
    if (canonIds.has(e.id) || destIds.has(e.id)) { dupId++; continue } // already in — drop silently
    const nearest = sameLensPins
      .filter((p) => p.lens.some((l) => e.lens.includes(l)))
      .reduce((m, p) => Math.min(m, distanceM(p, e)), Infinity)
    if (nearest < minDist) {
      // same temple canonical already has under another name/position — keep for manual review
      kept.push({ ...c, reason: `promote ${src}: ${e.nameRoman || e.name} sits ${Math.round(nearest)} m from an existing pin (<${minDist} m) — likely dup, review manually` })
      tooClose++
      continue
    }
    dest.push(e)
    destIds.add(e.id)
    promoted++
  }
  const remaining = kept
  save(destFile, dest)
  writeFileSync(join(CANON, 'merge-conflicts.json'), JSON.stringify(remaining, null, 2))
  console.log(`promote ${src}: +${promoted} new pins → ${basename(destFile)}, ${tooClose} kept as likely-dup, ${dupId} already-present, ${invalid} invalid`)
} else if (mode === 'uniquify') {
  // Make ids unique ACROSS THE WHOLE CORPUS.
  //
  // Each harvester de-duplicates ids with a `seen` set scoped to one crawl run,
  // so two regions can independently mint the same slug. There are many temples
  // called Wat Chedi Luang. The collision was invisible until something keyed on
  // id: /place/wat-chedi-luang/ served the Chiang Rai temple and the Chiang Mai
  // one — old city, Sao Inthakhin — had no permalink at all. 50 slugs, 107
  // records.
  //
  // Every colliding record is suffixed with its province, so no record silently
  // wins the bare slug; the bare slug becomes a disambiguation page instead.
  // Deterministic ordering (province, lat, lng) so re-running is stable.
  const slug = (x) => String(x || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const canonFiles = allCanonical()
  const byId = new Map()
  for (const [fname, pts] of Object.entries(canonFiles))
    for (const p of pts) {
      if (!byId.has(p.id)) byId.set(p.id, [])
      byId.get(p.id).push({ fname, p })
    }
  let renamed = 0, groups = 0
  const touched = new Set()
  for (const [id, recs] of byId) {
    if (recs.length < 2) continue
    groups++
    recs.sort((a, b) => (a.p.attrs?.province || '').localeCompare(b.p.attrs?.province || '')
      || (a.p.lat - b.p.lat) || (a.p.lng - b.p.lng))
    const used = new Set()
    for (const r of recs) {
      const prov = slug(r.p.attrs?.province)
      let next = prov ? `${id}-${prov}` : id
      if (used.has(next) || byId.has(next)) {
        // same name AND same province — fall back to a coordinate fingerprint
        next = `${next}-${Math.abs(Math.round(r.p.lat * 1e4) % 10000)}`
      }
      used.add(next)
      if (next !== r.p.id) {
        addConflict(`uniquify: ${r.p.id} → ${next} (collided with ${recs.length - 1} other record(s) of the same slug)`, { id: r.p.id, to: next, name: r.p.nameRoman || r.p.name, province: r.p.attrs?.province })
        r.p.id = next
        touched.add(r.fname)
        renamed++
      }
    }
  }
  for (const f of touched) save(join(CANON, f), canonFiles[f])
  writeFileSync(join(CANON, 'merge-conflicts.json'), JSON.stringify(conflicts, null, 2))
  console.log(`uniquify: ${groups} colliding slug(s), ${renamed} record(s) renamed`)
} else if (mode === 'supersede') {
  // Resolve the duplicate a WIDER CRAWL creates. When a Wikidata temple was
  // promoted because OSM didn't have it, and a later province crawl then brings
  // in the same temple from OSM, canonical ends up holding it twice — two pins,
  // metres apart, on the same building.
  //
  // OSM wins on geometry (surveyed, not a centroid) so the OSM point is kept.
  // But the promoted point usually carries the facts OSM lacks — the heritage
  // registration above all — so those are TRANSFERRED onto the survivor before
  // it is dropped, and its source is appended so the provenance chain survives
  // the deletion. Nothing is discarded silently: every supersession is printed
  // and recorded in the review queue.
  //
  //   node merge.mjs supersede wikidata            # default 75 m
  //   node merge.mjs supersede wikidata --within=120
  const src = arg
  const within = Number((process.argv.find((a) => a.startsWith('--within=')) || '=75').split('=')[1])
  const file = join(CANON, `${src}.json`)
  const mine = pointsOf(loadJson(file, null) ?? bail(`no data/canonical/${src}.json`))
  const canonFiles = allCanonical()
  const others = []
  for (const [fname, pts] of Object.entries(canonFiles)) {
    if (fname === `${src}.json`) continue
    for (const p of pts) others.push({ fname, p })
  }
  const hasOsm = (p) => (p.sources || []).some((s) => s.type === 'osm')

  const kept = []
  let dropped = 0, moved = 0
  const touched = new Set()
  for (const p of mine) {
    if (hasFieldSource(p)) { kept.push(p); continue } // field truth is never superseded
    let best = null, bestD = Infinity
    for (const o of others) {
      if (!o.p.lens.some((l) => p.lens.includes(l)) || !hasOsm(o.p)) continue
      const d = distanceM(o.p, p)
      if (d < bestD) { best = o; bestD = d }
    }
    if (!best || bestD > within) { kept.push(p); continue }
    // transfer facts the survivor lacks, then append provenance
    const t = best.p
    const gained = []
    for (const [k, v] of Object.entries(p.attrs || {})) {
      if (v == null || v === '' || v === 'unknown') continue
      const cur = t.attrs[k]
      if (cur == null || cur === '' || cur === 'unknown') { t.attrs[k] = v; gained.push(k); moved++ }
    }
    for (const s of p.sources || [])
      if (!(t.sources || []).some((x) => x.type === s.type && x.ref === s.ref)) t.sources.push(s)
    if (!(t.media || []).length && (p.media || []).length) t.media = p.media
    touched.add(best.fname)
    addConflict(`supersede ${src}: ${p.id} (${p.nameRoman || p.name}) dropped — same temple as ${t.id} in ${best.fname}, ${Math.round(bestD)} m; transferred [${gained.join(', ') || 'nothing new'}]`, p)
    console.log(`  − ${(p.nameRoman || p.name || p.id).slice(0, 44).padEnd(46)} → ${t.id} (${Math.round(bestD)} m)${gained.length ? '  +' + gained.join(',') : ''}`)
    dropped++
  }
  save(file, kept)
  for (const f of touched) save(join(CANON, f), canonFiles[f])
  writeFileSync(join(CANON, 'merge-conflicts.json'), JSON.stringify(conflicts, null, 2))
  console.log(`supersede ${src}: ${dropped} duplicate(s) dropped, ${moved} fact(s) transferred to the surviving OSM points, ${kept.length} kept`)
} else if (mode === 'summary') {
  // Attach Wikipedia intro extracts, joined on QID. CC BY-SA 4.0, so the article
  // title, URL and licence travel WITH the text and are rendered beside it —
  // a share-alike licence attaches to that paragraph, not to the site footer.
  //   node merge.mjs summary wikipedia
  const src = arg
  const recs = loadJson(join(ROOT, 'data/crawled', `${src}.json`), null) ?? bail(`no data/crawled/${src}.json`)
  const canonFiles = allCanonical()
  const byQid = new Map()
  for (const [fname, pts] of Object.entries(canonFiles))
    for (const p of pts)
      for (const sc of p.sources || [])
        if (sc.type === 'wikidata' && sc.ref) {
          if (!byQid.has(sc.ref)) byQid.set(sc.ref, [])
          byQid.get(sc.ref).push({ fname, p })
        }
  let set = 0, already = 0, orphan = 0
  const touched = new Set()
  for (const r of recs) {
    const hits = byQid.get(r.qid)
    if (!hits || !hits.length) { orphan++; continue }
    for (const { fname, p } of hits) {
      const had = !!p.attrs.summary && !!p.attrs.article
      p.attrs.summary = r.summary            // {text,title,url,lang,license,licenseUrl}
      if (r.summaryEn && r.summaryEn.lang !== r.summary.lang) p.attrs.summaryEn = r.summaryEn
      // Full sectioned article, both languages. Kept in canonical (the system of
      // record) but deliberately NOT carried into the map payload — see
      // sync_wats.py, which splits it into a separate file so /api/wats.json
      // stays small enough to load a 1,300-point map quickly.
      if (r.article) p.attrs.article = r.article
      if (had) { already++; continue }
      touched.add(fname); set++
    }
  }
  for (const f of touched) save(join(CANON, f), canonFiles[f])
  console.log(`summary ${src}: ${set} extract(s) attached, ${already} already-present, ${orphan} with no pin`)
} else if (mode === 'media') {
  // Attach freely-licensed imagery to canonical points. Joined on the Wikidata
  // QID carried in sources[] — an exact key, so no proximity/name guessing.
  // Appends only; never removes a photo, never overwrites a field-supplied one,
  // and dedupes on the image URL so re-running is a no-op. An image whose QID
  // matches no pin goes to the review queue rather than inventing a pin.
  //   node merge.mjs media commons-images
  const src = arg
  const recs = loadJson(join(ROOT, 'data/crawled', `${src}.json`), null) ?? bail(`no data/crawled/${src}.json`)
  const prefix = `media ${src}:`
  for (let i = conflicts.length - 1; i >= 0; i--)
    if (typeof conflicts[i].reason === 'string' && conflicts[i].reason.startsWith(prefix)) conflicts.splice(i, 1)

  const canonFiles = allCanonical()
  const byQid = new Map()
  for (const [fname, pts] of Object.entries(canonFiles))
    for (const p of pts)
      for (const s of p.sources || [])
        if (s.type === 'wikidata' && s.ref) {
          if (!byQid.has(s.ref)) byQid.set(s.ref, [])
          byQid.get(s.ref).push({ fname, p })
        }

  let attached = 0, added = 0, already = 0, orphan = 0
  const touched = new Set()
  for (const r of recs) {
    const hits = byQid.get(r.qid)
    if (!hits || !hits.length) {
      addConflict(`media ${src}: ${r.qid} (${r.nameRoman || r.name}) has ${r.media.length} image(s) but no canonical pin — candidate for review`, r)
      orphan++
      continue
    }
    for (const { fname, p } of hits) {
      // Wikidata's one-line description (CC0) rides along on the same QID join.
      if (r.description && !p.attrs.description) { p.attrs.description = r.description; touched.add(fname) }
      if (r.descriptionTh && !p.attrs.descriptionTh) { p.attrs.descriptionTh = r.descriptionTh; touched.add(fname) }
      p.media = p.media || []
      const have = new Set(p.media.map((m) => m.url || m.path))
      let n = 0
      for (const m of r.media) if (!have.has(m.url)) { p.media.push(m); have.add(m.url); n++ }
      if (n) { added += n; attached++; touched.add(fname) } else already++
    }
  }
  for (const f of touched) save(join(CANON, f), canonFiles[f])
  writeFileSync(join(CANON, 'merge-conflicts.json'), JSON.stringify(conflicts, null, 2))
  console.log(`media ${src}: ${added} image(s) attached to ${attached} point(s), ${already} already-current, ${orphan} with no pin → merge-conflicts.json`)
} else if (mode === 'patch') {
  // Apply a field patch file exported from the viewer (or the sync worker).
  const patch = loadJson(arg, null) ?? bail(`cannot read ${arg}`)
  if (patch.type !== 'mueang-map-patch') bail(`${arg} is not a mueang-map patch file`)
  const applied = loadJson(join(CANON, 'applied-patches.json'), [])
  const appliedSet = new Set(applied.map((a) => a.hash))
  const fieldFile = join(CANON, 'field.json')
  const field = pointsOf(loadJson(fieldFile, []))
  const canonFiles = allCanonical()

  let adds = 0, corrections = 0, skipped = 0, conflicted = 0
  for (const entry of patch.entries ?? []) {
    const hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16)
    if (appliedSet.has(hash)) { skipped++; continue } // idempotency
    const p = entry.point
    const errs = validatePoint(p, lensIds)
    if (!inBbox(p)) errs.push('outside bbox')
    if (errs.length) { addConflict(`invalid patch point: ${errs.join('; ')}`, entry); conflicted++; continue }

    if (entry.kind === 'correction' && entry.targetId) {
      let found = false
      for (const [fname, pts] of Object.entries(canonFiles)) {
        const t = pts.find((x) => x.id === entry.targetId)
        if (!t) continue
        found = true
        // field correction overlays the target: attrs merge, coords/name from
        // the correction, confidence from the field claim, sources appended.
        Object.assign(t, {
          name: p.name, nameRoman: p.nameRoman ?? t.nameRoman,
          lat: p.lat, lng: p.lng, geoPrecision: p.geoPrecision,
          attrs: { ...t.attrs, ...p.attrs },
          media: [...(t.media || []), ...(p.media || [])],
          sources: [...(t.sources || []), ...(p.sources || [])],
          confidence: p.confidence,
          notes: [t.notes, p.notes].filter(Boolean).join(' | '),
          updatedAt: p.updatedAt,
        })
        save(join(CANON, fname), pts)
        corrections++
        break
      }
      if (!found) { addConflict(`correction target ${entry.targetId} not in canonical`, entry); conflicted++; continue }
    } else {
      if (Object.values(canonFiles).some((pts) => pts.some((x) => x.id === p.id))) {
        addConflict(`add collides with existing id ${p.id} (review as possible duplicate)`, entry)
        conflicted++
        continue
      }
      field.push(p)
      adds++
    }
    applied.push({ hash, file: basename(arg), date: new Date().toISOString().slice(0, 10) })
    appliedSet.add(hash)
  }
  save(fieldFile, field)
  writeFileSync(join(CANON, 'applied-patches.json'), JSON.stringify(applied, null, 2))
  writeFileSync(join(CANON, 'merge-conflicts.json'), JSON.stringify(conflicts, null, 2))
  console.log(`patch ${basename(arg)}: +${adds} adds, ${corrections} corrections, ${skipped} already-applied (skipped), ${conflicted} → merge-conflicts.json`)
} else {
  console.log('usage: node merge.mjs crawled <source> | node merge.mjs enrich <source> |  node merge.mjs promote <source> [--min-dist=75] | node merge.mjs media <source> | node merge.mjs patch <file>')
}

function bail(msg) { console.error(`✗ ${msg}`); process.exit(1) }
