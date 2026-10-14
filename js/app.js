// Irish Repeater Map — UI wiring.
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const BANDS = ["10m", "4m", "2m", "70cm"];
  const STATUSES = ["good", "workable", "unlikely"];
  const RANK = { good: 0, workable: 1, unlikely: 2, pending: 3 };
  const LABEL = { good: "Good", workable: "Workable", unlikely: "Unlikely", pending: "…" };
  const LOS_TEXT = { clear: "clear line of sight", fresnel: "line of sight, Fresnel zone partly blocked", obstructed: "no direct line of sight" };
  // 145.6 -> "145.600", 145.6125 -> "145.6125"
  const mhz = (f) => f.toFixed(4).replace(/(\.\d{3}\d*?)0+$/, "$1");

  const DB = window.REPEATER_DB;
  const withId = (r) => ({ ...r, id: `${r.callsign}@${r.output}`, siteKey: `${r.lat.toFixed(5)},${r.lon.toFixed(5)}` });
  let repeaters = DB.repeaters.concat(store.get("addedRepeaters", [])).map(withId);
  const overrides = store.get("siteOverrides", {});
  const savedChirp = store.get("chirpIds", null);

  const state = {
    home: store.get("home", null),
    settings: Object.assign({ txAgl: 3, rxAgl: 15, powerW: 5, gainDbi: 0, extraLoss: 10, k: 1.333 }, store.get("settings", {})),
    bands: new Set(BANDS),
    statuses: new Set(STATUSES),
    mode: "", maxDist: 500, text: "", showOff: false, showUnlikelyLines: true, labels: true,
    chirp: savedChirp ? new Set(savedChirp) : null,
    chirpOnly: false,
    picking: false,
    sort: store.get("sort", "signal"),
    run: 0,
    profileFor: null,
  };

  // ---------- Map ----------
  const map = L.map("map", { zoomControl: true }).setView([53.45, -7.9], 7);
  const esri = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
  const LIGHT_BASE = "Light (terrain focus)";
  const TOPO_BASE = "Topographic (contours)";
  const bases = {
    // Pale roads/water underneath; town names sit above the terrain layers so they stay readable.
    [LIGHT_BASE]: L.layerGroup([
      L.tileLayer(esri("Canvas/World_Light_Gray_Base"), { maxZoom: 19, maxNativeZoom: 16, attribution: "Base map © Esri, HERE, Garmin, © OpenStreetMap contributors" }),
      L.tileLayer(esri("Canvas/World_Light_Gray_Reference"), { maxZoom: 19, maxNativeZoom: 16, zIndex: 6 }),
    ]),
    [TOPO_BASE]: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17, subdomains: "abc",
      attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }),
    "Street map": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
    "Esri topographic": L.tileLayer(esri("World_Topo_Map"), { maxZoom: 19, attribution: "© Esri, HERE, Garmin, © OpenStreetMap contributors" }),
    Satellite: L.tileLayer(esri("World_Imagery"), { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }),
  };
  const linesLayer = L.layerGroup().addTo(map);
  const sitesLayer = L.layerGroup().addTo(map);
  let currentBase = bases[store.get("baseLayer", "")] ? store.get("baseLayer", "") : LIGHT_BASE;
  bases[currentBase].addTo(map);
  L.control.layers(bases, { "Line-of-sight lines": linesLayer, Repeaters: sitesLayer }, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  map.on("baselayerchange", (e) => { currentBase = e.name; store.set("baseLayer", e.name); });

  // ---------- Terrain overlays (contours, elevation colours, hillshade) ----------
  const terrainPrefs = Object.assign({ contours: true, tint: true, shade: true, strength: 0.55 }, store.get("terrain", {}));
  const terrain = {
    contours: TerrainLayers.contours(),
    tint: TerrainLayers.tint(terrainPrefs.strength),
    shade: TerrainLayers.hillshade(),
  };
  const TerrainControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const el = L.DomUtil.create("div", "leaflet-bar terrain-ctl");
      el.innerHTML = `
        <button type="button" class="tc-head" aria-expanded="true">Terrain <span aria-hidden="true">▾</span></button>
        <div class="tc-body">
          <div class="tc-presets">
            <button type="button" data-preset="focus">Terrain focus</button>
            <button type="button" data-preset="topo" class="ghost">Topo map</button>
          </div>
          <label><input type="checkbox" data-layer="contours"> Contours <span class="tc-iv"></span></label>
          <label><input type="checkbox" data-layer="tint"> Elevation colours</label>
          <label><input type="checkbox" data-layer="shade"> Hillshade</label>
          <label class="tc-strength">Colour strength <input type="range" min="0.2" max="0.9" step="0.05"></label>
          <div class="tc-ramp" style="background:${TerrainLayers.legendGradient()}"></div>
          <div class="tc-ramp-labels"><span>0</span><span>250</span><span>500</span><span>750</span><span>1000 m</span></div>
        </div>`;
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    },
  });
  const terrainCtl = new TerrainControl().addTo(map);
  const tcEl = terrainCtl.getContainer();

  function applyTerrain() {
    for (const [k, layer] of Object.entries(terrain)) {
      terrainPrefs[k] ? layer.addTo(map) : layer.remove();
      tcEl.querySelector(`[data-layer="${k}"]`).checked = terrainPrefs[k];
    }
    terrain.tint.setOpacity(terrainPrefs.strength);
    tcEl.querySelector(".tc-strength input").value = terrainPrefs.strength;
    tcEl.querySelector(".tc-strength").hidden = !terrainPrefs.tint;
    tcEl.querySelector(".tc-ramp").hidden = tcEl.querySelector(".tc-ramp-labels").hidden = !terrainPrefs.tint;
    store.set("terrain", terrainPrefs);
  }
  const showInterval = () => {
    tcEl.querySelector(".tc-iv").textContent = `every ${TerrainLayers.interval(Math.min(map.getZoom(), 15))} m`;
  };
  function setBase(name) {
    if (name === currentBase) return;
    map.removeLayer(bases[currentBase]);
    bases[name].addTo(map);
    currentBase = name;
    store.set("baseLayer", name);
  }
  tcEl.querySelectorAll("[data-layer]").forEach((cb) =>
    cb.addEventListener("change", () => { terrainPrefs[cb.dataset.layer] = cb.checked; applyTerrain(); }));
  tcEl.querySelector(".tc-strength input").addEventListener("input", (e) => { terrainPrefs.strength = +e.target.value; applyTerrain(); });
  tcEl.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
    const focus = b.dataset.preset === "focus";
    setBase(focus ? LIGHT_BASE : TOPO_BASE);
    Object.assign(terrainPrefs, { contours: focus, tint: focus, shade: focus });
    applyTerrain();
  }));
  const setPanelOpen = (open) => {
    tcEl.classList.toggle("collapsed", !open);
    tcEl.querySelector(".tc-head").setAttribute("aria-expanded", String(open));
  };
  tcEl.querySelector(".tc-head").addEventListener("click", () => setPanelOpen(tcEl.classList.contains("collapsed")));
  setPanelOpen(!window.matchMedia("(max-width: 820px)").matches);
  applyTerrain();

  const onZoom = () => {
    showInterval();
    document.body.classList.toggle("compact-labels", map.getZoom() < 9);
  };
  map.on("zoomend", onZoom);
  onZoom();

  // ---------- Sites (repeaters sharing one location) ----------
  let sites = new Map();
  function buildSites() {
    for (const s of sites.values()) { s.marker.remove(); s.line && s.line.remove(); }
    sites = new Map();
    for (const r of repeaters) {
      if (!sites.has(r.siteKey)) {
        const o = overrides[r.siteKey];
        sites.set(r.siteKey, {
          key: r.siteKey, lat: o ? o.lat : r.lat, lon: o ? o.lon : r.lon, moved: !!o,
          site: r.site, locator: r.locator, groundElev: r.groundElev, position: r.position,
          repeaters: [], prof: null, status: "pending",
        });
      }
      const s = sites.get(r.siteKey);
      s.repeaters.push(r);
      r.siteObj = s;
    }
    for (const s of sites.values()) createMarker(s);
  }

  const siteIcon = (status, dragging) =>
    L.divIcon({ className: `site-icon ${status}${dragging ? " dragging" : ""}`, html: "<span></span>", iconSize: [14, 14], iconAnchor: [7, 7] });

  function createMarker(s) {
    s.iconStatus = "pending";
    s.marker = L.marker([s.lat, s.lon], { icon: siteIcon("pending"), title: s.site, riseOnHover: true });
    s.marker.bindTooltip("", { permanent: true, direction: "right", offset: [8, 0], className: "call-label" });
    s.marker.bindPopup(() => popupHtml(s), { maxWidth: 380, autoPanPaddingBottomRight: [20, 320] });
    s.marker.on("popupopen", (e) => wirePopup(s, e.popup.getElement()));
    s.marker.on("dragend", () => moveSite(s, s.marker.getLatLng()));
  }

  // ---------- Filtering ----------
  function visible(r) {
    if (!state.bands.has(r.band)) return false;
    if (r.offAir && !state.showOff) return false;
    if (state.mode && !r.modes.includes(state.mode)) return false;
    if (state.chirpOnly && state.chirp && !state.chirp.has(r.id)) return false;
    if (r.an && !state.statuses.has(r.an.status)) return false;
    if (state.home && state.maxDist < 500 && r.siteObj.dist > state.maxDist * 1000) return false;
    if (state.text) {
      const hay = [r.callsign, r.site, r.locator, r.modes.join(" "), r.notes.join(" "), r.output].join(" ").toLowerCase();
      if (!state.text.toLowerCase().split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    return true;
  }

  // ---------- Rendering ----------
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    const shown = [];
    const counts = { good: 0, workable: 0, unlikely: 0 };
    for (const s of sites.values()) {
      const vis = s.repeaters.filter(visible);
      s.visible = vis;
      if (!vis.length) {
        sitesLayer.removeLayer(s.marker);
        s.line && linesLayer.removeLayer(s.line);
        continue;
      }
      shown.push(...vis);
      vis.forEach((r) => r.an && counts[r.an.status]++);
      const status = vis.reduce((best, r) => (RANK[r.an?.status ?? "pending"] < RANK[best] ? r.an?.status ?? "pending" : best), "pending");
      s.status = status;
      if (s.iconStatus !== status) { s.marker.setIcon(siteIcon(status, s.marker.dragging?.enabled())); s.iconStatus = status; }
      const calls = vis.map((r) => r.callsign);
      s.marker.setTooltipContent(`${esc(calls[0])}<span class="extra">${calls.length > 1 ? " · " + calls.slice(1).map(esc).join(" · ") : ""}</span>`);
      sitesLayer.addLayer(s.marker);

      if (state.home) {
        const weak = status === "unlikely";
        const style = { color: css(`--${status}`), weight: weak ? 1.5 : 2.5, opacity: weak ? 0.55 : 0.85, dashArray: weak ? "4 6" : null };
        if (!s.line) {
          s.line = L.polyline([], style).on("click", () => openProfile(s));
          s.line.bindTooltip("", { sticky: true });
        }
        s.line.setLatLngs([[state.home.lat, state.home.lon], [s.lat, s.lon]]).setStyle(style);
        s.line.setTooltipContent(`${esc(calls.join(", "))} · ${(s.dist / 1000).toFixed(1)} km · ${LABEL[status]}`);
        if (weak && !state.showUnlikelyLines) linesLayer.removeLayer(s.line);
        else linesLayer.addLayer(s.line);
      } else if (s.line) linesLayer.removeLayer(s.line);
    }
    document.body.classList.toggle("hide-labels", !state.labels);
    renderList(shown);
    $("summary").innerHTML = state.home
      ? STATUSES.map((k) => `<span><b>${counts[k]}</b> ${LABEL[k].toLowerCase()}</span>`).join("")
      : "<span>Set your location to check line of sight.</span>";
  }

  function renderList(shown) {
    const by = state.home ? state.sort : "freq";
    const sig = (r) => (r.an ? r.an.rxDbm : -Infinity); // still-analysing rows sink to the bottom
    shown.sort((a, b) =>
      (by === "signal" ? sig(b) - sig(a) : by === "distance" ? a.siteObj.dist - b.siteObj.dist : 0) || a.output - b.output);
    $("listTitle").textContent = `Repeaters (${shown.length})`;
    $("list").innerHTML = shown.map((r, idx) => {
      const s = r.siteObj;
      const st = r.an?.status ?? "pending";
      const dir = state.home ? `${(s.dist / 1000).toFixed(1)} km ${Geo.compass(s.brg)}` : "";
      // Bar spans -130 dBm (empty) to -60 dBm (full).
      const pct = r.an ? Math.max(2, Math.min(100, ((r.an.rxDbm + 130) / 70) * 100)) : 0;
      const signal = r.an
        ? `<span class="signal"><span class="rank">#${idx + 1}</span><span class="bar"><i class="${st}" style="width:${pct.toFixed(0)}%"></i></span>` +
          `<span class="dbm">${Math.round(r.an.rxDbm)} dBm · ${r.an.sMeter}</span></span>`
        : "";
      const off = r.offset ? `${r.offset > 0 ? "+" : "−"}${Math.abs(r.offset)}` : "simplex";
      const tone = r.ctcss ? ` · ${r.ctcss} Hz` : "";
      const modes = r.modes.map((m) => `<span class="badge">${esc(m)}</span>`).join("");
      return `<li data-id="${esc(r.id)}" tabindex="0">
        <span><span class="call">${esc(r.callsign)}</span>${modes}${r.offAir ? '<span class="badge">off-air</span>' : ""}</span>
        <span>${state.home ? `<span class="pill ${st}">${LABEL[st]}</span>` : ""}</span>
        <span class="freq">${mhz(r.output)} MHz ${off}${tone}</span>
        <span class="dist">${dir}</span>
        ${signal}
        <span class="meta">${esc(r.site)} · ${esc(r.locator)} · ${Math.round(r.groundElev ?? 0)} m ASL</span>
      </li>`;
    }).join("");
  }

  $("list").addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const r = repeaters.find((x) => x.id === li.dataset.id);
    focusRepeater(r);
  });
  $("list").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("li")) e.target.click();
  });

  function focusRepeater(r) {
    const s = r.siteObj;
    map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), 10), { duration: 0.6 });
    map.once("moveend", () => s.marker.openPopup());
    if (state.home) openProfile(s, r);
    $("sidebar").classList.remove("open");
  }

  // ---------- Popup ----------
  function popupHtml(s) {
    const ground = s.prof ? s.prof.ground[s.prof.ground.length - 1] : s.groundElev;
    const rows = s.repeaters.map((r) => {
      const st = r.an?.status ?? "pending";
      const inp = r.offset ? mhz(r.input) : "simplex";
      return `<tr>
        <td><b class="mono">${esc(r.callsign)}</b><br><span class="muted">${esc(r.modes.join(", "))}${r.offAir ? " · off-air" : ""}</span></td>
        <td class="mono">${mhz(r.output)}<br><span class="muted">in ${inp}</span></td>
        <td>${esc(r.access || (r.ctcss ? r.ctcss + " Hz" : "—"))}</td>
        <td>${state.home ? `<span class="pill ${st}">${LABEL[st]}</span>` : ""}</td>
      </tr>${r.notes.length ? `<tr><td colspan="4" class="muted">${r.notes.map(esc).join(" · ")}</td></tr>` : ""}`;
    }).join("");
    const where = state.home
      ? `<div>${(s.dist / 1000).toFixed(1)} km from home, bearing ${Math.round(s.brg)}° (${Geo.compass(s.brg)})</div>`
      : "";
    return `<div class="pop">
      <h3>${esc(s.site)}</h3>
      <div class="muted">${esc(s.locator)} · ground ${Math.round(ground ?? 0)} m ASL · antenna ≈ ${Math.round((ground ?? 0) + state.settings.rxAgl)} m ASL</div>
      <div class="muted">Position: ${s.moved ? "adjusted by you" : esc(s.position)}</div>
      ${where}
      <table><tr><th>Call</th><th>MHz</th><th>Access</th><th>Signal</th></tr>${rows}</table>
      <div class="actions">
        ${state.home ? '<button data-act="profile">Elevation profile</button>' : ""}
        <button class="ghost" data-act="move">${s.marker.dragging?.enabled() ? "Done moving" : "Move site"}</button>
        ${s.moved ? '<button class="ghost" data-act="reset">Reset position</button>' : ""}
      </div>
    </div>`;
  }

  function wirePopup(s, el) {
    el.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "profile") openProfile(s);
      if (act === "move") {
        const on = !s.marker.dragging.enabled();
        on ? s.marker.dragging.enable() : s.marker.dragging.disable();
        s.marker.setIcon(siteIcon(s.status, on));
        s.marker.closePopup();
        if (on) $("cursor").textContent = `Drag ${s.repeaters[0].callsign} to its real site`;
      }
      if (act === "reset") {
        delete overrides[s.key];
        store.set("siteOverrides", overrides);
        const r = s.repeaters[0];
        moveSite(s, { lat: r.lat, lng: r.lon }, true);
      }
    }));
  }

  function moveSite(s, ll, reset) {
    s.lat = ll.lat; s.lon = ll.lng; s.moved = !reset;
    if (!reset) { overrides[s.key] = { lat: s.lat, lon: s.lon }; store.set("siteOverrides", overrides); }
    s.marker.dragging.disable();
    s.marker.setLatLng([s.lat, s.lon]).setIcon(siteIcon(s.status));
    computeSite(s);
  }

  // ---------- Line-of-sight computation ----------
  function analyseSite(s) {
    for (const r of s.repeaters) {
      r.an = LOS.analyse(s.prof, { ...state.settings, freqMHz: r.output });
    }
  }

  async function computeSite(s, run = state.run) {
    if (!state.home) return;
    s.dist = Geo.distance(state.home, s);
    s.brg = Geo.bearing(state.home, s);
    s.prof = null;
    s.repeaters.forEach((r) => (r.an = null));
    scheduleRender();
    const prof = await LOS.profile(state.home, s);
    if (run !== state.run) return;
    s.prof = prof;
    analyseSite(s);
    scheduleRender();
    if (state.profileFor?.s === s) openProfile(s, state.profileFor.r);
  }

  async function recompute() {
    const run = ++state.run;
    if (!state.home) { scheduleRender(); return; }
    const queue = [...sites.values()];
    for (const s of queue) {
      s.dist = Geo.distance(state.home, s);
      s.brg = Geo.bearing(state.home, s);
      s.prof = null;
      s.repeaters.forEach((r) => (r.an = null));
    }
    queue.sort((a, b) => a.dist - b.dist);
    render();
    let done = 0;
    const total = queue.length;
    $("progress").textContent = `Analysing terrain 0/${total}`;
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        const prof = await LOS.profile(state.home, s);
        if (run !== state.run) return;
        s.prof = prof;
        analyseSite(s);
        done++;
        $("progress").textContent = done < total ? `Analysing terrain ${done}/${total}` : "";
        scheduleRender();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (run === state.run && state.profileFor) openProfile(state.profileFor.s, state.profileFor.r);
  }

  function reanalyse() {
    for (const s of sites.values()) if (s.prof) analyseSite(s);
    scheduleRender();
    if (state.profileFor) openProfile(state.profileFor.s, state.profileFor.r);
  }

  // ---------- Elevation profile panel ----------
  let hoverDot = null;
  async function openProfile(s, r) {
    if (!state.home) return;
    r = r || (s.visible && s.visible[0]) || s.repeaters[0];
    state.profileFor = { s, r };
    $("profilePanel").hidden = false;
    document.body.classList.add("has-profile");
    $("profTitle").innerHTML = `${esc(r.callsign)} · ${esc(s.site)} <span class="pill pending">loading</span>`;
    $("profStats").textContent = "";
    if (!s.prof) { await computeSite(s); return; }
    const an = r.an || LOS.analyse(s.prof, { ...state.settings, freqMHz: r.output });
    const others = s.repeaters.length > 1
      ? " " + s.repeaters.filter((x) => x !== r).map((x) => `<button class="ghost chip" data-id="${esc(x.id)}">${esc(x.callsign)}</button>`).join(" ")
      : "";
    $("profTitle").innerHTML = `${esc(r.callsign)} · ${esc(s.site)} <span class="pill ${an.status}">${LABEL[an.status]}</span>${others}`;
    $("profTitle").querySelectorAll("button[data-id]").forEach((b) =>
      b.addEventListener("click", () => openProfile(s, repeaters.find((x) => x.id === b.dataset.id))));
    const st = state.settings;
    $("profStats").innerHTML = [
      `${(s.prof.D / 1000).toFixed(1)} km at ${Math.round(s.brg)}° ${Geo.compass(s.brg)}`,
      `you ${Math.round(an.txAsl)} m → repeater ${Math.round(an.rxAsl)} m ASL`,
      `${LOS_TEXT[an.los]} (clearance ${an.minClear >= 0 ? "+" : ""}${Math.round(an.minClear)} m)`,
    ].join(" · ") + "<br>" + [
      `<b>Est. ${Math.round(an.rxDbm)} dBm (${an.sMeter}) at repeater</b>`,
      `distance loss ${an.fspl.toFixed(0)} dB + hills ${an.diffLoss.toFixed(0)} dB + extra ${st.extraLoss} dB`,
      `${st.powerW} W, ${st.gainDbi} dBi @ ${r.output} MHz`,
    ].join(" · ");
    requestAnimationFrame(() => Profile.draw($("profCanvas"), s.prof, an));
  }

  $("profClose").addEventListener("click", () => {
    $("profilePanel").hidden = true;
    document.body.classList.remove("has-profile");
    state.profileFor = null;
    hoverDot && hoverDot.remove();
  });
  $("profCanvas").addEventListener("mousemove", (e) => {
    const pt = Profile.redraw(e.offsetX);
    if (!pt) return;
    if (!hoverDot) hoverDot = L.circleMarker([0, 0], { radius: 6, color: "#fff", weight: 2, fillColor: css("--home"), fillOpacity: 1 });
    hoverDot.setLatLng([pt.lat, pt.lon]).addTo(map);
  });
  $("profCanvas").addEventListener("mouseleave", () => { Profile.redraw(null); hoverDot && hoverDot.remove(); });
  window.addEventListener("resize", () => Profile.redraw(null));

  // ---------- Home location ----------
  const houseSvg = '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path d="M12 2.5 1.5 11.6h3V21h5.8v-6h3.4v6h5.8v-9.4h3z" fill="currentColor" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const homeIcon = L.divIcon({ className: "home-icon", html: houseSvg, iconSize: [32, 32], iconAnchor: [16, 28] });
  let homeMarker = null;

  function setHome(lat, lon, fly) {
    state.home = { lat, lon };
    store.set("home", state.home);
    if (!homeMarker) {
      homeMarker = L.marker([lat, lon], { icon: homeIcon, draggable: true, zIndexOffset: 1000, title: "Home — drag to move" }).addTo(map);
      homeMarker.on("dragend", () => { const p = homeMarker.getLatLng(); setHome(p.lat, p.lng); });
    } else homeMarker.setLatLng([lat, lon]);
    if (fly) map.flyTo([lat, lon], Math.max(map.getZoom(), 9), { duration: 0.8 });
    $("homeInfo").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${Geo.toLocator(lat, lon)} · elevation …`;
    Terrain.elevation(lat, lon).then((h) => {
      if (state.home.lat === lat && state.home.lon === lon) {
        $("homeInfo").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${Geo.toLocator(lat, lon)} · ${Math.round(h)} m ASL`;
      }
    });
    recompute();
  }

  map.on("contextmenu", (e) => setHome(e.latlng.lat, e.latlng.lng));
  map.on("click", (e) => {
    if (!state.picking) return;
    setPicking(false);
    setHome(e.latlng.lat, e.latlng.lng);
  });
  function setPicking(on) {
    state.picking = on;
    document.body.classList.toggle("picking", on);
    $("pickBtn").classList.toggle("active", on);
    $("pickBtn").textContent = on ? "Click the map…" : "Pick on map";
    if (on) $("sidebar").classList.remove("open");
  }
  $("pickBtn").addEventListener("click", () => setPicking(!state.picking));

  $("locateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { $("homeInfo").textContent = "This browser can't share its location."; return; }
    $("homeInfo").textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(
      (p) => setHome(p.coords.latitude, p.coords.longitude, true),
      (err) => {
        const why = err.code === err.PERMISSION_DENIED
          ? "Location access is blocked. Allow it in your browser's site settings (and for the browser in your system's location settings), then try again"
          : err.code === err.TIMEOUT ? "Finding your location timed out" : "Your location isn't available right now";
        $("homeInfo").textContent = `${why}. Or search for your town, or right-click the map.`;
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });

  $("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("searchInput").value.trim();
    if (!q) return;
    $("homeInfo").textContent = `Searching for “${q}”…`;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ie,gb&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const [hit] = await res.json();
      if (!hit) { $("homeInfo").textContent = `Nothing found for “${q}”. Check the spelling, or right-click the map.`; return; }
      setHome(+hit.lat, +hit.lon, true);
    } catch {
      $("homeInfo").textContent = "Search is unavailable right now. Right-click the map to set your location.";
    }
  });

  // ---------- Cursor elevation readout ----------
  let cursorTimer = null, cursorSeq = 0;
  map.on("mousemove", (e) => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(async () => {
      const seq = ++cursorSeq;
      const { lat, lng } = e.latlng;
      const head = `${lat.toFixed(5)}, ${lng.toFixed(5)} · ${Geo.toLocator(lat, lng)}`;
      $("cursor").textContent = `${head} · …`;
      const h = await Terrain.elevation(lat, lng);
      if (seq === cursorSeq) $("cursor").textContent = `${head} · ${Math.round(h)} m`;
    }, 80);
  });

  // ---------- Station settings ----------
  const SETTING_IDS = ["txAgl", "rxAgl", "powerW", "gainDbi", "extraLoss", "kFactor"];
  for (const id of SETTING_IDS) $(id).value = String(state.settings[id === "kFactor" ? "k" : id]);
  const num = (id, lo, fallback) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.max(lo, v) : fallback; };
  for (const id of SETTING_IDS) {
    $(id).addEventListener("change", () => {
      state.settings = {
        txAgl: num("txAgl", 0, 3),
        rxAgl: num("rxAgl", 0, 15),
        powerW: num("powerW", 0.1, 5),
        gainDbi: num("gainDbi", -20, 0),
        extraLoss: num("extraLoss", 0, 10),
        k: +$("kFactor").value,
      };
      store.set("settings", state.settings);
      reanalyse();
    });
  }

  // ---------- Filters ----------
  function chip(label, pressed, color, onToggle) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("aria-pressed", String(pressed));
    b.innerHTML = (color ? `<i style="background:var(${color})"></i>` : "") + esc(label);
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      onToggle(on);
      scheduleRender();
    });
    return b;
  }
  for (const band of BANDS) {
    $("bandChips").append(chip(band, true, null, (on) => (on ? state.bands.add(band) : state.bands.delete(band))));
  }
  for (const st of STATUSES) {
    $("statusChips").append(chip(LABEL[st], true, `--${st}`, (on) => (on ? state.statuses.add(st) : state.statuses.delete(st))));
  }
  $("sortSel").value = state.sort;
  $("sortSel").addEventListener("change", (e) => { state.sort = e.target.value; store.set("sort", state.sort); scheduleRender(); });
  $("modeSel").addEventListener("change", (e) => { state.mode = e.target.value; scheduleRender(); });
  $("maxDist").addEventListener("input", (e) => {
    state.maxDist = +e.target.value;
    $("maxDistOut").textContent = state.maxDist >= 500 ? "any" : `${state.maxDist} km`;
    scheduleRender();
  });
  $("textFilter").addEventListener("input", (e) => { state.text = e.target.value.trim(); scheduleRender(); });
  $("showOff").addEventListener("change", (e) => { state.showOff = e.target.checked; scheduleRender(); });
  $("showUnlikelyLines").addEventListener("change", (e) => { state.showUnlikelyLines = e.target.checked; scheduleRender(); });
  $("showLabels").addEventListener("change", (e) => { state.labels = e.target.checked; scheduleRender(); });
  $("chirpOnly").addEventListener("change", (e) => { state.chirpOnly = e.target.checked; scheduleRender(); });

  // ---------- CHIRP import / export ----------
  $("dbInfo").textContent = `${DB.repeaters.length} repeaters from the IRTS list (snapshot ${DB.updated}).` +
    " Import your CHIRP file to highlight your channels, or a CSV with lat/lon columns to add your own.";

  function showImport(res) {
    const parts = [`<b>${res.matched.length}</b> channels matched to known repeaters`];
    if (res.added.length) parts.push(`<b>${res.added.length}</b> added from lat/lon columns`);
    if (res.unmatched.length) {
      parts.push(`<b>${res.unmatched.length}</b> not found (${res.unmatched.slice(0, 8).map((c) => esc(c.name)).join(", ")}${res.unmatched.length > 8 ? "…" : ""})`);
    }
    const diffs = res.matched.filter(({ channel: c, repeater: r }) =>
      (c.freq && Math.abs(c.freq - r.output) > 0.0011) || (c.tone && r.ctcss && Math.abs(c.tone - r.ctcss) > 0.05));
    if (diffs.length) {
      parts.push("Check these against IRTS: " + diffs.map(({ channel: c, repeater: r }) =>
        `${esc(r.callsign)} (yours ${c.freq} MHz${c.tone ? ` / ${c.tone} Hz` : ""}, IRTS ${r.output} MHz${r.ctcss ? ` / ${r.ctcss} Hz` : ""})`).join("; "));
    }
    $("importInfo").innerHTML = parts.join(". ") + ".";
    $("importInfo").hidden = false;
  }

  $("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const res = Chirp.importCSV(await file.text(), repeaters);
    if (res.added.length) {
      const added = store.get("addedRepeaters", []).concat(res.added);
      store.set("addedRepeaters", added);
      repeaters = repeaters.concat(res.added.map(withId));
      buildSites();
    }
    const ids = new Set(res.matched.map((m) => m.repeater.id));
    res.added.forEach((r) => ids.add(`${r.callsign}@${r.output}`));
    state.chirp = ids;
    store.set("chirpIds", [...ids]);
    showImport(res);
    $("chirpOnlyWrap").hidden = false;
    $("chirpOnly").checked = state.chirpOnly = true;
    e.target.value = "";
    res.added.length ? recompute() : scheduleRender();
  });

  $("exportBtn").addEventListener("click", () => {
    const items = repeaters.filter((r) => r.siteObj.visible?.includes(r))
      .sort((a, b) => !state.home ? a.output - b.output
        : state.sort === "signal" ? (b.an?.rxDbm ?? -Infinity) - (a.an?.rxDbm ?? -Infinity)
        : a.siteObj.dist - b.siteObj.dist)
      .map((r) => ({
        r,
        comment: state.home
          ? `${r.site} ${(r.siteObj.dist / 1000).toFixed(0)}km ${r.an ? `${Math.round(r.an.rxDbm)}dBm ${LABEL[r.an.status]}` : ""}`.trim()
          : r.site,
      }));
    const blob = new Blob([Chirp.exportCHIRP(items)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "irish-repeaters-chirp.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- Mobile panel ----------
  $("sidebarToggle").addEventListener("click", () => $("sidebar").classList.toggle("open"));

  // ---------- Start ----------
  buildSites();
  if (state.chirp) { $("chirpOnlyWrap").hidden = false; }
  if (state.home) {
    map.setView([state.home.lat, state.home.lon], 8);
    setHome(state.home.lat, state.home.lon);
  } else render();
})();
