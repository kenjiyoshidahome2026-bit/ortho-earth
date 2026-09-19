// 世界の地震ビューア（quakes.html）の読み込み worker。
// GeoPBF（gzip 可）→ GPU に渡す列（Float32Array）へ展開して main へ transfer する。main をブロックしない。
//   pos   : 震源の 3D 座標（単位球ワールド＝ortho-core の lonlatTo3D と同式・深さぶん内側へ）
//   attr  : [mag, depth(km), 年（小数）] ×N
//   lon/lat/time : クリック時の情報表示用
// 並び順＝マグニチュード昇順（小さい地震を先に描き、大きい地震を上に重ねる＝アルファ合成の順序）。
import { GeoPBF } from "geopbf/pbf-base";
import { parseCsvTexts } from "../quakes-mirror/usgs.js";   // 直近分（CSV）の解析＝取り込み Worker・ビルドスクリプトと同じ規則

const D2R = Math.PI / 180;
const Y0 = Date.UTC(1967, 0, 1), YEAR_MS = 365.2425 * 86400000;

// 1 本ぶんの列 { n, lon, lat, mag, dep, time }（mag か時刻の無い地震は落とす）
function columns(N) {
	return { n: 0, lon: new Float32Array(N), lat: new Float32Array(N), mag: new Float32Array(N), dep: new Float32Array(N), time: new Float64Array(N) };
}
function push(c, lon, lat, mag, dep, t) {
	if (mag == null || !Number.isFinite(t)) return;
	const n = c.n++;
	c.lon[n] = lon; c.lat[n] = lat; c.mag[n] = mag; c.dep[n] = dep == null ? 0 : dep; c.time[n] = t;
}

// GeoPBF（gzip 可・URL か ArrayBuffer）
async function loadPbf(src, tag) {
	let u8;
	if (typeof src !== "string") u8 = new Uint8Array(src);
	else {
		self.postMessage({ type: "progress", text: `ダウンロード中…${tag}` });
		const res = await fetch(src);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${src}`);
		u8 = new Uint8Array(await res.arrayBuffer());
	}
	if (u8[0] === 0x1f && u8[1] === 0x8b) {   // gzip は署名で判定（拡張子を信用しない）
		self.postMessage({ type: "progress", text: `展開中…${tag}` });
		u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
	}
	self.postMessage({ type: "progress", text: `GeoPBF を読み込み中…${tag}` });
	const pbf = await new GeoPBF().set(u8);
	const c = columns(pbf.length);
	for (let i = 0; i < pbf.length; i++) {
		const g = pbf.getGeometry(i);
		if (!g || g.type !== "Point") continue;
		const p = pbf.getProperties(i) || {};
		push(c, g.coordinates[0], g.coordinates[1], p.mag, p.depth, p.date instanceof Date ? p.date.getTime() : Date.parse(p.date));
		if ((i & 0x3ffff) === 0) self.postMessage({ type: "progress", text: `GeoPBF を読み込み中…${tag} ${Math.round(i / pbf.length * 100)}%` });
	}
	c.meta = { name: pbf.name?.(), description: pbf.description?.(), attribution: pbf.attribution?.(), license: pbf.license?.() };
	return c;
}

// quakes-mirror の直近分＝目次（recent.json）→ 月別 CSV（USGS のまま）を並列に取って解析（usgs.js と同じ規則）
async function loadRecent(url, tag) {
	self.postMessage({ type: "progress", text: `直近分の目次…${tag}` });
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	const man = await res.json();
	const texts = await Promise.all(man.windows.map(async w => {
		const r = await fetch(new URL(`${w.key}?v=${w.fetchedAt}`, url));   // 取り直すと v が変わる＝長期キャッシュのまま最新を読む
		if (!r.ok) throw new Error(`HTTP ${r.status} ${w.key}`);
		return r.text();
	}));
	self.postMessage({ type: "progress", text: `直近分を解析中…${tag}` });
	const { N, T, LON, LAT, DEP, MAG } = parseCsvTexts(texts);
	const c = columns(N);
	for (let i = 0; i < N; i++) push(c, LON[i], LAT[i], MAG[i], DEP[i], T[i]);
	c.meta = { description: `USGS ANSS ComCat earthquakes, M${man.minmag}+, ${man.start} to ${man.end} (exclusive), worldwide.` };
	return c;
}

const load = (src, tag) => typeof src === "string" && /\.json(\?|$)/.test(new URL(src).pathname) ? loadRecent(src, tag) : loadPbf(src, tag);

// srcs＝URL か ArrayBuffer の列（例：archive.geopbf＋recent.json）。連結して 1 枚のカタログにする。
// 2 本以上のとき、落ちた本は飛ばして残りで出す（recent 未取得・一時的な 503 でも過去分は見せる）＝全滅だけがエラー
self.onmessage = async e => {
	const { srcs, rAx = 1, earthM = 6371000 } = e.data;
	try {
		const got = await Promise.allSettled(srcs.map((s, q) => load(s, srcs.length > 1 ? ` (${q + 1}/${srcs.length})` : "")));
		if (srcs.length === 1 && got[0].status === "rejected") throw got[0].reason;
		got.forEach((g, q) => g.status === "rejected" && console.warn("[quakes] skipped", typeof srcs[q] === "string" ? srcs[q] : "buffer", g.reason));
		const parts = got.filter(g => g.status === "fulfilled").map(g => g.value);   // 並びは srcs の順（archive→recent）
		if (!parts.length) throw new Error("どのデータも読めませんでした");
		const n = parts.reduce((a, c) => a + c.n, 0);
		const lon = new Float32Array(n), lat = new Float32Array(n), mag = new Float32Array(n), dep = new Float32Array(n), time = new Float64Array(n);
		let o = 0;
		for (const c of parts) {
			lon.set(c.lon.subarray(0, c.n), o); lat.set(c.lat.subarray(0, c.n), o); mag.set(c.mag.subarray(0, c.n), o);
			dep.set(c.dep.subarray(0, c.n), o); time.set(c.time.subarray(0, c.n), o);
			o += c.n;
		}
		// マグニチュード昇順
		const order = new Uint32Array(n);
		for (let i = 0; i < n; i++) order[i] = i;
		order.sort((a, b) => mag[a] - mag[b]);

		const pos = new Float32Array(n * 3), attr = new Float32Array(n * 3);
		const oLon = new Float32Array(n), oLat = new Float32Array(n), oTime = new Float64Array(n);
		for (let k = 0; k < n; k++) {
			const i = order[k];
			// lonlatTo3D（β単位球）＋深さ＝測地法線に沿って内側へ（球では動径を縮めるのと同じ）
			const a = lon[i] * D2R, b = lat[i] * D2R;
			let sb = Math.sin(b), cb = Math.cos(b);
			const nx = cb * Math.cos(a), ny = sb / rAx, nz = cb * Math.sin(a);   // ellNormal3D
			if (rAx !== 1) { const w = Math.hypot(cb, rAx * sb); sb = rAx * sb / w; cb = cb / w; }
			const h = -dep[i] * 1000 / earthM;
			pos[k * 3] = cb * Math.cos(a) + h * nx;
			pos[k * 3 + 1] = sb + h * ny;
			pos[k * 3 + 2] = cb * Math.sin(a) + h * nz;
			attr[k * 3] = mag[i];
			attr[k * 3 + 1] = dep[i];
			attr[k * 3 + 2] = 1967 + (time[i] - Y0) / YEAR_MS;
			oLon[k] = lon[i]; oLat[k] = lat[i]; oTime[k] = time[i];
		}
		const m0 = parts.find(c => c.meta.attribution)?.meta ?? {};
		const meta = { name: m0.name, description: parts.map(c => c.meta.description).filter(Boolean).join("\n"),
			attribution: m0.attribution ?? "U.S. Geological Survey, ANSS Comprehensive Earthquake Catalog (ComCat)", license: m0.license ?? "Public domain (U.S. Geological Survey)" };
		self.postMessage({ type: "done", n, pos, attr, lon: oLon, lat: oLat, time: oTime, meta },
			[pos.buffer, attr.buffer, oLon.buffer, oLat.buffer, oTime.buffer]);
	} catch (err) {
		self.postMessage({ type: "error", message: String(err?.message || err) });
	}
};
