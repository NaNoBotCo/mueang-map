#!/usr/bin/env node
// Mint a capability token and print the wrangler command that installs it.
// Token distribution is social: NaN hands these out personally (QR or link).
//   node scripts/make-token.mjs <name> <admin|trusted>
import { randomBytes } from 'node:crypto'

const [, , name, role] = process.argv
if (!name || !['admin', 'trusted'].includes(role)) {
  console.error('usage: node scripts/make-token.mjs <name> <admin|trusted>')
  process.exit(1)
}
const token = randomBytes(16).toString('hex') // 128-bit
console.log(`token for ${name} (${role}):\n\n  ${token}\n`)
console.log('install it (from worker/):')
console.log(`  npx wrangler kv key put --binding KV "tok:${token}" '${JSON.stringify({ name, role })}'`)
console.log('\nrevoke later with:')
console.log(`  npx wrangler kv key delete --binding KV "tok:${token}"`)
