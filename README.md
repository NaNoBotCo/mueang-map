# Mueang Map — Chiang Mai niche-lens atlas

Static-first, participatory map of Chiang Mai organized by lenses (spirit
houses, wats, views, tattoo, libraries, art studios, pad krapow,
auspiciousness). Full spec in [CLAUDE.md](CLAUDE.md). The dataset is the
product; `map.html` is a lens onto it.

## Quickstart

```bash
npm install          # jsdom (tests only — runtime has zero deps)
npm test             # schema, filters, merge idempotency, GeoJSON, worker
node build.mjs       # data/canonical/*.json → map.html + dist/data/*.geojson
open map.html        # works from file://, offline; phone-first UI
```

## Workflows

**Crawl refresh** (snapshot-first — API hit only when cache is missing):
```bash
node harvest/osm-overpass.mjs --fetch    # → cache/osm/ + data/crawled/osm.json
node merge.mjs crawled osm               # reviewed fold-in → data/canonical/osm.json
node build.mjs
```
Field-touched points are never overwritten by a crawl refresh — they land in
`data/canonical/merge-conflicts.json` for manual review (field truth beats
crawled truth).

**Field patches** (the participatory loop): capture points in the app (＋
button or long-press), export `patch-YYYYMMDD.json` from the Filters drawer,
then:
```bash
node merge.mjs patch patches/patch-20260718.json   # idempotent; conflicts → review file
node build.mjs
```

**Auspiciousness layer** (structural points are generated, never hand-typed):
- Basis + citations: [data/canonical/auspicious-basis.md](data/canonical/auspicious-basis.md)
- Single rule source: [data/canonical/auspicious-rules.json](data/canonical/auspicious-rules.json)
```bash
node harvest/osm-landmarks.mjs --fetch   # gate/jaeng/monument coords from OSM
node scripts/gen-auspicious.mjs          # → data/canonical/auspicious-structural.json
```
Declared readings are field-only — never machine-generated.

**Sync worker** (optional hybrid backend — Cloudflare Worker + KV):
```bash
cd worker && npx wrangler kv namespace create MM_KV   # paste id into wrangler.toml
npx wrangler deploy
node ../scripts/make-token.mjs nan admin              # mint + install tokens
echo '{"workerUrl":"https://mueang-map-sync.<acct>.workers.dev"}' > ../config.json
node ../build.mjs                                     # embeds workerUrl into map.html
node ../build.mjs --pull                              # fold live store (staged for review)
```
Roles: token = trusted direct writes, no token = suggestion queue, admin
moderates (`/queue`, `/moderate`). KV is a buffer; canonical files in this
repo remain ground truth.

## Decisions taken (open items from the spec)

1. **Romanization**: RTGS as working default for `nameRoman` (OSM `name:en`
   is used as-is when present). Swap centrally if the decoder engine decides
   otherwise.
2. **Tattoo lens**: seeded from OSM shop points only — name + location,
   traceable to OSM refs. `attrs` (style, ajarn/artist) stay empty until
   field input; the harvester never fills them from crawled text.

## Data honesty rules baked in

- `confidence` (verified / reported / crawled / heuristic) renders as badge +
  marker opacity; "from OSM, unvisited" is user-visible text.
- Coordinate sanity bbox + <25 m cross-source duplicate flagging at build;
  duplicates are reviewed, never auto-merged.
- Every auspiciousness point carries its derivation (`attrs.basis`) and cites
  the basis doc; UNVERIFIED valences (e.g. "Katam unlucky") are excluded or
  carried as explicit caveats.
- Pad-krapow ratings and crawled review scores: field-only / never imported.

## Licensing

OSM data © OpenStreetMap contributors, ODbL (share-alike applies to derived
point data; attribution in the viewer footer) · Wikidata CC0 · Wikipedia
CC BY-SA · MapLibre GL JS BSD-3 (vendored in `vendor/`). Per-source records
in [data/licenses.json](data/licenses.json).
