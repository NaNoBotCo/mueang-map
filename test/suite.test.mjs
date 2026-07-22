// Test suite per CLAUDE.md verification section. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, cpSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validatePoint, inBbox, findNearDuplicates } from '../lib/schema.mjs'
import { visiblePoints, toGeoJSON, confBadge, validFeature, CONF_LABEL } from '../viewer/logic.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LENSES = JSON.parse(readFileSync(join(ROOT, 'data/lenses.json'), 'utf8')).lenses.map((l) => l.id)

const goodPoint = (over = {}) => ({
  id: 'wat-test',
  lens: ['wat'],
  name: 'วัดทดสอบ',
  nameRoman: 'Wat Test',
  lat: 18.79, lng: 98.98,
  geoPrecision: 'exact',
  address: null,
  attrs: {},
  media: [],
  sources: [{ type: 'osm', ref: 'node/1', fetched: '2026-07-18' }],
  confidence: 'crawled',
  notes: '',
  updatedAt: '2026-07-18',
  ...over,
})

// ---- schema --------------------------------------------------------------
test('schema accepts a valid point', () => {
  assert.deepEqual(validatePoint(goodPoint(), LENSES), [])
})

test('schema rejects malformed features', () => {
  assert.ok(validatePoint({}, LENSES).length > 0)
  assert.ok(validatePoint(goodPoint({ id: 'Bad Slug!' }), LENSES).length > 0)
  assert.ok(validatePoint(goodPoint({ lens: [] }), LENSES).length > 0)
  assert.ok(validatePoint(goodPoint({ lens: ['not-a-lens'] }), LENSES).length > 0)
  assert.ok(validatePoint(goodPoint({ lat: '18.79' }), LENSES).length > 0)
  assert.ok(validatePoint(goodPoint({ confidence: 'gospel' }), LENSES).length > 0)
  assert.ok(validatePoint(goodPoint({ sources: [] }), LENSES).length > 0)
  assert.ok(validatePoint(goodPoint({ geoPrecision: 'roughly' }), LENSES).length > 0)
})

test('bbox gate + near-duplicate flagging', () => {
  assert.equal(inBbox(goodPoint()), true)
  assert.equal(inBbox(goodPoint({ lat: 13.75, lng: 100.5 })), false) // Bangkok
  const dups = findNearDuplicates([
    goodPoint({ id: 'a' }),
    goodPoint({ id: 'b', lat: 18.79001 }), // ~1 m away
    goodPoint({ id: 'c', lat: 18.8 }), // ~1.1 km away
  ])
  assert.equal(dups.length, 1)
  assert.deepEqual([dups[0].a, dups[0].b].sort(), ['a', 'b'])
})

// ---- lens filter correctness ---------------------------------------------
const filterState = (over = {}) => ({
  activeLenses: new Set(LENSES),
  activeConf: new Set(Object.keys(CONF_LABEL)),
  facetFilters: {},
  ...over,
})

test('lens filter correctness', () => {
  const pts = [
    goodPoint({ id: 'w1' }),
    goodPoint({ id: 'l1', lens: ['library'], attrs: { type: 'public' } }),
    goodPoint({ id: 'l2', lens: ['library'], attrs: { type: 'cafe-library' }, confidence: 'verified' }),
    goodPoint({ id: 'multi', lens: ['wat', 'view'] }),
  ]
  // all on
  assert.equal(visiblePoints(pts, filterState()).length, 4)
  // only libraries
  const libOnly = visiblePoints(pts, filterState({ activeLenses: new Set(['library']) }))
  assert.deepEqual(libOnly.map((p) => p.id).sort(), ['l1', 'l2'])
  // multi-lens point stays visible if ANY of its lenses is active
  const viewOnly = visiblePoints(pts, filterState({ activeLenses: new Set(['view']) }))
  assert.deepEqual(viewOnly.map((p) => p.id), ['multi'])
  // confidence filter
  const verifiedOnly = visiblePoints(pts, filterState({ activeConf: new Set(['verified']) }))
  assert.deepEqual(verifiedOnly.map((p) => p.id), ['l2'])
  // facet filter
  const cafe = visiblePoints(pts, filterState({
    activeLenses: new Set(['library']),
    facetFilters: { library: { type: 'cafe-library' } },
  }))
  assert.deepEqual(cafe.map((p) => p.id), ['l2'])
})

test('client feature re-check', () => {
  assert.equal(validFeature(goodPoint()), true)
  assert.equal(validFeature({ id: 'x' }), false)
  assert.equal(validFeature(goodPoint({ confidence: 'nope' })), false)
})

// ---- confidence badges (jsdom render, all four states) -------------------
test('confidence badges render for all states', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<div id="host"></div>')
  const host = dom.window.document.getElementById('host')
  for (const conf of ['verified', 'reported', 'crawled', 'heuristic']) {
    const b = confBadge(conf)
    assert.ok(b, `badge for ${conf}`)
    host.innerHTML = `<span class="${b.cls}">${b.text}</span>`
    const el = host.querySelector(`.conf-${conf}`)
    assert.ok(el, `rendered .conf-${conf}`)
    assert.ok(el.textContent.length > 5)
  }
  assert.equal(confBadge('bogus'), null)
})

// ---- merge + build in a fixture tree -------------------------------------
function makeFixture() {
  const fix = mkdtempSync(join(tmpdir(), 'mm-fix-'))
  mkdirSync(join(fix, 'data/canonical'), { recursive: true })
  mkdirSync(join(fix, 'data/crawled'), { recursive: true })
  cpSync(join(ROOT, 'data/lenses.json'), join(fix, 'data/lenses.json'))
  for (const link of ['viewer', 'vendor', 'lib'])
    symlinkSync(join(ROOT, link), join(fix, link))
  return fix
}
const run = (script, args, fix) =>
  execFileSync('node', [join(ROOT, script), ...args], {
    env: { ...process.env, MM_ROOT: fix }, encoding: 'utf8' })

test('patch merge is idempotent and never silently drops a field point', () => {
  const fix = makeFixture()
  const patch = {
    type: 'mueang-map-patch', version: 1, exported: '2026-07-18',
    entries: [
      { kind: 'add', targetId: null, point: goodPoint({ id: 'sh-1', lens: ['spirit-house'], confidence: 'verified', sources: [{ type: 'field', by: 'nan', date: '2026-07-18' }] }) },
      { kind: 'add', targetId: null, point: goodPoint({ id: 'bad-1', lat: 99, confidence: 'verified', sources: [{ type: 'field', by: 'nan', date: '2026-07-18' }] }) },
    ],
  }
  const pfile = join(fix, 'patch-test.json')
  writeFileSync(pfile, JSON.stringify(patch))
  const out1 = run('merge.mjs', ['patch', pfile], fix)
  assert.match(out1, /\+1 adds/)
  assert.match(out1, /1 → merge-conflicts/)
  const field1 = JSON.parse(readFileSync(join(fix, 'data/canonical/field.json'), 'utf8'))
  assert.equal(field1.length, 1)
  // the invalid field point is NOT silently dropped — it is in conflicts
  const conflicts = JSON.parse(readFileSync(join(fix, 'data/canonical/merge-conflicts.json'), 'utf8'))
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].entry.point.id, 'bad-1')
  // idempotent: second run applies nothing, canonical unchanged
  const out2 = run('merge.mjs', ['patch', pfile], fix)
  assert.match(out2, /\+0 adds/)
  assert.match(out2, /1 already-applied/)
  const field2 = JSON.parse(readFileSync(join(fix, 'data/canonical/field.json'), 'utf8'))
  assert.deepEqual(field2, field1)
})

test('crawled fold-in protects field-touched points', () => {
  const fix = makeFixture()
  // canonical field-corrected point
  writeFileSync(join(fix, 'data/canonical/osm.json'), JSON.stringify([
    goodPoint({ id: 'wat-x', name: 'ชื่อจากภาคสนาม', confidence: 'verified', sources: [{ type: 'osm', ref: 'node/9', fetched: '2026-07-01' }, { type: 'field', by: 'nan', date: '2026-07-10' }] }),
  ]))
  // crawl refresh wants to overwrite it + add a new point
  writeFileSync(join(fix, 'data/crawled/osm.json'), JSON.stringify([
    goodPoint({ id: 'wat-x', name: 'ชื่อจาก OSM' }),
    goodPoint({ id: 'wat-y', lat: 18.8 }),
  ]))
  const out = run('merge.mjs', ['crawled', 'osm'], fix)
  assert.match(out, /\+1 new/)
  assert.match(out, /1 field-protected/)
  const canon = JSON.parse(readFileSync(join(fix, 'data/canonical/osm.json'), 'utf8'))
  const watX = canon.find((p) => p.id === 'wat-x')
  assert.equal(watX.name, 'ชื่อจากภาคสนาม') // field truth beat crawled truth
  assert.ok(canon.find((p) => p.id === 'wat-y'))
})

test('enrich fills only empty attrs, protects existing facts, and never invents pins', () => {
  const fix = makeFixture()
  // canonical OSM wat: has a name + status, but no founding date / heritage.
  writeFileSync(join(fix, 'data/canonical/osm.json'), JSON.stringify([
    goodPoint({
      id: 'wat-chedi-luang', name: 'วัดเจดีย์หลวง', nameRoman: 'Wat Chedi Luang',
      lat: 18.7869, lng: 98.9865, attrs: { status: 'active', founded: '1391' },
    }),
  ]))
  // wikidata enrichment: a name+coord match with heritage + a DIFFERENT founded
  // (must NOT overwrite the existing one), and a second item that matches
  // nothing (a temple not in OSM → candidate, never auto-added).
  writeFileSync(join(fix, 'data/crawled/wikidata.json'), JSON.stringify([
    goodPoint({
      id: 'wd-chedi-luang', name: 'วัดเจดีย์หลวง', nameRoman: 'Wat Chedi Luang',
      lat: 18.78695, lng: 98.98655, geoPrecision: 'block',
      attrs: { status: 'active', founded: '1400', heritage: 'registered Thai historic site' },
      sources: [{ type: 'wikidata', ref: 'Q1454288', fetched: '2026-07-19' }],
    }),
    goodPoint({
      id: 'wd-orphan', name: 'วัดไม่มีใน OSM', nameRoman: 'Wat Not In Osm',
      lat: 18.72, lng: 98.95,
      attrs: { heritage: 'registered Thai historic site' },
      sources: [{ type: 'wikidata', ref: 'Q999', fetched: '2026-07-19' }],
    }),
  ]))
  const out = run('merge.mjs', ['enrich', 'wikidata'], fix)
  assert.match(out, /1 points enriched/)
  assert.match(out, /1 unmatched/)
  const canon = JSON.parse(readFileSync(join(fix, 'data/canonical/osm.json'), 'utf8'))
  assert.equal(canon.length, 1, 'orphan wikidata item was NOT added as a pin')
  const w = canon.find((p) => p.id === 'wat-chedi-luang')
  assert.equal(w.attrs.heritage, 'registered Thai historic site', 'empty attr filled')
  assert.equal(w.attrs.founded, '1391', 'existing fact NOT overwritten')
  assert.ok(w.sources.some((s) => s.type === 'wikidata' && s.ref === 'Q1454288'), 'source appended for traceability')
  // the unmatched temple is recorded for review, not dropped
  const conflicts = JSON.parse(readFileSync(join(fix, 'data/canonical/merge-conflicts.json'), 'utf8'))
  assert.ok(conflicts.some((c) => c.entry?.id === 'wd-orphan'))
  // idempotent: a second run changes nothing
  const out2 = run('merge.mjs', ['enrich', 'wikidata'], fix)
  assert.match(out2, /0 points enriched/)
  assert.match(out2, /1 already-current/)
  const canon2 = JSON.parse(readFileSync(join(fix, 'data/canonical/osm.json'), 'utf8'))
  assert.deepEqual(canon2, canon)
  // the review queue is regenerable, not append-only: still exactly one
  // candidate for wd-orphan after the second run (no duplicate accumulation)
  const conflicts2 = JSON.parse(readFileSync(join(fix, 'data/canonical/merge-conflicts.json'), 'utf8'))
  assert.equal(conflicts2.filter((c) => c.entry?.id === 'wd-orphan').length, 1)
})

test('promote turns reviewed candidates into pins but never duplicates an existing temple', () => {
  const fix = makeFixture()
  // one canonical OSM wat.
  writeFileSync(join(fix, 'data/canonical/osm.json'), JSON.stringify([
    goodPoint({ id: 'wat-a', name: 'วัดเอ', nameRoman: 'Wat A', lat: 18.7900, lng: 98.9800 }),
  ]))
  // two wikidata temples that match nothing by name: one far (a real gap OSM
  // missed), one ~50 m from Wat A (probably the same temple under another name).
  writeFileSync(join(fix, 'data/crawled/wikidata.json'), JSON.stringify([
    goodPoint({ id: 'wat-far', name: 'วัดไกล', nameRoman: 'Wat Far', lat: 18.7920, lng: 98.9800,
      attrs: { heritage: 'registered Thai historic site' }, sources: [{ type: 'wikidata', ref: 'Q1', fetched: '2026-07-19' }] }),
    goodPoint({ id: 'wat-near', name: 'วัดใกล้', nameRoman: 'Wat Near', lat: 18.79045, lng: 98.9800,
      sources: [{ type: 'wikidata', ref: 'Q2', fetched: '2026-07-19' }] }),
  ]))
  run('merge.mjs', ['enrich', 'wikidata'], fix)     // both land in the review queue
  const out = run('merge.mjs', ['promote', 'wikidata'], fix)
  assert.match(out, /\+1 new pins/)
  assert.match(out, /1 kept as likely-dup/)
  const promoted = JSON.parse(readFileSync(join(fix, 'data/canonical/wikidata.json'), 'utf8'))
  assert.deepEqual(promoted.map((p) => p.id), ['wat-far'], 'only the genuinely-new temple became a pin')
  const conflicts = JSON.parse(readFileSync(join(fix, 'data/canonical/merge-conflicts.json'), 'utf8'))
  assert.ok(conflicts.some((c) => c.entry?.id === 'wat-near' && /likely.dup/i.test(c.reason)), 'the near temple stays for manual review')
  assert.ok(!conflicts.some((c) => c.entry?.id === 'wat-far'), 'promoted candidate left the queue')
  // idempotent: re-running promotes nothing new (id already present).
  const out2 = run('merge.mjs', ['promote', 'wikidata'], fix)
  assert.match(out2, /\+0 new pins/)
  const promoted2 = JSON.parse(readFileSync(join(fix, 'data/canonical/wikidata.json'), 'utf8'))
  assert.deepEqual(promoted2, promoted)
})

test('enrich matches a formal name that contains the common name (Doi Suthep case)', () => {
  const fix = makeFixture()
  // OSM common name vs Wikidata formal name, 60 m apart, no exact match.
  writeFileSync(join(fix, 'data/canonical/osm.json'), JSON.stringify([
    goodPoint({ id: 'wat-doi-suthep', name: 'วัดพระธาตุดอยสุเทพ', nameRoman: 'Wat Phra That Doi Suthep',
      lat: 18.8049, lng: 98.9221 }),
  ]))
  writeFileSync(join(fix, 'data/crawled/wikidata.json'), JSON.stringify([
    goodPoint({ id: 'wd-doi-suthep', name: 'วัดพระธาตุดอยสุเทพราชวรวิหาร', nameRoman: 'Wat Phra That Doi Suthep Racha Worawihan',
      lat: 18.80545, lng: 98.9221, attrs: { heritage: 'registered Thai historic site' },
      sources: [{ type: 'wikidata', ref: 'Q123', fetched: '2026-07-19' }] }),
  ]))
  const out = run('merge.mjs', ['enrich', 'wikidata'], fix)
  assert.match(out, /1 points enriched/, 'formal-name containment counts as a name match')
  const w = JSON.parse(readFileSync(join(fix, 'data/canonical/osm.json'), 'utf8'))[0]
  assert.equal(w.attrs.heritage, 'registered Thai historic site')
})

test('build produces valid GeoJSON and excludes invalid features into the report', () => {
  const fix = makeFixture()
  writeFileSync(join(fix, 'data/canonical/mix.json'), JSON.stringify([
    goodPoint({ id: 'ok-1' }),
    goodPoint({ id: 'off-map', lat: 51.5, lng: -0.1 }), // London → excluded
  ]))
  run('build.mjs', [], fix)
  const gj = JSON.parse(readFileSync(join(fix, 'dist/data/wat.geojson'), 'utf8'))
  assert.equal(gj.type, 'FeatureCollection')
  assert.equal(gj.features.length, 1)
  const [lng, lat] = gj.features[0].geometry.coordinates
  assert.ok(lng > 98 && lng < 100 && lat > 18 && lat < 19, 'coordinates are [lng, lat]')
  const report = JSON.parse(readFileSync(join(fix, 'dist/build-report.json'), 'utf8'))
  assert.equal(report.invalid.length, 1)
  assert.equal(report.invalid[0].id, 'off-map')
  // the built page embeds the data and the exclusion record
  const html = readFileSync(join(fix, 'map.html'), 'utf8')
  assert.ok(html.includes('"ok-1"'))
  assert.ok(html.includes('buildInvalid'))
  assert.ok(existsSync(join(fix, 'dist/data/spirit-house.geojson')))
})
