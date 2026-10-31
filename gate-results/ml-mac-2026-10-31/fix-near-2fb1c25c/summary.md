# Near-terrain hillshade fix 2fb1c25c (on main 43fef354)

Mac, real GPU. `npm run verify:webgpu -- t-wgsl t-clipgint`: both PASS (t-wgsl 86/86).
MapLibre gate: no example below known.json, WebGPU and GL2.

`main.jpg` is o1031fix (666c49f1, i.e. the raster fix now in main), since o1031 predates #824. GL2 `main.jpg` is o1031gl2 (30e1caef, before #824).
Cells are mean abs RGB diff / % px differing by more than 40.

| example | vs o1031 | vs 666c49f1 |
|---|---|---|
| adding-3d-models-using-threejs-on-terrain | 7.43 / 0.89 | 6.92 / 0.89 |
| 3d-terrain | 19.06 / 14.10 | 0.00 / 0.00 |
| elevate-symbols-above-the-terrain | 5.90 / 3.25 | 0.00 / 0.00 |
| display-a-hybrid-satellite-map-with-terrain-elevation | 5.43 / 0.22 | 0.00 / 0.00 |
| sky-fog-terrain | 2.10 / 1.72 | 0.00 / 0.00 |
| add-3d-terrain-from-quantized-mesh-tiles | 0.00 / 0.00 | 0.00 / 0.00 |

adding-3d-models vs the bmStep experiment: 1.97 / 0.15.

GL2: adding-3d-models 6.55 / 0.74 vs o1031gl2, 1.73 / 0.15 vs WebGPU fix. 3d-terrain 19.07 / 14.10 vs o1031gl2 (includes the raster fix), 0.27 / 0.01 vs WebGPU fix.

## Cesium (main 43fef354 vs 2fb1c25c, live network, one run each)

| example | main vs fix |
|---|---|
| cesium-world-terrain | 0.00 / 0.00 |
| pamap-terrain | 0.01 / 0.01 |
| terrain | 0.00 / 0.00 |
| globe-materials | 0.00 / 0.00 |

A diff of 0.00 means these views did not change, not that the changed code ran there. globe-materials was shot in its default Elevation mode, so Slope and Aspect were not exercised.
