# Wider wat crawl — staged rollout (CM province → Nan → Chiang Rai)

The city seed (345 wats, lat 18.57–18.99) is complete and enriched. This is the
plan to widen coverage across the northern-Thai (Lanna) heartland. **Nothing here
has been run** — each step below hits the network deliberately, snapshot-first.

## What's already wired

Both harvesters are region-aware. Regions wider than the city use a precise OSM
**admin boundary** (`admin_level=4` = changwat/province), not a bounding box, so
they don't overshoot into neighbours. Wikidata uses a per-region geospatial
radius. Region runs write their own cache + `data/crawled/*-<region>.json` files,
so a wider sweep never clobbers the city seed.

Verify any query offline before fetching:

```
node harvest/osm-overpass.mjs --region=cm-province --only=wat --print-query
node harvest/osm-overpass.mjs --region=nan        --only=wat --print-query
node harvest/osm-overpass.mjs --region=chiang-rai --only=wat --print-query
```

Known regions: `cm-city` (default), `cm-province`, `nan`, `chiang-rai`.

## Nan & Chiang Rai — one command each (safe: no overlap with existing data)

```
npm run crawl:nan
npm run crawl:chiang-rai
```

Each chains: OSM area crawl (wats only) → merge into its own canonical file →
Wikidata enrich + promote (temples OSM missed) → rebuild map + wats visual.
Re-running is safe (snapshot cache is reused; merges are idempotent).

## Chiang Mai province — one decision to make first

`cm-province` ⊃ `cm-city`, so a naive province crawl would produce a second pin
for every temple already in `data/canonical/osm.json` (the build's 25 m dup-check
would light up in the hundreds). Pick one before running:

- **A — Supersede (recommended).** Treat the province file as the CM system of
  record and retire the city seed. Run the province crawl, then delete
  `data/canonical/osm.json`'s wat entries (keep the other lenses) so CM wats live
  only in `osm-cm-province.json`. Cleanest; one CM file going forward.
- **B — Keep both, dedupe at review.** Run the province crawl into its own file
  and resolve the flagged 25 m duplicates by hand at merge review. More manual
  work, no data thrown away.

There is intentionally **no `npm run crawl:cm-province`** script until this is
decided — see the manual steps in option A/B rather than baking in the wrong one.

Manual province pipeline (after choosing A or B):

```
node harvest/osm-overpass.mjs --region=cm-province --only=wat --fetch
node merge.mjs crawled osm-cm-province
node harvest/wikidata.mjs --region=cm-province --fetch
node merge.mjs enrich  wikidata-cm-province     # fills empty attrs on any file
node merge.mjs promote wikidata-cm-province     # adds temples OSM missed
node build.mjs && npm run build:wats
```

## Politeness & expectations

- Overpass: sequential, 3 s gap between queries, honest UA, 300 s server timeout
  for province areas, cached aggressively. A province of ~1,000+ wats is one query.
- Wikidata: heritage flag is the real enrichment win; founding dates are thin.
- Review every merge diff before trusting it — `data/canonical/merge-conflicts.json`
  is the queue of anything not confidently folded.
