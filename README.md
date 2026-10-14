# Irish Repeater Map

A static website that maps every amateur radio voice repeater in Ireland and
checks **line of sight** from your location to each one over real terrain.

- Your location is shown as a house. Set it by searching for your town or
  village, with "Use my location" (GPS), "Pick on map", or by right-clicking
  the map. Then drag the house to your exact spot.
- Every repeater is plotted with its callsign, and a line is drawn from home
  to each site, coloured by the estimated signal at the repeater: **green**
  (Good), **amber** (Workable) or **red dashed** (Unlikely). See below for
  how it's worked out.
- The repeater list ranks every repeater from strongest to weakest estimated
  signal, with dBm, S-meter and a strength bar. You can also sort by distance
  or frequency.
- Click a line, marker or list entry to see the **elevation profile**: terrain
  with Earth curvature, the radio path, the 60% Fresnel zone and obstructions.
  Hovering the profile shows that point on the map.
- **Terrain first.** The app draws its own contour lines, elevation colours
  and hillshade in the browser, from the same elevation data the signal
  calculations use, so what you see is what's being calculated.
  - Contour spacing follows the zoom: 100 m, then 50, 20 and 10 m as you zoom in.
  - Every fifth contour is bold and labelled with its height.
  - The **Terrain** panel on the map toggles each layer, sets colour strength
    and shows the colour key.
  - **Terrain focus** pairs these layers with a pale base map (Esri Light
    Gray) so the terrain stands out. **Topo map** switches back to OpenTopoMap.
  - The layer switcher also offers a street map, Esri topo and satellite.
  - The box at the bottom left shows the elevation under your cursor.
- **Import a CHIRP CSV** to highlight the channels in your radio. Channels are
  matched to repeaters by callsign (or by a unique frequency), and frequency or
  tone differences from the IRTS list are flagged. A CSV with
  `Latitude`/`Longitude` columns (for example a RepeaterBook export) adds new
  repeaters too.
- **Export the repeaters currently shown as a CHIRP CSV**, in the list's sort
  order, with the distance and estimated signal in each comment. Only analogue
  FM repeaters are exported.
- Filter by band, mode, signal estimate, distance and text.

Try it with [`samples/irts-chirp.csv`](samples/irts-chirp.csv), the CHIRP file
IRTS publishes.

## How the line of sight is worked out

1. The path from home to the repeater is sampled about every 95 m along the
   great circle. Ground heights come from the
   [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), which are
   free, need no key and are loaded straight into the browser.
2. Antennas sit at ground level plus the heights you enter: your antenna
   (default 3 m) and the repeater mast (default 15 m).
3. Terrain is raised by the Earth's bulge, `d1·d2 / (2kR)`. The k-factor
   (default 4/3) models normal VHF/UHF refraction.
4. The profile reports strict **line of sight**: clear, Fresnel zone partly
   blocked, or no direct line of sight.
5. Strict line of sight is too pessimistic for VHF/UHF, because signals bend
   over hills. A ridge that just grazes the path costs only a few dB. So the
   app also estimates **diffraction loss** with the Deygout method (ITU-R
   P.526: the main ridge plus the worst ridge on each side, which must be at
   least 1 km or 5% of the path from it). It then runs an **uplink budget**:

   `signal at repeater = your power + your antenna gain + 3 dBi repeater antenna − (distance loss + hill loss + extra losses)`

6. Lines and badges are coloured by that estimated signal:
   **Good** ≥ −100 dBm (about S8, full quieting),
   **Workable** −100 to −113 dBm (readable with some noise),
   **Unlikely** below −113 dBm.

Set your antenna height (about 3 m per storey), power, antenna gain, and an
allowance for cable, walls and fading (default 10 dB). Trees, buildings and
the exact repeater site still matter, so treat the result as a good estimate,
not a guarantee.

**Worked example.** At 53.14258, −7.06021 (Co. Kildare), 2nd floor (6 m),
5 W, EI2DBR on Devil's Bit is 66 km away. There is no strict line of sight: a
low rise 12.5 km out pokes 15 m into the path. That rise costs about 7 dB,
and smaller rises about 7 dB more. The estimate is −97 dBm (S8), rated Good,
which matches on-air experience.

### Repeater positions

IRTS publishes a 6-character Maidenhead locator for each repeater, which only
pins it to a box of about 5 × 4.6 km. The build script places each repeater on
the **highest ground inside its locator box**, which is usually where the mast
is. Exceptions are a few well-known summits with curated coordinates, and city
sites, which keep the box centre. If you know a site's real position, open its
popup, choose **Move site** and drag it. The new position is saved in your
browser.

## Run locally

Any static file server works:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Location lookup ("Use my location") needs
`https` or `localhost`.

## Deploy

No build step is needed. The site is plain HTML, CSS and JavaScript, so it runs
on free static hosting.

### GitHub Pages

1. Push this folder to a **public** GitHub repository (branch `main`). On a
   free account, Pages only works for public repositories.
2. Go to **Settings → Pages → Build and deployment → Source** and choose
   **GitHub Actions**.
3. That's it. The workflow in `.github/workflows/pages.yml`:
   - deploys the site on every push to `main`;
   - every Monday at 05:17 UTC, re-reads the IRTS list. If any repeater
     changed, it commits the new `data/repeaters.js` to the repo; either way
     it redeploys, so the site's snapshot date shows the last check;
   - can be run by hand from **Actions → Update data and deploy → Run workflow**.

The site appears at `https://<user>.github.io/<repo>/`. On a public repository
this costs nothing.

GitHub pauses scheduled workflows in a public repository after 60 days with no
activity, such as commits or pushes. It emails you first. If that happens,
re-enable the workflow from the Actions tab, or push any commit.

### GitLab Pages

1. Push this folder to a GitLab project.
2. `.gitlab-ci.yml` publishes the site on each push to the default branch.
3. Optional: add a weekly schedule under **Build → Pipeline schedules**. The
   `refresh-data` job then rebuilds the repeater data from IRTS before the
   site is published.

The site appears at `https://<user>.gitlab.io/<project>/`. The exact URL is
shown under **Deploy → Pages**.

## Updating the repeater data

```bash
python3 tools/update_repeaters.py
```

The script scrapes <https://irts.ie/cgi/repeater.cgi>, finds each site's high
point using the [Open-Meteo elevation API](https://open-meteo.com/en/docs/elevation-api)
and rewrites `data/repeaters.js`. It uses only the Python standard library.
The elevation API rate-limits heavily, so the script backs off and retries; a
full run takes a few minutes.

## Files

| Path | What it does |
| --- | --- |
| `index.html`, `css/style.css` | Page and styles (light and dark) |
| `js/app.js` | Map, UI, filters, popups |
| `js/los.js` | Terrain profile and line-of-sight / Fresnel analysis |
| `js/terrain.js` | Reads elevations from Terrarium PNG tiles (shared cache) |
| `js/terrainlayers.js` | Contour, elevation-colour and hillshade map layers |
| `js/profile.js` | Elevation profile chart |
| `js/chirp.js` | CHIRP CSV import and export |
| `js/geo.js` | Distance, bearing, great-circle and Maidenhead helpers |
| `data/repeaters.js` | Generated repeater database |
| `tools/update_repeaters.py` | Rebuilds the database from IRTS |

## Credits

Repeater data © [IRTS](https://irts.ie). Map © OpenStreetMap contributors,
SRTM, style © OpenTopoMap (CC-BY-SA). Terrain: Mapzen / AWS Terrain Tiles.
Light Gray base, topo and imagery © Esri. Built with [Leaflet](https://leafletjs.com).
