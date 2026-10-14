// Geodesy helpers: distances, bearings, great-circle interpolation, Maidenhead locator.
(function () {
  const R = 6371008.8; // mean Earth radius, metres
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function distance(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
      Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  // Point at fraction f along the great circle from a to b.
  function interpolate(a, b, f) {
    const d = distance(a, b) / R;
    if (d === 0) return { lat: a.lat, lon: a.lon };
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(rad(a.lat)) * Math.cos(rad(a.lon)) + B * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon));
    const y = A * Math.cos(rad(a.lat)) * Math.sin(rad(a.lon)) + B * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon));
    const z = A * Math.sin(rad(a.lat)) + B * Math.sin(rad(b.lat));
    return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) };
  }

  function compass(b) {
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][
      Math.round(b / 22.5) % 16
    ];
  }

  function toLocator(lat, lon) {
    const L = lon + 180, A = lat + 90;
    const c = (n) => String.fromCharCode(65 + n);
    return (
      c(Math.floor(L / 20)) + c(Math.floor(A / 10)) +
      Math.floor((L % 20) / 2) + Math.floor(A % 10) +
      c(Math.floor((L % 2) * 12)).toLowerCase() + c(Math.floor((A % 1) * 24)).toLowerCase()
    );
  }

  window.Geo = { R, distance, bearing, interpolate, compass, toLocator };
})();
