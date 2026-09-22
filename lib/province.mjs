// province.mjs — which changwat is a point actually in?
//
// The harvesters bound their queries two different ways, and only one of them
// could ever answer this question:
//
//   osm-overpass.mjs  bounds by an OSM admin_level=4 area (ISO3166-2). A result
//                     is inside the province by construction.
//   wikidata.mjs      bounds by centre + radius, because Wikidata's P131 admin
//                     chain is too sparse for northern-Thai temples to bound by.
//                     A radius does not know where a border is.
//
// The second one then stamped every result with its region's own label, and the
// radii are deliberately generous ("enough to blanket each changwat"). Lampang's
// 90 km reaches ~70 km into Phrae — a province that was never in the region list
// at all — so 25 Phrae temples were published as Lampang, Wat Sung Men among
// them: the single largest manuscript library in the collection. Phrae showed
// ZERO temples while the manuscript catalogue held 2,133 manuscripts from it.
// The same overshoot mislabelled 159 records in total, across every region pair
// (Chiang Rai↔Phayao, Lamphun↔Chiang Mai, Mae Hong Son↔Chiang Mai, …).
//
// So: ask the polygon. Boundaries are cached by harvest/fetch-province-boundaries.py.
// Verified against the 1,235 ISO-area-bounded OSM points — 1,234 agree, and the
// one that does not is a wrong addr:province tag in OSM which this correctly
// overrides (wat-phrathat-doi-kham, tagged Lamphun, is in Phayao).
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOUNDS = join(ROOT, 'data/boundaries/provinces.geojson')

let polys = null

function load() {
  if (polys) return polys
  if (!existsSync(BOUNDS)) {
    console.warn(`  ! no province boundaries at ${BOUNDS} — run:  python3 harvest/fetch-province-boundaries.py`)
    return (polys = [])
  }
  polys = JSON.parse(readFileSync(BOUNDS, 'utf8')).features.map((f) => {
    const rings = f.geometry.coordinates.map((r) => r[0])
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const r of rings) for (const [x, y] of r) {
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
    }
    return { name: f.properties.name_en, bbox: [x0, y0, x1, y1], rings }
  })
  return polys
}

// standard ray-casting; the bbox test first keeps this cheap over ~240k vertices
const inRing = (x, y, ring) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Province containing (lat,lng), or null when the point is in none of them
 *  — which is a real answer: it means outside the eleven cached changwats
 *  (across a national border, or bad coordinates), not "unknown". */
export function provinceAt(lat, lng) {
  if (lat == null || lng == null) return null
  for (const { name, bbox, rings } of load()) {
    if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue
    if (rings.some((r) => inRing(lng, lat, r))) return name
  }
  return null
}
