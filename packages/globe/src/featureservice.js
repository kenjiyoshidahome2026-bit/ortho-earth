// 公開のフィーチャーサービスを地図へ（#176）。読みの本体は geopbf/featureservice（ArcGIS REST・OGC API – Features）＝ここは地図の側：
//   開く    … 取得は呼び手の fetch（globe の requester＝transformRequest で利用者の鍵・addProtocol）＝どこの proxy も通らない
//   丸ごと  … 件数が WHOLE_MAX 以下（本人裁定 2026-09-30「件数で決める」）＝全件を 1 つの FeatureCollection に
//   視野追従 … それより多い層＝見えている範囲を固定の格子（スリッピータイルの枡）に割って、足りない枡だけ bbox で問い合わせる。
//             動いて止まった時（settle）に読み直す・枡ごとに控える（メモリ）・地物の id で重複を落とす・上限を超えたら遠い枡から捨てる。
//             範囲の件数が上限を超える間（引きすぎ）は読まない＝寄れば読む（サービスに全件を頼まない）。
// 控え（本人 2026-09-30「一度読んだ Feature は IDB で GeoPBF/GintBUF として使い回す」）＝枡ごとに cache.get/put（globe.js が geopbfCached へ繋ぐ）＝
//             一度読んだ枡は次の訪問でも網に出ない。鍵はサービスの版（ArcGIS の lastEditDate）を含む＝中身が替われば鍵も替わる。
// 描き先は呼び手（onData）＝?g= は利用者の gint 枠・addSource の data URL は MapLibre の層（どちらも gint＝識別が効く・本人裁定）。
import { openFeatureService, featureId, parseServiceUrl } from "geopbf/featureservice";

export { parseServiceUrl };
export const WHOLE_MAX = 50000;       // 丸ごと読む件数の上限（これを超えたら視野追従）
export const VIEW_MAX = 100000;       // 視野追従で手元に置く地物の上限（超えたら遠い枡から捨てる）

export const openService = (url, { fetch, signal } = {}) => openFeatureService(url, { fetch, signal });

// 枡（z/x/y）の範囲・経緯度 → 枡
const tileLon = (x, z) => x / 2 ** z * 360 - 180;
const tileLat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
const cellBbox = (z, x, y) => [tileLon(x, z), tileLat(y + 1, z), tileLon(x + 1, z), tileLat(y, z)];
const lonToX = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const latToY = (lat, z) => { const l = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 * 2 ** z); };
/** 範囲（w>e＝日付変更線を跨ぐ）を覆う z の枡の一覧 */
export function cellsFor(b, z) {
	const n = 2 ** z, out = [];
	const spans = b[0] <= b[2] ? [[b[0], b[2]]] : [[b[0], 180], [-180, b[2]]];
	const y0 = Math.max(0, latToY(b[3], z)), y1 = Math.min(n - 1, latToY(b[1], z));
	for (const [w, e] of spans) {
		const x0 = Math.max(0, lonToX(w, z)), x1 = Math.min(n - 1, lonToX(Math.min(e, 179.999999), z));
		for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
	}
	return out;
}

/**
 * 視野追従。map＝{ getBounds(), getZoom(), on("settle"), off }・onData(fc, info)＝手元の全地物が替わった（間引いて呼ぶ）。
 * @returns {{ ready: Promise, update(): Promise, destroy(): void, stats(): object }}
 */
export function followView(svc, { map, onData, onStatus = () => {}, cache = null, maxFeatures = VIEW_MAX, maxInflight = 2, maxCells = 48, minZ = 2, maxZ = 16 } = {}) {
	const cells = new Map();   // "z/x/y" → { ids: string[], used }
	const feats = new Map();   // id → { f, refs }
	const pending = new Set();
	let gen = 0, ac = new AbortController(), destroyed = false, emitT = 0, seq = 0, anon = 0, lastStatus = null;
	const st = { requests: 0, cells: 0, cacheHits: 0, skippedTooMany: 0, evicted: 0 };
	const status = s => { if (s !== lastStatus) { lastStatus = s; onStatus(s); } };
	const emit = () => { clearTimeout(emitT); emitT = setTimeout(() => { if (!destroyed) onData({ type: "FeatureCollection", features: [...feats.values()].map(v => v.f) }, stats()); }, 120); };
	const put = (key, list) => {
		const ids = [];
		for (const f of list) {
			let id = featureId(svc, f); if (id == null) id = "anon:" + (anon++);   // id の無いサービス＝重複は落とせない（枡の境の地物は二重になりうる）
			id = String(id); ids.push(id);
			const e = feats.get(id); if (e) e.refs++; else feats.set(id, { f, refs: 1 });
		}
		cells.set(key, { ids, used: ++seq });
	};
	const drop = key => { const c = cells.get(key); if (!c) return; for (const id of c.ids) { const e = feats.get(id); if (e && --e.refs <= 0) feats.delete(id); } cells.delete(key); st.evicted++; };
	const evict = keep => {
		if (feats.size <= maxFeatures) return;
		for (const [k] of [...cells].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].used - b[1].used)) { drop(k); if (feats.size <= maxFeatures) break; }
	};
	async function update() {
		if (destroyed) return;
		// 画面の縁が球の外（引いた地球）＝範囲が決まらない＝層の件数が上限以下なら層の範囲・超えるなら寄るまで読まない
		const b = map.getBounds?.() ?? (svc.count != null && svc.count <= maxFeatures ? svc.bbox : null);
		if (!b) { st.skippedTooMany++; status("zoom-in"); return; }
		const g = ++gen;
		ac.abort(); ac = new AbortController(); pending.clear();
		const sig = ac.signal;
		let n = await svc.countIn(b, { signal: sig }).catch(e => (e?.name === "AbortError" ? -1 : null));
		if (g !== gen || destroyed || n === -1) return;
		if (n != null && n > maxFeatures) { st.skippedTooMany++; status("zoom-in"); return; }   // 引きすぎ＝読まない（手元の分はそのまま）
		let z = Math.max(minZ, Math.min(maxZ, Math.floor(map.getZoom()) - 1)), list = cellsFor(b, z);
		while (list.length > maxCells && z > minZ) list = cellsFor(b, --z);
		const keys = new Set(list.map(c => c.join("/")));
		for (const k of keys) if (cells.has(k)) cells.get(k).used = ++seq;
		const todo = list.filter(c => !cells.has(c.join("/")));
		if (!todo.length) { status("ready"); return; }
		status("loading");
		let i = 0;
		const worker = async () => {
			while (i < todo.length && g === gen && !destroyed) {
				const [cz, cx, cy] = todo[i++], key = `${cz}/${cx}/${cy}`;
				if (cells.has(key) || pending.has(key)) continue;
				pending.add(key);
				try {
					let list = cache ? await cache.get(key).catch(() => null) : null;
					if (list) st.cacheHits++;
					else {
						st.requests++;
						const fc = await svc.readAll({ bbox: cellBbox(cz, cx, cy), max: maxFeatures, signal: sig });
						list = fc.features;
						if (!fc.truncated && list.length) cache?.put(key, fc).catch(() => {});   // 打ち切った枡は控えない（次は全部読む）
					}
					if (g !== gen || destroyed) return;
					put(key, list); st.cells++;
					evict(keys); emit();
				} catch (e) { if (e?.name !== "AbortError") { console.warn("[featureservice] cell", key, e); status("error"); } }
				finally { pending.delete(key); }
			}
		};
		await Promise.all(Array.from({ length: Math.min(maxInflight, todo.length) }, worker));
		if (g === gen && !destroyed) status("ready");
	}
	const onSettle = () => { update(); };
	map.on("settle", onSettle);
	const stats = () => ({ ...st, features: feats.size, cellsHeld: cells.size, pending: pending.size });
	return {
		ready: Promise.resolve().then(update),   // 一拍おく＝呼び手が戻り値を受け取ってから最初の知らせ（onData/onStatus）が来る
		update, stats,
		destroy() { destroyed = true; ac.abort(); clearTimeout(emitT); map.off?.("settle", onSettle); cells.clear(); feats.clear(); },
	};
}
