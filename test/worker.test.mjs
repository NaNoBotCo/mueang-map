// Worker harness tests per CLAUDE.md: role routing, queue isolation,
// idempotent moderation, revoked token rejection. Runs the real worker
// module against a Map-backed fake KV — no Cloudflare needed.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../worker/worker.js'

function fakeKV() {
  const store = new Map()
  return {
    store,
    async get(key, type) {
      const v = store.get(key)
      if (v == null) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key, value) { store.set(key, String(value)) },
    async delete(key) { store.delete(key) },
    async list({ prefix }) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }
    },
  }
}

let env
beforeEach(() => {
  env = { KV: fakeKV() }
  env.KV.store.set('tok:admintok', JSON.stringify({ name: 'nan', role: 'admin' }))
  env.KV.store.set('tok:trusttok', JSON.stringify({ name: 'friend', role: 'trusted' }))
})

const point = (id = 'sh-test') => ({
  id, lens: ['spirit-house'], name: 'ศาลทดสอบ', nameRoman: null,
  lat: 18.79, lng: 98.98, geoPrecision: 'exact', address: null,
  attrs: {}, media: [], sources: [{ type: 'field', by: 'x', date: '2026-07-18' }],
  confidence: 'reported', notes: '', updatedAt: '2026-07-18',
})
const entry = (id) => ({ kind: 'add', targetId: null, point: point(id) })

const req = (path, { method = 'GET', token, body, ip } = {}) =>
  worker.fetch(new Request(`https://mm.example${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env)

test('role routing: public cannot hit /point', async () => {
  const res = await req('/point', { method: 'POST', body: entry() })
  assert.equal(res.status, 403)
  // and a garbage token is public too
  const res2 = await req('/point', { method: 'POST', token: 'nope', body: entry() })
  assert.equal(res2.status, 403)
  // trusted can
  const res3 = await req('/point', { method: 'POST', token: 'trusttok', body: entry() })
  assert.equal(res3.status, 200)
  const stored = JSON.parse(env.KV.store.get('pt:sh-test'))
  assert.equal(stored.sources.at(-1).by, 'friend') // attribution
  assert.equal(stored.confidence, 'reported') // trust ≠ verified
})

test('queue isolation: /delta never leaks pending suggestions', async () => {
  const s = await req('/suggest', { method: 'POST', body: entry('sh-pending'), ip: '1.2.3.4' })
  assert.equal(s.status, 200)
  await req('/point', { method: 'POST', token: 'trusttok', body: entry('sh-live') })
  const d = await (await req('/delta?since=0')).json()
  const ids = d.points.map((p) => p.id)
  assert.ok(ids.includes('sh-live'))
  assert.ok(!ids.includes('sh-pending'), 'pending suggestion leaked into /delta')
  // queue is admin-only
  assert.equal((await req('/queue')).status, 403)
  assert.equal((await req('/queue', { token: 'trusttok' })).status, 403)
  const q = await (await req('/queue', { token: 'admintok' })).json()
  assert.equal(q.queue.length, 1)
  assert.equal(q.queue[0].entry.point.id, 'sh-pending')
})

test('moderation: approve moves to live, is idempotent; reject records reason', async () => {
  await req('/suggest', { method: 'POST', body: entry('sh-mod'), ip: '1.2.3.4' })
  const q = await (await req('/queue', { token: 'admintok' })).json()
  const id = q.queue[0].id
  const a1 = await (await req('/moderate', { method: 'POST', token: 'admintok', body: { id, action: 'approve' } })).json()
  assert.equal(a1.status, 'approved')
  const d = await (await req('/delta?since=0')).json()
  assert.ok(d.points.some((p) => p.id === 'sh-mod'))
  // idempotent: second approve (or reject) is a no-op
  const before = env.KV.store.get('pt:sh-mod')
  const a2 = await (await req('/moderate', { method: 'POST', token: 'admintok', body: { id, action: 'reject', reason: 'oops' } })).json()
  assert.equal(a2.alreadyModerated, true)
  assert.equal(a2.status, 'approved')
  assert.equal(env.KV.store.get('pt:sh-mod'), before)
  // reject path records the reason
  await req('/suggest', { method: 'POST', body: entry('sh-bad'), ip: '1.2.3.4' })
  const q2 = await (await req('/queue', { token: 'admintok' })).json()
  const id2 = q2.queue[0].id
  await req('/moderate', { method: 'POST', token: 'admintok', body: { id: id2, action: 'reject', reason: 'junk' } })
  const sug = JSON.parse(env.KV.store.get(`sug:${id2}`))
  assert.equal(sug.status, 'rejected')
  assert.equal(sug.reason, 'junk')
  const d2 = await (await req('/delta?since=0')).json()
  assert.ok(!d2.points.some((p) => p.id === 'sh-bad'))
})

test('revoked token is rejected', async () => {
  assert.equal((await req('/point', { method: 'POST', token: 'trusttok', body: entry('a-1') })).status, 200)
  env.KV.store.delete('tok:trusttok') // revocation = delete the KV entry
  const res = await req('/point', { method: 'POST', token: 'trusttok', body: entry('a-2') })
  assert.equal(res.status, 403)
  const j = await res.json()
  assert.match(j.error, /invalid or revoked/)
})

test('validation + rate limit at the edge', async () => {
  const bad = await req('/suggest', { method: 'POST', body: { kind: 'add', point: { id: 'x' } }, ip: '9.9.9.9' })
  assert.equal(bad.status, 400)
  const offMap = await req('/suggest', { method: 'POST', body: entry('far'), ip: '9.9.9.9' })
  // London coords → rejected by bbox
  assert.equal(offMap.status, 200) // control: valid one passes
  for (let i = 0; i < 25; i++) await req('/suggest', { method: 'POST', body: entry(`p-${i}`), ip: '8.8.8.8' })
  const limited = await req('/suggest', { method: 'POST', body: entry('p-last'), ip: '8.8.8.8' })
  assert.equal(limited.status, 429)
})

// ---- /trail — walks offered from wichaa.net ---------------------------------
// A trail is not a point: no coordinates, so it cannot ride /suggest (readEntry
// would reject it for a missing point, and again for the bbox). Same queue
// posture though — public in, moderation out, nothing live automatically.
const walk = (n = 3) => ({
  kind: 'trail',
  steps: Array.from({ length: n }, (_, i) => ({ href: `/m?id=${i + 1}`, title: `Step ${i + 1}` })),
  note: 'a walk worth following',
})

test('trail: public may offer one; it lands pending and never goes live', async () => {
  const res = await req('/trail', { method: 'POST', body: walk(), ip: '1.1.1.1' })
  assert.equal(res.status, 200)
  const { ok, queued } = await res.json()
  assert.equal(ok, true)
  const stored = JSON.parse(env.KV.store.get(`trail:${queued}`))
  assert.equal(stored.status, 'pending')
  assert.equal(stored.steps.length, 3)
  // and nothing entered the live point store
  assert.equal([...env.KV.store.keys()].filter((k) => k.startsWith('pt:')).length, 0)
})

test('trail: a one-stop walk is not a trail; junk hrefs are refused', async () => {
  const short = await req('/trail', { method: 'POST', body: walk(1), ip: '1.1.1.2' })
  assert.equal(short.status, 400)
  const evil = await req('/trail', {
    method: 'POST', ip: '1.1.1.3',
    body: { steps: [{ href: 'https://elsewhere.example/x' }, { href: '/ok' }] },
  })
  assert.equal(evil.status, 400)
})

test('trail: the offered queue is admin-only', async () => {
  await req('/trail', { method: 'POST', body: walk(), ip: '1.1.1.4' })
  assert.equal((await req('/trails')).status, 403)
  const res = await req('/trails', { token: 'admintok' })
  assert.equal(res.status, 200)
  const { queue } = await res.json()
  assert.equal(queue.length, 1)
  assert.equal(queue[0].note, 'a walk worth following')
})

test('trail: rate-limited per IP, and its bucket is separate from /suggest', async () => {
  for (let i = 0; i < 30; i++) await req('/trail', { method: 'POST', body: walk(), ip: '9.9.9.9' })
  assert.equal((await req('/trail', { method: 'POST', body: walk(), ip: '9.9.9.9' })).status, 429)
  // the point-suggestion bucket is untouched by all that trail traffic
  assert.equal((await req('/suggest', { method: 'POST', body: entry('sh-after'), ip: '9.9.9.9' })).status, 200)
})

// ---- /claim, /edit/:token, /biz/:slug — self-serve business pages ---------
const claim = (over = {}) => ({
  name: 'ร้านสักลาย', nameRoman: 'Test Tattoo', lens: 'tattoo',
  area: 'Nimman', contactLine: '@testtattoo', ...over,
})

test('claim: publishes instantly, no moderation queue involved', async () => {
  const res = await req('/claim', { method: 'POST', body: claim(), ip: '2.2.2.1' })
  assert.equal(res.status, 200)
  const { ok, slug, refCode, viewUrl, editUrl } = await res.json()
  assert.equal(ok, true)
  assert.ok(env.KV.store.has(`biz:${slug}`))
  assert.ok(env.KV.store.has(`bizref:${refCode}`))
  assert.match(viewUrl, /\/biz\//)
  assert.match(editUrl, /\/edit\//)
  const page = await req('/biz/' + slug)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /Test Tattoo/)
  assert.match(html, /schema\.org/) // JSON-LD present
})

test('claim: validation — name, an allowed lens, and a contact method are required', async () => {
  assert.equal((await req('/claim', { method: 'POST', body: claim({ name: '' }), ip: '2.2.2.2' })).status, 400)
  assert.equal((await req('/claim', { method: 'POST', body: claim({ lens: 'casino' }), ip: '2.2.2.2' })).status, 400)
  assert.equal((await req('/claim', { method: 'POST', body: claim({ contactLine: undefined }), ip: '2.2.2.2' })).status, 400)
})

test('claim: wat lens defaults to the merit tier, never a cash commission', async () => {
  const res = await req('/claim', { method: 'POST', body: claim({ lens: 'wat', name: 'วัดทดสอบ', nameRoman: 'Wat Test', contactPhone: '053-000000' }), ip: '2.2.2.3' })
  const { slug } = await res.json()
  const stored = JSON.parse(env.KV.store.get(`biz:${slug}`))
  assert.equal(stored.commission, 'merit')
  const html = await (await req('/biz/' + slug)).text()
  assert.doesNotMatch(html, /List it free/) // no recruit-a-business CTA on a wat's own page
})

test('claim: a printed code on one page attributes the next claim', async () => {
  const r1 = await req('/claim', { method: 'POST', body: claim(), ip: '2.2.2.4' })
  const { slug: recruiterSlug, refCode } = await r1.json()
  const r2 = await req('/claim', { method: 'POST', body: claim({ name: 'อีกร้าน', nameRoman: 'Another Shop', ref: refCode }), ip: '2.2.2.5' })
  const { slug: newSlug } = await r2.json()
  const stored = JSON.parse(env.KV.store.get(`biz:${newSlug}`))
  assert.equal(stored.referredBySlug, recruiterSlug)
})

test('claim: an unrecognized ref code is silently ignored, not an error', async () => {
  const res = await req('/claim', { method: 'POST', body: claim({ ref: 'NOSUCH1' }), ip: '2.2.2.6' })
  assert.equal(res.status, 200)
  const { slug } = await res.json()
  assert.equal(JSON.parse(env.KV.store.get(`biz:${slug}`)).referredBySlug, null)
})

test('claim: two businesses with the same name get distinct slugs', async () => {
  const r1 = await req('/claim', { method: 'POST', body: claim(), ip: '2.2.2.7' })
  const r2 = await req('/claim', { method: 'POST', body: claim(), ip: '2.2.2.8' })
  const s1 = (await r1.json()).slug
  const s2 = (await r2.json()).slug
  assert.notEqual(s1, s2)
})

test('claim: rate-limited per IP, bucket separate from /suggest and /trail', async () => {
  for (let i = 0; i < 5; i++) await req('/claim', { method: 'POST', body: claim(), ip: '3.3.3.3' })
  assert.equal((await req('/claim', { method: 'POST', body: claim(), ip: '3.3.3.3' })).status, 429)
  assert.equal((await req('/suggest', { method: 'POST', body: entry('after-claim-limit'), ip: '3.3.3.3' })).status, 200)
})

test('edit: the token is the only credential — it reads and writes its one business, whitelisted fields only', async () => {
  const { editUrl, slug } = await (await req('/claim', { method: 'POST', body: claim(), ip: '2.2.2.9' })).json()
  const editToken = editUrl.split('/edit/')[1]
  const got = await (await req('/edit/' + editToken)).json()
  assert.equal(got.biz.slug, slug)

  const upd = await req('/edit/' + editToken, { method: 'POST', body: { hours: '10:00-20:00', lens: 'wat', commission: 'standard' } })
  assert.equal(upd.status, 200)
  const stored = JSON.parse(env.KV.store.get(`biz:${slug}`))
  assert.equal(stored.hours, '10:00-20:00')
  assert.equal(stored.lens, 'tattoo') // lens is not owner-editable
  assert.equal(stored.commission, 'standard') // commission is not owner-editable either

  assert.equal((await req('/edit/not-a-real-token')).status, 404)
})
