// ガジェット：glTF/GLB（3D 模型）の直読み（2026-09-20・本人裁定＝落とした地点＋埋め込みがあれば優先／PLATEAU 建物経路／loaders.gl）。
//   入口：app.js の INTAKE（ドロップ・?g=）と map.gadget.model(src, opts)。src＝File か URL（https・gh: は app の門が展開済み）。
//   読む：相方の worker（model-worker.js）が loaders.gl（PLATEAU 用の遅延チャンク）で解き、plateaudecode.decodeModel＝PLATEAU と同じ後段
//         （剛体接地・RTE・LOD・溶接）で建物メッシュに焼く。main は塞がない。
//   置く：opts.at=[lon,lat]（落とした地点・?at=）。無ければ画面中心（center()）。glb に CESIUM_RTC/ECEF が埋まっていればそちらが勝つ（worker が判定）。
//         heading＝北から時計回りの度・scale＝倍率（?at=lon,lat,heading,scale）。
//   描く：renderer の plateauMesh スロット（setMesh＝app が wPost を注入）＝建物 3D と同じシェーダ（法線陰影・両面）。マテリアルごとに 1 バッチ
//         （key=名前#k・ward=名前）＝uv・頂点色（baseColorFactor×COLOR_0）・baseColorTexture を持つ派生パイプラインで描く（両バックエンド）。
//         PLATEAU の manager は関与しない（登録簿に無い名前は evict されない）。真俯瞰（pitch<0.02）では建物ごと描かれない＝fit はチルト付き。
//   単一スロット＝次の模型は前を置き換える（ドロップの掟「最後の 1 枚が勝つ」）。clear()＝外す。destroy()＝worker も畳む。
import { tr } from "../i18n.js";
import { HEIGHT_KEYS, LEVEL_KEYS } from "../extrude-keys.js";

const MAX_BYTES = 256e6;   // 正気上限（?g= と同じ・敵入力の巨大確保よけ）

// ── 押し出し（extrude・2026-09-21＝MapLibre の fill-extrusion 相当）──────────────────────────
// 高さの鍵は extrude-keys.js（app の自動判定と共有）
const BASE_KEYS = ["min_height", "base_height", "building:min_height", "base"];
const num = v => { if (v == null || v === "") return NaN; if (typeof v === "number") return v; const m = String(v).match(/-?\d+(?:\.\d+)?/); return m ? +m[0] : NaN; };   // "12m"・"約 12.5" も数に
export function heightOf(props, spec) {   // spec＝鍵名 | 数 | (props)=>m | undefined（自動）
	if (typeof spec === "function") return +spec(props || {});
	if (typeof spec === "number") return spec;
	if (!props) return NaN;
	if (typeof spec === "string") return num(props[spec]);
	for (const k of HEIGHT_KEYS) { const h = num(props[k]); if (h > 0) return h; }
	for (const k of LEVEL_KEYS) { const n = num(props[k]); if (n > 0) return n * 3; }
	return NaN;
}
// 色＝#rgb/#rrggbb/#rrggbbaa/rgb()/色名。色名などは canvas に正規化させる（main スレッドだけで呼ぶ）
let ctx2d = null;
function rgbaOf(c) {
	if (typeof c !== "string" || !c) return null;
	let m = c.trim().match(/^#([0-9a-f]{3,8})$/i);
	if (!m) { ctx2d ??= new OffscreenCanvas(1, 1).getContext("2d"); ctx2d.fillStyle = "#000"; ctx2d.fillStyle = c; const f = ctx2d.fillStyle; m = f.match(/^#([0-9a-f]{6})$/i); if (!m) { const r = f.match(/[\d.]+/g); return r ? [+r[0], +r[1], +r[2], 255] : null; } }
	let h = m[1]; if (h.length <= 4) h = [...h].map(x => x + x).join("");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];   // α は捨てる＝壁は不透明（半透明の塗り色でも建物は立つ色で）
}
// 既定の色＝高さの段彩（低い＝明るい砂色 → 高い＝群青）。@fill（geoedit の面の色）があればそちらが勝つ
const RAMP = [[0, [236, 226, 204]], [15, [214, 196, 160]], [40, [150, 170, 196]], [100, [86, 118, 170]], [250, [44, 62, 120]]];
function rampOf(h) {
	for (let i = 1; i < RAMP.length; i++) if (h <= RAMP[i][0]) {
		const [h0, a] = RAMP[i - 1], [h1, b] = RAMP[i], t = (h - h0) / (h1 - h0);
		return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * t)).concat(255);
	}
	return RAMP[RAMP.length - 1][1].concat(255);
}
// GeoJSON（Feature/FeatureCollection/features 配列）→ worker へ渡す面の列（環は度の平坦 Float64Array）
export function extrudePolys(src, { height, base, color, scale = 1 } = {}) {
	const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features : src?.type === "Feature" ? [src] : src?.features || [];
	const out = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null;
		if (!polys) continue;
		const p = f.properties || {};
		const h = heightOf(p, height) * scale;
		if (!(h > 0)) continue;
		let b = typeof base === "function" ? +base(p) : typeof base === "number" ? base : typeof base === "string" ? num(p[base]) : NaN;
		if (!(b >= 0)) { b = 0; for (const k of BASE_KEYS) { const v = num(p[k]); if (v > 0) { b = v; break; } } }
		b *= base == null || typeof base === "string" ? scale : 1;
		if (!(h > b)) continue;
		const rgba = (typeof color === "function" ? rgbaOf(color(p, h)) : rgbaOf(color)) || rgbaOf(p["@fill"]) || rgbaOf(p.color) || rgbaOf(p["building:colour"]) || rampOf(h);
		for (const rings of polys) {
			const rs = [];
			for (const r of rings || []) { if (!r || r.length < 3) continue; const a = new Float64Array(r.length * 2); r.forEach((c, i) => { a[i*2] = c[0]; a[i*2+1] = c[1]; }); rs.push(a); }
			if (rs.length) out.push({ rings: rs, h, base: b, rgba });
		}
	}
	return out;
}

export function createModel(map, { setMesh, fit, center, ell = false, signal } = {}) {
	const t = tr();
	let worker = null, seq = 0, cur = null;   // cur＝{ name, stats, src }
	const waiting = new Map();
	const rpc = (msg, transfer) => new Promise((res, rej) => {
		worker ??= (() => {
			const w = new Worker(new URL("../model-worker.js", import.meta.url), { type: "module", name: "model" });
			w.onmessage = e => { const d = e.data, p = waiting.get(d.id); if (!p) return; waiting.delete(d.id); d.error ? p.rej(new Error(d.error)) : p.res(d); };
			w.onerror = e => console.error("[model] worker error", e.message);
			return w;
		})();
		const id = ++seq; waiting.set(id, { res, rej }); worker.postMessage({ id, ...msg }, transfer || []);
	});
	const clear = () => { if (cur) { setMesh(cur.name, null); cur = null; } };
	let ext = null;   // 押し出しの今＝{ name, stats }（模型とは別スロット＝GLB と並べて立てられる）
	const clearExtrude = () => { if (ext) { setMesh(ext.name, null); ext = null; } };
	const ctl = {
		get stats() { return cur?.stats || null; },
		get bbox() { return cur?.stats?.bbox || null; },
		get name() { return cur?.name || null; },
		clear,
		get extruded() { return ext?.stats || null; },
		clearExtrude,
		// 押し出し：src＝GeoJSON（Feature/FeatureCollection/features 配列）。opts＝{ height: 鍵名|数|fn, base, color: css|fn, scale, mask, fit }
		// 高さ無し（自動の鍵に当たらない）の面は立てない。戻り値＝stats（polygons/triangles/bbox）か、立つ面が無ければ null
		async extrude(src, { height, base, color, scale = 1, mask = true, fit: doFit = false } = {}) {
			const polys = extrudePolys(src, { height, base, color, scale });
			if (!polys.length) { clearExtrude(); return null; }
			const tr = []; for (const p of polys) for (const r of p.rings) tr.push(r.buffer);
			const r = await rpc({ kind: "extrude", polys, ell, mask }, tr);
			clearExtrude();
			const key = `extrude/${++seq}`;
			ext = { name: key, stats: r.stats };
			r.batches.forEach((b, k) => setMesh(`${key}#${k}`, { ...b.mesh, ward: key, tex: null, alphaMode: "OPAQUE", alphaCutoff: 0.5, maskBbox: r.mask?.bbox || null, maskN: r.mask?.n || 0 }));
			console.info(`[extrude] ${r.stats.polygons} polygons, ${r.stats.triangles} tris`, r.stats.bbox);
			if (doFit && fit) fit(r.stats.bbox);
			return r.stats;
		},
		destroy() { clear(); clearExtrude(); worker?.terminate(); worker = null; waiting.clear(); },
		// src＝File | URL 文字列。戻り値＝ctl（stats/bbox）。失敗は throw（dropFile がトーストへ出す）
		// ground="each"＝連結成分ごとに接地（街の一区画を切り出した模型＝高台の建物が浮かない）。既定 "batch"＝一体で接地
		// mask=true＝模型の足元の基図建物を伏せる（街の一区画を切り出した模型＝白い箱と二重に描いて壁が明滅するのを断つ）
		async load(src, { at = null, heading = 0, scale = 1, name = null, fit: doFit = true, textures = true, ground = "batch", mask = false } = {}) {   // textures=false＝形だけ（画像を読まない）
			let ab, baseUri = null;
			if (typeof src === "string") {
				const r = await fetch(src, { credentials: "omit" });
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				if (+r.headers.get("content-length") > MAX_BYTES) throw new Error("too large");
				ab = await r.arrayBuffer();
				baseUri = src;   // .gltf の外部 .bin/画像は URL 相対で解決（File では埋め込み buffer だけ）
				name ??= decodeURIComponent(src.split("/").pop() || "") || "model.glb";
			} else {
				if (src.size > MAX_BYTES) throw new Error("too large");
				ab = await src.arrayBuffer();
				name ??= src.name || "model.glb";
			}
			const anchor = at || center?.() || null;
			const r = await rpc({ ab, at: anchor, heading, scale, baseUri, ell, textures, ground, mask }, [ab]).catch(err => {
				if (err.message === "no-triangles") throw new Error(t("3D model has no triangles"));
				throw err;
			});
			clear();
			const key = `model/${++seq}`;
			cur = { name: key, stats: r.stats, src: name };
			r.batches.forEach((b, k) => setMesh(`${key}#${k}`, { ...b.mesh, ward: key, tex: b.tex, alphaMode: b.alphaMode, alphaCutoff: b.alphaCutoff, maskBbox: r.mask?.bbox || null, maskN: r.mask?.n || 0 }));   // ward＝自分の名前（解放は名前#* の一括・マスク不参加）。バッチ＝マテリアル
			console.info(`[model] ${name}: ${r.stats.triangles} tris, ${r.stats.vertices} verts, ${r.stats.instances} instances, ${r.stats.materials} materials (${r.stats.textures} textured, ${r.stats.blended} blended), placed by ${r.stats.mode}`, r.stats.bbox);
			if (doFit && fit) fit(r.stats.bbox);
			return ctl;
		},
		toastLength() { return cur ? t("$1 triangles", cur.stats.triangles) : "?"; },
	};
	signal?.addEventListener("abort", () => ctl.destroy(), { once: true });
	return ctl;
}
