// タイル・マネージャ：距離別LOD（近=高z/遠=低z、重なりなし）で可視タイルを選び、取得・生成・キャッシュ。
// buildScene で全選択タイルを style層ごとに1バッファへ結合（mixed-z, 共通原点に再ベース）。
// ラベルは近景（高z）タイルのみ＝遠方はテキスト無し。
import { fetchMVT } from "./decode.js";
import { tileBounds } from "./tile.js";
import { buildTileDrawList } from "./build.js";
import { buildLabels } from "./labels.js";
import { buildBuildings } from "./buildings.js";
import { selectLOD } from "./tilecover.js";

const keyOf = t => `${t.z}/${t.x}/${t.y}`;
const EMPTY = new Set();

export function createTileManager({ style, tileUrl, onChange, cap = 256, buildTile, onEvict }) {
	const cache = new Map();   // key → { status, origin, dl, labels, z }

	// 既定：メインスレッドで fetch→decode→tessellation（重い）。buildTile 注入で worker へ退避できる。
	async function defaultBuildTile(t) {
		const layers = await fetchMVT(tileUrl(t.z, t.x, t.y));
		const [w, s, e, n] = tileBounds(t.x, t.y, t.z);
		const origin = [w, n];
		const dl = buildTileDrawList({ layers, z: t.z, x: t.x, y: t.y }, style, origin);
		const { labels } = buildLabels({ layers, z: t.z, x: t.x, y: t.y }, style);
		const buildings = buildBuildings({ layers, z: t.z, x: t.x, y: t.y }, origin);
		return { origin, dl, labels, buildings, z: t.z };
	}
	const build = buildTile || defaultBuildTile;

	async function ensure(t) {
		const k = keyOf(t);
		const ex = cache.get(k);
		if (ex && ex.status !== "error") return;   // loading/ready はそのまま
		const tries = ex ? (ex.tries || 0) : 0;
		if (tries >= 3) return;                     // 3回失敗＝諦める（本当に無いタイル等での永久リトライ回避）
		cache.set(k, { status: "loading", tries });
		try {
			const r = await build(t);   // worker or main
			cache.set(k, { status: "ready", ...r });
			onChange && onChange();
		} catch (e) {
			// abort（視野から外れて中断）はエントリごと消す＝再訪時に再取得できる。
			if (String(e && e.message) === "aborted") { cache.delete(k); return; }
			// その他のエラー（ネット瞬断/デコード失敗）は "error" のまま残すと永久欠け＝そこだけ粗いタイルが透けて
			// 静止中もズーム混在になる。tries を数えてバックオフ再取得を促す（onChange→再update→ensure がリトライ）。
			cache.set(k, { status: "error", origin: null, dl: null, labels: [], z: t.z, tries: tries + 1 });
			setTimeout(() => onChange && onChange(), 300 * (tries + 1));
		}
	}

	// 距離LODで可視タイルを選定→ロード。ready なタイル列 { key, origin, z } を返す。
	function update(cam, W, H) {
		const selected = selectLOD(cam, W, H);
		// 粗い下地：3段低いズームで広く覆う。移動中の先端の空白を常に埋める underlay。
		const coarse = selectLOD(cam, W, H, { maxZ: Math.max(4, Math.round(cam.zoom) - 3) });
		const keep = new Set([...selected, ...coarse].map(keyOf));
		for (const t of coarse) ensure(t);
		for (const t of selected) ensure(t);
		// 視野から外れた読込中タイルは fetch ごと中断（高速パンで帯域とworker CPUを空ける）。
		// エントリは ensure の catch("aborted") が消す＝パンで戻ってきたら普通に再取得される。
		if (build.abort) {
			for (const [k, c] of cache) if (c.status === "loading" && !keep.has(k)) build.abort(k);
		}
		if (cache.size > cap) {
			const evicted = [];
			for (const k of [...cache.keys()]) {
				if (cache.size <= cap) break;
				if (!keep.has(k)) { cache.delete(k); evicted.push(k); }
			}
			// geometry 保持側（scene worker）へ同期通知：ここで知らせないと「main は ready・worker は破棄」の
			// 食い違いが生まれ、merge で黙って穴になる（scene worker 側の独自CAP退避で実際に起きた）。
			if (evicted.length && onEvict) onEvict(evicted);
		}
		const ready = arr => { const o = []; for (const t of arr) { const c = cache.get(keyOf(t)); if (c && c.status === "ready") o.push({ key: keyOf(t), origin: c.origin, z: t.z }); } return o; };
		return { order: ready(selected), coarseOrder: ready(coarse), total: selected.length };
	}

	// order の全タイルの op を style層(li)ごとに結合。origin(=cam.center)へ再ベースして精度確保。
	function buildScene(order, opts = {}) {
		if (!order.length) return { origin: [0, 0], layers: [] };
		const origin = opts.origin || order[0].origin;
		const hidden = opts.hidden || EMPTY;   // 非表示スタイル層(li)の集合。既存タイルから当該opを描画時に除くだけ
		const tileOps = [];
		const size = new Map();
		for (const { key, origin: to } of order) {
			const c = cache.get(key); if (!c || !c.dl) continue;
			tileOps.push({ ox: to[0] - origin[0], oy: to[1] - origin[1], ops: c.dl.ops });
			for (const op of c.dl.ops) {
				if (hidden.has(op.li)) continue;
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
				if (hidden.has(op.li)) continue;
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

		// 建物（3D押し出し）を全タイルから結合。pos は xy を原点へ再ベース、z(高さ)はそのまま。
		let bN = 0;
		for (const { key } of order) { const c = cache.get(key); if (c && c.buildings) bN += c.buildings.pos.length; }
		let buildings = null;
		if (bN) {
			const pos = new Float32Array(bN), shade = new Float32Array(bN / 3), anchor = new Float32Array(bN / 3 * 2);
			let pi = 0, si = 0, ai = 0;
			for (const { key, origin: to } of order) {
				const c = cache.get(key); if (!c || !c.buildings) continue;
				const ox = to[0] - origin[0], oy = to[1] - origin[1], bp = c.buildings.pos, ba = c.buildings.anchor;
				for (let i = 0; i < bp.length; i += 3) { pos[pi++] = bp[i] + ox; pos[pi++] = bp[i + 1] + oy; pos[pi++] = bp[i + 2]; }
				for (let i = 0; i < ba.length; i += 2) { anchor[ai++] = ba[i] + ox; anchor[ai++] = ba[i + 1] + oy; }
				shade.set(c.buildings.shade, si); si += c.buildings.shade.length;
			}
			buildings = { pos, shade, anchor };
		}
		return { origin, layers, buildings };
	}

	// 近景（高z）タイルのラベルだけ結合＆重複排除。遠方（粗タイル）はテキスト無し。
	function labels(order) {
		if (!order.length) return [];
		const maxZ = Math.max(...order.map(o => o.z));
		const near = maxZ - 2;                 // 最細から2段以内＝近景
		const out = [], seen = new Set();
		for (const { key, z } of order) {
			if (z < near) continue;
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
