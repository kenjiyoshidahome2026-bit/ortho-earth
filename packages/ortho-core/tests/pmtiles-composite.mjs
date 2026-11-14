// OPFS の Source（pmtiles://opfs:…）と複合 Source（pmtiles://composite:…）の検定（UNMAP オフライン版 M2・2026-11-14）。
// OPFS は navigator.storage を偽物に替える・HTTP は fetch を偽物に替える（Range を無視して全量＝pmtiles-src のメモリ経路）。
// 中身はラスタ（png の印 1 バイト）＝fetchPMTilesRaw で生のまま比べる。node packages/ortho-core/tests/pmtiles-composite.mjs
import { zxyToTileId } from "pmtiles";
import { fetchPMTilesRaw, pmtilesInfo, opfsPMTilesUrl, compositePMTilesUrl, compositeMembers } from "../src/pmtiles-src.ts";
import { readPMTilesHeader, safePMTilesName } from "../src/opfs-store.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };

// PMTiles v3 を組む：tiles＝[[z,x,y,印]]・bounds・ズーム域・tileType 2（png）・metadata に層名
function build(tiles, { bounds = [-180, -85, 180, 85], minZoom = 0, maxZoom = 5, layers = [], attribution = null } = {}) {
	const ents = tiles.map(([z, x, y, mark]) => ({ id: zxyToTileId(z, x, y), d: new Uint8Array([mark]) })).sort((a, b) => a.id - b.id);
	const v = []; const vint = n => { while (n >= 128) { v.push(n % 128 | 128); n = Math.floor(n / 128); } v.push(n); };
	vint(ents.length); let last = 0; for (const e of ents) { vint(e.id - last); last = e.id; } for (const e of ents) vint(1); for (const e of ents) vint(1); ents.forEach((e, i) => vint(i ? 0 : 1));
	const dir = new Uint8Array(v), md = new TextEncoder().encode(JSON.stringify({ vector_layers: layers.map(id => ({ id })), ...(attribution ? { attribution } : {}) }));
	const out = new Uint8Array(127 + dir.length + md.length + ents.length), dv = new DataView(out.buffer);
	out.set(new TextEncoder().encode("PMTiles")); out[7] = 3;
	const u64 = (o, n) => dv.setBigUint64(o, BigInt(n), true);
	u64(8, 127); u64(16, dir.length); u64(24, 127 + dir.length); u64(32, md.length); u64(40, 0); u64(48, 0); u64(56, 127 + dir.length + md.length); u64(64, ents.length); u64(72, ents.length); u64(80, ents.length); u64(88, ents.length);
	out[96] = 1; out[97] = 1; out[98] = 1; out[99] = 2; out[100] = minZoom; out[101] = maxZoom;
	bounds.forEach((d, i) => dv.setInt32(102 + i * 4, Math.round(d * 1e7), true));
	out.set(dir, 127); out.set(md, 127 + dir.length); ents.forEach((e, i) => { out[127 + dir.length + md.length + i] = e.d[0]; });
	return out;
}

// 端末の矩形（東アフリカ・z0–6）：2/2/1 と 6/37/31 を持つ。印 0xA1・0xA6
const RECT = build([[2, 2, 1, 0xa1], [6, 37, 31, 0xa6]], { bounds: [20, -10, 45, 15], minZoom: 2, maxZoom: 6, layers: ["roads"], attribution: "rect" });
// 世界の土台（HTTP・z0–3）：0/0/0・2/2/1・3/4/3。印 0xB0・0xB2・0xB3
const WORLD = build([[0, 0, 0, 0xb0], [2, 2, 1, 0xb2], [3, 4, 3, 0xb3]], { maxZoom: 3, layers: ["earth"], attribution: "world" });

// 偽の OPFS（rects/a.pmtiles）
const files = new Map([["rects/a.pmtiles", RECT]]);
const dirH = prefix => ({
	getDirectoryHandle: async name => dirH(prefix + name + "/"),
	getFileHandle: async name => { const b = files.get(prefix + name); if (!b) throw new DOMException("not found", "NotFoundError"); return { getFile: async () => new Blob([b]) }; },
});
Object.defineProperty(globalThis.navigator, "storage", { value: { getDirectory: async () => dirH("") }, configurable: true });
let online = true;
globalThis.fetch = async u => { if (!online) throw new TypeError("Failed to fetch"); return String(u).includes("world") ? new Response(WORLD, { status: 200 }) : new Response("", { status: 404 }); };

const A = opfsPMTilesUrl("/rects/a.pmtiles"), W = "pmtiles://https://example.test/world.pmtiles";
ok("opfsPMTilesUrl＝pmtiles://opfs:<道>（先頭の / を落とす）", A === "pmtiles://opfs:rects/a.pmtiles");
{
	const c = compositePMTilesUrl([A, "https://x.test/a,b.pmtiles?k=1"]);
	ok("複合の URL：構成員を encode（, を含む URL も往復）", JSON.stringify(compositeMembers(c)) === JSON.stringify(["opfs:rects/a.pmtiles", "https://x.test/a,b.pmtiles?k=1"]));
	ok("複合でなければ compositeMembers は null", compositeMembers(A) === null);
}
{
	const t = await fetchPMTilesRaw(A, 6, 37, 31);
	ok("OPFS：索引のタイルを読む", t?.[0] === 0xa6);
	ok("OPFS：ズーム域の外は null", (await fetchPMTilesRaw(A, 7, 74, 62)) === null);
	ok("OPFS：範囲の外は null", (await fetchPMTilesRaw(A, 2, 0, 0)) === null);
	const i = await pmtilesInfo(A);
	ok("OPFS：ヘッダの申告", i.minZoom === 2 && i.maxZoom === 6 && i.tileType === "png" && Math.abs(i.bbox[0] - 20) < 1e-6);
	ok("OPFS：無いファイルは失敗", await fetchPMTilesRaw("pmtiles://opfs:rects/none.pmtiles", 2, 2, 1).then(() => false, () => true));
}
const C = compositePMTilesUrl([A, W]);
{
	ok("複合：両方が持つタイルは先頭（端末の矩形）", (await fetchPMTilesRaw(C, 2, 2, 1))?.[0] === 0xa1);
	ok("複合：先頭に無いタイルは次（世界の土台）", (await fetchPMTilesRaw(C, 0, 0, 0))?.[0] === 0xb0 && (await fetchPMTilesRaw(C, 3, 4, 3))?.[0] === 0xb3);
	ok("複合：先頭だけが持つ深いタイル", (await fetchPMTilesRaw(C, 6, 37, 31))?.[0] === 0xa6);
	ok("複合：誰も持たない＝null", (await fetchPMTilesRaw(C, 5, 0, 0)) === null);
	const i = await pmtilesInfo(C);
	ok("複合の申告＝和（ズーム 0–6・全球・層名・出典）", i.minZoom === 0 && i.maxZoom === 6 && i.bbox === null && i.layers.join() === "roads,earth" && i.attribution === "rect · world", JSON.stringify(i));
}
{
	// 回線なし：HTTP の構成員は読めない＝飛ばして端末の矩形だけで描く
	online = false;
	const C2 = compositePMTilesUrl([A, "https://example.test/world-offline.pmtiles"]);
	ok("回線なし：端末の矩形は読める", (await fetchPMTilesRaw(C2, 6, 37, 31))?.[0] === 0xa6);
	ok("回線なし：HTTP にしか無いタイルは null（投げない）", (await fetchPMTilesRaw(C2, 0, 0, 0)) === null);
	const i = await pmtilesInfo(C2);
	ok("回線なし：複合の申告は読めた構成員だけ", i.minZoom === 2 && i.maxZoom === 6 && i.attribution === "rect");
	ok("どの構成員も読めない複合は失敗", await pmtilesInfo(compositePMTilesUrl(["https://example.test/w2.pmtiles"])).then(() => false, () => true));
	online = true;
}
{
	ok("readPMTilesHeader：v3 を読む", readPMTilesHeader(RECT.slice(0, 127).buffer)?.maxZoom === 6 && readPMTilesHeader(RECT.slice(0, 127).buffer)?.tileType === 2);
	ok("readPMTilesHeader：違えば null", readPMTilesHeader(new ArrayBuffer(127)) === null && readPMTilesHeader(new ArrayBuffer(3)) === null);
	ok("safePMTilesName：道を越えさせない・.pmtiles を付ける", safePMTilesName("../../etc/x.pmtiles") === "x.pmtiles" && safePMTilesName("Kenya rect") === "Kenya_rect.pmtiles" && safePMTilesName("..") === "archive.pmtiles");
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ pmtiles-composite 全 PASS");
process.exit(fail ? 1 : 0);
