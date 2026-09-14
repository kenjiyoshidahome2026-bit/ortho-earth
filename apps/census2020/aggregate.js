// 集約ポリゴン生成器：admin_all（市区町村アーク）を pbf.merge で位相的に溶かし、
// 都道府県 / 政令市 / 東京都区部 / 振興局(支庁) / 郡(≥2) を「admin_all と同じ形の gint 層」として構成する。
//
// 思想（本人裁定 2026-08-13）：集約は市区町村と"同じパーツ"＝同じ paintTable / onGintClick / ドレープに乗る
// ＝全レベルで同じ絵が出る。サーバーには何も足さない（市区町村アークからの純クライアント導出＝「サーバーは最小限」）。
//
// merge の返り＝{type:"MultiPolygon", coordinates:[[ring,…]]}（座標は gint.unpack＝経緯度・度）。共有アークは
// 1feature 参照のみ残す＝内部境界が消えて外周だけ＝そのまま geopbf({gint:true}) で新しい gint 層に焼き直す。
import { geopbf } from "geopbf";
import { PREFS, DESIGNATED_CITIES, wardParent, SHICHO, GUN } from "./jp/codes.js";
import POP2020 from "./census/2020-pop.json" with { type: "json" };
import CENSUS_MANIFEST from "./census/manifest.json" with { type: "json" };
import STATS2015 from "./census/2015-stats.json" with { type: "json" };
import AGES2020 from "./census/2020-ages.json" with { type: "json" };

const NAME_BY_CODE = new Map(CENSUS_MANIFEST.map(e => [e.code, e.name]));
const MB = new Map(CENSUS_MANIFEST.map(e => [e.code, e]));

// 値なし重なり集約（"北海道"名の振興局集約ポリゴン14個）＝市区町村と重なる独立ジオメトリ＝merge から除外。
// 6村の北方領土（村名を持つ・重ならない離島）は除外しない＝北海道県ポリゴンの正当な離島部。
const isAggPoly = p => p?.name === "北海道";

// --- 各レベルへの所属割当：admin_all の実市区町村コードを1走査で全レベルのグループへ配る ---
// group = { code, name, kind, members:Set<code5> }。filter は members.has で作る＝値の合算も同じ Set で回せる。
function push(map, key, meta, code) {
	if (!map.has(key)) map.set(key, { ...meta, members: new Set() });
	map.get(key).members.add(code);
}
function assignGroups(codesInfo) {
	const L = { pref: new Map(), designated: new Map(), kubu: new Map(), shicho: new Map(), gun: new Map() };
	for (const { code } of codesInfo) {
		const pp = code.slice(0, 2), n = +code;
		push(L.pref, pp, { code: pp, name: PREFS[pp] || pp, kind: "pref" }, code);
		const dc = wardParent(code);
		if (dc) push(L.designated, dc, { code: dc, name: NAME_BY_CODE.get(dc) || dc, kind: "designated" }, code);
		if (n >= 13101 && n <= 13123) push(L.kubu, "13100", { code: "13100", name: NAME_BY_CODE.get("13100") || "東京都区部", kind: "kubu" }, code);
		const sh = SHICHO[code];
		if (sh) push(L.shicho, "SH:" + sh, { code: "SH" + code.slice(0, 2) + "_" + sh, name: sh, kind: "shicho" }, code);
		const gn = GUN[code];
		if (gn) {   // 郡名は県内でも重複（北海道の中川郡×2 等）＝北海道は振興局で、他県は県2桁でスコープ分離
			const scope = pp === "01" ? (SHICHO[code] || "01") : pp;
			push(L.gun, scope + "|" + gn, { code: "GN" + pp + "_" + gn, name: gn, kind: "gun" }, code);
		}
	}
	for (const [k, g] of L.gun) if (g.members.size < 2) L.gun.delete(k);   // 郡は2町村以上のみ（1件＝その町村自身＝無意味）
	return L;
}

// --- 連結成分への分割（島嶼分離）＝本人裁定 2026-08-13：東京/鹿児島/長崎/島根/沖縄本島。 ---
// merge の rings は既に「閉じた1ループ＝1島or本土の外周 or 穴」。符号付面積で外周/穴を判定し、穴は内包する外周へ。
// 返り＝正しい MultiPolygon（[[外周,穴…],[島2外周],…]）＝塗りは全部・寄りは代表部だけ、が後段で効く。
function signedArea(ring) { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]); return a / 2; }
function ringBbox(ring) { let x0 = 180, y0 = 90, x1 = -180, y1 = -90; for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; }
function pointInRing(p, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }
const bboxContains = (o, i) => o[0] <= i[0] && o[1] <= i[1] && o[2] >= i[2] && o[3] >= i[3];
function partition(rings) {
	// stitch の向きは任意＝符号で外周/穴を決めると島の外周を穴と誤判定する。包含"深さ"で決める（偶数=外周/奇数=穴）。
	const rs = rings.filter(r => r.length >= 4).map(r => { const a = signedArea(r); return { r, a, ab: Math.abs(a), bb: ringBbox(r) }; });
	if (!rs.length) return { type: "MultiPolygon", coordinates: [rings] };
	rs.sort((x, y) => y.ab - x.ab);   // 大→小（親は必ず自分より大）
	const depth = rs.map((o, i) => { let d = 0; for (let j = 0; j < rs.length; j++) { if (j === i || rs[j].ab <= o.ab) continue; if (bboxContains(rs[j].bb, o.bb) && pointInRing(o.r[0], rs[j].r)) d++; } return d; });
	const parts = [], outerAt = new Map();
	rs.forEach((o, i) => { if (!(depth[i] & 1)) { outerAt.set(i, parts.length); parts.push([o.a >= 0 ? o.r : o.r.slice().reverse()]); } });   // 外周＝CCW 正規化
	rs.forEach((o, i) => { if (depth[i] & 1) {   // 穴＝内包する最小外周へ（CW 正規化）＝政令市/郡が市を刳り貫くケース
		let best = -1, bestA = Infinity;
		for (let j = 0; j < rs.length; j++) { if ((depth[j] & 1) || rs[j].ab <= o.ab || !outerAt.has(j)) continue; if (bboxContains(rs[j].bb, o.bb) && pointInRing(o.r[0], rs[j].r) && rs[j].ab < bestA) { best = j; bestA = rs[j].ab; } }
		if (best >= 0) parts[outerAt.get(best)].push(o.a < 0 ? o.r : o.r.slice().reverse());
	} });
	return { type: "MultiPolygon", coordinates: parts.length ? parts : [rings] };   // parts[0]=最大=本土
}
// 代表部（最大面積の外周）の bbox＝カメラ／ラベル用（島嶼を無視して本土に寄る）
function primaryBbox(geometry) {   // 全リング中で最大面積の外周の bbox＝島嶼を無視して本土に寄るカメラ用
	let best = null, bestA = -1;
	for (const part of geometry.coordinates) for (const r of part) { const a = Math.abs(signedArea(r)); if (a > bestA) { bestA = a; best = ringBbox(r); } }
	return best;
}

// rank24 簡略化で内部境界が完全一致せず"薄いスリバー"リングが大量に残る（東京6843/鹿児島8986・面積<1e-8＝実島でない）。
// 微小面積リングを落として除去＝実島（大島91km² 等＝全て≫1e-6deg²）は温存。0.01km² 未満＝県ズームで不可視＝表示無害。
const MIN_RING_AREA = 1e-6;

// --- レベルを1つ焼く：グループごとに merge → Feature 化 → まとめて gint 層へ ---
export async function buildLevel(adminPbf, groups, { partitionIslands = false, main = false } = {}) {
	const t0 = performance.now();
	const features = [], used = [];
	for (const g of groups) {
		const mp = adminPbf.merge({ filter: c => g.members.has(c.code) });
		const rings = (mp?.coordinates?.[0] || []).filter(r => r.length >= 4 && Math.abs(signedArea(r)) >= MIN_RING_AREA);   // スリバー除去
		if (!rings.length) continue;
		// 全体(全パーツ) と 主要部(最大面積の連結成分だけ) の二通り＝本人裁定 2026-08-13。塗りは全体・寄りは主要部が定石。
		const full = partitionIslands ? partition(rings) : { type: "MultiPolygon", coordinates: [rings] };
		const geometry = (partitionIslands && main) ? { type: "MultiPolygon", coordinates: [full.coordinates[0]] } : full;
		features.push({ type: "Feature", properties: { code: g.code, name: g.name, kind: g.kind }, geometry });
		used.push({ ...g, bbox: primaryBbox(full) });   // カメラ用 bbox は常に主要部
	}
	const pbf = await geopbf({ type: "FeatureCollection", features }, { gint: true });
	console.log(`[aggregate] ${used[0]?.kind ?? "?"} ×${features.length}${main ? " 主要部" : ""} 焼き ${(performance.now() - t0).toFixed(0)}ms`);
	return { pbf, features, groups: used };
}

export async function initAggregate(adminPbf) {
	const codesInfo = [];
	const n = adminPbf.fmap?.length ?? 0, seen = new Set();
	for (let i = 0; i < n; i++) {
		let p; try { p = adminPbf.getProperties(i); } catch { continue; }
		const code = p?.code, name = p?.name;
		if (!code || name === "北海道") continue;   // 重なり集約ポリゴン除外
		if (seen.has(code)) continue; seen.add(code);
		codesInfo.push({ code, name });
	}
	const LEVELS = assignGroups(codesInfo);
	const cache = new Map();
	async function level(kind, { partitionIslands = false, main = false } = {}) {
		const ck = kind + (partitionIslands ? ":p" : "") + (main ? ":m" : "");
		if (!cache.has(ck)) cache.set(ck, buildLevel(adminPbf, [...(LEVELS[kind]?.values() || [])], { partitionIslands, main }));
		return cache.get(ck);
	}
	return { level, LEVELS };
}

// --- 集約値：メンバ市区町村の census を各指標の合算則で畳む（同じパーツ＝同じ指標を"足す"だけ） ---
// choropleth の INDICATORS と同じキー・同じ元データ＝トグルで pref を選ぶと「県版の同じ指標」が出る。
export const AGG_VALUE = {
	pop:     m => { let s = 0, a = false; for (const c of m) { const v = POP2020[c]?.[0]; if (v != null) { s += v; a = true; } } return a ? s : null; },
	hh:      m => { let s = 0, a = false; for (const c of m) { const v = MB.get(c)?.hh; if (v != null) { s += v; a = true; } } return a ? s : null; },
	density: m => { let p = 0, ar = 0; for (const c of m) { const pop = POP2020[c]?.[0], d = MB.get(c)?.density; if (pop != null && d > 0) { p += pop; ar += pop / d; } } return ar > 0 ? p / ar : null; },   // Σ人口/Σ面積
	change:  m => { let a = 0, b = 0; for (const c of m) { const x = POP2020[c]?.[0], y = STATS2015[c]?.pop?.[0]; if (x != null && y != null) { a += x; b += y; } } return b > 0 ? (a - b) / b : null; },
	aging:   m => { let t = 0, o = 0; for (const c of m) { const g = AGES2020[c]; if (g?.length === 32) { t += g.reduce((z, x) => z + x, 0); o += g[13] + g[14] + g[15] + g[29] + g[30] + g[31]; } } return t > 0 ? o / t : null; },
};
export const sumPop = g => AGG_VALUE.pop(g.members);   // 実証用エイリアス

// --- 実証用：レベルを塗って地図に載せる（choropleth と同じ fid スタイル表フォーマット・分位6級） ---
const SEQ = ["#eef5fc", "#cfe1f2", "#93c4e4", "#4f97cc", "#2166ac", "#0a3a67"];
const packRGBA = (h, a) => { const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16); return ((r << 24) | (g << 16) | (b << 8) | Math.round(a * 255)) >>> 0; };
const AGG_STYLE = (() => { const t = new Float32Array(256 * 4); t.set([0, 0, 0, 0], 0); t.set([0.42, 0.5, 0.62, 0.55], 4); return { styleTable: t, lineWidth: 0.9 }; })();
export async function showLevel(map, agg, kind, valueOf = sumPop, { partitionIslands = false, main = false } = {}) {
	const { pbf, features, groups } = await agg.level(kind, { partitionIslands, main });
	// admin_all 同様、集約境界も海岸線を全解像度で抱える＝既定2M上限だと fill が消灯。上限を上げて全密度塗りを通す。
	map.applyGintData(pbf, "agg_" + kind, false, { minZoom: 1, style: AGG_STYLE, fillMaxEdges: 8_000_000 });
	const vals = groups.map(valueOf).filter(v => v != null).sort((a, b) => a - b);
	const br = []; for (let k = 1; k < SEQ.length; k++) br.push(vals[Math.min(vals.length - 1, Math.floor(vals.length * k / SEQ.length))]);
	const cls = v => { let k = 0; while (k < br.length && v > br[k]) k++; return k; };
	const N = features.length, u32 = new Uint32Array(N * 4);
	for (let i = 0; i < N; i++) {
		const v = valueOf(groups[i]);
		if (v == null) { u32[i * 4 + 2] = ((8 << 24) | (6 << 8) | 0) >>> 0; continue; }
		u32[i * 4] = packRGBA(SEQ[cls(v)], 0.62); u32[i * 4 + 1] = 0; u32[i * 4 + 2] = ((10 << 24) | (6 << 8) | 1) >>> 0;
	}
	map.paintTable(u32, N);
	return { pbf, features, groups };
}
