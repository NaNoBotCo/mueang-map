// viewer/logic.mjs — pure viewer logic, no DOM, no MapLibre.
// Imported as ESM by the test suite; inlined into map.html by build.mjs
// (which strips the `export ` keywords). Keep this file dependency-free.

export const CONF_LABEL = {
  verified: { en: 'Field-verified', th: 'ยืนยันภาคสนามแล้ว' },
  reported: { en: 'Reported, unvisited', th: 'มีผู้แจ้ง ยังไม่ได้ไปดู' },
  crawled: { en: 'Machine-collected, unvisited', th: 'เก็บอัตโนมัติ ยังไม่ได้ไปดู' },
  heuristic: { en: 'Computed / inferred', th: 'คำนวณ/อนุมาน' },
}
export const CONF_ALPHA = { verified: 1, reported: 0.88, crawled: 0.72, heuristic: 0.6 }

/** Minimal client-side feature check (build.mjs is the real gate). */
export function validFeature(p) {
  return !!(
    p && typeof p.id === 'string' && Array.isArray(p.lens) && p.lens.length &&
    typeof p.lat === 'number' && typeof p.lng === 'number' &&
    CONF_LABEL[p.confidence]
  )
}

/** Filter points by active lenses, confidence set, and per-lens facet values.
 *  state: { activeLenses:Set, activeConf:Set, facetFilters:{lens:{attr:value}} } */
export function visiblePoints(points, state) {
  return points.filter((p) => {
    if (!p.lens.some((l) => state.activeLenses.has(l))) return false
    if (!state.activeConf.has(p.confidence)) return false
    for (const l of p.lens) {
      const ff = state.facetFilters[l]
      if (!ff) continue
      for (const [k, v] of Object.entries(ff))
        if (v && String((p.attrs && p.attrs[k]) ?? '') !== v) return false
    }
    return true
  })
}

/** GeoJSON for the map source; icon key = first *active* lens + confidence. */
export function toGeoJSON(points, activeLenses) {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        icon: `${p.lens.find((l) => activeLenses.has(l)) || p.lens[0]}--${p.confidence}`,
        label: p.name,
      },
    })),
  }
}

/** Confidence badge parts — every confidence state must render a badge. */
export function confBadge(conf) {
  const label = CONF_LABEL[conf]
  if (!label) return null
  return { cls: `badge conf-${conf}`, text: `${label.th} · ${label.en}` }
}
