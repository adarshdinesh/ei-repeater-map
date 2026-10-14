// Map overlays drawn in the browser from the Terrarium elevation tiles:
// contour lines, hypsometric (elevation) colours and hillshade.
(function () {
  const SIZE = Terrain.SIZE;
  const P = SIZE + 2; // padded grid: one pixel borrowed from each neighbouring tile
  const NATIVE_MAX = 15; // deepest Terrarium zoom; Leaflet upscales beyond it

  // Contour spacing for a zoom level. Every 5th line is a bold, labelled index contour.
  function interval(z) {
    return z <= 8 ? 100 : z === 9 ? 50 : z === 10 ? 20 : 10;
  }

  // Elevation colour stops (m → rgb), tuned for Ireland's 0–1040 m range.
  const STOPS = [
    [0, [172, 208, 165]], [50, [148, 191, 139]], [100, [168, 198, 143]], [200, [209, 215, 171]],
    [300, [225, 228, 181]], [400, [239, 220, 162]], [500, [222, 190, 140]], [650, [202, 158, 117]],
    [800, [176, 134, 104]], [1000, [245, 240, 235]],
  ];
  const RAMP_MAX = 1100;
  const RAMP = new Uint8ClampedArray((RAMP_MAX + 1) * 3); // 1 m steps
  for (let h = 0; h <= RAMP_MAX; h++) {
    let k = STOPS.findIndex((s) => s[0] > h);
    if (k === -1) k = STOPS.length - 1;
    const [h0, c0] = STOPS[Math.max(0, k - 1)], [h1, c1] = STOPS[k];
    const t = h1 === h0 ? 0 : Math.min(1, (h - h0) / (h1 - h0));
    for (let j = 0; j < 3; j++) RAMP[h * 3 + j] = c0[j] + (c1[j] - c0[j]) * t;
  }

  const tileLat = (z, y) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z));

  // Tile grid with a one-pixel border from its eight neighbours, so slopes and
  // contours continue across tile edges instead of leaving seams.
  async function padded(z, x, y) {
    const near = await Promise.all([-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => Terrain.tile(z, x + dx, y + dy))));
    const centre = near[4];
    if (!centre) return null;
    const out = new Float32Array(P * P);
    for (let py = -1; py <= SIZE; py++) {
      const ty = py < 0 ? 0 : py < SIZE ? 1 : 2, ly = (py + SIZE) % SIZE;
      for (let px = -1; px <= SIZE; px++) {
        const tx = px < 0 ? 0 : px < SIZE ? 1 : 2, lx = (px + SIZE) % SIZE;
        const t = near[ty * 3 + tx];
        out[(py + 1) * P + px + 1] = t
          ? t[ly * SIZE + lx]
          : centre[Math.min(SIZE - 1, Math.max(0, py)) * SIZE + Math.min(SIZE - 1, Math.max(0, px))];
      }
    }
    return out;
  }

  const BaseLayer = L.GridLayer.extend({
    options: { maxNativeZoom: NATIVE_MAX, tileSize: SIZE, updateWhenZooming: false, keepBuffer: 1 },
    neighbours: false,
    createTile(coords, done) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      (this.neighbours ? padded : Terrain.tile)(coords.z, coords.x, coords.y).then((data) => {
        if (data) this.paint(canvas.getContext("2d"), data, coords);
        done(null, canvas);
      });
      return canvas;
    },
  });

  // ---- Elevation colours ----
  const TintLayer = BaseLayer.extend({
    paint(ctx, data) {
      const img = ctx.createImageData(SIZE, SIZE);
      const px = img.data;
      for (let i = 0; i < data.length; i++) {
        if (data[i] <= 0.5) continue; // sea stays transparent
        const r = Math.min(RAMP_MAX, Math.round(data[i])) * 3;
        px[i * 4] = RAMP[r]; px[i * 4 + 1] = RAMP[r + 1]; px[i * 4 + 2] = RAMP[r + 2]; px[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },
  });

  // ---- Hillshade (light from the north-west, 45° up) ----
  const LIGHT = [-0.5, 0.5, Math.SQRT1_2]; // unit vector: x east, y north, z up
  const ShadeLayer = BaseLayer.extend({
    neighbours: true,
    paint(ctx, g, { z, y }) {
      const m = Terrain.metresPerPixel(tileLat(z, y), z);
      const exaggerate = z <= 8 ? 2.5 : z <= 10 ? 2 : 1.5; // Irish hills are gentle
      const img = ctx.createImageData(SIZE, SIZE);
      const px = img.data;
      for (let yy = 0; yy < SIZE; yy++) {
        for (let x = 0; x < SIZE; x++) {
          const c = (yy + 1) * P + x + 1;
          const dzdx = ((g[c + 1] - g[c - 1]) / (2 * m)) * exaggerate;
          const dzdy = ((g[c - P] - g[c + P]) / (2 * m)) * exaggerate; // north is up
          // Surface normal (-dzdx, -dzdy, 1) · light, minus the flat-ground value, so flat land is untouched.
          const shade = (-dzdx * LIGHT[0] - dzdy * LIGHT[1] + LIGHT[2]) / Math.hypot(dzdx, dzdy, 1) - LIGHT[2];
          const i = (yy * SIZE + x) * 4;
          if (shade < 0) px[i + 3] = Math.min(200, -shade * 520);
          else { px[i] = px[i + 1] = px[i + 2] = 255; px[i + 3] = Math.min(140, shade * 360); }
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  });

  // ---- Contours (marching squares over pixel centres) ----
  const ContourLayer = BaseLayer.extend({
    neighbours: true,
    paint(ctx, g, { z }) {
      const step = interval(z);
      const lines = new Map(); // level -> [x1, y1, x2, y2, ...] in canvas pixels
      // Cell (gx, gy) joins padded samples gx..gx+1, gy..gy+1; padded index i is pixel i-1, centred at i-0.5.
      for (let gy = 0; gy <= SIZE; gy++) {
        for (let gx = 0; gx <= SIZE; gx++) {
          const a = g[gy * P + gx], b = g[gy * P + gx + 1];
          const c = g[(gy + 1) * P + gx + 1], d = g[(gy + 1) * P + gx];
          const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
          for (let lv = Math.ceil(Math.max(lo, 0.5) / step) * step; lv <= hi; lv += step) {
            const pts = [];
            const edge = (v0, v1, x0, y0, x1, y1) => {
              if ((v0 < lv) !== (v1 < lv)) {
                const t = (lv - v0) / (v1 - v0);
                pts.push(x0 + (x1 - x0) * t - 0.5, y0 + (y1 - y0) * t - 0.5);
              }
            };
            edge(a, b, gx, gy, gx + 1, gy);
            edge(b, c, gx + 1, gy, gx + 1, gy + 1);
            edge(c, d, gx + 1, gy + 1, gx, gy + 1);
            edge(d, a, gx, gy + 1, gx, gy);
            if (pts.length < 4) continue;
            if (!lines.has(lv)) lines.set(lv, []);
            lines.get(lv).push(...pts); // 2 points, or 4 at a saddle
          }
        }
      }
      ctx.lineCap = "round";
      const labels = [];
      for (const [lv, seg] of lines) {
        const index = lv % (step * 5) === 0;
        ctx.strokeStyle = index ? "rgba(112, 62, 22, 0.9)" : "rgba(130, 84, 44, 0.6)";
        ctx.lineWidth = index ? 1.5 : 0.8;
        ctx.beginPath();
        for (let i = 0; i < seg.length; i += 4) { ctx.moveTo(seg[i], seg[i + 1]); ctx.lineTo(seg[i + 2], seg[i + 3]); }
        ctx.stroke();
        if (!index) continue;
        // Up to 6 labels per tile: every 23rd segment is a candidate, kept 90 px apart and off the tile edges.
        for (let i = 0; i < seg.length && labels.length < 6; i += 4 * 23) {
          const mx = (seg[i] + seg[i + 2]) / 2, my = (seg[i + 1] + seg[i + 3]) / 2;
          if (mx < 24 || my < 12 || mx > SIZE - 24 || my > SIZE - 12) continue;
          if (labels.some((l) => Math.hypot(l.x - mx, l.y - my) < 90)) continue;
          let ang = Math.atan2(seg[i + 3] - seg[i + 1], seg[i + 2] - seg[i]);
          if (ang > Math.PI / 2) ang -= Math.PI;
          if (ang < -Math.PI / 2) ang += Math.PI;
          labels.push({ x: mx, y: my, ang, text: String(lv) });
        }
      }
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fillStyle = "rgb(100, 52, 16)";
      for (const l of labels) {
        ctx.save();
        ctx.translate(l.x, l.y);
        ctx.rotate(l.ang);
        ctx.strokeText(l.text, 0, 0);
        ctx.fillText(l.text, 0, 0);
        ctx.restore();
      }
    },
  });

  // CSS gradient matching the colour ramp, for the legend (0–1000 m).
  const legendGradient = () =>
    `linear-gradient(to right, ${STOPS.map(([h, c]) => `rgb(${c.join(",")}) ${h / 10}%`).join(", ")})`;

  window.TerrainLayers = {
    interval,
    legendGradient,
    contours: () => new ContourLayer({ zIndex: 4 }),
    tint: (opacity) => new TintLayer({ zIndex: 2, opacity }),
    hillshade: () => new ShadeLayer({ zIndex: 3 }),
  };
})();
