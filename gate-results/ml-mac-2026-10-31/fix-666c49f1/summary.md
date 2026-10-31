# Fix candidate 666c49f1 (raster coarse ancestors use leftover budget only)

Mac, real GPU (WebGPU). main = 30e1caef. Replay of ref r7 for the MapLibre gate; `before` = o1023f, `main` = o1031, `fix` = o1031fix.
Levels are unchanged and known.json holds. Each cell is mean abs RGB diff / % pixels differing by more than 40.

## MapLibre

| example | level o1023f/main/fix | main vs o1023f (mean / %>40) | fix vs o1023f | fix vs main | net-miss o1023f/main/fix |
|---|---|---|---|---|---|
| 3d-terrain | 2/2/2 | 19.10 / 14.07 | 0.94 / 0.01 | 19.06 / 14.10 | 10/135/125 |
| adding-3d-models-using-threejs-on-terrain | 2/2/2 | 15.76 / 11.15 | 15.35 / 11.15 | 0.52 / 0.00 | 49/64/60 |
| add-3d-terrain-from-quantized-mesh-tiles | 2/2/2 | 42.49 / 42.18 | 42.49 / 42.18 | 0.00 / 0.00 | 15/545/543 |
| elevate-symbols-above-the-terrain | 2/2/2 | 9.00 / 4.88 | 5.68 / 2.42 | 5.90 / 3.25 | 7/109/161 |
| display-a-hybrid-satellite-map-with-terrain-elevation | 2/2/2 | 5.49 / 0.22 | 0.58 / 0.02 | 5.43 / 0.22 | 15/148/141 |
| sky-fog-terrain | 2/2/2 | 2.32 / 1.72 | 0.37 / 0.00 | 2.10 / 1.72 | 21/140/122 |
| draw-a-circle | 3/3/3 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0/4/4 |
| add-a-hillshade-layer | 3/3/3 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0/8/8 |
| add-a-wms-source | 3/3/3 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0/8/8 |
| add-a-raster-tile-source | 2/2/2 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0/4/4 |
| animate-a-series-of-images | 2/2/2 | 3.98 / 4.10 | 3.98 / 4.10 | 0.00 / 0.00 | 0/0/0 |

Fix was repeated twice more (--jobs 1) for 3d-terrain, adding-3d-models-using-threejs-on-terrain and elevate-symbols-above-the-terrain; diffs reproduced to two decimals, net-miss varied as: 3d-terrain 125/130/120, adding-3d-models 60/67/60, elevate-symbols 161/161/161.

- 3d-terrain, display-a-hybrid-satellite-map-with-terrain-elevation and sky-fog-terrain return to o1023f. 3d-terrain was checked by eye.
- elevate-symbols-above-the-terrain moves closer to o1023f but is not back to it, and its net-miss is higher than main (161 vs 109).
- add-3d-terrain-from-quantized-mesh-tiles (fix vs main 0.00), adding-3d-models-using-threejs-on-terrain (0.52) and animate-a-series-of-images (0.00) are not changed by the fix; their difference from o1023f has another cause.

## Cesium

`tests/csexamples/run.mjs --side ortho --gpu --time-from runs/v220`, Chrome for Testing via CHROME. cesium-ref = runs/v220/ref. Live network, one run per side.
Navy px = rough colour heuristic (r<40, b>40, b>2r, b>1.5g), not horizon-specific.

| example | cs-main vs cs-fix (mean / %>40) | navy px % ref/main/fix |
|---|---|---|
| cesium-world-terrain | 0.00 / 0.00 | 0.71/0.83/0.83 |
| terrain | 0.00 / 0.00 | 0.06/0.06/0.06 |
| imagery-layers | 0.01 / 0.00 | 0.09/0.41/0.41 |
| hello-world | 0.01 / 0.00 | 8.84/8.76/8.76 |
| 3d-tiles-terrain-classification | 0.00 / 0.00 | 0.00/0.00/0.00 |
| pamap-terrain | 1.44 / 0.03 | 0.00/0.00/0.00 |

No visible change between main and fix. pamap-terrain and cesium-world-terrain were checked by eye on the fix side and show no base-colour band. These views may not hit the texture budget, in which case they don't exercise the changed branch; this was not measured.
