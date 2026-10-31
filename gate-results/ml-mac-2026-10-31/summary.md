# MapLibre example gate, Mac real GPU (WebGPU), 2026-10-31

main @ 30e1caef, ref r7, baseline o1023f (2026-10-23), new run o1031, graded without --update. Replay only.
Gate result: no example fell below known.json.
Net misses: o1023f 333, o1031 1582. Exceptions/console errors: 3 and 3.

### o1023f summary

`{"levels":{"0 動かない":0,"1 動く":11,"2 同じ答え":47,"3 同じ絵":79,"分母の外":2},"n":137,"plainN":111,"plain3":62,"pictureOnly":80,"pictureN":122,"text":{"examples":96,"n":2422,"hit":2066,"ink":2080,"inkN":2171,"extra":482,"line":723,"lineHit":444,"linePlaced":789,"low":["display-buildings-in-3d","fill-extrusion-rounded-corners","fly-to-a-location-based-on-scroll-position","walk-around-a-map-in-first-person"]}}`

### o1031 summary

`{"levels":{"0 動かない":0,"1 動く":11,"2 同じ答え":47,"3 同じ絵":79,"分母の外":2},"n":137,"plainN":111,"plain3":62,"pictureOnly":80,"pictureN":122,"text":{"examples":96,"n":2422,"hit":2063,"ink":2080,"inkN":2171,"extra":485,"line":723,"lineHit":437,"linePlaced":789,"low":["display-buildings-in-3d","fill-extrusion-rounded-corners","fly-to-a-location-based-on-scroll-position","update-geojson-polygons","walk-around-a-map-in-first-person"]}}`

### Changed examples (o1023f → o1031)

| example | old level | new level | mean abs RGB diff | % px diff >40 | trigger |
|---|---|---|---|---|---|
| add-3d-terrain-from-quantized-mesh-tiles | 2 | 2 | 42.49 | 42.18 | picture |
| 3d-terrain | 2 | 2 | 19.10 | 14.07 | picture |
| adding-3d-models-using-threejs-on-terrain | 2 | 2 | 15.76 | 11.15 | picture |
| animate-map-camera-around-a-point | 1 | 1 | 5.69 | 5.16 | picture |
| elevate-symbols-above-the-terrain | 2 | 2 | 9.00 | 4.88 | picture |
| animate-a-series-of-images | 2 | 2 | 3.98 | 4.10 | picture |
| display-a-hybrid-satellite-map-with-terrain-elevation | 2 | 2 | 5.49 | 0.22 | picture |

Canvas missing in one run: none

## WebGL2 (o1031gl2)

The o1012gl2 baseline holds only sky-fog-terrain (level 2; o1031gl2 also level 2), so it can't serve as a full comparison. The table below compares o1031 (WebGPU, 'before') with o1031gl2 (WebGL2, 'after') on the same commit; it shows backend differences, not change over time. Images are in gl2/.
Against known.json, GL2 fell on add-a-new-layer-below-labels 3→2 and use-a-fallback-image 3→2, and rose on display-a-popup-on-click, display-a-popup-on-hover and measure-distances 2→3.

Summary: {"0 動かない": 0, "1 動く": 11, "2 同じ答え": 46, "3 同じ絵": 80, "分母の外": 2}

### Changed examples (o1031 → o1031gl2)

| example | old level | new level | mean abs RGB diff | % px diff >40 | trigger |
|---|---|---|---|---|---|
| add-a-new-layer-below-labels | 3 | 2 | 1.72 | 1.33 | level |
| use-a-fallback-image | 3 | 2 | 1.29 | 1.05 | level |
| customize-the-map-transform-constrain | 1 | 1 | 213.39 | 96.58 | picture |
| sky-fog-terrain | 2 | 2 | 19.92 | 20.48 | picture |
| display-a-hybrid-satellite-map-with-terrain-elevation | 2 | 2 | 11.78 | 9.72 | picture |
| variable-label-placement | 2 | 2 | 7.83 | 5.92 | picture |
| variable-label-placement-with-offset | 2 | 2 | 7.83 | 5.91 | picture |
| filter-symbols-by-text-input | 2 | 2 | 7.51 | 5.61 | picture |
| filter-symbols-by-toggling-a-list | 2 | 2 | 7.22 | 5.36 | picture |
| create-deckgl-layer-using-rest-api | 3 | 3 | 10.73 | 5.13 | picture |
| fit-to-the-bounds-of-a-linestring | 3 | 3 | 7.04 | 4.65 | picture |
| display-buildings-in-3d | 2 | 2 | 14.61 | 4.51 | picture |
| create-a-gradient-dashed-line-using-an-expression | 3 | 3 | 6.68 | 4.31 | picture |
| create-a-gradient-line-using-an-expression | 3 | 3 | 6.66 | 4.30 | picture |
| fly-to-a-location-based-on-scroll-position | 3 | 3 | 6.93 | 4.07 | picture |
| animate-map-camera-around-a-point | 1 | 1 | 14.99 | 3.98 | picture |
| change-a-layers-color-with-buttons | 3 | 3 | 4.57 | 3.59 | picture |
| fill-extrusion-rounded-corners | 1 | 1 | 8.74 | 3.14 | picture |
| use-locally-generated-ideographs | 3 | 3 | 4.42 | 3.07 | picture |
| change-the-case-of-labels | 2 | 2 | 4.47 | 3.04 | picture |
| add-a-default-marker | 3 | 3 | 2.98 | 3.04 | picture |
| jump-to-a-series-of-locations | 3 | 3 | 4.21 | 2.94 | picture |
| geocode-with-nominatim | 3 | 3 | 3.98 | 2.80 | picture |
| restrict-map-panning-to-an-area | 3 | 3 | 3.63 | 2.64 | picture |
| add-a-cog-raster-source | 1 | 1 | 10.72 | 2.64 | picture |
| fit-a-map-to-a-bounding-box | 3 | 3 | 4.43 | 2.27 | picture |
| fly-to-a-location | 3 | 3 | 4.43 | 2.27 | picture |
| slowly-fly-to-a-location | 3 | 3 | 4.43 | 2.27 | picture |
| add-a-vector-tile-source | 3 | 3 | 4.12 | 2.25 | picture |
| view-a-fullscreen-map | 3 | 3 | 3.52 | 2.18 | picture |
| navigate-the-map-with-game-like-controls | 1 | 1 | 4.66 | 1.34 | picture |
| measure-distances | 2 | 3 | 8.47 | 5.87 | level+picture |
| display-a-popup-on-click | 2 | 3 | 7.51 | 5.58 | level+picture |
| display-a-popup-on-hover | 2 | 3 | 7.35 | 5.46 | level+picture |

Canvas missing in one run: none

## Findings

- Net misses rose from 333 to 1582. Bisect (draw-a-circle, add-a-hillshade-layer, add-a-wms-source) points to 53333145, which fetches ancestors three levels up (preloadAncestors). Those tiles are not in r7, and each failed tile is retried, so the replay count overstates real extra requests. Only the three bisected examples tie directly to this commit.
- The ref for the terrain examples shows OSM "Access blocked" tiles while ortho shows a mix of blocked and real map tiles, so these pictures can't be compared to ref pixel for pixel.
- Not landed: experiment-far-merge/raster.patch merges far tiles first when over the texture budget. Near-field tile scale in add-3d-terrain-from-quantized-mesh-tiles moved close to ref, but 3d-terrain lost its map and went blurry in all three replay runs. Replay can't separate a real fault from tiles missing in r7, so the patch is unverified.
