# altpbf

> **Repo layout note** — development happens in the [ortho-earth monorepo](https://github.com/kenjiyoshidahome2026-bit/ortho-earth) (`packages/altpbf`); this standalone repo is a read-only mirror synced on each release. Issues are welcome here; patches land in the monorepo. / 開発はモノレポ側で行い、ここはリリースごとに同期される公開ミラーです（Issue歓迎・変更はモノレポへ）。

**A tiny binary format for elevation tiles.** Heights are stored as delta-coded SVarint grids compressed with deflate-raw, and decoded straight into an `Int16Array` — no intermediate JS arrays (a 5.7M-point tile decodes in ~21 ms / +12 MB instead of ~99 ms / +230 MB).

This is the elevation backbone of [ortho-earth](https://www.ortho-earth.com/): eight R90 tiles — **55 MB total — cover the entire planet**, cached once in IndexedDB and re-read with zero network. Everything runs in the browser. MIT.

```js
import { encode, decode, encodeName, decodeName, altpbf2png } from "altpbf";

// encode: an elevation grid → compressed binary (Blob-ready buffer)
const bin = await encode({
  name: encodeName(139, 35, 1),   // → "R01N035E139"  (1° tile at 35N 139E)
  source: "GSI DEM10B",
  lng: 139, lat: 35, range: 1,    // origin (bottom-left) and span in degrees
  width: 1200, height: 1200,
  data: heights,                  // Int16Array (or array) of meters, row-major
});

// decode: binary → { name, source, lng, lat, range, width, height, data: Int16Array }
const tile = await decode(new Blob([bin]));

// quick-look PNG (hypsometric tint by default, pass { colorMap } to restyle)
const png = await altpbf2png(new Blob([bin]), { size: 256 });
```

## Name scheme

`R{span:2}{N|S}{lat:3}{E|W}{lng:3}` — `R01N035E139` is the 1°×1° tile with its bottom-left corner at 35°N 139°E; `R90S090W180` is a 90° quadrant. `encodeName` / `decodeName` round-trip it.

## Scope

This package is the **format**: encode, decode, naming, preview. Data acquisition (which DEM, which bucket, which cache) is deliberately out of scope — bring your own tiles from GSI DEM10B, JAXA AW3D30, GEBCO or anywhere else, and store the results wherever you like. Runtime dependencies: `pbf`, `geopbf` (shared compression helpers). Requires `CompressionStream` (all evergreen browsers); `altpbf2png` additionally needs `OffscreenCanvas`.

## License

MIT. Technical notes: [ortho-earth.com/docs/altpbf.html](https://www.ortho-earth.com/docs/altpbf.html)
