// Line-of-sight and link-budget analysis over a terrain profile.
//
// Geometry: the radio path is a straight line between the two antennas.
// Terrain is raised by the Earth's bulge d1*d2 / (2 k R); k (default 4/3)
// models normal atmospheric refraction.
//
// Optical line of sight alone is too strict for VHF/UHF: signals diffract
// over hills, and a ridge grazing the path costs only a few dB. So we also
// estimate diffraction loss with the Deygout method (ITU-R P.526: main edge
// plus the worst edge either side) and run a simple uplink budget — your
// transmitter to the repeater's receiver, usually the weaker direction.
//
// status, by estimated signal at the repeater:
//   good      ≥ -100 dBm   full quieting
//   workable  ≥ -113 dBm   readable, some noise
//   unlikely  <  -113 dBm
(function () {
  const C = 299792458;
  const GOOD_DBM = -100;
  const WORKABLE_DBM = -113;
  const REPEATER_GAIN_DBI = 3; // typical collinear
  const MIN_PATH_M = 10; // avoids dividing by zero when home sits on the site

  async function profile(a, b) {
    const D = Geo.distance(a, b);
    const step = Terrain.metresPerPixel((a.lat + b.lat) / 2);
    const n = Math.max(32, Math.min(2000, Math.ceil(D / step))) + 1;
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(Geo.interpolate(a, b, i / (n - 1)));
    const ground = await Terrain.elevations(pts);
    return { D, d: pts.map((_, i) => (D * i) / (n - 1)), ground, pts };
  }

  // Single knife-edge loss in dB for Fresnel-Kirchhoff parameter v (ITU-R P.526 eq. 31).
  const knifeEdge = (v) => (v <= -0.78 ? 0 : 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1));

  // Deygout: find the edge with the largest v between i0 and i1, take its loss,
  // then recurse on each side with that edge as a new endpoint. Secondary edges
  // must sit well clear of the edge they hang off: otherwise one broad hill,
  // sampled every ~95 m, gets counted as a string of separate knife edges.
  function deygout(prof, i0, i1, h0, h1, lambda, k, depth, top = true) {
    if (depth === 0 || i1 - i0 < 2) return { loss: 0, edges: [] };
    const { d, ground } = prof;
    const D = d[i1] - d[i0];
    const sep = top ? 0 : Math.max(1000, 0.05 * D);
    let vMax = -Infinity, at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d1 = d[i] - d[i0], d2 = d[i1] - d[i];
      if (d1 < sep || d2 < sep) continue;
      const h = ground[i] + (d1 * d2) / (2 * k * Geo.R) - (h0 + ((h1 - h0) * d1) / D);
      const v = h * Math.sqrt((2 * D) / (lambda * d1 * d2));
      if (v > vMax) { vMax = v; at = i; }
    }
    if (at < 0) return { loss: 0, edges: [] };
    const loss = knifeEdge(vMax);
    if (loss === 0) return { loss: 0, edges: [] };
    const left = deygout(prof, i0, at, h0, ground[at], lambda, k, depth - 1, false);
    const right = deygout(prof, at, i1, ground[at], h1, lambda, k, depth - 1, false);
    return { loss: loss + left.loss + right.loss, edges: [{ i: at, v: vMax, loss }, ...left.edges, ...right.edges] };
  }

  function analyse(prof, { txAgl, rxAgl, freqMHz, k, powerW, gainDbi, extraLoss }) {
    const { d, ground } = prof;
    const D = Math.max(prof.D, MIN_PATH_M);
    const n = d.length;
    const txAsl = ground[0] + txAgl;
    const rxAsl = ground[n - 1] + rxAgl;
    const lambda = C / (freqMHz * 1e6);
    let minRatio = Infinity, minClear = Infinity;
    const bulge = new Float64Array(n), line = new Float64Array(n), fresnel = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d1 = d[i], d2 = D - d1;
      bulge[i] = (d1 * d2) / (2 * k * Geo.R);
      line[i] = txAsl + ((rxAsl - txAsl) * d1) / D;
      fresnel[i] = Math.sqrt((lambda * d1 * d2) / D);
      if (i === 0 || i === n - 1) continue;
      const clear = line[i] - (ground[i] + bulge[i]);
      minClear = Math.min(minClear, clear);
      minRatio = Math.min(minRatio, clear / fresnel[i]);
    }
    const los = minClear < 0 ? "obstructed" : minRatio < 0.6 ? "fresnel" : "clear";
    const fspl = 32.45 + 20 * Math.log10(D / 1000) + 20 * Math.log10(freqMHz);
    const diff = deygout(prof, 0, n - 1, txAsl, rxAsl, lambda, k, 2);
    const rxDbm = 10 * Math.log10(powerW * 1000) + gainDbi + REPEATER_GAIN_DBI - (fspl + diff.loss + extraLoss);
    const status = rxDbm >= GOOD_DBM ? "good" : rxDbm >= WORKABLE_DBM ? "workable" : "unlikely";
    return {
      status, los, minClear, txAsl, rxAsl, fspl, bulge, line, fresnel,
      diffLoss: diff.loss, edges: diff.edges, rxDbm, sMeter: sMeter(rxDbm, freqMHz),
    };
  }

  // IARU S-meter: S9 = -93 dBm above 30 MHz, -73 dBm below; 6 dB per S-unit.
  function sMeter(dbm, freqMHz) {
    const s9 = freqMHz > 30 ? -93 : -73;
    if (dbm >= s9) return `S9+${Math.round(dbm - s9)}`;
    return `S${Math.max(0, Math.round(9 + (dbm - s9) / 6))}`;
  }

  window.LOS = { profile, analyse };
})();
