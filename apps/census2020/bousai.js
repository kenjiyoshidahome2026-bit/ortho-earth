// 防災×3D＝census2020 の一級市民。市区町村レベルのトグル4種:
//   筆(14条) / 土砂警戒(A33) / 洪水浸水(A31) … gint スタック（単一スロットに合成して載せる）
//   避難場所（指定緊急避難場所） … DOMマーカー層（gint と独立・標高付き属性カード）
// gint スタックの作法（gint draw spec の restyle 哲学）:
//   ・データセット集合が変わった時だけ FC 合成→gint 焼き（IDB cache: stack://{code}/{sig}＝2回目爆速）
//   ・トグルの見た目切替は fid スタイル表の再計算のみ（ジオメトリ再構築ゼロ）…単一ソース時は直載せの高速路
// 3Dの絵作り: 真俯瞰=ランク色の2D塗り（ハザードマップ見せ切り）⇄ チルト=pitch-watcher が standupGint(2)
//   ＝実スケール地形のドレープ境界線＋PLATEAU 突き刺し（エンジン既存ゲートの転用・改造なし）。
import { geopbf } from "geopbf";
import { nativeBucket } from "native-bucket";
import { loadMoj, mojSource, probeBucket } from "./moj.js";
import { escHtml } from "./ui/shared.js";

const API = "https://api.ortho-earth.com";
const DRAPE_LIFT_M = 2;
const PITCH_UP = 0.025, PITCH_DOWN = 0.015;   // 真俯瞰⇄チルトのヒステリシス（rad）
const HINAN_MAX = 1500;                        // 市区町村 bbox 内マーカー上限（DOM 予算）
const HINAN_FLAGS = ["洪水", "土砂", "高潮", "地震", "津波", "大火", "内水", "火山"];   // bake の flags ビット順

const A31_COLORS = ["#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c"];   // 浸水深ランク1..6
// スタック層の持参スタイル（style0=塗り未使用・style1=線）。線は淡く＝ランク塗りが主役。
// rgb はドレープ線色（standupGint が styleTable[4..6] を読む）＝チルトの見せ場用に暖色。
const STACK_STYLE = (() => {
	const t = new Float32Array(256 * 4);
	t.set([0, 0, 0, 0], 0);
	t.set([1.0, 0.55, 0.15, 0.22], 4);
	return { styleTable: t, lineWidth: 0.6 };
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
const GINT_LAYERS = [
	{ key: "moj", label: "筆(14条)" },
	{ key: "a33", label: "土砂警戒" },
	{ key: "a31", label: "洪水浸水" },
];

export function initBousai(map, { bboxForCode, onStackApplied, onStackCleared } = {}) {
	let city = null;
	const on = new Set();              // 点灯中の gint レイヤ key
	let hinanOn = false;
	let stackApplied = false;          // gint スロットをスタックが占有中か
	let draped = false, drapePending = false, stackDrapeFill = false;
	let seq = 0;                       // 再入ガード（連打・都市切替中の非同期競合）
	const fcCache = new Map();         // `${city}/${key}` → Feature[]（セッション内メモ）

	// --- トグルUI（#panel-head・市区町村ドリル中のみ表示） ---
	const head = document.getElementById("panel-head");
	const wrap = document.createElement("span");
	wrap.id = "c20-layers";
	wrap.style.cssText = "display:none;gap:6px;align-items:center;flex-wrap:wrap;border-left:1px solid rgba(255,255,255,.14);padding-left:8px;margin-left:2px";
	head.appendChild(wrap);
	const sta = document.createElement("span");
	sta.style.cssText = "font-size:11px;color:#89a";
	const chips = new Map();
	for (const def of [...GINT_LAYERS, { key: "hinan", label: "避難場所" }]) {
		const b = document.createElement("button");
		b.className = "c20-chip"; b.type = "button"; b.textContent = def.label; b.disabled = true;
		b.addEventListener("click", () => toggle(def.key));
		wrap.appendChild(b); chips.set(def.key, b);
	}
	wrap.appendChild(sta);
	const say = t => { sta.textContent = t || ""; };
	const syncChips = () => {
		chips.forEach((b, k) => b.setAttribute("aria-pressed", String(k === "hinan" ? hinanOn : on.has(k))));
	};

	// --- 在庫 probe（市区町村ごと・並列）。無い層は非活性＝「未整備」を正直に見せる ---
	async function probeAvailability(code) {
		const mySeq = ++seq;
		chips.forEach(b => { b.disabled = true; b.title = "確認中…"; });
		const probes = {   // GET+即中断（bucket Worker は HEAD 405＝moj.js probeBucket の轍）
			moj: mojSource(code).then(s => !!s),
			a33: probeBucket(`${API}/bucket/bousai/a33/${code}.geopbf`),
			a31: probeBucket(`${API}/bucket/bousai/a31/${code}.geopbf`),
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
	// ハザード層(a31/a33)は**サーバーで既にランク/区分マージ済み**の GeoPBF を直読み（裁定 2026-08-12
	// 「サーバーは最小限のデータ・通信も最小」）＝クライアントのパース/マージ消滅・ワイヤ8-10倍削減。
	// マージで fid が1桁＝WebGPU idfill の fid≤2047 上限にも収まる（A31世田谷 6849→5地物）。
	// gint は載せず受信後にWASMで焼く（スタック再マージで無駄になるため）。native-bucket が gzip 自動＝手動gunzip。
	async function loadBousaiGeoPBF(code, key) {
		const res = await fetch(`${API}/bucket/bousai/${key}/${code}.geopbf`);
		if (!res.ok) return null;
		const raw = await gunzipBuf(await res.arrayBuffer());
		const pbf = await geopbf(raw, { gint: false, name: `bousai/${key}/${code}` });
		return pbf?.geojson?.features ?? null;   // _src/rank/kbn は bake で埋め込み済み（rank/kbn=INTEGER で復元）
	}
	async function sourceFC(code, key) {
		const ck = `${code}/${key}`;
		if (fcCache.has(ck)) return fcCache.get(ck);
		let feats = null;
		if (key === "moj") {
			const pbf = await loadMoj(code, { onStatus: say });
			feats = pbf?.geojson?.features?.map(f => ({ ...f, properties: { ...f.properties, _src: "moj" } })) ?? null;
		} else {
			feats = await loadBousaiGeoPBF(code, key);
		}
		if (feats) fcCache.set(ck, feats);
		return feats;
	}
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
		if (keys.length === 1 && keys[0] === "moj") {
			pbf = await loadMoj(code, { onStatus: say });   // 単一筆＝直載せの高速路（再焼きゼロ・moj.js が IDB 持ち）
		} else {
			const stackKey = `stack://v2/${code}/${sig}`;   // v2＝ハザードのランク/区分マージ後（旧・個別fid版と縁切り）
			const cache = await getCache();
			const val = await cache(stackKey).catch(() => null);
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
				say(`重ね焼き中…（${features.length.toLocaleString()}地物・この組合せの初回のみ）`);
				pbf = await geopbf({ type: "FeatureCollection", features }, { gint: true, name: stackKey });
				if (pbf?.unPackGint) {
					const GINT = new Uint8Array(pbf._gintBuffer).slice().buffer;
					cache(stackKey, { PBF: pbf.arrayBuffer, GINT }).catch(() => {});
				}
			}
		}
		if (mySeq !== seq) return;
		if (!pbf?.unPackGint) { say("読み込みに失敗しました"); return; }
		// 持参スタイル＝線は気配に落とす（既定オレンジ1pxは小ポリゴンの塗りを覆い隠す＝admin_fill と同じ轍）。
		// 筆のみの高速路は例外＝筆は線が主役なので既定のまま。style1 の rgb はドレープ線色にも使われる
		//（standupGint 参照）＝防災の見せ場に合う暖色を残す。
		map.applyGintData(pbf, `census2020/${code}/${sig}`, false, { minZoom: 10, style: sig === "moj" ? null : STACK_STYLE, drapeFill: (stackDrapeFill = keys.includes("a33") || keys.includes("a31")), hover: !stackDrapeFill });   // 防災の面=チルトで斜面ドレープ＋ホバー処理オフ（クリック属性カードは生存）
		stackApplied = true; draped = false;
		onStackApplied?.();
		buildStackTable(pbf, keys.length === 1 && keys[0] === "moj");
		say("");
		watchPitch();   // 現姿勢がチルトなら即ドレープ
	}
	// fid スタイル表＝_src とランクで塗り分け（トグルの見た目はこの表の再計算だけで変わる）
	function buildStackTable(pbf, mojOnly) {
		const n = pbf.fmap?.length ?? 0;
		if (!n) return;
		const u32 = new Uint32Array(n * 4);
		const lineMoj = packRGBA("#ff8c26", 0.9);   // 14条筆の系統色（塗りなし・線だけ）
		for (let i = 0; i < n; i++) {
			let p = {};
			try { p = pbf.getProperties(i) ?? {}; } catch { /* 壊れ feature */ }
			const src = mojOnly ? "moj" : p._src;
			let fill = 0, line = 0, w8 = 8;
			if (src === "moj") { line = lineMoj; }
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
	let markers = [];   // { el, lon, lat, row }
	function clearMarkers() { layerEl.textContent = ""; markers = []; card.style.display = "none"; }
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
			el.className = "c20-hinan"; el.type = "button"; el.title = row[2];
			el.addEventListener("click", ev => { ev.stopPropagation(); showCard(row); });
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
		const src = props._src || "moj";
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
		else html = `<div style="font-weight:600">筆（登記所備付地図）</div><div>${escHtml(props["大字名"] || props.oaza || "")} ${escHtml(props["地番"] || props.chiban || "")}</div>`;
		card.innerHTML = `<button class="c20-card-x" type="button" aria-label="閉じる">×</button>${html}`;
		card.style.left = `${Math.round(x + 10)}px`; card.style.top = `${Math.round(y - 10)}px`;
		card.style.display = "block";
		card.querySelector(".c20-card-x").addEventListener("click", () => { card.style.display = "none"; });
	}
	// 曝露突合（浸水域内人口 等）の継ぎ目＝将来 worker/bake で実装。v1 は常に null（UI 非表示）
	async function exposure(_cityCode) { return null; }

	return { enterCity, leaveCity, onFeatureClick, exposure, isActive: () => stackApplied || hinanOn };
}
