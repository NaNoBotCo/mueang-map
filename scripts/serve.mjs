#!/usr/bin/env node
// scripts/serve.mjs — zero-dep static file server for local viewing.
// The map renderer needs http:// (MapLibre's worker won't start from file://).
//   node scripts/serve.mjs [port]
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.argv[2] || process.env.PORT || 8799)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
}

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p === '/') p = '/wats.html'
    // contain to ROOT — no path traversal
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return }
    const s = await stat(file)
    if (s.isDirectory()) { res.writeHead(404).end('not found'); return }
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  }
}).listen(PORT, () => console.log(`mueang-map serving ${ROOT} → http://localhost:${PORT}/wats.html`))
