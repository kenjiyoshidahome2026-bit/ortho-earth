# @ortho-earth/h3

H3 cells for [`@ortho-earth/globe`](../globe): the counterpart of deck.gl's `H3HexagonLayer` and `HexagonLayer`
(point binning), built on the globe's own layer path instead of a separate renderer.

- `cellsToGeoJSON(cells, props?)` — H3 cell ids (array, `Map(id → props)` or `{ id: props }`) → GeoJSON polygons.
  Cells crossing the antimeridian are kept as one polygon with longitudes extended past 180°.
- `binPoints(points, { res, weight })` — points (GeoJSON or `[{ lon, lat, props }]`) → `Map(cell → { h3, res, count, sum, mean, min, max })`.
  `weight` is a number, a property name, a function `(props) => number`, or a MapLibre expression (when `evalExpr` is passed).
- `resForZoom(zoom, { edgePx = 40 })` — the H3 resolution whose hexagon edge is about `edgePx` at that zoom (256px world).
- `createH3Layer(map, src, opts)` — what `map.addH3(src, opts)` calls: draws the cells with `addSource` / `addLayer`
  as a `fill` layer (plus an outline `line` layer) or a `fill-extrusion` layer, so terrain draping, LOD,
  `queryRenderedFeatures` and layer events work as for any layer.

```js
const h = await map.addH3(pointsGeoJSON, {
  id: "h3", res: "auto",                       // "auto" picks the resolution from the zoom and re-bins when it changes
  weight: "pop",
  paint: { "fill-color": ["interpolate", ["linear"], ["get", "sum"], 0, "#ffffb2", 1e5, "#bd0026"], "fill-opacity": 0.7 },
  extrude: { height: ["*", ["get", "count"], 50] },   // optional: fill-extrusion instead of fill
});
h.setData(newPoints); h.setPaint({ "fill-opacity": 0.4 }); h.setRes(6); h.cells; h.geojson; h.remove();
```

`h3-js` is the only dependency; the globe imports this package lazily, so it costs nothing until `map.addH3` is called.

Tests: `node tests/t-h3.mjs` (pure functions and the layer handle against a fake map), `packages/globe/tests/t-h3.html` (real rendering).

## License

GPL-3.0-or-later, like the rest of ortho-earth.
