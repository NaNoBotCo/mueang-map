# CLAUDE.md — Mueang Map (Chiang Mai niche-lens atlas)

Interactive, participatory map of Chiang Mai organized by niche filters ("lenses"): spirit houses, wats, views, tattoo shops, libraries, art studios, pad krapow, auspiciousness, and whatever lenses get added later. Seeded from open-source crawls, deepened over time by field input. The spine: **snapshot-first crawling, one canonical schema, lenses are data not code, field truth beats crawled truth.**

## Architecture

**Static-first, no Ushahidi.** Ushahidi is a hosted PHP/API platform — wrong shape for this project (server dependency, account system, someone else's schema). The equivalent capability is built from:

- **Viewer**: single self-contained `map.html` — MapLibre GL JS *inlined* (no CDN), vector tiles optional, raster OSM tiles acceptable fallback. All lens data embedded as JSON or loaded from sibling `data/*.geojson` files via file:// -tolerant loading (inline `<script type="application/json">` blocks if file:// fetch is blocked). Works offline on a phone in a soi with no signal.
- **Harvesters**: Node 18+ scripts, zero npm deps, in `harvest/`. One script per source. Snapshot-first: crawl once into `cache/`, iterate extraction offline, never re-hammer.
- **Field capture**: in-app "add/correct a point" form → writes to localStorage → export as JSON patch file → merged into canonical data by a merge script. This is the participatory loop. GPS via Geolocation API, photo attach as base64 (size-capped), offline-queued.
- **Merge/build**: `build.mjs` compiles `data/canonical/*.json` + accepted field patches → per-lens GeoJSON → embeds into `map.html`. One command, deterministic output.

**Participation model (decided):** hybrid. A minimal Cloudflare Worker + KV is the one sanctioned backend. Two write paths: **trusted contributors** (token-holding) add points directly; **everyone else** submits suggestions into a moderation queue that NaN approves or rejects. The baked-in data always works offline; the Worker layer is additive. See "Sync worker & roles."

## Canonical schema

One schema across all lenses and all sources. Do not fork it per lens.

```json
{
  "id": "wat-chedi-luang",
  "lens": ["wat", "view"],
  "name": "วัดเจดีย์หลวง",
  "nameRoman": "Wat Chedi Luang",
  "lat": 18.7869, "lng": 98.9865,
  "geoPrecision": "exact|block|area",
  "address": null,
  "attrs": {},
  "media": [],
  "sources": [
    {"type": "osm", "ref": "node/123", "fetched": "2026-07-18"},
    {"type": "field", "by": "nan", "date": "2026-07-20"}
  ],
  "confidence": "verified|crawled|heuristic",
  "notes": "",
  "updatedAt": "2026-07-18"
}
```

`confidence` is load-bearing: `verified` = field-confirmed; `crawled` = machine-extracted, unvisited; `heuristic` = inferred (e.g., auspiciousness computations). The map renders it (badge/opacity), never hides it. (`reported` added as fourth value: human-relayed, unvisited.)

## Lens registry (`data/lenses.json`)

Lenses are declared as data — name, icon, color, marker shape, attrs schema, filter facets — so adding a lens never touches viewer code. Color is never the sole signal: every lens gets a distinct marker **shape** and label.

Seed lenses and their lens-specific `attrs`:

| lens | attrs | seed source | notes |
|---|---|---|---|
| `spirit-house` | style (san phra phum / san chao thi / chao thi boran), material, condition, offerings observed | **field-primary** | Near-absent from OSM. This lens is the participatory flagship — crawls can't build it. |
| `wat` | sect, founded, chedi style, active/ruin, ordination hall access | OSM + Wikidata + Wikipedia | OSM Overpass: `amenity=place_of_worship` + `religion=buddhist` inside the bbox. Cross-ref Wikidata for founding dates. |
| `view` | direction, subject (Doi Suthep / city / river), best hour, access (free/paid/consumption) | field + heuristic | Heuristic seed: SRTM elevation + rooftop-bar crawls; mark `heuristic` until visited. |
| `tattoo` | style (sak yant / machine / both), ajarn/artist named **only from field input, never from memory** | OSM + Google-visible listings snapshot + field | Confabulation-sensitive category — no invented practitioners. |
| `library` | type (public/uni/cafe-library/little-free), hours, wifi, farang-usable | OSM + field | |
| `art-studio` | discipline, open-to-visitors, classes | OSM + gallery listing crawls | |
| `pad-krapow` | protein options, khai dao quality, price ฿, heat honesty, rating (field only) | OSM restaurants + field | Ratings are field-only; crawled review scores are not imported (TOS + junk signal). |
| `auspicious` | basis (see below), polarity, strength | computed + declared | See auspiciousness section. |

## Auspiciousness lens

This is a real analytical layer inside the animist–geomantic framework, not decoration. Two point types:

1. **Structural**: computed from the mueang's actual sacred geography — city pillar (Sao Inthakhin), the gate/corner scheme of the old city (each gate and corner bastion carries a traditional directional valence, including the inauspicious one), khuang, moat axes, Doi Suthep sightlines, naga-associated water features (Ping, khlong mueang). These are `heuristic` confidence with the derivation recorded in `attrs.basis` — the rule applied, not just the verdict.
2. **Declared**: NaN (or another contributor) marks a site with a reading. `attrs.basis = "declared"`, source = field. Never machine-generate declared readings.

The traditional directional scheme for the gates/corners must be **sourced and cited** in `data/canonical/auspicious-basis.md` before any structural points ship — from training this is plausible-but-unverified territory. Search Thai-language sources; do not assert the gate valences from memory.

## Harvesting conventions

- `harvest/osm-overpass.mjs` — Overpass API, one bbox query per element class, results to `cache/osm/`. Polite: sequential, honest UA (`mueang-map/1.0 (+contact)`), respect Overpass rate guidance, and cache aggressively — re-run extraction from cache, not from the API.
- `harvest/wikidata.mjs` — SPARQL for wats/monuments in Chiang Mai province, `cache/wikidata/`.
- `harvest/wikipedia.mjs` — article extracts for named sites only, `cache/wikipedia/`.
- Government/open data (data.go.th, municipality GIS) — check availability, expect legacy charsets: **sniff TIS-620/windows-874 before assuming UTF-8**; mojibake here is a known failure class.
- Every harvester emits canonical-schema JSON to `data/crawled/<source>.json` with `sources[]` and `confidence:"crawled"` populated. No harvester writes to `data/canonical/` directly — merge is a separate reviewed step.
- Session-ID/tracking junk in URLs gets stripped at cache-key time (known infinite-duplicate failure class).
- Licensing: OSM data is ODbL — attribution in the viewer footer and share-alike applies to derived point data; Wikidata CC0; Wikipedia CC BY-SA (extracts carry attribution). Record license per source in `data/licenses.json`.

## Sync worker & roles

Single Cloudflare Worker + KV. Total surface: four endpoints. No accounts, no OAuth, no user table — capability tokens.

- **Tokens**: random 128-bit strings NaN generates and hands out personally (QR or link). KV maps `token → {name, role}`. Roles: `admin` (NaN — moderate, revoke tokens), `trusted` (direct add/edit), absent/invalid token = `public` (suggest only). Revocation = delete the KV entry. Token distribution is social, which is the correct trust model at this scale.
- **Endpoints**: `POST /point` (trusted+ → written to live store with `sources[].by` = token's name), `POST /suggest` (anyone → queue, status `pending`, basic size/schema validation at the edge, rate-limited per IP), `GET /delta?since=` (public → live points + nothing from the pending queue), `GET /queue` + `POST /moderate` (admin → approve moves to live store, reject records the reason).
- **Client behavior**: token pasted once, kept in localStorage. Capture form is identical for both roles; the app routes to `/point` or `/suggest` by whether a valid token exists. Offline: submissions queue locally and flush when online — the existing patch queue *is* this queue, the Worker is just a second export target.
- **Trust ≠ verified**: direct adds land with whatever `confidence` the contributor sets; trusted status controls *write access*, not epistemic status. A trusted contributor adding a spirit house they're standing at marks it `verified`; adding one from hearsay marks it `reported` (human-relayed-unvisited).
- **Canonical fold-in**: `build.mjs --pull` fetches the live store, diffs against canonical, and folds approved+direct points in at rebuild. KV is a buffer, not the system of record; canonical files in the repo remain ground truth and the disaster-recovery copy. Suggestions never reach canonical except through `/moderate`.
- **Abuse posture, disclosed honestly**: no tamper-proof log, no spam-proofing beyond rate limits and moderation. A leaked trusted token can write junk until revoked; the diff-review at fold-in is the backstop. Disclaimer over theater.
- **Tests**: Worker logic gets its own harness — role routing (public token cannot hit `/point`), queue isolation (`/delta` never leaks pending), idempotent moderation, revoked token rejected.

## Viewer requirements

- Mobile-primary. Lens toggles as ≥44px real `<button>` chips with pressed state; filter drawer; Escape closes overlays with focus return; aria-live for result counts; works at 200% zoom; focus-visible outlines. Wikipedia-dark-mode plainness — the map imagery is the visual richness, chrome stays flat.
- Marker taps open a detail card: name (Thai + roman), lens badges, confidence badge, attrs, media, sources ("from OSM, unvisited" is displayed text, not metadata).
- Field mode: long-press map or "I'm here" → capture form pre-filled with GPS + accuracy radius → localStorage queue → export button produces `patch-YYYYMMDD.json`.
- Diagnostics built in: a debug flag that dumps current filter state, loaded feature counts per lens, and any features that failed schema validation — the artifact-return loop for tuning harvesters.
- Thai text rendering checked on-device (line-breaking without spaces; don't let CSS `word-break` mangle it).

## Verification

- `node --check` every script; jsdom suite for the viewer covering: lens filter correctness, schema validation rejects malformed features, patch merge is idempotent and never silently drops a field point, export produces valid GeoJSON, confidence badges render for all states.
- Coordinate sanity gate in `build.mjs`: every point inside a generous Chiang Mai bbox; duplicates within 25 m across sources flagged for merge review, not auto-merged.
- Any auspiciousness rule table and the code applying it are generated from one source file — no hand-typed parallel tables.

## Growth model

Richness accrues in `data/canonical/` via reviewed merges: crawl refreshes (re-run harvester → diff against canonical → review) and field patches (import → validate → review conflicts → merge). `build.mjs` stamps a data version; changelog per release. The dataset is the product; the viewer is a lens onto it — keep them decoupled so the viewer can be rebuilt without touching data.

## Build order

1. Schema + lens registry + `build.mjs` + empty-state viewer (map renders, toggles work, field capture works) — usable day one with zero crawled data.
2. OSM harvester → wats/libraries/restaurants seeded.
3. Wikidata/Wikipedia enrichment.
4. Field patch import/merge loop.
5. Auspiciousness basis research + structural layer.
6. Sync worker: endpoints + token roles + moderation view + `build.mjs --pull`.

## Open decisions for NaN

1. Romanization scheme for `nameRoman` — RTGS adopted as working default (matches OSM name:en conventions loosely; swap if the decoder engine decides otherwise).
2. Tattoo lens: seeded from OSM shop points only (name + location, traceable to OSM); `attrs` (style, ajarn/artist) stay empty until field input. Never from crawled text or model memory.
