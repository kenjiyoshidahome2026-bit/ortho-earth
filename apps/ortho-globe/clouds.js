// 雲（いまの雲＝静止気象衛星の赤外画像）を地球儀（@ortho-earth/globe）に描く（clouds.html から遅延 import）。
// 既定＝輝度温度から雲頂の高さを出して高度 0〜17 km の層を歩く（体積の雲の第 1 段）・vol=false＝高度 alt の殻 1 枚（clouds-gl.js）。
// 骨格は人工衛星（sats.js）と同じ：器＝clouds.html／読み・詰め替え・UI＝ここ／GPU 描画＝clouds-gl.js（レンダーワーカー内・同一フレーム）。
//
// データ：静止気象衛星 5 機の赤外（10.4〜10.8 µm・昼も夜も）を直読み（どちらも CORS 開放・鯖焼き無し）。全機とも EPSG:4326 の同じ升目（段 L）＝タイル位置ごとに重ねる。
//   NASA GIBS の WMTS … Himawari（JMA・東経 140.7°）／GOES-West（NOAA・西経 137°）／GOES-East（NOAA・西経 75.2°）。10 分ごと。
//     画像は色つきの温度パレット（Clean_Longwave_Infrared_Window_Band）＝逆引きで輝度温度（℃）へ。
//     ⚠パレットは冷たい側（−80〜−70 ℃）にも灰色の段がある（230・204・177・155・129・102・76・54・27・5）＝暖かい側の灰色の階調（1〜197）と同じ濃さが二重に居る。
//     縮小段の中間の灰色（例 102）を完全一致で引くと暖かい海が −75 ℃ の雲になる（実測 9/29・画素の約 3%）＝灰色は「197 超＝冷たい側」
//     「197 以下＝暖かい側の階調で補間。ただし周り 8 画素に冷たい色つき（−60 ℃ 以下）があれば冷たい側」（対流の核の中の灰色）。色つきは色つきの項目だけから最寄り。
//   EUMETSAT の EUMETView（WMS）… Meteosat 0°（ヨーロッパ・アフリカ）／Meteosat IODC（東経 45.5°・中東とインド洋）。15 分ごと・2020 年から。
//     温度の表が無い 8 ビットの灰色（WCS の単位は放射輝度）＝灰色は放射輝度に比例と見て、重なる所の GIBS の温度と突き合わせて決めた（9/29 実測）：
//     灰色 = 262.95 − 28.84 × L（L＝10.8 µm のプランク放射輝度 W·m⁻²·sr⁻¹·µm⁻¹）。インド洋（IODC×Himawari）の分位点と大西洋（0°×GOES-East）の暖かい側で ±3 ℃。
// 重ね方：画素ごとに各衛星の直下点からの角度 γ で重み（cosγ が cos EDGE を超えた分の 2 乗）＝縁（斜めに見た所）ほど弱い・継ぎ目は重みでぼける。
// 渡す物：「冷たさ」1 バイト b＝(60−T)×1.6（0＝データ無し＝暖かい扱い）。雲らしさ（不透明度）への変換は GPU 側＝閾値を変えても取り直さない。
// 正直さ：緯度 75° より極側はどの静止衛星も斜めにしか見えない。低い暖かい雲（層積雲）は赤外では薄い。冬の極地・高地の冷たい地面は雲に見えることがある。
//   Meteosat の温度は上の突き合わせ（±3 ℃）。GIBS の保存はまだら（Himawari は約 1 年・GOES は欠けがある）＝読めない衛星はパネルに「なし」。
// 時刻：共通の時計（#42・map.clock）に従う＝実時間は最新の観測（10 分おきに見に行く）・時計を動かすとその時刻の観測（衛星の刻みへ丸める・未来は最新で止めて明示）。
// エンジンとの接点は公開面だけ：map.overlay（同一フレームのオーバーレイ・#13）・map.clock（共通の時計・太陽の向き）・map.cam（読む順）・mapEl。
import { sunSubpoint } from "@ortho-earth/ephem/sun";   // 太陽直下点＝雲の昼夜（夜の側と同じ正本）
import { tr, setLang, getLang, loadPage } from "@ortho-earth/globe/i18n.js";
import glUrl from "./clouds-gl.js?url";   // worker が import() する URL（⚠?worker&url は殻になる＝sats と同じ轍）＝モジュールは依存ゼロが掟
import { ENC, T_WARM } from "./clouds-gl.js";
const t = tr();

export const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best";
export const EUMETVIEW = "https://view.eumetsat.int/geoserver/wms";
const COLORMAP = "https://gibs.earthdata.nasa.gov/colormaps/v1.3/Clean_Longwave_Infrared_Window_Band.xml";
const MIN = 60e3;
// src＝gibs（WMTS・色の温度パレット）／wms（EUMETView・灰色＝放射輝度）。step＝観測の刻み。edge＝使う角度（EUMETView は重なりが広い＝少し狭く＝読むタイルを減らす）
export const SATS = [
	{ src: "gibs", id: "Himawari_AHI_Band13_Clean_Infrared", name: "Himawari", org: "JMA", lon: 140.7, step: 10 * MIN, edge: 78 },
	{ src: "gibs", id: "GOES-West_ABI_Band13_Clean_Infrared", name: "GOES-West", org: "NOAA", lon: -137.0, step: 10 * MIN, edge: 78 },
	{ src: "gibs", id: "GOES-East_ABI_Band13_Clean_Infrared", name: "GOES-East", org: "NOAA", lon: -75.2, step: 10 * MIN, edge: 78 },
	{ src: "wms", id: "msg_fes:ir108", name: "Meteosat 0°", org: "EUMETSAT", lon: 0, step: 15 * MIN, edge: 70 },
	{ src: "wms", id: "msg_iodc:ir108", name: "Meteosat IODC", org: "EUMETSAT", lon: 45.5, step: 15 * MIN, edge: 70 },
];
const TILE = 512;                                   // GIBS の EPSG:4326 は 512 px 四方（EUMETView も同じ升目で頼む）
const SPAN = [288, 144, 72, 36, 18, 9];             // 段 L のタイル 1 枚の度数（2km 系・段 0 は 2×1 枚）
const REFRESH_MS = 10 * MIN, SUN_MS = 20e3, POOL = 6, BACK = 3;
const STEP_MS = 10 * MIN;                           // 時計の刻み（GIBS の観測の刻み）
const isoOf = ms => new Date(ms).toISOString().slice(0, 19) + "Z";
const floorTo = (ms, step) => Math.floor(ms / step) * step;
const D2R = Math.PI / 180;

// ── GIBS のパレット（色 → ℃）＝画像 1 枚ぶんの RGBA を温度（NaN＝データ無し）へ ──
async function loadPalette(signal) {
	const xml = await (await fetch(COLORMAP, { signal })).text();
	const warm = [], coldGray = [], colored = [];
	for (const m of xml.matchAll(/rgb="(\d+),(\d+),(\d+)" transparent="false"[^>]*?sourceValue="([^"]*)"/g)) {
		const [r, g, b] = [+m[1], +m[2], +m[3]], v = m[4], n = v.match(/-?[\d.]+/g).map(Number);
		const T = v.includes("-INF") ? n[0] - 0.5 : v.includes("+INF") ? n[0] + 0.5 : (n[0] + n[1]) / 2;
		if (r === g && g === b) (T > -30 ? warm : coldGray).push([r, T]); else colored.push([r, g, b, T]);
	}
	if (warm.length < 50 || colored.length < 50) throw new Error("colormap parse failed");
	warm.sort((a, b) => a[0] - b[0]);
	const warmMax = warm[warm.length - 1][0];
	// 灰色 → ℃：暖かい側の階調を補間（中間の灰色も連続に）・冷たい側の灰色は最寄り
	const WARM = new Float32Array(256), COLD = new Float32Array(256);
	for (let v = 0, j = 0; v < 256; v++) {
		while (j < warm.length - 2 && warm[j + 1][0] < v) j++;
		const [g0, t0] = warm[j], [g1, t1] = warm[Math.min(j + 1, warm.length - 1)];
		WARM[v] = v <= warm[0][0] ? warm[0][1] : v >= warmMax ? warm[warm.length - 1][1] : t0 + (t1 - t0) * (v - g0) / Math.max(g1 - g0, 1);
		let best = Infinity; for (const [g, T] of coldGray) { const d = Math.abs(g - v); if (d < best) { best = d; COLD[v] = T; } }
	}
	// 色つき：完全一致 → 外れは色つきの項目だけから最寄り（32³ の箱の中心で）
	const exact = new Map(colored.map(([r, g, b, T]) => [(r << 16) | (g << 8) | b, T]));
	const near = new Float32Array(32 * 32 * 32);
	for (let i = 0; i < near.length; i++) {
		const r = ((i >> 10) << 3) + 4, g = (((i >> 5) & 31) << 3) + 4, b = ((i & 31) << 3) + 4;
		let best = Infinity; for (const p of colored) { const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (d < best) { best = d; near[i] = p[3]; } }
	}
	return (px, w, h) => {
		const n = w * h, T = new Float32Array(n).fill(NaN), coldC = new Uint8Array(n);
		for (let i = 0; i < n; i++) {                   // 1 回目：色つき
			const p = i * 4, r = px[p], g = px[p + 1], b = px[p + 2];
			if (px[p + 3] < 128 || (r === g && g === b)) continue;
			const v = exact.get((r << 16) | (g << 8) | b) ?? near[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
			T[i] = v; coldC[i] = v < -60 ? 1 : 0;
		}
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {   // 2 回目：灰色（冷たい色つきの隣だけ冷たい側）
			const i = y * w + x, p = i * 4, v = px[p];
			if (px[p + 3] < 128 || v !== px[p + 1] || v !== px[p + 2]) continue;
			if (v > warmMax) { T[i] = COLD[v]; continue; }
			let nb = 0;
			for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1) && !nb; yy++)
				for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) if (coldC[yy * w + xx]) { nb = 1; break; }
			T[i] = nb ? COLD[v] : WARM[v];
		}
		return T;
	};
}

// ── EUMETView の灰色 → ℃（灰色 = 262.95 − 28.84·L・L＝10.8 µm のプランク放射輝度）──
const MSG_T = (() => {
	const c1 = 1.191042e-16, c2 = 1.4387752e-2, lam = 10.8e-6, a = new Float32Array(256);
	for (let g = 0; g < 256; g++) { const L = Math.max((262.95 - g) / 28.84, 0.05) * 1e6; a[g] = c2 / (lam * Math.log(1 + c1 / (lam ** 5 * L))) - 273.15; }
	return a;
})();
function decodeGray(px, w, h) {
	const n = w * h, T = new Float32Array(n).fill(NaN);
	for (let i = 0; i < n; i++) { const p = i * 4; if (px[p + 3] >= 128) T[i] = MSG_T[px[p]]; }
	return T;
}

// ── 最新の観測時刻 ──
// GIBS＝DescribeDomains を直近 12 時間に絞る（数百 B）。EUMETView＝目録（GetCapabilities）は 280 KB と重い＝一つ前の刻みから読んでみて、無ければ前へ（BACK 段）
async function latestTime(sat, signal) {
	if (sat.src === "wms") return isoOf(floorTo(Date.now(), sat.step) - sat.step);
	const now = Date.now();
	const url = `${GIBS}/1.0.0/${sat.id}/default/2km/all/${isoOf(now - 12 * 3600e3)}--${isoOf(now + 3600e3)}.xml`;
	const xml = await (await fetch(url, { signal })).text();
	const dom = xml.match(/<Domain>([^<]*)<\/Domain>/)?.[1];
	const last = dom?.split(",").pop()?.split("/")[1];
	if (!last) throw new Error(`no time domain for ${sat.id}`);
	return last;
}
// タイル 1 枚の URL（段 L・行 row・列 col・時刻 tm）。EUMETView は WMS 1.3.0 の EPSG:4326＝bbox は 緯度,経度 の順
function tileUrl(sat, L, row, col, tm) {
	if (sat.src === "gibs") return `${GIBS}/${sat.id}/default/${tm}/2km/${L}/${row}/${col}.png`;
	const span = SPAN[L], n = 90 - row * span, s = Math.max(-90, n - span), w = -180 + col * span, e = w + span;
	const h = Math.round(TILE * (n - s) / span);   // 段 2 の最下行は南極より下へはみ出す＝−90 で切って縦の画素も縮める（上から詰める）
	return `${EUMETVIEW}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(sat.id)}&styles=&crs=EPSG:4326&bbox=${s},${w},${n},${e}&width=${TILE}&height=${h}&format=image/png&transparent=true&time=${tm}`;
}

// ── 画像 → RGBA（色の変換なし＝パレット・灰色の値そのまま）──
async function decodePng(blob) {
	const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
	const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d", { willReadFrequently: true });
	g.drawImage(bmp, 0, 0); bmp.close();
	return { px: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountClouds(map, { level, alt = 10000, vol = true, look, perf = false, panelHost } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/clouds/${c}.json`));   // 本番はこのチャンクの i18n.js が SDK と別実体＝自分で訳を用意してから UI を組む（sats と同じ）
	document.title = t("Clouds now — ortho-globe");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Infrared images from five geostationary weather satellites (Himawari, GOES, Meteosat), read straight from NASA GIBS and EUMETSAT and drawn in 3D over the globe at the time of the shared clock."));
	const mapEl = map.mapEl;
	const ac = new AbortController(), signal = ac.signal;
	const lowMem = (navigator.deviceMemory || 8) <= 4 || matchMedia("(max-width:640px)").matches;
	const L = Math.max(2, Math.min(5, level ?? (lowMem ? 2 : 3)));
	const span = SPAN[L], cols = Math.round(360 / span), rows = Math.ceil(180 / span);
	const texW = cols * TILE, texH = rows * TILE, vspan = rows * span;

	const ov = map.overlay(glUrl, { name: "clouds", opts: { alt, vol, perf, ...(look ? { look } : {}) } });
	let lastPerf = null;   // 計測（?perf=1）＝worker が 30 フレームごとに平均の描画時間（gl.finish 込み）を返す
	ov.onmessage = d => { if (d?.type === "perf") { lastPerf = d; console.log(`[clouds] ${d.mode} ${d.ms.toFixed(2)} ms (${d.how}) @ ${d.w}x${d.h}`); } };

	// ── パネル（sats と同じ意匠＝暗いガラス）──
	const panel = document.createElement("div");
	panel.className = "clouds-panel";
	panel.innerHTML = `
<style>
.clouds-panel{position:absolute;top:12px;right:12px;z-index:30;width:292px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;
 box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;background:rgba(12,17,32,.86);color:#e7ecf5;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.clouds-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.clouds-panel h1{font-size:15px;margin:0 0 2px;font-weight:700;letter-spacing:.02em}
.clouds-panel .fold{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e7ecf5;font-size:14px;line-height:1;cursor:pointer}
.clouds-panel.min .body{display:none}
.clouds-panel .sub{color:#9aa6bd;font-size:11.5px;margin-bottom:10px}
.clouds-panel .stat{font-variant-numeric:tabular-nums;color:#fff;margin:8px 0}
.clouds-panel .sat{display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-variant-numeric:tabular-nums}
.clouds-panel .sat em{font-style:normal;color:#9aa6bd}
.clouds-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
.clouds-panel .honest{color:#ffd479;font-size:11px;line-height:1.45;margin-top:6px}
@media (max-width:640px){.clouds-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:45%}}
</style>
<div class="head"><h1>${t("Clouds now")}</h1><button type="button" class="fold" data-k="fold" aria-label="${t("Collapse panel")}">−</button></div>
<div class="sub">${t("Infrared · NASA GIBS (Himawari: JMA · GOES: NOAA) · EUMETView (Meteosat: EUMETSAT)")}</div>
<div class="stat" data-k="status">${t("Loading cloud images…")}</div>
<div class="honest" data-k="ahead" style="display:none">${t("The clock is ahead of the newest images — showing the latest.")}</div>
<div class="body">
<div data-k="sats"></div>
<div class="note">${t("Cold cloud tops are drawn white and opaque; the same infrared image works day and night.")}<br>${t("Cloud-top height is estimated from the infrared temperature (6.5 °C per km below a rough surface temperature) and drawn at true scale — tilt the globe to see it.")}</div>
<div class="honest">${t("Beyond about 75° latitude no geostationary satellite sees well, and low warm clouds are faint in infrared. Meteosat temperatures are matched to Himawari and GOES from the image grey levels (about ±3 °C).")}</div>
</div>`;
	(panelHost || mapEl).appendChild(panel);
	const $ = k => panel.querySelector(`[data-k="${k}"]`);
	const setFold = min => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? t("Expand panel") : t("Collapse panel")); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	setFold(matchMedia("(max-width:640px)").matches);
	const fmtTime = iso => { const d = new Date(iso); return d.toLocaleString(getLang(), { ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
	const ago = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60e3));
	const showSats = (times, live) => {
		$("sats").innerHTML = SATS.map((s, i) => `<div class="sat"><span>${s.name} <em>${s.org}</em></span><span>${times[i] ? `${fmtTime(times[i])}${live ? ` <em>${t("$1 min ago", ago(times[i]))}</em>` : ""}` : `<em>${t("unavailable")}</em>`}</span></div>`).join("");
	};

	// ── 時刻＝共通の時計（#42・map.clock）。実時間＝最新の観測・時計を動かした＝その時刻の観測（10 分刻み）──
	const simNow = () => map.clock ? map.clock.time : Date.now();
	const want = () => map.clock && !map.clock.isLive() ? Math.floor(map.clock.time / STEP_MS) * STEP_MS : null;   // null＝実時間
	const postSun = () => { const [lon, dec] = sunSubpoint(simNow()), c = Math.cos(dec); ov.post({ type: "sun", dir: [c * Math.cos(lon), Math.sin(dec), c * Math.sin(lon)] }); };
	postSun();
	const sunT = setInterval(postSun, SUN_MS);

	// ── 読み込み（時刻 → タイル位置ごとに 3 機を読んで重ねる → 冷たさを送る）──
	// 一度に走る読み込みは 1 本。読み終えた時に時計が別の刻みへ進んでいたら、その一番新しい刻みだけ読み直す（行列を作らない＝早送りでも溜まらない）。
	// 時計が 1 時間より大きく飛んだら読みかけは捨てる。GIBS は no-store（手元に残らない）＝同じ時刻へ戻ると取り直す
	const palP = loadPalette(signal);
	let latest = SATS.map(() => null), latestAt = 0;    // 最新の観測（衛星ごと ISO）と、それを聞いた時刻
	let loadedKey = "", loading = null, gridSent = false;
	const refreshLatest = async () => {
		latest = await Promise.all(SATS.map(s => latestTime(s, signal).catch(e => { if (e?.name === "AbortError") throw e; console.warn("[clouds] time", s.name, e?.message); return null; })));
		latestAt = Date.now();
	};
	const timesFor = w => SATS.map((s, i) => !latest[i] ? null : w == null ? latest[i] : isoOf(floorTo(Math.min(w, Date.parse(latest[i])), s.step)));   // 衛星の刻みへ丸める
	const setStatus = (w, done, n) => {
		const ahead = w != null && latest.some(x => x && w > Date.parse(x));   // 時計が最新の観測より先＝最新で止めている
		$("status").textContent = done < n ? t("Loading cloud images… $1/$2", done, n) : w == null || ahead ? t("Latest images loaded") : t("Images for $1", fmtTime(isoOf(w)));
		$("ahead").style.display = ahead ? "" : "none";
	};
	const kick = async () => {
		if (loading || signal.aborted) return;
		const w = want();
		try {
			if (w == null || !latestAt || Date.now() - latestAt > REFRESH_MS) await refreshLatest();
		} catch (e) { if (e?.name !== "AbortError") $("status").textContent = t("Could not load cloud images"); return; }
		const times = timesFor(w), key = times.join("|");
		if (key === loadedKey) { setStatus(w, 1, 1); return; }
		const lac = new AbortController(), off = () => lac.abort();
		signal.addEventListener("abort", off);
		loading = { key, w, ac: lac };
		try {
			const used = await loadTimes(times, lac.signal, w);
			loadedKey = key;
			showSats(used, w == null);
			setStatus(w, 1, 1);
		} catch (e) {
			if (e?.name !== "AbortError") { console.error("[clouds] load failed", e); $("status").textContent = t("Could not load cloud images"); }
		} finally { loading = null; signal.removeEventListener("abort", off); }
		const w2 = want();
		if (!signal.aborted && w2 !== w) kick();   // 読んでいる間に時計が進んだ＝追いかける
	};
	const loadTimes = async (times, sig, w) => {
		const toPal = await palP;
		// タイル位置 → その位置を見ている衛星（直下点から edge° 以内に掛かる列・緯度 ±78° に掛かる行）
		const jobs = [];
		for (let row = 0; row < rows; row++) {
			const n = 90 - row * span, s = Math.max(-90, n - span);
			if (s > 78 || n < -78) continue;
			for (let col = 0; col < cols; col++) {
				const mid = -180 + (col + 0.5) * span;
				const who = SATS.map((sat, i) => times[i] && Math.abs(((mid - sat.lon + 540) % 360) - 180) - span / 2 < sat.edge ? i : -1).filter(i => i >= 0);
				jobs.push({ row, col, who });   // 誰も見ていない位置も送る（前の時刻の雲を残さない＝空で上書き）
			}
		}
		if (!gridSent) { ov.post({ type: "grid", w: texW, h: texH, vspan }); gridSent = true; }
		const used = SATS.map(() => null);
		let done = 0;
		setStatus(w, 0, jobs.length);
		const one = async ({ row, col, who }) => {
			// GIBS は最新時刻を目録に載せてから全タイルが焼き上がるまで数分かかる（その間は 404＝CORS ヘッダ無しで fetch が投げる・実測 9/29）
			// ・定時の欠測もある・EUMETView の最新は推定＝読めなければ衛星の刻みずつ前へ BACK 段まで下がる。実際に使った時刻は衛星ごとに一番古いものをパネルへ（正直さ）
			const imgs = await Promise.all(who.map(async i => {
				const sat = SATS[i];
				for (let k = 0; k <= BACK; k++) {
					const tm = isoOf(Date.parse(times[i]) - k * sat.step), url = tileUrl(sat, L, row, col, tm);
					try {
						const r = await fetch(url, { signal: sig }); if (!r.ok) throw new Error(r.status);
						if (!(r.headers.get("content-type") || "").startsWith("image/")) throw new Error("not an image");   // WMS の例外は XML で 200 が来る
						const im = await decodePng(await r.blob());
						const T = sat.src === "gibs" ? toPal(im.px, im.w, im.h) : decodeGray(im.px, im.w, im.h);
						if (!used[i] || tm < used[i]) used[i] = tm;
						return { i, T, w: im.w, h: im.h };
					} catch (e) { if (e?.name === "AbortError") throw e; if (k === BACK) console.warn("[clouds] tile", sat.name, tm, row, col, e?.message); }
				}
				return null;
			}));
			const out = new Uint8Array(TILE * TILE);
			const w0 = -180 + col * span, n0 = 90 - row * span, dpx = span / TILE;
			// 重み＝cos(lat)·cos(lon−直下経度) − cos(edge) の正の部分を 2 乗（縁ほど弱い＝継ぎ目がぼける）
			const cosLat = new Float32Array(TILE); for (let y = 0; y < TILE; y++) cosLat[y] = Math.cos((n0 - (y + 0.5) * dpx) * D2R);
			const cosDl = imgs.map(im => { if (!im) return null; const a = new Float32Array(TILE); for (let x = 0; x < TILE; x++) a[x] = Math.cos((w0 + (x + 0.5) * dpx - SATS[im.i].lon) * D2R); return a; });
			const cosEdge = imgs.map(im => im ? Math.cos(SATS[im.i].edge * D2R) : 1);
			for (let y = 0; y < TILE; y++) {
				if (n0 - (y + 0.5) * dpx < -90) break;
				for (let x = 0; x < TILE; x++) {
					let sw = 0, st = 0;
					for (let k = 0; k < imgs.length; k++) {
						const im = imgs[k]; if (!im || y >= im.h || x >= im.w) continue;
						const T = im.T[y * im.w + x]; if (T !== T) continue;   // NaN＝円盤の外・データ無し
						const c = cosLat[y] * cosDl[k][x] - cosEdge[k]; if (c <= 0) continue;
						const wt = c * c;
						sw += wt; st += wt * T;
					}
					if (sw > 0) out[y * TILE + x] = Math.max(1, Math.min(255, Math.round((T_WARM - st / sw) * ENC)));
				}
			}
			if (sig.aborted) return;
			ov.post({ type: "tile", x: col * TILE, y: row * TILE, w: TILE, h: TILE, data: out }, [out.buffer]);
			setStatus(w, ++done, jobs.length);
		};
		// 同時 POOL 本。いま見ている所から先に（画面の中心に近いタイル位置から）
		const [clon, clat] = map.cam.center, cx = (clon + 180) / span - 0.5, cy = (90 - clat) / span - 0.5;
		const dcol = c => { const d = Math.abs(c - cx) % cols; return Math.min(d, cols - d); };
		jobs.sort((a, b) => Math.hypot(dcol(a.col), a.row - cy) - Math.hypot(dcol(b.col), b.row - cy));
		let next = 0;
		await Promise.all(Array.from({ length: POOL }, async () => { while (next < jobs.length && !sig.aborted) await one(jobs[next++]); }));
		if (sig.aborted) throw new DOMException("aborted", "AbortError");
		return used;
	};
	// 時計が刻み（10 分）を跨いだ＝太陽を回して読み直す。1 時間より大きく飛んだら読みかけを捨てる
	let lastWant = want(), kickT = 0;
	const onClock = () => {
		const w = want();
		if (w === lastWant) return;
		lastWant = w; postSun();
		if (loading) { const lw = loading.w; if ((w == null) !== (lw == null) || (w != null && Math.abs(w - lw) > 3600e3)) loading.ac.abort(); }
		clearTimeout(kickT); kickT = setTimeout(kick, 250);
	};
	map.clock?.on("change", onClock).on("tick", onClock);
	await kick();
	const refT = setInterval(() => { if (!document.hidden && want() == null) kick(); }, REFRESH_MS);   // 実時間の時だけ新しい観測を見に行く

	return {
		get loaded() { return loadedKey !== ""; },     // 一度でも全タイルを読み終えた（verify-prod の起動判定）
		reload: () => { loadedKey = ""; return kick(); },
		style: s => ov.post({ type: "style", ...s }),   // { vol:bool, alt:m（殻）, look:[地表の目安より何度冷たければ雲か, 真っ白の温度℃, ガンマ, 最大不透明度], fadeLod }
		perf: on => { ov.post({ type: "perf", on: on !== false }); return lastPerf; },
		destroy() { ac.abort(); clearInterval(sunT); clearInterval(refT); clearTimeout(kickT); map.clock?.off("change", onClock).off("tick", onClock); ov.remove(); panel.remove(); },
	};
}
