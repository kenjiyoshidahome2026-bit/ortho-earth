# Cesium gate v271 (origin/main 148e80713, all 309 examples)

Conditions: same as v259 (--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2; refs = v242/ref = v259/ref; WebGPU only; Chrome for Testing 154).
Served from worktree gis-hub-wt/reshoot at 148e80713. Pairs: Cesium left, ortho right, 1920x720.

Runs merged (later wins): v271 (full) · v271c (aerometrex-san-francisco, web-map-service-wms: external-data flakes in v271/v271b) · v271d (material-with-custom-glsl against the w4p1 ref shot with the pre-shot counter pin; v242's ref predates the pin).

Levels: L3 241 · L2 57 · not graded 11. With checked.json: L3 244 · L2 59 · not graded 6. (v259: L3 232 · L2 66 · not graded 11)

Up vs v259 (colour / edges / blob): 3d-tiles-nga-gpm-visualization 93.2/96.4/29 → 97.1/98.6/3 · custom-datasource 96.0/96.1/27 → 99.2/99.7/1 · czml-path 98.9/8.9/0 → 99.3/99.8/1 · globe-interior 70.7/81.4/565 → 98.0/98.5/18 · material-with-custom-glsl 92.9/94.7/114 → (new ref) L3 · rectangle 95.6/95.8/64 → 99.2/96.4/3 · terrain-exaggeration 79.5/88.3/53 → 97.5/95.7/5 · time-dynamic-wheels 90.8/93.2/119 → 98.6/94.9/6 · web-map-tile-service-picking 93.8/99.4/30 → 99.9/99.4/0

Real drop vs best previous run: cartographic-limit-rectangle (gi2 L3 98.6/98.0/2; v259 L2 94.9/93.9/32; v271 ×3 L2 92.9/96.7/129): the far inner wall is now drawn, but its west half is flat navy without imagery.
Same level, edges slid ≥3 pts vs v259: 3d-tiles-1.1-photogrammetry 96.2 → 76.0 edges (L3), 3d-tiles-1.1-cdb-yemen 98.6 → 91.8 edges (L3).
