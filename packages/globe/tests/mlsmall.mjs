// MapLibre の小口の純粋な部品（src/mlsmall.js・B6 2026-10-12）
import { normSprite, spriteEcho, spritePrefix, tileOf, tilesFromPoints, fontFaceArgs } from "../src/mlsmall.ts";
let fail = 0; const ok = (name, c, note = "") => { console.log(`${c ? "✓" : "✗"} ${name}${note ? `（${note}）` : ""}`); if (!c) fail++; };
const J = JSON.stringify;
ok("sprite-string", J(normSprite("https://x/s")) === J([{ id: "default", url: "https://x/s" }]));
ok("sprite-array-dedupe", J(normSprite([{ id: "a", url: "u1" }, { url: "u0" }, { id: "a", url: "u2" }, { id: "b" }])) === J([{ id: "a", url: "u2" }, { id: "default", url: "u0" }]));
ok("sprite-none", normSprite(null).length === 0 && spriteEcho([]) === undefined && spriteEcho(null) === undefined);
ok("sprite-echo", spriteEcho([{ id: "default", url: "u" }]) === "u" && J(spriteEcho([{ id: "a", url: "u" }])) === J([{ id: "a", url: "u" }]));
ok("sprite-prefix", spritePrefix("default") === "" && spritePrefix("a") === "a:" && spritePrefix(undefined) === "");
ok("tileOf", J(tileOf(139.76, 35.68, 10)) === J([909, 403]) && J(tileOf(-180, 85, 1)) === J([0, 0]) && J(tileOf(180, -85, 1)) === J([0, 1]) && J(tileOf(179.99, 0, 1)) === J([1, 1]));
const t = tilesFromPoints([[139.76, 35.68], [139.76, 35.68], null, [NaN, 1], [140.2, 35.68], [139.76, 35.2]], 10);
ok("tiles-dedupe-sort", t.length === 3 && t[0].key === "10/909/403" && t[1].key === "10/909/404" && t[2].key === "10/910/403" && t.every(x => x.overscaledZ === 10 && x.wrap === 0), J(t.map(x => x.key)));
ok("tiles-zfn-clamp", tilesFromPoints([[0, 0]], () => 7.9, { minzoom: 5, maxzoom: 6 })[0].canonical.z === 6 && tilesFromPoints([[0, 0]], 2, { minzoom: 3 })[0].canonical.z === 3);
ok("fontface", J(fontFaceArgs({ "font-family": "Noto", src: "url('/f.woff2')", "font-weight": 700, "unicode-range": "U+3000-9FFF" })) === J({ family: "Noto", src: "/f.woff2", descriptors: { weight: "700", unicodeRange: "U+3000-9FFF" } }));
ok("fontface-alt", fontFaceArgs({ family: "A", src: ["x.ttf", "y.ttf"], style: "italic" }).src === "x.ttf" && fontFaceArgs({ family: "A" }) === null && fontFaceArgs(null) === null && fontFaceArgs({ src: "x" }) === null);
console.log(fail ? `✗ mlsmall: ${fail} failed` : "✓ mlsmall PASS");
process.exit(fail ? 1 : 0);
