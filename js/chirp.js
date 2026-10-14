// CHIRP CSV import/export, plus generic repeater CSVs that carry lat/lon.
(function () {
  function parseCSV(text) {
    text = text.replace(/^﻿/, ""); // spreadsheet exports often start with a BOM
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f.trim())) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some((f) => f.trim())) rows.push(row);
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
  }

  const CALL = /\b([A-Z]{1,2}\d[A-Z0-9]{2,4})\b/i;
  const pick = (row, names) => {
    const key = Object.keys(row).find((k) => names.includes(k.toLowerCase()));
    return key ? row[key] : "";
  };

  // Returns { matched: [{channel, repeater}], added: [repeater], unmatched: [channel] }
  function importCSV(text, db) {
    const rows = parseCSV(text);
    const byCall = new Map(db.map((r) => [r.callsign, r]));
    const result = { matched: [], added: [], unmatched: [] };
    for (const row of rows) {
      const name = pick(row, ["name", "callsign", "call", "call sign", "channel name"]);
      const comment = pick(row, ["comment", "notes"]);
      const freq = parseFloat(pick(row, ["frequency", "output", "output freq", "freq", "receive frequency"]));
      const duplex = pick(row, ["duplex"]);
      const offsetField = parseFloat(pick(row, ["offset"])) || 0;
      // CHIRP: "+"/"-" shift by Offset; "split" puts the TX frequency in Offset; "" is simplex.
      // Other CSVs have no Duplex column and carry a signed offset.
      const offset = duplex === "+" ? offsetField : duplex === "-" ? -offsetField
        : duplex === "split" ? offsetField - freq : duplex ? 0 : offsetField;
      // CHIRP: "Tone" sends rToneFreq; "TSQL" sends and expects cToneFreq. Other CSVs: a ctcss/pl column.
      const toneMode = pick(row, ["tone"]);
      const tone = toneMode === "Tone" ? parseFloat(pick(row, ["rtonefreq"]))
        : toneMode === "TSQL" ? parseFloat(pick(row, ["ctonefreq"]))
        : parseFloat(pick(row, ["ctcss", "uplink tone", "pl"])) || parseFloat(toneMode) || null;
      const lat = parseFloat(pick(row, ["lat", "latitude"]));
      const lon = parseFloat(pick(row, ["lon", "lng", "long", "longitude"]));
      const call = ((name.match(CALL) || comment.match(CALL) || [])[1] || "").toUpperCase();
      const channel = { name: name || call || "?", freq, tone };
      let rep = call && byCall.get(call);
      if (!rep && freq) {
        // Fall back to a unique frequency match.
        const same = db.filter((r) => Math.abs(r.output - freq) < 0.0011);
        if (same.length === 1) rep = same[0];
      }
      if (rep) result.matched.push({ channel, repeater: rep });
      else if (Number.isFinite(lat) && Number.isFinite(lon) && freq) {
        result.added.push({
          callsign: call || name, output: freq, input: freq + offset, offset,
          band: freq < 50 ? "10m" : freq < 100 ? "4m" : freq < 200 ? "2m" : "70cm",
          ctcss: Number.isFinite(tone) ? tone : null, access: "", modes: ["FM"],
          site: pick(row, ["location", "site", "nearest city", "city"]) || "Imported", locator: Geo.toLocator(lat, lon),
          notes: comment ? [comment] : [], offAir: false, lat, lon, position: "from imported file",
        });
      } else result.unmatched.push(channel);
    }
    return result;
  }

  const HEAD = "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,RPT1CALL,RPT2CALL,DVCODE";
  const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

  // Analogue-capable repeaters only: digital-only systems need codeplug software.
  function exportCHIRP(items) {
    const lines = [HEAD];
    items.filter(({ r }) => r.modes.includes("FM")).forEach(({ r, comment }, i) => {
      const tone = r.ctcss ? r.ctcss.toFixed(1) : "88.5";
      lines.push([
        i + 1, r.callsign, r.output.toFixed(6), r.offset > 0 ? "+" : r.offset < 0 ? "-" : "",
        Math.abs(r.offset).toFixed(6), r.ctcss ? "Tone" : "", tone, tone, "023", "NN", "023", "Tone->Tone",
        "FM", "12.50", "", "50W", q(comment || r.site), "", "", "", "",
      ].join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  window.Chirp = { importCSV, exportCHIRP };
})();
