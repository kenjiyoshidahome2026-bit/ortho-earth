# Draco decoder (vendored)

`draco_wasm_wrapper.js` and `draco_decoder.wasm` are Google's Draco 3D decoder (version 1.5.6, Apache License 2.0,
https://github.com/google/draco), copied unchanged from `@loaders.gl/draco/dist/libs/` (loaders.gl 4.5.4, MIT).

The engine ships them so Draco-compressed buildings (PLATEAU 3D Tiles) decode without reaching the
unpkg / gstatic CDNs, including offline. `src/draco-libs.ts` loads them and hands them to loaders.gl.
