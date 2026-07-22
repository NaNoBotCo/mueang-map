// Canonical point schema — the one schema across all lenses and sources.
// Shared by build.mjs, merge.mjs, harvesters, the sync worker, and tests.

export const CONFIDENCE = ['verified', 'reported', 'crawled', 'heuristic']
export const GEO_PRECISION = ['exact', 'block', 'area']

// Not every *.json in data/canonical/ is a point collection. These are
// control/source files that live alongside canonical point files but must
// never be validated or built as points. Shared by build.mjs and merge.mjs
// so the two agree on what "a canonical point file" is.
//   - merge-conflicts.json : review queue written by merge.mjs
//   - applied-patches.json : idempotency ledger for field patches
//   - auspicious-rules.json : the single source the structural layer is
//                             generated FROM (its generated output,
//                             auspicious-structural.json, IS a point file)
const CONTROL_FILES = new Set([
  'merge-conflicts.json',
  'applied-patches.json',
  'auspicious-rules.json',
])

/** True if a filename in data/canonical/ holds canonical POINTS (vs a
 *  control/source file). Excludes anything merge writes (`merge-*`) too. */
export function isPointFile(filename) {
  return (
    filename.endsWith('.json') &&
    !filename.startsWith('merge-') &&
    !CONTROL_FILES.has(filename)
  )
}

// Coordinate sanity gate for the Lanna north — Chiang Mai, Chiang Rai, Lamphun,
// Lampang, Nan, Phayao, Mae Hong Son, up to the Golden Triangle. Anything
// outside this is a harvester or typo bug, not a real point.
//
// This was a tight Chiang-Mai-only box (18.3–19.4 N, 98.5–99.5 E). That was
// correct while the atlas was one city, but once the crawl widened to the
// northern provinces the gate started REJECTING real temples as invalid —
// silently, into the conflict queue. A sanity gate that quietly drops good data
// is worse than no gate, so it now matches the actual coverage area.
// South edge is 17.1, not 17.8: Lampang reaches ~17.15 at Thoen and Lamphun
// ~17.5 at Li. The tighter figure rejected 36 real temples as 'invalid'.
export const LANNA_BBOX = { south: 17.1, north: 20.6, west: 97.2, east: 101.4 }
// Kept as an alias: older call sites import CM_BBOX by name.
export const CM_BBOX = LANNA_BBOX

// Two points closer than this across different sources are flagged for
// merge review — never auto-merged.
export const DUP_RADIUS_M = 25

/** Validate one point against the canonical schema.
 *  Returns [] when valid, else a list of human-readable problems. */
export function validatePoint(p, knownLenses) {
  const errs = []
  const bad = (m) => errs.push(m)
  if (!p || typeof p !== 'object') return ['not an object']

  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(p.id))
    bad(`id must be a stable slug, got ${JSON.stringify(p.id)}`)
  if (!Array.isArray(p.lens) || p.lens.length === 0)
    bad('lens must be a non-empty array')
  else if (knownLenses)
    for (const l of p.lens)
      if (!knownLenses.includes(l)) bad(`unknown lens "${l}"`)
  if (typeof p.name !== 'string' || !p.name.trim()) bad('name required')
  if (p.nameRoman != null && typeof p.nameRoman !== 'string')
    bad('nameRoman must be string or null')
  if (typeof p.lat !== 'number' || typeof p.lng !== 'number')
    bad('lat/lng must be numbers')
  if (!GEO_PRECISION.includes(p.geoPrecision))
    bad(`geoPrecision must be one of ${GEO_PRECISION.join('|')}`)
  if (p.address != null && typeof p.address !== 'string')
    bad('address must be string or null')
  if (p.attrs == null || typeof p.attrs !== 'object' || Array.isArray(p.attrs))
    bad('attrs must be an object')
  if (!Array.isArray(p.media)) bad('media must be an array')
  if (!Array.isArray(p.sources) || p.sources.length === 0)
    bad('sources must be a non-empty array — every fact traceable')
  else
    for (const s of p.sources)
      if (typeof s.type !== 'string') bad('each source needs a type')
  if (!CONFIDENCE.includes(p.confidence))
    bad(`confidence must be one of ${CONFIDENCE.join('|')}`)
  if (p.notes != null && typeof p.notes !== 'string') bad('notes must be a string')
  if (typeof p.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(p.updatedAt))
    bad('updatedAt must be YYYY-MM-DD')
  return errs
}

export function inBbox(p, bbox = CM_BBOX) {
  return (
    p.lat >= bbox.south && p.lat <= bbox.north &&
    p.lng >= bbox.west && p.lng <= bbox.east
  )
}

/** Haversine distance in meters. */
export function distanceM(a, b) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** Cross-source near-duplicates (< DUP_RADIUS_M apart, different ids).
 *  Returned as pairs for human review — never auto-merged. */
export function findNearDuplicates(points, radius = DUP_RADIUS_M) {
  const pairs = []
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i], b = points[j]
      if (a.id === b.id) continue
      if (Math.abs(a.lat - b.lat) > 0.001 || Math.abs(a.lng - b.lng) > 0.001)
        continue // cheap pre-filter (~110 m); haversine only near-misses
      const d = distanceM(a, b)
      if (d < radius) pairs.push({ a: a.id, b: b.id, meters: Math.round(d) })
    }
  return pairs
}

/** RTGS-ish slugifier for ids from roman names. */
export function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}
