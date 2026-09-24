// 人工衛星（いま軌道にいる衛星＝CelesTrak GP・active 約 1.6 万機）を地球儀（@ortho-earth/globe）のまわりに共通の時計の時刻で立体表示する（sats.html から遅延 import）。
// 地震（quakes.js＝地下）と対の「3D の地上」＝同じ器・同じ骨格：器＝sats.html／UI と伝播と pick＝ここ／GPU 描画＝sats-gl.js（レンダーワーカー内・同一フレーム）。
//
// データ：CelesTrak の GP（米宇宙軍の公開カタログの再配布・OMM の CSV）。active 一本だけ取り、分類は名前（Starlink）と軌道の形（高度帯・離心率）で手元で付ける。
//   読む先はミラー（www.ortho-earth.com/sats/active.csv＝専用 Worker apps/sats-mirror が 2 時間に 1 回だけ CelesTrak から素通しで KV に置く）。
//   ⚠CelesTrak は同じグループを同一 IP から 2 時間に 1 回しか返さない（間は CSV でなく断り文・実測 2026-09-19）＝学校など IP を共有する所では
//   直読みだと 2 人目以降が読めない（本人裁定 9/19＝ミラー）。ミラーが無い/壊れた時だけ CelesTrak 直読みへ落ちる。?src=URL で差し替え可。
//   手元は Cache API に 30 分置く（開き直しで 0.7 MB を取り直さない）。全部だめなら古い手元の要素で回す（数日なら km 級）。
// 伝播：ephem/sgp4（自前の SGP4/SDP4＝参照実装の移植・satellite.js と全機 cm 一致を検定済み）。全機の伝播は 1 秒に 1 回（約 6 ms）。
//   間のフレームは GPU が位置＋速度×経過で直線外挿（1 秒で数 m の誤差＝画面では 0 px）。
// 表現の決め事
//   位置   … 地球固定（ECEF）へ GMST で回し、β 単位球ワールド（y＝北極・z＝東経 90°）にして GPU へ＝毎フレーム経緯度に戻さない
//   色     … 分類ごと（凡例＝パネルの行・押すと出し入れ）。有人の宇宙ステーションは名前つき（札）
//   選択   … 点をクリック＝その衛星の軌道（前後半周＝地球の自転込みの実際の通り道）と地上軌跡・真下への糸・高度と速さ。既定の選択は ISS
//   畳み   … 地球の見かけの半径が小さい（太陽系圏の奥）＝点が地球に団子＝描かない（sats-gl.js）
// エンジンとの接点は公開面だけ：map.overlay（同一フレームのオーバーレイ・#13）・map.cam＋ ortho-core の cameraState（pick と札の投影）・onFrame（札の追従）・mapEl。
import { cameraState, ellipsoidOn, worldRadiusM } from "@ortho-earth/core";
import { parseOMM, sgp4init, sgp4, gmst, temeToGeodetic, jdOf } from "@ortho-earth/ephem/sgp4";
import { sunSubpoint } from "@ortho-earth/ephem/sun";   // 太陽直下点＝日照と地球の影（夜の側と同じ正本）
import { gunzip } from "geopbf/gzip";
import glUrl from "./sats-gl.js?url";   // worker が import() する URL＝vite はこのファイルをそのまま置く（⚠?worker&url は殻になる・quakes と同じ轍）＝モジュールは依存ゼロが掟
import { CATS, CAT_NONE, MIN_EARTH_PX } from "./sats-gl.js";   // 分類の表は同じ物（正本は sats-gl.js）
import { tr, setLang, getLang, loadPage } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語（i18n.js の作法）。モジュール評価時に t() を呼ばない
const t = tr();

export const MIRROR = "https://www.ortho-earth.com/sats/active.csv";   // 専用 Worker apps/sats-mirror（CORS 開放＝開発機からも読める）
export const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv";   // 本家（ミラーが無い時だけ）
const CACHE = "ortho-sats-v1", CACHE_KEY = CELESTRAK, FRESH_MS = 30 * 60e3;
const PROP_MS = 1000, TAG_MS = 100, PATH_MS = 15000, PROP_TICK = 250, DT_MAX = 30;   // PROP_TICK＝伝播の見回り（実 ms）・DT_MAX＝直線外挿の上限（秒・時計の早送り中の飛び出し止め）   // 全機の伝播間隔／札の追従間隔／選択衛星の軌道の引き直し
const STATIONS = new Map([[25544, "ISS"], [48274, "Tiangong"]]);   // 有人の宇宙ステーション（NORAD 番号→表示名）＝常に名前つき
const DEFAULT_PICK = 25544;
// 時刻の正直さ（2026-09-24 本人裁定）：軌道要素（元期）から NEAR_D 日より離れた時刻は「位置は近似」と明示・FAR_D 日より先は元期±FAR_D で止める
// （その時刻の位置は分からない＝今の軌道で並べた目安）。打ち上げ前（OBJECT_ID の年）の衛星は出さない
const NEAR_D = 3, FAR_D = 30, DAY_MS = 864e5, FAR_MS = FAR_D * DAY_MS;
const PATH_N = 240;                         // 選択衛星の軌道の標本数（前後半周）
const OMEGA = 7.2921159e-5;                 // 地球自転（rad/s）＝TEME→ECEF の速度の補正
const D2R = Math.PI / 180;
const F = 1 / 298.257223563;

const fmt = n => n.toLocaleString(getLang());
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const catLabel = { starlink: () => "Starlink", leo: () => t("Low Earth orbit"), meo: () => t("Medium Earth orbit (GPS etc.)"), geo: () => t("Geostationary orbit"), heo: () => t("Highly elliptical orbit") };
const cssColor = c => `rgb(${c.join(",")})`;

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountSats(map, { src = [MIRROR, CELESTRAK], panelHost } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/sats/${c}.json`));   // 本番はこのチャンクの i18n.js が SDK と別実体＝自分で訳を用意してから UI を組む。ページの辞書（i18n/pages/sats.json）も足す
	document.title = t("Satellites in orbit now — ortho-globe");   // 器（sats.html）の題名と説明もここで＝i18n の走査器は .js だけ読む
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("About 16,000 active satellites (CelesTrak GP) propagated in your browser with SGP4 and shown in 3D around the globe in real time."));
	const mapEl = map.mapEl;
	const ac = new AbortController(), signal = ac.signal;

	// 単位：km → β 単位球ワールド（楕円体は y を b/a で割る＝cameraState の mvp/eye と同じ空間）
	const EARTH_M = worldRadiusM();
	const RAX = ellipsoidOn() ? 1 - F : 1;
	const K = 1000 / EARTH_M, KY = K / RAX;
	// 衛星（ECEF km）→ ワールド。球（既定）＝測地の緯度・経度・高さで置く＝地図と同じ置き方（経緯度をそのまま球の緯度に置く）
	// ＝衛星は地図の直下点の真上・真下への糸は球の法線（旧＝地心の向きに置いていた＝測地緯度の直下点とずれ、糸が斜めだった・中緯度の ISS で約 20 km）。
	// 楕円体（?ell=1）＝β ワールドは ECEF を a で割った形（y だけ b/a で割る）＝そのままで厳密
	const toWorld = (r, g, X, Y, Z) => {
		if (RAX !== 1) return [X * K, Z * KY, Y * K];
		const ll = temeToGeodetic(r, g), q = surf(ll.lon, ll.lat), k = 1 + ll.h * 1000 / EARTH_M;
		return [q[0] * k, q[1] * k, q[2] * k];
	};
	const sunDirOf = ms => { const [lon, dec] = sunSubpoint(ms), c = Math.cos(dec); return [c * Math.cos(lon), Math.sin(dec), c * Math.sin(lon)]; };   // 太陽の向き（ワールドの軸）
	const inShadow = (x, y, z, u) => { const d = x * u[0] + y * u[1] + z * u[2]; return d < 0 && x * x + y * y + z * z - d * d < 1; };   // 地球の影（円柱＝半影は無視・sats-gl.js と同じ式）
	const surf = (lon, lat) => {   // 経緯度 → β 単位球の地表点（quakes-worker の toGpu と同式）
		const a = lon * D2R, b = lat * D2R;
		let sb = Math.sin(b), cb = Math.cos(b);
		if (RAX !== 1) { const w = Math.hypot(cb, RAX * sb); sb = RAX * sb / w; cb = cb / w; }
		return [cb * Math.cos(a), sb, cb * Math.sin(a)];
	};

	// GPU 描画＝レンダーワーカー内のオーバーレイ（sats-gl.js）。ここは列の写しを持つ＝pick・札の投影用
	const ov = map.overlay(glUrl, { name: "sats" });

	// 状態
	const vis = new Set(CATS.map(c => c.key));
	let S = [], cat = null, names = [], norad = null;   // 衛星（sgp4init 済み）と分類（Float32＝GPU の属性そのもの）・名前・NORAD 番号
	let Wp = null, Wv = null, ok = null, tProp = 0;     // 直近の伝播（β ワールド・位置と速度/秒）と時刻(ms)
	let pick = -1, pathAt = 0, dataAt = 0, catDirty = false;
	let catBase = null, epochMs = null, launchY = null, sunNow = [1, 0, 0];   // 本来の分類（打ち上げ前で隠した後の戻し先）・各衛星の元期(ms)・打ち上げ年・今の太陽の向き
	const effTime = (i, now) => Math.max(epochMs[i] - FAR_MS, Math.min(epochMs[i] + FAR_MS, now));   // 伝播に使う時刻＝元期±FAR_D に収める（その先は止める）
	const n = () => S.length;
	// その時刻＝共通の時計（#42・map.clock）。早送り・巻き戻し・日時の指定で衛星も同じ時刻へ（無ければ実時刻）
	const simNow = () => map.clock ? map.clock.time : Date.now();
	const nowPos = (i, now = simNow()) => {   // 直近の伝播から直線外挿した今の位置（GPU と同じ式）
		const dt = Math.max(-DT_MAX, Math.min(DT_MAX, (now - tProp) / 1000));   // 外挿は ±DT_MAX 秒まで（sats-gl.js と同じ）
		return [Wp[i * 3] + Wv[i * 3] * dt, Wp[i * 3 + 1] + Wv[i * 3 + 1] * dt, Wp[i * 3 + 2] + Wv[i * 3 + 2] * dt];
	};

	// ── pick と札の投影は main の cam から。1 フレーム遅らせる（quakes.js と同じ）：地球はレンダーワーカーが次の rAF で描く（main の render は
	// cam を送るだけ）ので、onFrame の cam をそのまま使うと札だけ 1 フレーム先行する。前フレームに送った cam＝地球が今見せている姿。
	let shownCam = null, catchUp = 0;
	const snapCam = () => ({ ...map.cam, center: [...map.cam.center] });
	const camState = () => {
		const c = shownCam ?? map.cam;
		const dpr = c.dpr || devicePixelRatio || 1;
		const W = Math.max(1, Math.round(mapEl.clientWidth * dpr)), H = Math.max(1, Math.round(mapEl.clientHeight * dpr));
		return { s: cameraState(c, W, H), dpr, W, H };
	};
	// β ワールドの点 → 画面（device px）。地球の陰（視線と地球の交差）・カメラ後方・画面外は null
	const project = (s, x, y, z, W, H) => {
		const m = s.mvp, E = s.eye;
		const w = m[3] * x + m[7] * y + m[11] * z + m[15];
		if (w <= 1e-6) return null;
		const dx = x - E[0], dy = y - E[1], dz = z - E[2], dd = dx * dx + dy * dy + dz * dz;
		const tt = -(E[0] * dx + E[1] * dy + E[2] * dz) / dd;   // 視線上で地球中心に最も近い所
		if (tt > 0 && tt < 1) { const px = E[0] + dx * tt, py = E[1] + dy * tt, pz = E[2] + dz * tt; if (px * px + py * py + pz * pz < 1) return null; }
		const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * W;
		const sy = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5 + 0.5)) * H;
		if (sx < 0 || sy < 0 || sx > W || sy > H) return null;
		return { x: sx, y: sy };
	};
	const earthPxOf = s => { const E = s.eye; return s.focal / Math.sqrt(Math.max(E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - 1, 1e-12)); };   // 地球の見かけの半径（device px）
	const offFrame = map.onFrame(() => {
		placeTags();
		shownCam = snapCam();
		if (!catchUp) catchUp = requestAnimationFrame(() => { catchUp = 0; placeTags(); });
	});

	// ── パネル（quakes と同じ意匠＝暗いガラス）──
	const panel = document.createElement("div");
	panel.className = "sats-panel";
	panel.innerHTML = `
<style>
.sats-panel{position:absolute;top:12px;right:12px;z-index:30;width:292px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;
 box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;background:rgba(12,17,32,.86);color:#e7ecf5;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.sats-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sats-panel h1{font-size:15px;margin:0 0 2px;font-weight:700;letter-spacing:.02em}
.sats-panel .fold{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e7ecf5;font-size:14px;line-height:1;cursor:pointer}
.sats-panel.min .body{display:none}
.sats-panel.min{padding-bottom:10px}
.sats-panel .sub{color:#9aa6bd;font-size:11.5px;margin-bottom:10px}
.sats-panel .row{margin:9px 0}
.sats-panel .stat{font-variant-numeric:tabular-nums;color:#fff}
.sats-panel .q{width:100%;box-sizing:border-box;margin:2px 0 6px;padding:6px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font:inherit;outline:none}
.sats-panel .q:focus{border-color:rgba(255,255,255,.5)}
.sats-panel .hits{display:flex;flex-direction:column;gap:1px;margin-bottom:6px}
.sats-panel .hit{display:flex;justify-content:space-between;gap:8px;width:100%;border:0;background:rgba(255,255,255,.05);text-align:start;padding:4px 8px;border-radius:6px;cursor:pointer;font:inherit;color:inherit}
.sats-panel .hit:hover,.sats-panel .hit:focus{background:rgba(255,255,255,.14);outline:none}
.sats-panel .hit em{font-style:normal;color:#9aa6bd;white-space:nowrap}
.sats-panel .nohit{color:#8793aa;font-size:11px;padding:2px 4px 6px}
.sats-panel .cat{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;text-align:start;padding:4px 4px;border-radius:7px;cursor:pointer;font:inherit;color:inherit}
.sats-panel .cat:hover{background:rgba(255,255,255,.08)}
.sats-panel .cat i{width:10px;height:10px;border-radius:50%;flex:none}
.sats-panel .cat span{flex:1}
.sats-panel .cat em{font-style:normal;color:#9aa6bd;font-variant-numeric:tabular-nums}
.sats-panel .cat.off{opacity:.4}
.sats-panel .cat.off i{background:transparent !important;box-shadow:inset 0 0 0 1.5px #9aa6bd}
.sats-panel .sel{padding:8px 4px 2px;border-top:1px solid rgba(255,255,255,.12);margin-top:6px}
.sats-panel .sel b{font-size:14px}
.sats-panel .sel .m{color:#b9c3d6;font-variant-numeric:tabular-nums}
.sats-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
.sats-panel .honest{color:#ffd479;font-size:11px;line-height:1.45;margin-top:4px}
.sats-tag{position:absolute;z-index:29;pointer-events:none;transform:translate(8px,-50%);padding:1px 7px;border-radius:6px;
 background:rgba(12,17,32,.86);color:#fff;border:1px solid rgba(255,255,255,.18);font:600 11px/1.6 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;white-space:nowrap}
.sats-tag.pick{border-color:rgba(255,255,255,.45)}
.sats-tip{position:absolute;z-index:31;pointer-events:none;transform:translate(10px,-50%);padding:1px 6px;border-radius:5px;white-space:nowrap;
 background:rgba(20,24,32,.82);color:#fff;font:11px/1.6 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif}
@media (max-width:640px){.sats-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:45%}}
</style>
<div class="head"><h1>${t("Satellites in orbit now")}</h1><button type="button" class="fold" data-k="fold" aria-label="${t("Collapse panel")}">−</button></div>
<div class="sub" data-k="sub">${t("Orbital data: CelesTrak (NORAD GP) · $1", "")}</div>
<div class="row"><div data-k="status" class="stat">${t("Loading orbits…")}</div><div data-k="honest" class="honest" style="display:none"></div></div>
<div class="body">
<input class="q" data-k="q" type="search" autocomplete="off" spellcheck="false" placeholder="${t("Search satellites (name or NORAD ID)")}" aria-label="${t("Search satellites (name or NORAD ID)")}">
<div class="hits" data-k="hits"></div>
<div class="row" data-k="cats"></div>
<div class="sel" data-k="sel" style="display:none"></div>
<div class="note">${t("Click a dot to see its orbit")}<br>${t("Faint dots are in Earth's shadow")}<br>${t("Tilt (right-drag / two fingers) to see altitude in 3D.")}</div>
</div>`;
	(panelHost || mapEl).appendChild(panel);
	const $ = k => panel.querySelector(`[data-k="${k}"]`);
	const tip = document.createElement("div");
	tip.className = "sats-tip"; tip.style.display = "none";
	mapEl.appendChild(tip);
	// 折り畳み：小さい画面は最初から畳む（見出し＋件数だけ残す）
	const setFold = min => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? t("Expand panel") : t("Collapse panel")); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	setFold(matchMedia("(max-width:640px)").matches);

	// 凡例（分類の行＝押すと出し入れ）
	const buildCats = () => {
		const counts = CATS.map(() => 0); for (const k of cat) if (k < CAT_NONE) counts[k]++;
		$("cats").innerHTML = CATS.map((c, k) => `<button type="button" class="cat${vis.has(c.key) ? "" : " off"}" data-c="${c.key}" aria-pressed="${vis.has(c.key)}">
			<i style="background:${cssColor(c.color)}"></i><span>${catLabel[c.key]()}</span><em>${fmt(counts[k])}</em></button>`).join("");
	};
	panel.addEventListener("click", e => {
		const b = e.target.closest(".cat"); if (!b) return;
		const k = b.dataset.c; vis.has(k) ? vis.delete(k) : vis.add(k);
		b.classList.toggle("off", !vis.has(k)); b.setAttribute("aria-pressed", vis.has(k));
		ov.post({ type: "state", vis: CATS.map(c => vis.has(c.key) ? 1 : 0) });
		placeTags();
	});
	// ── 検索（衛星名の部分一致・NORAD 番号の前方一致）＝選ぶと選択して直下点へ球を回す（見えない裏側の衛星を選んでも表に来る）──
	const HIT_MAX = 8;
	const renderHits = () => {
		const q = $("q").value.trim().toUpperCase(), box = $("hits");
		if (!q || !n()) { box.innerHTML = ""; return; }
		const num = /^\d+$/.test(q), hits = [];
		for (let i = 0; i < n() && hits.length < HIT_MAX; i++) if (num ? String(norad[i]).startsWith(q) : names[i].toUpperCase().includes(q) || (STATIONS.get(norad[i]) || "").toUpperCase().includes(q)) hits.push(i);   // 表示名（ISS/Tiangong）でも引ける（登録名は ISS (ZARYA)・CSS (TIANHE)）
		box.innerHTML = hits.length
			? hits.map(i => `<button type="button" class="hit" data-i="${i}"><span>${esc(names[i])}</span><em>${cat[i] < CAT_NONE ? catLabel[CATS[cat[i]].key]() : ""} · ${norad[i]}</em></button>`).join("")
			: `<div class="nohit">${t("No satellite matches")}</div>`;
	};
	const goTo = i => {   // 選択＋直下点を画面中央へ（ズームはそのまま）
		setPick(i);
		const jd = jdOf(effTime(i, simNow())), p = sgp4(S[i], (jd - S[i].jdEpoch) * 1440);
		if (p && map.flyTo) { const ll = temeToGeodetic(p.r, gmst(jd)); map.flyTo(ll.lon, ll.lat, map.getZoom ? map.getZoom() : map.cam.zoom); }
	};
	$("q").addEventListener("input", renderHits);
	$("q").addEventListener("keydown", e => { if (e.key === "Enter") { const b = $("hits").querySelector(".hit"); if (b) goTo(+b.dataset.i); } else if (e.key === "Escape") { $("q").value = ""; renderHits(); $("q").blur(); } });
	$("hits").addEventListener("click", e => { const b = e.target.closest(".hit"); if (b) goTo(+b.dataset.i); });
	const setStatus = html => { $("status").innerHTML = html; };
	const setSub = () => {
		const when = dataAt ? new Date(dataAt).toLocaleString(getLang(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
		$("sub").textContent = t("Orbital data: CelesTrak (NORAD GP) · $1", when);
	};
	let selKey = "";
	const showSel = () => {   // 選択衛星の高度と速さ（変わった時だけ DOM を書く）
		const el = $("sel");
		if (pick < 0 || !n()) { el.style.display = "none"; selKey = ""; return; }
		el.style.display = "";
		if (!ok[pick]) { if (selKey !== "x" + pick) { selKey = "x" + pick; el.innerHTML = `<b>${esc(names[pick])}</b>`; } return; }
		const jd = jdOf(effTime(pick, simNow())), p = sgp4(S[pick], (jd - S[pick].jdEpoch) * 1440);
		if (!p) return;
		const h = temeToGeodetic(p.r, gmst(jd)).h, v = Math.hypot(p.v[0], p.v[1], p.v[2]);
		const [wx, wy, wz] = nowPos(pick), dark = inShadow(wx, wy, wz, sunNow);   // 点と同じ位置で日照を判定（GPU の暗い点と一致）
		const key = `${pick}|${Math.round(h)}|${v.toFixed(2)}|${dark}`;
		if (key === selKey) return; selKey = key;
		el.innerHTML = `<b>${esc(names[pick])}</b><div class="m">${t("Altitude $1 km · speed $2 km/s", fmt(Math.round(h)), v.toFixed(2))}</div><div class="m">${dark ? t("In Earth's shadow") : t("In sunlight")}</div>`;
	};

	// ── 札（宇宙ステーション＋選択衛星の名前）＝点の右に貼る DOM。位置は前フレームの cam＋今の外挿位置 ──
	let tags = [];   // { i, el }
	const clearTags = () => { tags.forEach(x => x.el.remove()); tags = []; };
	const refreshTags = () => {
		clearTags();
		if (!n()) return;
		const want = [];
		norad.forEach((id, i) => { if (STATIONS.has(id)) want.push(i); });
		if (pick >= 0 && !STATIONS.has(norad[pick])) want.push(pick);
		for (const i of want) {
			const el = document.createElement("div");
			el.className = "sats-tag" + (i === pick ? " pick" : "");
			el.textContent = STATIONS.get(norad[i]) || names[i];
			mapEl.appendChild(el);
			tags.push({ i, el });
		}
		placeTags();
	};
	function placeTags() {
		if (!tags.length || !Wp) return;
		const { s, dpr, W, H } = camState();
		const folded = earthPxOf(s) / dpr < MIN_EARTH_PX;
		for (const x of tags) {
			const [px, py, pz] = nowPos(x.i);
			const p = !folded && ok[x.i] && vis.has(CATS[cat[x.i]]?.key) ? project(s, px, py, pz, W, H) : null;
			if (!p) { x.el.style.display = "none"; continue; }
			x.el.style.display = ""; x.el.style.left = (p.x / dpr) + "px"; x.el.style.top = (p.y / dpr) + "px";
		}
	}

	// ── 当たり（ホバー＝名前・クリック＝選択）＝CPU で最寄りを探す ──
	function nearest(x, y, rad) {   // x,y＝CSS px。戻り＝添字（無ければ -1）
		if (!Wp) return -1;
		const { s, dpr, W, H } = camState();
		if (earthPxOf(s) / dpr < MIN_EARTH_PX) return -1;
		const px = x * dpr, py = y * dpr, bd = rad * dpr;
		let best = -1, bestD = bd * bd;
		const now = simNow();
		for (let i = 0; i < n(); i++) {
			if (!ok[i] || !vis.has(CATS[cat[i]]?.key)) continue;
			const [X, Y, Z] = nowPos(i, now);
			const p = project(s, X, Y, Z, W, H);
			if (!p) continue;
			const dx = p.x - px, dy = p.y - py, d2 = dx * dx + dy * dy;
			if (d2 < bestD) { bestD = d2; best = i; }
		}
		return best;
	}
	let hoverI = -1;
	mapEl.addEventListener("pointermove", e => {
		if (e.pointerType === "touch" || !n() || panel.contains(e.target)) return;
		const b = mapEl.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
		const i = nearest(x, y, 7);
		if (i !== hoverI) hoverI = i;
		if (i < 0 || i === pick || STATIONS.has(norad[i])) { tip.style.display = "none"; return; }   // 名前が札で出ている点には出さない
		tip.textContent = names[i]; tip.style.left = x + "px"; tip.style.top = y + "px"; tip.style.display = "block";
	}, { signal, passive: true });
	mapEl.addEventListener("pointerleave", () => { hoverI = -1; tip.style.display = "none"; }, { signal });
	let down = null;
	mapEl.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; }, { signal, capture: true });
	mapEl.addEventListener("pointerup", e => {
		if (!down || !n() || panel.contains(e.target)) return;
		const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
		if (moved > 4) return;
		const r = mapEl.getBoundingClientRect();
		const i = nearest(e.clientX - r.left, e.clientY - r.top, 10);
		if (i >= 0) setPick(i);
	}, { signal, capture: true });
	function setPick(i) {
		pick = i; selKey = ""; tip.style.display = "none";
		postMarks(); buildPath(simNow()); showSel(); refreshTags();
	}
	const postMarks = () => {
		const st = []; norad.forEach((id, i) => { if (STATIONS.has(id)) st.push(i); });
		ov.post({ type: "marks", stations: Uint32Array.from(st), pick: pick >= 0 && !STATIONS.has(norad[pick]) ? Uint32Array.of(pick) : new Uint32Array(0), sel: pick });   // sel＝真下への糸を引く衛星（宇宙ステーションでも）
	};

	// ── データ ──
	async function fetchCsv() {
		let cache = null, hit = null;
		try { cache = await caches.open(CACHE); hit = await cache.match(CACHE_KEY); } catch { /* Cache API 無し（非セキュア文脈等）＝毎回取る */ }
		const at = hit ? +hit.headers.get("x-fetched-at") || 0 : 0;
		if (hit && Date.now() - at < FRESH_MS) return await hit.text();
		const isCsv = text => text.startsWith("OBJECT_NAME,");
		for (const url of (Array.isArray(src) ? src : [src])) {
			try {
				const r = await fetch(url, { signal });
				if (!r.ok) { console.warn(`[sats] ${url}: HTTP ${r.status}`); continue; }
				const text = await (await gunzip(await r.blob())).text();   // ミラーは gzip 配信＝通常はブラウザが解く。解かれずに届いても gunzip が解く（平文は素通し）
				if (!isCsv(text)) { console.warn(`[sats] ${url} did not return CSV (rate limit?):`, text.slice(0, 120)); continue; }
				cache?.put(CACHE_KEY, new Response(text, { headers: { "content-type": "text/csv", "x-fetched-at": String(Date.now()) } })).catch(() => {});
				return text;
			} catch (e) { if (signal.aborted) throw e; console.warn(`[sats] ${url} fetch failed`, e); }
		}
		if (hit) return await hit.text();
		throw new Error("no orbital data");
	}
	function parseCsv(text) {
		const lines = text.split(/\r?\n/).filter(Boolean), head = lines[0].split(",");
		const rows = [];
		for (let i = 1; i < lines.length; i++) {
			const f = splitCsv(lines[i]); if (f.length < head.length) continue;
			const o = {}; head.forEach((h, j) => { o[h] = f[j]; }); rows.push(o);
		}
		return rows;
	}
	function splitCsv(line) {   // 名前に , が入る時だけ "…" で括られる＝最小の CSV 読み
		if (!line.includes('"')) return line.split(",");
		const out = []; let cur = "", q = false;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
			else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
		}
		out.push(cur); return out;
	}
	const classify = o => {   // 添字＝CATS の並び
		const nn = +o.MEAN_MOTION, e = +o.ECCENTRICITY;
		if (/^STARLINK/.test(o.OBJECT_NAME)) return 0;
		if (e > 0.25) return 4;             // 長楕円（モルニア・静止トランスファー等）
		if (nn > 11.25) return 1;           // 低軌道（周期 128 分未満＝高度 約 2,000 km 以下）
		if (nn > 0.9 && nn < 1.1) return 3; // 静止・対地同期（一日一周）
		return 2;                           // 中軌道（GPS・GLONASS・Galileo・北斗など）
	};
	let propTimer = 0, tagTimer = 0;   // 伝播（1 Hz）と札の追従（10 Hz）のタイマー＝destroy で止める
	const loaded = (async () => {
		const text = await fetchCsv();
		const rows = parseCsv(text), sats = [], cats = [], nm = [], ids = [], ly = [];
		for (const o of rows) {
			let s; try { s = sgp4init(parseOMM(o)); } catch { continue; }
			if (s.error) continue;
			sats.push(s); cats.push(classify(o)); nm.push(o.OBJECT_NAME); ids.push(+o.NORAD_CAT_ID);
			ly.push(+String(o.OBJECT_ID || "").slice(0, 4) || 0);   // 国際標識（例 1998-067A）の頭＝打ち上げ年（読めない＝0＝いつでも出す）
		}
		S = sats; cat = Float32Array.from(cats); catBase = Float32Array.from(cats); names = nm; norad = Int32Array.from(ids);
		launchY = Int16Array.from(ly); epochMs = Float64Array.from(sats, x => (x.jdEpoch - 2440587.5) * DAY_MS);
		const nowMs = Date.now();   // 最新の元期＝この要素の新しさ（取得時刻より正直）。未来の元期（打ち上げ予定の名目要素等・実測 2 日先）は除く
		dataAt = S.reduce((m, s) => { const e = (s.jdEpoch - 2440587.5) * 864e5; return e <= nowMs && e > m ? e : m; }, 0);
		const N = S.length;
		Wp = new Float64Array(N * 3); Wv = new Float64Array(N * 3); ok = new Uint8Array(N);
		if (pick < 0) pick = norad.indexOf(DEFAULT_PICK);
		catDirty = true;
		propagateAll(simNow());
		buildCats(); setSub(); postMarks(); showSel(); refreshTags();
		renderHits();   // 読み込み前に打った文字があれば今引く
		// 時計の時刻で 1 秒ぶん進んだら伝播し直す（実時間＝従来どおり 1 Hz／早送り＝PROP_TICK ごと＝外挿は ±DT_MAX で頭打ち＝低軌道が接線へ飛び出さない）
		propTimer = setInterval(() => { const now = simNow(); if (Math.abs(now - tProp) >= PROP_MS) propagateAll(now); }, PROP_TICK);
		// 時計が跳んだ（日時の指定・今へ戻る・段の変更）＝その場で伝播し直し・軌道も引き直す
		const onTime = e => { if (e.ticking) return; const now = simNow(); propagateAll(now); buildPath(now); showSel(); placeTags(); };
		map.on?.("time", onTime); signal.addEventListener("abort", () => map.off?.("time", onTime), { once: true });
		tagTimer = setInterval(() => { placeTags(); showSel(); }, TAG_MS);
		return { n: N };
	})();
	loaded.catch(e => { if (!signal.aborted) { console.error("[sats]", e); setStatus(t("Could not load orbital data")); } });   // 呼び手が await しない使い方で unhandled にしない

	// ── 伝播（1 Hz）＝TEME → ECEF（GMST で回す・速度は自転を差し引く）→ β ワールド → GPU へ写しを送る ──
	function propagateAll(now) {
		const N = n(), jdN = jdOf(now), gN = gmst(jdN), yr = new Date(now).getUTCFullYear();
		const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3);
		let shown = 0, unlaunched = 0;
		for (let i = 0; i < N; i++) {
			const s = S[i];
			const born = !(launchY[i] > yr);   // 打ち上げ前（OBJECT_ID の年＝年の粒度）は出さない
			if (!born) unlaunched++;
			const tE = effTime(i, now), still = tE !== now;   // 元期±FAR_D の外＝そこで止める（位置は分からない＝今の軌道で並べた目安）
			const jd = still ? jdOf(tE) : jdN, g = still ? gmst(jd) : gN;
			const p = born ? sgp4(s, (jd - s.jdEpoch) * 1440) : null;
			const want = p ? catBase[i] : CAT_NONE;
			if (cat[i] !== want) { cat[i] = want; catDirty = true; }
			if (!p) { ok[i] = 0; pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = NaN; continue; }
			ok[i] = 1; shown++;
			const c = Math.cos(g), sn = Math.sin(g);
			const X = p.r[0] * c + p.r[1] * sn, Y = -p.r[0] * sn + p.r[1] * c, Z = p.r[2];   // ECEF km
			const w = toWorld(p.r, g, X, Y, Z);
			Wp[i * 3] = pos[i * 3] = w[0]; Wp[i * 3 + 1] = pos[i * 3 + 1] = w[1]; Wp[i * 3 + 2] = pos[i * 3 + 2] = w[2];
			if (still) { Wv[i * 3] = Wv[i * 3 + 1] = Wv[i * 3 + 2] = 0; continue; }   // 止めた衛星は外挿しない（vel は 0 のまま）
			const vx = p.v[0] * c + p.v[1] * sn + OMEGA * Y, vy = -p.v[0] * sn + p.v[1] * c - OMEGA * X, vz = p.v[2];   // ECEF km/s（v − ω×r）
			// 外挿用の速さ＝ECEF のまま（球の置き方との差は 1 秒で数十 m＝次の伝播で消える）
			Wv[i * 3] = vel[i * 3] = vx * K; Wv[i * 3 + 1] = vel[i * 3 + 1] = vz * KY; Wv[i * 3 + 2] = vel[i * 3 + 2] = vy * K;
		}
		tProp = now; sunNow = sunDirOf(now);
		const msg = { type: "sats", n: N, pos, vel, t0: now, sun: sunNow }, transfer = [pos.buffer, vel.buffer];
		if (catDirty) { msg.cat = cat.slice(); transfer.push(msg.cat.buffer); catDirty = false; buildCats(); }
		ov.post(msg, transfer);
		report(now, shown, unlaunched);
		if (pick >= 0 && Math.abs(now - pathAt) > PATH_MS) buildPath(now);
	}
	// 件数と時刻の正直さの札（変わった時だけ書く）：打ち上げ前を隠している／元期から NEAR_D 日より離れた＝近似／FAR_D 日より先＝分からない（止めた）
	let reportKey = "";
	function report(now, shown, unlaunched) {
		const yr = new Date(now).getUTCFullYear(), gapD = dataAt ? Math.abs(now - dataAt) / DAY_MS : 0;
		const level = gapD > FAR_D ? 2 : gapD > NEAR_D ? 1 : 0;
		const key = `${shown}|${unlaunched ? yr : ""}|${level}`;
		if (key === reportKey) return; reportKey = key;
		setStatus(t("Showing $1 ##count", `<b>${fmt(shown)}</b>`));
		const lines = [];
		if (unlaunched) lines.push(t("Only satellites launched by $1 that are still active today", yr));
		if (level === 2) lines.push(t("Positions at this time are unknown — shown on today's orbits as a guide"));
		else if (level === 1) lines.push(t("Positions are approximate — the orbit data is from $1", new Date(dataAt).toLocaleDateString(getLang(), { year: "numeric", month: "short", day: "numeric" })));
		$("honest").innerHTML = lines.map(esc).join("<br>");
		$("honest").style.display = lines.length ? "" : "none";
	}
	function buildPath(now) {   // 選択衛星の前後半周（最長 1 日）＝地球固定での通り道（自転込み）＋地上軌跡。止めた衛星は止めた時刻を中心に
		pathAt = now;
		if (pick < 0 || !ok[pick]) { ov.post({ type: "path", space: null }); return; }
		const s = S[pick], period = Math.min(1440, 2 * Math.PI / s.no), tC = effTime(pick, now);
		const space = [], ground = [];
		for (let k = 0; k <= PATH_N; k++) {
			const jd = jdOf(tC) + ((k / PATH_N - 0.5) * period) / 1440;
			const p = sgp4(s, (jd - s.jdEpoch) * 1440);
			if (!p) continue;
			const g = gmst(jd), c = Math.cos(g), sn = Math.sin(g);
			const X = p.r[0] * c + p.r[1] * sn, Y = -p.r[0] * sn + p.r[1] * c, Z = p.r[2];
			space.push(...toWorld(p.r, g, X, Y, Z));   // 点と同じ置き方（球＝測地の緯度・経度・高さ）
			const ll = temeToGeodetic(p.r, g); ground.push(...surf(ll.lon, ll.lat));
		}
		const col = STATIONS.has(norad[pick]) ? [1, 1, 1] : CATS[cat[pick]].color.map(v => v / 255);
		const sp = Float32Array.from(space), gr = Float32Array.from(ground);
		ov.post({ type: "path", space: sp, ground: gr, color: col }, [sp.buffer, gr.buffer]);   // 真下への糸は GPU が毎フレーム引く（点と同じ外挿）
	}

	return {
		loaded,
		get count() { return n(); },
		get pick() { return pick >= 0 ? { i: pick, name: names[pick], norad: norad[pick] } : null; },
		stats: () => ({ total: n(), ok: ok ? ok.reduce((a, b) => a + b, 0) : 0, pick: pick >= 0 ? names[pick] : null, dataAt }),
		select: i => { if (i >= 0 && i < n()) setPick(i); },
		nearest: (x, y) => nearest(x, y, 10),   // console 検証用（CSS px → 添字）
		destroy() {
			ac.abort(); clearInterval(propTimer); clearInterval(tagTimer); clearTags(); offFrame(); cancelAnimationFrame(catchUp);
			ov.remove(); panel.remove(); tip.remove();
		},
	};
}
