# v261: Cesium refs re-shot for two examples (2026-11-09)

Shot Cesium (ref side) three times on the Mac with the real GPU, using the same flags as v242. The three shots gave the same numbers. The old refs are kept in runs/v242/ref-old and runs/v254/ref-old; the new refs replace them in v242/v254/v259/v260. v259 is regraded against the new refs.

| example | old ref | new ref (ortho = v259) |
|---|---|---|
| 3d-tiles-1.1-cdb-yemen | 2 · 88.9 / 50.4 / 22 | **3** · 99.0 / 98.6 / 5 |
| web-map-tile-service-picking | 2 · 94.4 / 99.4 / 31 | 2 · 93.8 / 99.4 / 30 |

- cdb-yemen: Cesium itself now draws differently (served data). With today's ref it is level 3.
- web-map-tile-service-picking: still level 2 with today's ref. Ortho shows a red patch over England that today's Cesium does not show, so this is a real difference.
- v259 after the regrade: L3 232, L2 66.
