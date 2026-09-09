#!/usr/bin/env node
// t-moj: 登記所備付地図デコーダ（decoder/moj.js）の検定。zip of zips（外側 zip → 市区町村 zip → 地図XML）の合成フィクスチャを
// 自前の最小 zip ライタで作り（deflate と stored の両 method）、Worker の入口（onmessage）を Node で直接呼ぶ。
//   ・feature 数・属性・座標（平面直角→WGS84）が期待どおり
//   ・引数の旧実装（pako 同期）が手元にあれば同じ入力で出力バイト列が一致（scripts 用: MOJ_OLD=path）
globalThis.ImageData ??= class ImageData { };
import { deflateRawSync, crc32 } from "node:zlib";
import { GeoPBF } from "../src/pbf-base.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const enc = new TextEncoder();

// ---- 最小 zip ライタ（local header + central directory + EOCD・method 0/8）----
function makeZip(files) {   // files: [{ name, data: Uint8Array, method: 0|8 }]
	const locals = [], cds = []; let off = 0;
	const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
	for (const f of files) {
		const nm = enc.encode(f.name), comp = f.method === 8 ? new Uint8Array(deflateRawSync(f.data)) : f.data, crc = crc32(f.data);
		const lh = Uint8Array.from([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0), ...u16(f.method), ...u16(0), ...u16(0), ...u32(crc), ...u32(comp.length), ...u32(f.data.length), ...u16(nm.length), ...u16(0)]);
		locals.push(lh, nm, comp);
		cds.push(Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(f.method), ...u16(0), ...u16(0), ...u32(crc), ...u32(comp.length), ...u32(f.data.length), ...u16(nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nm);
		off += lh.length + nm.length + comp.length;
	}
	let cdLen = 0; for (const c of cds) cdLen += c.length;
	const eocd = Uint8Array.from([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdLen), ...u32(off), ...u16(0)]);
	const parts = [...locals, ...cds, eocd]; let n = 0; for (const p of parts) n += p.length;
	const out = new Uint8Array(n); let p = 0; for (const b of parts) { out.set(b, p); p += b.length; }
	return out;
}

// ---- 地図XML（法務省 地図XML の形＝moj-convert.js の正規表現が読む形に合わせる。空間属性→主題属性の順）----
// 平面直角座標系 9 系（原点 36°N 139°50'E）付近の矩形筆。X=北(m) Y=東(m)。order: "spatial-first" | "feature-first"
function mojXml({ cityCode, cityName, sys, parcels, order = "spatial-first" }) {
	let pts = "", curves = "", surfaces = "", feats = "";
	let pid = 1, cid = 1;
	parcels.forEach((pc, k) => {
		const [x0, y0, x1, y1] = pc.xy, sid = `F${k + 1}`;
		const corners = [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
		const cids = [];
		for (let i = 0; i < 4; i++) {
			const a = corners[i], b = corners[(i + 1) % 4], c = `C${cid++}`;
			curves += `<zmn:GM_Curve id="${c}"><zmn:GM_Curve.segment><zmn:GM_LineString><zmn:GM_LineString.controlPoint><zmn:GM_PointArray.column><zmn:GM_Position.direct><zmn:X>${a[0]}</zmn:X><zmn:Y>${a[1]}</zmn:Y></zmn:GM_Position.direct></zmn:GM_PointArray.column><zmn:GM_PointArray.column><zmn:GM_Position.direct><zmn:X>${b[0]}</zmn:X><zmn:Y>${b[1]}</zmn:Y></zmn:GM_Position.direct></zmn:GM_PointArray.column></zmn:GM_LineString.controlPoint></zmn:GM_LineString></zmn:GM_Curve.segment><zmn:GM_OrientablePrimitive.orientation>+</zmn:GM_OrientablePrimitive.orientation></zmn:GM_Curve>`;
			cids.push(`<zmn:GM_CompositeCurve.generator idref="${c}"/>`);
		}
		pts += `<zmn:GM_Point id="P${pid++}"><zmn:GM_Point.position><zmn:DirectPosition><zmn:X>${x0}</zmn:X><zmn:Y>${y0}</zmn:Y></zmn:DirectPosition></zmn:GM_Point.position></zmn:GM_Point>`;
		surfaces += `<zmn:GM_Surface id="${sid}"><zmn:GM_Surface.patch><zmn:GM_Polygon><zmn:GM_Polygon.boundary><zmn:GM_SurfaceBoundary><zmn:GM_SurfaceBoundary.exterior><zmn:GM_Ring>${cids.join("")}</zmn:GM_Ring></zmn:GM_SurfaceBoundary.exterior></zmn:GM_SurfaceBoundary></zmn:GM_Polygon.boundary></zmn:GM_Polygon></zmn:GM_Surface.patch></zmn:GM_Surface>`;
		feats += `<筆 id="H${k + 1}"><大字コード>${pc.oaza}</大字コード><大字名>${pc.oazaName}</大字名><丁目コード>001</丁目コード><小字コード></小字コード><地番>${pc.chiban}</地番><精度区分>甲一</精度区分><座標値種別>図上測量</座標値種別><形状 idref="${sid}"/></筆>`;
	});
	const spatial = `<空間属性>${pts}${curves}${surfaces}</空間属性>`, thematic = `<主題属性>${feats}</主題属性>`;
	return `<?xml version="1.0" encoding="UTF-8"?><地図 xmlns:zmn="http://www.moj.go.jp/MINJI/tizuxml"><版数>1</版数><市区町村コード>${cityCode}</市区町村コード><市区町村名>${cityName}</市区町村名><座標系>公共座標${sys}系</座標系>${order === "spatial-first" ? spatial + thematic : thematic + spatial}</地図>`;
}

const xmlA = mojXml({ cityCode: "09201", cityName: "宇都宮市", sys: 9, order: "spatial-first", parcels: [
	{ xy: [1000, 2000, 1100, 2150], oaza: "001", oazaName: "大通り", chiban: "1-1" },
	{ xy: [1100, 2000, 1250, 2150], oaza: "001", oazaName: "大通り", chiban: "1-2" },
] });
const parcelB = [{ xy: [-500, -700, -300, -600], oaza: "002", oazaName: "馬場通り", chiban: "3" }];
const xmlB = mojXml({ cityCode: "09201", cityName: "宇都宮市", sys: 9, parcels: parcelB, order: "feature-first" });   // 主題属性が先の並び
const xmlBsf = mojXml({ cityCode: "09201", cityName: "宇都宮市", sys: 9, parcels: parcelB, order: "spatial-first" });
const innerA = makeZip([{ name: "09201-0001-2026.xml", data: enc.encode(xmlA), method: 8 }]);
const innerB = makeZip([{ name: "09201-0002-2026.xml", data: enc.encode(xmlB), method: 0 }]);
const outer = makeZip([{ name: "09201-0001-2026.zip", data: innerA, method: 8 }, { name: "09201-0002-2026.zip", data: innerB, method: 0 }, { name: "readme.txt", data: enc.encode("x"), method: 0 }]);
// 旧実装比較用（旧実装は 主題属性が先 の並びを読めない＝空間属性が先 だけで比べる）
const outerSF = makeZip([{ name: "09201-0001-2026.zip", data: innerA, method: 8 }, { name: "09201-0002-2026.zip", data: makeZip([{ name: "09201-0002-2026.xml", data: enc.encode(xmlBsf), method: 0 }]), method: 0 }]);

// ---- Worker の入口を Node で直接呼ぶ ----
async function runDecoder(modulePath, zip = outer) {
	const messages = [];
	globalThis.onmessage = null;
	globalThis.postMessage = (m) => messages.push(m);
	const mod = await import(modulePath + "?v=" + Date.now());
	await globalThis.onmessage({ data: { file: new Blob([zip]), name: "09201-0608-2026", precision: 7, description: "d", license: "CC BY 4.0", attribution: "法務省" } });
	return messages;
}
const msgs = await runDecoder(new URL("../src/decoder/moj.js", import.meta.url).href);
const progress = msgs.filter(m => m?.type === "progress"), done = msgs.find(m => m?.type === "mojdec");
ok(progress.length === 2 && progress.at(-1).loaded === 2 && progress.at(-1).total === 2, `progress が entry ごとに届く（${progress.length}）`);
ok(done && done.data instanceof ArrayBuffer, "mojdec で GeoPBF が返る");
const pbf = await new GeoPBF().set(done.data);
const gj = pbf.geojson;
ok(gj.features.length === 3, `3 筆（deflate 内側 zip 2 筆 + stored 内側 zip 1 筆・主題属性が先の並びも読む）＝${gj.features.length}`);
ok(pbf.name() === "09201-0608-2026" && pbf.precision() === 7 && pbf.attribution() === "法務省", "ヘッダ（name/precision/attribution）");
const f0 = gj.features[0];
ok(f0.properties["市区町村コード"] === "09201" && f0.properties["市区町村名"] === "宇都宮市" && f0.properties["大字名"] === "大通り" && f0.properties["地番"] === "1-1" && f0.properties["精度区分"] === "甲一", "属性（市区町村コード/名・大字名・地番・精度区分）");
const ring = f0.geometry.coordinates[0];
ok(f0.geometry.type === "Polygon" && ring.length === 5 && ring[0][0] === ring[4][0], "Polygon・閉じた外環（5 点）");
// 9 系原点 (36°N, 139°50'E) から北 1000m 東 2000m ≒ 緯度 +0.009°・経度 +0.022°
ok(Math.abs(ring[0][1] - 36.009) < 0.002 && Math.abs(ring[0][0] - 139.8555) < 0.003, `平面直角 9 系 → WGS84（${ring[0].map(v => v.toFixed(5))}）`);
ok(gj.features[2].properties["大字名"] === "馬場通り" && gj.features[2].geometry.coordinates[0][0][1] < 36, "stored 内側 zip の筆（原点の南西）");

// ---- 旧実装（pako 同期）との出力一致（MOJ_OLD=旧 moj.js のパス を渡した時だけ）----
if (process.env.MOJ_OLD) {
	const cur = (await runDecoder(new URL("../src/decoder/moj.js", import.meta.url).href, outerSF)).find(m => m?.type === "mojdec");
	const old = (await runDecoder(new URL(process.env.MOJ_OLD, "file://").href, outerSF)).find(m => m?.type === "mojdec");
	const a = new Uint8Array(cur.data), b = new Uint8Array(old.data);
	let same = a.length === b.length; if (same) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
	ok(same, `旧実装と出力バイト列が一致（${a.length} / ${b.length} B）`);
} else console.log("– skip: 旧実装比較（MOJ_OLD 未指定）");

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
