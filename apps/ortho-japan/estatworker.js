// e-Stat 小地域 worker：fetch→gunzip→行単位JSON.parse→fan/線ジオメトリ生成、までを main から追い出す。
// 東京23区で数千ポリゴン＝main でやると数百ms ブロックしていた。identify（点in面）もここで実行＝
// feature 実体は worker に住み、main へは typed array（transfer）とヒット時の properties しか渡らない。
import { buildGeoJSONOverlay, pointInFeature } from "ortho-core";

let features = null, origin = [138, 37];

async function gunzipText(bytes) {
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
	return new TextDecoder().decode(bytes);
}
const overlayBufs = s => [s.fanPos.buffer, s.P1.buffer, s.P2.buffer, s.lineCol.buffer, s.lineHalf.buffer];

// 小地域境界は市区町村の外周が他データと不整合を起こす（県境で顕著＝e-Stat の癖・国交省系と違う点）。
// 描くのは市区町村「内側」の共有エッジのみ＝エッジ多重度で仕分け（同一 shapefile 由来なので共有辺の座標はビット一致）:
// 2回=内側→1本だけ描く / 1回=外周→捨てる（市区町村境界は別レベル＝基図の行政界に委ねる）。
// 多重度は市区町村ごとに数える＝隣接市区町村との突き合わせは最初から発生しない（不整合の検疫）。
function interiorMesh(feats) {
	const count = new Map();   // "x1,y1|x2,y2"（端点を辞書順に正規化）→ 出現回数
	const rings = g => g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
	for (const f of feats) if (f.geometry) for (const ring of rings(f.geometry))
		for (let i = 0; i + 1 < ring.length; i++) {
			const a = ring[i], b = ring[i + 1];
			const k = (a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])) ? `${a[0]},${a[1]}|${b[0]},${b[1]}` : `${b[0]},${b[1]}|${a[0]},${a[1]}`;
			count.set(k, (count.get(k) || 0) + 1);
		}
	const coords = [];
	for (const [k, n] of count) coords.push(k.split("|").map(p => p.split(",").map(Number)));   // 全ユニーク辺（多重度1も描く）
	return coords;
}

function bboxOf(feats) {
	let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90;
	const walk = c => { if (typeof c[0] === "number") { if (c[0] < lo0) lo0 = c[0]; if (c[0] > lo1) lo1 = c[0]; if (c[1] < la0) la0 = c[1]; if (c[1] > la1) la1 = c[1]; } else c.forEach(walk); };
	for (const f of feats) if (f.geometry?.coordinates) walk(f.geometry.coordinates);
	return [lo0, la0, lo1, la1];
}

self.onmessage = async (e) => {
	const m = e.data;
	if (m.type === "load") {
		const perCode = [];   // 市区町村ごとの feature 配列（内側メッシュ抽出の単位）
		const year = m.year ?? "2020";   // bucket キーは estat/{調査年}/{code}.geojsonl（調査年ごとに別断面）
		await Promise.all(m.codes.map(async code => {
			try {
				const r = await fetch(`https://api.ortho-earth.com/bucket/estat/${year}/${code}.geojsonl`);
				if (!r.ok) return;
				const text = await gunzipText(new Uint8Array(await r.arrayBuffer()));
				const fs = [];
				for (const line of text.split("\n")) { const s = line.trim(); if (s) { try { fs.push(JSON.parse(s)); } catch { /* skip */ } } }
				if (fs.length) perCode.push(fs);
			} catch (err) { console.warn("estat", code, err); }
		}));
		const feats = perCode.flat();
		if (!feats.length) { self.postMessage({ type: "loaded", ok: false }); return; }
		features = feats;
		const bb = bboxOf(feats);
		origin = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
		// 表示は内側メッシュ（純線・fan ゼロ）。ポリゴンは identify とヒット強調（下の identify 分岐）にだけ使う
		const mesh = perCode.map(fs => ({ geometry: { type: "MultiLineString", coordinates: interiorMesh(fs) } }));
		const s = buildGeoJSONOverlay(mesh, origin, m.style || undefined);   // style＝AI経路の線色/線幅（無指定は従来既定）
		self.postMessage({ type: "loaded", ok: true, count: feats.length, center: origin, overlay: s }, overlayBufs(s));
	} else if (m.type === "identify") {
		const hit = features ? features.findIndex(f => pointInFeature(m.lon, m.lat, f.geometry)) : -1;
		if (hit < 0) { self.postMessage({ type: "identify", hit: -1 }); return; }
		const s = buildGeoJSONOverlay([features[hit]], origin);   // ヒット地物だけの強調ジオメトリ（小さい）
		self.postMessage({ type: "identify", hit, props: features[hit].properties || {}, overlay: s }, overlayBufs(s));
	} else if (m.type === "highlight") {
		// KEY_CODE 指名のハイライト（パネル行→地図）。完全一致＋9桁指名は prefix 一致（11桁の基本単位区を包含）。
		// bbox は flyTo 用。ヒットゼロは bbox:null（秘匿・年度差で起こり得る＝呼び手は静かに諦める）。
		const key = String(m.key ?? "");
		const hits = features ? features.filter(f => {
			const k = String(f.properties?.KEY_CODE ?? "");
			return k === key || (key.length === 9 && k.slice(0, 9) === key);
		}) : [];
		if (!hits.length) { self.postMessage({ type: "highlighted", key, bbox: null, count: 0 }); return; }
		const s = buildGeoJSONOverlay(hits, origin);
		self.postMessage({ type: "highlighted", key, bbox: bboxOf(hits), count: hits.length, overlay: s }, overlayBufs(s));
	}
};
