// タイル・マネージャ：距離別LOD（近=高z/遠=低z、重なりなし）で可視タイルを選び、取得・生成・キャッシュ。
// buildScene で全選択タイルを style層ごとに1バッファへ結合（mixed-z, 共通原点に再ベース）。
// ラベルは近景（高z）タイルのみ＝遠方はテキスト無し。
import { fetchMVT, neededSourceLayers } from "./decode.js";
import { tileBounds } from "./tile.js";
import { buildTileDrawList } from "./build.js";
import { buildLabels } from "./labels.js";
import { buildBuildings } from "./buildings.js";
import { selectLOD } from "./tilecover.js";

const keyOf = t => `${t.z}/${t.x}/${t.y}`;
const EMPTY = new Set();

// lodFloor＝{ minViewZoom, z }：ビューが minViewZoom 以上のとき詳細シーンの LOD 下限を z に強制。
// optbv の海（WA）は z8 タイルから全面収録＝z7 以下が混ざる遠景は海が紙色に抜ける。下限 z8 で敷けば
// 海の色がズーム段間で揃う（沖合の z8 タイルは全面WA一枚=50B級なので枚数が増えても実質タダ）。
export function createTileManager({ style, tileUrl, onChange, cap = 256, buildTile, onEvict, lodFloor, memBudgetMB }) {
	const cache = new Map();   // key → { status, origin, dl, labels, z, bytes, seen }

	// tess済み geometry の常駐量を「枚数」でなく「実バイト」で束ねる：z16密都市(~100KB級)と沖合z8(数十B)を
	// 同一に数えると枚数上限がメモリの代理にならない。予算は端末メモリで自動調整（navigator.deviceMemory=GB・
	// 上限8で頭打ち／Safari・FF は未提供＝4GB相当とみなす）。呼び出し側 memBudgetMB で明示上書き可。
	// geometry の実体は scene worker 側（main はメタのみ保持）＝この予算は onEvict 経由で鏡(scene worker)を縛る。
	const dm = (typeof navigator !== "undefined" && navigator.deviceMemory) || 4;
	const autoMB = Math.max(24, Math.min(96, dm * 12));   // 自動＝端末メモリで [24,96]MB（16GB機≒96 / 4GBタブ≒48 / 2GB≒24）
	const budgetBytes = (memBudgetMB || autoMB) * 1024 * 1024;   // memBudgetMB 明示時はそのまま（呼び出し側を信頼＝上限に丸めない）
	const hardCap = Math.max(cap, 4096);   // 極小タイル多数での Map 肥大だけ抑える二次ガード（バイト予算が主）
	let clock = 0;   // update 連番＝LRU の時刻（keep に入る度に更新＝「最近見えた」を保つ）

	// 既定：メインスレッドで fetch→decode→tessellation（重い）。buildTile 注入で worker へ退避できる。
	const need = neededSourceLayers(style);
	async function defaultBuildTile(t) {
		const layers = await fetchMVT(tileUrl(t.z, t.x, t.y), undefined, need);
		const [w, s, e, n] = tileBounds(t.x, t.y, t.z);
		const origin = [w, n];
		const dl = buildTileDrawList({ layers, z: t.z, x: t.x, y: t.y }, style, origin);
		const { labels } = buildLabels({ layers, z: t.z, x: t.x, y: t.y }, style);
		const buildings = buildBuildings({ layers, z: t.z, x: t.x, y: t.y }, origin);
		return { origin, dl, labels, buildings, z: t.z, bytes: dlBytes(dl, buildings) };
	}
	const build = buildTile || defaultBuildTile;

	// dl+建物の typed array 実バイト（main保持の既定パス用。worker パスは tileworker が bytes を報告）。
	function dlBytes(dl, buildings) {
		let b = 0;
		for (const op of dl.ops) b += op.kind === "fill" ? op.pos.byteLength + op.col.byteLength : op.P1.byteLength + op.P2.byteLength + op.col.byteLength + op.half.byteLength;
		if (buildings) b += buildings.pos.byteLength + buildings.shade.byteLength + buildings.anchor.byteLength;
		return b;
	}

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
	let stickySplit = null;   // 前回 update で分割された祖先ノード集合＝selectLOD のヒステリシス（境界の親⇔子振動を止める）
	function update(cam, W, H) {
		clock++;
		const floorZ = lodFloor && cam.zoom >= lodFloor.minViewZoom ? lodFloor.z : 0;
		const selected = selectLOD(cam, W, H, { sticky: stickySplit, floorZ });
		// 「分割されたノード」＝選択タイルの祖先チェーンそのもの。次回のヒステリシス判定に持ち越す。
		stickySplit = new Set();
		for (const t of selected) {
			let z = t.z, x = t.x, y = t.y;
			while (z > 4) { z--; x >>= 1; y >>= 1; const k = `${z}/${x}/${y}`; if (stickySplit.has(k)) break; stickySplit.add(k); }
		}
		// 粗い下地：3段低いズームで広く覆う。移動中の先端の空白を常に埋める underlay。
		// lodFloor 有効時は下地も z8 で敷く（floorZ が強制分割・maxZ が上限開放）：z5-7 の下地は海（WA）を
		// 持たないため、移動中に下地が顔を出す瞬間だけ海が紙色に白転してちらつく（実害はまさに下地側だった）。
		const coarse = selectLOD(cam, W, H, { maxZ: Math.max(floorZ || 4, Math.round(cam.zoom) - 3), floorZ });
		// 毛布：固定 z4 の床タイル＝フォールバックの終点保証。「zoom-6」の動く目標だと高速ズームアウト中に
		// 毎段コールドフェッチで間に合わず白が出る。z4 固定なら1枚で22.5°＝数枚で日本全体、初回以降キャッシュ常駐
		// ＝どんな引き方をしても床が必ず先に居る。W/H×3＝視野の3倍を先回り（外周の白露出も防ぐ）。
		const blanket = selectLOD(cam, W * 3, H * 3, { maxZ: 4 });
		const keep = new Set([...selected, ...coarse, ...blanket].map(keyOf));
		for (const t of blanket) ensure(t);
		for (const t of coarse) ensure(t);
		for (const t of selected) ensure(t);
		// 視野から外れた読込中タイルは fetch ごと中断（高速パンで帯域とworker CPUを空ける）。
		// エントリは ensure の catch("aborted") が消す＝パンで戻ってきたら普通に再取得される。
		if (build.abort) {
			for (const [k, c] of cache) if (c.status === "loading" && !keep.has(k)) build.abort(k);
		}
		// keep（今見えている／下地／毛布）は常に残す＝merge の穴を作らない。予算はそれを超えて「パンで戻った時に
		// 即出す」ための履歴分を束ねる。keep 外を LRU（最後に見えた update が古い順）で、バイト予算 かつ 枚数ガードを
		// 満たすまで退避。geometry の実体は scene worker＝ここで消せば onEvict で鏡が同時に縮む（知らせないと
		// 「main は ready・worker は破棄」の食い違いで merge が黙って穴になる。scene 側独自CAP退避で実際に起きた）。
		for (const k of keep) { const c = cache.get(k); if (c) c.seen = clock; }   // 「最近見えた」を更新＝LRUの新しさ
		let total = 0; for (const c of cache.values()) total += c.bytes || 0;
		if (total > budgetBytes || cache.size > hardCap) {
			const cands = [];
			for (const [k, c] of cache) if (!keep.has(k)) cands.push(k);
			cands.sort((a, b) => (cache.get(a).seen || 0) - (cache.get(b).seen || 0));   // 古い(seen小)順＝先に捨てる
			const evicted = [];
			for (const k of cands) {
				if (total <= budgetBytes && cache.size <= hardCap) break;
				total -= cache.get(k).bytes || 0;
				cache.delete(k); evicted.push(k);
			}
			if (evicted.length && onEvict) onEvict(evicted);
		}
		const ready = arr => { const o = []; for (const t of arr) { const c = cache.get(keyOf(t)); if (c && c.status === "ready") o.push({ key: keyOf(t), origin: c.origin, z: t.z }); } return o; };
		// 下地は祖先フォールバック付き：ズームで下地の段(round(zoom)-3)が切り替わる度に新段が未着で
		// 紙色の空白がチラつくのを、キャッシュ済みの粗い親で埋めて防ぐ。粗い順＝下に描かれる。
		const readyWithFallback = arr => {
			const o = [], seen = new Set();
			for (const t of arr) {
				let z = t.z, x = t.x, y = t.y;
				while (z >= 4) {
					const k = `${z}/${x}/${y}`, c = cache.get(k);
					if (c && c.status === "ready") {
						if (!seen.has(k)) { seen.add(k); o.push({ key: k, origin: c.origin, z }); }
						break;
					}
					z--; x >>= 1; y >>= 1;
				}
			}
			return o.sort((a, b) => a.z - b.z);
		};
		// 毛布は祖先フォールバックの「保険」でなく下地mergeに直接混ぜる（z昇順ソートで一番下に敷かれる）
		// ＝ズームを引いた瞬間も画面全域に必ず一番粗い絵がある。真っ白は出ない。
		return { order: ready(selected), coarseOrder: readyWithFallback([...blanket, ...coarse]), total: selected.length };
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
				? { kind: "fill", li, pos: new Float32Array(e.fillN * 2), col: new Uint8Array(e.fillN * 4), pi: 0, ci: 0 }
				: { kind: "line", li, P1: new Float32Array(e.lineN * 2), P2: new Float32Array(e.lineN * 2), col: new Uint8Array(e.lineN * 4), half: new Float32Array(e.lineN), pi: 0, ci: 0, hi: 0 });
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

	// 常駐 geometry の観測（メモリ確認用）：ready タイル枚数・実バイト・予算・端末メモリ推定。
	function stats() {
		let tiles = 0, bytes = 0;
		for (const c of cache.values()) if (c.status === "ready") { tiles++; bytes += c.bytes || 0; }
		return { tiles, bytes, budgetBytes, deviceMemoryGB: dm, cacheEntries: cache.size };
	}

	return { update, buildScene, labels, cache, stats };
}
