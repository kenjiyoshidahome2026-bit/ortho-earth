// 星空劇場（z<4）＝実在星表（stars.6）・惑星（ケプラー近似）・月の満ち欠け・星座線と星座名・メシエ天体・黄道と天の赤道・
// 日時計の家具・太陽系圏（z<1・solarsky.js）との交代。v1 ortho-map の星空アクセサリーの移植。
// app.js の一塊（旧 1201〜1391 行＋render() の太陽系圏 8 行）を**動作を変えずに**ここへ移した（2026-09-17・plateau/gint と同じ作法）。
// env … mapEl, renderer, dpr, cam, STARSKY_Z, solarOff（生成前に定義済み）／printHold・saveView・requestDraw（app の状態と口）
// 戻り値 … ensureStars（z<STARSKY_Z に初めて出た時に一度だけ読む）／toggleConstellations・applyConstellations（星座の点灯）／
//          solarFrame(w,h)（render() 毎の太陽系圏の出入り）／terminate()（惑星・日時計のタイマー＝destroy）
import { geopbf } from "geopbf";
import { getLang } from "../i18n.js";

const D2R = Math.PI / 180;

export function createSkyTheater(env) {
const { mapEl, renderer, dpr, cam, STARSKY_Z, solarOff, requestDraw } = env;

// --- 星空劇場（z<4・v1 ortho-map の星空アクセサリー移植）---
// stars.6（実在星表：RA/Dec・等級・B-V色指数）を天球単位ベクトル＋色＋点径に焼いて render worker へ。
// 向きは恒星時(GMST)＝engine が毎描画で回す（実時刻の空）。クリックで星座線（constellation_lines）をトグル。
const bvColor = v => v < -0.3 ? "#b2c8ff" : v < 0.0 ? "#d9e2ff" : v < 0.3 ? "#f8faff" : v < 0.6 ? "#fff8f0" :
	v < 0.8 ? "#fff2c8" : v < 1.1 ? "#ffe0b5" : v < 1.4 ? "#ffcc99" : "#ffab91";   // v1 border.js と同表
const celVec = (raDeg, decDeg) => {
	const ra = raDeg * D2R, dec = decDeg * D2R, cd = Math.cos(dec);
	return [cd * Math.cos(ra), Math.sin(dec), cd * Math.sin(ra)];
};
// 星空モジュール（planets/skynames＝z<4専用・計~12K）は初期バンドルに載せず、初めて星空パスに入る時に一度だけ動的読込。
// 読込後に下の holder へ注入＝以降の updatePlanets/toggleConstellations は従来どおり同期的に使える（memo化＝多重読込なし）。
let planetPositions, moonPosition, sunPosition, constellationJa;
let _skyLoad = null;
const ensureSkyMod = () => (_skyLoad ??= Promise.all([import("../planets.js"), import("../skynames.js")]).then(([p, s]) => {
	({ planetPositions, moonPosition, sunPosition } = p); ({ constellationJa } = s);
}));
let starsArmed = true;
function ensureStars() { if (starsArmed && cam.zoom < STARSKY_Z) { starsArmed = false; loadStars(); ensureSkyMod().then(startPlanets); } }
// 惑星（実位置・低精度ケプラー＝planets.js）：星と同じ点バッファ形式で常設。名前は注記トグル(skyLabels)側。
// 位置は10分毎に再計算（最速の水星でも0.03°/10分＝表示上は静止と同じだが、開きっぱなしの夜に正直でいる）。
let planetTimer = null, planetLabels = [];
let solarSky = null, solarSkyLoad = null, inSolarPrev = false;   // 太陽系圏（z<1）＝solarsky.js の状態
function updatePlanets() {
	const now = new Date();
	// 太陽系圏＝ドーム表現（天球方向のみ・距離なし）は世界表現（solarsky＝実位置3D）と矛盾する＝引っ込めて交代
	if (!solarOff && cam.zoom < 1) {
		renderer.set("planets", new Float32Array(0));
		renderer.set("skyMoon", null);
		planetLabels = [];
		if (skyLabels) { skyLabels.planets = []; if (constelVisible) renderer.set("skyLabels", skyLabels); }
		requestDraw();
		return;
	}
	const ps = planetPositions(now), moon = moonPosition(now), sun = sunPosition(now);
	const buf = new Float32Array(ps.length * 8);
	ps.forEach((p, i) => {
		const [x, y, z] = celVec(p.ra, p.dec);
		buf.set([x, y, z, p.color[0], p.color[1], p.color[2],
			Math.max(0, 1 - p.mag / 15), Math.max(2, (9 - p.mag) * 0.4 * dpr)], i * 8);
	});
	renderer.set("planets", buf);
	// 月＝満ち欠けの円盤（ラベルcanvas・欠け側は赤黒）。輝面比 k=(1-cosψ)/2（ψ=太陽との離角。月距離≪太陽距離の近似）
	const mCel = celVec(moon.ra, moon.dec), sCel = celVec(sun.ra, sun.dec);
	const k = (1 - (mCel[0] * sCel[0] + mCel[1] * sCel[1] + mCel[2] * sCel[2])) / 2;
	renderer.set("skyMoon", { cel: mCel, sunCel: sCel, k });
	planetLabels = [...ps, moon].map(p => ({ cel: celVec(p.ra, p.dec), name: p.name }));
	if (skyLabels) {
		skyLabels.planets = planetLabels;
		if (constelVisible) renderer.set("skyLabels", skyLabels);
	}
	requestDraw();
}
// 星空劇場の家具（quiet-monoの逆相家具＝#map.worldでだけ点灯）：左下=日時計（1秒針）、右下=空データの出典。
// 「実時刻の空」を名乗る劇場の証書＝今この瞬間を刻む時計と、データの出どころ。
const skyClockEl = document.createElement("div");
skyClockEl.id = "sky-clock";
mapEl.appendChild(skyClockEl);
// （旧 #sky-attr＝星空専用の出典別要素は廃止 2026-09-03「attr表示を各ズームで綺麗に統合」＝
//   #attr 一枚が圏で差し替わる。星空圏の文面は render() の attrZone="sky" 節）
const SKY_WD = getLang() === "ja" ? ["日", "月", "火", "水", "木", "金", "土"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const skyClockTimer = setInterval(() => {
	if (cam.zoom >= STARSKY_Z) return;   // 見えていない間はDOMに触れない（星空圏の外）
	const d = new Date(), L2 = n => String(n).padStart(2, "0");
	skyClockEl.textContent = `${d.getFullYear()}/${L2(d.getMonth() + 1)}/${L2(d.getDate())} (${SKY_WD[d.getDay()]}) ${L2(d.getHours())}:${L2(d.getMinutes())}:${L2(d.getSeconds())}`;
}, 1000);

function startPlanets() {
	if (planetTimer) return;
	updatePlanets();
	planetTimer = setInterval(updatePlanets, 600000);   // 最速の月でも0.09°/10分＝表示上は連続
	// 黄道（黄緯0の大円・J2000）＝淡い黄：太陽・月・惑星の通り道。天の赤道（赤緯0）＝淡い青灰：
	// 地球の赤道の空への投影＝GMSTで空が回る軸の「胴回り」。二本の交点が春分点・秋分点、開き23.4°が地軸の傾き
	// ＝季節の仕組みがそのまま絵になる。どちらも注記トグル(showConst)と同時に出る。
	const es = [], qs = [], eps = 23.43928 * D2R;
	for (let l = 0; l < 360; l += 2) for (const g of [l, l + 2]) {
		const s = Math.sin(g * D2R), c = Math.cos(g * D2R);
		es.push(c, s * Math.sin(eps), s * Math.cos(eps));
		qs.push(c, 0, s);
	}
	renderer.set("ecliptic", Float32Array.from(es));
	renderer.set("celequator", Float32Array.from(qs));
}
async function loadStars() {
	const pbf = await geopbf("stars.6", { gint: false }).catch(e => { console.warn("[stars] load failed", e); return null; });
	const g = pbf && pbf.geojson;
	if (!g) { starsArmed = true; return; }   // 一過性失敗は次の機会に再試行
	const fs = g.features;
	const buf = new Float32Array(fs.length * 8);
	for (let i = 0; i < fs.length; i++) {
		const { mag, bv } = fs[i].properties, [ra, dec] = fs[i].geometry.coordinates;
		const hex = bvColor(bv);
		const [x, y, z] = celVec(ra, dec);
		buf.set([x, y, z,
			parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255,
			Math.max(0, 1 - mag / 15),                    // 等級→明るさ（v1と同式）
			Math.max(1.5, (9 - mag) * 0.4 * dpr)], i * 8);   // 等級→点径（v1の半径0.2css相当をdevice pxへ）
	}
	renderer.set("stars", buf);
	requestDraw();
	console.log(`[stars] ${fs.length} stars loaded (drawn at z<4; click for constellation lines)`);
}
// 星座線＋星座名＋メシエ天体：クリックでトグル（v1と同じ所作＝三点一組）。初回クリックでロード→表示、以降は表示反転のみ。
// 線は GL（render worker）、名前と記号はラベルcanvas（skyLabels）＝どちらも同じ変換・同じタイミングで出入りする。
let constelState = 0, constelVisible = false, skyLabels = null;   // 0=未読込 1=読込中 2=読込済
// 表示の実務（点灯希望×圏の裁き→engine）。トグル・URL同期・太陽系圏の出入りの三者が共用＝経路一本。
// 旧・太陽系圏(z<1)は休演だったが、点灯（l=sky）していれば太陽系圏でも出す（本人裁定 2026-09-02
// 「z<1以下でも、l=sky があれば星座線を出していい」）＝星座は無限遠の天球＝実位置3Dの惑星と矛盾しない。
// 惑星ドーム（updatePlanets）だけは従来どおり z<1 で引っ込める（距離を持つ天体は solarsky の実位置3Dと二重になる）。
function constelApply() {
	const show = constelState === 2 && constelVisible;
	// skySolar＝太陽系圏(z<1)の空モード（本人裁定 2026-09-02）：星座線だけ薄く残し、黄道/天の赤道は消灯
	//（レンダラ側が裁く・両バックエンド）、星座名・メシエ等のテキスト注記も全消し（ラベル投影が太陽系圏の
	// カメラと合わず表示が乱れる＝線のみが正）。呼び出しは圏の出入りで必ず来る（休演/再点灯の一本化と同じ口）。
	const solar = !solarOff && cam.zoom < 1;
	renderer.set("view", { showConst: show, skySolar: solar });
	renderer.set("skyLabels", show && !solar ? skyLabels : null);
	const sc = document.getElementById("chip-sky");   // 表示パネルの星空チップ＝点火の一本道でだけ見た目同期
	if (sc) { sc.classList.toggle("on", constelVisible); sc.setAttribute("aria-pressed", String(constelVisible)); }
	requestDraw();
}
async function toggleConstellations() {
	if (constelState === 1) return;
	if (constelState === 2) {
		constelVisible = !constelVisible;
		constelApply();
		return;
	}
	constelState = 1;
	await ensureSkyMod();   // 星座名の日本語化(skynames)を使う前に星空モジュールの読込を保証（初回z<4で通常は既済）
	const [cl, ms] = await Promise.all([
		geopbf("constellation_lines", { gint: false }).catch(e => { console.warn("[constellation] load failed", e); return null; }),
		geopbf("messier", { gint: false }).catch(() => null),   // 任意（v1と同じ＝無ければ星座線と名前だけ）
	]);
	const g = cl && cl.geojson;
	if (!g) { constelState = 0; return; }
	const seg = [], consts = [];
	for (const f of g.features) {
		const lines = f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates];
		for (const line of lines) for (let i = 0; i < line.length - 1; i++)
			seg.push(...celVec(line[i][0], line[i][1]), ...celVec(line[i + 1][0], line[i + 1][1]));
		// 星座名の置き場＝全頂点の天球ベクトル平均を正規化（v1のra/dec単純平均はRA 0/360跨ぎの星座で狂う。ベクトル平均は跨ぎ無縁）
		// 名前は日本語化（skynames.js＝IAU略号/ラテン名の両対応。v2=japanの流儀＝惑星名と揃える）
		const name = constellationJa(f.properties?.name ?? f.properties?.id ?? f.id);
		if (name) {
			let vx = 0, vy = 0, vz = 0;
			for (const line of lines) for (const p of line) { const v = celVec(p[0], p[1]); vx += v[0]; vy += v[1]; vz += v[2]; }
			const l = Math.hypot(vx, vy, vz) || 1;
			consts.push({ cel: [vx / l, vy / l, vz / l], name });
		}
	}
	const messier = [];
	if (ms && ms.geojson) for (const f of ms.geojson.features) {
		const c = f.geometry.coordinates;
		messier.push({ cel: celVec(c[0], c[1]), name: f.properties?.name || "", type: f.properties?.type || "" });
	}
	skyLabels = { constellations: consts, messier, planets: planetLabels };   // 惑星名も注記の一員（位置は updatePlanets が更新）
	renderer.set("constellations", Float32Array.from(seg));
	constelState = 2; constelVisible = true;
	constelApply();
	console.log(`[constellation] ${consts.length} constellations + ${messier.length} Messier objects loaded (click to toggle)`);
	if (!env.printHold) env.saveView();   // 初回ロード(2秒級)中に settle の saveView が sky 抜きで先行する＝完了後に l=sky を書き戻す（レース根治・モバイル実測）
}
// URL(l=sky)⇄星座表示の冪等同期：望む状態と違う時だけ toggle を叩く（未読込なら読込→表示、読込済なら反転）。
// z によらず状態を確定させる＝共有URLの往復で消えない（z<4に降りた時に実際に描かれる。worldFade が可視ゲート）。
function applyConstellations(want) { if (!!want !== constelVisible) toggleConstellations(); }


// 太陽系圏（z<1）：Canvas2D の薄いオーバーレイ（solarsky.js＝遅延ロード）が太陽・惑星・軌道線を実位置で重ねる。
// カメラは engine と同じ cameraState を共有＝星空・地球と厳密に整合。圏の出入りでドーム惑星（方向のみ表現）と交代。
// render() が毎フレーム呼ぶ（旧 app.js render() の 8 行をそのまま）。
function solarFrame(w, h) {
	const inSolar = !solarOff && cam.zoom < 1;
	if (inSolar && !solarSkyLoad) solarSkyLoad = import("../solarsky.js").then(m => { solarSky = m.createSolarSky({ mapEl }); requestDraw(); }).catch(e => console.warn("[solar] zone load failed", e));
	solarSky?.frame(cam, w, h, inSolar);
	if (inSolar !== inSolarPrev) {
		inSolarPrev = inSolar;
		if (planetTimer) updatePlanets();   // ドーム惑星/月の点灯切替を即時反映
		if (constelState === 2) constelApply();   // 星座注記の休演/再点灯（裁きは constelApply に一本化）
	}
}
function terminate() { clearInterval(planetTimer); clearInterval(skyClockTimer); }   // destroy：惑星の再計算・日時計
return { ensureStars, toggleConstellations, applyConstellations, solarFrame, terminate, get constelVisible() { return constelVisible; } };   // constelVisible＝共有 URL の l=sky（viewHash / map.view）が読む
}
