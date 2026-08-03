#!/usr/bin/env node
// build-claim-page.mjs — generate claim.html, the free self-serve business
// page: a form that POSTs to /claim, then two QR codes (view + edit) the
// business owner can print. Self-contained like map.html: the QR encoder
// (vendor/qrcode.js + qrcode_UTF8.js, MIT, kazuhikoarase) is inlined, no CDN.
//
// Re-run after editing viewer/claim-template.html or vendor/qrcode*.js:
//   node scripts/build-claim-page.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const bail = (m) => { console.error(`✗ ${m}`); process.exit(1) }
const rd = (p) => readFileSync(join(ROOT, p), 'utf8')

if (!existsSync(join(ROOT, 'config.json'))) bail('config.json missing')
const config = JSON.parse(rd('config.json'))
if (!config.workerUrl) bail('config.json needs a workerUrl — the claim page has nowhere to POST to')

// JS source inlined into <script>: neutralize any literal </script.
const jsSafe = (s) => s.replace(/<\/script/gi, '<\\/script')

const html = rd('viewer/claim-template.html')
  .replace('/*@QRCODE_JS@*/', () => jsSafe(rd('vendor/qrcode.js')))
  .replace('/*@QRCODE_UTF8_JS@*/', () => jsSafe(rd('vendor/qrcode_UTF8.js')))
  .replace('/*@WORKER_URL_JSON@*/', () => JSON.stringify(config.workerUrl))

writeFileSync(join(ROOT, 'claim.html'), html)
console.log(`✓ claim.html written (${(html.length / 1024).toFixed(0)} KB, worker: ${config.workerUrl})`)
