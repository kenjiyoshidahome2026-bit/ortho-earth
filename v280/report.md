# Cesium gate v280 (origin/main 4390431c5, all 309 graded examples)

Conditions: same as v271 (--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2; refs = v242/ref; WebGPU only; Chrome for Testing 154).
Served from worktree gis-hub-wt/reshoot at 4390431c5 (#1078, #1079, #1080), vite on :5480 with --force. Pairs: Cesium left, ortho right, 1920x720.
Graded with main's grade.mjs at 9952534e5 (#1081: every grid cell a widget rectangle touches is left out). The engine is the same at both commits (#1081 changes only grade.mjs).
material-with-custom-glsl: the w4p1 ref (shot with the #1054 pre-shot pin) is now canonical in v242/ref (the old one kept in v242/ref-pre-w4p1).

Levels: L3 260 · L2 38 · not graded 11. With checked.json: L3 264 · L2 40 · not graded 5. (v271: L3 241 · L2 57 · not graded 11; with checked.json L3 244 · L2 59 · not graded 6)
v271 regraded with the #1081 grader (v271-g1081, the merged v271/v271c/v271d shots): L3 252 · L2 46 · not graded 11 = the new grader alone gives +11 L3; the new shots give the rest.

Colour / edges / blob below. "same grader" = v271 regraded with #1081.

## Up vs v271 with the same grader (new shots)
- 3d-tiles-bim: 95.0/96.7/89 → 100.0/97.9/0
- 3d-tiles-inspector: 84.5/91.6/46 → 92.7/91.6/11
- aec-elements-api-query: 87.9/94.3/69 → 93.3/93.5/7
- billboards-instancing-dev: 89.1/93.3/150 → 96.2/86.4/2 (#1080)
- cartographic-limit-rectangle: 92.9/96.8/129 → 98.9/98.8/4
- clipping-regions: 93.7/97.7/118 → 98.8/98.7/1
- high-dynamic-range: 68.7/73.4/102 → 93.8/79.8/13
- shadows: 72.8/96.1/306 → 97.8/99.1/1
- video: 23.6/50.4/883 → 98.4/98.2/2
- voxels: 75.2/96.3/101 → 100.0/100.0/0

## Up from the #1081 grader only (same shot level with either; v271 old grader → v280)
3d-tiles-batch-table-hierarchy, 3d-tiles-clipping-planes, 3d-tiles-compare, 3d-tiles-split-dev, camera-controllers, depth-of-field, ground-primitive-materials-dev, imagery-assets-available-from-ion, imagery-layers-manipulation, imagery-layers-split, pbr-lighting-dev (numbers in changed.json)

## Down vs v271 (re-shot once in v280r: same level both times = not a flake)
- 3d-tiles-1.1-cdb-yemen L3 → L2: v271 99.0/91.8/5 (same grader 100.0/92.7/0) → 89.5/45.7/19 (v280r 89.5/45.7/19). The v242 Cesium ref is still blurry (low-LOD imagery under the help panel); ortho now draws the sharp city and coast, v271 was as blurry as the ref. The ref is behind, not ortho wrong.
- japan-buildings L3 → L2: v271 93.3/95.3/9 (same grader 94.9/95.6/3) → 91.1/94.9/24 (v280r 91.2/95.0/24). The pictures look alike; a patch of 24 cells (blobMax 20) differs; marginal.

Not ran on ortho (same as v271, not graded, both in checked.json): itwin-feature-service, multifrustum-snapping-dev.
