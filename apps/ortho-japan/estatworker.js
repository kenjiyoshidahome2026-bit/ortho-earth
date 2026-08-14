// e-Stat 小地域 worker：fetch→gunzip→行単位JSON.parse→fan/線ジオメトリ生成、までを main から追い出す。
// 東京23区で数千ポリゴン＝main でやると数百ms ブロックしていた。identify（点in面）もここで実行＝
// feature 実体は worker に住み、main へは typed array（transfer）とヒット時の properties しか渡らない。
import { buildGeoJSONOverlay, pointInFeature } from "ortho-core";

let features = null, origin = [138, 37];
let featBBoxes = null;   // 地物ごとの外接bbox＝identify/hovertip の point-in-poly 前の即棄却（毎ホバー安価に）

// bbox 即棄却つきの点in面（全地物 point-in-poly より桁で速い＝ズームイン後の毎ホバーでも軽い）。
function findHit(lon, lat) {
	if (!features) return -1;
	for (let i = 0; i < features.length; i++) {
		const b = featBBoxes[i];
		if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
		if (pointInFeature(lon, lat, features[i].geometry)) return i;
	}
	return -1;
}

async function gunzipText(bytes) {
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
	return new TextDecoder().decode(bytes);
}
const overlayBufs = s => [s.fanPos.buffer, s.P1.buffer, s.P2.buffer, s.lineCol.buffer, s.lineHalf.buffer];

// 小地域境界は市区町村の外周が他データと不整合を起こす（県境で顕著＝e-Stat の癖・国交省系と違う点）。
// 描くのは市区町村「内側」の共有エッジのみ＝エッジ多重度で仕分け（同一 shapefile 由来なので共有辺の座標はビット一致）:
// 2回=内側→1本だけ描く / 1回=外周→捨てる（市区町村境界は別レベル＝基図の行政界に委ねる）。
// 多重度は市区町村ごとに数える＝隣接市区町村との突き合わせは最初から発生しない（不整合の検疫）。
// interiorOnly=false（既定・凍結デモの AI 経路）＝全ユニーク辺を描く（従来どおり）。
// interiorOnly=true（census2020）＝多重度2の「内側の共有辺」だけ描き、外周(多重度1)は gint admin(N03) に委ねる
//   ＝市区町村境界は一系統(N03)で隣と同一の線・二重線/汚い点々を断つ。突合キーは 1e-6°丸め＝e-Stat の非ビット一致な
//   内部共有辺（実測：千代田区で完全一致だと868辺が多重度1→336辺が内部の取りこぼし＝破線化）も拾って solid にする。
//   描画は原座標（丸めは突合キーだけ＝視覚ズレ無し）。
function interiorMesh(feats, interiorOnly = false) {
	const count = new Map(), seg = new Map();   // 正規化キー → 出現回数 ／ 原座標の代表辺（描画用）
	const rings = g => g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
	const q = interiorOnly ? (v => Math.round(v * 1e6)) : (v => v);   // 突合キーの量子化（census=1e-6°で非ビット一致を吸収）
	for (const f of feats) if (f.geometry) for (const ring of rings(f.geometry))
		for (let i = 0; i + 1 < ring.length; i++) {
			const a = ring[i], b = ring[i + 1], ax = q(a[0]), ay = q(a[1]), bx = q(b[0]), by = q(b[1]);
			const k = (ax < bx || (ax === bx && ay <= by)) ? `${ax},${ay}|${bx},${by}` : `${bx},${by}|${ax},${ay}`;
			count.set(k, (count.get(k) || 0) + 1);
			if (!seg.has(k)) seg.set(k, [[a[0], a[1]], [b[0], b[1]]]);   // 原座標を代表として保持（描画は丸めない）
		}
	const coords = [];
	for (const [k, n] of count) if (!interiorOnly || n >= 2) coords.push(seg.get(k));
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
		featBBoxes = feats.map(f => bboxOf([f]));   // 地物ごとbbox（1回・identify/hovertip の即棄却用）
		const bb = bboxOf(feats);
		origin = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
		// 表示は内側メッシュ（純線・fan ゼロ）。ポリゴンは identify とヒット強調（下の identify 分岐）にだけ使う
		const mesh = perCode.map(fs => ({ geometry: { type: "MultiLineString", coordinates: interiorMesh(fs, m.interiorOnly) } }));
		const s = buildGeoJSONOverlay(mesh, origin, m.style || undefined);   // style＝AI経路の線色/線幅（無指定は従来既定）
		self.postMessage({ type: "loaded", ok: true, count: feats.length, center: origin, bbox: bb, overlay: s }, overlayBufs(s));   // bbox＝ホバー tip の内外即判定用（外側はworker問合せ無しで gint へ）
	} else if (m.type === "hovertip") {
		// ホバー＝町丁目名(tip)＋その境界を太線で返す（bbox即棄却で毎ホバー安価）。ミスは name:null で tip/境界を消す。
		const hit = findHit(m.lon, m.lat);
		if (hit < 0) { self.postMessage({ type: "hovertip", name: null }); return; }
		const s = buildGeoJSONOverlay([features[hit]], origin, { lineColor: [0.16, 0.40, 0.70, 1.0], lineWidth: 2.6 });   // 青の太線（塗りは呼び側で透明＝境界のみ）
		self.postMessage({ type: "hovertip", name: String(features[hit].properties?.S_NAME ?? ""), overlay: s }, overlayBufs(s));
	} else if (m.type === "identify") {
		const hit = findHit(m.lon, m.lat);
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
		// 選択＝周辺マスクのみ＝境界線ゼロ（統一ルール「選択=マスク/ホバー=線」）。フル解像度の生線を半透明で
		// 重ねると頂点の丸キャップが数珠状に濃くなる（チリチリの正体の一つ・本人指摘2026-08-14）＝線は描かない。
		// マスク塗りの縁が境界を鋭く示す＋ホバー太線が形を出す。呼び手は census bind のみ＝凍結デモ経路に影響なし。
		const s = buildGeoJSONOverlay(hits, origin, { lineColor: [0, 0, 0, 0], lineWidth: 0 });
		self.postMessage({ type: "highlighted", key, bbox: bboxOf(hits), count: hits.length, overlay: s }, overlayBufs(s));
	}
};
