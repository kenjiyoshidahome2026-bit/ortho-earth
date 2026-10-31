# Labels fix 3693be07 (merged in #833)

Mac, real GPU. `before` = rdall (road fix without the labels fix, on c9a3b87e), `after` = o1031lbl, `main-o1031` = o1031. Replay of ref r7.

Levels: WebGPU 3:86 2:40 1:11, GL2 3:83 2:43 1:11. Same counts as before the labels fix, no example changed level.
Against known.json: WebGPU none lower, 7 higher. GL2 add-a-new-layer-below-labels 3->2, 5 higher.
Text measures, WebGPU, before -> after: near-anchor hit 2061 -> 2069, line-label overlap 431 -> 451. Measure only.

Page gates on 3693be07: verify:webgpu 107/107 PASS. verify:ui 6/186 failed; each also failed or passed irregularly without the fixes:

| page | full run | rerun 3693be07 | rerun e3bd5991 (before the road fix) |
|---|---|---|---|
| t-mlcompat?g=layers | FAIL | PASS | PASS |
| t-multimap | FAIL | FAIL | FAIL |
| t-multimap?v=sync | FAIL | FAIL, then PASS x3 | PASS, then PASS, PASS, FAIL |
| t-react | FAIL | FAIL | FAIL |
| t-googletiles | FAIL | FAIL | FAIL |
| t-pvoxel | FAIL | PASS | FAIL |

Round trip `setStyle(getStyle())` on use-a-fallback-image: minzoom stays 5.3587, dzApplied stays 1.3587, zoom stays 5, diff 0.232 / 0.190, orange pixels 27149 -> 27152. Live network.
Built-in style (createGlobe default) vs e3bd5991, at z5, z8, z11: 0.000 / 0.000.

## Pictures changed by the labels fix (before -> after)

| example | old level | new level | mean abs RGB diff | % px diff >40 | trigger |
|---|---|---|---|---|---|
| animate-map-camera-around-a-point | 1 | 1 | 27.88 | 30.35 | picture |
| create-deckgl-layer-using-rest-api | 3 | 3 | 6.71 | 4.50 | picture |
| change-a-maps-language | 3 | 3 | 5.79 | 3.64 | picture |
| animate-a-series-of-images | 2 | 2 | 3.16 | 3.27 | picture |
| fly-to-a-location-based-on-scroll-position | 3 | 3 | 3.08 | 3.01 | picture |
| add-a-custom-layer-with-tiles-to-a-globe | 2 | 2 | 2.76 | 2.49 | picture |
| variable-label-placement | 2 | 2 | 2.89 | 2.48 | picture |
| display-a-popup-on-click | 3 | 3 | 2.84 | 2.46 | picture |
| variable-label-placement-with-offset | 2 | 2 | 2.86 | 2.45 | picture |
| display-a-popup-on-hover | 3 | 3 | 2.78 | 2.40 | picture |
| filter-symbols-by-text-input | 3 | 3 | 2.77 | 2.40 | picture |
| fit-a-map-to-a-bounding-box | 3 | 3 | 2.59 | 2.37 | picture |
| fly-to-a-location | 3 | 3 | 2.59 | 2.37 | picture |
| slowly-fly-to-a-location | 3 | 3 | 2.59 | 2.37 | picture |
| filter-symbols-by-toggling-a-list | 3 | 3 | 2.68 | 2.32 | picture |
| display-and-style-rich-text-labels | 3 | 3 | 3.35 | 2.27 | picture |
| display-a-non-interactive-map | 3 | 3 | 2.63 | 2.03 | picture |

