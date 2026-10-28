// 3D Tiles のタイルを取った headers／credentials（transformRequest・ion の Bearer）を glTF の外部画像・buffer・i3dm の glTF の fetch にも付ける（2026-10-28）。
// ion の CDB（3d-tiles-1.1-cdb-yemen）はテクスチャが glb の外の画像で、Bearer が無いと 401＝建物も地形も白のままだった。
// fetchFor(baseUri, opts)：タイルと同じ origin にだけ付ける（別ホストへ委譲された画像に token を漏らさない）・init は残す・opts が無ければ素の fetch。
import { fetchFor } from "../src/meshdecode.ts";

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log("FAIL", m); } else console.log("ok", m); };
const calls = [];
globalThis.self = globalThis;
globalThis.fetch = async (u, init) => { calls.push([String(u), init]); return { ok: true }; };
const H = { Authorization: "Bearer x" };
const f = fetchFor("https://assets.ion.cesium.com/us-east-1/1/t/tileset.json?v=1", { headers: H, credentials: "include" });

await f("https://assets.ion.cesium.com/us-east-1/1/t/Textures/a.jpg", { credentials: "omit" });
ok(calls[0][1].headers?.Authorization === "Bearer x" && calls[0][1].credentials === "include", "same origin: headers + credentials added");
await f(new URL("https://assets.ion.cesium.com/x.bin"), { signal: null, headers: { Accept: "*/*" } });
ok(calls[1][1].headers.Accept === "*/*" && calls[1][1].headers.Authorization === "Bearer x" && "signal" in calls[1][1], "same origin: init headers kept and merged");
await f("https://other.example.com/img.png", { credentials: "omit" });
ok(!calls[2][1].headers && calls[2][1].credentials === "omit", "other origin: nothing added");
await f("Textures/rel.jpg");
ok(calls[3][0] === "Textures/rel.jpg" && calls[3][1].headers?.Authorization === "Bearer x", "relative URL resolves against the tile = same origin");

const g = fetchFor("https://a.example/t.glb", null);
await g("https://a.example/i.jpg");
ok(!calls[4][1].headers && calls[4][1].credentials === "omit", "no opts: plain fetch with credentials omit");
const h = fetchFor(null, { headers: H });
await h("https://a.example/i.jpg");
ok(!calls[5][1].headers, "no baseUri: no origin to match = nothing added");

if (fail) { console.log(`fetch-for: ${fail} failed`); process.exit(1); }
console.log("fetch-for: all ok");
