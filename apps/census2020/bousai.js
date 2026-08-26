// 防災×3D＝census2020 の一級市民。市区町村レベルのトグル5種:
//   土砂災害(A33) / 洪水浸水(A31) / 14条地図(moj) / 筆ポリゴン(maff) … gint スタック（単一スロットに合成して載せる）
//   避難場所（指定緊急避難場所） … DOMマーカー層（gint と独立・標高付き属性カード）
// gint スタックの作法（gint draw spec の restyle 哲学）:
//   ・データセット集合が変わった時だけ FC 合成→gint 焼き（IDB cache: stack://{code}/{sig}＝2回目爆速）
//   ・トグルの見た目切替は fid スタイル表の再計算のみ（ジオメトリ再構築ゼロ）…単一ソース時は直載せの高速路
// 3Dの絵作り: 真俯瞰=ランク色の2D塗り（ハザードマップ見せ切り）⇄ チルト=pitch-watcher が standupGint(2)
//   ＝実スケール地形のドレープ境界線＋PLATEAU 突き刺し（エンジン既存ゲートの転用・改造なし）。
import { geopbf } from "geopbf";
import { nativeBucket } from "native-bucket";
import { loadMoj, mojSource, probeBucket } from "./moj.js";
import { loadMaff, maffCode } from "./maff.js";
import { escHtml } from "./ui/shared.js";
import { DESIGNATED_CITIES } from "./jp/codes.js";

const API = "https://api.ortho-earth.com";
const DRAPE_LIFT_M = 2;
const PITCH_UP = 0.025, PITCH_DOWN = 0.015;   // 真俯瞰⇄チルトのヒステリシス（rad）
const HINAN_MAX = 1500;                        // 市区町村 bbox 内マーカー上限（DOM 予算）
const HINAN_FLAGS = ["洪水", "土砂", "高潮", "地震", "津波", "大火", "内水", "火山"];   // bake の flags ビット順

const A31_COLORS = ["#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c"];   // 浸水深ランク1..6
const A31_DEPTH = { 1: "〜0.5m", 2: "0.5〜3.0m", 3: "3.0〜5.0m", 4: "5.0〜10.0m", 5: "10.0〜20.0m", 6: "20.0m〜" };   // A31b_201 浸水深ランク→ラベル
// スタック層の持参スタイル（style0=塗り未使用・style1=線）。線は淡く＝ランク塗りが主役。
// rgb はドレープ線色（standupGint が styleTable[4..6] を読む）＝チルトの見せ場用に暖色。
const STACK_STYLE = (() => {
	const t = new Float32Array(256 * 4);
	t.set([0, 0, 0, 0], 0);
	t.set([1.0, 0.55, 0.15, 0.22], 4);
	return { styleTable: t, lineWidth: 0.6, maskColor: [0, 0, 0, 0], hiliteColor: [0.16, 0.40, 0.70, 1.0] };   // ホバー=線のみ（マスク撤去）＋ホバー線は町丁目と同じ青
})();
const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const packRGBA = (h, a) => { const [r, g, b] = hex2rgb(h); return ((r << 24) | (g << 16) | (b << 8) | Math.round(a * 255)) >>> 0; };

let _cacheP = null;
const getCache = () => (_cacheP ||= nativeBucket(API).Cache("GIS/pbf"));
const gunzipBuf = async buf => {
	const h = new Uint8Array(buf, 0, 2);
	return (h[0] === 0x1f && h[1] === 0x8b)
		? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
		: buf;
};
// 並びは配列順＝スタックの合成順（面のハザード→線の筆＝線が上に乗る）
const GINT_LAYERS = [
	{ key: "a33", label: "土砂災害" },
	{ key: "a31", label: "洪水浸水" },
	{ key: "moj", label: "14条地図" },
	{ key: "maff", label: "筆ポリゴン" },
];
// チップ並び＝土砂災害・洪水浸水・避難場所・14条地図・筆ポリゴン（本人裁定 2026-08-18）
const CHIP_DEFS = [GINT_LAYERS[0], GINT_LAYERS[1], { key: "hinan", label: "避難場所" }, GINT_LAYERS[2], GINT_LAYERS[3]];
const MAFF_LINE = { 100: "#2fae52", 200: "#b0731f" };   // 田=緑 / 畑=黄土（黄緑は緑と1px線で判別不能＝色相を離す・moj橙#ff8c26とも別系統）
const MAFF_FILL_ALPHA = 0.18;                           // 田畑の塗り＝線と同色相の淡面（真俯瞰の読図用・ハザード面0.5より控えめ＝基図を殺さない）

export function initBousai(map, { bboxForCode, cityGeomForCode, legend, onStackApplied, onStackCleared } = {}) {
	let city = null;
	const on = new Set();              // 点灯中の gint レイヤ key
	let hinanOn = false;
	let stackApplied = false;          // gint スロットをスタックが占有中か
	let soloSrc = null;                // 単独点灯中の層 key（筆の高速路は feature に _src が無い＝クリック種別判定用）
	let draped = false, drapePending = false, stackDrapeFill = false;
	let seq = 0;                       // 再入ガード（連打・都市切替中の非同期競合）
	const fcCache = new Map();         // `${city}/${key}` → Feature[]（セッション内メモ）

	// --- トグルUI（#panel-head・市区町村ドリル中のみ表示） ---
	const head = document.getElementById("panel-head");
	const wrap = document.createElement("span");
	wrap.id = "c20-layers";
	wrap.style.cssText = "display:none;gap:6px;align-items:center;flex-wrap:wrap";   // 置き場はドリル面（wikiカード直下）＝bind.js が再親付け。意匠は panel.scss
	head.appendChild(wrap);
	const sta = document.createElement("span");
	sta.style.cssText = "font-size:11px;color:#89a";
	const chips = new Map();
	for (const def of CHIP_DEFS) {
		const b = document.createElement("button");
		b.className = "c20-chip"; b.type = "button"; b.textContent = def.label; b.disabled = true;
		b.addEventListener("click", () => toggle(def.key));
		wrap.appendChild(b); chips.set(def.key, b);
	}
	wrap.appendChild(sta);
	const say = t => { sta.textContent = t || ""; };
	const nextFrame = () => new Promise(r => setTimeout(r, 0));   // 重い await/同期ループの前に状況表示を描かせる譲り
	// 防災層の凡例（コロプレスの legendHtml と同じ行様式）。洪水=浸水深6段（深い順）・土砂=警戒/特別警戒。
	const legRow = (c, t) => `<div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.7"><span style="width:14px;height:10px;border-radius:2px;background:${c};display:inline-block"></span>${t}</div>`;
	function hazardLegend(keys) {
		const secs = [];
		if (keys.includes("a31")) {
			const rows = [6, 5, 4, 3, 2, 1].map(r => legRow(A31_COLORS[r - 1], A31_DEPTH[r])).join("");   // 深い順に上から
			secs.push(`<div style="font-size:12px;font-weight:600;margin-bottom:4px">洪水浸水想定 <span style="font-weight:400;color:#89a">想定最大規模・浸水深</span></div>${rows}`);
		}
		if (keys.includes("a33")) {
			const rows = legRow("#c0392b", "特別警戒区域（レッド）") + legRow("#d9a441", "警戒区域（イエロー）");   // paint と同色
			secs.push(`<div style="font-size:12px;font-weight:600;margin:${secs.length ? "8px" : "0"} 0 4px">土砂災害警戒区域</div>${rows}`);
		}
		if (secs.length) secs.push(`<div style="font-size:10px;color:#89a;margin-top:4px">出典: 国土数値情報（KSJ）</div>`);   // KSJ の出典はハザード節（a31/a33）だけに付ける
		if (keys.includes("maff")) {
			const rows = legRow(MAFF_LINE[100], "田") + legRow(MAFF_LINE[200], "畑");
			secs.push(`<div style="font-size:12px;font-weight:600;margin:${secs.length ? "8px" : "0"} 0 4px">筆ポリゴン <span style="font-weight:400;color:#89a">農林水産省・農地の区画</span></div>${rows}`);
		}
		if (keys.includes("moj") && !secs.length) secs.push(`<div style="font-size:12px;font-weight:600">筆界（14条地図）</div><div style="font-size:11px;color:#89a">法務省 登記所備付地図</div>`);
		return secs.length ? secs.join("") : null;
	}
	const syncChips = () => {
		chips.forEach((b, k) => b.setAttribute("aria-pressed", String(k === "hinan" ? hinanOn : on.has(k))));
	};

	// --- 在庫 probe（市区町村ごと・並列）。無い層は非活性＝「未整備」を正直に見せる ---
	async function probeAvailability(code) {
		const mySeq = ++seq;
		chips.forEach(b => { b.disabled = true; b.title = "確認中…"; });
		// moj筆(14条地図)は末端の区/市単位のみ＝集約コード(政令市14100・特別区部13100)は持たない。
		// 探ると geojsonl フォールバックまで落ちて 404 を撒く（本人報告2026-08-14 moj/13100.geojsonl）＝probeを省く。
		const mojEligible = !(DESIGNATED_CITIES.has(code) || code === "13100");
		const probes = {   // GET+即中断（bucket Worker は HEAD 405＝moj.js probeBucket の轍）
			moj: mojEligible ? mojSource(code).then(s => !!s) : Promise.resolve(false),
			maff: Promise.resolve(!!maffCode(code)),   // 網羅表の in-memory 判定＝network 0（農地の無い市区町村は表に無い）
			a33: a33TargetForPref(code.slice(0, 2)).then(t => !!t).catch(() => false),   // browser-native＝県に A33 KSJ があれば有効（catalog確認）
			a31: a31CatIndex().then(cat => meshesForBbox(bboxForCode?.(code)).some(m => cat.has(m))).catch(() => false),   // browser-native＝市bboxを覆う1次メッシュが A31b catalog にあれば有効
			hinan: probeBucket(`${API}/bucket/bousai/hinan/${code.slice(0, 2)}.json`),
		};
		for (const [k, p] of Object.entries(probes)) p.then(ok => {
			if (mySeq !== seq || city !== code) return;   // 別の市区町村へ移った後の到着は捨てる
			const b = chips.get(k);
			b.disabled = !ok;
			b.title = ok ? "" : "データ未整備";
		});
	}

	// --- gint スタック（筆∪土砂∪洪水） ---
	// ハザード層(a31/a33)は原典KSJ（土砂=県別・洪水=1次メッシュ別）を legacy geopbf で直読み＝proxy＋自動IDBキャッシュ。
	// 市境界クリップ＋ランク/区分で束ねて fid を1桁に（WebGPU idfill fid≤2047）。サーバー焼き（thinRingsで階段を潰す等の
	// 加工）を廃し原典忠実へ（裁定2026-08-14）。gint は載せず受信後にWASMで焼く（スタック再マージで無駄になるため）。
	// ── A33 土砂＝browser-native オンデマンド（既定路線・裁定2026-08-13）。単被覆化なし・県別 KSJ を直読み。
	// ★moj.js と同じ作法＝レガシー geopbf facade を使う。初期化は main.js 冒頭の createGeopbf（8/20改定＝
	// SDK分割後は census バンドルの geopbf が engine と別インスタンスのため、engine 任せは本番だけ死ぬ・
	// legacy-geopbf-init-order の罠）。ここでは再呼びしない。
	// legacy geopbf(url) は CORS遮断の MLIT KSJ zip を api worker の proxy 経由で取り→zip内geojson抽出→ingest、
	// かつ geopbf の URL キャッシュ規約で自動IDB＝2回目爆速（moj AIGID と同じ）。target は catalog（正典）から。
	const A33_GENSHO = { 1: "急傾斜地の崩壊", 2: "土石流", 3: "地滑り" };   // A33_001＝現象の種類
	// 境界クリップの素（外周リングの点in面・穴は無視＝十分）。旧a33-batch/ksj-common と同一。
	const pointInRing = (x, y, ring) => { let hit = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if (((a[1] > y) !== (b[1] > y)) && (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])) hit = !hit; } return hit; };
	const pointInGeom = (x, y, g) => g.type === "Polygon" ? pointInRing(x, y, g.coordinates[0]) : g.type === "MultiPolygon" ? g.coordinates.some(p => pointInRing(x, y, p[0])) : false;
	let _a33Cat = null;
	const catJson = async url => { const r = await fetch(url, { cache: "no-store" }); return r.ok ? JSON.parse(new TextDecoder().decode(await gunzipBuf(await r.arrayBuffer()))) : null; };
	async function a33TargetForPref(pref) {   // 県コード→ A33 KSJ target（zipURL#zip内path）を catalog から
		if (!_a33Cat) {
			_a33Cat = new Map();
			const idx = await catJson(`${API}/bucket/catalog/index.json`) || [];
			const a33 = idx.find(d => /土砂災害警戒/.test(d.title || ""));   // 最新 A33（A33-2025 等）を自動選択
			const ds = a33 && await catJson(`${API}/bucket/catalog/${a33.dataset_code}.json`);
			for (const f of ds?.files || []) if (f.scope === "都道府県" && f.format === "geojson" && /Polygon/i.test(f.target)) _a33Cat.set(f.pref_code, f.target);   // 面(Polygon)を明示選択＝一部県(広島34)は線(Line)geojsonも持つ→線を拾うと面merge が空振りして出ない
		}
		return _a33Cat.get(pref) || null;
	}
	// 境界クリップ closure（A33/A31 共有）＝表示中の市区町村ポリゴンで絞る。「少しでも市にかかっていれば、その区域を
	// 丸ごと出す」＝外周頂点が1つでも市内なら feature ごと採用。重心割当てと違い境界の欠けを作らない（安全側）。
	// 矩形クリップの隅の劣化も消える。県/メッシュ丸ごとを gint に渡すと idfill 巻き数が溢れるのも、市の数へ落として回避。
	function makeCityClip(code) {
		const cityGeom = cityGeomForCode?.(code) ?? null;   // 市境界ポリゴン（無ければ bbox のみのフォールバック）
		const bb = bboxForCode?.(code);   // 点in面の前置ふるい（市bbox外の頂点は即skip）
		const inBB = c => !bb || (c[0] >= bb[0] && c[0] <= bb[2] && c[1] >= bb[1] && c[1] <= bb[3]);
		return comps => {   // 外周頂点が1つでも市内→採用（早期脱出）。少しでもかかれば出す＝欠け無し優先。
			for (const poly of comps) for (const c of poly[0]) {
				if (!inBB(c)) continue;
				if (!cityGeom) return true;   // 市ポリゴン無→bbox内に頂点があれば出す（フォールバック）
				if (pointInGeom(c[0], c[1], cityGeom)) return true;
			}
			return false;
		};
	}
	const compsOf = g => g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
	const groupsToFeats = groups => [...groups.values()].map(({ props, comps }) => ({
		type: "Feature", properties: props,
		geometry: comps.length === 1 ? { type: "Polygon", coordinates: comps[0] } : { type: "MultiPolygon", coordinates: comps },
	}));
	async function loadA33Pref(code) {
		const target = await a33TargetForPref(code.slice(0, 2)).catch(() => null);
		if (!target) return null;
		say("土砂データ取得中…（初回のみ・proxy 経由）");   // moj 作法＝8秒級の初回読みに進捗を出す
		const pbf = await geopbf(target, { gint: false, name: `a33/${code.slice(0, 2)}` }).catch(e => { console.warn("[a33]", e); return null; });   // legacy geopbf＝proxy経由＋自動IDBキャッシュ
		const raw = pbf?.geojson?.features;
		if (!raw) return null;
		// ②生KSJ props(A33_002区分/A33_001現象)→{kbn,gensho} へ写像し kbn/gensho で束ねて fid を1桁に（gint idfill fid≤2047）。
		const zoneHitsCity = makeCityClip(code);
		const groups = new Map();
		for (const f of raw) {
			const comps = compsOf(f.geometry ?? {});
			if (!comps.length || !zoneHitsCity(comps)) continue;   // 境界クリップ（少しでも市にかかる区域だけ・feature 単位で丸ごと）
			const kbn = +f.properties?.A33_002 === 2 ? 2 : 1, gensho = A33_GENSHO[+f.properties?.A33_001] ?? "";
			const k = `${kbn}/${gensho}`;
			if (!groups.has(k)) groups.set(k, { props: { _src: "a33", kbn, gensho }, comps: [] });
			groups.get(k).comps.push(...comps);
		}
		return groupsToFeats(groups);
	}
	// ── A31 洪水浸水（想定最大規模）＝A33 と同じ browser-native 直読み（裁定2026-08-14「元データ直読み・IDB保存・A33参考」）。
	// 旧・サーバー焼き geopbf（thinRingsで階段を潰した）を廃し、catalog A31b（1次メッシュ単位 geojson・原典メッシュ忠実）を
	// メッシュ毎に legacy geopbf 直読み（proxy＋自動IDBキャッシュ＝2回目爆速）→市境界クリップ→浸水深ランクで束ねる。
	// A33 が県単位なのに対し A31 は1次メッシュ単位配布＝索引を location_code（メッシュ）で持ち、市bboxを覆うメッシュだけ引く。
	let _a31Cat = null;
	async function a31CatIndex() {   // 1次メッシュコード → [想定最大規模 geojson target, …]（河川区分ごとに複数あり得る）
		if (!_a31Cat) {
			_a31Cat = new Map();
			const idx = await catJson(`${API}/bucket/catalog/index.json`) || [];
			const a31 = idx.find(d => /^A31b/.test(d.dataset_code || "") || /洪水浸水想定区域（1次メッシュ/.test(d.title || ""));   // 最新 A31b（メッシュ単位）
			const ds = a31 && await catJson(`${API}/bucket/catalog/${a31.dataset_code}.json`);
			// 想定最大規模(-20-)レイヤのみ採用（計画規模/継続時間/危険区域は捨てる）。catalog は旧 A31(2022) と A31b(2025) を
			// 同居させており両方読むと同一区域を二重取得する＝target 名から年度を解析し (メッシュ×河川区分) ごとに最新年度だけ
			// 採る（本人裁定2026-08-14「最新年度のみ」）。製品名(A31/A31b)に依らず年度で採択＝将来カタログが年度を混ぜても堅牢。
			const best = new Map();   // `${mesh}/${rc}` → { year, target }
			for (const f of ds?.files || []) {
				if (f.format !== "geojson") continue;
				const m = (f.target.split("#")[1] || "").match(/A31b?-20-(\d+)_(\d+)_(\d+)/);   // 想定最大(-20-)・(year, 河川区分, メッシュ)
				if (!m) continue;
				const [year, rc, mesh] = [+m[1], m[2], m[3]];
				const key = `${mesh}/${rc}`, cur = best.get(key);
				if (!cur || year > cur.year) best.set(key, { year, mesh, target: f.target });
			}
			for (const { mesh, target } of best.values()) {
				if (!_a31Cat.has(mesh)) _a31Cat.set(mesh, []);
				_a31Cat.get(mesh).push(target);
			}
		}
		return _a31Cat;
	}
	// 1次メッシュコード＝`${floor(lat*1.5)}${floor(lon)-100}`（a31-all.mjs meshBbox の逆算）。市bboxを覆う候補を列挙。
	const meshesForBbox = bb => {
		if (!bb) return [];
		const out = [];
		for (let p = Math.floor(bb[1] * 1.5); p <= Math.floor(bb[3] * 1.5); p++)
			for (let q = Math.floor(bb[0]) - 100; q <= Math.floor(bb[2]) - 100; q++)
				out.push(`${p}${String(q).padStart(2, "0")}`);
		return out;
	};
	async function loadA31Meshes(code) {
		const bb = bboxForCode?.(code);
		const cat = await a31CatIndex().catch(e => { console.warn("[a31]", e); return null; });
		if (!bb || !cat) return null;
		const targets = meshesForBbox(bb).filter(m => cat.has(m)).flatMap(m => cat.get(m));
		if (!targets.length) return null;
		const zoneHitsCity = makeCityClip(code);
		const groups = new Map();
		const N = targets.length;
		for (let mi = 0; mi < N; mi++) {
			const of = N > 1 ? ` ${mi + 1}/${N}` : "";
			say(`洪水データ取得中${of}…（初回は数十秒・proxy 経由）`);
			await nextFrame();   // 状況表示を先に描いてから重い取得 await へ（24秒級・1メッシュ32MB）
			const pbf = await geopbf(targets[mi], { gint: false, name: `a31/${targets[mi].split("#")[0].split("/").pop()}` }).catch(e => { console.warn("[a31]", e); return null; });   // legacy geopbf＝proxy＋自動IDB
			const raw = pbf?.geojson?.features;
			if (!raw) continue;
			// A31b の1 feature は「rank ごとに数万メッシュセルを集約した巨大 MultiPolygon（80km四方・32MB級）」。
			// A33 の「feature 丸ごと」だと 80km を丸取り＝構成ポリゴン（メッシュセル）へ分解し、セル単位で市クリップする。
			// ＝境界外セルは捨て・市にかかるセルは丸ごと（欠け無し・階段=原典を保つ）・push はセル単位（スプレッド禁止＝
			// 数万要素の push(...arr) は Maximum call stack size exceeded で落ちる）。数百万セル＝チャンク分割で UI を固めず進捗表示。
			for (let i = 0; i < raw.length; i++) {
				if ((i & 0x1FFFF) === 0) { say(`洪水域を市域でクリップ中${of}…（${Math.floor(i / raw.length * 100)}%）`); await nextFrame(); }
				const g = raw[i].geometry;
				const polys = g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : [];
				if (!polys.length) continue;
				const rank = Math.max(1, Math.min(6, +raw[i].properties?.A31b_201 || +raw[i].properties?.A31_201 || 1));   // 想定最大規模の浸水深ランク
				const k = `r${rank}`;
				let bkt = groups.get(k);
				for (const poly of polys) {
					if (!zoneHitsCity([poly])) continue;   // セル単位の市クリップ（外周頂点が1つでも市内→採用）
					if (!bkt) { bkt = { props: { _src: "a31", rank, depth: A31_DEPTH[rank] ?? "" }, comps: [] }; groups.set(k, bkt); }
					bkt.comps.push(poly);   // 単一push＝スプレッド無し
				}
			}
		}
		return groupsToFeats(groups);
	}
	async function sourceFC(code, key) {
		const ck = `${code}/${key}`;   // a33 は境界クリップ済の少数feature＝市単位で軽くセッション保持（県ファイル自体は geopbf の URL キャッシュで使い回し＝2回目爆速）
		if (fcCache.has(ck)) return fcCache.get(ck);
		let feats = null;
		if (key === "moj") {
			const pbf = await loadMoj(code, { onStatus: say });
			feats = pbf?.geojson?.features?.map(f => ({ ...f, properties: { ...f.properties, _src: "moj" } })) ?? null;
		} else if (key === "maff") {
			const pbf = await loadMaff(code, { onStatus: say });
			feats = pbf?.geojson?.features?.map(f => ({ ...f, properties: { ...f.properties, _src: "maff" } })) ?? null;
		} else if (key === "a33") {
			feats = await loadA33Pref(code);   // browser-native オンデマンド（県別 KSJ 直読み）
		} else if (key === "a31") {
			feats = await loadA31Meshes(code);   // browser-native オンデマンド（1次メッシュ別 KSJ 直読み・原典メッシュ忠実）
		}
		if (feats) fcCache.set(ck, feats);
		return feats;
	}
	// 筆層のホバーtip＝筆の情報（moj=大字・地番／maff=田畑）。点灯中は町丁目tipと排他（エンジン側で tip 持参層が主導）。
	// ホバーの見た目は従来の線ハイライトのまま（本人裁定2026-08-18「ホバーは線太化でいい」）。
	const FUDE_TIP = p => {
		const src = p._src || soloSrc || "moj";
		if (src === "moj") return [`${p["大字名"] || p.oaza || ""} ${p["地番"] || p.chiban || ""}`.trim() || "筆", "登記所備付地図（14条）"];
		if (src === "maff") return [+p.land_type === 100 ? "田" : +p.land_type === 200 ? "畑" : "農地", "筆ポリゴン（農林水産省）"];
		return null;   // ハザード面＝tipなし（凡例とクリックカードで読む）
	};
	async function rebuildStack() {
		const mySeq = ++seq;
		const code = city;
		const keys = GINT_LAYERS.map(l => l.key).filter(k => on.has(k));
		if (!code || !keys.length) {   // 全消灯＝スタック解除 → admin コロプレスへ返す
			if (stackApplied) { stackApplied = false; draped = false; map.standupGint(null); onStackCleared?.(); }
			say("");
			return;
		}
		let pbf = null;
		const sig = keys.slice().sort().join("+");
		if (keys.length === 1 && (keys[0] === "moj" || keys[0] === "maff")) {
			pbf = keys[0] === "moj" ? await loadMoj(code, { onStatus: say }) : await loadMaff(code, { onStatus: say });   // 単一筆＝直載せの高速路（再焼きゼロ・moj.js/maff.js が IDB 持ち）
		} else {
			// a33/a31 を含む合成は IDB に焼かない：原典KSJは geopbf の URL キャッシュ（県/メッシュ単位）が正典で、
			// 合成物を市ごとに焼くと肥大＋原典との二重管理。原典（URLキャッシュ命中で速い）から都度 境界クリップ再合成する。
			// ＝残る stack キャッシュは非a33/非a31（筆のみ 等）＝内容は production と不変 → 版は v2 据置（IDBを一切変えない）。
			const useStackCache = !keys.includes("a33") && !keys.includes("a31");
			const stackKey = `stack://v2/${code}/${sig}`;
			const cache = await getCache();
			const val = useStackCache ? await cache(stackKey).catch(() => null) : null;
			if (val?.PBF) {   // 2回目＝合成済みを IDB から復元（焼きゼロ）
				pbf = await geopbf(val.PBF, { gint: false, name: stackKey });
				if (val.GINT) await pbf.setGintBUF(val.GINT).catch(() => null);
				if (!pbf?.unPackGint) pbf = null;
			}
			if (!pbf) {
				const parts = await Promise.all(keys.map(k => sourceFC(code, k)));
				if (mySeq !== seq) return;   // 合成中にトグルが変わった＝この結果は捨てる
				const features = parts.flatMap(p => p || []);
				if (!features.length) { say("データが空でした"); return; }
				say(`重ね焼き中…（${features.length.toLocaleString()}地物）`);
				pbf = await geopbf({ type: "FeatureCollection", features }, { gint: true, name: stackKey });
				if (useStackCache && pbf?.unPackGint) {
					const GINT = new Uint8Array(pbf._gintBuffer).slice().buffer;
					cache(stackKey, { PBF: pbf.arrayBuffer, GINT }).catch(() => {});
				}
			}
		}
		if (mySeq !== seq) return;
		if (!pbf?.unPackGint) { say("読み込みに失敗しました"); return; }
		// 持参スタイル＝線は気配に落とす（既定オレンジ1pxは小ポリゴンの塗りを覆い隠す＝admin_fill と同じ轍）。
		// 筆のみ（moj/maff）の高速路は例外＝筆は線が主役なので既定のまま。style1 の rgb はドレープ線色にも使われる
		//（standupGint 参照）＝防災の見せ場に合う暖色を残す。
		const hazard = keys.includes("a33") || keys.includes("a31");
		soloSrc = keys.length === 1 ? keys[0] : null;
		map.applyGintData(pbf, `census2020/${code}/${sig}`, false, { minZoom: 10, style: (sig === "moj" || sig === "maff") ? null : STACK_STYLE, drapeFill: (stackDrapeFill = hazard), hover: !hazard, tip: hazard ? null : FUDE_TIP });   // 防災の面=チルトで斜面ドレープ＋ホバー処理オフ（クリック属性カードは生存）。筆のみ＝筆tip持参（町丁目tipと排他）
		stackApplied = true; draped = false;
		onStackApplied?.();
		buildStackTable(pbf, soloSrc);
		legend?.(hazardLegend(keys));   // 防災層の凡例（浸水深ランク/警戒区分）。解除で bind が choro.refreshLegend 復元
		say("");
		watchPitch();   // 現姿勢がチルトなら即ドレープ
	}
	// fid スタイル表＝_src とランクで塗り分け（トグルの見た目はこの表の再計算だけで変わる）
	// solo＝単独点灯の層 key（筆の高速路は feature に _src が無い＝層 key で決め打ち）／null＝合成＝_src で判定
	function buildStackTable(pbf, solo) {
		const n = pbf.fmap?.length ?? 0;
		if (!n) return;
		const u32 = new Uint32Array(n * 4);
		const lineMoj = packRGBA("#ff8c26", 0.9);   // 14条筆の系統色（塗りなし・線だけ）
		for (let i = 0; i < n; i++) {
			let p = {};
			try { p = pbf.getProperties(i) ?? {}; } catch { /* 壊れ feature */ }
			const src = solo ?? p._src;
			let fill = 0, line = 0, w8 = 8;
			if (src === "moj") { line = lineMoj; }
			else if (src === "maff") {
				const c = MAFF_LINE[+p.land_type] ?? MAFF_LINE[200];   // 田/畑の二色
				line = packRGBA(c, 0.9);
				fill = packRGBA(c, MAFF_FILL_ALPHA);   // 同色相の淡塗り（moj は線のみのまま）
			}
			else if (src === "a33") {
				const sp = +p.kbn === 2;   // 2=特別警戒（レッド）/ 1=警戒（イエロー）。GeoPBFはINTEGER復元
				fill = packRGBA(sp ? "#c0392b" : "#d9a441", sp ? 0.5 : 0.42);   // 面のみ＝土砂は塗りが主役・斜面にドレープ（本人裁定 2026-08-13）
				line = 0;   // 線を捨てる（本人裁定：土砂は線でなく面でのみ見せる）
			} else if (src === "a31") {
				const r = Math.max(1, Math.min(6, +p.rank || 1));
				fill = packRGBA(A31_COLORS[r - 1], 0.5);
			}
			u32[i * 4] = fill; u32[i * 4 + 1] = line;
			u32[i * 4 + 2] = ((w8 << 24) | (6 << 8) | 1) >>> 0;
		}
		map.paintTable(u32, n);
	}
	// pitch-watcher：真俯瞰=2D塗り ⇄ チルト=地形ドレープ線（standupGint は重い＝跨ぎ時だけ・再入ガード）
	async function watchPitch() {
		if (!stackApplied || drapePending) return;
		if (stackDrapeFill) return;   // 面ドレープ層＝塗りが gv=true で斜面に乗る＝standupGint(線ドレープ)は使わない
		const p = map.cam.pitch || 0;
		if (!draped && p > PITCH_UP) {
			drapePending = true; draped = true;
			await map.standupGint(DRAPE_LIFT_M).catch(() => { draped = false; });
			drapePending = false;
		} else if (draped && p < PITCH_DOWN) {
			drapePending = true; draped = false;
			await map.standupGint(null).catch(() => {});
			drapePending = false;
		}
	}
	map.onFrame(() => { if (stackApplied) watchPitch(); });

	// --- 避難場所マーカー層（DOM・gint と独立） ---
	const layerEl = document.createElement("div");
	layerEl.className = "c20-hinan-layer";
	layerEl.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
	map.mapEl.appendChild(layerEl);
	const card = document.createElement("div");
	card.className = "c20-hinan-card";
	card.style.display = "none";
	map.mapEl.appendChild(card);
	const htip = document.createElement("div");   // ホバー tip（名称・住所・対応災害＝クリック前に読める・本人要望2026-08-14）
	htip.className = "c20-hinan-tip";
	htip.style.display = "none";
	map.mapEl.appendChild(htip);
	let markers = [];   // { el, lon, lat, row }
	function clearMarkers() { layerEl.textContent = ""; markers = []; card.style.display = "none"; htip.style.display = "none"; }
	function showTip(row) {
		const [lon, lat, name, addr, flags] = row;
		const [x, y, f] = map.projectLL(lon, lat);
		if (f < 0) return;
		const badges = HINAN_FLAGS.filter((_, i) => flags & (1 << i)).join("・");
		htip.innerHTML = `<div style="font-weight:600">${escHtml(name)}</div>
			${addr ? `<div style="color:#9ab;font-size:10.5px">${escHtml(addr)}</div>` : ""}
			${badges ? `<div style="color:#8fd39a;font-size:10.5px;margin-top:2px">${escHtml(badges)}</div>` : ""}`;
		htip.style.left = `${Math.round(x + 12)}px`; htip.style.top = `${Math.round(y - 8)}px`;
		htip.style.display = "block";
	}
	async function loadHinan(code) {
		const mySeq = ++seq;
		say("避難場所を取得中…");
		let rows = null;
		try {
			const res = await fetch(`${API}/bucket/bousai/hinan/${code.slice(0, 2)}.json`);
			if (res.ok) rows = JSON.parse(new TextDecoder().decode(await gunzipBuf(await res.arrayBuffer())));
		} catch { /* 未整備 or 回線 */ }
		if (mySeq !== seq || city !== code) return;
		say("");
		if (!rows?.length) { say("避難場所データ未整備"); hinanOn = false; syncChips(); return; }
		const b = bboxForCode?.(code);   // 市区町村 bbox で絞る（県ファイル＝隣接市の点を混ぜない）
		const inCity = b ? rows.filter(r => r[0] >= b[0] && r[0] <= b[2] && r[1] >= b[1] && r[1] <= b[3]) : rows;
		clearMarkers();
		for (const row of inCity.slice(0, HINAN_MAX)) {
			const el = document.createElement("button");
			el.className = "c20-hinan"; el.type = "button";   // title 属性は廃止＝自前 tip と二重になる
			el.addEventListener("click", ev => { ev.stopPropagation(); showCard(row); });
			el.addEventListener("mouseenter", () => showTip(row));
			el.addEventListener("mouseleave", () => { htip.style.display = "none"; });
			layerEl.appendChild(el);
			markers.push({ el, lon: row[0], lat: row[1], row });
		}
		if (inCity.length > HINAN_MAX) console.warn("[hinan] %d件を上限%dに切詰め", inCity.length, HINAN_MAX);
	}
	async function showCard(row) {
		const [lon, lat, name, addr, flags] = row;
		const [x, y, f] = map.projectLL(lon, lat);
		if (f < 0) return;
		const badges = HINAN_FLAGS.filter((_, i) => flags & (1 << i))
			.map(t => `<span style="border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:0 4px;margin-right:3px">${t}</span>`).join("");
		card.innerHTML = `<button class="c20-card-x" type="button" aria-label="閉じる">×</button>
			<div style="font-weight:600">${escHtml(name)}</div>
			<div style="color:#9ab;font-size:11px">${escHtml(addr || "")}</div>
			<div style="font-size:10.5px;margin-top:4px">${badges || "<span style='color:#89a'>対応災害情報なし</span>"}</div>
			<div class="c20-card-elev" style="font-size:11px;color:#8ab4f8;margin-top:4px">標高 …</div>`;
		card.style.left = `${Math.round(x + 10)}px`; card.style.top = `${Math.round(y - 10)}px`;
		card.style.display = "block";
		card.querySelector(".c20-card-x").addEventListener("click", () => { card.style.display = "none"; });
		const h = await map.getHeight(lon, lat);   // 標高＝垂直避難か水平避難かの読みどころ
		const el = card.querySelector(".c20-card-elev");
		if (el?.isConnected) el.textContent = `標高 約${Math.round(h)}m`;
	}
	map.onFrame(() => {   // マーカー追随（cpos/pop と同じ投影ブリッジ作法）
		if (!markers.length) return;
		for (const m of markers) {
			const [x, y, f] = map.projectLL(m.lon, m.lat);
			if (f < 0 || x < -20 || y < -20 || x > map.mapEl.clientWidth + 20 || y > map.mapEl.clientHeight + 20) { m.el.style.display = "none"; continue; }
			m.el.style.display = "block";
			m.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
		}
	});

	// --- トグル・出入り ---
	function toggle(key) {
		if (key === "hinan") {
			hinanOn = !hinanOn;
			if (hinanOn) loadHinan(city); else { clearMarkers(); say(""); }
		} else {
			on.has(key) ? on.delete(key) : on.add(key);
			rebuildStack();
		}
		syncChips();
	}
	function enterCity(code) {
		if (city !== code) {   // 都市替え＝前の都市の点灯を引き継がない（データが別物）
			city = code;
			on.clear(); hinanOn = false; clearMarkers();
			if (stackApplied) { stackApplied = false; draped = false; map.standupGint(null); onStackCleared?.(); }
		}
		wrap.style.display = "inline-flex";
		syncChips();
		probeAvailability(code);
	}
	function leaveCity() {
		city = null; seq++;
		on.clear(); hinanOn = false; clearMarkers(); say("");
		wrap.style.display = "none";
		if (stackApplied) { stackApplied = false; draped = false; map.standupGint(null); onStackCleared?.(); }
	}
	// スタック地物クリック（bind 経由）＝種別に応じた属性カード
	function onFeatureClick(fid, props, lnglat) {
		if (!props) return;
		const src = props._src || soloSrc || "moj";   // 筆の高速路（moj/maff 単独）は _src 無し＝点灯中の層 key で判定
		// click 応答に経緯度が無い個体がある（renderworker の返り実測）＝その時は画面中央へ置く
		let x = map.mapEl.clientWidth / 2, y = map.mapEl.clientHeight / 2;
		if (lnglat && Number.isFinite(+lnglat[0])) {
			const p = map.projectLL(+lnglat[0], +lnglat[1]);
			if (p[2] < 0) return;
			[x, y] = p;
		}
		let html = "";
		if (src === "a31") html = `<div style="font-weight:600">洪水浸水想定区域</div><div>浸水深ランク ${escHtml(String(props.rank ?? "—"))}${props.depth ? `（${escHtml(props.depth)}）` : ""}</div>`;
		else if (src === "a33") html = `<div style="font-weight:600">土砂災害${+props.kbn === 2 ? "特別警戒" : "警戒"}区域</div><div>${escHtml(props.gensho || "")}${props.name ? `：${escHtml(props.name)}` : ""}</div><div style="color:#9ab;font-size:11px">${escHtml(props.addr || "")}</div>`;
		else if (src === "maff") html = `<div style="font-weight:600">筆ポリゴン（農地）</div><div>${+props.land_type === 100 ? "田" : +props.land_type === 200 ? "畑" : "農地"}</div><div style="color:#9ab;font-size:11px">${Number.isFinite(+props.edit_year) ? `更新 ${escHtml(String(props.edit_year))}年度・` : ""}農林水産省</div>`;
		else html = `<div style="font-weight:600">筆（登記所備付地図）</div><div>${escHtml(props["大字名"] || props.oaza || "")} ${escHtml(props["地番"] || props.chiban || "")}</div>`;
		card.innerHTML = `<button class="c20-card-x" type="button" aria-label="閉じる">×</button>${html}`;
		card.style.left = `${Math.round(x + 10)}px`; card.style.top = `${Math.round(y - 10)}px`;
		card.style.display = "block";
		card.querySelector(".c20-card-x").addEventListener("click", () => { card.style.display = "none"; });
	}
	// 曝露突合（浸水域内人口 等）の継ぎ目＝将来 worker/bake で実装。v1 は常に null（UI 非表示）
	async function exposure(_cityCode) { return null; }

	return { enterCity, leaveCity, onFeatureClick, exposure, isActive: () => stackApplied || hinanOn, layersEl: wrap };   // layersEl＝bind がドリル毎に wiki 直下へ再親付け（detach 後は getElementById で見つからない＝参照渡しが正）
}
