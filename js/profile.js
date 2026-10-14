// Draws the terrain profile between home and a repeater on a <canvas>.
(function () {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  let current = null;

  function niceStep(range, target) {
    const raw = range / target, mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  }

  function draw(canvas, prof, an, hover) {
    current = { canvas, prof, an };
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const pad = { l: 52, r: 16, t: 14, b: 30 };
    const n = prof.d.length;
    const surface = prof.ground.map((g, i) => g + an.bulge[i]);
    const lo = Math.min(0, ...surface);
    const hi = Math.max(...surface, an.txAsl, an.rxAsl) * 1.08 + 10;
    const x = (d) => pad.l + (d / prof.D) * (W - pad.l - pad.r);
    const y = (h) => H - pad.b - ((h - lo) / (hi - lo)) * (H - pad.t - pad.b);

    // Grid + axes
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = css("--muted");
    ctx.strokeStyle = css("--grid");
    ctx.lineWidth = 1;
    const ys = niceStep(hi - lo, 5);
    for (let h = Math.ceil(lo / ys) * ys; h <= hi; h += ys) {
      ctx.beginPath(); ctx.moveTo(pad.l, y(h)); ctx.lineTo(W - pad.r, y(h)); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillText(`${h} m`, pad.l - 6, y(h) + 4);
    }
    const km = prof.D / 1000, xs = niceStep(km, 8);
    ctx.textAlign = "center";
    for (let k = 0; k <= km + 1e-9; k += xs) ctx.fillText(`${+k.toFixed(1)} km`, x(k * 1000), H - pad.b + 16);

    // Terrain (with Earth bulge applied)
    ctx.beginPath();
    ctx.moveTo(x(0), y(lo));
    for (let i = 0; i < n; i++) ctx.lineTo(x(prof.d[i]), y(surface[i]));
    ctx.lineTo(x(prof.D), y(lo));
    ctx.closePath();
    ctx.fillStyle = css("--terrain");
    ctx.fill();
    ctx.strokeStyle = css("--terrain-edge");
    ctx.stroke();

    // 60% Fresnel boundary
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = css("--fresnel");
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const h = an.line[i] - 0.6 * an.fresnel[i];
      i ? ctx.lineTo(x(prof.d[i]), y(h)) : ctx.moveTo(x(prof.d[i]), y(h));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Obstructions
    ctx.fillStyle = css("--unlikely");
    for (let i = 1; i < n - 1; i++) {
      if (surface[i] > an.line[i]) ctx.fillRect(x(prof.d[i]) - 1, y(surface[i]), 2, y(an.line[i]) - y(surface[i]));
    }

    // Diffraction edges, labelled with the dB they cost
    ctx.fillStyle = css("--text");
    for (const e of an.edges) {
      if (e.loss < 0.5) continue;
      const ex = x(prof.d[e.i]), ey = y(surface[e.i]);
      ctx.beginPath(); ctx.moveTo(ex, ey - 2); ctx.lineTo(ex - 5, ey - 10); ctx.lineTo(ex + 5, ey - 10); ctx.closePath(); ctx.fill();
      ctx.fillText(`${e.loss.toFixed(0)} dB`, ex, ey - 14);
    }

    // Radio line
    ctx.lineWidth = 2;
    ctx.strokeStyle = ctx.fillStyle = css(`--${an.status}`);
    ctx.beginPath(); ctx.moveTo(x(0), y(an.txAsl)); ctx.lineTo(x(prof.D), y(an.rxAsl)); ctx.stroke();
    for (const [d, h] of [[0, an.txAsl], [prof.D, an.rxAsl]]) {
      ctx.beginPath(); ctx.arc(x(d), y(h), 4, 0, 2 * Math.PI); ctx.fill();
    }

    // Hover readout
    if (hover != null) {
      const i = Math.max(0, Math.min(n - 1, Math.round(((hover - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
      const px = x(prof.d[i]);
      ctx.strokeStyle = css("--muted"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, H - pad.b); ctx.stroke();
      const clear = an.line[i] - surface[i];
      const label = `${(prof.d[i] / 1000).toFixed(2)} km · ground ${Math.round(prof.ground[i])} m · ` +
        `clearance ${clear >= 0 ? "+" : ""}${Math.round(clear)} m`;
      ctx.font = "12px system-ui, sans-serif";
      const w = ctx.measureText(label).width + 12;
      const bx = Math.min(Math.max(px - w / 2, pad.l), W - pad.r - w);
      ctx.fillStyle = css("--panel"); ctx.fillRect(bx, pad.t, w, 20);
      ctx.fillStyle = css("--text"); ctx.textAlign = "left"; ctx.fillText(label, bx + 6, pad.t + 14);
      return prof.pts[i];
    }
    return null;
  }

  function redraw(hover) {
    return current ? draw(current.canvas, current.prof, current.an, hover) : null;
  }

  window.Profile = { draw, redraw };
})();
