// Cloudflare Worker — the one sanctioned backend. KV, capability tokens.
// No accounts, no OAuth, no user table.
//
// KV layout:
//   tok:<token>        → {name, role: "admin"|"trusted"}   (revoke = delete)
//   pt:<id>            → live point (+_syncedAt ms)
//   sug:<uuid>         → {entry, status: pending|approved|rejected, reason?, submittedAt}
//   trail:<uuid>       → {steps, note, status: pending|…, submittedAt}  (from wichaa.net)
//   biz:<slug>         → self-claimed business page (see "Business claim" below)
//   bizedit:<token>    → slug   (capability token, same shape as tok:, one biz each)
//   bizref:<code>      → slug   (printed referral code, for /claim's recruitment loop)
//   rl:<ip>:<hour>     → suggestion count (1h TTL)
//   rlt:<ip>:<hour>    → offered-trail count (1h TTL)
//   rlc:<ip>:<hour>    → claim count (1h TTL)
//
// Abuse posture (disclosed honestly): no tamper-proof log, no spam-proofing
// beyond IP rate limits and moderation. A leaked trusted token can write junk
// until revoked; diff review at `build.mjs --pull` fold-in is the backstop.
//
// Business claim (biz:/bizedit:) is deliberately its own namespace, not a
// pt: point or a sug: suggestion, for the same reason trail: is separate:
// different shape, different trust model. A map point is a claim ABOUT a
// place that a stranger can get wrong, so it goes through moderation. A
// business page is a claim a business makes ABOUT ITSELF — the owner is the
// authority on their own hours and phone number — so it publishes instantly,
// no queue. It is not folded into the map's canonical data; it lives here as
// the crawl-bait / QR-magic-link layer described in CLAUDE.md's "Business
// pages" section.

import { validatePoint, inBbox } from '../lib/schema.mjs'

const MAX_BODY = 200_000 // bytes; a suggestion is text — photographs go to /photo
const SUGGEST_PER_HOUR = 20
// Trails are cheaper to offer than points (no coordinates to get right) and
// cheaper to read, so a slightly looser bucket, still per-IP per-hour.
const TRAIL_PER_HOUR = 30

// Photographs DO travel. 83% of the archive has no picture, so refusing them
// would decline the single most valuable thing a visitor can offer.
//
// They live in KV rather than R2 deliberately: R2 is the right home for a large
// image corpus, but it needs a separate service enabled on the account, and KV
// costs nothing extra and is already here. 1 GB of free storage at ~150 KB a
// photograph is a few thousand contributions — far past the point where this
// flow will have proved itself. Moving to R2 later changes this one handler and
// nothing that calls it.
const PHOTO_MAX = 2_000_000 // ~2 MB of base64: a 1000px JPEG with room to spare
const PHOTO_PER_HOUR = 10

// Business claim. Claiming is rarer and more consequential than suggesting a
// point (it publishes instantly, no moderation), so its own tighter bucket.
const CLAIM_PER_HOUR = 5
const ALLOWED_LENS = ['clinic', 'massage', 'tattoo', 'wat', 'other']
const LENS_LABEL = { clinic: 'Clinic', massage: 'Massage', tattoo: 'Tattoo studio', wat: 'Wat', other: 'Business' }
// schema.org type per lens for the JSON-LD block. "wat" maps to PlaceOfWorship
// deliberately, not a commerce type — see the wat note below.
const SCHEMA_TYPE = { clinic: 'MedicalBusiness', massage: 'HealthAndBeautyBusiness', tattoo: 'HealthAndBeautyBusiness', wat: 'PlaceOfWorship', other: 'LocalBusiness' }

const cap = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || ''
const slugify = (s) => (s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
// Base32-ish, no 0/O/1/I/L — printed on a card, has to survive being misread.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const randCode = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
  .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Rendered on claim so a business can hand the printed card straight to a
// customer. No commission math lives here — this just carries the code.
// Wats get no cash commission line: they're on the merit tier by design (see
// CLAUDE.md), so the copy invites other business owners in, never asks a wat
// to advertise a payout.
function renderBizPage(biz, origin) {
  const type = SCHEMA_TYPE[biz.lens] || 'LocalBusiness'
  const title = escapeHtml(biz.nameRoman ? `${biz.name} (${biz.nameRoman})` : biz.name)
  const desc = escapeHtml([LENS_LABEL[biz.lens], biz.area].filter(Boolean).join(' · '))
  const jsonLd = {
    '@context': 'https://schema.org', '@type': type, name: biz.name,
    ...(biz.area ? { address: biz.area } : {}),
    ...(biz.contactPhone ? { telephone: biz.contactPhone } : {}),
    ...(biz.hours ? { openingHours: biz.hours } : {}),
    url: `${origin}/biz/${biz.slug}`,
  }
  const contactLines = []
  if (biz.contactPhone) contactLines.push(`<a href="tel:${escapeHtml(biz.contactPhone)}">${escapeHtml(biz.contactPhone)}</a>`)
  if (biz.contactLine) contactLines.push(`LINE: ${escapeHtml(biz.contactLine)}`)
  const joinHref = `${origin}/claim.html?ref=${encodeURIComponent(biz.refCode)}`
  const meritNote = biz.lens === 'wat'
    ? ''
    : `<p class="cta">Own a shop, clinic, or studio too? <a href="${joinHref}">List it free</a> — mention code <strong>${escapeHtml(biz.refCode)}</strong> from ${escapeHtml(biz.nameRoman || biz.name)}.</p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="business.business">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
.cta{background:#f5f0e6;border-radius:8px;padding:.75rem 1rem;margin-top:2rem}
.label{color:#666;font-size:.9em;text-transform:uppercase;letter-spacing:.04em}</style>
</head>
<body>
<p class="label">${escapeHtml(LENS_LABEL[biz.lens])}${biz.area ? ' · ' + escapeHtml(biz.area) : ''}</p>
<h1>${escapeHtml(biz.name)}</h1>
${biz.nameRoman ? `<p>${escapeHtml(biz.nameRoman)}</p>` : ''}
${biz.hours ? `<p>${escapeHtml(biz.hours)}</p>` : ''}
${biz.note ? `<p>${escapeHtml(biz.note)}</p>` : ''}
${contactLines.length ? `<p>${contactLines.join('<br>')}</p>` : ''}
${meritNote}
</body>
</html>`
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  })

async function role(request, env) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
  if (!token) return { role: 'public', name: null }
  const rec = await env.KV.get(`tok:${token}`, 'json')
  if (!rec) return { role: 'public', name: null, badToken: true }
  return { role: rec.role, name: rec.name }
}

async function readEntry(request) {
  const text = await request.text()
  if (text.length > MAX_BODY) return { err: 'body too large' }
  let entry
  try { entry = JSON.parse(text) } catch { return { err: 'invalid json' } }
  const p = entry && entry.point
  const errs = p ? validatePoint(p) : ['missing point']
  if (p && !errs.length && !inBbox(p)) errs.push('outside coverage bbox')
  if (errs.length) return { err: errs.join('; ') }
  if (!['add', 'correction'].includes(entry.kind)) return { err: 'kind must be add|correction' }
  return { entry }
}

async function listPrefix(env, prefix) {
  const out = []
  let cursor
  do {
    const page = await env.KV.list({ prefix, cursor })
    for (const k of page.keys) {
      const v = await env.KV.get(k.name, 'json')
      if (v) out.push({ key: k.name, value: v })
    }
    cursor = page.list_complete ? null : page.cursor
  } while (cursor)
  return out
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    const who = await role(request, env)

    // POST /point — trusted+ writes directly to the live store.
    if (url.pathname === '/point' && request.method === 'POST') {
      if (!['trusted', 'admin'].includes(who.role))
        return json({ error: who.badToken ? 'invalid or revoked token' : 'token required' }, 403)
      const { entry, err } = await readEntry(request)
      if (err) return json({ error: err }, 400)
      const p = entry.point
      // Provenance: the write is attributed to the token's holder. Trust
      // controls WRITE ACCESS, not epistemic status — confidence stays as
      // the contributor set it (verified only if they were there).
      p.sources = [...(p.sources || []), { type: 'field', by: who.name, date: new Date().toISOString().slice(0, 10), via: 'sync-worker' }]
      p._syncedAt = Date.now()
      await env.KV.put(`pt:${p.id}`, JSON.stringify(p))
      return json({ ok: true, id: p.id })
    }

    // POST /suggest — anyone; lands in the moderation queue, never live.
    if (url.pathname === '/suggest' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown'
      const bucket = `rl:${ip}:${Math.floor(Date.now() / 3600_000)}`
      const count = Number((await env.KV.get(bucket)) || 0)
      if (count >= SUGGEST_PER_HOUR) return json({ error: 'rate limit — try again later' }, 429)
      const { entry, err } = await readEntry(request)
      if (err) return json({ error: err }, 400)
      const id = crypto.randomUUID()
      await env.KV.put(`sug:${id}`, JSON.stringify({
        entry, status: 'pending', submittedAt: new Date().toISOString(),
      }))
      await env.KV.put(bucket, String(count + 1), { expirationTtl: 3600 })
      return json({ ok: true, queued: id })
    }

    // POST /trail — anyone; a WALK offered from wichaa.net, into the same
    // moderation queue as everything else. Separate from /suggest because a
    // trail is not a point: it has no coordinates, so readEntry()'s point
    // validation (and the bbox test) would reject every one of them.
    //
    // Deliberately shallow validation: a trail is a list of paths on the wichaa
    // site plus a sentence. There is nothing here to place on the map, nothing
    // that goes live automatically, and a human reads every one — so the
    // checks that matter are the cheap ones (size, shape, rate).
    if (url.pathname === '/trail' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown'
      const bucket = `rlt:${ip}:${Math.floor(Date.now() / 3600_000)}`
      const count = Number((await env.KV.get(bucket)) || 0)
      if (count >= TRAIL_PER_HOUR) return json({ error: 'rate limit — try again later' }, 429)
      const text = await request.text()
      if (text.length > MAX_BODY) return json({ error: 'body too large' }, 400)
      let body
      try { body = JSON.parse(text) } catch { return json({ error: 'invalid json' }, 400) }
      const steps = Array.isArray(body?.steps) ? body.steps : null
      if (!steps || steps.length < 2) return json({ error: 'a trail needs at least two steps' }, 400)
      if (steps.length > 40) return json({ error: 'too many steps' }, 400)
      for (const s of steps) {
        if (typeof s?.href !== 'string' || !s.href.startsWith('/'))
          return json({ error: 'each step needs a site-relative href' }, 400)
      }
      const id = crypto.randomUUID()
      await env.KV.put(`trail:${id}`, JSON.stringify({
        steps: steps.slice(0, 40).map((s) => ({
          href: String(s.href).slice(0, 300),
          title: String(s.title || '').slice(0, 200),
        })),
        note: String(body.note || '').slice(0, 1000),
        status: 'pending',
        submittedAt: new Date().toISOString(),
      }))
      await env.KV.put(bucket, String(count + 1), { expirationTtl: 3600 })
      return json({ ok: true, queued: id })
    }

    // GET /trails — admin; offered walks awaiting a read.
    if (url.pathname === '/trails' && request.method === 'GET') {
      if (who.role !== 'admin') return json({ error: 'admin only' }, 403)
      const all = await listPrefix(env, 'trail:')
      return json({ queue: all.filter((r) => r.value.status === 'pending')
        .map((r) => ({ id: r.key.slice(6), ...r.value })) })
    }

    // POST /photo — anyone; stores a contributed photograph, returns its key.
    // The key then rides in a suggestion's media array, so the picture and the
    // claim about the place travel as one reviewable unit.
    //
    // `by` is REQUIRED and not a formality: CC BY-SA is an attribution licence,
    // so a photograph with no author recorded is one the archive cannot lawfully
    // publish. Refusing it at the door beats discovering it at moderation.
    if (url.pathname === '/photo' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown'
      const bucket = `rlp:${ip}:${Math.floor(Date.now() / 3600_000)}`
      const count = Number((await env.KV.get(bucket)) || 0)
      if (count >= PHOTO_PER_HOUR) return json({ error: 'rate limit — try again later' }, 429)
      const text = await request.text()
      if (text.length > PHOTO_MAX) return json({ error: 'photograph too large — under about 1.5 MB please' }, 413)
      let b
      try { b = JSON.parse(text) } catch { return json({ error: 'invalid json' }, 400) }
      const { place, dataUrl, by, licence, note } = b || {}
      if (typeof dataUrl !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl))
        return json({ error: 'dataUrl must be a base64 jpeg, png or webp' }, 400)
      if (typeof by !== 'string' || !by.trim())
        return json({ error: 'by is required — an attribution licence needs an author' }, 400)
      const key = crypto.randomUUID()
      await env.KV.put(`img:${key}`, JSON.stringify({
        place: place || null, dataUrl, by: by.trim(),
        licence: licence || 'CC BY-SA 4.0', note: note || '',
        at: new Date().toISOString(),
      }))
      await env.KV.put(bucket, String(count + 1), { expirationTtl: 3600 })
      return json({ ok: true, key })
    }

    // GET /photo?key= — admin only. The queue is not public and neither are the
    // photographs in it: nothing a contributor sends is visible to anyone else
    // until a person has approved it.
    if (url.pathname === '/photo' && request.method === 'GET') {
      if (who.role !== 'admin') return json({ error: 'admin only' }, 403)
      const rec = await env.KV.get(`img:${url.searchParams.get('key')}`, 'json')
      if (!rec) return json({ error: 'no such photograph' }, 404)
      return json(rec)
    }

    // GET /delta?since=<ms> — public; live points only, NEVER the queue.
    if (url.pathname === '/delta' && request.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0)
      const all = await listPrefix(env, 'pt:')
      const points = all.map((r) => r.value).filter((p) => (p._syncedAt || 0) > since)
      return json({ now: Date.now(), points })
    }

    // GET /queue — admin; pending suggestions.
    if (url.pathname === '/queue' && request.method === 'GET') {
      if (who.role !== 'admin') return json({ error: 'admin only' }, 403)
      const all = await listPrefix(env, 'sug:')
      return json({ queue: all.filter((r) => r.value.status === 'pending')
        .map((r) => ({ id: r.key.slice(4), ...r.value })) })
    }

    // POST /moderate — admin; approve → live store, reject → recorded reason.
    // Idempotent: moderating an already-moderated suggestion is a no-op.
    if (url.pathname === '/moderate' && request.method === 'POST') {
      if (who.role !== 'admin') return json({ error: 'admin only' }, 403)
      let body
      try { body = await request.json() } catch { return json({ error: 'invalid json' }, 400) }
      const { id, action, reason } = body || {}
      const key = `sug:${id}`
      const sug = await env.KV.get(key, 'json')
      if (!sug) return json({ error: 'no such suggestion' }, 404)
      if (sug.status !== 'pending')
        return json({ ok: true, alreadyModerated: true, status: sug.status })
      if (action === 'approve') {
        const p = sug.entry.point
        p.sources = [...(p.sources || []), { type: 'moderation', by: who.name, date: new Date().toISOString().slice(0, 10) }]
        p._syncedAt = Date.now()
        await env.KV.put(`pt:${p.id}`, JSON.stringify(p))
        sug.status = 'approved'
      } else if (action === 'reject') {
        sug.status = 'rejected'
        sug.reason = reason || '(none given)'
      } else return json({ error: 'action must be approve|reject' }, 400)
      sug.moderatedAt = new Date().toISOString()
      sug.moderatedBy = who.name
      await env.KV.put(key, JSON.stringify(sug))
      return json({ ok: true, status: sug.status })
    }

    // ---- Business claim (biz:/bizedit:) ----------------------------------
    // POST /claim, GET/POST /edit/:token, GET /biz/:slug. See the KV-layout
    // comment at the top of this file for why this is a separate namespace
    // from pt:/sug:.

    if (url.pathname === '/claim' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown'
      const bucket = `rlc:${ip}:${Math.floor(Date.now() / 3600_000)}`
      const count = Number((await env.KV.get(bucket)) || 0)
      if (count >= CLAIM_PER_HOUR) return json({ error: 'rate limit — try again later' }, 429)
      let body
      try { body = await request.json() } catch { return json({ error: 'invalid json' }, 400) }
      const name = cap(body?.name, 200)
      if (!name) return json({ error: 'name is required' }, 400)
      const lens = ALLOWED_LENS.includes(body?.lens) ? body.lens : null
      if (!lens) return json({ error: `lens must be one of ${ALLOWED_LENS.join(', ')}` }, 400)
      const contactLine = cap(body?.contactLine, 120)
      const contactPhone = cap(body?.contactPhone, 40)
      if (!contactLine && !contactPhone) return json({ error: 'contactLine or contactPhone is required' }, 400)
      const nameRoman = cap(body?.nameRoman, 200)
      const area = cap(body?.area, 120)
      const hours = cap(body?.hours, 200)
      const note = cap(body?.note, 500)

      let slug = slugify(nameRoman || name) || lens
      for (let i = 0; i < 5; i++) {
        const candidate = i === 0 ? slug : `${slug}-${randCode(4).toLowerCase()}`
        if (!(await env.KV.get(`biz:${candidate}`))) { slug = candidate; break }
        if (i === 4) slug = `${lens}-${randCode(6).toLowerCase()}`
      }

      const editToken = crypto.randomUUID()
      const refCode = randCode(6)
      const now = new Date().toISOString()
      // A code printed on someone else's card, quoted at claim time — the
      // recruitment loop. Looked up, not trusted blind: an unknown or
      // mistyped code just means no referrer, never an error.
      const refInput = cap(body?.ref || url.searchParams.get('ref'), 12).toUpperCase()
      const referredBySlug = refInput ? (await env.KV.get(`bizref:${refInput}`)) || null : null
      const biz = {
        slug, name, nameRoman: nameRoman || null, lens, area: area || null,
        contactLine: contactLine || null, contactPhone: contactPhone || null,
        hours: hours || null, note: note || null,
        refCode, referredBySlug, commission: lens === 'wat' ? 'merit' : 'standard',
        claimedAt: now, updatedAt: now,
      }
      await env.KV.put(`biz:${slug}`, JSON.stringify(biz))
      await env.KV.put(`bizedit:${editToken}`, slug)
      await env.KV.put(`bizref:${refCode}`, slug)
      await env.KV.put(bucket, String(count + 1), { expirationTtl: 3600 })
      return json({
        ok: true, slug, refCode,
        viewUrl: `${url.origin}/biz/${slug}`,
        editUrl: `${url.origin}/edit/${editToken}`,
      })
    }

    if (url.pathname.startsWith('/edit/') && (request.method === 'GET' || request.method === 'POST')) {
      const token = url.pathname.slice('/edit/'.length)
      const slug = token && await env.KV.get(`bizedit:${token}`)
      if (!slug) return json({ error: 'invalid or revoked edit link' }, 404)
      const biz = await env.KV.get(`biz:${slug}`, 'json')
      if (!biz) return json({ error: 'no such business record' }, 404) // orphaned token; shouldn't happen

      if (request.method === 'GET') return json({ ok: true, slug, biz })

      let body
      try { body = await request.json() } catch { return json({ error: 'invalid json' }, 400) }
      // Whitelist: an owner can correct their own facts, not their lens or
      // commission tier — those are fixed at claim time by design (see the
      // "wat" note in CLAUDE.md's Business pages section).
      for (const [key, max] of [['name', 200], ['nameRoman', 200], ['area', 120],
        ['contactLine', 120], ['contactPhone', 40], ['hours', 200], ['note', 500]]) {
        if (body?.[key] !== undefined) {
          const v = cap(body[key], max)
          biz[key] = v || null
        }
      }
      biz.updatedAt = new Date().toISOString()
      await env.KV.put(`biz:${slug}`, JSON.stringify(biz))
      return json({ ok: true, slug, biz })
    }

    if (url.pathname.startsWith('/biz/') && request.method === 'GET') {
      const slug = url.pathname.slice('/biz/'.length)
      const biz = await env.KV.get(`biz:${slug}`, 'json')
      if (!biz) return new Response('not found', { status: 404 })
      return new Response(renderBizPage(biz, url.origin), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    return json({ error: 'not found', endpoints: ['/point', '/suggest', '/trail', '/photo', '/delta', '/queue', '/trails', '/moderate', '/claim', '/edit/:token', '/biz/:slug'] }, 404)
  },
}
