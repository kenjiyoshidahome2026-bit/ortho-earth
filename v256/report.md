# Cesium 門 v256（claude/project-thread-mir9bm 7a55d2b・--only 5 例）

条件：v250 と同じ（--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2・ref は v242）。比較の元＝v250。pair＝左 Cesium・右 ortho（1920×720）。

## 段か colour が 2 ポイント以上変わった例

| 例 | v250 | v256 | v250 colour / edges / blob | v256 colour / edges / blob |
|---|---|---|---|---|
| ground-primitive-dev | 2 | **2** | 69.2 / 83.7 / 301 | 74.0 / 85.4 / 301 |
| ground-primitive-materials-dev | 2 | **2** | 90.6 / 93.3 / 58 | 86.9 / 93.7 / 41 |

## 撮った全例

| 例 | v250 | v256 | v250 | v256 |
|---|---|---|---|---|
| ground-primitive-dev | 2 | 2 | 69.2 / 83.7 / 301 | 74.0 / 85.4 / 301 |
| ground-primitive-materials-dev | 2 | 2 | 90.6 / 93.3 / 58 | 86.9 / 93.7 / 41 |
| picking-dev | 3 | 2 | 99.0 / 99.8 / 2 | 65.6 / 85.2 / 695 |
| polygon-texture-coordinates-dev | 3 | 2 | 99.0 / 99.7 / 2 | 66.3 / 85.1 / 705 |
| polylines-on-terrain-dev | 3 | 3 | 95.8 / 98.1 / 3 | 96.5 / 98.2 / 5 |

## Notes (2026-11-09)

- picking-dev and polygon-texture-coordinates-dev came out at level 2 in v256: their globe drew blank blue because the imagery didn't load. Re-shot in v256b, both are level 3 at their v254 numbers.
- The ground-primitive-dev colour gain (53.5 → 74.0) comes from the terrain imagery z (#1036), not from the fills: the ortho shot still shows no polygons.
- In the page, `_orthoPrimitives.fills` holds the 3 GroundPrimitive fills with the right lon/lat, and the `__cs-shapes` source has them as `_k: fill`. Looking straight down (debug/top-down-15km.png, debug/tilt-0-25-40-50.jpg first frame) they draw. From a tilt of 25° or more they don't. A plain clamped entity polygon added at the same place doesn't draw either (debug/example-view-plus-entity-polygon.png). So on this 2.3 km mountain the ground fill layer only shows top-down: it's a globe draping problem that affects entity polygons too, not the GroundPrimitive wiring.
