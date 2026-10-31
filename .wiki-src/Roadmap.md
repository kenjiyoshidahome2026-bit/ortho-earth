> **English** · [日本語](Roadmap-ja)

# Roadmap after 2.2

The plan in the repository is [`packages/ortho-core/improvement plan.md`](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/improvement%20plan.md). Summary as of 2026-10-31:

**No big rewrite is needed.** Copy-paste duplication in the engine is small (about 2% of packages and SDKs, 12.8% in apps). The real duplication is the twin WebGL2 / WebGPU implementations (about 9,000 and 10,500 lines). Speed waste sits more in the per-frame work added in 2.2 (the Cesium layer and 3D Tiles) than in the engine core.

| Stage | Work | Status |
|---|---|---|
| 0. Measure (days) | `?perf=1` timers for the Cesium layer and 3D Tiles; a gate on the initial bundle size; baselines on Mac and iPhone | Timers done (#815); iPhone baseline open |
| 1. Cheap speed-ups (1 week) | Compare before rebuilding in the Cesium facade; keep 3D Tiles bounds per node; no per-point JSON keys in point-cloud styles; lazy-load start-up modules | Main items done (#815); CPU per frame ≤ ~1 ms on the Mac |
| 2. Rest of the speed plans (2–3 weeks) | WebGPU paint table, GPU text (T-P1 gate), render bundles (go/no-go on the Mac bench), 2× faster `geopbf` topology (uint32 hash) | Next; measure the GPU side first |
| 3. Remove duplication (in parallel) | One i18n gate (#813), shared GL program builder (#814), census copy removed (#816); a small shared base for custom draw layers (voxel, splat, scene, copc…); pure functions out of `gl/` and `gpu/` | In progress |
| 4. Structure (later) | Split `globe.ts` and `gpu/renderer.ts`; type the facades (`any` in cesium, leaflet, gmaps) | When it gets in the way |

Every speed PR must keep the picture the same and pass the Sandcastle and MapLibre gates, with a URL escape hatch (`?xxx=0`).

**Not planned:** WASM for the draw loop or tile merging, multi-draw-indirect, generating GL and GPU shaders from one source.

**Decided:** WebGL2 stays through 2.x (#817), while older iPhones and devices without WebGPU are in use.
