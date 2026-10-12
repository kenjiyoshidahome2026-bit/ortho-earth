# @ortho-earth/ktx2

KTX2 / Basis Universal texture transcoder for [`@ortho-earth/globe`](../globe). It fills the `registry.textureTranscoders` extension point: once installed, `KHR_texture_basisu` textures in glb models (`map.gadget.model`, drag & drop, `?g=`) and in 3D Tiles (`add3DTiles`) are transcoded to plain RGBA inside the globe's model worker and drawn like any other texture.

```js
import { createGlobe } from "@ortho-earth/globe";
import { ktx2Plugin } from "@ortho-earth/ktx2";

const map = await createGlobe({ target: "#map" });
map.use(ktx2Plugin());                                   // basis_universal WASM from unpkg (@loaders.gl/textures, pinned) on first use
// map.use(ktx2Plugin({ libraryPath: "/vendor/basis/" }));   // self-hosted basis_transcoder.js + basis_transcoder.wasm
map.supports("texture.ktx2");                            // true ("plugin", via "ktx2")
```

- **Opt-in.** Nothing is fetched until a model with a KTX2 texture is loaded, and nothing at all when the plugin is not installed. Without the plugin the globe keeps the model's fallback image (if any) and reports the count in `handle.stats.ktx2 = { textures, transcoded, failed }`.
- **`libraryPath`** is the directory holding `basis_transcoder.js` and `basis_transcoder.wasm` (the build in `@loaders.gl/textures/dist/libs/`). Copy those two files next to your app to avoid the CDN.
- **What is transcoded**: level 0 of image 0 (layer 0, face 0) to RGBA8, for KTX2 (ETC1S or UASTC, supercompressed or not) and `.basis` files. Mipmaps are left to the GPU.
- **Contract** (if you want your own transcoder instead): register `{ url }` on `map.registry.textureTranscoders.add("ktx2", …)`; the worker `import()`s `url` and calls `transcode(bytes, { mimeType }) → { width, height, rgba }` (Promise allowed). `src/transcode.js` is that module; it must stay import-free because it is loaded by URL.

Tests: `npm test -w @ortho-earth/ktx2` (node: header parsing, plugin shape, URL hash, input validation) and, in `packages/globe`, `npm run verify:ui -- t-plugin?v=gltf` (the worker path with a fake transcoder; the real WASM needs network or a self-hosted copy).
