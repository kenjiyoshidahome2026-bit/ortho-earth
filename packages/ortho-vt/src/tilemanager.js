// タイル・マネージャ：カメラから可視タイルを算出し、非同期に取得・生成・キャッシュ・破棄する。
// 幾何はタイル毎原点、ラベルは絶対座標（跨ぎ共通原点）。ラベル衝突は全可視タイル横断でグローバル。
import { fetchMVT } from "./decode.js";
import { tileBounds } from "./tile.js";
import { buildTileDrawList } from "./build.js";
import { buildLabels } from "./labels.js";
import { pickZoom, visibleTiles } from "./tilecover.js";

const keyOf = t => `${t.z}/${t.x}/${t.y}`;

export function createTileManager({ renderer, atlas, style, tileUrl, glyphFont, onChange, cap = 128 }) {
	const cache = new Map();   // key → { status:'loading'|'ready'|'error', origin, labels }
	let stable = [];           // 直近で全可視タイルが揃った order（LOD切替中のフォールバック下地）

	async function ensure(t) {
		const k = keyOf(t);
		if (cache.has(k)) return;
		cache.set(k, { status: "loading" });
		try {
			const layers = await fetchMVT(tileUrl(t.z, t.x, t.y));
			const [w, s, e, n] = tileBounds(t.x, t.y, t.z);
			const origin = [w, n];
			const dl = buildTileDrawList({ layers, z: t.z, x: t.x, y: t.y }, style, origin);
			const { labels, codepoints } = buildLabels({ layers, z: t.z, x: t.x, y: t.y }, style);
			renderer.uploadTile(k, dl);
			cache.set(k, { status: "ready", origin, labels });
			if (atlas && codepoints.size) await atlas.load(glyphFont, codepoints);   // GL-SDF経路のみ
			onChange && onChange();
		} catch (e) {
			cache.set(k, { status: "error", origin: null, labels: [] });
		}
	}

	// 可視タイルを算出→ロード開始。描画順リスト { z, order:[{key,origin}], total } を返す。
	function update(cam, W, H) {
		const z = pickZoom(cam);
		const tiles = visibleTiles(cam, W, H, z);
		const keep = new Set(tiles.map(keyOf));
		for (const t of tiles) ensure(t);
		// キャッシュ上限：可視外の古いものから破棄
		if (cache.size > cap) {
			for (const k of [...cache.keys()]) {
				if (cache.size <= cap) break;
				if (!keep.has(k)) { renderer.removeTile(k); cache.delete(k); }
			}
		}
		const order = [];
		for (const t of tiles) {
			const c = cache.get(keyOf(t));
			if (c && c.status === "ready") order.push({ key: keyOf(t), origin: c.origin });
		}
		const fullyReady = tiles.length > 0 && order.length === tiles.length;
		if (fullyReady) stable = order;
		// フォールバック：未完了時、直前 good order のうち今も ready で現orderに無いもの（下地）
		const curKeys = new Set(order.map(o => o.key));
		const fallback = fullyReady ? [] : stable.filter(o => cache.get(o.key)?.status === "ready" && !curKeys.has(o.key));
		return { z, order, fallback, total: tiles.length };
	}

	// 現在の可視タイル（order）のラベルだけを結合＆重複排除。
	// キャッシュ全体から集めると、ズーム中に古い高zタイルのラベルが混ざって密度が倍増するため order 限定。
	function labels(order) {
		const out = [], seen = new Set();
		for (const { key } of (order || [])) {
			const c = cache.get(key);
			if (!c || c.status !== "ready") continue;
			for (const L of c.labels) {
				const dk = L.text + "@" + L.anchor[0].toFixed(5) + "," + L.anchor[1].toFixed(5);
				if (seen.has(dk)) continue; seen.add(dk); out.push(L);
			}
		}
		return out;
	}

	return { update, labels, cache };
}
