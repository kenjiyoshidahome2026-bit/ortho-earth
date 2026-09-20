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

const MAX_BYTES = 256e6;   // 正気上限（?g= と同じ・敵入力の巨大確保よけ）

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
	const ctl = {
		get stats() { return cur?.stats || null; },
		get bbox() { return cur?.stats?.bbox || null; },
		get name() { return cur?.name || null; },
		clear,
		destroy() { clear(); worker?.terminate(); worker = null; waiting.clear(); },
		// src＝File | URL 文字列。戻り値＝ctl（stats/bbox）。失敗は throw（dropFile がトーストへ出す）
		async load(src, { at = null, heading = 0, scale = 1, name = null, fit: doFit = true, textures = true } = {}) {   // textures=false＝形だけ（画像を読まない）
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
			const r = await rpc({ ab, at: anchor, heading, scale, baseUri, ell, textures }, [ab]).catch(err => {
				if (err.message === "no-triangles") throw new Error(t("3D model has no triangles"));
				throw err;
			});
			clear();
			const key = `model/${++seq}`;
			cur = { name: key, stats: r.stats, src: name };
			r.batches.forEach((b, k) => setMesh(`${key}#${k}`, { ...b.mesh, ward: key, tex: b.tex, alphaMode: b.alphaMode, alphaCutoff: b.alphaCutoff }));   // ward＝自分の名前（解放は名前#* の一括・マスク不参加）。バッチ＝マテリアル
			console.info(`[model] ${name}: ${r.stats.triangles} tris, ${r.stats.vertices} verts, ${r.stats.instances} instances, ${r.stats.materials} materials (${r.stats.textures} textured, ${r.stats.blended} blended), placed by ${r.stats.mode}`, r.stats.bbox);
			if (doFit && fit) fit(r.stats.bbox);
			return ctl;
		},
		toastLength() { return cur ? t("$1 triangles", cur.stats.triangles) : "?"; },
	};
	signal?.addEventListener("abort", () => ctl.destroy(), { once: true });
	return ctl;
}
