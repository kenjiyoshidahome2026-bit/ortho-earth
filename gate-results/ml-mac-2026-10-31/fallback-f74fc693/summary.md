# Image fallback fix f74fc693 (on main c9a3b87e)

Mac, real GPU, ref r7. `use-a-fallback-image` is the only corpus example with coalesce over images. Cells are mean abs RGB diff / % px >40, fix vs main.

| example | WebGPU | GL2 | level main/fix WebGPU | level main/fix GL2 |
|---|---|---|---|---|
| use-a-fallback-image | 0.09 / 0.06 | 0.09 / 0.06 | 3/3 | 2/2 |
| add-an-icon-to-the-map | 0.00 / 0.00 | 0.00 / 0.00 | 2/2 | 2/2 |
| add-a-generated-icon-to-the-map | 0.00 / 0.00 | 0.00 / 0.00 | 2/2 | 2/2 |
| display-and-style-rich-text-labels | 0.00 / 0.00 | 0.00 / 0.00 | 3/3 | 3/3 |
| add-custom-icons-with-markers | 0.00 / 0.00 | 0.00 / 0.00 | 3/3 | 3/3 |
| add-a-stretchable-image-to-the-map | 0.00 / 0.00 | 0.00 / 0.00 | 2/2 | 2/2 |
| add-a-new-layer-below-labels | 0.00 / 0.00 | 0.00 / 0.00 | 3/3 | 2/2 |

The brown pin appears at Pittsburgh on the WebGPU fix picture. WebGPU matches known.json. GL2 still drops the same two examples as main.

## Roads at z5 (diagnosis, cause not pinned down)

Live network, on main c9a3b87e. Orange-ish pixel count by map zoom:

| zoom | ortho | ref |
|---|---|---|
| 5 | 0 | 27769 |
| 5.2 | 0 | 28102 |
| 5.6 | 0 | 26642 |
| 6 | 3225 | 25043 |
| 6.5 | 2392 | 29152 |
| 7 | 9422 | 27606 |
| 5, casings set to width 3 opacity 1 | 0 | 96989 |

The ortho query does return highway features at z5 (7 of 7 ref highway hits in the probes), so the tile data and filter reach the query path; only the drawing is missing. Line width and opacity do not explain it if the paint change applied on ortho, which was not separately verified. The count threshold is rough.
