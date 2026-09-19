// 世界の地震ビューア（quakes.html）の読み込み worker。
// GeoPBF（gzip 可）→ GPU に渡す列（Float32Array）へ展開して main へ transfer する。main をブロックしない。
//   pos   : 震源の 3D 座標（単位球ワールド＝ortho-core の lonlatTo3D と同式・深さぶん内側へ）
//   attr  : [mag, depth(km), 年（小数）] ×N
//   lon/lat/time : クリック時の情報表示用
// 並び順＝マグニチュード昇順（小さい地震を先に描き、大きい地震を上に重ねる＝アルファ合成の順序）。
// 直近分（archive の後〜今）は USGS FDSN（CORS 開放）を直接取りに行く＝月ごとに GeoPBF へ焼いて IDB に置き、表示は常に GeoPBF から読む。
//   確定した月（月末＋30 日以降に取った）は二度と取らない。未確定の月は 1 日・今月（途中まで）は 1 時間たったら取り直す。
//   取れなかった月は IDB の古い版で代打、それも無ければ飛ばして skipped で知らせる。
// 送り方＝層（srcs の 1 本＝q）ごとに、読めたそばから part を送る。直近分は 1 か月届くごとに送り直す（届いた月から地球儀に現れる）。
//   { type:"progress", q, text } … 層ごとの進み具合
//   { type:"part", q, n, pos, attr, lon, lat, time, meta } … 層 q の中身（同じ q は置き換え）
//   { type:"done", n, skipped } / { type:"error", message }
import { GeoPBF } from "geopbf/pbf-base";
import { API, DAY, fetchRange, csvText, parseCsvTexts, buildGeoPBF, months } from "../quakes-mirror/usgs.js";   // ビルドスクリプトと同じ規則で焼く

const D2R = Math.PI / 180;
const Y0 = Date.UTC(1967, 0, 1), YEAR_MS = 365.2425 * 86400000;

// 1 本ぶんの列 { n, lon, lat, mag, dep, time, place }（mag か時刻の無い地震は落とす）。place＝疎（大地震だけ・Map: 添字→USGS の place）
const PLACE_MIN = 7;   // この M 以上だけ地名を持つ（再生中の tip・クリックの詳細用。全件持つと文字列 150 万本）
function columns(N) {
	return { n: 0, lon: new Float32Array(N), lat: new Float32Array(N), mag: new Float32Array(N), dep: new Float32Array(N), time: new Float64Array(N), place: new Map() };
}
function push(c, lon, lat, mag, dep, t, place) {
	if (mag == null || !Number.isFinite(t)) return;
	const n = c.n++;
	c.lon[n] = lon; c.lat[n] = lat; c.mag[n] = mag; c.dep[n] = dep == null ? 0 : dep; c.time[n] = t;
	if (place != null && mag >= PLACE_MIN) c.place.set(n, place);
}
// 列の連結（並びは渡した順）
function concat(parts) {
	const out = columns(parts.reduce((a, c) => a + c.n, 0));
	for (const c of parts) {
		for (const k of ["lon", "lat", "mag", "dep", "time"]) out[k].set(c[k].subarray(0, c.n), out.n);
		for (const [i, p] of c.place) out.place.set(out.n + i, p);
		out.n += c.n;
	}
	return out;
}

// GeoPBF（gzip 可・URL か ArrayBuffer）。say＝進み具合の報告（null なら黙る）
async function loadPbf(src, say) {
	let u8;
	if (typeof src !== "string") u8 = new Uint8Array(src);
	else {
		say?.("ダウンロード中…");
		const res = await fetch(src);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${src}`);
		const size = +res.headers.get("content-length") || 0;
		if (!say || !res.body) u8 = new Uint8Array(await res.arrayBuffer());
		else {   // 何 MB 来たかを見せる
			const chunks = [], mb = n => (n / 1e6).toFixed(1);
			let got = 0, last = 0;
			for (const rd = res.body.getReader(); ;) {
				const { done, value } = await rd.read();
				if (done) break;
				chunks.push(value); got += value.byteLength;
				if (got - last > 5e5) { last = got; say(`ダウンロード中… ${mb(got)}${size ? ` / ${mb(size)}` : ""} MB`); }
			}
			u8 = new Uint8Array(got);
			for (let o = 0, i = 0; i < chunks.length; o += chunks[i++].byteLength) u8.set(chunks[i], o);
		}
	}
	if (u8[0] === 0x1f && u8[1] === 0x8b) {   // gzip は署名で判定（拡張子を信用しない）
		say?.("展開中…");
		u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
	}
	say?.("GeoPBF を読み込み中…");
	const pbf = await new GeoPBF().set(u8);
	const c = columns(pbf.length);
	for (let i = 0; i < pbf.length; i++) {
		const g = pbf.getGeometry(i);
		if (!g || g.type !== "Point") continue;
		const p = pbf.getProperties(i) || {};
		push(c, g.coordinates[0], g.coordinates[1], p.mag, p.depth, p.date instanceof Date ? p.date.getTime() : Date.parse(p.date), p.place);
		if ((i & 0x3ffff) === 0) say?.(`GeoPBF を読み込み中… ${Math.round(i / pbf.length * 100)}%`);
	}
	c.meta = { name: pbf.name?.(), description: pbf.description?.(), attribution: pbf.attribution?.(), license: pbf.license?.() };
	return c;
}

// 月ごとの GeoPBF の置き場（IDB・鍵＝minmag:月初 ms・値＝{ from, to, fetchedAt, buf }）。失敗は全て null＝無かったことに
const monthDb = (() => {
	let p = null;
	const open = () => p ??= new Promise((res, rej) => {
		if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
		const rq = indexedDB.open("ortho-quakes", 1);
		rq.onupgradeneeded = () => rq.result.createObjectStore("m");
		rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
	});
	const run = async (mode, f) => { try { const db = await open(); return await new Promise((res, rej) => { const r = f(db.transaction("m", mode).objectStore("m")); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); } catch { return null; } };
	return { get: k => run("readonly", st => st.get(k)), set: (k, v) => run("readwrite", st => st.put(v, k)),
		keys: () => run("readonly", st => st.getAllKeys()), del: k => run("readwrite", st => st.delete(k)) };
})();

const MINMAG = 2, FINAL_MS = 30 * DAY, HOUR = 3600000, PARALLEL = 3;
const monthEnd = a => { const d = new Date(a); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const fmt = n => n.toLocaleString("ja-JP");
// 置いてある版をそのまま使ってよいか
function usable(m, now) {
	if (!m) return false;
	const whole = m.to >= monthEnd(m.from);
	if (whole && m.fetchedAt >= m.to + FINAL_MS) return true;                 // 確定
	return now - m.fetchedAt < (whole ? DAY : HOUR);                          // 未確定 1 日・今月 1 時間
}
// 期間 [a, z) を USGS から取って GeoPBF に焼く（0 件なら buf＝null）
async function bakeMonth(a, z, now, api) {
	const get = async url => {
		const r = await fetch(url);
		if (r.status === 204) return "";
		if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
		return r.text();
	};
	const cols = parseCsvTexts([csvText(await fetchRange(get, a, z, MINMAG, api))], ["place"]);
	for (let i = 0; i < cols.N; i++) if (!(cols.MAG[i] >= PLACE_MIN)) cols.X[0][i] = null;   // 地名は大地震だけ
	const buf = cols.N ? await buildGeoPBF(cols, { minmag: MINMAG, start: ymd(a), end: ymd(z - 1) }) : null;
	return { from: a, to: z, fetchedAt: now, buf };
}

// 直近分：spec＝起点の日付（YYYY-MM-DD）か、{ end } を持つ JSON の URL（archive.json＝排他終端）。起点〜今を月ごとに。
// 1 か月届くごとに onPart（それまでに届いた月の連結）を呼ぶ
async function loadUsgs(spec, say, onPart, now, api = API) {
	let start = spec;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
		const r = await fetch(spec);
		if (!r.ok) throw new Error(`HTTP ${r.status} ${spec}`);
		start = (await r.json()).end;
	}
	const s = Date.parse(start + "T00:00:00Z");
	if (!Number.isFinite(s)) throw new Error(`bad start ${start}`);
	const wins = months(s, Math.floor(now / 1000) * 1000);
	const key = a => `${MINMAG}:${a}`;
	// archive に入った月は捨てる
	const keep = new Set(wins.map(([a]) => key(a)));
	for (const k of await monthDb.keys() ?? []) if (!keep.has(k)) await monthDb.del(k);

	const cols = new Array(wins.length).fill(null), skipped = [];
	let next = 0, done = 0, rows = 0, fetched = 0;
	const meta = () => ({ description: `USGS ANSS ComCat earthquakes, M${MINMAG}+, ${start} to ${ymd(now)}, worldwide (fetched from USGS FDSN).` });
	const lane = async () => {
		for (let i; (i = next++) < wins.length;) {
			const [a, z] = wins[i], ym = ymd(a).slice(0, 7);
			const have = await monthDb.get(key(a));
			let m = usable(have, now) ? have : null;
			if (!m) {
				say(`USGS から直接取得中… ${ym}（${done}/${wins.length} か月・${fmt(rows)} 件）`);
				try { m = await bakeMonth(a, z, now, api); await monthDb.set(key(a), m); fetched++; }
				catch (err) { console.warn("[quakes] USGS", ym, err.message); m = have; if (!m) skipped.push(ym); }
			}
			if (m?.buf) { const b = m.buf; cols[i] = await loadPbf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), null); rows += cols[i].n; }
			done++;
			say(`USGS から直接取得中… ${ym}（${done}/${wins.length} か月・${fmt(rows)} 件）`);
			if (done < wins.length) onPart(Object.assign(concat(cols.filter(Boolean)), { meta: meta() }));
		}
	};
	await Promise.all(Array.from({ length: Math.min(PARALLEL, wins.length) }, lane));
	say(`USGS 直近分 ${start}〜${ymd(now)}：${fmt(rows)} 件（${wins.length} か月・${fetched ? `うち ${fetched} か月を USGS から今取得` : "すべて手元の GeoPBF から"}）`);
	return Object.assign(concat(cols.filter(Boolean)), { meta: meta(), skipped });
}

// 列 → GPU に渡す形（マグニチュード昇順）
function toGpu({ n, lon, lat, mag, dep, time, place }, rAx, earthM) {
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
	const oPlace = new Map();
	for (let k = 0; k < n; k++) { const p = place.get(order[k]); if (p != null) oPlace.set(k, p); }
	return { n, pos, attr, lon: oLon, lat: oLat, time: oTime, place: oPlace };
}

const load = (src, say, onPart, now, api) => src?.usgs ? loadUsgs(src.usgs, say, onPart, now, api) : loadPbf(src, say);

// srcs＝URL・ArrayBuffer・{ usgs: 起点 } の列（例：archive.geopbf＋{ usgs: archive.json }）。層ごとに part を送り、main が重ねて描く。
// 2 本以上のとき、落ちた本は飛ばして残りで出す（USGS が落ちていても過去分は見せる）＝全滅だけがエラー。飛ばした分は skipped で返す
self.onmessage = async e => {
	const { srcs, rAx = 1, earthM = 6371000, now = Date.now(), api } = e.data;
	const part = (q, c) => {
		const g = toGpu(c, rAx, earthM);
		self.postMessage({ type: "part", q, ...g, meta: c.meta }, [g.pos.buffer, g.attr.buffer, g.lon.buffer, g.lat.buffer, g.time.buffer]);
	};
	try {
		const got = await Promise.allSettled(srcs.map((s, q) =>
			load(s, text => self.postMessage({ type: "progress", q, text: (srcs.length > 1 && !s?.usgs ? "過去分 " : "") + text }), c => part(q, c), now, api).then(c => { part(q, c); return c; })));
		got.forEach((g, q) => {
			if (g.status !== "rejected") return;
			console.warn("[quakes] skipped", typeof srcs[q] === "string" ? srcs[q] : srcs[q]?.usgs ? "USGS" : "buffer", g.reason);
			self.postMessage({ type: "progress", q, text: `読めませんでした：${g.reason?.message || g.reason}` });
		});
		if (srcs.length === 1 && got[0].status === "rejected") throw got[0].reason;
		const parts = got.filter(g => g.status === "fulfilled").map(g => g.value);
		if (!parts.length) throw new Error("どのデータも読めませんでした");
		const skipped = got.flatMap((g, q) => g.status === "rejected" ? [srcs[q]?.usgs ? "USGS" : "archive"] : g.value.skipped ?? []);
		self.postMessage({ type: "done", n: parts.reduce((a, c) => a + c.n, 0), skipped });
	} catch (err) {
		self.postMessage({ type: "error", message: String(err?.message || err) });
	}
};
