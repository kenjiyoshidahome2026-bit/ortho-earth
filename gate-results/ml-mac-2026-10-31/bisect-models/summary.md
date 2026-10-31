# Bisect: adding-3d-models-using-threejs-on-terrain

Criterion: mean abs RGB diff vs o1023f canvas below 3 is good. o1023f is reproduced exactly by 6abff796 (diff 0.00), the last main commit before the run's file time, 2026-10-23 15:20 local.

First bad: 9ef58a5e, near elevation layer. Some commits around it render a black map on real WebGPU (fwidth bug from 5819b61d, fixed by 21d62cc2), so both sides were tested with 21d62cc2 applied:

| build | mean / % px >40 vs o1023f |
|---|---|
| 9d2c26fd + 21d62cc2 (parent of 9ef58a5e) | 2.45 / 0.02 |
| 9ef58a5e + 21d62cc2 | 16.61 / 11.28 |
| 666c49f1 with the near layer disabled | 2.04 / 0.02 |
| 666c49f1 with missing tiles fetched live (store restored afterwards) | 15.42 / 11.15 |
| 666c49f1 with the wider shade step (experiment-wider-step.patch) | 16.55 / 13.91 |

Picture differences from o1023f are expected once the near layer is on, since it changes the terrain shape; the rim now sits where ref has it. So the mean diff can't grade the fix itself. Judge the wider-step picture by eye.

Cause of the grain (WebGPU, wgsl.ts near-mesh pass): the shade difference uses a one-texel step on an r16float atlas with gain 0.004/dTex. At elevations of 1024-2048 m r16float steps by 1 m, and the example's view gives a small texel, so a single quantisation step produces a large shade jump. Widening the step to 0.00025 deg (about 28 m) removes the grain, which supports this reading. The exact elevation and span at this view were not measured.

The patch is an experiment on the WebGPU path only. The GL path uses the same formula per the commit message and was not tested. Other near-layer views (cesium-world-terrain cliffs) were not rechecked with the patch.

## add-3d-terrain-from-quantized-mesh-tiles

Not caused by the near layer: near off and wider step both give 0.00 vs 666c49f1.

Bisect on this example (mean below 3 is good; pictures with mean above 100 skipped): first change is 4e4faf1b, which makes setTerrain exaggeration take effect. 823fe410 gives 0.00, 4e4faf1b gives 42.33 / 42.04. Example's exaggeration setting: exaggeration: 1.2.
