/* Mueang Map viewer. Framework-free; everything inlined by build.mjs.
   Lenses come from the registry JSON — adding a lens never touches this file. */
'use strict'

const $ = (s) => document.querySelector(s)
const readJson = (id) => JSON.parse(document.getElementById(id).textContent)

const REGISTRY = readJson('mm-lenses')
const LENSES = REGISTRY.lenses
const META = readJson('mm-meta')
const RAW = readJson('mm-data')

// CONF_LABEL / CONF_ALPHA / validFeature / visiblePoints / toGeoJSON /
// confBadge come from viewer/logic.mjs, inlined just above this script by
// build.mjs (and unit-tested as ESM in test/).

// ---- state ---------------------------------------------------------------
const state = {
  activeLenses: new Set(LENSES.map((l) => l.id)),
  activeConf: new Set(Object.keys(CONF_LABEL)),
  facetFilters: {}, // lensId -> { attrKey -> value }
  invalid: [], // client-side re-check failures, for the debug loop
  queue: loadQueue(),
  lastFocus: null,
}

// Light client re-check (build.mjs is the real gate) — bad features are
// excluded and *reported*, never silently dropped.
const POINTS = []
for (const p of RAW.points) {
  if (validFeature(p)) POINTS.push(p)
  else state.invalid.push({ id: p && p.id, reason: 'client schema re-check failed' })
}
if (Array.isArray(RAW.buildInvalid)) state.invalid.push(...RAW.buildInvalid)

// ---- map -----------------------------------------------------------------
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#1c1f24' } },
      { id: 'osm', type: 'raster', source: 'osm' },
    ],
  },
  center: [98.987, 18.788], // old city
  zoom: 13.2,
  attributionControl: false,
})
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), 'bottom-right')

// ---- marker icons: distinct SHAPE per lens (color never sole signal) -----
function drawShape(ctx, shape, cx, cy, r) {
  ctx.beginPath()
  switch (shape) {
    case 'square': ctx.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7); break
    case 'triangle':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.95, cy + r * 0.75)
      ctx.lineTo(cx - r * 0.95, cy + r * 0.75); ctx.closePath(); break
    case 'diamond':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r)
      ctx.lineTo(cx - r, cy); ctx.closePath(); break
    case 'star':
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? r * 0.45 : r
        const a = (Math.PI / 5) * i - Math.PI / 2
        ctx[i ? 'lineTo' : 'moveTo'](cx + rr * Math.cos(a), cy + rr * Math.sin(a))
      }
      ctx.closePath(); break
    case 'hex':
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6
        ctx[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a))
      }
      ctx.closePath(); break
    case 'pin':
      ctx.arc(cx, cy - r * 0.25, r * 0.72, Math.PI * 0.8, Math.PI * 2.2)
      ctx.lineTo(cx, cy + r); ctx.closePath(); break
    case 'cross':
      const w = r * 0.38
      ctx.moveTo(cx - w, cy - r); ctx.lineTo(cx + w, cy - r); ctx.lineTo(cx + w, cy - w)
      ctx.lineTo(cx + r, cy - w); ctx.lineTo(cx + r, cy + w); ctx.lineTo(cx + w, cy + w)
      ctx.lineTo(cx + w, cy + r); ctx.lineTo(cx - w, cy + r); ctx.lineTo(cx - w, cy + w)
      ctx.lineTo(cx - r, cy + w); ctx.lineTo(cx - r, cy - w); ctx.lineTo(cx - w, cy - w)
      ctx.closePath(); break
    default: ctx.arc(cx, cy, r, 0, Math.PI * 2)
  }
}

function makeIcon(lens, conf) {
  const size = 34, c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  ctx.globalAlpha = CONF_ALPHA[conf]
  ctx.fillStyle = lens.color
  ctx.strokeStyle = '#14161a'
  ctx.lineWidth = 2.5
  drawShape(ctx, lens.shape, size / 2, size / 2, size / 2 - 4)
  ctx.fill(); ctx.stroke()
  if (conf === 'heuristic') { // extra non-color cue: hollow center
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath(); ctx.arc(size / 2, size / 2, 4, 0, Math.PI * 2); ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
  return ctx.getImageData(0, 0, size, size)
}

// ---- rendering -----------------------------------------------------------
function refresh() {
  const pts = visiblePoints(POINTS, state)
  map.getSource('points')?.setData(toGeoJSON(pts, state.activeLenses))
  const n = pts.length
  $('#count').textContent = `${n} จุด · ${n} points`
  renderDebug()
}

// Layer setup is idempotent and NOT gated on map.loaded()/isStyleLoaded():
// a single failed OSM tile (flaky 3G) keeps those false forever. We attempt
// on styledata/load/idle + a short polling fallback; addLayer throws until
// the style is parsed, so the try/catch below is the actual readiness gate.
let layersReady = false
function ensureLayers() {
  if (layersReady) return
  try { setupLayers() } catch { /* style not parsed yet — retried on next event */ }
}
function setupLayers() {
  for (const lens of LENSES)
    for (const conf of Object.keys(CONF_LABEL))
      if (!map.hasImage(`${lens.id}--${conf}`))
        map.addImage(`${lens.id}--${conf}`, makeIcon(lens, conf))
  if (!map.getSource('points'))
    map.addSource('points', { type: 'geojson', data: toGeoJSON([], state.activeLenses) })
  if (!map.getLayer('points')) map.addLayer({
    id: 'points',
    type: 'symbol',
    source: 'points',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-allow-overlap': true,
      'text-field': ['step', ['zoom'], '', 15, ['get', 'label']],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.4],
      'text-optional': true,
    },
    paint: {
      'text-color': '#e8e6e1',
      'text-halo-color': '#14161a',
      'text-halo-width': 1.4,
    },
  })
  map.on('click', 'points', (e) => {
    const id = e.features?.[0]?.properties?.id
    const p = POINTS.find((x) => x.id === id)
    if (p) openCard(p)
  })
  map.on('mouseenter', 'points', () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', 'points', () => (map.getCanvas().style.cursor = ''))
  layersReady = true
  refresh()
}
map.on('styledata', ensureLayers)
map.on('load', ensureLayers)
map.on('idle', ensureLayers)
const layerPoll = setInterval(() => {
  ensureLayers()
  if (layersReady) clearInterval(layerPoll)
}, 500)
new ResizeObserver(() => map.resize()).observe(document.getElementById('map'))
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { map.resize(); map.triggerRepaint() }
})

// Long-press on map → field capture at that location.
let pressTimer = null, pressStart = null
map.getCanvas().addEventListener('pointerdown', (e) => {
  pressStart = { x: e.clientX, y: e.clientY }
  pressTimer = setTimeout(() => {
    const ll = map.unproject([pressStart.x, pressStart.y - $('#map').getBoundingClientRect().top])
    openCapture({ lat: ll.lat, lng: ll.lng, geoPrecision: 'exact', from: 'long-press' })
  }, 650)
})
for (const ev of ['pointerup', 'pointercancel'])
  map.getCanvas().addEventListener(ev, () => clearTimeout(pressTimer))
map.getCanvas().addEventListener('pointermove', (e) => {
  if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 12)
    clearTimeout(pressTimer)
})

// ---- lens chips ----------------------------------------------------------
function renderChips() {
  const nav = $('#chips')
  nav.innerHTML = ''
  for (const lens of LENSES) {
    const b = document.createElement('button')
    b.className = 'chip'
    b.style.setProperty('--chipc', lens.color)
    b.setAttribute('aria-pressed', state.activeLenses.has(lens.id))
    const sw = document.createElement('canvas')
    sw.width = sw.height = 12; sw.className = 'dot'
    const ctx = sw.getContext('2d')
    ctx.fillStyle = lens.color
    drawShape(ctx, lens.shape, 6, 6, 5.5); ctx.fill()
    b.append(sw, `${lens.icon} `, lens.name.th, ` · ${lens.name.en}`)
    b.addEventListener('click', () => {
      state.activeLenses.has(lens.id)
        ? state.activeLenses.delete(lens.id)
        : state.activeLenses.add(lens.id)
      b.setAttribute('aria-pressed', state.activeLenses.has(lens.id))
      refresh()
    })
    nav.append(b)
  }
}
renderChips()

// ---- detail card ---------------------------------------------------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function sourceText(s) {
  if (s.type === 'osm') return `OpenStreetMap (${esc(s.ref || '')}, ${esc(s.fetched || '')})`
  if (s.type === 'field') return `field · ${esc(s.by || '?')} · ${esc(s.date || '')}`
  if (s.type === 'wikidata') return `Wikidata ${esc(s.ref || '')}`
  if (s.type === 'wikipedia') return `Wikipedia: ${esc(s.ref || '')}`
  if (s.type === 'basis') return `basis: ${esc(s.ref || '')}`
  return esc(JSON.stringify(s))
}

function openCard(p) {
  state.lastFocus = document.activeElement
  const card = $('#card')
  const lensBadges = p.lens
    .map((id) => {
      const l = LENSES.find((x) => x.id === id)
      return l ? `<span class="badge" style="border-color:${l.color}">${l.icon} ${esc(l.name.th)} · ${esc(l.name.en)}</span>` : ''
    })
    .join('')
  const conf = confBadge(p.confidence)
  const attrRows = Object.entries(p.attrs || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<div><dt>${esc(labelForAttr(p, k))}</dt><dd>${esc(v)}</dd></div>`)
    .join('')
  const media = (p.media || [])
    .map((m) => (m.base64 ? `<img src="${m.base64}" alt="">` :
      m.path ? `<img src="${esc(m.path)}" alt="">` : ''))
    .join('')
  card.innerHTML = `
    <button class="btn closebtn" data-close aria-label="Close">✕</button>
    <h2 id="card-name" lang="th">${esc(p.name)}</h2>
    ${p.nameRoman ? `<p class="roman">${esc(p.nameRoman)}</p>` : ''}
    <div class="badges">
      <span class="${conf.cls}">${conf.text}</span>
      ${lensBadges}
    </div>
    ${attrRows ? `<dl class="attrs">${attrRows}</dl>` : ''}
    ${p.notes ? `<p>${esc(p.notes)}</p>` : ''}
    ${media}
    <p class="sources">ที่มา · Sources: ${(p.sources || []).map(sourceText).join(' · ')}</p>
    <div class="row">
      <button class="btn" data-correct>แก้ไขจุดนี้ · Correct this point</button>
    </div>`
  card.hidden = false
  card.querySelector('[data-close]').addEventListener('click', closeOverlays)
  card.querySelector('[data-correct]').addEventListener('click', () => {
    closeOverlays()
    openCapture({ ...p, correctionOf: p.id, from: 'correction' })
  })
  card.querySelector('[data-close]').focus()
}

function labelForAttr(p, key) {
  for (const id of p.lens) {
    const l = LENSES.find((x) => x.id === id)
    if (l && l.attrs[key]) return key
  }
  return key
}

// ---- filter drawer + field tools ----------------------------------------
function openDrawer() {
  state.lastFocus = document.activeElement
  const d = $('#drawer')
  $('#btn-filter').setAttribute('aria-expanded', 'true')
  const confBoxes = Object.entries(CONF_LABEL)
    .map(([k, v]) => `<div class="checkline"><input type="checkbox" id="conf-${k}"
      ${state.activeConf.has(k) ? 'checked' : ''} data-conf="${k}">
      <label for="conf-${k}" style="margin:0">${v.th} · ${v.en}</label></div>`)
    .join('')
  const facetBlocks = LENSES.filter((l) => state.activeLenses.has(l.id))
    .map((l) => {
      const selects = (l.facets || [])
        .map((f) => {
          const spec = l.attrs[f]
          if (!spec || spec.type !== 'enum') return ''
          const cur = state.facetFilters[l.id]?.[f] || ''
          return `<label for="fx-${l.id}-${f}">${esc(f)}</label>
            <select id="fx-${l.id}-${f}" data-lens="${l.id}" data-attr="${f}">
              <option value="">— all —</option>
              ${spec.options.map((o) => `<option ${o === cur ? 'selected' : ''}>${o}</option>`).join('')}
            </select>`
        })
        .join('')
      return selects ? `<fieldset><legend>${l.icon} ${esc(l.name.en)}</legend>${selects}</fieldset>` : ''
    })
    .join('')
  d.innerHTML = `
    <button class="btn closebtn" data-close aria-label="Close filters">✕</button>
    <h2>Filters</h2>
    <fieldset><legend>ความเชื่อมั่น · Confidence</legend>${confBoxes}</fieldset>
    ${facetBlocks}
    <h2>Field kit</h2>
    <p class="sources">${state.queue.length} queued point(s) on this device.</p>
    <div class="row">
      <button class="btn primary" data-export ${state.queue.length ? '' : 'disabled'}>Export patch file</button>
      <button class="btn danger" data-clearq ${state.queue.length ? '' : 'disabled'}>Clear queue</button>
    </div>
    <label for="fk-token">Contributor token (optional)</label>
    <input type="text" id="fk-token" value="${esc(localStorage.getItem('mm-token') || '')}"
      autocomplete="off" placeholder="paste token from NaN">
    ${META.workerUrl ? `<div class="row"><button class="btn" data-sync>Send queue to server</button></div>
      <p class="sources">Goes to ${state.tokenValid === false ? 'suggestion queue' : 'the live store or suggestion queue'} depending on your token.</p>` : ''}
    <div class="row"><button class="btn" data-debug>Debug info</button></div>
    <p class="sources">Data ${esc(META.version)} · built ${esc(META.builtAt)}</p>`
  d.hidden = false
  d.querySelector('[data-close]').addEventListener('click', closeOverlays)
  d.querySelectorAll('input[data-conf]').forEach((el) =>
    el.addEventListener('change', () => {
      el.checked ? state.activeConf.add(el.dataset.conf) : state.activeConf.delete(el.dataset.conf)
      refresh()
    }))
  d.querySelectorAll('select[data-lens]').forEach((el) =>
    el.addEventListener('change', () => {
      const { lens, attr } = el.dataset
      state.facetFilters[lens] = state.facetFilters[lens] || {}
      state.facetFilters[lens][attr] = el.value
      refresh()
    }))
  d.querySelector('#fk-token').addEventListener('change', (e) =>
    localStorage.setItem('mm-token', e.target.value.trim()))
  d.querySelector('[data-export]')?.addEventListener('click', exportPatch)
  d.querySelector('[data-clearq]')?.addEventListener('click', () => {
    if (confirm('Clear the local capture queue? Export first if unsure.')) {
      state.queue = []; saveQueue(); openDrawer()
    }
  })
  d.querySelector('[data-sync]')?.addEventListener('click', syncQueue)
  d.querySelector('[data-debug]').addEventListener('click', () => {
    $('#debug').hidden = !$('#debug').hidden; renderDebug()
  })
  d.querySelector('[data-close]').focus()
}

// ---- field capture -------------------------------------------------------
function openCapture(seed = {}) {
  state.lastFocus = document.activeElement
  const d = $('#drawer')
  const isCorrection = !!seed.correctionOf
  const lensOpts = LENSES.map((l) =>
    `<option value="${l.id}" ${seed.lens?.[0] === l.id ? 'selected' : ''}>${l.icon} ${esc(l.name.th)} · ${esc(l.name.en)}</option>`).join('')
  d.innerHTML = `
    <button class="btn closebtn" data-close aria-label="Close form">✕</button>
    <h2>${isCorrection ? 'แก้ไขจุด · Correct point' : 'เพิ่มจุด · Add a point'}</h2>
    <p class="sources" id="cap-gps">${seed.from === 'long-press'
      ? `pinned: ${seed.lat.toFixed(5)}, ${seed.lng.toFixed(5)}`
      : 'Getting GPS…'}</p>
    <label for="cap-lens">Lens</label>
    <select id="cap-lens">${lensOpts}</select>
    <label for="cap-name">ชื่อ · Name (Thai preferred)</label>
    <input type="text" id="cap-name" lang="th" value="${esc(seed.name || '')}">
    <label for="cap-roman">Roman name (RTGS)</label>
    <input type="text" id="cap-roman" value="${esc(seed.nameRoman || '')}">
    <div id="cap-attrs"></div>
    <label for="cap-notes">Notes</label>
    <textarea id="cap-notes">${esc(seed.notes || '')}</textarea>
    <label for="cap-conf">How do you know?</label>
    <select id="cap-conf">
      <option value="verified">I am here / have been here (verified)</option>
      <option value="reported">Someone told me (reported)</option>
    </select>
    <label for="cap-photo">Photo (optional)</label>
    <input type="file" id="cap-photo" accept="image/*" capture="environment">
    <div class="row">
      <button class="btn primary" data-save>Save to queue</button>
      <button class="btn" data-close2>Cancel</button>
    </div>`
  d.hidden = false

  const pos = { lat: seed.lat, lng: seed.lng, acc: null }
  if (seed.from !== 'long-press' && !isCorrection && navigator.geolocation)
    navigator.geolocation.getCurrentPosition(
      (g) => {
        pos.lat = g.coords.latitude; pos.lng = g.coords.longitude
        pos.acc = Math.round(g.coords.accuracy)
        $('#cap-gps').textContent = `GPS: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (±${pos.acc} m)`
      },
      () => { $('#cap-gps').textContent = 'GPS unavailable — long-press the map to pin instead.' },
      { enableHighAccuracy: true, timeout: 8000 })

  const renderAttrFields = () => {
    const lens = LENSES.find((l) => l.id === $('#cap-lens').value)
    $('#cap-attrs').innerHTML = Object.entries(lens.attrs)
      .map(([k, spec]) => spec.type === 'enum'
        ? `<label for="cap-a-${k}">${esc(k)}</label>
           <select id="cap-a-${k}" data-attr="${k}"><option value="">—</option>
           ${spec.options.map((o) => `<option ${seed.attrs?.[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
        : `<label for="cap-a-${k}">${esc(k)}</label>
           <input type="text" id="cap-a-${k}" data-attr="${k}" value="${esc(seed.attrs?.[k] || '')}">`)
      .join('')
  }
  renderAttrFields()
  $('#cap-lens').addEventListener('change', renderAttrFields)

  let photo = null
  $('#cap-photo').addEventListener('change', async (e) => {
    const f = e.target.files[0]
    if (f) photo = await shrinkPhoto(f)
  })

  d.querySelectorAll('[data-close],[data-close2]').forEach((b) =>
    b.addEventListener('click', closeOverlays))
  d.querySelector('[data-save]').addEventListener('click', () => {
    const name = $('#cap-name').value.trim()
    if (!name) { $('#cap-name').focus(); return }
    if (pos.lat == null) { $('#cap-gps').textContent = 'Need a location — wait for GPS or long-press the map.'; return }
    const attrs = {}
    d.querySelectorAll('[data-attr]').forEach((el) => { if (el.value) attrs[el.dataset.attr] = el.value })
    const today = new Date().toISOString().slice(0, 10)
    state.queue.push({
      kind: isCorrection ? 'correction' : 'add',
      targetId: seed.correctionOf || null,
      point: {
        id: (isCorrection && seed.correctionOf) || proposeId($('#cap-roman').value || name),
        lens: [$('#cap-lens').value],
        name,
        nameRoman: $('#cap-roman').value.trim() || null,
        lat: pos.lat, lng: pos.lng,
        geoPrecision: pos.acc == null || pos.acc <= 30 ? 'exact' : 'block',
        address: null,
        attrs,
        media: photo ? [{ type: 'photo', base64: photo, capturedAt: today }] : [],
        sources: [{ type: 'field', by: localStorage.getItem('mm-name') || 'anon', date: today,
          gpsAccuracyM: pos.acc }],
        confidence: $('#cap-conf').value,
        notes: $('#cap-notes').value.trim(),
        updatedAt: today,
      },
    })
    saveQueue()
    closeOverlays()
    announce(`Saved to queue (${state.queue.length}). Export from Filters when ready.`)
  })
  d.querySelector('#cap-name').focus()
}

function proposeId(s) {
  const slug = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
  return (slug || 'point') + '-' + Math.random().toString(36).slice(2, 6)
}

async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url
    })
    const scale = Math.min(1, 1024 / Math.max(img.width, img.height))
    const c = document.createElement('canvas')
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    let q = 0.72, out = c.toDataURL('image/jpeg', q)
    while (out.length > 400_000 && q > 0.3) { q -= 0.12; out = c.toDataURL('image/jpeg', q) }
    return out
  } finally { URL.revokeObjectURL(url) }
}

// ---- queue / export / sync ----------------------------------------------
function loadQueue() {
  try { return JSON.parse(localStorage.getItem('mm-queue') || '[]') } catch { return [] }
}
function saveQueue() { localStorage.setItem('mm-queue', JSON.stringify(state.queue)) }

function exportPatch() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const blob = new Blob(
    [JSON.stringify({ type: 'mueang-map-patch', version: 1, exported: new Date().toISOString(),
      entries: state.queue }, null, 2)],
    { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `patch-${today}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  announce('Patch exported. Send the file to NaN or merge with merge.mjs.')
}

async function syncQueue() {
  if (!META.workerUrl) return
  const token = localStorage.getItem('mm-token') || ''
  let ok = 0, fail = 0
  for (const entry of [...state.queue]) {
    try {
      const path = token ? '/point' : '/suggest'
      const res = await fetch(META.workerUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(entry),
      })
      if (res.status === 403 && token) {
        // token invalid/revoked → fall back to the public suggestion path
        const r2 = await fetch(META.workerUrl + '/suggest', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(entry) })
        if (!r2.ok) throw new Error('suggest failed')
      } else if (!res.ok) throw new Error(`http ${res.status}`)
      state.queue.splice(state.queue.indexOf(entry), 1)
      ok++
    } catch { fail++ }
  }
  saveQueue()
  announce(`Sync: ${ok} sent${fail ? `, ${fail} failed (kept in queue)` : ''}.`)
  openDrawer()
}

// ---- overlays / a11y / debug --------------------------------------------
function closeOverlays() {
  $('#card').hidden = true
  $('#drawer').hidden = true
  $('#btn-filter').setAttribute('aria-expanded', 'false')
  if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus()
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (!$('#card').hidden || !$('#drawer').hidden)) closeOverlays()
})
function announce(msg) { $('#count').textContent = msg }

function renderDebug() {
  const el = $('#debug')
  if (el.hidden) return
  const counts = {}
  for (const l of LENSES) counts[l.id] = POINTS.filter((p) => p.lens.includes(l.id)).length
  el.textContent = JSON.stringify({
    meta: META,
    activeLenses: [...state.activeLenses],
    activeConf: [...state.activeConf],
    facetFilters: state.facetFilters,
    countsPerLens: counts,
    visibleNow: visiblePoints(POINTS, state).length,
    queueLength: state.queue.length,
    invalidFeatures: state.invalid,
  }, null, 2)
}
if (new URLSearchParams(location.search).get('debug') === '1') $('#debug').hidden = false

$('#btn-filter').addEventListener('click', () =>
  $('#drawer').hidden ? openDrawer() : closeOverlays())
$('#btn-here').addEventListener('click', () => openCapture({}))
