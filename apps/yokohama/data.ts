// 横浜市デジタルツインの台帳（区・名所・ツアー・ハザード・年代の写真・URL の状態）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 座標は区の中ほど／名所の建物の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 画像タイルは国土地理院（地理院タイル・重ねるハザードマップ）を、ブラウザが直に取る（焼かない・置き場を持たない）。

export interface Ward { code: string; name: string; lon: number; lat: number; zoom: number }
export interface Spot { id: string; name: string; ward: string; lon: number; lat: number; zoom: number; tilt: number; bearing: number; note: string }
export interface Legend { color: string; label: string }
export interface Hazard { id: string; name: string; urls: string[]; maxZoom: number; legend: Legend[]; note: string }
export interface Era { id: string; name: string; url: string | null; minZoom: number; maxZoom: number }
export interface TwinState { tab: Tab; ward: string; hz: string[]; era: string; spot: string }
export type Tab = "city" | "risk" | "time" | "tools";

/** 横浜市の外接矩形（18 区を包む）と全景の視点 */
export const CITY_BBOX: [number, number, number, number] = [139.46, 35.31, 139.73, 35.60];
export const CITY_VIEW = { lon: 139.60, lat: 35.45, zoom: 11.3, tilt: 35, bearing: 0 };

/** 18 区（市区町村コード順）。座標は区の中ほど・zoom は区がほぼ画面に収まる値 */
export const WARDS: Ward[] = [
	{ code: "14101", name: "鶴見区", lon: 139.680, lat: 35.497, zoom: 13.2 },
	{ code: "14102", name: "神奈川区", lon: 139.618, lat: 35.483, zoom: 13.3 },
	{ code: "14103", name: "西区", lon: 139.621, lat: 35.457, zoom: 14.2 },
	{ code: "14104", name: "中区", lon: 139.652, lat: 35.430, zoom: 13.4 },
	{ code: "14105", name: "南区", lon: 139.603, lat: 35.428, zoom: 14.0 },
	{ code: "14106", name: "保土ケ谷区", lon: 139.583, lat: 35.459, zoom: 13.6 },
	{ code: "14107", name: "磯子区", lon: 139.617, lat: 35.393, zoom: 13.6 },
	{ code: "14108", name: "金沢区", lon: 139.625, lat: 35.341, zoom: 13.2 },
	{ code: "14109", name: "港北区", lon: 139.628, lat: 35.525, zoom: 13.4 },
	{ code: "14110", name: "戸塚区", lon: 139.530, lat: 35.400, zoom: 13.2 },
	{ code: "14111", name: "港南区", lon: 139.584, lat: 35.393, zoom: 13.6 },
	{ code: "14112", name: "旭区", lon: 139.535, lat: 35.471, zoom: 13.3 },
	{ code: "14113", name: "緑区", lon: 139.527, lat: 35.513, zoom: 13.4 },
	{ code: "14114", name: "瀬谷区", lon: 139.488, lat: 35.469, zoom: 13.8 },
	{ code: "14115", name: "栄区", lon: 139.555, lat: 35.360, zoom: 13.8 },
	{ code: "14116", name: "泉区", lon: 139.495, lat: 35.418, zoom: 13.6 },
	{ code: "14117", name: "青葉区", lon: 139.522, lat: 35.555, zoom: 13.3 },
	{ code: "14118", name: "都筑区", lon: 139.575, lat: 35.545, zoom: 13.6 },
];

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "yokohama-st", name: "横浜駅", ward: "14103", lon: 139.6223, lat: 35.4657, zoom: 16.2, tilt: 58, bearing: 30, note: "鉄道 6 社が乗り入れる横浜の玄関口。駅の東西にビルが集まる。" },
	{ id: "mm21", name: "みなとみらい 21", ward: "14103", lon: 139.6315, lat: 35.4546, zoom: 15.6, tilt: 62, bearing: -20, note: "造船所と操車場の跡地に築いた新しい都心。横浜ランドマークタワー（高さ 296m・1993 年開業）が建つ。" },
	{ id: "akarenga", name: "横浜赤レンガ倉庫", ward: "14104", lon: 139.6425, lat: 35.4529, zoom: 16.8, tilt: 60, bearing: 20, note: "明治末から大正初めに建てられた国の保税倉庫。いまは商業と文化の施設。" },
	{ id: "osanbashi", name: "大さん橋", ward: "14104", lon: 139.6475, lat: 35.4513, zoom: 16.4, tilt: 60, bearing: 140, note: "大型客船が着く国際客船ターミナル。屋上は誰でも歩ける広場。" },
	{ id: "yamashita", name: "山下公園", ward: "14104", lon: 139.6505, lat: 35.4460, zoom: 16.4, tilt: 60, bearing: 60, note: "関東大震災のがれきで海を埋め立てて造った臨海公園（1930 年開園）。" },
	{ id: "chinatown", name: "横浜中華街", ward: "14104", lon: 139.6460, lat: 35.4425, zoom: 16.8, tilt: 62, bearing: 45, note: "開港後に生まれた日本最大級の中華街。" },
	{ id: "marine-tower", name: "横浜マリンタワー", ward: "14104", lon: 139.6506, lat: 35.4437, zoom: 17.0, tilt: 55, bearing: -30, note: "1961 年に開業した港のタワー。" },
	{ id: "stadium", name: "横浜スタジアム", ward: "14104", lon: 139.6400, lat: 35.4433, zoom: 16.8, tilt: 58, bearing: 0, note: "横浜公園の中にある球場。" },
	{ id: "city-hall", name: "横浜市役所", ward: "14104", lon: 139.6330, lat: 35.4513, zoom: 16.8, tilt: 58, bearing: 200, note: "2020 年に北仲通の新庁舎へ移った市役所。" },
	{ id: "baybridge", name: "横浜ベイブリッジ", ward: "14104", lon: 139.6740, lat: 35.4545, zoom: 15.2, tilt: 65, bearing: -60, note: "1989 年に開通した斜張橋。橋は PLATEAU の橋梁モデルで立つ。" },
	{ id: "daikoku", name: "大黒ふ頭", ward: "14101", lon: 139.6800, lat: 35.4620, zoom: 15.2, tilt: 55, bearing: 20, note: "コンテナや自動車を扱う埠頭。" },
	{ id: "sankeien", name: "三溪園", ward: "14104", lon: 139.6620, lat: 35.4170, zoom: 16.2, tilt: 55, bearing: 0, note: "実業家 原三溪が造り 1906 年に公開した日本庭園。" },
	{ id: "shin-yokohama", name: "新横浜", ward: "14109", lon: 139.6150, lat: 35.5085, zoom: 15.4, tilt: 58, bearing: -30, note: "新幹線の駅と日産スタジアムのある北の拠点。" },
	{ id: "center-kita", name: "港北ニュータウン", ward: "14118", lon: 139.5785, lat: 35.5470, zoom: 15.4, tilt: 55, bearing: 0, note: "丘陵を開いて計画的に造った住宅都市。センター北・センター南が核。" },
	{ id: "hakkeijima", name: "八景島", ward: "14108", lon: 139.6420, lat: 35.3380, zoom: 15.6, tilt: 58, bearing: 30, note: "金沢の海に造った人工島。" },
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["yokohama-st", "mm21", "akarenga", "osanbashi", "yamashita", "chinatown", "baybridge", "shin-yokohama", "center-kita", "sankeien"];

/** 浸水深の凡例（重ねるハザードマップの共通の色・洪水／高潮／津波） */
const DEPTH: Legend[] = [
	{ color: "#f7f5a9", label: "0.5m 未満" }, { color: "#ffd8c0", label: "0.5〜3m" }, { color: "#ffb7b7", label: "3〜5m" },
	{ color: "#ff9191", label: "5〜10m" }, { color: "#f285c9", label: "10〜20m" }, { color: "#dc7adc", label: "20m 以上" },
];
const DP = "https://disaportaldata.gsi.go.jp/raster/";
/** 災害の想定（国土交通省 重ねるハザードマップのオープンデータ） */
export const HAZARDS: Hazard[] = [
	{ id: "flood", name: "洪水（想定最大規模）", urls: [DP + "01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png"], maxZoom: 17, legend: DEPTH, note: "河川があふれた時の浸水の深さ（想定し得る最大規模の降雨）。" },
	{ id: "hightide", name: "高潮（想定最大規模）", urls: [DP + "03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png"], maxZoom: 17, legend: DEPTH, note: "台風の高潮で海があふれた時の浸水の深さ。" },
	{ id: "tsunami", name: "津波", urls: [DP + "04_tsunami_newlegend_data/{z}/{x}/{y}.png"], maxZoom: 17, legend: DEPTH, note: "神奈川県の津波浸水想定の深さ。" },
	{ id: "dosha", name: "土砂災害警戒区域", urls: ["05_dosekiryukeikaikuiki", "05_kyukeishakeikaikuiki", "05_jisuberikeikaikuiki"].map(d => `${DP}${d}/{z}/{x}/{y}.png`), maxZoom: 17,
		legend: [{ color: "#f5e95c", label: "警戒区域" }, { color: "#e5463c", label: "特別警戒区域" }], note: "土石流・急傾斜地の崩壊（がけ崩れ）・地すべりの警戒区域。" },
];

const GSI = "https://cyberjapandata.gsi.go.jp/xyz/";
/** 年代の航空写真（地理院タイル）。url:null＝写真を重ねない（いまの地図） */
export const ERAS: Era[] = [
	{ id: "map", name: "いまの地図", url: null, minZoom: 0, maxZoom: 0 },
	{ id: "now", name: "いまの写真", url: GSI + "seamlessphoto/{z}/{x}/{y}.jpg", minZoom: 2, maxZoom: 18 },
	{ id: "1988", name: "1988〜90 年", url: GSI + "gazo4/{z}/{x}/{y}.jpg", minZoom: 10, maxZoom: 17 },
	{ id: "1979", name: "1979〜83 年", url: GSI + "gazo2/{z}/{x}/{y}.jpg", minZoom: 10, maxZoom: 17 },
	{ id: "1974", name: "1974〜78 年", url: GSI + "gazo1/{z}/{x}/{y}.jpg", minZoom: 10, maxZoom: 17 },
	{ id: "1961", name: "1961〜69 年", url: GSI + "ort_old10/{z}/{x}/{y}.png", minZoom: 10, maxZoom: 17 },
	{ id: "1945", name: "1945〜50 年", url: GSI + "ort_USA10/{z}/{x}/{y}.png", minZoom: 10, maxZoom: 17 },
];

/** 指定緊急避難場所の対応災害（census2020 の焼き bousai/hinan の flags のビット順） */
export const HINAN_FLAGS = ["洪水", "土砂", "高潮", "地震", "津波", "大火", "内水", "火山"];
/** 避難場所の 1 行＝[経度, 緯度, 名称, 住所, 対応災害ビット] */
export type HinanRow = [number, number, string, string, number];
/** 横浜市の避難場所だけ（県の一覧から住所で選ぶ） */
export function yokohamaShelters(rows: HinanRow[]): HinanRow[] {
	const out: HinanRow[] = [];
	for (const r of rows) if (Array.isArray(r) && typeof r[3] === "string" && r[3].includes("横浜市") && Number.isFinite(r[0]) && Number.isFinite(r[1])) out.push(r);
	return out;
}
/** 住所の「横浜市◯◯区」から区を引く */
export function wardOfAddress(addr: string): Ward | null {
	const m = /横浜市(.+?区)/.exec(addr || "");
	return m ? WARDS.find(w => w.name === m[1]) ?? null : null;
}
export const flagsOf = (bits: number) => HINAN_FLAGS.filter((_, i) => bits & (1 << i));

// ── URL の状態（共有できる）：?tab=risk&hz=flood,tsunami&era=1974&ward=14104&spot=mm21 ──
const TABS: Tab[] = ["city", "risk", "time", "tools"];
export function parseState(search: string): TwinState {
	const q = new URLSearchParams(search);
	const tab = TABS.includes(q.get("tab") as Tab) ? q.get("tab") as Tab : "city";
	const hz = (q.get("hz") || "").split(",").filter(id => HAZARDS.some(h => h.id === id));
	const era = ERAS.some(e => e.id === q.get("era")) ? q.get("era")! : "map";
	const ward = WARDS.some(w => w.code === q.get("ward")) ? q.get("ward")! : "";
	const spot = SPOTS.some(s => s.id === q.get("spot")) ? q.get("spot")! : "";
	return { tab, hz: [...new Set(hz)], era, ward, spot };
}
/** 状態 → search（既定値は書かない＝素の URL を短く保つ）。他の鍵（?data= 等）は残す */
export function writeState(search: string, st: TwinState): string {
	const q = new URLSearchParams(search);
	const set = (k: string, v: string, def: string) => v && v !== def ? q.set(k, v) : q.delete(k);
	set("tab", st.tab, "city"); set("hz", st.hz.join(","), ""); set("era", st.era, "map"); set("ward", st.ward, ""); set("spot", st.spot, "");
	const s = q.toString();
	return s ? "?" + s : "";
}
