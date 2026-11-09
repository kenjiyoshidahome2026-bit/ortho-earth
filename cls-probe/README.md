# classification / classification-types probes (2026-11-09)

- cls.jpg: classification. Left Cesium ref, middle ortho v254 (solid balls), right ortho f8731a3+eb8dff14f (tinted trees, but at full strength: red (255,81,88) vs Cesium (168,59,60), whose colours are alpha 0.5).
- ct.jpg: classification-types. Left Cesium ref, middle ortho v254, right ortho eb8dff14f (level 3, colour 99.7 %).
- ctprobe.jpg / ct-*.png: real Cesium (Mac GPU). 0 default (depthTestAgainstTerrain already true), 1 dtat=true (same), 2 CESIUM_3D_TILE only (the trapezoid goes), 3 TERRAIN only (the trapezoid stays, the lot's tiles are not red), 4 BOTH with the tileset hidden (the full trapezoid on the terrain).
