"""fetch-province-boundaries.py — cache the changwat polygons (OSM admin_level=4).

    python3 harvest/fetch-province-boundaries.py

Province is a POLYGON question, not a radius one. harvest/wikidata.mjs bounds its
queries by centre+radius (Wikidata's P131 admin chain is too sparse to bound by)
and then stamps every result with the region's own label — so Lampang's 90 km
radius reached ~70 km into Phrae and labelled 25 Phrae temples "Lampang",
Wat Sung Men among them. A radius cannot know where a border is; this file can.

Writes data/boundaries/provinces.geojson (ODbL 1.0, like all OSM-derived data
here). Refresh only when a boundary actually changes — these move about once a
decade.
"""
import json, urllib.request, pathlib, sys

ISO = ["TH-50","TH-51","TH-52","TH-53","TH-54","TH-55","TH-56","TH-57","TH-58","TH-63","TH-64"]
Q = f'''[out:json][timeout:600];
rel["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"~"^({"|".join(ISO)})$"];
out geom;'''
UA = "mueang-map/1.0 (Chiang Mai niche-lens atlas; contact: skunkhaus@gmail.com)"
req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                             data=Q.encode(), headers={"User-Agent": UA})
raw = urllib.request.urlopen(req, timeout=600).read()
d = json.loads(raw)
print(f"overpass: {len(raw)/1048576:.1f} MB, {len(d.get('elements',[]))} relations")

def stitch(rel):
    """Assemble the relation's outer ways into closed rings."""
    segs = [[(p["lon"], p["lat"]) for p in m["geometry"]]
            for m in rel.get("members", [])
            if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("geometry")]
    rings, cur = [], None
    while segs:
        if cur is None:
            cur = segs.pop(0)
        if cur[0] == cur[-1] and len(cur) > 3:
            rings.append(cur); cur = None; continue
        for i, s in enumerate(segs):
            if s[0] == cur[-1]:   cur = cur + s[1:]; segs.pop(i); break
            if s[-1] == cur[-1]:  cur = cur + s[::-1][1:]; segs.pop(i); break
            if s[-1] == cur[0]:   cur = s[:-1] + cur; segs.pop(i); break
            if s[0] == cur[0]:    cur = s[::-1][:-1] + cur; segs.pop(i); break
        else:
            rings.append(cur); cur = None      # unclosed fragment — keep it anyway
    if cur: rings.append(cur)
    return [r for r in rings if len(r) > 3]

feats = []
for rel in d.get("elements", []):
    t = rel.get("tags", {})
    rings = stitch(rel)
    name = (t.get("name:en") or t.get("name") or "").replace(" Province", "")
    feats.append({"type": "Feature",
                  "properties": {"iso": t.get("ISO3166-2"), "name_en": name,
                                 "name_th": t.get("name:th") or t.get("name"),
                                 "rings": len(rings)},
                  "geometry": {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}})
    print(f"  {t.get('ISO3166-2')}  {name:16s} {len(rings)} ring(s), {sum(len(r) for r in rings)} pts")

out = pathlib.Path("data/boundaries/provinces.geojson")
out.write_text(json.dumps({"type": "FeatureCollection",
                           "note": "OSM admin_level=4 changwat boundaries, ODbL 1.0",
                           "features": feats}, ensure_ascii=False))
print(f"\n→ {out}  {out.stat().st_size/1048576:.1f} MB")
