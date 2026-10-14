#!/usr/bin/env python3
"""Rebuild data/repeaters.js from the IRTS voice repeater listing.

IRTS publishes each repeater's Maidenhead locator (6 characters, roughly a
5 x 4.6 km box). Repeaters live on high ground, so unless a site has a
curated coordinate we sample a grid of DEM elevations inside the locator box
and place the repeater on the highest point. Elevations come from the
Open-Meteo elevation API (Copernicus GLO-90 DEM).

Positions from the previous data/repeaters.js are reused for unchanged sites,
so routine refreshes make no elevation requests. Delete that file to
recompute every position.

Usage:  python3 tools/update_repeaters.py
"""
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

SOURCE = "https://irts.ie/cgi/repeater.cgi"
ELEV_API = "https://api.open-meteo.com/v1/elevation"
OUT = Path(__file__).resolve().parent.parent / "data" / "repeaters.js"
GRID = 7  # samples per side when searching a locator box for its high point

# Well-known summits. Used only if they fall inside the published locator.
CURATED = {
    "Three Rock": (53.2471, -6.2386),
    "Kippure": (53.1776, -6.3318),
    "Mount Leinster": (52.6178, -6.7797),
    "Truskmore": (54.3746, -8.3711),
    "Mullaghanish": (51.9853, -9.1475),
    "Clermont Cairn": (54.0826, -6.3184),
}
# Sites in town centres: keep the locator centre rather than hunting for hills.
URBAN = re.compile(r"\bCity\b|Salthill|Portmarnock|Belfast|Lisburn|Carrickfergus|Comber", re.I)


def locator_box(loc):
    loc = loc.strip()
    lon = (ord(loc[0].upper()) - 65) * 20 - 180 + int(loc[2]) * 2 + (ord(loc[4].lower()) - 97) * 5 / 60
    lat = (ord(loc[1].upper()) - 65) * 10 - 90 + int(loc[3]) + (ord(loc[5].lower()) - 97) * 2.5 / 60
    return lat, lon, lat + 2.5 / 60, lon + 5 / 60  # south, west, north, east


def elevations(points):
    out = []
    for i in range(0, len(points), 100):
        chunk = points[i:i + 100]
        q = urllib.parse.urlencode({
            "latitude": ",".join(f"{p[0]:.5f}" for p in chunk),
            "longitude": ",".join(f"{p[1]:.5f}" for p in chunk),
        })
        for attempt in range(8):
            try:
                with urllib.request.urlopen(f"{ELEV_API}?{q}", timeout=30) as r:
                    out += json.load(r)["elevation"]
                break
            except urllib.error.HTTPError as err:
                if (err.code != 429 and err.code < 500) or attempt == 7:
                    raise
                print(f"elevation API returned {err.code}, waiting {5 * 2 ** attempt}s")
                time.sleep(5 * 2 ** attempt)
        time.sleep(1)
    return out


def text(cell):
    cell = re.sub(r"<br\s*/?>", "\n", cell, flags=re.I)
    cell = re.sub(r"<[^>]+>", "", cell)
    return [l.strip().strip('"').strip() for l in html.unescape(cell).replace("\xa0", " ").split("\n") if l.strip()]


def modes_of(access, notes):
    blob = " ".join(access + notes)
    modes = [name for name, pat in [("DMR", r"DMR"), ("C4FM", r"C4FM|Fusion|Wires"),
                                    ("D-STAR", r"D-?STAR"), ("NXDN", r"NXDN")]
             if re.search(pat, blob, re.I)]
    # MMDVM is modem hardware, not a mode: it marks a digital repeater whose modes are in the notes.
    analogue = re.search(r"\d\s*Hz|Carrier|Analog", blob, re.I)
    digital_only = re.search(r"D-STAR only|MMDVM", blob, re.I) or (modes and not analogue)
    return (["FM"] if not digital_only else []) + modes


def band_of(mhz):
    return "10m" if mhz < 50 else "4m" if mhz < 100 else "2m" if mhz < 200 else "70cm"


def parse(page):
    rows = []
    for tr in re.findall(r"<tr>(.*?)</tr>", page, re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if len(tds) != 6 or "Output" not in tds[1]:
            continue
        _, freq, call, access, loc, notes = (text(t) for t in tds)
        out = float(re.search(r"Output:\s*([\d.]+)", " ".join(freq)).group(1))
        inp = float(re.search(r"Input:\s*([\d.]+)", " ".join(freq)).group(1))
        m = re.search(r"\b([A-Ra-r]{2}\d\d[A-Xa-x]{2})\b", " ".join(loc + notes))
        if not m:
            print(f"skipping {call[0]}: no locator")
            continue
        locator = m.group(1)
        if not any(locator in l for l in loc):
            # Malformed row: the location spilled into the notes cell.
            loc, notes = loc + notes, []
        site = ", ".join(l.replace(locator, "").strip(" ,") for l in loc if l.replace(locator, "").strip(" ,"))
        # CTCSS tones are 67–254 Hz; the lookbehind keeps "1750Hz" (toneburst) from reading as 750.
        tones = [float(t) for t in re.findall(r"(?<![\d.])(\d{2,3}(?:\.\d)?)\s*Hz", " ".join(access))]
        rows.append({
            "callsign": call[0].upper(),
            "output": out,
            "input": inp,
            "offset": round(inp - out, 4),
            "band": band_of(out),
            "ctcss": tones[0] if tones else None,
            "access": " ".join(access),
            "modes": modes_of(access, notes),
            "site": site,
            "locator": locator.upper()[:4] + locator.lower()[4:],
            "notes": notes,
            "offAir": any(re.search(r"off-?air", n, re.I) for n in notes),
        })
    return rows


def place(rows):
    boxes = {r["locator"] for r in rows}
    samples, owners = [], []
    for loc in sorted(boxes):
        s, w, n, e = locator_box(loc)
        for i in range(GRID):
            for j in range(GRID):
                samples.append((s + (i + 0.5) * (n - s) / GRID, w + (j + 0.5) * (e - w) / GRID))
                owners.append(loc)
    centres = {}
    for loc in boxes:
        s, w, n, e = locator_box(loc)
        centres[loc] = ((s + n) / 2, (w + e) / 2)
    elev = elevations(samples + list(centres.values()))
    high = {}
    for (pt, loc, h) in zip(samples, owners, elev):
        if loc not in high or h > high[loc][1]:
            high[loc] = (pt, h)
    centre_h = dict(zip(centres, elev[len(samples):]))

    extra = []
    for r in rows:
        s, w, n, e = locator_box(r["locator"])
        cur = next((v for k, v in CURATED.items() if k.lower() in r["site"].lower()), None)
        if cur and s <= cur[0] <= n and w <= cur[1] <= e:
            r["lat"], r["lon"], r["position"] = cur[0], cur[1], "curated summit"
            extra.append(r)
        elif URBAN.search(r["site"]):
            (r["lat"], r["lon"]), r["groundElev"] = centres[r["locator"]], centre_h[r["locator"]]
            r["position"] = "locator centre"
        else:
            (r["lat"], r["lon"]), r["groundElev"] = high[r["locator"]]
            r["position"] = "highest ground in locator"
    if extra:
        for r, h in zip(extra, elevations([(r["lat"], r["lon"]) for r in extra])):
            r["groundElev"] = h
    for r in rows:
        r["lat"], r["lon"] = round(r["lat"], 5), round(r["lon"], 5)


POSITION_FIELDS = ("lat", "lon", "groundElev", "position")


def previous_positions():
    """Positions from the last run, keyed by (locator, site): they only change if IRTS moves a site."""
    if not OUT.exists():
        return {}
    t = OUT.read_text(encoding="utf-8")
    old = json.loads(t[t.index("{"):t.rindex("}") + 1])["repeaters"]
    return {(r["locator"], r["site"]): {k: r[k] for k in POSITION_FIELDS} for r in old}


def main():
    req = urllib.request.Request(SOURCE, headers={"User-Agent": "irish-repeater-map/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        page = r.read().decode(r.headers.get_content_charset() or "utf-8")
    rows = parse(page)
    if not rows:
        raise SystemExit("No repeaters found: the IRTS page layout may have changed.")
    known = previous_positions()
    for r in rows:
        r.update(known.get((r["locator"], r["site"]), {}))
    new = [r for r in rows if "lat" not in r]
    if new:
        print(f"Looking up positions for {len(new)} new or moved repeaters")
        place(new)
    OUT.parent.mkdir(exist_ok=True)
    payload = {"source": SOURCE, "updated": date.today().isoformat(), "repeaters": rows}
    OUT.write_text("// Generated by tools/update_repeaters.py — do not edit by hand.\n"
                   f"window.REPEATER_DB = {json.dumps(payload, indent=1, ensure_ascii=False)};\n",
                   encoding="utf-8")
    print(f"Wrote {len(rows)} repeaters to {OUT}")


if __name__ == "__main__":
    main()
