// 市のデジタルツインの共通の台帳と純関数（横浜市 2026-10-18〜 から切り出し・京都市と共用・2026-11-14）＝描画を持たない（Node の検定がそのまま読む）。
// 市ごとの物（区・名所・地下鉄・救急・物語）は各アプリの city 設定（CityConfig）＝apps/<市>/data.ts。ここは全国で同じ物（面・施設の区分・用途地域・ハザードの型紙・
// URL の状態・地点の調べ・歩ける道（OSM）の網と Dijkstra・通信なしの束のタイルの篩・通信なしの地名検索）。
// 座標は WGS84。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。

export interface Ward { code: string; /** 日本語の名（住所の照合に使う） */ name: string; /** 訳の鍵（i18n/pages/yokohama.json） */ en: string; lon: number; lat: number; zoom: number }
export interface Spot { id: string; /** ja.wikipedia の記事名（写真の出どころ） */ wiki: string; name: string; ward: string; lon: number; lat: number; zoom: number; tilt: number; bearing: number; note: string; /** 止まった時に地図に立てる名札（三塔のキング・クイーン・ジャックなど） */ marks?: { name: string; lon: number; lat: number }[]; /** 最寄り駅を測る点（無い＝lon/lat）＝カメラの点が広い街の端にある時に街の真ん中から測る（中華街＝カメラは西寄り・元町・中華街駅が 3 番目に落ち、道のりも大回りになった・Mac 実測 2026-11-13） */ near?: [number, number] }
export interface Legend { color: string; label: string; /** 画素の照合だけに使う、同じ帯のほかの色（凡例には出さない） */ match?: string[] }
export interface Hazard { id: string; name: string; urls: string[]; maxZoom: number; legend: Legend[]; note: string }
export interface TwinState { tab: Tab; ward: string; hz: string[]; spot: string; tr: string[] }
/** 面＝観光・交通・防災・解析（2026-10-21 に「まち」→「観光」・「時間」を外し「交通」を足した） */
export type Tab = "life" | "transit" | "sight" | "risk" | "tools";
export const TAB_NAMES: Record<Tab, string> = { life: "Daily life", transit: "Transport", sight: "Sightseeing", risk: "Disasters", tools: "Analysis" };

/** 名所の写真の 1 件（photos.json・Wikimedia Commons の代表画像） */
export interface Photo { src: string; file: string; artist: string; license: string; page: string }

/** 市営地下鉄の路線と駅番号（駅ナンバリング）。地図の駅は N02 の駅名で引き当てて記号を付ける */
export interface SubwayLine { id: string; name: string; color: string; stations: string[]; /** 駅名のローマ字（日本語以外の UI・stations と同じ並び） */ romaji: string[] }
/** 駅名 → 駅番号の並び（"B29"・"G04"…）。乗換駅（横浜のセンター南・北・京都の烏丸御池）は 2 つ。名前の揺れ（ヶ・ケ）は畳む */
const normSta = (n: string) => String(n || "").replace(/ケ/g, "ヶ").replace(/駅$/, "").trim();
export function subwayCodes(lines: readonly SubwayLine[], name: string): { code: string; line: SubwayLine }[] {
	const n = normSta(name), out: { code: string; line: SubwayLine }[] = [];
	for (const l of lines) { const i = l.stations.findIndex(s => normSta(s) === n); if (i >= 0) out.push({ code: `${l.id}${String(i + 1).padStart(2, "0")}`, line: l }); }
	return out;
}
/** 交通の層の 1 行（地下鉄・JR と私鉄・市営バス）。JR と私鉄の行は全国で同じ */
export interface TransitLayer { id: "subway" | "rail" | "bus"; name: string }
export const RAIL_LAYER: TransitLayer = { id: "rail", name: "JR and private railway stations and lines" };

/** 公共施設の区分（bake-yokohama.mjs の CATS と同じ並び＝facilities.json の区分の番号）。色＝地図の点と凡例 */
export const FACILITY_CATS = [
	{ name: "Ward offices and government", color: "#d84315" }, { name: "Community centers and halls", color: "#8e24aa" }, { name: "Schools", color: "#1e88e5" },
	{ name: "Libraries and culture", color: "#00897b" }, { name: "Fire stations", color: "#e53935" }, { name: "Police", color: "#3949ab" }, { name: "Hospitals", color: "#43a047" },
];
/** 用途地域（都市計画法の 13 種）＝zoning.json の n（正式名）で引く。色＝用途地域図の慣例（住居系＝緑〜黄・商業系＝桃〜赤・工業系＝紫〜青） */
export const ZONES: { ja: string; name: string; color: string }[] = [
	{ ja: "第一種低層住居専用地域", name: "Category 1 low-rise exclusive residential", color: "#2e9b5f" },
	{ ja: "第二種低層住居専用地域", name: "Category 2 low-rise exclusive residential", color: "#7cc576" },
	{ ja: "第一種中高層住居専用地域", name: "Category 1 mid/high-rise exclusive residential", color: "#a8d86e" },
	{ ja: "第二種中高層住居専用地域", name: "Category 2 mid/high-rise exclusive residential", color: "#d4e88a" },
	{ ja: "第一種住居地域", name: "Category 1 residential", color: "#f6e27a" },
	{ ja: "第二種住居地域", name: "Category 2 residential", color: "#f3c96b" },
	{ ja: "準住居地域", name: "Quasi-residential", color: "#f2b25c" },
	{ ja: "田園住居地域", name: "Rural residential", color: "#c9a46a" },
	{ ja: "近隣商業地域", name: "Neighborhood commercial", color: "#f4a3b8" },
	{ ja: "商業地域", name: "Commercial", color: "#e8556d" },
	{ ja: "準工業地域", name: "Quasi-industrial", color: "#b58fd0" },
	{ ja: "工業地域", name: "Industrial", color: "#8fc7e8" },
	{ ja: "工業専用地域", name: "Exclusively industrial", color: "#4f8fd0" },
];
/** 平面の地区地図に重ねる区域（台帳＝ortho-data/japan/yokohama/<file>・bake-yokohama.mjs）。zoning は塗り分け・他は線と淡い塗り（押すと名前） */
export const AREAS = [
	{ id: "zoning", file: "zoning.json", name: "Land-use zoning", color: "" },
	{ id: "school-e", file: "school-e.json", name: "Elementary school districts", color: "#1e88e5" },
	{ id: "school-j", file: "school-j.json", name: "Junior high school districts", color: "#8e24aa" },
	{ id: "police", file: "police-areas.json", name: "Police station jurisdictions", color: "#3949ab", hide: true },   // hide＝一覧に出さない（本人 2026-10-26「警察署・消防署の管轄は非表示に」。台帳と描く仕組みは残す）
	{ id: "fire", file: "fire-areas.json", name: "Fire station jurisdictions", color: "#e53935", hide: true },
] as const;
export type AreaId = typeof AREAS[number]["id"];

/** 施設の種別ごとの出し入れ（本人 2026-10-21「それぞれでトグル」）＝区分（FACILITY_CATS）の中を、台帳の種別（行の 6 列目）で束ねる。並びが番号 */
export const FACILITY_SUBS: { cat: number; name: string; kinds: string[] }[] = [
	{ cat: 0, name: "Ward offices", kinds: ["区役所"] },
	{ cat: 0, name: "National and prefectural offices", kinds: ["国の機関", "国・県の機関", "県の機関"] },
	{ cat: 0, name: "Service counters", kinds: ["行政サービス窓口"] },
	{ cat: 1, name: "Community centers and halls", kinds: ["集会施設"] },
	{ cat: 2, name: "Elementary schools", kinds: ["小学校", "義務教育学校"] },
	{ cat: 2, name: "Junior high schools", kinds: ["中学校"] },
	{ cat: 2, name: "High schools", kinds: ["高等学校"] },
	{ cat: 2, name: "Special needs schools", kinds: ["特別支援学校"] },
	{ cat: 2, name: "Universities and colleges", kinds: ["大学", "専修学校"] },
	{ cat: 3, name: "Libraries", kinds: ["図書館"] },
	{ cat: 3, name: "Museums", kinds: ["博物館・資料館", "美術館"] },
	{ cat: 3, name: "Zoos and aquariums", kinds: ["動植物園", "水族館"] },
	{ cat: 4, name: "Fire stations and headquarters", kinds: ["消防本部", "消防署"] },   // 区分の名（Fire stations＝消防）と同じ名にしない＝チップが「消防 / 消防」と二重に見えた
	{ cat: 4, name: "Fire branch offices", kinds: ["出張所"] },
	{ cat: 5, name: "Police stations", kinds: ["警察署", "警察本部", "警察学校"] },
	{ cat: 5, name: "Police boxes", kinds: ["交番", "派出所", "駐在所", "地域安全センター"] },
	{ cat: 6, name: "Hospitals", kinds: ["病院"] },
];
/** 行 → 種別の番号（台帳に新しい種別が出たら、その区分の先頭の種別へ寄せる） */
export function subOf(cat: number, kind: string): number {
	const i = FACILITY_SUBS.findIndex(s => s.cat === cat && s.kinds.includes(kind));
	return i >= 0 ? i : FACILITY_SUBS.findIndex(s => s.cat === cat);
}
/** 施設の 1 行＝[経度, 緯度, 名称, 区分の番号, 住所, 種別] */
export type FacilityRow = [number, number, string, number, string, string];
/** 施設の検索（common/bigtable の表・本人 2026-10-22）に載せる行＝区（ward・空＝全市）と出している種別（subs）で絞った台帳の行番号。並びは台帳のまま */
export function facilityIndex(city: CityWards, rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>): number[] {
	const w = city.wards.find(x => x.code === ward), out: number[] = [];
	rows.forEach((r, i) => { if (subs.has(subOf(r[3], r[5])) && (!w || wardOfAddress(city, r[4])?.code === w.code)) out.push(i); });
	return out;
}
/** 鉄道の駅の 1 行＝[経度, 緯度, 駅名, "事業者 路線・…", 地下鉄なら 1] */
export type StationRow = [number, number, string, string, number];
/** 市営バスの停留所の 1 行＝[経度, 緯度, 停留所名, "系統・…"] */
export type BusRow = [number, number, string, string];

/** 物語（横浜＝港の物語・京都＝千二百年の物語）の 1 章。写真は photo（名所の id）か、無ければ章の id で photos.json を引く */
export interface Chapter extends Spot { year: string; photo?: string }
/** 視点（全景・眺め） */
export interface View { lon: number; lat: number; zoom: number; tilt: number; bearing: number }

/** 浸水深の凡例（重ねるハザードマップの共通の色・洪水／高潮／津波）。タイルには細かい帯の色（0.3m 未満 #ffffb3・0.5〜1m #f8e1a6）も混じる＝match で同じ帯に寄せる（2026-10-21 タイル実測） */
export const DEPTH: Legend[] = [
	{ color: "#f7f5a9", label: "Under 0.5 m", match: ["#ffffb3"] }, { color: "#ffd8c0", label: "0.5–3 m", match: ["#f8e1a6"] }, { color: "#ffb7b7", label: "3–5 m" },
	{ color: "#ff9191", label: "5–10 m" }, { color: "#f285c9", label: "10–20 m" }, { color: "#dc7adc", label: "20 m or more" },
];
const DP = "https://disaportaldata.gsi.go.jp/raster/";
/** 災害の想定（国土交通省 重ねるハザードマップのオープンデータ） */
export const HAZARDS: Hazard[] = [
	{ id: "flood", name: "Flood (maximum assumed)", urls: [DP + "01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png"], maxZoom: 17, legend: DEPTH, note: "Flood depth when rivers overflow (rainfall of the largest assumed scale)." },
	{ id: "hightide", name: "Storm surge (maximum assumed)", urls: [DP + "03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png"], maxZoom: 17, legend: DEPTH, note: "Flood depth when a typhoon storm surge overtops the sea defenses." },
	{ id: "tsunami", name: "Tsunami", urls: [DP + "04_tsunami_newlegend_data/{z}/{x}/{y}.png"], maxZoom: 17, legend: DEPTH, note: "Inundation depth in the prefecture's tsunami scenario." },
	{ id: "dosha", name: "Sediment disaster warning areas", urls: ["05_dosekiryukeikaikuiki", "05_kyukeishakeikaikuiki", "05_jisuberikeikaikuiki"].map(d => `${DP}${d}/{z}/{x}/{y}.png`), maxZoom: 17,
		legend: [{ color: "#fae600", label: "Warning area" }, { color: "#fa2800", label: "Special warning area" }, { color: "#00008b", label: "Steep-slope collapse hazard area (Steep Slope Act)" }],
		note: "Warning areas for debris flows, steep-slope collapses (cliff failures) and landslides. Navy shows hazard areas under the Steep Slope Act." },
];

/** LOD1 の建物を出すズームの下限（本人 2026-10-21「ないところがあるなら全部ない方がいい」「傾きに関係なく z で決めていい」）。
 *  LOD1 の 3D Tiles は 4 段（REPLACE）で、粗い段には大きな建物しか入っていない＝細かい段が届いた枠と届いていない枠で「有る／無い」の四角いまだらになる。
 *  Mac 実測（保土ケ谷・旭・戸塚・南・真上）：z16.5 で 3〜32 秒で出そろう・z16 は 4 か所中 3 か所が 90 秒でも出そろわない（13 区が同時取得 6 本ずつ張り付く） */
export const BUILDINGS_MIN_ZOOM = 16.5;
/** 市営地下鉄（線・駅の記号）を出す最小の z＝これ未満（市より広い縮尺）では消す（本人 2026-10-21）。全市を真上から収めた時（z≈10.5〜11）は出る */
export const SUBWAY_MIN_ZOOM = 10;
/** 見えている範囲が覆いの外枠の内側か（null＝球の縁が見える＝内側でない） */
export const insideBox = (view: ArrayLike<number> | null, box: ArrayLike<number>) => !!view && view[0] > box[0] && view[1] > box[1] && view[2] < box[2] && view[3] < box[3];

/** 指定緊急避難場所の対応災害（census2020 の焼き bousai/hinan の flags のビット順） */
export const HINAN_FLAGS = ["Flood", "Sediment disaster", "Storm surge", "Earthquake", "Tsunami", "Large fire", "Inland flooding", "Volcano"];
/** 避難場所の 1 行＝[経度, 緯度, 名称, 住所, 対応災害ビット] */
export type HinanRow = [number, number, string, string, number];
/** 鉄道の路線の一覧（「・」区切り）→ 英語（同じ名は 1 つに・表に無い路線は日本語のまま）。dict＝市の RAIL_LINES_EN */
export const railLinesEn = (dict: Readonly<Record<string, string>>, s: string) => [...new Set(String(s || "").split("・").filter(Boolean).map(x => dict[x] || x))].join("・");
/** その市の避難場所だけ（県の一覧から住所の頭＝「横浜市」で選ぶ） */
export function sheltersIn(rows: HinanRow[], addrPrefix: string): HinanRow[] {
	const out: HinanRow[] = [];
	for (const r of rows) if (Array.isArray(r) && typeof r[3] === "string" && r[3].includes(addrPrefix) && Number.isFinite(r[0]) && Number.isFinite(r[1])) out.push(r);
	return out;
}
/** 表記の揺れを揃える（半角カナ・全角英数＝NFKC、「ヶ」「ケ」の小書き＝ケ）＝住所の照合と施設の検索に使う。保土ケ谷区は台帳に「保土ｹ谷区」「保土ヶ谷区」も混ざる */
export const normJa = (s: string) => String(s ?? "").normalize("NFKC").replace(/[ヶヵ]/g, m => m === "ヶ" ? "ケ" : "カ");
/** 区を引く物（市の設定のうち区の台帳と住所の頭） */
export interface CityWards { wards: readonly Ward[]; addrPrefix: string }
/** 住所の「横浜市◯◯区」から区を引く */
export function wardOfAddress(city: CityWards, addr: string): Ward | null {
	const m = new RegExp(city.addrPrefix + "(.+?区)").exec(normJa(addr));
	return m ? city.wards.find(w => w.name === m[1]) ?? null : null;
}
export const flagsOf = (bits: number) => HINAN_FLAGS.filter((_, i) => bits & (1 << i));

// ── URL の状態（共有できる）：?tab=risk&hz=flood,tsunami&ward=14104&spot=mm21&tr=subway,bus ──
export const TABS: Tab[] = ["life", "transit", "sight", "risk", "tools"];   // 暮らしを先頭に・次が交通・観光（本人 2026-10-25「地域を暮らしに変えて、先頭に」）＝既定の面は暮らし
const OLD_TABS: Record<string, Tab> = { city: "sight", time: "tools", area: "life" };   // 旧い共有 URL（city／time＝2026-10-21 より前・area＝2026-10-25 より前の「地域」）
/** URL の状態を読む物（市の設定のうち区・名所・ハザード・交通） */
export interface CityState { wards: readonly Ward[]; spots: readonly Spot[]; hazards: readonly Hazard[]; transit: readonly TransitLayer[]; transitDefault: readonly string[] }
export function parseState(city: CityState, search: string): TwinState {
	const q = new URLSearchParams(search);
	const t = q.get("tab") || "";
	const tab = TABS.includes(t as Tab) ? t as Tab : OLD_TABS[t] || TABS[0];
	const hz = (q.get("hz") || "").split(",").filter(id => city.hazards.some(h => h.id === id));
	const ward = city.wards.some(w => w.code === q.get("ward")) ? q.get("ward")! : "";
	const spot = city.spots.some(s => s.id === q.get("spot")) ? q.get("spot")! : "";
	const want = q.has("tr") ? (q.get("tr") || "").split(",") : city.transitDefault;
	const tr = city.transit.map(x => x.id as string).filter(id => want.includes(id));   // 台帳の並びに揃える（往復で同じ）
	return { tab, ward, hz: [...new Set(hz)], spot, tr };
}
/** 状態 → search（既定値は書かない＝素の URL を短く保つ）。他の鍵（?data= 等）は残す */
export function writeState(city: CityState, search: string, st: TwinState): string {
	const q = new URLSearchParams(search);
	const set = (k: string, v: string, def: string) => v && v !== def ? q.set(k, v) : q.delete(k);
	set("tab", st.tab, TABS[0]); set("hz", st.hz.join(","), ""); set("ward", st.ward, ""); set("spot", st.spot, "");
	const tr = city.transit.filter(x => st.tr.includes(x.id)).map(x => x.id).join(",");
	if (tr === city.transitDefault.join(",")) q.delete("tr"); else q.set("tr", tr);
	q.delete("era");   // 旧「時間」の鍵
	const s = q.toString();
	return s ? "?" + s : "";
}

// ── 防災を自分ごとに（地点を調べる・2026-10-21）＝押した所の想定浸水の深さ・最寄りの避難場所（距離・徒歩・標高差）──
/** 経緯度 → z の XYZ タイル番号と、そのタイルの中の画素（256px） */
export function tilePixel(lon: number, lat: number, z: number): { x: number; y: number; px: number; py: number } {
	const n = 2 ** z, s = Math.sin(lat * Math.PI / 180);
	const fx = (lon + 180) / 360 * n, fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
	const x = Math.floor(fx), y = Math.floor(fy);
	return { x, y, px: Math.min(255, Math.floor((fx - x) * 256)), py: Math.min(255, Math.floor((fy - y) * 256)) };
}
/** 画素の色 → 凡例の何番目か（-1＝透明＝想定の外）。重ねるハザードマップの PNG は凡例の色そのまま＝最も近い色（距離 40 以内）を採る */
export function legendIndex(legend: Legend[], r: number, g: number, b: number, a: number): number {
	if (a < 128) return -1;
	let bi = -1, bd = 40 * 40 * 3;
	legend.forEach((l, i) => { for (const hex of [l.color, ...l.match ?? []]) { const c = parseInt(hex.slice(1), 16), d = (r - (c >> 16)) ** 2 + (g - (c >> 8 & 255)) ** 2 + (b - (c & 255)) ** 2; if (d < bd) { bd = d; bi = i; } } });
	return bi;
}
/** 浸水の深さの帯（DEPTH の番号）→ 水が届く階（1 階＝3m とみなす・0.5m 未満は 0＝床下）。20m 以上は 7 */
export const floorsOfDepth = (i: number) => [0, 1, 2, 4, 7, 7][i] ?? 0;
/** 浸水の帯の上端（m）＝地点に立てる水面の高さ（最大想定なので帯の上端・20m 以上は 20m）。範囲外＝0 */
export const depthTop = (i: number) => [0.5, 3, 5, 10, 20, 20][i] ?? 0;
/** 2 点の距離（m・球面） */
/** 保存した地点（自宅・実家・職場など）＝名前と経緯度。この端末だけ（localStorage）・3 か所まで（Kenji 2026-10-27） */
export type SavedPlace = { n: string; at: [number, number] };
export const PLACES_MAX = 3, PLACE_NAME_MAX = 12;
/** 保存の文字列 → 地点の列（壊れた・市外・名前なしは捨てる・多すぎは先頭 3 つ） */
export function parsePlaces(raw: string | null, bbox: readonly number[]): SavedPlace[] {
	let a: unknown; try { a = JSON.parse(raw ?? "[]"); } catch { return []; }
	if (!Array.isArray(a)) return [];
	return a.filter((p): p is SavedPlace => !!p && typeof p.n === "string" && p.n.trim() !== "" && Array.isArray(p.at) && p.at.length === 2 && p.at.every((v: unknown) => typeof v === "number" && Number.isFinite(v)) && p.at[0] > bbox[0] && p.at[0] < bbox[2] && p.at[1] > bbox[1] && p.at[1] < bbox[3])
		.slice(0, PLACES_MAX).map(p => ({ n: p.n.trim().slice(0, PLACE_NAME_MAX), at: [p.at[0], p.at[1]] }));
}
/** 同じ地点か（押し直しの揺れ 20m 以内） */
export const samePlace = (a: [number, number], b: [number, number]) => distM(a, b) <= 20;
export function distM(a: [number, number], b: [number, number]): number {
	const R = 6371008.8, r = Math.PI / 180, dla = (b[1] - a[1]) * r, dlo = (b[0] - a[0]) * r;
	const h = Math.sin(dla / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dlo / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** 道順の高低差（本人 2026-11-13「ルート案内のときに標高差のグラフも」）＝線をほぼ step m ごとに区切った点と、そこまでの道のり m。
 *  始点・終点と曲がり角（頂点）は必ず入れる。点が max を超える長い道は step を広げて max に収める */
export function sampleLine(line: [number, number][], step = 20, max = 120): { at: [number, number]; d: number }[] {
	if (line.length < 2) return line.map(at => ({ at, d: 0 }));
	const seg = line.slice(1).map((p, i) => distM(line[i], p)), total = seg.reduce((s, m) => s + m, 0);
	const st = Math.max(step, total / Math.max(1, max - line.length));
	const out: { at: [number, number]; d: number }[] = [{ at: line[0], d: 0 }];
	let d0 = 0;
	for (let i = 0; i < seg.length; i++) {
		const [a, b] = [line[i], line[i + 1]], n = Math.floor(seg[i] / st);
		for (let j = 1; j <= n; j++) { const f = j * st / seg[i]; if (f >= 1) break; out.push({ at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], d: d0 + j * st }); }
		d0 += seg[i]; out.push({ at: b, d: d0 });
	}
	return out;
}
/** 標高の列 → 上りの計・下りの計・最高・最低（m）。DEM の細かい段差（thr m 未満の揺れ）は数えない＝基準から thr 以上動いた時だけ足して基準を移す */
export function climb(h: number[], thr = 1): { up: number; down: number; min: number; max: number } {
	const v = h.filter(Number.isFinite);
	if (!v.length) return { up: 0, down: 0, min: NaN, max: NaN };
	let up = 0, down = 0, r = v[0];
	for (const x of v) { if (x - r >= thr) { up += x - r; r = x; } else if (r - x >= thr) { down += r - x; r = x; } }
	return { up, down, min: Math.min(...v), max: Math.max(...v) };
}
/** 画面上の線の枠 box を、空いている枠 free に入れるためのずらし量（px・地図の中心をこの分だけ動かす）。
 * もう入っている＝{0,0}・ずらしても入らない大きさ＝null（引いて収める側へ）。枠＝[x0, y0, x1, y1] */
export function shiftInto(box: [number, number, number, number], free: [number, number, number, number]): { dx: number; dy: number } | null {
	if (box[2] - box[0] > free[2] - free[0] || box[3] - box[1] > free[3] - free[1]) return null;
	const d = (a0: number, a1: number, f0: number, f1: number) => a0 < f0 ? a0 - f0 : a1 > f1 ? a1 - f1 : 0;
	return { dx: d(box[0], box[2], free[0], free[2]), dy: d(box[1], box[3], free[1], free[3]) };
}
/** 近い順に k 件（避難場所の行・直線距離） */
export function nearestRows<T extends [number, number, ...unknown[]]>(rows: T[], at: [number, number], k: number): { row: T; m: number }[] {
	return rows.map(row => ({ row, m: distM(at, [row[0], row[1]]) })).sort((a, b) => a.m - b.m).slice(0, k);
}
/** 避難場所の「場所」の名＝名称の空白（全角・半角）より前。避難場所の台帳は校舎・体育館ごとに 1 行＝「横浜市立岡野中学校　校舎７」「…　体育館」は同じ学校 */
export const siteName = (name: string) => String(name || "").split(/[\s\u3000]/)[0] || String(name || "");
/** 近い順に k か所（同じ場所の別の棟は最も近い 1 行だけ＝最寄り 3 件が 1 校の棟違いで埋まらないように） */
export function nearestSites<T extends [number, number, string, ...unknown[]]>(rows: T[], at: [number, number], k: number): { row: T; m: number }[] {
	const seen = new Set<string>(), out: { row: T; m: number }[] = [];
	for (const x of nearestRows(rows, at, rows.length)) { const key = siteName(x.row[2]); if (seen.has(key)) continue; seen.add(key); out.push(x); if (out.length >= k) break; }
	return out;
}
/** 点が面（Polygon／MultiPolygon・穴あり）の中か（偶奇則）。わが家のまわり（2026-10-25）＝押した所の区・校区・用途地域・管轄を台帳の面から引く */
type Ring = number[][];
export function inGeometry(g: { type: string; coordinates: unknown } | null | undefined, at: [number, number]): boolean {
	if (!g) return false;
	const polys = (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) as Ring[][];
	const inRing = (r: Ring) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > at[1]) !== (yj > at[1]) && at[0] < (xj - xi) * (at[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
	return polys.some(rings => rings.length > 0 && inRing(rings[0]) && !rings.slice(1).some(inRing));
}
/** 点を含む最初の地物の properties（無い＝null） */
export function featureAt<P>(fc: { features: { geometry: { type: string; coordinates: unknown } | null; properties: P }[] } | null | undefined, at: [number, number]): P | null {
	return fc?.features.find(f => inGeometry(f.geometry, at))?.properties ?? null;
}
/** 歩いて何分（80m/分＝不動産の表示と同じ・道のりは直線の 1.3 倍とみなす） */
export const walkMin = (m: number) => Math.max(1, Math.round(m * 1.3 / 80));
/** 駅からの徒歩圏の輪（分）。半径＝分×80m を道のり 1.3 倍で割り戻した直線距離 */
export const WALK_RINGS = [5, 10, 15] as const;
export const walkRadius = (min: number) => min * 80 / 1.3;
/** 円（中心・半径 m）を n 角形で（経度は緯度で縮める） */
export function circleRing(c: [number, number], m: number, n = 64): [number, number][] {
	const dLat = m / 111320, dLon = dLat / Math.cos(c[1] * Math.PI / 180);
	return Array.from({ length: n + 1 }, (_, i) => { const a = i % n / n * 2 * Math.PI; return [c[0] + dLon * Math.sin(a), c[1] + dLat * Math.cos(a)]; });
}
/** 輪ごとの数（rows の中で、半径の内側にあるもの）。返り値は WALK_RINGS と同じ並び */
export function countRings<T extends [number, number, ...unknown[]]>(rows: T[], at: [number, number], keep: (r: T) => boolean = () => true): number[] {
	const out = WALK_RINGS.map(() => 0);
	for (const r of rows) { if (!keep(r)) continue; const m = distM(at, [r[0], r[1]]); WALK_RINGS.forEach((w, i) => { if (m <= walkRadius(w)) out[i]++; }); }
	return out;
}

// ── 歩ける道（OpenStreetMap・ODbL）＝わが家のまわりの道のりと道順（本人「お願いします」2026-10-26）──
// 直線×1.3 は線路・川・緑道で大きく外れた（Mac の試作：鶴見で直線 669m→道のり 890m、地理院の道路だけでは自由通路が無く 1,309m）。
// 台帳＝walk/<cx>_<cy>.bin（0.02° 四方の区画・bake-yokohama.mjs の walk）。頁は家のまわりの区画だけ読み、同じ座標の点を 1 つに束ねて道の網を作り、家から 1 度だけ Dijkstra を回す
/** 区画の大きさ（度）と座標の刻み（度＝約 1m） */
export const WALK_CELL = 0.02, WALK_Q = 1e-5;
const WALK_FOOT = new Set(["footway", "path", "pedestrian", "cycleway", "track", "corridor", "bridleway"]);
const WALK_ROAD = new Set(["living_street", "residential", "service", "unclassified", "road", "tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link", "trunk", "trunk_link"]);
/** OSM の道の札 → 種別（0 道路・1 歩行者の道・2 階段・-1 歩けない／入れない）。高速・私道・歩行者お断りは採らない */
export function walkKind(tags: Record<string, string>): number {
	const h = tags.highway ?? "", foot = tags.foot ?? "";
	if (foot === "no" || foot === "private") return -1;
	if (/^(private|no)$/.test(tags.access ?? "") && !/^(yes|designated|permissive)$/.test(foot)) return -1;
	if (h === "steps") return 2;
	if (WALK_FOOT.has(h)) return 1;
	if (WALK_ROAD.has(h)) return tags.motorroad === "yes" && !/^(yes|designated)$/.test(foot) ? -1 : 0;
	return -1;
}
export type WalkLine = { kind: number; pts: number[] };   // pts＝[x, y, …]（1e-5° の整数）
const zz = (v: number) => (v << 1) ^ (v >> 31), unzz = (v: number) => (v >>> 1) ^ -(v & 1);
/** 区画 1 つを詰める：[本数, (種別, 点の数, 区画の南西からの差分…)…]＝zigzag varint */
export function encodeWalk(lines: WalkLine[], cx: number, cy: number): Uint8Array {
	const out: number[] = [], put = (v: number) => { v >>>= 0; while (v > 127) { out.push((v & 127) | 128); v >>>= 7; } out.push(v); };
	const ox = Math.round(cx * WALK_CELL / WALK_Q), oy = Math.round(cy * WALK_CELL / WALK_Q);
	put(lines.length);
	for (const l of lines) {
		put(l.kind); put(l.pts.length / 2);
		let px = ox, py = oy;
		for (let i = 0; i < l.pts.length; i += 2) { put(zz(l.pts[i] - px)); put(zz(l.pts[i + 1] - py)); px = l.pts[i]; py = l.pts[i + 1]; }
	}
	return Uint8Array.from(out);
}
export function decodeWalk(buf: Uint8Array, cx: number, cy: number): WalkLine[] {
	let o = 0;
	const get = () => { let v = 0, s = 0, b: number; do { b = buf[o++]; v |= (b & 127) << s; s += 7; } while (b & 128); return v >>> 0; };
	const ox = Math.round(cx * WALK_CELL / WALK_Q), oy = Math.round(cy * WALK_CELL / WALK_Q), out: WalkLine[] = [];
	for (let n = get(); n-- > 0;) {
		const kind = get(), k = get(), pts: number[] = new Array(k * 2);
		let px = ox, py = oy;
		for (let i = 0; i < k; i++) { px += unzz(get()); py += unzz(get()); pts[i * 2] = px; pts[i * 2 + 1] = py; }
		out.push({ kind, pts });
	}
	return out;
}
/** 点のまわり r メートルに掛かる区画の名（"cx_cy"） */
export function walkCells(at: [number, number], r: number): string[] {
	const dy = r / 111320, dx = r / (111320 * Math.cos(at[1] * Math.PI / 180)), out: string[] = [];
	for (let cx = Math.floor((at[0] - dx) / WALK_CELL); cx <= Math.floor((at[0] + dx) / WALK_CELL); cx++)
		for (let cy = Math.floor((at[1] - dy) / WALK_CELL); cy <= Math.floor((at[1] + dy) / WALK_CELL); cy++) out.push(`${cx}_${cy}`);
	return out;
}
/** 道の網：点（1e-5° の整数 xy）と隣り（CSR）。同じ座標の点は 1 つ＝区画の境で切った線もここで繋がる */
export type WalkGraph = { x: Int32Array; y: Int32Array; start: Int32Array; to: Int32Array; len: Float32Array };
export function buildWalkGraph(lines: WalkLine[]): WalkGraph {
	const id = new Map<number, number>(), xs: number[] = [], ys: number[] = [], ea: number[] = [], eb: number[] = [], el: number[] = [];
	const node = (x: number, y: number) => { const k = x * 4194304 + y; let i = id.get(k); if (i === undefined) { i = xs.length; id.set(k, i); xs.push(x); ys.push(y); } return i; };
	for (const l of lines) {
		let a = node(l.pts[0], l.pts[1]);
		for (let i = 2; i < l.pts.length; i += 2) {
			const b = node(l.pts[i], l.pts[i + 1]); if (b === a) continue;
			const m = distM([xs[a] * WALK_Q, ys[a] * WALK_Q], [xs[b] * WALK_Q, ys[b] * WALK_Q]) * (l.kind === 2 ? 1.5 : 1);   // 階段は 1.5 倍に見る（上り下りの分）
			ea.push(a); eb.push(b); el.push(m); a = b;
		}
	}
	const n = xs.length, deg = new Int32Array(n + 1);
	for (let i = 0; i < ea.length; i++) { deg[ea[i] + 1]++; deg[eb[i] + 1]++; }
	for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
	const fill = deg.slice(0, n), to = new Int32Array(ea.length * 2), len = new Float32Array(ea.length * 2);
	for (let i = 0; i < ea.length; i++) { let j = fill[ea[i]]++; to[j] = eb[i]; len[j] = el[i]; j = fill[eb[i]]++; to[j] = ea[i]; len[j] = el[i]; }
	return { x: Int32Array.from(xs), y: Int32Array.from(ys), start: deg, to, len };
}
/** 家や行き先を道に繋ぐ点＝いちばん近い道の線分に下ろした垂線の足（折れ点ではない：まっすぐな道の途中の家が、離れた角や裏の道へ斜めに飛ばないように）。
 *  a・b＝線分の両端の点、ta・tb＝足から両端までの道のり（m・階段の割増し込み）、m＝元の地点から足までの直線（m）、pt＝足 */
export type WalkSnap = { a: number; b: number; ta: number; tb: number; m: number; pt: [number, number] };
/** 近い線分の候補（近い順・いちばん近いものから +30m まで・最大 6 本）。道が無ければ空。候補を複数持つのは、繋ぎの直線と道のりを足した合計で選ぶため */
export function walkSnap(g: WalkGraph, at: [number, number], n = 6): WalkSnap[] {
	const kx = Math.cos(at[1] * Math.PI / 180), px = at[0] / WALK_Q, py = at[1] / WALK_Q;
	const best: { j: number; v: number; t: number; d: number }[] = [];   // d＝足までの距離²（刻み単位）
	for (let v = 0; v < g.x.length; v++) for (let j = g.start[v]; j < g.start[v + 1]; j++) {
		const w = g.to[j]; if (w < v) continue;   // 片向きだけ見る
		const ax = (g.x[v] - px) * kx, ay = g.y[v] - py, sx = (g.x[w] - g.x[v]) * kx, sy = g.y[w] - g.y[v], ss = sx * sx + sy * sy;
		const t = ss ? Math.min(1, Math.max(0, -(ax * sx + ay * sy) / ss)) : 0, qx = ax + sx * t, qy = ay + sy * t, d = qx * qx + qy * qy;
		if (best.length === n && d >= best[n - 1].d) continue;
		let i = best.length; if (i === n) i--; else best.push(null as never);
		while (i > 0 && best[i - 1].d > d) { best[i] = best[i - 1]; i--; }
		best[i] = { j, v, t, d };
	}
	if (!best.length) return [];
	const lim = Math.sqrt(best[0].d) + 30 / 1.1132;   // 30m（1 刻み＝約 1.11m）
	return best.filter(c => Math.sqrt(c.d) <= lim).map(({ j, v, t }) => {
		const w = g.to[j], pt: [number, number] = [(g.x[v] + (g.x[w] - g.x[v]) * t) * WALK_Q, (g.y[v] + (g.y[w] - g.y[v]) * t) * WALK_Q];
		return { a: v, b: w, ta: g.len[j] * t, tb: g.len[j] * (1 - t), m: distM(at, pt), pt };
	});
}
/** 家からの探索の結果：at＝家、snaps＝家を道に繋ぐ候補、dist＝各点までの道のり（家から繋ぎの直線を含む）、prev＝来た点、src＝出発した候補の番号（出発点の点だけ） */
export type WalkFrom = { at: [number, number]; snaps: WalkSnap[]; dist: Float64Array; prev: Int32Array; src: Int32Array };
/** 家から全部の点への道のり（m）と来た点（道順を辿る用）。候補の線分の両端を、繋ぎの直線＋足から端までの道のりを初期値にして一度に出発させる（合計が最短の繋ぎ方が自然に選ばれる） */
export function walkSearch(g: WalkGraph, at: [number, number], snaps: WalkSnap[]): WalkFrom {
	const n = g.x.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), src = new Int32Array(n).fill(-1);
	const hn: number[] = [], hd: number[] = [];   // 二分ヒープ（古い札は取り出した時に捨てる）
	const push = (v: number, d: number) => { let i = hn.length; hn.push(v); hd.push(d); while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hn[i] = hn[p]; hd[i] = hd[p]; i = p; } hn[i] = v; hd[i] = d; };
	const pop = () => { const v = hn[0], lv = hn.pop()!, ld = hd.pop()!; if (hn.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hn.length) break; if (c + 1 < hn.length && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; hn[i] = hn[c]; hd[i] = hd[c]; i = c; } hn[i] = lv; hd[i] = ld; } return v; };
	snaps.forEach((s, k) => { for (const [v, d] of [[s.a, s.m + s.ta], [s.b, s.m + s.tb]] as const) if (d < dist[v]) { dist[v] = d; src[v] = k; push(v, d); } });
	while (hn.length) {
		const d0 = hd[0], v = pop(); if (d0 > dist[v]) continue;
		for (let j = g.start[v]; j < g.start[v + 1]; j++) { const w = g.to[j], d = d0 + g.len[j]; if (d < dist[w]) { dist[w] = d; prev[w] = v; src[w] = -1; push(w, d); } }
	}
	return { at, snaps, dist, prev, src };
}
/** 家から行き先までの道のり（m・家と行き先から道までの直線も足す）と道順（家 → 足 → 道なり → 足 → 行き先）。繋がっていない・道から 150m 超え＝null（呼ぶ側は直線に戻す） */
export function walkTo(g: WalkGraph, from: WalkFrom, to: [number, number]): { m: number; path: [number, number][] } | null {
	const ss = walkSnap(g, to);
	if (!ss.length || ss[0].m > 150) return null;
	let m = Infinity, via: { s: WalkSnap; v: number } | null = null, same: { h: WalkSnap; s: WalkSnap } | null = null;
	for (const s of ss) {
		for (const h of from.snaps) {   // 家と同じ線分の上＝道なりに真っ直ぐ（端まで行って戻らない）
			const d = h.a === s.a && h.b === s.b ? Math.abs(h.ta - s.ta) : h.a === s.b && h.b === s.a ? Math.abs(h.ta - s.tb) : NaN;
			if (d >= 0 && h.m + d + s.m < m) { m = h.m + d + s.m; same = { h, s }; via = null; }
		}
		for (const [v, t] of [[s.a, s.ta], [s.b, s.tb]] as const) if (from.dist[v] + t + s.m < m) { m = from.dist[v] + t + s.m; via = { s, v }; same = null; }
	}
	if (!Number.isFinite(m)) return null;
	const path: [number, number][] = [];
	const put = (p: [number, number]) => { const q = path[path.length - 1]; if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) path.push(p); };   // 足が折れ点と重なる時の重複は省く
	if (same) { [from.at, same.h.pt, same.s.pt, to].forEach(put); return { m, path }; }
	put(to); put(via!.s.pt);
	let v = via!.v;
	for (; from.prev[v] >= 0; v = from.prev[v]) put([g.x[v] * WALK_Q, g.y[v] * WALK_Q]);
	put([g.x[v] * WALK_Q, g.y[v] * WALK_Q]); put(from.snaps[from.src[v]].pt); put(from.at);
	return { m, path: path.reverse() };
}

// ── 通信なしで使う（完全オフライン・本人 2026-11-12）──
// 端末に詰める束の中身を決める純関数（タイルの列と、市の形で間引く升目）。詰める・配る仕組みは offline.ts と共有の sw.js
/** タイル z/x/y の範囲 [w,s,e,n]（度） */
export function tileBox(z: number, x: number, y: number): [number, number, number, number] {
	const n = 2 ** z, lon = (i: number) => i / n * 360 - 180, lat = (j: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * j / n))) * 180 / Math.PI;
	return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}
/** bbox（[w,s,e,n]）に掛かる z のタイル */
export function tilesIn(bbox: readonly number[], z: number): [number, number, number][] {
	const a = tilePixel(bbox[0], bbox[3], z), b = tilePixel(bbox[2], bbox[1], z), out: [number, number, number][] = [];
	for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push([z, x, y]);
	return out;
}
/** 市に掛かるタイルだけを通す篩（市の外の海・川崎・鎌倉は細かい段を詰めない）。
 *  mz の段で中心が市の中の枡に印を付け、1 枡ぶん太らせる（境の取りこぼし＝約 1 km の余白）。mz より細かい段＝祖先の印・粗い段＝子孫に印があれば通す */
export function cityTileMask(inside: (lon: number, lat: number) => boolean, bbox: readonly number[], mz = 15): (z: number, x: number, y: number) => boolean {
	const marks = new Set<string>(), key = (x: number, y: number) => `${x}/${y}`;
	for (const [, x, y] of tilesIn(bbox, mz)) {
		const b = tileBox(mz, x, y);
		if (inside((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) marks.add(key(x + dx, y + dy));
	}
	const coarse = new Map<number, Set<string>>();   // 粗い段の印（子孫に印がある枡）
	for (let z = mz - 1; z >= 0; z--) { const s = new Set<string>(), k = 2 ** (mz - z); for (const m of marks) { const [x, y] = m.split("/").map(Number); s.add(key(Math.floor(x / k), Math.floor(y / k))); } coarse.set(z, s); }
	return (z, x, y) => z >= mz ? marks.has(key(x >> (z - mz), y >> (z - mz))) : coarse.get(z)!.has(key(x, y));
}
/** 子の 4 枚 */
export const tileKids = (z: number, x: number, y: number): [number, number, number][] => [[z + 1, 2 * x, 2 * y], [z + 1, 2 * x + 1, 2 * y], [z + 1, 2 * x, 2 * y + 1], [z + 1, 2 * x + 1, 2 * y + 1]];
/** 型紙（{z}/{x}/{y}）を埋める */
export const fillTpl = (tpl: string, z: number, x: number, y: number) => tpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
/** 通信なしの地名検索（地理院の検索は通信が要る）＝台帳の名所・駅・施設・町丁目・区から引く 1 行 */
/** 地名の 1 行。ja＝日本語名・en＝英語名（英語の問いで引く）・loc＝今の言語の表示名（無い＝ja/en） */
export interface PlaceRow { ja: string; en: string; loc?: string; note: string; c?: [number, number]; bbox?: [number, number, number, number] }
const searchKey = (s: string) => normJa(s).toLowerCase().replace(/[\s\-・ー'’.]/g, "");
/** 通信なしの地名検索：日本語か英語の名前に問いを含む行（完全一致 → 前方一致 → 途中・短い名前を先に）。2 文字未満は引かない */
export function searchPlaces(rows: readonly PlaceRow[], q: string, max = 8): PlaceRow[] {
	const k = searchKey(q); if (k.length < 2) return [];
	const hits: { r: PlaceRow; s: number }[] = [];
	for (const r of rows) {
		let best = 9;
		for (const n of [r.ja, r.en, r.loc]) { if (!n) continue; const m = searchKey(n), i = m.indexOf(k); if (i < 0) continue; best = Math.min(best, m === k ? 0 : i === 0 ? 1 : 2); }
		if (best < 9) hits.push({ r, s: best * 1000 + Math.min(999, (r.ja || r.en).length) });
	}
	return hits.sort((a, b) => a.s - b.s).slice(0, max).map(h => h.r);
}

// ── 市の設定（apps/<市>/data.ts が組む・mountTwin が受ける）──
// 文言は英語のキー（t() で 26 言語へ）＝訳はその市の頁の辞書（apps/<市>/i18n/pages/<市>.json）。全国で同じ文言の訳はこのパッケージの辞書（i18n/pages/citytwin.json）
/** 救急の 1 か所（夜間急病センター等）＝名前・住所（日本語／英語）・電話・位置 */
export interface Clinic { name: string; addr: string; tel: string; lon: number; lat: number; enName: string; en: string }
export interface CityConfig extends CityWards, CityState {
	/** 置き場の名・console の印・CSV の名・通信なしの束の名（oj-pack-<id>） */
	id: string;
	/** 端末の保存（localStorage）の鍵の頭（横浜＝"yk"→ yk-places・yk-offline） */
	key: string;
	/** 見出し（頁の題）・市の名・区の選びの「全市」・市の外の一言 */
	title: string; cityName: string; allWards: string; outside: string;
	bbox: [number, number, number, number]; view: View;
	/** 市の外の覆いの外枠 [w,s,e,n]（枠の縁が画面に入ったら覆いごと消す） */
	maskBox: [number, number, number, number];
	spots: Spot[]; tour: string[];
	/** 名所ツアーの最初の札（市の大きさの一言） */
	tourIntro: string;
	/** 物語（章をめぐって最後に眺め views を見渡す）。button＝始めるボタン・viewsButton＝眺めだけのボタン・viewsCaption＝眺めの札の [見出し, 一行] */
	story?: { button: string; chapters: Chapter[]; views: View[]; viewsButton: string; viewsCaption: [string, string] };
	/** 市営地下鉄：路線（駅番号）・事業者の名（吹き出し）・N02 の路線名 → 線の色・地下鉄の路線名（rail.json の「事業者 路線」）の型・案内板の一言 */
	subway: SubwayLine[]; subwayName: string; subwayColor: (n02Line: string) => string; subwayRail: RegExp; subwayNote: string;
	/** 市営バスの事業者の名（吹き出し） */
	busName: string;
	/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語 */
	railLinesEn: Readonly<Record<string, string>>;
	/** 防災の面の結びの一言（想定の出どころ）と、内水（市が PDF だけで出している等）の案内（無い市は無し） */
	riskNote: string; inland?: { text: string; link: string; url: string };
	/** 指定緊急避難場所（県の焼き bousai/hinan/<県>.json） */
	hinanUrl: string;
	/** 起動直後に先読みする建物（エンジンの登録簿の名）・通信なしの保存で詰める建物（区＋橋梁） */
	lod2Prefetch: string[]; bldSets: string[];
	/** 区 → 登録簿の名（ツアーの先読み・橋梁のある区は橋梁も） */
	bldNames: (wardCode: string) => string[];
	/** 救急（わが家のまわり）：区の休日急患診療所・近い夜間急病センター・相談の電話。無い物は出さない */
	emergency?: {
		holiday?: { clinics: Readonly<Record<string, { addr: string; tel: string; en: string }>>; /** 名（$1＝区の名）・受付の一言（$1＝time の時間）・区 → 時間 */ name: string; hours: string; time: (wardCode: string) => string };
		night?: { centers: Clinic[]; hours: string; /** 行の見出し（無ければ "Night emergency center"） */ label?: string };
		advice?: { text: string; tel: string };
	};
	/** 大きな病院（市立・大学・地域中核）＝台帳の名に含まれる語 key → 短い名 */
	majorHospitals: { key: string; name: string }[];
	/** 警察署・消防署の管轄をわが家のカードに出すか（区と一致しない市なら true） */
	homeJuris: boolean;
	/** 通信なしの保存のおおよその大きさ（MB） */
	offlineMB: number;
}
