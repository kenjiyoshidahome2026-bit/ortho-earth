# @ortho-earth/tile-formats

Tile-format plugins for [`@ortho-earth/core`](../ortho-core) — formats the core does not want as a
dependency. The core ships MVT (Mapbox Vector Tile) built in; this package adds:

| Format | Registered name | PMTiles `tileType` | Decoder |
|---|---|---|---|
| **MLT** — [MapLibre Tile](https://github.com/maplibre/maplibre-tile-spec), the column-oriented successor of MVT | `"mlt"` | `6` | [`@maplibre/mlt`](https://www.npmjs.com/package/@maplibre/mlt), loaded lazily on the first MLT tile |

Every format is one function, `decode(bytes, need?) → { [sourceLayer]: { extent, features } }`, returning the same
intermediate representation the MVT decoder returns, so everything downstream (build, labels, buildings, merge,
draw) is format-agnostic.

## Enable it in an app (build-time, recommended)

The core reads `"#tile-formats"` (a `package.json` `imports` slot, default: nothing extra). Point it at this
package's register module in your bundler:

```js
// vite.config.js
resolve: { alias: [{ find: "#tile-formats", replacement: "@ortho-earth/tile-formats/register" }] }
```

That registers `"mlt"` in every realm that decodes tiles (main thread and workers). Then tell the style which
sources are MLT, exactly as in MapLibre GL JS:

```json
{ "sources": { "omt": { "type": "vector", "tiles": ["https://…/{z}/{x}/{y}.mlt"], "encoding": "mlt" } } }
```

PMTiles archives need no declaration: the header's `tileType` (`6` = MLT) picks the decoder.
Without the alias, an `"encoding": "mlt"` source (or an MLT archive) draws nothing and the console says once:
`tile format "mlt" is not registered`.

## Programmatic use

```js
import { registerMLT, decodeMLT } from "@ortho-earth/tile-formats";
registerMLT();                       // same as the alias, for the realm you call it in
const layers = decodeMLT(bytes);     // → { [layer]: { extent, features } }, no registry involved
```

## Tools

- `scripts/mvt2mlt.mjs` — converts MVT tiles (a `{z}/{x}/{y}.pbf` directory or an MVT PMTiles) into `.mlt`
  tiles and a PMTiles archive with `tileType` 6. Development only; it is how the test fixtures and the
  browser comparison tiles are made.
- `node-hook` / `node-register` — `@maplibre/mlt` 1.3.0 ships extension-less relative imports that plain
  Node cannot resolve. Bundlers are fine; in Node use
  `node --import @ortho-earth/tile-formats/node-register script.mjs`.

## Notes

- Polygon rings come out in the order and orientation they were written (exterior, then its holes, then the
  next exterior). The engine classifies rings by winding, as it does for MVT and as MapLibre does for MLT, so an
  MLT converted from an MVT decodes to exactly the MVT's rings — same tile, same picture.
- `struct` (shared-dictionary) columns arrive as flat keys (`name:ja`, `name:en`), the same keys the MVT has.
  Nested (`MAP`) columns keep their object/array values; `["get", key, ["get", "map"]]` and `["at", …]` read them.
- 64-bit ids and integers are returned as `Number` (as the MVT decoder does).
- A layer the decoder cannot read is drawn empty with one warning; the other layers of the tile still draw.

## License

GPL-3.0-or-later ([LICENSE](LICENSE)), like the core. `@maplibre/mlt` is MIT OR Apache-2.0.
