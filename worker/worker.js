// Cloudflare Worker — the one sanctioned backend. Four endpoints, KV,
// capability tokens. No accounts, no OAuth, no user table.
//
// KV layout:
//   tok:<token>        → {name, role: "admin"|"trusted"}   (revoke = delete)
//   pt:<id>            → live point (+_syncedAt ms)
//   sug:<uuid>         → {entry, status: pending|approved|rejected, reason?, submittedAt}
//   rl:<ip>:<hour>     → suggestion count (1h TTL)
//
// Abuse posture (disclosed honestly): no tamper-proof log, no spam-proofing
// beyond IP rate limits and moderation. A leaked trusted token can write junk
// until revoked; diff review at `build.mjs --pull` fold-in is the backstop.

import { validatePoint, inBbox } from '../lib/schema.mjs'

const MAX_BODY = 200_000 // bytes; a suggestion is text — photographs go to /photo
const SUGGEST_PER_HOUR = 20

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

    return json({ error: 'not found', endpoints: ['/point', '/suggest', '/photo', '/delta', '/queue', '/moderate'] }, 404)
  },
}
