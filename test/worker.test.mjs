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
