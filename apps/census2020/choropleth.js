// 全国市区町村コロプレス：admin_all（bucket GeoPBF・全国1900余ポリゴン・properties.code=5桁）を
// gint ユーザー層として搭載し、指標5種を fid スタイル表の直書きで塗り分ける。
// 式評価（buildFidStyle）は使わない＝指標切替は「表の再計算＋テクスチャ更新1回」だけ（gint draw spec の restyle 哲学）。
// 表示はエンジン仕様どおり真俯瞰（pitch<0.02）のみ＝チルトすると塗りは静かに消える（防災ドレープと住み分け）。
import { geopbf } from "geopbf";
import { belongsTo } from "./jp/codes.js";
import { initAggregate, AGG_VALUE } from "./aggregate.js";
import CENSUS_MANIFEST from "./census/manifest.json" with { type: "json" };
import POP2020 from "./census/2020-pop.json" with { type: "json" };
import STATS2015 from "./census/2015-stats.json" with { type: "json" };
import AGES2020 from "./census/2020-ages.json" with { type: "json" };

const MB = new Map(CENSUS_MANIFEST.map(e => [e.code, e]));

// 指標定義：value(code)→数値|null（null＝データ欠損＝透明）。diverging は増減率のみ（固定級）
const INDICATORS = {
	density: { label: "人口密度", unit: "人/km²", fmt: v => Math.round(v).toLocaleString(), value: c => MB.get(c)?.density || null },
	pop:     { label: "人口",     unit: "人",     fmt: v => v.toLocaleString(),              value: c => POP2020[c]?.[0] || null },
	change:  { label: "増減率",   unit: "",       fmt: v => `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`, diverging: true,
		value: c => { const a = POP2020[c]?.[0], b = STATS2015[c]?.pop?.[0]; return a && b ? (a - b) / b : null; } },
	aging:   { label: "高齢化率", unit: "",       fmt: v => `${(v * 100).toFixed(1)}%`,
		value: c => { const g = AGES2020[c]; if (g?.length !== 32) return null;
			const t = g.reduce((s, x) => s + x, 0); if (!t) return null;
			return (g[13] + g[14] + g[15] + g[29] + g[30] + g[31]) / t; } },   // 65+＝男女とも末尾3ビン（65-69/70-74/75+）
	hh:      { label: "世帯数",   unit: "世帯",   fmt: v => v.toLocaleString(),              value: c => MB.get(c)?.hh || null },
};
const SEQ_COLORS = ["#eef5fc", "#cfe1f2", "#93c4e4", "#4f97cc", "#2166ac", "#0a3a67"];   // 明→深（分位6級）
const DIV_COLORS = ["#2166ac", "#67a9cf", "#d1e5f0", "#f5f0eb", "#fddbc7", "#ef8a62", "#b2182b"];   // 減←→増（固定7級）
const DIV_BREAKS = [-0.10, -0.05, -0.02, 0, 0.02, 0.05];   // 増減率の級境界（v ≤ 境界で左の級）
const FILL_A = 0.62;   // 塗りの透明度＝基図の道路・地名が透けて読める濃さ
const LEVEL_LABEL = { mun: "市区町村", pref: "都道府県", designated: "政令市", shicho: "振興局", gun: "郡" };

// 個別ポリゴン bbox 群 [{code, bb}] を近接クラスタリング（bbox が margin 以内で交われば連結）し、
// 「異なる市区町村コード数が最多」のクラスタ（=本島/本土）の外接bboxを返す。飛び地を持つ市区町村は
// ポリゴン単位で分割済み＝遠隔離島の巨大bboxが本土を橋渡ししない（座標ハードコード無しで主要部を自動導出）。
// 全県が1塊なら全体と一致（呼び側が面積比で島嶼有無を判定）。
function largestClusterBbox(rows, margin = 0.05) {
	const n = rows.length;
	if (!n) return null;
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
	const near = (p, q) => !(p[2] + margin < q[0] || q[2] + margin < p[0] || p[3] + margin < q[1] || q[3] + margin < p[1]);
	for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (near(rows[i].bb, rows[j].bb)) parent[find(i)] = find(j);
	const groups = new Map();
	for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
	let best = null, bestN = -1;
	for (const idx of groups.values()) { const codes = new Set(idx.map(i => rows[i].code)); if (codes.size > bestN) { bestN = codes.size; best = idx; } }   // 市区町村数最多＝本土
	let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90;
	for (const i of best) { const b = rows[i].bb; if (b[0] < lo0) lo0 = b[0]; if (b[1] < la0) la0 = b[1]; if (b[2] > lo1) lo1 = b[2]; if (b[3] > la1) la1 = b[3]; }
	return [lo0, la0, lo1, la1];
}

const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const packRGBA = (h, a) => { const [r, g, b] = hex2rgb(h); return ((r << 24) | (g << 16) | (b << 8) | Math.round(a * 255)) >>> 0; };

export function initChoropleth(map, { legend } = {}) {
	let pbf = null, feats = null;          // feats＝fid 整列の properties（表直書きの入力）
	let bboxByCode = new Map();            // code → [lo0,la0,lo1,la1]（flyTo 用・geojson 由来）
	const polyBoxByPref = new Map();       // 県コード → [{code, bb}]（個別ポリゴン単位・島嶼県の主要部クラスタリング用）
	let indicator = "none", selected = null, lastTable = null, lastCount = 0;   // 既定＝塗りなし（起動時に人口密度コロプレスを出さない・本人裁定2026-08-14）
	let lastLegend = null;   // 直近の凡例HTML（防災スタックから戻る時に refreshLegend で復元）
	// レベル：全国級で 市区町村(admin_all) ⇄ 都道府県(集約) をトグル。既定=市区町村（絶賛された全密度コロプレスを保存）。
	// nationalLevel=全国トグルの記憶／activeLevel=今スロットに載ってる層。県以下へドリル時は市区町村へ自動降下。
	let activeLevel = "mun", nationalLevel = "mun", agg = null;
	const layerCache = new Map();   // level → { pbf, features, groups }（"mun" は admin 直＝別扱い）

	// 指標チップ（#panel-head 左端）。「塗りなし」も一級の選択肢
	const head = document.getElementById("panel-head");
	const chipWrap = document.createElement("span");
	chipWrap.id = "c20-ind";
	chipWrap.style.display = "contents";
	head.appendChild(chipWrap);
	const chips = new Map();
	for (const [key, def] of [["none", { label: "塗りなし" }], ...Object.entries(INDICATORS)]) {
		const b = document.createElement("button");
		b.className = "c20-chip"; b.type = "button"; b.textContent = def.label;
		b.addEventListener("click", () => setIndicator(key));
		chipWrap.appendChild(b); chips.set(key, b);
	}
	const syncChips = () => chips.forEach((b, k) => b.setAttribute("aria-pressed", String(k === indicator)));

	// レベルチップ（文脈で変わる選択肢）＝指標とは別軸。全国=[都道府県,市区町村]／北海道=[振興局,市区町村] 等。
	const levelWrap = document.createElement("span");
	levelWrap.id = "c20-lvl"; levelWrap.style.display = "contents";
	head.appendChild(levelWrap);
	let levelChips = new Map();
	const syncLevelChips = () => levelChips.forEach((b, k) => b.setAttribute("aria-pressed", String(k === activeLevel)));
	function setLevels(keys) {   // 文脈に応じたレベル選択肢を差し替える（bind がドリル階層に応じて呼ぶ）
		if ([...levelChips.keys()].join() === keys.join()) { syncLevelChips(); return; }   // 同じ＝DOM を作り直さない
		levelWrap.textContent = ""; levelChips = new Map();
		for (const key of keys) {
			const b = document.createElement("button");
			b.className = "c20-chip c20-lvlchip"; b.type = "button"; b.textContent = LEVEL_LABEL[key] || key;
			b.addEventListener("click", () => { if (key === "pref" || key === "mun") nationalLevel = key; showLevel(key); });
			levelWrap.appendChild(b); levelChips.set(key, b);
		}
		syncLevelChips();
	}

	// ── 主要部/全体トグル（島嶼部を持つ県の pref view でのみ・データ駆動で自動判定）──────────────
	// 東京(小笠原/南鳥島)・沖縄(先島)・長崎(対馬/五島)・鹿児島(奄美/種子)・島根(隠岐)等は全県bboxが遠隔離島まで
	// 含んで巨大化。主要部(本島/本土＝最大クラスタ)bboxを別持ちし、カメラ枠だけトグルで切替（クリップ/probe は
	// 全体bboxのまま不変）。対象県はハードコードせず bbox クラスタリングで自動検出＝沖縄本島等も一律に効く。
	// トグルはドリルの .cs-drill-title-row（ルビ「東京都」の右）に差し込む（本人裁定2026-08-14）。
	let bboxScope = "main";   // "main"(主要部) | "full"(全体)。pref を開くたび main に戻す
	const _mainBbox = new Map();   // prefCode → 主要部bbox（島嶼あり）or null（島嶼なし＝全体と実質同一＝トグル不要）
	function mainBboxForPref(prefCode) {
		if (_mainBbox.has(prefCode)) return _mainBbox.get(prefCode);
		const main = largestClusterBbox(polyBoxByPref.get(prefCode) ?? []), full = bboxForCode(prefCode);
		const areaOf = b => b ? (b[2] - b[0]) * (b[3] - b[1]) : 0;
		const val = (main && full && areaOf(main) < areaOf(full) * 0.6) ? main : null;   // 主要部が全体の6割未満＝島嶼ありと判定
		_mainBbox.set(prefCode, val);
		return val;
	}
	function frameBboxForCode(code) {   // カメラ枠用bbox（島嶼県は主要部/全体トグルに従う。非prefは常に全体）
		const c = String(code);
		if (c.length === 2 && bboxScope === "main") { const m = mainBboxForPref(c); if (m) return m; }
		return bboxForCode(c);
	}
	function setScope(prefCode, reset = true) {   // bind が pref で prefCode・他レベルで null を渡す。reset=false はトグルクリック再描画
		if (reset) bboxScope = "main";
		const row = document.querySelector(".cs-drill-title-row");
		row?.querySelector(".c20-scope")?.remove();   // 既存トグルを外す（再描画）
		const c = prefCode ? String(prefCode) : null;
		if (!row || !c || c.length !== 2 || !mainBboxForPref(c)) return;   // 島嶼なし県/非pref/タイトル未描画＝出さず
		const span = document.createElement("span");
		span.className = "c20-scope"; span.style.display = "inline-flex"; span.style.gap = "4px";
		for (const [key, label] of [["main", "主要部"], ["full", "全体（離島含む）"]]) {
			const b = document.createElement("button");
			b.className = "c20-chip c20-lvlchip"; b.type = "button"; b.textContent = label;
			b.setAttribute("aria-pressed", String(key === bboxScope));
			b.addEventListener("click", () => { bboxScope = key; setScope(c, false); flyToCode(c); });
			span.appendChild(b);
		}
		row.appendChild(span);
	}

	const ready = (async () => {
		// ★フル解像度 admin_all をそのまま食わせる＝gint の GPU 動的LOD に境界描画を委ねる（前方スナップで
		// ズーム毎に鋭く・gap無し）。CPU 事前間引き（旧・simplified+小島落とし）は gint の心臓を殺し、
		// カクカク境界＋隙間を生んでいた（2026-08-12 実測・本人指摘）＝撤去。塗り(idfill)は本質的に全密度
		// ＝FILL_MAX_EDGES(2M) を踏むので、この層だけ fillMaxEdges で上限を上げて全密度塗りを通す。
		pbf = await geopbf("admin_all", { gint: true });   // bucket 名慣習＝IDBファースト（2回目はネットワーク0）
		if (!pbf?.unPackGint) throw new Error("admin_all の読込に失敗");
		window.__adminPbf = pbf;   // console 検証用（ortho作法の window デバッグ手すり）
		const n = pbf.fmap?.length ?? 0;
		feats = new Array(n);
		for (let i = 0; i < n; i++) { let p = {}; try { p = pbf.getProperties(i) ?? {}; } catch { /* 壊れ feature＝空 */ } feats[i] = { properties: p }; }
		// bbox 台帳は geojson 由来（壊れ feature スキップで fid とはズレ得るが、code キー引きなので無害）
		for (const f of pbf.geojson?.features ?? []) {
			const code = f?.properties?.code; if (!code || !f.geometry) continue;
			let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90;
			const walk = c => { if (typeof c[0] === "number") { if (c[0] < lo0) lo0 = c[0]; if (c[0] > lo1) lo1 = c[0]; if (c[1] < la0) la0 = c[1]; if (c[1] > la1) la1 = c[1]; } else c.forEach(walk); };
			walk(f.geometry.coordinates);
			bboxByCode.set(code, [lo0, la0, lo1, la1]);
			// 個別ポリゴン bbox を県別に貯める（島嶼県の主要部＝最大クラスタ算出用）。飛び地を持つ市区町村は
			// MultiPolygon を分割＝各ポリゴンが局所でクラスタ化し、遠隔離島の巨大bboxが本土を橋渡ししない。集約(XX000/XX100)除外。
			if (code.length === 5 && !code.endsWith("00")) {
				const gg = f.geometry, polys = gg.type === "Polygon" ? [gg.coordinates] : gg.type === "MultiPolygon" ? gg.coordinates : [];
				const pref = code.slice(0, 2);
				let arr = polyBoxByPref.get(pref); if (!arr) polyBoxByPref.set(pref, arr = []);
				for (const poly of polys) {
					let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
					for (const ring of poly) for (const c of ring) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
					arr.push({ code, bb: [x0, y0, x1, y1] });
				}
			}
		}
		agg = await initAggregate(pbf);   // 集約グループ割当（コード1走査・軽量）。pref 等の層は初トグルで遅延 merge 焼き
		applyAdmin();
		setIndicator(indicator);
		setLevels(["pref", "mun"]);   // 全国級の既定選択肢
		return api;
	})();

	function classify(values) {   // 分位6級の境界値（重複値の多い指標でも壊れない素朴分位）
		const s = [...values].sort((a, b) => a - b);
		const br = [];
		for (let k = 1; k < SEQ_COLORS.length; k++) br.push(s[Math.min(s.length - 1, Math.floor(s.length * k / SEQ_COLORS.length))]);
		return br;
	}
	function buildTable() {
		const def = INDICATORS[indicator];
		// 活性レベルの fid 列（数・コード・値）を用意＝市区町村は per-code、集約は「同じ指標をメンバ合算」（AGG_VALUE）。
		let n, codeOf, valueOf;
		if (activeLevel !== "mun") {
			const L = layerCache.get(activeLevel);
			if (!L) return;                                   // 層まだ未焼き（初トグルの await 待ち）＝載った後に呼び直す
			n = L.features.length;
			codeOf = i => L.groups[i].code;
			valueOf = i => AGG_VALUE[indicator]?.(L.groups[i].members) ?? null;
		} else {
			if (!feats) return;
			n = feats.length;
			codeOf = i => feats[i].properties?.code;
			valueOf = i => def.value(feats[i].properties?.code);
		}
		if (!def) { lastTable = null; lastCount = 0; map.paint(null); legend?.(lastLegend = null); return; }   // legend＝gadgetの戻り値＝setter関数そのもの（塗りなし＝凡例も消す）
		const u32 = new Uint32Array(n * 4);
		const vals = [], vOf = new Array(n);
		for (let i = 0; i < n; i++) { const v = valueOf(i); vOf[i] = v; if (v != null) vals.push(v); }
		const breaks = def.diverging ? DIV_BREAKS : classify(vals);
		const colors = def.diverging ? DIV_COLORS : SEQ_COLORS;
		const cls = v => { let k = 0; while (k < breaks.length && v > breaks[k]) k++; return k; };
		for (let i = 0; i < n; i++) {
			const code = codeOf(i), v = vOf[i];
			// ★値なし＝不可視(flags bit0=0)。市区町村では admin_all 20個(北海道14振興局＝"北海道"名の集約＋北方領土6村)が
			// 該当＝重なり fid を可視にすると idfill winding が非整数化→下の市区町村まで塗りが消える(札幌が低く見えた真因)。
			// エンジンの vsId が不可視fidを蓄積から除外＝重なりが無い物として正しく塗れる。集約層では欠損指標が不可視。
			if (v == null) { u32[i * 4] = 0; u32[i * 4 + 1] = 0; u32[i * 4 + 2] = ((8 << 24) | (6 << 8) | 0) >>> 0; continue; }
			const isSel = selected && code === selected;   // 選択以外の淡色化は撤去済（白縁だけで示す）
			u32[i * 4] = packRGBA(colors[cls(v)], FILL_A);
			u32[i * 4 + 1] = isSel ? packRGBA("#ffffff", 0.95) : 0;
			u32[i * 4 + 2] = (((isSel ? 20 : 8) << 24) | (6 << 8) | 1) >>> 0;   // width(1/8px)<<24 | radius<<8 | visible
		}
		lastTable = u32; lastCount = n;
		map.paintTable(u32, n);
		legend?.(lastLegend = legendHtml(def, breaks, colors, activeLevel));
	}
	function refreshLegend() { legend?.(lastLegend); }   // 防災スタック解除時にコロプレス凡例を復元（塗りなし=null復元）
	function legendHtml(def, breaks, colors, level = "mun") {
		const row = (c, t) => `<div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.7"><span style="width:14px;height:10px;border-radius:2px;background:${c};display:inline-block"></span>${t}</div>`;
		const f = def.fmt;
		const rows = colors.map((c, k) => {
			const lo = k === 0 ? null : breaks[k - 1], hi = k < breaks.length ? breaks[k] : null;
			const t = lo == null ? `〜 ${f(hi)}` : hi == null ? `${f(lo)} 〜` : `${f(lo)} 〜 ${f(hi)}`;
			return row(c, t);
		}).join("");
		return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${def.label}${def.unit ? `（${def.unit}）` : ""} <span style="font-weight:400;color:#89a">2020年・${LEVEL_LABEL[level] || "市区町村"}</span></div>${rows}
			<div style="font-size:10px;color:#89a;margin-top:4px">塗りは真俯瞰のみ（チルトで消灯）</div>`;
	}
	function setIndicator(key) { indicator = key; syncChips(); buildTable(); }
	// 層の持参スタイル：既定オレンジ線(1px)は全国ズームで市区町村(2〜3px)を覆い隠しコロプレスを潰す
	// （実測 2026-08-12＝「塗れているのに見えない」）。基図に馴染む青灰の細線へ＝塗りが主役・境界は気配。
	const ADMIN_STYLE = (() => {
		const t = new Float32Array(256 * 4);
		t.set([0, 0, 0, 0], 0);              // style0 polygon＝未使用（塗りは paint 表＝idfill が担う）
		t.set([0.42, 0.5, 0.62, 0.45], 4);   // style1 line＝青灰・淡
		return { styleTable: t, lineWidth: 0.7 };
	})();
	const AGG_STYLE = (() => {   // 集約境界＝本数が少ない＝やや濃く太く主張してよい（県境/振興局境/郡境）
		const t = new Float32Array(256 * 4);
		t.set([0, 0, 0, 0], 0);
		t.set([0.42, 0.5, 0.62, 0.72], 4);
		return { styleTable: t, lineWidth: 0.9 };
	})();
	function applyAdmin() {   // 市区町村(admin_all)を gint スロットへ＝レベル'mun'。防災/筆スタックから戻る時も呼ばれる。
		if (!pbf) return;
		activeLevel = "mun";
		// fillMaxEdges=6M＝admin_all(437万辺)の全密度塗りを通す。この層限定＝筆/国立公園の既定 2M 暴走止めは不変。
		map.applyGintData(pbf, "admin_all", false, { minZoom: 3, style: ADMIN_STYLE, fillMaxEdges: 6_000_000 });
		buildTable();   // 現指標を市区町村で塗る（スタック復帰・レベル差替も同経路＝worker 側状態に依存しない）
	}
	// レベル載せ替え：市区町村(admin) ⇄ 集約(pref 等)。層を差替えて活性レベルの表で塗り直す。集約層は初回のみ merge 焼き。
	async function showLevel(level) {
		if (level === activeLevel) return;   // 既に同レベル＝再ベイク回避（bousai 復帰は applyAdmin 直呼び＝別経路で必ず再適用）
		if (level === "mun") { applyAdmin(); syncLevelChips(); return; }
		if (!agg) return;
		let L = layerCache.get(level);
		if (!L) { L = await agg.level(level, { partitionIslands: true }); layerCache.set(level, L); }
		activeLevel = level;
		map.applyGintData(L.pbf, "agg_" + level, false, { minZoom: 1, style: AGG_STYLE, fillMaxEdges: 8_000_000 });
		buildTable();
		syncLevelChips();
	}
	// 集約ポリゴン(振興局/郡＝ドリルコードを持たない合成コード)をクリック＝その領域の市区町村へ降下＋寄る。
	function descendAgg(fid) {
		const g = layerCache.get(activeLevel)?.groups?.[fid];
		showLevel("mun");
		if (g?.bbox) map.flyTo((g.bbox[0] + g.bbox[2]) / 2, (g.bbox[1] + g.bbox[3]) / 2, map.fitZoomForBbox(g.bbox));
	}
	function bboxForCode(code) {
		const c = String(code);
		if (bboxByCode.has(c)) return bboxByCode.get(c);
		// 政令市（例:14100）＝区 bbox の合併／2桁＝都道府県＝前方一致の合併
		let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90, hit = false;
		for (const [k, b] of bboxByCode) {
			if (!belongsTo(k, c)) continue;   // 政令市＝区合併／東京都区部13100＝23区合併／県＝前方一致
			hit = true;
			if (b[0] < lo0) lo0 = b[0]; if (b[1] < la0) la0 = b[1]; if (b[2] > lo1) lo1 = b[2]; if (b[3] > la1) la1 = b[3];
		}
		return hit ? [lo0, la0, lo1, la1] : null;
	}
	function flyToCode(code) {
		const b = frameBboxForCode(code);   // 島嶼県の pref は主要部/全体トグルに従う（クリップ用 bboxForCode は不変）
		if (!b) return false;
		map.flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, map.fitZoomForBbox(b));
		return true;
	}
	function setSelected(code) { selected = code || null; buildTable(); }

	function geomForCode(code) {   // code→境界幾何（admin_all 由来）。防災の市域クリップ用。
		if (!pbf || !feats) return null;
		const c = String(code);
		const i = feats.findIndex(f => f?.properties?.code === c);
		if (i >= 0) { try { return pbf.getGeometry(i); } catch { return null; } }   // 市区町村・区＝単一 feature
		// 集約コード（政令市14100・東京都区部13100・県2桁）＝子の幾何を MultiPolygon へ合併して返す。無いと
		// makeCityClip が cityGeom=null→巨大bboxフォールバックで隣接市へ大はみ出しする（集約単位の防災クリップ根治）。
		const parts = [];
		for (let j = 0; j < feats.length; j++) {
			const kc = feats[j]?.properties?.code;
			if (!kc || !belongsTo(kc, c)) continue;
			let g; try { g = pbf.getGeometry(j); } catch { continue; }
			if (!g) continue;
			if (g.type === "Polygon") parts.push(g.coordinates);
			else if (g.type === "MultiPolygon") for (const p of g.coordinates) parts.push(p);
		}
		return parts.length ? { type: "MultiPolygon", coordinates: parts } : null;
	}
	const api = { ready, applyAdmin, flyToCode, bboxForCode, geomForCode, setSelected, setIndicator, showLevel, setLevels, setScope, descendAgg, refreshLegend, get activeLevel() { return activeLevel; }, get nationalLevel() { return nationalLevel; }, get pbf() { return pbf; } };
	return api;
}
