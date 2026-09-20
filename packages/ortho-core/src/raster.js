// 画像タイル層（メルカトル XYZ ラスタ）＝v1 ortho-map base.js の知見を v2 のノード（mat4／球／worker／地形）で再導出したもの。
//
// 置き場＝render worker（terrain.js と同じ流儀：自前で取得し、GPU 資産は renderer の口で作る）。DOM に触れない。
// 描画方式＝「先に合成・後で貼る」（RTT ドレープ・2026-09-21 本人指摘「基図をしっかり合成してから処理」）：
//   1. タイル群を GPU で経緯度整列のアトラス（近窓＝視野 1.8 画面幅・遠窓＝選抜の外接）へ合成する（タイル 1 枚＝タイル北西隅からの
//      dLL 格子メッシュ＋uv。uv の v はメルカトル線形＝格子の行・緯度は逆メルカトルで CPU が置く＝メルカトル→経緯度の warp は
//      このメッシュが担う。CRS はシェーダに入れない）
//   2. 地形・球・塗りの FS が画素ごとにアトラスを標本化する（COG スロットと同じ配線）＝地形面そのものに写る＝幾何の不一致がゼロ
//      （頂点で貼る方式は「折れ目をまたぐ弦が地形に潜る」＝細分・バイアス・リフトでは消えなかった＝iPhone 実機）。
// 携えた v1 の知見＝祖先フォールバック（親テクスチャの部分 uv）・CLAMP_TO_EDGE＋mips・世代番号で在庫を全捨て。
// 再導出した所＝選抜（selectLOD：距離 LOD・sticky・地形リフト球）・貼り方（画素標本化）・可視判定（地形/球の FS に委ねる）。
//
// renderer 契約（gl/renderer.js・gpu/renderer.js が実装）：
//   rasterTex(bitmap) → { kind:"tex", bytes, … }      rasterMesh({pos,uv,idx}) → { kind:"mesh", bytes, count, … }
//   rasterFree(handle)                                  setRasterDraws(rd | null)
//   rd = { rev, atlas:2048|1024, near:[W,S,E,N], far:[W,S,E,N]|null, hideFills:bool,
//          layers:[{ order:"under"|"over", opacity, draws:[{ mesh, tex, nw:[lon,lat], bounds:[w,s,e,n], uvT:[u0,v0,su,sv] }] }] }
//   renderer は rev が変わった時だけアトラスを描き直し、毎フレームは標本化だけ（合成は静止中ゼロコスト）
import { selectLOD } from "./tilecover.js";
import { tileBounds, tileLocalToLonLat, tileOutsideCoverage } from "./tile.js";
import { createRasterSource } from "./raster-src.js";

const keyOf = (z, x, y) => `${z}/${x}/${y}`;
const MAX_UP = 5;   // 祖先フォールバックの段数（v1＝3段＋高緯度補正。5 段＝1/32 の部分 uv までは絵として成立）

// タイル 1 枚の格子メッシュ（純関数＝Node で検定）。頂点＝タイル北西隅からの (dlon, dlat) 度・uv＝(i/n, j/n)。
// 同じ z・同じ行 y なら x に依らず同一（経度は線形・緯度は行で決まる）＝メッシュは (z, y, n) でキャッシュできる。
export function buildTileMesh(z, y, n) {
	const [w, , , north] = tileBounds(0, y, z);
	const V = (n + 1) * (n + 1);
	const pos = new Float32Array(V * 2), uv = new Float32Array(V * 2);
	for (let j = 0; j <= n; j++) {
		const [, lat] = tileLocalToLonLat(0, y, z, 0, j, n);
		for (let i = 0; i <= n; i++) {
			const [lon] = tileLocalToLonLat(0, y, z, i, 0, n);
			const k = (j * (n + 1) + i) * 2;
			pos[k] = lon - w; pos[k + 1] = lat - north;
			uv[k] = i / n; uv[k + 1] = j / n;
		}
	}
	const idx = new Uint16Array(n * n * 6);
	let o = 0;
	for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
		const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
		idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
	}
	return { pos, uv, idx, n };
}
// 細分数＝メルカトル→経緯度 warp の精度（アトラスは経緯度整列・タイルはメルカトル）。低 z ほど非線形＝細かく。z≥6 は 8 で十分
export const subdivOf = z => z < 3 ? 32 : z < 6 ? 16 : 8;

// 祖先の部分 uv：タイル (z,x,y) を祖先 (z−d) のテクスチャで描く時の [u0, v0, su, sv]（メルカトルは段を跨いでも線形＝厳密）
export function ancestorUV(x, y, d) {
	const m = 1 << d, inv = 1 / m;
	return [(x & (m - 1)) * inv, (y & (m - 1)) * inv, inv, inv];
}

export function createRaster({ renderer, requestDraw, lowMem = false, post = null, maxTiles = lowMem ? 160 : 400, budgetMB = null } = {}) {
	const layers = new Map();          // id → L
	const meshes = new Map();          // "z/y/n" → { h, seen }（層をまたいで共有）
	const MESH_CAP = 256;
	const BUDGET = budgetMB ? Math.round(budgetMB * 1048576) : (lowMem ? 24 : 64) << 20;   // GPU テクスチャの常駐予算（mips 込み）。LOW_MEM＝iOS jetsam 対策の側。budgetMB＝検定用の明示
	const CONC = lowMem ? 4 : 8;       // 同時取得数（v1 は hardwareConcurrency 本の sub-worker・ここは fetch の並列）
	const CONC_MOVING = lowMem ? 1 : 2;   // 遷移中（飛行/入力）は絞る＝「トランジション通過点で重い層を発火させない」の一般則（着地で本来の並列へ戻る）
	let inflight = 0, clock = 0, texBytes = 0, meshBytes = 0, drawCount = 0, gen = 0, moving = false, rev = 0, lastSig = "", texSeq = 0;
	const say = m => { if (post) try { post(m); } catch { /* main が居ない（検定等）＝無害 */ } };

	function meshFor(z, y) {
		const n = subdivOf(z), k = `${z}/${y}/${n}`;
		let m = meshes.get(k);
		if (!m) {
			const h = renderer.rasterMesh(buildTileMesh(z, y, n));
			meshBytes += h.bytes || 0;
			m = { h, seen: 0 }; meshes.set(k, m);
			if (meshes.size > MESH_CAP) {   // 最も古いものを落とす（LRU）
				let oldK = null, old = Infinity;
				for (const [kk, mm] of meshes) if (mm.seen < old && kk !== k) { old = mm.seen; oldK = kk; }
				if (oldK) { const mm = meshes.get(oldK); meshBytes -= mm.h.bytes || 0; renderer.rasterFree(mm.h); meshes.delete(oldK); }
			}
		}
		m.seen = clock;
		return m.h;
	}

	function freeEntry(e) {
		if (e.ac) { e.ac.abort(); e.ac = null; }
		if (e.tex) { texBytes -= e.bytes || 0; renderer.rasterFree(e.tex); e.tex = null; e.bytes = 0; }
	}

	// 取得（並列上限つき・距離順）。ready で層を dirty＝次フレームで描画リストが更新される
	function pump() {
		while (inflight < (moving ? CONC_MOVING : CONC)) {
			let best = null, bestL = null;
			for (const L of layers.values()) {
				if (!L.source || !L.queue.length) continue;
				const q = L.queue[0];
				if (!best || q.dist < best.dist) { best = q; bestL = L; }
			}
			if (!best) return;
			bestL.queue.shift();
			const L = bestL, e = L.cache.get(best.key);
			if (!e || e.status !== "queued") continue;
			e.status = "loading"; e.ac = new AbortController(); inflight++;
			const myGen = L.gen, src = L.source;
			src.get(best.z, best.x, best.y, e.ac.signal).then(bitmap => {
				inflight--; e.ac = null;
				if (L.gen !== myGen || !layers.has(L.id)) { bitmap?.close?.(); return; }   // 世代替わり（remove/再 add）の遅着＝捨てる
				if (!bitmap) { e.status = "empty"; }
				else {
					try { e.tex = renderer.rasterTex(bitmap); e.tex.id = ++texSeq; e.bytes = e.tex.bytes || 0; texBytes += e.bytes; e.status = "ready"; }
					catch (err) { e.status = "error"; e.tries = (e.tries || 0) + 1; console.warn("[raster] texture upload failed", err?.message); }
					bitmap.close?.();
				}
				L.dirty = true; requestDraw && requestDraw(); pump();
			}, err => {
				inflight--; e.ac = null;
				if (String(err && err.message) === "aborted" || err?.name === "AbortError") { L.cache.delete(best.key); pump(); return; }   // 視野外中断＝再訪で再取得
				e.status = "error"; e.tries = (e.tries || 0) + 1; e.err = String(err && err.message || err);
				if (e.tries <= 3) setTimeout(() => { if (layers.has(L.id) && L.cache.get(best.key) === e && e.status === "error") { e.status = "retry"; L.dirty = true; requestDraw && requestDraw(); } }, 400 * e.tries);
				else if (!L.warned) { L.warned = true; console.warn(`[raster] ${L.id}: tile fetch keeps failing (${e.err})`); say({ type: "rasterError", id: L.id, error: e.err }); }
				pump();
			});
		}
	}

	function selectFor(L, cam, W, H, opts) {
		const src = L.source;
		// 可視集合そのものが予算を超えるなら一段粗く（tilePx を上げる＝分割を早く止める）：退避は「今描いている物」を触れない
		// ので、可視集合を予算内に収めるのは選抜の責任（LOW_MEM 24MB＝写真 256²+mips≈350KB×68 枚）。層が複数なら分け合う。
		const perTile = src.tileSize * src.tileSize * 4 * 4 / 3, share = BUDGET * 0.7 / Math.max(1, layers.size);
		let tilePx = src.tileSize * 1.1, sel = null;   // 256px タイル＝画面上 ≈282px を超えたら分割（bvmap 512px の 560 と同じ比率）
		for (let step = 0; step < 4; step++) {
			sel = selectLOD(cam, W, H, { minZ: Math.max(0, src.minZoom), maxZ: src.maxZoom, tilePx, sticky: step ? null : L.sticky, groundR: opts?.groundR ?? 1 });
			if (sel.length * perTile <= share) break;
			tilePx *= 1.6;
		}
		// 枚数の上限（低 z の巨大視野・極端なチルト）：中心に近い順に残す＝遠景の掠りタイルを落とす
		if (sel.length > maxTiles) {
			const c = cam.center;
			for (const t of sel) { const [w, s, e, n] = tileBounds(t.x, t.y, t.z); t._d = Math.hypot((w + e) / 2 - c[0], (s + n) / 2 - c[1]); }
			sel.sort((a, b) => a._d - b._d); sel.length = maxTiles;
		}
		L.sticky = new Set();
		for (const t of sel) { let z = t.z, x = t.x, y = t.y; while (z > src.minZoom) { z--; x >>= 1; y >>= 1; const k = keyOf(z, x, y); if (L.sticky.has(k)) break; L.sticky.add(k); } }
		return sel;
	}

	// 選抜タイルを在庫へ（未着は取得列へ）・視野外の取得は中断・予算超過は LRU 退避・描画リストを組む
	function updateLayer(L, cam, W, H, opts) {
		const src = L.source, sel = selectFor(L, cam, W, H, opts);
		const keep = new Set();
		const c = cam.center;
		L.queue.length = 0;
		for (const t of sel) {
			const k = keyOf(t.z, t.x, t.y);
			keep.add(k);
			let e = L.cache.get(k);
			if (!e) {
				e = { status: "queued", z: t.z, x: t.x, y: t.y, tex: null, bytes: 0, seen: clock, tries: 0 };
				if (tileOutsideCoverage(t.x, t.y, t.z, src.bbox)) e.status = "empty";   // 配信圏外＝要求を作らない（404 の無駄打ちを断つ）
				L.cache.set(k, e);
			} else if (e.status === "retry") e.status = "queued";
			e.seen = clock;
			const [w, s, ea, n] = tileBounds(t.x, t.y, t.z), dist = Math.hypot((w + ea) / 2 - c[0], (s + n) / 2 - c[1]);
			if (e.status === "queued") L.queue.push({ key: k, z: t.z, x: t.x, y: t.y, dist });
			else if (e.status === "empty") {
				// 無い（404/索引外）＝v1 base.js と同じく祖先で埋める：連鎖の最初の「未知」の祖先を要求（ready/取得中に当たれば止まる）
				let z = t.z, x = t.x, y = t.y;
				for (let d = 1; d <= MAX_UP && z > 0; d++) {
					z--; x >>= 1; y >>= 1;
					const ak = keyOf(z, x, y), ae = L.cache.get(ak);
					if (!ae) {
						const aq = { status: "queued", z, x, y, tex: null, bytes: 0, seen: clock, tries: 0 };
						if (tileOutsideCoverage(x, y, z, src.bbox)) aq.status = "empty";
						L.cache.set(ak, aq); keep.add(ak);
						if (aq.status === "queued") L.queue.push({ key: ak, z, x, y, dist: dist + d });   // 同距離なら子を先に
						break;
					}
					if (ae.status !== "empty") break;
				}
			}
		}
		L.queue.sort((a, b) => a.dist - b.dist);
		// 祖先（フォールバック候補）も「最近見えた」扱い＝LRU で先に消えて穴にならない
		for (const t of sel) { let z = t.z, x = t.x, y = t.y; for (let d = 1; d <= MAX_UP && z > 0; d++) { z--; x >>= 1; y >>= 1; const e = L.cache.get(keyOf(z, x, y)); if (e) { e.seen = clock; keep.add(keyOf(z, x, y)); } } }
		for (const [k, e] of L.cache) if (e.status === "loading" && !keep.has(k)) { e.ac?.abort(); }   // 視野外は fetch ごと中断（catch が cache から消す）
		for (const [k, e] of L.cache) if (e.status === "queued" && !keep.has(k)) L.cache.delete(k);
		pump();
		// 描画リスト：自身が ready ならそのまま・未着/無しなら ready な祖先の部分 uv（v1 の親フォールバック）・祖先も無ければ描かない（球の下地が透ける）
		const draws = [];
		for (const t of sel) {
			let z = t.z, x = t.x, y = t.y, e = L.cache.get(keyOf(z, x, y));
			let d = 0;
			while (!(e && e.status === "ready") && d < MAX_UP && z > 0) { z--; x >>= 1; y >>= 1; d++; e = L.cache.get(keyOf(z, x, y)); }
			if (!(e && e.status === "ready")) continue;
			const b = tileBounds(t.x, t.y, t.z);
			draws.push({ mesh: meshFor(t.z, t.y), tex: e.tex, nw: [b[0], b[3]], bounds: b, uvT: d ? ancestorUV(t.x, t.y, d) : [0, 0, 1, 1], z: t.z });
		}
		L.draws = draws;
		L.selN = sel.length;
	}

	function evict() {
		if (texBytes <= BUDGET) return;
		// ⚠描画リストが参照中のテクスチャは絶対に退避しない：WebGPU は「破棄済みテクスチャを submit で使用」＝検証エラーで
		// フレームが丸ごと落ちる（＝黒画面。iPhone 実機で 2026-09-21 に被弾：静止中は seen が進まないのに時計だけ進み、
		// 予算超過の瞬間に可視タイルまで destroy していた）。可視集合が予算を超える分は selectFor の粗化が受け持つ。
		const inUse = new Set();
		for (const L of layers.values()) for (const d of L.draws) inUse.add(d.tex);
		const cands = [];
		for (const L of layers.values()) for (const [k, e] of L.cache) if (e.status === "ready" && e.tex && !inUse.has(e.tex)) cands.push([L, k, e]);
		cands.sort((a, b) => a[2].seen - b[2].seen);
		for (const [L, k, e] of cands) { if (texBytes <= BUDGET) break; freeEntry(e); L.cache.delete(k); }
	}

	// 毎フレーム（render worker の frame から。カメラ不変・在庫不変なら選抜は走らない）
	function update(cam, W, H, opts) {
		if (!layers.size) return;
		clock++;
		const wasMoving = moving; moving = !!opts?.moving;
		if (wasMoving && !moving) { for (const L of layers.values()) L.dirty = true; pump(); }   // 着地＝絞っていた取得を本来の並列で再開
		const key = `${cam.zoom.toFixed(3)}/${cam.center[0].toFixed(5)}/${cam.center[1].toFixed(5)}/${(cam.pitch || 0).toFixed(3)}/${(cam.bearing || 0).toFixed(3)}/${W}x${H}/${(opts?.groundR ?? 1).toFixed(4)}`;
		let changed = false;
		// アトラスの窓：近窓＝視野中心 ±0.9 画面幅（cog ガジェットの viewWindow と同じ尺＝2048px が ≈1.1px/画面px）・遠窓＝選抜タイルの外接
		// （近窓を含む・近窓の 24 倍まで）。窓は動いても rev が変わらなければ描き直さない（下）
		const dpr = cam.dpr || 1, capW = 360 * (W / dpr) / (256 * Math.pow(2, cam.zoom)) * 0.9, capH = capW * H / W;
		const cx = cam.center[0], cy = cam.center[1];
		const near = [cx - capW, Math.max(-85, cy - capH), cx + capW, Math.min(85, cy + capH)];
		const rd = { rev: 0, atlas: lowMem ? 1024 : 2048, near, far: null, hideFills: false, layers: [] };
		for (const L of layers.values()) {
			if (!L.source || !L.visible) { if (L.draws.length) { L.draws = []; changed = true; } continue; }
			const inRange = cam.zoom >= L.showMin && cam.zoom <= L.showMax;
			if (!inRange) { if (L.draws.length) { L.draws = []; changed = true; } continue; }
			if (L.camKey !== key || L.dirty) { L.camKey = key; L.dirty = false; updateLayer(L, cam, W, H, opts); changed = true; }
			else {
				// 原点は cam.center＝カメラ不変なら off も不変（camKey が同じ＝center 同じ）
			}
			if (L.draws.length) rd.layers.push({ order: L.order, opacity: L.opacity, draws: L.draws });
			if (L.order === "under" && L.hideFills && L.draws.length) rd.hideFills = true;
		}
		evict();
		drawCount = 0; for (const l of rd.layers) drawCount += l.draws.length;
		if (rd.layers.length) {
			let fw = near[0], fs = near[1], fe = near[2], fn = near[3];
			for (const l of rd.layers) for (const d of l.draws) { fw = Math.min(fw, d.bounds[0]); fs = Math.min(fs, d.bounds[1]); fe = Math.max(fe, d.bounds[2]); fn = Math.max(fn, d.bounds[3]); }
			const capF = 24;   // 遠窓の上限＝近窓の 24 倍（z0 の全球タイルなどで無限に広げない）
			fw = Math.max(fw, cx - capW * capF); fe = Math.min(fe, cx + capW * capF); fs = Math.max(fs, cy - capH * capF, -85); fn = Math.min(fn, cy + capH * capF, 85);
			rd.far = (fw < near[0] - 1e-9 || fs < near[1] - 1e-9 || fe > near[2] + 1e-9 || fn > near[3] + 1e-9) ? [fw, fs, fe, fn] : null;
			// 改訂番号：描画リスト（tex/uvT）か窓が変わった時だけ進める＝静止中に到着が無ければアトラスは描き直さない
			const sig = rd.near.map(v => v.toFixed(5)).join(",") + "|" + (rd.far ? rd.far.map(v => v.toFixed(5)).join(",") : "-") + "|" + rd.layers.map(l => l.order + l.opacity + ":" + l.draws.map(d => d.tex.id + "/" + d.uvT.join(",") + "/" + d.nw[0].toFixed(6) + "," + d.nw[1].toFixed(6)).join(";")).join("#");
			if (sig !== lastSig) { lastSig = sig; rev++; }
			rd.rev = rev;
		} else lastSig = "";
		renderer.setRasterDraws(rd.layers.length ? rd : null);
		return changed;
	}

	async function add(id, spec, opts = {}) {
		if (layers.has(id)) remove(id);
		const L = {
			id, spec, source: null, error: null, gen: ++gen,
			order: opts.order === "over" ? "over" : "under",
			opacity: Number.isFinite(opts.opacity) ? Math.max(0, Math.min(1, opts.opacity)) : 1,
			visible: opts.visible !== false,
			hideFills: opts.hideFills !== undefined ? !!opts.hideFills : opts.order !== "over",   // 基図（under）は塗りを伏せる（裁定：線と注記は残す）
			showMin: -Infinity, showMax: Infinity, cache: new Map(), queue: [], sticky: null, draws: [], dirty: true, camKey: "", selN: 0, warned: false,
		};
		layers.set(id, L);
		try {
			const src = await createRasterSource(spec);
			if (!layers.has(id) || layers.get(id) !== L) { src.close(); throw new Error("removed while opening"); }
			L.source = src;
			L.showMin = Number.isFinite(opts.minZoom) ? opts.minZoom : src.minZoom - 1.5;   // 表示域＝配信下限の 1.5 段下から（v1 minZoom 門）。下は選抜爆発を避ける
			L.showMax = Number.isFinite(opts.maxZoom) ? opts.maxZoom : Infinity;
			const info = { id, kind: src.kind, tileSize: src.tileSize, minZoom: src.minZoom, maxZoom: src.maxZoom, bbox: src.bbox, attribution: src.attribution, name: src.name, tileType: src.tileType || null, order: L.order, opacity: L.opacity, hideFills: L.hideFills };
			L.info = info;
			L.dirty = true; requestDraw && requestDraw();
			say({ type: "rasterInfo", id, info });
			return info;
		} catch (err) {
			L.error = String(err && err.message || err);
			if (layers.get(id) === L) layers.delete(id);
			say({ type: "rasterError", id, error: L.error });
			throw err;
		}
	}
	function remove(id) {
		const L = layers.get(id); if (!L) return false;
		L.gen = ++gen;
		for (const e of L.cache.values()) freeEntry(e);
		L.cache.clear(); L.queue.length = 0; L.draws = [];
		L.source?.close?.();
		layers.delete(id);
		if (!layers.size) renderer.setRasterDraws(null);
		requestDraw && requestDraw();
		return true;
	}
	function set(id, o = {}) {
		const L = layers.get(id); if (!L) return false;
		if (o.opacity != null && Number.isFinite(o.opacity)) L.opacity = Math.max(0, Math.min(1, o.opacity));
		if (o.visible != null) L.visible = !!o.visible;
		if (o.order === "under" || o.order === "over") L.order = o.order;
		if (o.hideFills != null) L.hideFills = !!o.hideFills;
		if (o.minZoom != null) L.showMin = o.minZoom;
		if (o.maxZoom != null) L.showMax = o.maxZoom;
		L.dirty = true; requestDraw && requestDraw();
		return true;
	}
	function stats() {
		const out = { layers: [], texBytes, meshBytes, draws: drawCount, meshes: meshes.size, inflight, budget: BUDGET };
		for (const L of layers.values()) {
			let ready = 0, loading = 0, empty = 0, error = 0;
			for (const e of L.cache.values()) { if (e.status === "ready") ready++; else if (e.status === "loading" || e.status === "queued") loading++; else if (e.status === "empty") empty++; else error++; }
			out.layers.push({ id: L.id, kind: L.source?.kind || null, ready, loading, empty, error, selected: L.selN, draws: L.draws.length, order: L.order, opacity: L.opacity, visible: L.visible, hideFills: L.hideFills });
		}
		return out;
	}
	function destroy() {
		for (const id of [...layers.keys()]) remove(id);
		for (const m of meshes.values()) renderer.rasterFree(m.h);
		meshes.clear(); meshBytes = 0;
	}
	return { add, remove, set, update, stats, destroy, bytes: () => texBytes + meshBytes, has: id => layers.has(id), list: () => [...layers.keys()] };
}
