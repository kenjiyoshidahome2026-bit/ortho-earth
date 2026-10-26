// 横浜市デジタルツインの台帳（区・名所・ツアー・地下鉄の駅番号・公共施設の区分・ハザード・URL の状態）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 座標は区の中ほど／名所の建物の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 画像タイルは国土地理院（重ねるハザードマップ）を、ブラウザが直に取る。区の境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-yokohama.mjs が組んで
// ortho-data/japan/yokohama/ に置く（GitHub Pages・DATA.md）。年代の航空写真（旧「時間」）は継ぎ目と色むらが目立つので外した（本人 2026-10-21）。

export interface Ward { code: string; /** 日本語の名（住所の照合に使う） */ name: string; /** 訳の鍵（i18n/pages/yokohama.json） */ en: string; lon: number; lat: number; zoom: number }
export interface Spot { id: string; /** ja.wikipedia の記事名（写真の出どころ） */ wiki: string; name: string; ward: string; lon: number; lat: number; zoom: number; tilt: number; bearing: number; note: string }
export interface Legend { color: string; label: string; /** 画素の照合だけに使う、同じ帯のほかの色（凡例には出さない） */ match?: string[] }
export interface Hazard { id: string; name: string; urls: string[]; maxZoom: number; legend: Legend[]; note: string }
export interface TwinState { tab: Tab; ward: string; hz: string[]; spot: string; tr: string[] }
/** 面＝観光・交通・防災・解析（2026-10-21 に「まち」→「観光」・「時間」を外し「交通」を足した） */
export type Tab = "life" | "transit" | "sight" | "risk" | "tools";
export const TAB_NAMES: Record<Tab, string> = { life: "Daily life", transit: "Transport", sight: "Sightseeing", risk: "Disasters", tools: "Analysis" };

/** 横浜市の外接矩形（18 区を包む）と全景の視点 */
export const CITY_BBOX: [number, number, number, number] = [139.46, 35.31, 139.73, 35.60];
export const CITY_VIEW = { lon: 139.60, lat: 35.45, zoom: 11.3, tilt: 35, bearing: 0 };

/** 18 区（市区町村コード順）。座標は区の中ほど・zoom は区がほぼ画面に収まる値 */
export const WARDS: Ward[] = [
	{ code: "14101", name: "鶴見区", en: "Tsurumi-ku", lon: 139.680, lat: 35.497, zoom: 13.2 },
	{ code: "14102", name: "神奈川区", en: "Kanagawa-ku", lon: 139.618, lat: 35.483, zoom: 13.3 },
	{ code: "14103", name: "西区", en: "Nishi-ku", lon: 139.621, lat: 35.457, zoom: 14.2 },
	{ code: "14104", name: "中区", en: "Naka-ku", lon: 139.652, lat: 35.430, zoom: 13.4 },
	{ code: "14105", name: "南区", en: "Minami-ku", lon: 139.603, lat: 35.428, zoom: 14.0 },
	{ code: "14106", name: "保土ケ谷区", en: "Hodogaya-ku", lon: 139.583, lat: 35.459, zoom: 13.6 },
	{ code: "14107", name: "磯子区", en: "Isogo-ku", lon: 139.617, lat: 35.393, zoom: 13.6 },
	{ code: "14108", name: "金沢区", en: "Kanazawa-ku", lon: 139.625, lat: 35.341, zoom: 13.2 },
	{ code: "14109", name: "港北区", en: "Kohoku-ku", lon: 139.628, lat: 35.525, zoom: 13.4 },
	{ code: "14110", name: "戸塚区", en: "Totsuka-ku", lon: 139.530, lat: 35.400, zoom: 13.2 },
	{ code: "14111", name: "港南区", en: "Konan-ku", lon: 139.584, lat: 35.393, zoom: 13.6 },
	{ code: "14112", name: "旭区", en: "Asahi-ku", lon: 139.535, lat: 35.471, zoom: 13.3 },
	{ code: "14113", name: "緑区", en: "Midori-ku", lon: 139.527, lat: 35.513, zoom: 13.4 },
	{ code: "14114", name: "瀬谷区", en: "Seya-ku", lon: 139.488, lat: 35.469, zoom: 13.8 },
	{ code: "14115", name: "栄区", en: "Sakae-ku", lon: 139.555, lat: 35.360, zoom: 13.8 },
	{ code: "14116", name: "泉区", en: "Izumi-ku", lon: 139.495, lat: 35.418, zoom: 13.6 },
	{ code: "14117", name: "青葉区", en: "Aoba-ku", lon: 139.522, lat: 35.555, zoom: 13.3 },
	{ code: "14118", name: "都筑区", en: "Tsuzuki-ku", lon: 139.575, lat: 35.545, zoom: 13.6 },
];

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "yokohama-st", wiki: "横浜駅", name: "Yokohama Station", ward: "14103", lon: 139.6223, lat: 35.4657, zoom: 17.0, tilt: 58, bearing: 30, note: "Gateway to Yokohama, served by six railway companies. Office towers cluster on both sides of the station." },
	{ id: "mm21", wiki: "みなとみらい21", name: "Minato Mirai 21", ward: "14103", lon: 139.6315, lat: 35.4546, zoom: 16.4, tilt: 62, bearing: -20, note: "A new city center built on former shipyard and rail yard sites. Home to Yokohama Landmark Tower (296 m, opened 1993)." },
	{ id: "akarenga", wiki: "横浜赤レンガ倉庫", name: "Yokohama Red Brick Warehouse", ward: "14104", lon: 139.6425, lat: 35.4529, zoom: 17.6, tilt: 60, bearing: 20, note: "Bonded warehouses built by the national government in the late Meiji and early Taisho eras, now a shopping and cultural venue." },
	{ id: "osanbashi", wiki: "横浜港大さん橋国際客船ターミナル", name: "Osanbashi Pier", ward: "14104", lon: 139.6475, lat: 35.4513, zoom: 17.2, tilt: 60, bearing: 140, note: "International passenger terminal for large cruise ships. Its rooftop is an open plaza anyone can walk on." },
	{ id: "yamashita", wiki: "山下公園", name: "Yamashita Park", ward: "14104", lon: 139.6505, lat: 35.4460, zoom: 17.2, tilt: 60, bearing: 60, note: "Waterfront park built on land reclaimed with rubble from the Great Kanto Earthquake (opened 1930)." },
	{ id: "chinatown", wiki: "横浜中華街", name: "Yokohama Chinatown", ward: "14104", lon: 139.6460, lat: 35.4425, zoom: 17.6, tilt: 62, bearing: 45, note: "One of Japan's largest Chinatowns, which grew up after the port opened." },
	{ id: "marine-tower", wiki: "横浜マリンタワー", name: "Yokohama Marine Tower", ward: "14104", lon: 139.6506, lat: 35.4437, zoom: 17.8, tilt: 55, bearing: -30, note: "Harbor tower opened in 1961." },
	{ id: "stadium", wiki: "横浜スタジアム", name: "Yokohama Stadium", ward: "14104", lon: 139.6400, lat: 35.4433, zoom: 17.6, tilt: 58, bearing: 0, note: "Baseball stadium inside Yokohama Park." },
	{ id: "city-hall", wiki: "横浜市役所", name: "Yokohama City Hall", ward: "14104", lon: 139.6330, lat: 35.4513, zoom: 17.6, tilt: 58, bearing: 200, note: "City hall, which moved to a new building in Kitanakadori in 2020." },
	{ id: "baybridge", wiki: "横浜ベイブリッジ", name: "Yokohama Bay Bridge", ward: "14104", lon: 139.6740, lat: 35.4545, zoom: 16.0, tilt: 65, bearing: -60, note: "Cable-stayed bridge opened in 1989, shown with PLATEAU's bridge model." },
	{ id: "daikoku", wiki: "大黒ふ頭", name: "Daikoku Pier", ward: "14101", lon: 139.6800, lat: 35.4620, zoom: 16.0, tilt: 55, bearing: 20, note: "Pier handling containers and cars." },
	{ id: "sankeien", wiki: "三溪園", name: "Sankeien Garden", ward: "14104", lon: 139.6620, lat: 35.4170, zoom: 17.0, tilt: 55, bearing: 0, note: "Japanese garden created by businessman Hara Sankei and opened to the public in 1906." },
	{ id: "shin-yokohama", wiki: "新横浜駅", name: "Shin-Yokohama", ward: "14109", lon: 139.6150, lat: 35.5085, zoom: 16.6, tilt: 58, bearing: -30, note: "Northern hub with the Shinkansen station and Nissan Stadium." },
	{ id: "center-kita", wiki: "港北ニュータウン", name: "Kohoku New Town", ward: "14118", lon: 139.5785, lat: 35.5470, zoom: 16.6, tilt: 55, bearing: 0, note: "Planned residential town developed on the hills, centered on Center-Kita and Center-Minami." },
	{ id: "hakkeijima", wiki: "横浜・八景島シーパラダイス", name: "Hakkeijima", ward: "14108", lon: 139.6420, lat: 35.3380, zoom: 16.6, tilt: 58, bearing: 30, note: "Artificial island built in the sea off Kanazawa." },
];

/** 名所の写真の 1 件（photos.json・Wikimedia Commons の代表画像） */
export interface Photo { src: string; file: string; artist: string; license: string; page: string }

/** 横浜市営地下鉄の路線と駅番号（駅ナンバリング）。地図の駅は N02 の駅名で引き当てて記号を付ける */
export interface SubwayLine { id: "B" | "G"; name: string; color: string; stations: string[]; /** 駅名のローマ字（日本語以外の UI・stations と同じ並び） */ romaji: string[] }
export const SUBWAY: SubwayLine[] = [
	{ id: "B", name: "Blue Line", color: "#1f6fc5", stations: ["湘南台", "下飯田", "立場", "中田", "踊場", "戸塚", "舞岡", "下永谷", "上永谷", "港南中央", "上大岡", "弘明寺", "蒔田", "吉野町", "阪東橋", "伊勢佐木長者町", "関内", "桜木町", "高島町", "横浜", "三ツ沢下町", "三ツ沢上町", "片倉町", "岸根公園", "新横浜", "北新横浜", "新羽", "仲町台", "センター南", "センター北", "中川", "あざみ野"],
		romaji: ["Shonandai", "Shimoiida", "Tateba", "Nakada", "Odoriba", "Totsuka", "Maioka", "Shimonagaya", "Kaminagaya", "Konan-Chuo", "Kamiooka", "Gumyoji", "Maita", "Yoshinocho", "Bandobashi", "Isezakichojamachi", "Kannai", "Sakuragicho", "Takashimacho", "Yokohama", "Mitsuzawa-Shimocho", "Mitsuzawa-Kamicho", "Katakuracho", "Kishine-Koen", "Shin-Yokohama", "Kita Shin-Yokohama", "Nippa", "Nakamachidai", "Center Minami", "Center Kita", "Nakagawa", "Azamino"] },
	{ id: "G", name: "Green Line", color: "#1e9b4f", stations: ["中山", "川和町", "都筑ふれあいの丘", "センター南", "センター北", "北山田", "東山田", "高田", "日吉本町", "日吉"],
		romaji: ["Nakayama", "Kawawacho", "Tsuzuki-Fureai-no-Oka", "Center Minami", "Center Kita", "Kita-Yamata", "Higashi-Yamata", "Takata", "Hiyoshi-Honcho", "Hiyoshi"] },
];
/** 駅名 → 駅番号の並び（"B29"・"G04"…）。乗換駅（センター南・北）は 2 つ。名前の揺れ（ヶ・ケ）は畳む */
const normSta = (n: string) => String(n || "").replace(/ケ/g, "ヶ").replace(/駅$/, "").trim();
export function subwayCodes(name: string): { code: string; line: SubwayLine }[] {
	const n = normSta(name), out: { code: string; line: SubwayLine }[] = [];
	for (const l of SUBWAY) { const i = l.stations.findIndex(s => normSta(s) === n); if (i >= 0) out.push({ code: `${l.id}${String(i + 1).padStart(2, "0")}`, line: l }); }
	return out;
}
/** 交通の層（最初は全部 OFF） */
export const TRANSIT = [
	{ id: "subway", name: "Yokohama Municipal Subway (Blue Line, Green Line)" },
	{ id: "bus", name: "Yokohama Municipal Bus stops" },
	{ id: "rail", name: "JR and private railway stations and lines" },
] as const;
export const TRANSIT_DEFAULT: string[] = [];   // 最初は何も出さない（本人 2026-10-21「市営地下鉄は最初は OFF」）＝旧 URL の "tr=" も同じ意味で読める

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
	{ id: "police", file: "police-areas.json", name: "Police station jurisdictions", color: "#3949ab" },
	{ id: "fire", file: "fire-areas.json", name: "Fire station jurisdictions", color: "#e53935" },
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
/** 市の大きな病院＝市立 3・市大 2・地域中核 6（市「市立病院・地域中核病院等一覧」）。key＝台帳の名に含まれる語、name＝カードに出す短い名。
 *  横浜市には病院の「管轄区域」が無い（市全体で 1 医療圏）＝わが家のまわりでは管轄の代わりに近い順で出す（本人 2026-10-25） */
export const MAJOR_HOSPITALS: { key: string; name: string }[] = [
	{ key: "横浜市立市民病院", name: "横浜市立市民病院" },
	{ key: "脳卒中・神経脊椎センター", name: "横浜市立脳卒中・神経脊椎センター" },
	{ key: "みなと赤十字病院", name: "横浜市立みなと赤十字病院" },
	{ key: "横浜市立大学附属病院", name: "横浜市立大学附属病院" },
	{ key: "横浜市立大学附属市民総合医療センター", name: "横浜市立大学附属市民総合医療センター" },
	{ key: "済生会横浜市南部病院", name: "済生会横浜市南部病院" },
	{ key: "済生会横浜市東部病院", name: "済生会横浜市東部病院" },
	{ key: "横浜市西部病院", name: "聖マリアンナ医科大学横浜市西部病院" },
	{ key: "横浜労災病院", name: "横浜労災病院" },
	{ key: "横浜市北部病院", name: "昭和医科大学横浜市北部病院" },   // 台帳は旧名「昭和大学」
	{ key: "横浜医療センター", name: "国立病院機構横浜医療センター" },
];
/** 区の休日急患診療所（内科・小児科・日曜祝日と年末年始）＝区の番号 → 住所・電話。市「休日・夜間の急病」（kyubyo/14248.html）2026-10-26 */
export const HOLIDAY_CLINICS: Record<string, { addr: string; tel: string }> = {
	"14101": { addr: "鶴見区鶴見中央3-4-22", tel: "045-503-3851" }, "14102": { addr: "神奈川区反町1-8-4 はーと友神奈川3階", tel: "045-317-5474" },
	"14103": { addr: "西区中央1-15-18", tel: "045-322-5715" }, "14104": { addr: "中区本牧町2-353", tel: "045-622-6372" },
	"14105": { addr: "南区宿町4-76-1", tel: "045-711-7000" }, "14106": { addr: "保土ケ谷区天王町1-21", tel: "045-335-5975" },
	"14107": { addr: "磯子区磯子1-3-13", tel: "045-753-6011" }, "14108": { addr: "金沢区金沢町48", tel: "045-782-8785" },
	"14109": { addr: "港北区菊名7-8-27", tel: "045-433-2311" }, "14110": { addr: "戸塚区戸塚町4141-1", tel: "045-861-3335" },
	"14111": { addr: "港南区港南中央通7-29", tel: "045-842-8806" }, "14112": { addr: "旭区二俣川1-88-16", tel: "045-363-2020" },
	"14113": { addr: "緑区中山3-16-2", tel: "045-937-2300" }, "14114": { addr: "瀬谷区二ツ橋町489-46", tel: "045-360-8666" },
	"14115": { addr: "栄区公田町635-15", tel: "045-893-2999" }, "14116": { addr: "泉区和泉中央北5-1-5", tel: "045-806-0921" },
	"14117": { addr: "青葉区市ケ尾町31-21", tel: "045-973-2707" }, "14118": { addr: "都筑区牛久保西1-23-4", tel: "045-911-0088" },
};
/** 青葉区だけ昼休みがある（9–12 時・13–16 時）。ほかは 10–16 時 */
export const clinicHours = (code: string) => code === "14117" ? "9:00–12:00, 13:00–16:00" : "10:00–16:00";
/** 夜間急病センター（毎日 20–24 時）＝市内 3 か所。位置は国土地理院の住所検索 */
export const NIGHT_CENTERS: { name: string; addr: string; tel: string; lon: number; lat: number }[] = [
	{ name: "横浜市夜間急病センター", addr: "中区桜木町1-1", tel: "045-212-3535", lon: 139.62924, lat: 35.45356 },
	{ name: "横浜市北部夜間急病センター", addr: "都筑区牛久保西1-23-4", tel: "045-911-0088", lon: 139.58112, lat: 35.55659 },
	{ name: "横浜市南西部夜間急病センター", addr: "泉区和泉中央北5-1-5", tel: "045-806-0921", lon: 139.48894, lat: 35.41826 },
];
/** 台帳の名 → 大きな病院の短い名（でなければ null） */
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
/** 施設の 1 行＝[経度, 緯度, 名称, 区分の番号, 住所, 種別] */
export type FacilityRow = [number, number, string, number, string, string];
/** 施設の検索（common/bigtable の表・本人 2026-10-22）に載せる行＝区（ward・空＝全市）と出している種別（subs）で絞った台帳の行番号。並びは台帳のまま */
export function facilityIndex(rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>): number[] {
	const w = WARDS.find(x => x.code === ward), out: number[] = [];
	rows.forEach((r, i) => { if (subs.has(subOf(r[3], r[5])) && (!w || wardOfAddress(r[4])?.code === w.code)) out.push(i); });
	return out;
}
/** 鉄道の駅の 1 行＝[経度, 緯度, 駅名, "事業者 路線・…", 地下鉄なら 1] */
export type StationRow = [number, number, string, string, number];
/** 市営バスの停留所の 1 行＝[経度, 緯度, 停留所名, "系統・…"] */
export type BusRow = [number, number, string, string];

/** 港の物語＝開港（1859）から今までの章。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake-yokohama.mjs が両方焼く） */
export interface Chapter extends Spot { year: string; photo?: string }
export const PORT_STORY: Chapter[] = [
	{ id: "port-1859", year: "1859", wiki: "象の鼻パーク", name: "The port opens", ward: "14104", lon: 139.6430, lat: 35.4502, zoom: 17.4, tilt: 62, bearing: 60, note: "Yokohama opened to foreign trade in 1859. The curved breakwater at Zou-no-hana (Elephant's Trunk) Park traces the early pier." },
	{ id: "port-1872", year: "1872", wiki: "桜木町駅", name: "Japan's first railway", ward: "14104", lon: 139.6311, lat: 35.4510, zoom: 17.2, tilt: 58, bearing: 0, note: "In 1872 Japan's first railway linked Shimbashi in Tokyo with Yokohama, today's Sakuragicho Station." },
	{ id: "port-1911", year: "1911", photo: "akarenga", wiki: "横浜赤レンガ倉庫", name: "Warehouses for a busy port", ward: "14104", lon: 139.6425, lat: 35.4529, zoom: 17.6, tilt: 60, bearing: 20, note: "The Red Brick Warehouses (1911 and 1913) stored the goods passing through the port." },
	{ id: "port-1930", year: "1930", wiki: "氷川丸", name: "Rebuilt after the earthquake", ward: "14104", lon: 139.6497, lat: 35.4471, zoom: 17.4, tilt: 62, bearing: 40, note: "The 1923 Great Kanto Earthquake devastated the city. Its rubble became Yamashita Park (1930); the ocean liner Hikawa Maru, built in 1930, has been moored beside it since 1961." },
	{ id: "port-1983", year: "1983", photo: "mm21", wiki: "みなとみらい21", name: "Shipyards become Minato Mirai", ward: "14103", lon: 139.6315, lat: 35.4546, zoom: 16.2, tilt: 62, bearing: -20, note: "From 1983, old shipyards and rail yards became Minato Mirai 21. Landmark Tower opened in 1993, with a stone dock from the 1890s preserved at its foot." },
	{ id: "port-1989", year: "1989", photo: "baybridge", wiki: "横浜ベイブリッジ", name: "A bridge across the harbor", ward: "14104", lon: 139.6740, lat: 35.4545, zoom: 15.8, tilt: 65, bearing: -60, note: "Yokohama Bay Bridge opened in 1989, carrying traffic over the harbor entrance." },
	{ id: "port-2002", year: "2002", photo: "osanbashi", wiki: "横浜港大さん橋国際客船ターミナル", name: "Gateway for cruise ships", ward: "14104", lon: 139.6475, lat: 35.4513, zoom: 17.0, tilt: 60, bearing: 140, note: "The pier first built in 1894 got today's Osanbashi terminal in 2002. Cruise ships still arrive here." },
];
/** 海からの眺め＝港の沖に船を置いたつもりで、街並みを順に見渡す（中心＝見る先・bearing＝向き＝カメラは中心の反対側に立つ）。
 *  向きは手前（画面の下）が海になるよう実測で決めた（2026-10-21 CDP・下端の unproject が水面）。見渡しで +25° 回すので、回した後も海が手前に残る向き */
export const SEA_VIEWS = [
	{ lon: 139.6330, lat: 35.4560, zoom: 15.4, tilt: 75, bearing: -110 },   // みなとみらいを東の内港から（手前＝内港の水面）
	{ lon: 139.6480, lat: 35.4470, zoom: 15.6, tilt: 75, bearing: -140 },   // 大さん橋・山下公園を北東の内港から
	{ lon: 139.6740, lat: 35.4545, zoom: 15.0, tilt: 72, bearing: -75 },    // ベイブリッジを東京湾の側から＝港に入る船の目（奥に街）
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["yokohama-st", "mm21", "akarenga", "osanbashi", "yamashita", "chinatown", "baybridge", "shin-yokohama", "center-kita", "sankeien"];

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
	{ id: "tsunami", name: "Tsunami", urls: [DP + "04_tsunami_newlegend_data/{z}/{x}/{y}.png"], maxZoom: 17, legend: DEPTH, note: "Inundation depth in Kanagawa Prefecture's tsunami scenario." },
	{ id: "dosha", name: "Sediment disaster warning areas", urls: ["05_dosekiryukeikaikuiki", "05_kyukeishakeikaikuiki", "05_jisuberikeikaikuiki"].map(d => `${DP}${d}/{z}/{x}/{y}.png`), maxZoom: 17,
		legend: [{ color: "#fae600", label: "Warning area" }, { color: "#fa2800", label: "Special warning area" }, { color: "#00008b", label: "Steep-slope collapse hazard area (Steep Slope Act)" }],
		note: "Warning areas for debris flows, steep-slope collapses (cliff failures) and landslides. Navy shows hazard areas under the Steep Slope Act." },
];

/** PLATEAU の建物が LOD2（屋根の形まで）で配信される区＝エンジンの登録簿（plateau-sets.json）が自動で読む 5 区。残り 13 区は LOD1（箱）だけ＝この頁が任意で足す（2026-10-18 の配信を確認） */
export const LOD2_WARDS = ["14101", "14102", "14103", "14104", "14114"];
export const LOD1_WARDS = WARDS.filter(w => !LOD2_WARDS.includes(w.code));
/** 区の LOD1 建築物の 3D Tiles（PLATEAU の datacatalog・texture 版しか無い＝読む時にテクスチャは落とす） */
/** LOD1 の建物を出すズームの下限（本人 2026-10-21「ないところがあるなら全部ない方がいい」「傾きに関係なく z で決めていい」）。
 *  LOD1 の 3D Tiles は 4 段（REPLACE）で、粗い段には大きな建物しか入っていない＝細かい段が届いた枠と届いていない枠で「有る／無い」の四角いまだらになる。
 *  Mac 実測（保土ケ谷・旭・戸塚・南・真上）：z16.5 で 3〜32 秒で出そろう・z16 は 4 か所中 3 か所が 90 秒でも出そろわない（13 区が同時取得 6 本ずつ張り付く） */
export const BUILDINGS_MIN_ZOOM = 16.5;
/** 市営地下鉄（線・駅の記号）を出す最小の z＝これ未満（市より広い縮尺）では消す（本人 2026-10-21）。全市を真上から収めた時（z≈10.5〜11）は出る */
export const SUBWAY_MIN_ZOOM = 10;
/** 市の外の覆い（穴＝市の外周）の外枠 [w,s,e,n]。枠の縁が画面に入ったら覆いごと消す（縁を見せない・本人 2026-10-21） */
export const MASK_BOX: [number, number, number, number] = [138.6, 34.8, 140.6, 36.2];
/** 見えている範囲が覆いの外枠の内側か（null＝球の縁が見える＝内側でない） */
export const insideBox = (view: ArrayLike<number> | null, box: ArrayLike<number>) => !!view && view[0] > box[0] && view[1] > box[1] && view[2] < box[2] && view[3] < box[3];
export const lod1Url = (code: string) => `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${code}-bldg-lod1-texture-latest/tileset.json`;

/** 指定緊急避難場所の対応災害（census2020 の焼き bousai/hinan の flags のビット順） */
export const HINAN_FLAGS = ["Flood", "Sediment disaster", "Storm surge", "Earthquake", "Tsunami", "Large fire", "Inland flooding", "Volcano"];
/** 避難場所の 1 行＝[経度, 緯度, 名称, 住所, 対応災害ビット] */
export type HinanRow = [number, number, string, string, number];
/** 横浜市の避難場所だけ（県の一覧から住所で選ぶ） */
export function yokohamaShelters(rows: HinanRow[]): HinanRow[] {
	const out: HinanRow[] = [];
	for (const r of rows) if (Array.isArray(r) && typeof r[3] === "string" && r[3].includes("横浜市") && Number.isFinite(r[0]) && Number.isFinite(r[1])) out.push(r);
	return out;
}
/** 表記の揺れを揃える（半角カナ・全角英数＝NFKC、「ヶ」「ケ」の小書き＝ケ）＝住所の照合と施設の検索に使う。保土ケ谷区は台帳に「保土ｹ谷区」「保土ヶ谷区」も混ざる */
export const normJa = (s: string) => String(s ?? "").normalize("NFKC").replace(/[ヶヵ]/g, m => m === "ヶ" ? "ケ" : "カ");
/** 住所の「横浜市◯◯区」から区を引く */
export function wardOfAddress(addr: string): Ward | null {
	const m = /横浜市(.+?区)/.exec(normJa(addr));
	return m ? WARDS.find(w => w.name === m[1]) ?? null : null;
}
export const flagsOf = (bits: number) => HINAN_FLAGS.filter((_, i) => bits & (1 << i));

// ── URL の状態（共有できる）：?tab=risk&hz=flood,tsunami&ward=14104&spot=mm21&tr=subway,bus ──
export const TABS: Tab[] = ["life", "transit", "sight", "risk", "tools"];   // 暮らしを先頭に・次が交通・観光（本人 2026-10-25「地域を暮らしに変えて、先頭に」）＝既定の面は暮らし
const OLD_TABS: Record<string, Tab> = { city: "sight", time: "tools", area: "life" };   // 旧い共有 URL（city／time＝2026-10-21 より前・area＝2026-10-25 より前の「地域」）
export function parseState(search: string): TwinState {
	const q = new URLSearchParams(search);
	const t = q.get("tab") || "";
	const tab = TABS.includes(t as Tab) ? t as Tab : OLD_TABS[t] || TABS[0];
	const hz = (q.get("hz") || "").split(",").filter(id => HAZARDS.some(h => h.id === id));
	const ward = WARDS.some(w => w.code === q.get("ward")) ? q.get("ward")! : "";
	const spot = SPOTS.some(s => s.id === q.get("spot")) ? q.get("spot")! : "";
	const want = q.has("tr") ? (q.get("tr") || "").split(",") : TRANSIT_DEFAULT;
	const tr = TRANSIT.map(x => x.id as string).filter(id => want.includes(id));   // 台帳の並びに揃える（往復で同じ）
	return { tab, ward, hz: [...new Set(hz)], spot, tr };
}
/** 状態 → search（既定値は書かない＝素の URL を短く保つ）。他の鍵（?data= 等）は残す */
export function writeState(search: string, st: TwinState): string {
	const q = new URLSearchParams(search);
	const set = (k: string, v: string, def: string) => v && v !== def ? q.set(k, v) : q.delete(k);
	set("tab", st.tab, TABS[0]); set("hz", st.hz.join(","), ""); set("ward", st.ward, ""); set("spot", st.spot, "");
	const tr = TRANSIT.filter(x => st.tr.includes(x.id)).map(x => x.id).join(",");
	if (tr === TRANSIT_DEFAULT.join(",")) q.delete("tr"); else q.set("tr", tr);
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
/** 2 点の距離（m・球面） */
export function distM(a: [number, number], b: [number, number]): number {
	const R = 6371008.8, r = Math.PI / 180, dla = (b[1] - a[1]) * r, dlo = (b[0] - a[0]) * r;
	const h = Math.sin(dla / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dlo / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
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
/** いちばん近い点（番号と、そこまでの直線 m）。点が無ければ null */
export function walkSnap(g: WalkGraph, at: [number, number]): { i: number; m: number } | null {
	const kx = Math.cos(at[1] * Math.PI / 180), ax = at[0] / WALK_Q, ay = at[1] / WALK_Q;
	let best = -1, bd = Infinity;
	for (let i = 0; i < g.x.length; i++) { const dx = (g.x[i] - ax) * kx, dy = g.y[i] - ay, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
	return best < 0 ? null : { i: best, m: distM(at, [g.x[best] * WALK_Q, g.y[best] * WALK_Q]) };
}
/** 1 点から全部の点への道のり（m）と、来た点（道順を辿る用） */
export function walkFrom(g: WalkGraph, src: number): { dist: Float64Array; prev: Int32Array } {
	const n = g.x.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
	const hn: number[] = [], hd: number[] = [];   // 二分ヒープ（古い札は取り出した時に捨てる）
	const push = (v: number, d: number) => { let i = hn.length; hn.push(v); hd.push(d); while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hn[i] = hn[p]; hd[i] = hd[p]; i = p; } hn[i] = v; hd[i] = d; };
	const pop = () => { const v = hn[0], lv = hn.pop()!, ld = hd.pop()!; if (hn.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hn.length) break; if (c + 1 < hn.length && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; hn[i] = hn[c]; hd[i] = hd[c]; i = c; } hn[i] = lv; hd[i] = ld; } return v; };
	dist[src] = 0; push(src, 0);
	while (hn.length) {
		const d0 = hd[0], v = pop(); if (d0 > dist[v]) continue;
		for (let j = g.start[v]; j < g.start[v + 1]; j++) { const w = g.to[j], d = d0 + g.len[j]; if (d < dist[w]) { dist[w] = d; prev[w] = v; push(w, d); } }
	}
	return { dist, prev };
}
/** 家から行き先までの道のり（家と行き先から網までの直線も足す）。繋がっていない・網から 150m 超え＝null（呼ぶ側は直線に戻す） */
export function walkTo(g: WalkGraph, from: { dist: Float64Array }, home: { m: number }, to: [number, number]): { m: number; i: number } | null {
	const s = walkSnap(g, to);
	if (!s || s.m > 150 || !Number.isFinite(from.dist[s.i])) return null;
	return { m: from.dist[s.i] + home.m + s.m, i: s.i };
}
/** 道順の折れ線（家 → 網 → 行き先） */
export function walkPath(g: WalkGraph, prev: Int32Array, i: number, home: [number, number], to: [number, number]): [number, number][] {
	const out: [number, number][] = [to];
	for (let v = i; v >= 0; v = prev[v]) out.push([g.x[v] * WALK_Q, g.y[v] * WALK_Q]);
	out.push(home);
	return out.reverse();
}
