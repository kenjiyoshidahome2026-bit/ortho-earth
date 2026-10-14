// 鳥獣の捕獲記録（捕獲報告アプリの書き出し 2024-12〜・約 1.6 万件）を日本の 3D 地図（ortho-japan）に（choju.html から遅延 import）。
// onsen.js と同じ骨格＝CSV 2 本を、エンジンの MapLibre 互換の口（addSource／addLayer／setFilter）で描く。
//
// データ（GitHub Pages の ortho-data/japan/choju/・dev は手元の正本 ortho-data/japan/choju/）
//   captures.csv … 1 行 1 頭：hkk_tm（捕獲日時・日本時間）・市区町村コード・緯度・経度・座標の出所・獣種・利用区分・
//                  estimate_length（体長 cm）・estimate_weight（体重 kg）・receipt_no・hkk_user_id
//   munis.csv    … 捕獲のあった市区町村：市区町村コード・都道府県・市区町村名（＋獣種別・年度別の件数）
//
// 表現の決め事
//   色   … 獣種で色分け（イノシシ・シカが大半＝この 2 つを強い色に）
//   大分類 … 利用区分をジビエ（施設搬入・食肉利用・ジビエ用アプリ）／捕獲のみ（廃棄）／不明に束ねる。色分けを獣種⇄大分類で切り替えられる
//   絞り … 獣種・利用区分・捕獲日（から／まで）・市区町村（セレクタ＝選ぶとそこへ飛ぶ・内訳を出す）。?m=市区町村コード で共有できる
//   案内 … ホバーの札と詳細に受付番号・捕獲者 ID（CSV にあれば）
//   座標 … 捕獲地点の無い記録は送信位置・補完住所の座標（座標の出所）＝点を白抜きにする
//   UI は日本語のみ（日本の自治体の捕獲記録）

const SP = ["イノシシ", "シカ", "サル", "タヌキ", "アナグマ", "ハクビシン", "アライグマ", "ヌートリア", "鳥類", "その他"];
const SP_COLORS = ["#b4532a", "#2f6b55", "#7a5aa6", "#8a7a3a", "#3f7fb0", "#c0457a", "#d08a1a", "#5a8a2a", "#4a4f57", "#9a9a9a"];
const CLS = ["ジビエ（施設搬入）", "食肉利用（自家消費など）", "廃棄（埋設・焼却）", "ジビエ用アプリで登録", "不明（処分方法が未記入）"];
const SRC = ["捕獲地点", "送信位置", "補完住所"];
// 大分類＝利用区分を「ジビエ（食肉として利用）」と「捕獲のみ（被害対策で捕って廃棄）」に束ねる。処分方法の無い記録は「不明」
export const GROUPS = [
	{ name: "ジビエ（食肉利用）", ks: [0, 1, 3], color: "#c0702a" },
	{ name: "捕獲のみ（廃棄）", ks: [2], color: "#3f6fa8" },
	{ name: "不明", ks: [4], color: "#9aa3ad" },
];
export const groupOf = k => GROUPS.findIndex(g => g.ks.includes(k));
const SEL = "#d7263d";

// RFC 4180 の CSV（BOM・引用・引用内の改行）を行のオブジェクトへ
export function parseCSV(text) {
	text = text.replace(/^\uFEFF/, "");
	const rows = []; let row = [], cell = "", q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
		if (c === '"') q = true;
		else if (c === ",") { row.push(cell); cell = ""; }
		else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
		else cell += c;
	}
	if (cell || row.length) { row.push(cell); rows.push(row); }
	const [head = [], ...body] = rows.filter(r => r.length > 1 || r[0]);
	return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// CSV の行 → 地図の点（読めない行は落とす）
export function toRecords(caps, munis) {
	const name = new Map(munis.map(r => [r["市区町村コード"], { pref: r["都道府県"] || "", name: r["市区町村名"] || "" }]));
	const out = [];
	for (const r of caps) {
		const s = SP.indexOf(r["獣種"]), k = CLS.indexOf(r["利用区分"]), lon = +r["経度"], lat = +r["緯度"];
		const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d:\d\d)/.exec(r["hkk_tm"] || "");
		if (s < 0 || k < 0 || !m || !Number.isFinite(lon) || !Number.isFinite(lat) || !lon || !lat) continue;
		const code = r["市区町村コード"];
		out.push({ i: out.length, s, k, lon, lat, d: +(m[1] + m[2] + m[3]), tm: `${m[1]}/${m[2]}/${m[3]} ${m[4]}`, code,
			muni: name.get(code)?.name || code, o: Math.max(0, SRC.indexOf(r["座標の出所"])),
			len: r["estimate_length"] === "" ? null : +r["estimate_length"], wt: r["estimate_weight"] === "" ? null : +r["estimate_weight"],
			rno: r["receipt_no"] || "", uid: r["hkk_user_id"] || "" });
	}
	return out;
}

const fetchText = url => fetch(url, { credentials: "omit" }).then(r => { if (!r.ok) throw new Error(`${url} HTTP ${r.status}`); return r.text(); });
const bboxOf = pts => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
const ymd = n => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;
const fmt = v => (+v).toLocaleString("ja");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountChoju(map, { base = "./" } = {}) {
	document.title = "鳥獣の捕獲記録";
	const mapEl = map.mapEl;
	const [capText, muniText] = await Promise.all([fetchText(base + "captures.csv"), fetchText(base + "munis.csv")]);
	const muniRows = parseCSV(muniText), recs = toRecords(parseCSV(capText), muniRows);
	const munis = muniRows.map(r => ({ code: r["市区町村コード"], pref: r["都道府県"], name: r["市区町村名"] }))
		.filter(m => recs.some(d => d.code === m.code)).sort((a, b) => a.code.localeCompare(b.code));
	const muniOf = new Map(munis.map(m => [m.code, m]));
	const dMin = recs.reduce((a, d) => Math.min(a, d.d), 99999999), dMax = recs.reduce((a, d) => Math.max(a, d.d), 0);

	// ── 層 ──
	const feats = recs.map(d => ({ type: "Feature", geometry: { type: "Point", coordinates: [d.lon, d.lat] }, properties: { i: d.i, s: d.s, k: d.k, g: groupOf(d.k), d: d.d, m: d.code, o: d.o } }));
	map.addSource("cj-pts", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
	const COLORS = { sp: ["match", ["get", "s"], ...SP_COLORS.flatMap((c, i) => [i, c]), "#9a9a9a"], g: ["match", ["get", "g"], ...GROUPS.flatMap((g, i) => [i, g.color]), "#9a9a9a"] };
	const color = COLORS.sp;
	const radius = ["interpolate", ["linear"], ["zoom"], 4, 2.2, 8, 3.6, 12, 6];
	const LAYERS = {
		"cj-pt": { type: "circle", source: "cj-pts", filter: ["==", ["get", "o"], 0], paint: { "circle-radius": radius, "circle-color": color, "circle-opacity": 0.8, "circle-stroke-color": "#fff", "circle-stroke-width": 0.8 } },
		"cj-est": { type: "circle", source: "cj-pts", filter: [">", ["get", "o"], 0], paint: { "circle-radius": radius, "circle-color": "rgba(255,255,255,.85)", "circle-stroke-color": color, "circle-stroke-width": 1.4, "circle-opacity": 0.8 } },
		"cj-sel": { type: "circle", source: "cj-pts", filter: ["==", ["get", "i"], -1], paint: { "circle-radius": ["+", 4, radius], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": SEL, "circle-stroke-width": 2.4 } },
	};
	for (const [id, L] of Object.entries(LAYERS)) await map.addLayer({ id, ...L });

	// 絞り込みの状態
	const st = { sp: new Set(SP.keys()), cls: new Set(CLS.keys()), d0: dMin, d1: dMax, muni: "" };
	const shown = d => st.sp.has(d.s) && st.cls.has(d.k) && d.d >= st.d0 && d.d <= st.d1 && (!st.muni || d.code === st.muni);
	const filterExpr = () => ["all",
		["match", ["get", "s"], st.sp.size ? [...st.sp] : [-1], true, false],
		["match", ["get", "k"], st.cls.size ? [...st.cls] : [-1], true, false],
		[">=", ["get", "d"], st.d0], ["<=", ["get", "d"], st.d1],
		...(st.muni ? [["==", ["get", "m"], st.muni]] : [])];
	function apply() {
		const f = filterExpr();
		map.setFilter("cj-pt", ["all", LAYERS["cj-pt"].filter, f]); map.setFilter("cj-est", ["all", LAYERS["cj-est"].filter, f]);
		renderCounts();
	}

	// ── 選択 ──
	let sel = null;
	function select(i) {
		sel = i == null ? null : recs[i];
		map.setFilter("cj-sel", ["==", ["get", "i"], sel ? sel.i : -1]);
		renderDetail();
	}

	// ── 地図の操作（ホバー＝獣種と日付・クリック＝詳細）──
	const tip = map.gadget.tip();
	const HIT = ["cj-pt", "cj-est"];
	const top = e => (e.features || []).find(f => f.properties?.i != null);
	map.on("mousemove", HIT, e => { const f = top(e), d = f && recs[f.properties.i]; tip(d ? [`<b>${esc(SP[d.s])}</b>　${esc(d.tm)}`, esc(`${muniOf.get(d.code)?.pref || ""}${d.muni}`), esc(`${GROUPS[groupOf(d.k)].name}・${CLS[d.k]}`),
		...(d.rno ? [`受付番号 ${esc(d.rno)}`] : []), ...(d.uid ? [`捕獲者 ID ${esc(d.uid)}`] : [])] : null); });
	map.on("mouseleave", HIT, () => tip(null));
	map.on("click", HIT, e => { const f = top(e); if (f) select(f.properties.i); });

	// ── 案内板（右上）──
	const prefs = [...new Set(munis.map(m => m.pref))];
	const panel = document.createElement("div");
	panel.className = "cj-panel";
	panel.innerHTML = `<style>${CSS}</style>
		<div class="head"><h1>鳥獣の捕獲記録</h1><button class="fold" type="button" aria-label="畳む">–</button></div>
		<div class="body">
			<p class="span">${esc(ymd(dMin).replaceAll("-", "/"))} 〜 ${esc(ymd(dMax).replaceAll("-", "/"))}・${fmt(munis.length)} 市区町村</p>
			<label class="msel"><span>市区町村</span><select class="muni"><option value="">すべての市区町村</option>${prefs.map(p => `<optgroup label="${esc(p)}">${munis.filter(m => m.pref === p).map(m => `<option value="${m.code}">${esc(m.name.replace(p, "") || m.name)}（${fmt(recs.filter(d => d.code === m.code).length)}）</option>`).join("")}</optgroup>`).join("")}</select></label>
			<p class="total"><b></b> 件を表示中</p>
			<div class="detail" hidden></div>
			<label class="msel"><span>色分け</span><select class="cmode"><option value="sp">獣種</option><option value="g">大分類（ジビエ／捕獲のみ）</option></select></label>
			<h2>獣種</h2>
			${SP.map((s, i) => `<label class="grp"><input type="checkbox" data-s="${i}" checked><span class="sw" style="background:${SP_COLORS[i]}"></span>${esc(s)}<small data-ns="${i}"></small></label>`).join("")}
			<div class="all"><button type="button" data-all="1">すべて</button><button type="button" data-all="0">なし</button></div>
			<h2>大分類・利用区分</h2>
			${GROUPS.map((g, gi) => `<label class="grp top"><input type="checkbox" data-g="${gi}" checked><span class="sw" style="background:${g.color}"></span><b>${esc(g.name)}</b><small data-ng="${gi}"></small></label>
				${g.ks.length > 1 ? g.ks.map(i => `<label class="grp sub"><input type="checkbox" data-k="${i}" checked>${esc(CLS[i])}<small data-nk="${i}"></small></label>`).join("") : `<input type="checkbox" data-k="${g.ks[0]}" checked hidden><small data-nk="${g.ks[0]}" hidden></small>`}`).join("")}
			<h2>捕獲日</h2>
			<div class="dates"><label>から<input type="date" class="d0" value="${ymd(dMin)}" min="${ymd(dMin)}" max="${ymd(dMax)}"></label><label>まで<input type="date" class="d1" value="${ymd(dMax)}" min="${ymd(dMin)}" max="${ymd(dMax)}"></label></div>
			<div class="all"><button type="button" data-fy="">全期間</button>${[...new Set(recs.map(d => Math.floor(d.d / 10000) - (d.d % 10000 < 401 ? 1 : 0)))].sort().map(y => `<button type="button" data-fy="${y}">${y}年度</button>`).join("")}</div>
			<p class="note">白抜きの点は捕獲地点の座標が無く、送信位置か住所の座標で置いた記録です。獣種と利用区分は書き出しのコードからの推定です。</p>
		</div>`;
	mapEl.appendChild(panel);
	const $ = s => panel.querySelector(s);
	$(".fold").onclick = () => { panel.classList.toggle("min"); $(".fold").textContent = panel.classList.contains("min") ? "+" : "–"; };
	panel.querySelectorAll("input[data-s]").forEach(inp => inp.onchange = () => { inp.checked ? st.sp.add(+inp.dataset.s) : st.sp.delete(+inp.dataset.s); apply(); });
	// 大分類の箱＝中の利用区分をまとめて切る。中を一部だけ切った時は大分類の箱を「一部」（indeterminate）に
	const syncGroups = () => GROUPS.forEach((g, gi) => { const box = $(`input[data-g="${gi}"]`), on = g.ks.filter(k => st.cls.has(k)).length;
		box.checked = on === g.ks.length; box.indeterminate = on > 0 && on < g.ks.length; });
	const setCls = (k, on) => { on ? st.cls.add(k) : st.cls.delete(k); $(`input[data-k="${k}"]`).checked = on; };
	panel.querySelectorAll("input[data-k]").forEach(inp => inp.onchange = () => { setCls(+inp.dataset.k, inp.checked); syncGroups(); apply(); });
	panel.querySelectorAll("input[data-g]").forEach(inp => inp.onchange = () => { for (const k of GROUPS[+inp.dataset.g].ks) setCls(k, inp.checked); syncGroups(); apply(); });
	$(".cmode").onchange = e => { const c = COLORS[e.target.value] || COLORS.sp; map.setPaintProperty("cj-pt", "circle-color", c); map.setPaintProperty("cj-est", "circle-stroke-color", c); };
	panel.querySelectorAll("button[data-all]").forEach(b => b.onclick = () => { panel.querySelectorAll("input[data-s]").forEach(inp => { inp.checked = b.dataset.all === "1"; inp.checked ? st.sp.add(+inp.dataset.s) : st.sp.delete(+inp.dataset.s); }); apply(); });
	const D0 = $(".d0"), D1 = $(".d1"), num = v => +v.replaceAll("-", "");
	const setDates = (a, b) => { st.d0 = Math.max(dMin, a); st.d1 = Math.min(dMax, b); D0.value = ymd(st.d0); D1.value = ymd(st.d1); apply(); };
	D0.onchange = () => D0.value && setDates(num(D0.value), st.d1);
	D1.onchange = () => D1.value && setDates(st.d0, num(D1.value));
	panel.querySelectorAll("button[data-fy]").forEach(b => b.onclick = () => { const y = +b.dataset.fy; y ? setDates(y * 10000 + 401, (y + 1) * 10000 + 331) : setDates(dMin, dMax); });
	$(".muni").onchange = e => setMuni(e.target.value);
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) panel.addEventListener(ev, e => e.stopPropagation());

	// 市区町村を選ぶ＝絞って、そこへ飛ぶ。URL の ?m= に残す
	async function setMuni(code, { fly = true } = {}) {
		st.muni = muniOf.has(code) ? code : ""; $(".muni").value = st.muni;
		const u = new URL(location.href); st.muni ? u.searchParams.set("m", st.muni) : u.searchParams.delete("m"); history.replaceState(null, "", u);
		if (sel && st.muni && sel.code !== st.muni) select(null);
		apply();
		if (!fly) return;
		const pts = (st.muni ? recs.filter(d => d.code === st.muni) : recs).map(d => [d.lon, d.lat]);
		const bb = bboxOf(pts);
		await map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, st.muni ? Math.max(6, Math.min(12, map.fitZoomForBbox(bb) - 0.4)) : 4.6);
	}

	function renderCounts() {
		const ns = SP.map(() => 0), nk = CLS.map(() => 0); let n = 0;
		for (const d of recs) {
			if (d.d < st.d0 || d.d > st.d1 || (st.muni && d.code !== st.muni)) continue;
			if (st.cls.has(d.k)) ns[d.s]++;
			if (st.sp.has(d.s)) nk[d.k]++;
			if (st.sp.has(d.s) && st.cls.has(d.k)) n++;
		}
		ns.forEach((v, i) => { $(`[data-ns="${i}"]`).textContent = fmt(v); });
		nk.forEach((v, i) => { $(`[data-nk="${i}"]`).textContent = fmt(v); });
		GROUPS.forEach((g, gi) => { $(`[data-ng="${gi}"]`).textContent = fmt(g.ks.reduce((a, k) => a + nk[k], 0)); });
		$(".total b").textContent = fmt(n);
	}

	function renderDetail() {
		const el = $(".detail"), d = sel;
		if (!d) { el.hidden = true; el.innerHTML = ""; return; }
		const row = (k, v) => v == null || v === "" ? "" : `<div class="m"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
		el.hidden = false;
		el.innerHTML = `<div class="dh"><span class="sw" style="background:${SP_COLORS[d.s]}"></span><div><b class="nm">${esc(SP[d.s])}</b><small>${esc(d.tm)}</small></div><button class="x" type="button" aria-label="閉じる">×</button></div>
			${row("市区町村", `${muniOf.get(d.code)?.pref || ""}${(d.muni || "").replace(muniOf.get(d.code)?.pref || "", "")}（${d.code}）`)}
			${row("大分類", GROUPS[groupOf(d.k)].name)}${row("利用区分", CLS[d.k])}
			${row("体長", d.len ? `${d.len} cm` : null)}${row("体重", d.wt ? `${d.wt} kg` : null)}
			${row("座標", `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}（${SRC[d.o]}）`)}
			${row("受付番号", d.rno)}${row("捕獲者 ID", d.uid)}`;
		el.querySelector(".x").onclick = () => select(null);
	}

	apply();
	const m0 = new URLSearchParams(location.search).get("m");
	if (m0 && muniOf.has(m0)) setMuni(m0, { fly: !location.hash });

	return { recs, munis, select, setMuni, state: st, get sel() { return sel; }, shown };
}

// ── 意匠（quiet-mono のトークン＝#map の変数を使う＝onsen と同じ）──
const CSS = `
.cj-panel{position:absolute;top:12px;right:12px;z-index:30;width:300px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;box-sizing:border-box;
	padding:12px 14px;border-radius:var(--qm-r-l);background:var(--qm-panel-solid);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);
	backdrop-filter:blur(var(--qm-blur));-webkit-backdrop-filter:blur(var(--qm-blur));color:var(--qm-text);font:13px/1.45 var(--qm-font)}
.cj-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cj-panel h1{flex:1;min-width:0;font-size:15px;margin:0;font-weight:700;color:var(--qm-ink)}
.cj-panel .fold,.cj-panel .x{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer}
.cj-panel.min .body{display:none}
.cj-panel .span{margin:2px 0 8px;color:var(--qm-text-dim);font-size:12px}
.cj-panel .msel{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--qm-text-dim)}
.cj-panel select,.cj-panel input[type=date]{font:inherit;font-size:12.5px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:#fff;color:var(--qm-text);padding:5px 6px;min-width:0}
.cj-panel .total{margin:10px 0 4px;color:var(--qm-text-dim)}
.cj-panel .total b{font-size:20px;color:var(--qm-ink);font-variant-numeric:tabular-nums}
.cj-panel h2{font-size:12px;margin:10px 0 2px;color:var(--qm-text-dim);font-weight:600}
.cj-panel .grp{display:flex;align-items:center;gap:8px;padding:2px 0;cursor:pointer}
.cj-panel .grp small{margin-left:auto;color:var(--qm-text-faint);font-variant-numeric:tabular-nums}
.cj-panel .sw{flex:none;width:11px;height:11px;border-radius:50%}
.cj-panel .grp.top b{font-weight:600;color:var(--qm-ink)}
.cj-panel .grp.sub{padding-left:20px;font-size:12.5px}
.cj-panel .msel + h2,.cj-panel .msel{margin-top:8px}
.cj-panel .all{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0}
.cj-panel .all button{font:inherit;font-size:11.5px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);border-radius:6px;padding:1px 8px;cursor:pointer}
.cj-panel .dates{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.cj-panel .dates label{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--qm-text-dim)}
.cj-panel .note{color:var(--qm-text-dim);font-size:12px;margin:10px 0 0}
.cj-panel .detail{margin:8px 0 2px;padding:10px;border-radius:var(--qm-r-m);background:rgba(43,59,87,.04);border:1px solid var(--qm-border-soft)}
.cj-panel .dh{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px}
.cj-panel .dh .sw{margin-top:4px}
.cj-panel .dh > div{flex:1;min-width:0}
.cj-panel .dh .nm{display:block;font-size:15px;color:var(--qm-ink)}
.cj-panel .dh small{color:var(--qm-text-dim)}
.cj-panel .m{display:flex;align-items:baseline;gap:8px;padding:2px 0}
.cj-panel .m span{flex:none;color:var(--qm-text-dim);min-width:64px}
.cj-panel .m b{font-weight:500;color:var(--qm-ink)}
@media (max-width:720px){ .cj-panel{left:12px;right:12px;width:auto;max-height:46vh} }`;
