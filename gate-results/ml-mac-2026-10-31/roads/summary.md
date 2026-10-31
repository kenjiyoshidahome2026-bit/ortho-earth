# Missing roads at low zoom

Fix: f2095777 on branch claude/project-thread-etztmx-roads (on main c9a3b87e). Not merged.

## Cause

`packages/ortho-core/src/build.ts:496-497` and the expression contexts at `:510` and `:567`. `normalizeMLLayer` (`mlstyle.ts`) adds dz to a MapLibre layer's minzoom, maxzoom and ["zoom"] (about 1.36 at this latitude), but the tile build compared them with the tile's own z, which stays on the MapLibre scale. Two effects:

1. A layer with minzoom 5 was dropped from tiles below z 6.36, so it came about two tile levels late (state and county boundaries too).
2. Zoom-driven paint evaluated about 1.36 levels low, so line-width and line-opacity were baked as 0.

Thin-line rendering is not the cause: with the zoom gate fixed, a constant width 0.4 gives 27027 orange pixels at z5 against 27769 in ref.

## Fix

Normalisation records the dz it applied (`metadata["ortho:dzApplied"]`), and the build uses `zL = z + dzApplied` for the layer zoom gate and expression zoom. Tile coordinates stay as they are. Styles without the key are unchanged.

## Full gate, 139 examples, replay of ref r7

Baselines are o1031 and o1031gl2 (30e1caef), which predate #824 and later main commits, so picture diffs include those too.

| backend | same answer | same picture | picture-only match | vs known.json |
|---|---|---|---|---|
| WebGPU before | 47 | 79 | 80 | |
| WebGPU after | 40 | 86 | 87 | none lower, 7 higher |
| GL2 before | 46 | 80 | | |
| GL2 after | 43 | 83 | | add-a-new-layer-below-labels lower, as before; 5 higher |

Levels raised on WebGPU: add-a-generated-icon-to-the-map, display-a-popup-on-click, display-a-popup-on-hover, filter-symbols-by-text-input, filter-symbols-by-toggling-a-list, measure-distances, render-world-copies.
Text: line-label overlap 437 -> 431, placed symbol hit 2063 -> 2061 (measure only).

Core `npm test` and tsc passed. `verify:ui` and other page gates were not run, and native (non-MapLibre) styles were not shot.
