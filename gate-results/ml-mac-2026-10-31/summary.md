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
