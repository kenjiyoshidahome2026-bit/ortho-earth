// 横浜市デジタルツインの市の設定（区・名所・ツアー・地下鉄の駅番号・救急・港の物語）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 案内板と機能は共有モジュール @ortho-earth/citytwin（packages/citytwin・共有エンジンの入口）＝京都市と同じ芯（2026-11-14 に切り出し）。ここは横浜の物だけ。
// 座標は区の中ほど／名所の建物の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 区の境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-yokohama.mjs が組んで ortho-data/japan/yokohama/ に置く（GitHub Pages・DATA.md）。
import { HAZARDS as HAZARD_DEFS, RAIL_LAYER, subwayCodes as codesOf, railLinesEn as linesEn, sheltersIn, wardOfAddress as wardOf, facilityIndex as facIndex, parseState as parse, writeState as write, parsePlaces as places } from "@ortho-earth/citytwin/core";
import type { Ward, Spot, Hazard, SubwayLine, TransitLayer, Chapter, View, FacilityRow, HinanRow, TwinState, CityConfig } from "@ortho-earth/citytwin/core";
export * from "@ortho-earth/citytwin/core";   // 検定（tests/t-yokohama.mjs）と頁がここから引く共通の物

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
	{ id: "santo", wiki: "横浜三塔", name: "The Three Towers of Yokohama", ward: "14104", lon: 139.6422, lat: 35.4483, zoom: 17.3, tilt: 60, bearing: 235, note: "Three historic towers nicknamed after playing cards: the King (Kanagawa Prefectural Government Office, 1928), the Queen (Yokohama Customs, 1934) and the Jack (Port Opening Memorial Hall, 1917), all within a short walk.",
		marks: [{ name: "King · Kanagawa Prefectural Office", lon: 139.64233, lat: 35.4475 }, { name: "Queen · Yokohama Customs", lon: 139.64244, lat: 35.44917 }, { name: "Jack · Port Opening Memorial Hall", lon: 139.64136, lat: 35.44765 }] },
	{ id: "osanbashi", wiki: "横浜港大さん橋国際客船ターミナル", name: "Osanbashi Pier", ward: "14104", lon: 139.6475, lat: 35.4513, zoom: 17.2, tilt: 60, bearing: 140, note: "International passenger terminal for large cruise ships. Its rooftop is an open plaza anyone can walk on." },
	{ id: "yamashita", wiki: "山下公園", name: "Yamashita Park", ward: "14104", lon: 139.6505, lat: 35.4460, zoom: 17.2, tilt: 60, bearing: 60, note: "Waterfront park built on land reclaimed with rubble from the Great Kanto Earthquake (opened 1930)." },
	{ id: "chinatown", wiki: "横浜中華街", name: "Yokohama Chinatown", ward: "14104", lon: 139.6460, lat: 35.4425, zoom: 17.6, tilt: 62, bearing: 45, note: "One of Japan's largest Chinatowns, which grew up after the port opened.", near: [139.6478, 35.4430] },
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

/** 横浜市営地下鉄の路線と駅番号（駅ナンバリング）。地図の駅は N02 の駅名で引き当てて記号を付ける */
export const SUBWAY: SubwayLine[] = [
	{ id: "B", name: "Blue Line", color: "#1f6fc5", stations: ["湘南台", "下飯田", "立場", "中田", "踊場", "戸塚", "舞岡", "下永谷", "上永谷", "港南中央", "上大岡", "弘明寺", "蒔田", "吉野町", "阪東橋", "伊勢佐木長者町", "関内", "桜木町", "高島町", "横浜", "三ツ沢下町", "三ツ沢上町", "片倉町", "岸根公園", "新横浜", "北新横浜", "新羽", "仲町台", "センター南", "センター北", "中川", "あざみ野"],
		romaji: ["Shonandai", "Shimoiida", "Tateba", "Nakada", "Odoriba", "Totsuka", "Maioka", "Shimonagaya", "Kaminagaya", "Konan-Chuo", "Kamiooka", "Gumyoji", "Maita", "Yoshinocho", "Bandobashi", "Isezakichojamachi", "Kannai", "Sakuragicho", "Takashimacho", "Yokohama", "Mitsuzawa-Shimocho", "Mitsuzawa-Kamicho", "Katakuracho", "Kishine-Koen", "Shin-Yokohama", "Kita Shin-Yokohama", "Nippa", "Nakamachidai", "Center Minami", "Center Kita", "Nakagawa", "Azamino"] },
	{ id: "G", name: "Green Line", color: "#1e9b4f", stations: ["中山", "川和町", "都筑ふれあいの丘", "センター南", "センター北", "北山田", "東山田", "高田", "日吉本町", "日吉"],
		romaji: ["Nakayama", "Kawawacho", "Tsuzuki-Fureai-no-Oka", "Center Minami", "Center Kita", "Kita-Yamata", "Higashi-Yamata", "Takata", "Hiyoshi-Honcho", "Hiyoshi"] },
];
/** 駅名 → 駅番号の並び（"B29"・"G04"…）。乗換駅（センター南・北）は 2 つ */
export const subwayCodes = (name: string) => codesOf(SUBWAY, name);
/** 交通の層（最初は全部 OFF） */
export const TRANSIT: TransitLayer[] = [
	{ id: "subway", name: "Yokohama Municipal Subway (Blue Line, Green Line)" },
	RAIL_LAYER,
	{ id: "bus", name: "Yokohama Municipal Bus stops" },   // 鉄道の後（本人 2026-11-13「バスの停留所と JR・私鉄の順番を逆に」）
];
export const TRANSIT_DEFAULT: string[] = [];   // 最初は何も出さない（本人 2026-10-21「市営地下鉄は最初は OFF」）＝旧 URL の "tr=" も同じ意味で読める

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
export const HOLIDAY_CLINICS: Record<string, { addr: string; tel: string; en: string }> = {   // en＝日本語以外の UI の住所
	"14101": { addr: "鶴見区鶴見中央3-4-22", tel: "045-503-3851", en: "3-4-22 Tsurumi-chuo, Tsurumi-ku" }, "14102": { addr: "神奈川区反町1-8-4 はーと友神奈川3階", tel: "045-317-5474", en: "3F Heart-tomo Kanagawa, 1-8-4 Tammachi, Kanagawa-ku" },
	"14103": { addr: "西区中央1-15-18", tel: "045-322-5715", en: "1-15-18 Chuo, Nishi-ku" }, "14104": { addr: "中区本牧町2-353", tel: "045-622-6372", en: "2-353 Honmokucho, Naka-ku" },
	"14105": { addr: "南区宿町4-76-1", tel: "045-711-7000", en: "4-76-1 Shukumachi, Minami-ku" }, "14106": { addr: "保土ケ谷区天王町1-21", tel: "045-335-5975", en: "1-21 Tennocho, Hodogaya-ku" },
	"14107": { addr: "磯子区磯子1-3-13", tel: "045-753-6011", en: "1-3-13 Isogo, Isogo-ku" }, "14108": { addr: "金沢区金沢町48", tel: "045-782-8785", en: "48 Kanazawacho, Kanazawa-ku" },
	"14109": { addr: "港北区菊名7-8-27", tel: "045-433-2311", en: "7-8-27 Kikuna, Kohoku-ku" }, "14110": { addr: "戸塚区戸塚町4141-1", tel: "045-861-3335", en: "4141-1 Totsukacho, Totsuka-ku" },
	"14111": { addr: "港南区港南中央通7-29", tel: "045-842-8806", en: "7-29 Konan-chuodori, Konan-ku" }, "14112": { addr: "旭区二俣川1-88-16", tel: "045-363-2020", en: "1-88-16 Futamatagawa, Asahi-ku" },
	"14113": { addr: "緑区中山3-16-2", tel: "045-937-2300", en: "3-16-2 Nakayama, Midori-ku" }, "14114": { addr: "瀬谷区二ツ橋町489-46", tel: "045-360-8666", en: "489-46 Futatsubashicho, Seya-ku" },
	"14115": { addr: "栄区公田町635-15", tel: "045-893-2999", en: "635-15 Kudencho, Sakae-ku" }, "14116": { addr: "泉区和泉中央北5-1-5", tel: "045-806-0921", en: "5-1-5 Izumi-chuo-kita, Izumi-ku" },
	"14117": { addr: "青葉区市ケ尾町31-21", tel: "045-973-2707", en: "31-21 Ichigaocho, Aoba-ku" }, "14118": { addr: "都筑区牛久保西1-23-4", tel: "045-911-0088", en: "1-23-4 Ushikubo-nishi, Tsuzuki-ku" },
};
/** 青葉区だけ昼休みがある（9–12 時・13–16 時）。ほかは 10–16 時 */
export const clinicHours = (code: string) => code === "14117" ? "9:00–12:00, 13:00–16:00" : "10:00–16:00";
/** 夜間急病センター（毎日 20–24 時）＝市内 3 か所。位置は国土地理院の住所検索 */
export const NIGHT_CENTERS: { name: string; addr: string; tel: string; lon: number; lat: number; enName: string; en: string }[] = [
	{ name: "横浜市夜間急病センター", addr: "中区桜木町1-1", tel: "045-212-3535", lon: 139.62924, lat: 35.45356, enName: "Yokohama Night Emergency Center", en: "1-1 Sakuragicho, Naka-ku" },
	{ name: "横浜市北部夜間急病センター", addr: "都筑区牛久保西1-23-4", tel: "045-911-0088", lon: 139.58112, lat: 35.55659, enName: "Yokohama Northern Night Emergency Center", en: "1-23-4 Ushikubo-nishi, Tsuzuki-ku" },
	{ name: "横浜市南西部夜間急病センター", addr: "泉区和泉中央北5-1-5", tel: "045-806-0921", lon: 139.48894, lat: 35.41826, enName: "Yokohama Southwestern Night Emergency Center", en: "5-1-5 Izumi-chuo-kita, Izumi-ku" },
];
/** 台帳の名 → 大きな病院の短い名（でなければ null） */
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
/** 施設の検索の行（区で絞る） */
export const facilityIndex = (rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>) => facIndex(CITY, rows, ward, subs);

/** 港の物語＝開港（1859）から今までの章。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake-yokohama.mjs が両方焼く） */
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
export const SEA_VIEWS: View[] = [
	{ lon: 139.6330, lat: 35.4560, zoom: 15.4, tilt: 75, bearing: -110 },   // みなとみらいを東の内港から（手前＝内港の水面）
	{ lon: 139.6480, lat: 35.4470, zoom: 15.6, tilt: 75, bearing: -140 },   // 大さん橋・山下公園を北東の内港から
	{ lon: 139.6740, lat: 35.4545, zoom: 15.0, tilt: 72, bearing: -75 },    // ベイブリッジを東京湾の側から＝港に入る船の目（奥に街）
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["yokohama-st", "mm21", "akarenga", "osanbashi", "santo", "yamashita", "chinatown", "baybridge", "shin-yokohama", "center-kita", "sankeien"];

/** 災害の想定（全国の型紙・津波は神奈川県の想定） */
export const HAZARDS: Hazard[] = HAZARD_DEFS.map(h => h.id === "tsunami" ? { ...h, note: "Inundation depth in Kanagawa Prefecture's tsunami scenario." } : h);

/** PLATEAU の建物が LOD2（屋根の形まで）で配信される区。残り 13 区は LOD1（箱）だけ（2026-10-18 の配信を確認）。
 *  18 区とも描くのはエンジン（登録簿 plateau-sets.json＝#1052 から LOD1 の区も載る・R2 の焼き GIS/plateau を先に読む）。この頁は LOD1 を自前で足さない（2026-11-12 まで 3D Tiles を直に足していた＝二重） */
export const LOD2_WARDS = ["14101", "14102", "14103", "14104", "14114"];
/** 先読みする PLATEAU LOD2（エンジンの登録簿 plateau-sets.json の名前）＝観光の主役から。起動直後に map.prefetchBuildings で IDB へ（本人 2026-10-26） */
export const LOD2_PREFETCH = ["横浜西区", "横浜中区", "横浜市（橋梁）", "横浜神奈川区", "横浜鶴見区", "横浜瀬谷区"];
export const LOD1_WARDS = WARDS.filter(w => !LOD2_WARDS.includes(w.code));
/** 通信なしの保存で端末に詰める建物＝18 区＋橋梁（エンジンの登録簿の名前）。R2 の焼き（量子化済み・Mac 実測 248 ファイル約 73 MB）をエンジンの IDB/OPFS へ（map.prefetchBuildings） */
export const BLD_SETS = [...WARDS.map(w => "横浜" + w.name), "横浜市（橋梁）"];
/** 市の外の覆い（穴＝市の外周）の外枠 [w,s,e,n]。枠の縁が画面に入ったら覆いごと消す（縁を見せない・本人 2026-10-21） */
export const MASK_BOX: [number, number, number, number] = [138.6, 34.8, 140.6, 36.2];

/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語（日本語以外で出す・本人 2026-10-26） */
export const RAIL_LINES_EN: Record<string, string> = {
	"横浜高速鉄道 みなとみらい21線": "Minatomirai Line", "横浜市 1号線": "Blue Line", "横浜市 3号線": "Blue Line", "横浜市 4号線": "Green Line", "横浜シーサイドライン 金沢シーサイドライン": "Kanazawa Seaside Line",
	"京王電鉄 相模原線": "Keio Sagamihara Line", "京浜急行電鉄 空港線": "Keikyu Airport Line", "京浜急行電鉄 逗子線": "Keikyu Zushi Line", "京浜急行電鉄 大師線": "Keikyu Daishi Line", "京浜急行電鉄 本線": "Keikyu Main Line",
	"江ノ島電鉄 江ノ島電鉄線": "Enoden Line", "小田急電鉄 江ノ島線": "Odakyu Enoshima Line", "小田急電鉄 小田原線": "Odakyu Odawara Line", "小田急電鉄 多摩線": "Odakyu Tama Line", "湘南モノレール 江の島線": "Shonan Monorail",
	"相模鉄道 相鉄いずみ野線": "Sotetsu Izumino Line", "相模鉄道 相鉄本線": "Sotetsu Main Line", "相模鉄道 相鉄新横浜線": "Sotetsu Shin-Yokohama Line", "東海旅客鉄道 東海道新幹線": "Tokaido Shinkansen",
	"東京モノレール 東京モノレール羽田空港線": "Tokyo Monorail", "東急電鉄 こどもの国線": "Tokyu Kodomonokuni Line", "東急電鉄 大井町線": "Tokyu Oimachi Line", "東急電鉄 池上線": "Tokyu Ikegami Line",
	"東急電鉄 田園都市線": "Tokyu Den-en-toshi Line", "東急電鉄 東横線": "Tokyu Toyoko Line", "東急電鉄 東急多摩川線": "Tokyu Tamagawa Line", "東急電鉄 目黒線": "Tokyu Meguro Line", "東急電鉄 東急新横浜線": "Tokyu Shin-Yokohama Line",
	"東京都 1号線浅草線": "Toei Asakusa Line", "東京臨海高速鉄道 臨海副都心線": "Rinkai Line", "東日本旅客鉄道 横須賀線": "JR Yokosuka Line", "東日本旅客鉄道 横浜線": "JR Yokohama Line", "東日本旅客鉄道 根岸線": "JR Negishi Line",
	"東日本旅客鉄道 山手線": "JR Yamanote Line", "東日本旅客鉄道 鶴見線": "JR Tsurumi Line", "東日本旅客鉄道 東海道線": "JR Tokaido Line", "東日本旅客鉄道 南武線": "JR Nambu Line",
};
export const railLinesEn = (s: string) => linesEn(RAIL_LINES_EN, s);
/** 神奈川県の指定緊急避難場所（census2020 と同じ焼き・gzip の JSON・[経度, 緯度, 名称, 住所, 対応災害ビット]） */
export const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/14.json";
export const yokohamaShelters = (rows: HinanRow[]): HinanRow[] => sheltersIn(rows, "横浜市");
/** 住所の「横浜市◯◯区」から区を引く */
export const wardOfAddress = (addr: string): Ward | null => wardOf(CITY, addr);
/** URL の状態（?tab=risk&hz=flood,tsunami&ward=14104&spot=mm21&tr=subway,bus） */
export const parseState = (search: string): TwinState => parse(CITY, search);
export const writeState = (search: string, st: TwinState): string => write(CITY, search, st);
/** 保存した地点（市の外接矩形の外は捨てる） */
export const parsePlaces = (raw: string | null) => places(raw, CITY_BBOX);

/** 端末に詰める物のおおよその大きさ（MB）＝Mac の実測（scripts/measure-offline.mjs）。保存ボタンの説明に出す */
export const OFFLINE_MB = 750;   // 実測（MacBook 本番・新しいプロファイル 2026-11-13）：保存 112 秒・カード 721 MB・端末の使用量 +790 MB（エンジンの置き場を含む）。少し多めに言う

/** 市の設定（共有モジュールの mountTwin が読む） */
export const CITY: CityConfig = {
	id: "yokohama", key: "yk",
	title: "Yokohama Digital Twin", cityName: "Yokohama City", allWards: "Yokohama City (18 wards)", outside: "Outside Yokohama City.",
	wholeCityTitle: "Show the whole city", flatNote: "Shown on the flat district map (choose a district or the whole city).", zonesTitle: "Zones and districts",
	addrPrefix: "横浜市", bbox: CITY_BBOX, view: CITY_VIEW, maskBox: MASK_BOX,
	wards: WARDS, spots: SPOTS, tour: TOUR,
	tourIntro: "18 wards, about 437 km². From the port to the hillside suburbs, a tour through the city in 3D.",
	story: { button: "⚓ Port story (1859 to today)", chapters: PORT_STORY, views: SEA_VIEWS, viewsButton: "View the city from the sea", viewsCaption: ["View the city from the sea", "The skyline as seen from a ship entering the harbor."] },
	subway: SUBWAY, subwayName: "Yokohama Municipal Subway",
	subwayColor: name => /4号線|グリーン/.test(name) ? SUBWAY[1].color : SUBWAY[0].color,   // N02 の路線名＝1号線・3号線（ブルー）／4号線（グリーン）
	subwayRail: /^横浜市 [134]号線/,
	subwayNote: "Subway stations carry their station numbers (B = Blue Line, G = Green Line). Tap a station or stop to see its lines or routes.",
	busName: "Yokohama Municipal Bus",
	transit: TRANSIT, transitDefault: TRANSIT_DEFAULT, railLinesEn: RAIL_LINES_EN,
	hazards: HAZARDS,
	riskNote: "Tilt the map to compare flood depths with building heights. Scenarios are official estimates by the national government, Kanagawa Prefecture and others; real disasters can exceed them.",
	inland: { text: "Inland flooding (rain the sewers cannot drain) is published by the city only as PDF maps.", link: "City flood hazard maps", url: "https://www.city.yokohama.lg.jp/bousai-kyukyu-bohan/bousai-saigai/map/shinsui/sinsuiHM.html" },
	hinanUrl: HINAN_URL,
	lod2Prefetch: LOD2_PREFETCH, bldSets: BLD_SETS,
	bldNames: code => { const w = WARDS.find(x => x.code === code); return w ? ["横浜" + w.name, ...(w.code === "14104" ? ["横浜市（橋梁）"] : [])] : []; },   // 中区＝ベイブリッジの橋梁も
	emergency: {
		holiday: { clinics: HOLIDAY_CLINICS, name: "$1 Holiday Emergency Clinic", hours: "Internal medicine and pediatrics · Sundays, holidays and Dec 30–Jan 3, $1", time: clinicHours },
		night: { centers: NIGHT_CENTERS, hours: "Internal medicine and pediatrics · every day, 20:00–24:00" },
		advice: { text: "Unsure whether to call an ambulance? Kanagawa emergency advice line, 24 hours:", tel: "#7119" },
	},
	majorHospitals: MAJOR_HOSPITALS,
	homeJuris: false,   // 警察署・消防署の管轄は横浜では区と同じ＝カードに出さない（本人 2026-10-25・作りは残す）
	offlineMB: OFFLINE_MB,
};
