// タイル・マネージャ：カメラから可視タイルを算出し、非同期に取得・生成・キャッシュ・破棄する。
// 幾何は buildScene で可視タイル横断・style層ごとに結合（draw call 削減）。ラベルは絶対座標・グローバル衝突。
import { fetchMVT } from "./decode.js";
import { tileBounds, lonLatToTile } from "./tile.js";
import { buildTileDrawList } from "./build.js";
import { buildLabels } from "./labels.js";
import { pickZoom, visibleTiles } from "./tilecover.js";

const keyOf = t => `${t.z}/${t.x}/${t.y}`;

export function createTileManager({ style, tileUrl, onChange, cap = 220 }) {
	const cache = new Map();   // key → { status, origin, dl, labels }
	let stable = [];           // 直近で全可視タイルが揃った order（LOD切替中フォールバック）

	async function ensure(t) {
		const k = keyOf(t);
		if (cache.has(k)) return;
		cache.set(k, { status: "loading" });
		try {
			const layers = await fetchMVT(tileUrl(t.z, t.x, t.y));
			const [w, s, e, n] = tileBounds(t.x, t.y, t.z);
			const origin = [w, n];
			const dl = buildTileDrawList({ layers, z: t.z, x: t.x, y: t.y }, style, origin);
			const { labels } = buildLabels({ layers, z: t.z, x: t.x, y: t.y }, style);
			cache.set(k, { status: "ready", origin, dl, labels });
			onChange && onChange();
		} catch (e) {
			cache.set(k, { status: "error", origin: null, dl: null, labels: [] });
		}
	}

	// 可視タイル算出→ロード。{ z, order:[{key,origin}], fallback, total } を返す。
	function update(cam, W, H) {
		const z = pickZoom(cam);
		const tiles = visibleTiles(cam, W, H, z);
		const keep = new Set(tiles.map(keyOf));
		for (const t of tiles) ensure(t);
		// 先読み：親(z-1)タイル（1/4枚で安い）＝ズームアウトを即スワップ可能に。周囲リングは pad で確保済み。
		if (z > 4) {
			const seen = new Set();
			for (const t of tiles) {
				const px = t.x >> 1, py = t.y >> 1, pk = `${z - 1}/${px}/${py}`;
				if (!seen.has(pk)) { seen.add(pk); keep.add(pk); ensure({ z: z - 1, x: px, y: py }); }
			}
		}
		// 先読み：中心付近の子(z+1)＝ズームインを即スワップ可能に（中心3×3のみ、安価）
		if (z < 16) {
			const [cx, cy] = lonLatToTile(cam.center[0], cam.center[1], z + 1), n1 = 1 << (z + 1);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const x = ((cx + dx) % n1 + n1) % n1, y = cy + dy; if (y < 0 || y >= n1) continue;
				keep.add(`${z + 1}/${x}/${y}`); ensure({ z: z + 1, x, y });
			}
		}
		// 粗い下書き（underlay）：主の下に、より粗く・広く敷く。傾けた遠方の海/陸を縁近くまで一様に埋める。
		const coarseZ = Math.max(4, z - 5);
		let coarseTiles = [];
		if (coarseZ < z) {
			coarseTiles = visibleTiles(cam, W, H, coarseZ, { pad: 2 });
			for (const t of coarseTiles) { keep.add(keyOf(t)); ensure(t); }
		}
		if (cache.size > cap) {
			for (const k of [...cache.keys()]) {
				if (cache.size <= cap) break;
				if (!keep.has(k)) cache.delete(k);
			}
		}
		const order = [];
		for (const t of tiles) {
			const c = cache.get(keyOf(t));
			if (c && c.status === "ready") order.push({ key: keyOf(t), origin: c.origin });
		}
		const coarseOrder = [];
		for (const t of coarseTiles) {
			const c = cache.get(keyOf(t));
			if (c && c.status === "ready") coarseOrder.push({ key: keyOf(t), origin: c.origin });
		}
		const fullyReady = tiles.length > 0 && order.length === tiles.length;
		if (fullyReady) stable = order;
		const curKeys = new Set(order.map(o => o.key));
		const fallback = fullyReady ? [] : stable.filter(o => cache.get(o.key)?.status === "ready" && !curKeys.has(o.key));
		return { z, order, fallback, total: tiles.length, coarseZ, coarseOrder };
	}

	// order の全タイルの op を style層(li)ごとに結合し、共通原点(=先頭タイル)に再ベースした scene を作る。
	// 2パス（サイズ計上→事前確保→充填）で JS配列push を排し高速化。fallback を先に積むと LOD切替中も下地が埋まる。
	function buildScene(order, fallback = []) {
		const all = fallback.concat(order);
		if (!all.length) return { origin: [0, 0], layers: [] };
		const origin = order[0]?.origin || all[0].origin;
		const tileOps = [];
		const size = new Map();   // li → { kind, fillN, lineN }
		for (const { key, origin: to } of all) {
			const c = cache.get(key); if (!c || !c.dl) continue;
			tileOps.push({ ox: to[0] - origin[0], oy: to[1] - origin[1], ops: c.dl.ops });
			for (const op of c.dl.ops) {
				let e = size.get(op.li); if (!e) { e = { kind: op.kind, fillN: 0, lineN: 0 }; size.set(op.li, e); }
				if (op.kind === "fill") e.fillN += op.pos.length / 2; else e.lineN += op.half.length;
			}
		}
		const buf = new Map();
		for (const [li, e] of size) {
			buf.set(li, e.kind === "fill"
				? { kind: "fill", li, pos: new Float32Array(e.fillN * 2), col: new Float32Array(e.fillN * 4), pi: 0, ci: 0 }
				: { kind: "line", li, P1: new Float32Array(e.lineN * 2), P2: new Float32Array(e.lineN * 2), col: new Float32Array(e.lineN * 4), half: new Float32Array(e.lineN), pi: 0, ci: 0, hi: 0 });
		}
		for (const { ox, oy, ops } of tileOps) {
			for (const op of ops) {
				const m = buf.get(op.li);
				if (op.kind === "fill") {
					const p = op.pos; let pi = m.pi; for (let i = 0; i < p.length; i += 2) { m.pos[pi++] = p[i] + ox; m.pos[pi++] = p[i + 1] + oy; } m.pi = pi;
					m.col.set(op.col, m.ci); m.ci += op.col.length;
				} else {
					const P1 = op.P1, P2 = op.P2; let pi = m.pi;
					for (let i = 0; i < P1.length; i += 2) { m.P1[pi] = P1[i] + ox; m.P1[pi + 1] = P1[i + 1] + oy; m.P2[pi] = P2[i] + ox; m.P2[pi + 1] = P2[i + 1] + oy; pi += 2; } m.pi = pi;
					m.col.set(op.col, m.ci); m.ci += op.col.length;
					m.half.set(op.half, m.hi); m.hi += op.half.length;
				}
			}
		}
		const layers = [...buf.values()].sort((a, b) => a.li - b.li).map(m => m.kind === "fill"
			? { kind: "fill", pos: m.pos, col: m.col }
			: { kind: "line", P1: m.P1, P2: m.P2, col: m.col, half: m.half });
		return { origin, layers };
	}

	// 現在の可視タイル（order）のラベルだけ結合＆重複排除。
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

	return { update, buildScene, labels, cache };
}
