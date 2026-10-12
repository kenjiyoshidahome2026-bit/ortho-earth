// @ortho-earth/ktx2 — node checks (no WASM): header parsing, plugin shape, library path in the URL hash, input validation before any download
import { ktx2Plugin, transcoderUrl, isKTX2, isBasis, ktx2Header, libraryPath, DEFAULT_LIBRARY_PATH } from "../src/index.js";
import { transcode } from "../src/transcode.js";
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
// a KTX2 header: 64×32, 1 layer, 1 face, 3 levels, Basis supercompression (vkFormat 0, scheme 1)
const hdr = new Uint8Array(80); hdr.set([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A], 0);
const dv = new DataView(hdr.buffer); dv.setUint32(12, 0, true); dv.setUint32(16, 1, true); dv.setUint32(20, 64, true); dv.setUint32(24, 32, true); dv.setUint32(28, 0, true); dv.setUint32(32, 0, true); dv.setUint32(36, 1, true); dv.setUint32(40, 3, true); dv.setUint32(44, 1, true);
ok("isKTX2", isKTX2(hdr) && !isKTX2(new Uint8Array(10)) && !isKTX2(Uint8Array.of(0x73, 0x42, ...new Array(50).fill(0))));
ok("isBasis", isBasis(Uint8Array.of(0x73, 0x42, 0)) && !isBasis(hdr));
const h = ktx2Header(hdr);
ok("header", h && h.width === 64 && h.height === 32 && h.faces === 1 && h.levels === 3 && h.vkFormat === 0 && h.supercompression === 1 && ktx2Header(new Uint8Array(3)) === null, JSON.stringify(h));
// plugin shape + registered url
const calls = []; const map = { registry: { textureTranscoders: { add: (n, impl) => calls.push([n, impl]) } } };
const p = ktx2Plugin({ libraryPath: "https://cdn.example.test/basis/" });
ok("plugin.shape", p.name === "ktx2" && typeof p.install === "function" && typeof p.version === "string");
p.install(map);
ok("plugin.registers", calls.length === 1 && calls[0][0] === "ktx2" && typeof calls[0][1].url === "string" && calls[0][1].url.endsWith("/src/transcode.js#lib=https%3A%2F%2Fcdn.example.test%2Fbasis%2F") && calls[0][1].formats.join() === "ktx2,basis", calls[0]?.[1]?.url);
ok("plugin.name", (() => { const c = []; ktx2Plugin({ name: "ktx2-alt" }).install({ registry: { textureTranscoders: { add: (n) => c.push(n) } } }); return c[0] === "ktx2-alt"; })());
// library path: from the hash, trailing slash added, default when absent
ok("libraryPath", libraryPath("https://x.test/transcode.js#lib=https%3A%2F%2Fcdn.example.test%2Fbasis") === "https://cdn.example.test/basis/" && libraryPath("https://x.test/transcode.js") === DEFAULT_LIBRARY_PATH && libraryPath(transcoderUrl()) === DEFAULT_LIBRARY_PATH && libraryPath(transcoderUrl({ libraryPath: "/basis/" })) === "/basis/");
ok("defaultPath", DEFAULT_LIBRARY_PATH.startsWith("https://") && DEFAULT_LIBRARY_PATH.endsWith("/"));
// transcode rejects non-KTX2/basis input before touching the network
let err = null; try { await transcode(new Uint8Array([1, 2, 3])); } catch (e) { err = e; }
ok("transcode.rejects", err && /not a KTX2/.test(err.message), err?.message);
if (fails) { console.error(`${fails} failed`); process.exit(1); } else console.log("ALL PASS ktx2");
