# WebGL2: added-layer probes on add-a-new-layer-below-labels and use-a-fallback-image

main c9a3b87e, Mac real GPU, ref r7. Distance is colorDist (Euclidean), tolerance 40.
Crops: 80x80 around each probe, enlarged 3x, left to right ref / WebGPU / WebGPU + Canvas2D text / GL2.

| example | i | x,y | ref layers | ref | WebGPU (dist) | WebGPU + Canvas2D text (dist) | GL2 (dist) |
|---|---|---|---|---|---|---|---|
| add-a-new-layer-below-labels | 118 | 334,426 | label_city urban-areas-fill | [252, 181, 216] | [250, 195, 219] (14.5) | [250, 196, 220] (15.7) | [249, 219, 229] (40.3) |
| add-a-new-layer-below-labels | 119 | 378,426 | label_city urban-areas-fill | [251, 153, 201] | [250, 195, 219] (45.7) | [250, 195, 219] (45.7) | [249, 219, 229] (71.7) |
| add-a-new-layer-below-labels | 139 | 554,476 | urban-areas-fill | [251, 146, 198] | [251, 146, 198] (0.0) | [236, 153, 194] (17.0) | [236, 153, 194] (17.0) |
| use-a-fallback-image | 52 | 246,224 | points | [206, 203, 200] | [207, 204, 200] (1.4) | [242, 238, 234] (60.6) | [242, 238, 234] (60.6) |
| use-a-fallback-image | 53 | 290,224 | points | [216, 212, 209] | [214, 211, 207] (3.0) | [204, 201, 198] (19.6) | [204, 201, 198] (19.6) |
| use-a-fallback-image | 120 | 422,426 | points boundary_3 park | [197, 202, 187] | [227, 223, 219] (48.6) | [232, 238, 220] (60.1) | [232, 238, 220] (60.1) |

Levels: GL2 drops both examples 3->2 in two runs with identical pictures. WebGPU keeps both. WebGPU with `?text=2d` keeps add-a-new-layer-below-labels and drops use-a-fallback-image.

Mean diff / % px >40:

| comparison | add-a-new-layer-below-labels | use-a-fallback-image |
|---|---|---|
| GL2 vs WebGPU | 1.72 / 1.33 | 1.29 / 1.05 |
| GL2 vs WebGPU + Canvas2D text | 0.18 / 0.00 | 0.12 / 0.00 |
| GL2 vs GL2 rerun | 0.00 / 0.00 | 0.00 / 0.00 |

Solid fill colour in urban-areas-fill is the same on all three sides (251,146,198). Backend pictures have no offset (best integer shift 0,0).

Diagnosis: no GL2 colour or blending fault was found. Almost all the backend difference is the text path, since GL2 draws labels with Canvas2D and WebGPU with GPU text. The failing probes sit on glyph or polygon edges. Probe 118 is the exception: it differs between WebGPU + Canvas2D (15.7) and GL2 (40.3, over the tolerance by 0.3) with the same text path, which is a small fill-edge difference whose cause was not investigated.

Both backends also miss probes 119 and 120, so those are not GL2 faults. No patch.
