// Terrain elevation from Mapzen/AWS "Terrarium" tiles (free, CORS-enabled).
// Each PNG pixel encodes metres as (R * 256 + G + B / 256) - 32768.
(function () {
  const TILE_URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
  const ZOOM = 10; // ~95 m per pixel at Irish latitudes, close to the source DEM resolution
  const SIZE = 256;
  const MAX_TILES = 256; // decoded tiles kept in memory (~256 KB each)
  const tiles = new Map(); // "z/x/y" -> Promise<Float32Array|null>, in least-recently-used order

  // Decoded elevation grid for one tile, shared by line-of-sight and the map layers.
  function tile(z, x, y) {
    const n = 2 ** z;
    x = ((x % n) + n) % n;
    const key = `${z}/${x}/${y}`;
    if (tiles.has(key)) {
      const p = tiles.get(key);
      tiles.delete(key);
      tiles.set(key, p);
      return p;
    }
    const p = new Promise((resolve) => {
      if (y < 0 || y >= n) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = SIZE;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
        const out = new Float32Array(SIZE * SIZE);
        for (let i = 0; i < out.length; i++) {
          out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        }
        resolve(out);
      };
      img.onerror = () => resolve(null); // treat missing tiles as sea level
      img.src = TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    });
    tiles.set(key, p);
    if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
    return p;
  }

  // Fractional global pixel coordinates at ZOOM.
  function pixel(lat, lon) {
    const n = 2 ** ZOOM * SIZE;
    const s = Math.sin((lat * Math.PI) / 180);
    return {
      px: ((lon + 180) / 360) * n,
      py: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
    };
  }

  // Bilinear sample; the four neighbours may straddle tiles.
  async function elevation(lat, lon) {
    const { px, py } = pixel(lat, lon);
    const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5);
    const fx = px - 0.5 - x0, fy = py - 0.5 - y0;
    const v = await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(async ([dx, dy]) => {
      const gx = x0 + dx, gy = y0 + dy;
      const data = await tile(ZOOM, Math.floor(gx / SIZE), Math.floor(gy / SIZE));
      return data ? data[(((gy % SIZE) + SIZE) % SIZE) * SIZE + (((gx % SIZE) + SIZE) % SIZE)] : 0;
    }));
    const h = v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy) + v[2] * (1 - fx) * fy + v[3] * fx * fy;
    return Math.max(0, h); // clamp sea/bathymetry to the surface
  }

  function elevations(points) {
    return Promise.all(points.map((p) => elevation(p.lat, p.lon)));
  }

  const metresPerPixel = (lat, z = ZOOM) => (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

  window.Terrain = { SIZE, tile, elevation, elevations, metresPerPixel };
})();
