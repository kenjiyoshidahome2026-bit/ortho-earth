// 旭川市デジタルツインの市の設定（市・名所・ツアー・救急・旭川の歴史の物語）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 案内板と機能は共有モジュール @ortho-earth/citytwin（packages/citytwin・共有エンジンの入口）＝横浜・京都・福岡・札幌と同じ芯（2026-11-17）。ここは旭川の物だけ。
// 旭川は区の無い市・地下鉄の無い市・PLATEAU の無い市（2026-11-17 配信カタログで確認＝北海道は札幌・室蘭・更別村だけ）：
//   区＝市そのもの 1 つ（WARDS の 1 行＝芯は区の選びを出さず、統計は市の物をいつでも）・交通＝JR とバス・建物＝地理院の基図の建物（種別ごとの推定の高さ・エンジンの building-extrusion）。
// 座標は名所の建物の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 市の境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-asahikawa.mjs（中身は共通の packages/citytwin/scripts/bake-city.mjs）が組んで ortho-data/japan/asahikawa/ に置く（GitHub Pages・DATA.md）。
import { HAZARDS as HAZARD_DEFS, RAIL_LAYER, subwayCodes as codesOf, railLinesEn as linesEn, sheltersIn, wardOfAddress as wardOf, facilityIndex as facIndex, parseState as parse, writeState as write, parsePlaces as places } from "@ortho-earth/citytwin/core";
import type { Ward, Spot, Hazard, SubwayLine, TransitLayer, Chapter, View, FacilityRow, HinanRow, TwinState, CityConfig, Clinic } from "@ortho-earth/citytwin/core";
export * from "@ortho-earth/citytwin/core";   // 検定（tests/t-asahikawa.mjs）と頁がここから引く共通の物

/** 旭川市の外接矩形（N03 の市の面＝西は江丹別・東は東旭川の山・南は西神楽）と全景の視点（市街地を中心に） */
export const CITY_BBOX: [number, number, number, number] = [142.14, 43.54, 142.75, 43.96];
export const CITY_VIEW = { lon: 142.37, lat: 43.77, zoom: 11.6, tilt: 35, bearing: 0 };

/** 区の無い市＝市そのもの 1 つ（コード＝市のコード 01204）。芯は 1 行なら区の選びを出さない */
export const WARDS: Ward[] = [
	{ code: "01204", name: "旭川市", en: "Asahikawa City", lon: 142.365, lat: 43.770, zoom: 11.0 },
];
const W = WARDS[0].code;

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "asahikawa-st", wiki: "旭川駅", name: "Asahikawa Station", ward: W, lon: 142.3546, lat: 43.7628, zoom: 16.8, tilt: 58, bearing: 0, note: "Main station of northern Hokkaido, where the Hakodate, Soya, Sekihoku and Furano lines meet. The present station building opened in 2011." },
	{ id: "kaimono-koen", wiki: "平和通買物公園", name: "Heiwa-dori Shopping Park", ward: W, lon: 142.3590, lat: 43.7680, zoom: 16.8, tilt: 60, bearing: 20, note: "Opened in 1972 as Japan's first permanent pedestrian shopping street, running about 1 km north from the station." },
	{ id: "tokiwa-koen", wiki: "常磐公園 (旭川市)", name: "Tokiwa Park", ward: W, lon: 142.3633, lat: 43.7777, zoom: 16.4, tilt: 58, bearing: 0, note: "Park by the Ishikari River opened in 1916, with a pond, the Hokkaido Asahikawa Museum of Art and the central library." },
	{ id: "asahibashi", wiki: "旭橋 (旭川市)", name: "Asahi Bridge", ward: W, lon: 142.3600, lat: 43.7830, zoom: 17.0, tilt: 60, bearing: 330, note: "Steel arch bridge over the Ishikari River, completed in 1932 and a symbol of the city." },
	{ id: "kawamura-kaneto", wiki: "川村カ子トアイヌ記念館", name: "Kawamura Kaneto Ainu Memorial Museum", ward: W, lon: 142.3253, lat: 43.7856, zoom: 17.2, tilt: 58, bearing: 0, note: "One of the oldest museums of Ainu culture, run by the Kawamura family of Chikabumi." },
	{ id: "hokuchin", wiki: "北鎮記念館", name: "Hokuchin Memorial Museum", ward: W, lon: 142.3480, lat: 43.8010, zoom: 17.0, tilt: 58, bearing: 0, note: "Museum in the Ground Self-Defense Force camp on the history of the army's Seventh Division, based in Asahikawa from 1901." },
	{ id: "kamuikotan", wiki: "神居古潭", name: "Kamuikotan", ward: W, lon: 142.2430, lat: 43.7290, zoom: 15.6, tilt: 62, bearing: 60, note: "Gorge where the Ishikari River squeezes between rocks, with a suspension bridge and the preserved Kamuikotan Station building." },
	{ id: "miura-ayako", wiki: "三浦綾子記念文学館", name: "Ayako Miura Literature Museum", ward: W, lon: 142.3577, lat: 43.7548, zoom: 17.0, tilt: 58, bearing: 180, note: "Museum of the novelist Ayako Miura, in the forest of foreign trees that is the setting of her novel Hyoten (Freezing Point)." },
	{ id: "science-museum", wiki: "旭川市科学館", name: "Asahikawa City Science Center", ward: W, lon: 142.3800, lat: 43.7478, zoom: 17.0, tilt: 58, bearing: 0, note: "Science museum with a planetarium and a room where you can feel cold of minus 30 degrees." },
	{ id: "asahiyama-zoo", wiki: "旭川市旭山動物園", name: "Asahiyama Zoo", ward: W, lon: 142.4800, lat: 43.7686, zoom: 16.4, tilt: 60, bearing: 90, note: "Zoo opened in 1967, known for exhibits that show animals' natural behavior, such as penguins walking through the snow in winter." },
	{ id: "ueno-farm", wiki: "上野ファーム", name: "Ueno Farm", ward: W, lon: 142.4447, lat: 43.8143, zoom: 16.8, tilt: 58, bearing: 0, note: "English-style garden on a farm, open from spring to autumn." },
	{ id: "ramen-mura", wiki: "旭川ラーメン村", name: "Asahikawa Ramen Village", ward: W, lon: 142.4140, lat: 43.8098, zoom: 17.2, tilt: 58, bearing: 0, note: "Row of ramen shops in one building. Asahikawa ramen is known for soy sauce soup under a layer of oil that keeps it hot." },
];

/** 地下鉄は無い（旭川）＝路線なし。駅からの徒歩圏の一覧は JR の駅（芯が rail.json から組む） */
export const SUBWAY: SubwayLine[] = [];
export const subwayCodes = (name: string) => codesOf(SUBWAY, name);
/** 交通の層（最初は全部 OFF）。旭川に市営バスは無い＝路線バスの主な会社の停留所（P11） */
export const TRANSIT: TransitLayer[] = [
	{ ...RAIL_LAYER, name: "JR stations and lines" },
	{ id: "bus", name: "Bus stops (Asahikawa Denki Kido, Dohoku Bus)" },
];
export const TRANSIT_DEFAULT: string[] = [];   // 横浜・京都と同じ＝最初は何も出さない

/** 市の大きな病院（救命救急センター・大学病院・地域医療支援病院）。key＝台帳（KSJ P04）の名に含まれる語、name＝カードに出す短い名 */
export const MAJOR_HOSPITALS: { key: string; name: string; en: string }[] = [
	{ key: "旭川医科大学病院", name: "旭川医科大学病院", en: "Asahikawa Medical University Hospital" },
	{ key: "旭川赤十字病院", name: "旭川赤十字病院", en: "Asahikawa Red Cross Hospital" },
	{ key: "市立旭川病院", name: "市立旭川病院", en: "Asahikawa City Hospital" },
	{ key: "旭川厚生病院", name: "旭川厚生病院", en: "Asahikawa Kosei General Hospital" },
	{ key: "旭川医療センター", name: "国立病院機構旭川医療センター", en: "NHO Asahikawa Medical Center" },
];
/** 急病の診療所（夜間）＝旭川市夜間急病センター（市内 1 か所）。時間は市の掲載＝変わることがあるので「電話で確かめて」を添える */
export const NIGHT_CENTERS: Clinic[] = [
	{ name: "旭川市夜間急病センター", addr: "金星町1丁目1-65", tel: "0166-29-0303", lon: 142.3815, lat: 43.7830, enName: "Asahikawa City Night Emergency Center", en: "1-1-65 Kinseicho" },
];
/** 台帳の名 → 大きな病院の短い名（でなければ null） */
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
/** 施設の検索の行（市で絞る＝区の無い市は全部） */
export const facilityIndex = (rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>) => facIndex(CITY, rows, ward, subs);

/** 旭川の歴史の物語＝村ができた 1890 年から今までの章。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake が両方焼く） */
export const ASAHIKAWA_STORY: Chapter[] = [
	{ id: "ash-1890", year: "1890", photo: "asahibashi", wiki: "旭川市", name: "Villages where rivers meet", ward: W, lon: 142.3600, lat: 43.7830, zoom: 15.6, tilt: 60, bearing: 330, note: "In 1890 the villages of Asahikawa, Nagayama and Kamui were set up in the Kamikawa basin, where the Ishikari, Chubetsu and Biei rivers meet." },
	{ id: "ash-1891", year: "1891", wiki: "屯田兵", name: "Farmer-soldiers in Nagayama", ward: W, lon: 142.4120, lat: 43.8000, zoom: 15.4, tilt: 60, bearing: 0, note: "In 1891 the first tondenhei, soldiers who also cleared and farmed the land, settled in Nagayama, east of today's city centre." },
	{ id: "ash-1898", year: "1898", photo: "asahikawa-st", wiki: "旭川駅", name: "The railway arrives", ward: W, lon: 142.3546, lat: 43.7628, zoom: 16.4, tilt: 58, bearing: 0, note: "In 1898 the railway reached Asahikawa, linking the basin with Sapporo and the sea." },
	{ id: "ash-1901", year: "1901", photo: "hokuchin", wiki: "北鎮記念館", name: "A garrison town", ward: W, lon: 142.3480, lat: 43.8010, zoom: 16.0, tilt: 58, bearing: 0, note: "From 1901 the army's Seventh Division moved to Asahikawa, and the town grew around the garrison north of the river." },
	{ id: "ash-1902", year: "1902", wiki: "旭川地方気象台", name: "Minus 41 degrees", ward: W, lon: 142.3717, lat: 43.7567, zoom: 16.4, tilt: 58, bearing: 0, note: "On 25 January 1902 Asahikawa's weather station recorded minus 41.0 degrees Celsius, still the lowest in Japan's official records." },
	{ id: "ash-1922", year: "1922", photo: "kaimono-koen", wiki: "旭川市", name: "A city", ward: W, lon: 142.3654, lat: 43.7705, zoom: 16.2, tilt: 58, bearing: 0, note: "In 1922 Asahikawa became a city, one of the first six cities of Hokkaido." },
	{ id: "ash-1932", year: "1932", photo: "asahibashi", wiki: "旭橋 (旭川市)", name: "The Asahi Bridge", ward: W, lon: 142.3600, lat: 43.7830, zoom: 16.8, tilt: 60, bearing: 330, note: "The steel arch of the Asahi Bridge over the Ishikari River was completed in 1932 and became the symbol of the city." },
	{ id: "ash-1967", year: "1967", photo: "asahiyama-zoo", wiki: "旭川市旭山動物園", name: "A zoo on Mount Asahi", ward: W, lon: 142.4800, lat: 43.7686, zoom: 16.2, tilt: 60, bearing: 90, note: "Asahiyama Zoo opened in 1967. Its exhibits that let visitors watch animals move as they do in the wild later drew visitors from all over Japan." },
	{ id: "ash-1972", year: "1972", photo: "kaimono-koen", wiki: "平和通買物公園", name: "A street without cars", ward: W, lon: 142.3590, lat: 43.7680, zoom: 16.6, tilt: 60, bearing: 20, note: "In 1972 the main street from the station became Japan's first permanent pedestrian shopping street." },
	{ id: "ash-2011", year: "2011", photo: "asahikawa-st", wiki: "旭川駅", name: "A station facing the river", ward: W, lon: 142.3546, lat: 43.7628, zoom: 16.6, tilt: 58, bearing: 180, note: "The new elevated station building was completed in 2011, opening the city centre to the parks along the Chubetsu River." },
];
/** 嵐山からの眺め＝西の丘に立ったつもりで、石狩川の向こうの街並みを順に見渡す（中心＝見る先・bearing＝向き＝カメラは中心の反対側に立つ） */
export const HILL_VIEWS: View[] = [
	{ lon: 142.3600, lat: 43.7790, zoom: 15.0, tilt: 75, bearing: 100 },   // 旭橋と常磐公園の向こうに市街地（tilt はエンジンの上限 75）
	{ lon: 142.3560, lat: 43.7680, zoom: 15.0, tilt: 75, bearing: 95 },    // 買物公園と旭川駅
	{ lon: 142.3700, lat: 43.7600, zoom: 15.2, tilt: 75, bearing: 85 },    // 忠別川の川辺から大雪山の方へ
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["asahikawa-st", "kaimono-koen", "tokiwa-koen", "asahibashi", "kawamura-kaneto", "hokuchin", "kamuikotan", "miura-ayako", "science-museum", "asahiyama-zoo", "ueno-farm", "ramen-mura"];

/** 災害の想定＝海に面さない旭川は洪水と土砂災害（高潮・津波は持たない） */
export const HAZARDS: Hazard[] = HAZARD_DEFS.filter(h => h.id === "flood" || h.id === "dosha");

/** PLATEAU の建物は無い（旭川）＝先読み・通信なしの保存で詰める建物の組は空。建物は基図（地理院 optimal_bvmap の BldA）の押し出し＝基図のタイルと一緒に束に入る */
export const LOD2_PREFETCH: string[] = [];
export const BLD_SETS: string[] = [];
/** 市の外の覆い（穴＝市の外周）の外枠 [w,s,e,n]。枠の縁が画面に入ったら覆いごと消す */
export const MASK_BOX: [number, number, number, number] = [141.6, 43.2, 143.3, 44.3];

/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語（日本語以外で出す） */
export const RAIL_LINES_EN: Record<string, string> = {
	"北海道旅客鉄道 函館線": "JR Hakodate Line", "北海道旅客鉄道 宗谷線": "JR Soya Line",
	"北海道旅客鉄道 石北線": "JR Sekihoku Line", "北海道旅客鉄道 富良野線": "JR Furano Line",
};
export const railLinesEn = (s: string) => linesEn(RAIL_LINES_EN, s);
/** 北海道の指定緊急避難場所（census2020 と同じ焼き・gzip の JSON・[経度, 緯度, 名称, 住所, 対応災害ビット]） */
export const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/01.json";
export const asahikawaShelters = (rows: HinanRow[]): HinanRow[] => sheltersIn(rows, "旭川市");
/** 住所の「旭川市…」から市（区の無い市＝市そのもの）を引く */
export const wardOfAddress = (addr: string): Ward | null => wardOf(CITY, addr);
/** URL の状態（?tab=risk&hz=flood&spot=asahiyama-zoo&tr=rail,bus） */
export const parseState = (search: string): TwinState => parse(CITY, search);
export const writeState = (search: string, st: TwinState): string => write(CITY, search, st);
/** 保存した地点（市の外接矩形の外は捨てる） */
export const parsePlaces = (raw: string | null) => places(raw, CITY_BBOX);

/** 端末に詰める物のおおよその大きさ（MB）。保存ボタンの説明に出す（Mac の実測で直す） */
export const OFFLINE_MB = 400;

/** 市の設定（共有モジュールの mountTwin が読む） */
export const CITY: CityConfig = {
	id: "asahikawa", key: "ak",
	title: "Asahikawa Digital Twin", cityName: "Asahikawa City", allWards: "Asahikawa City", outside: "Outside Asahikawa City.",
	wholeCityTitle: "Show all of Asahikawa City", flatNote: "Shown on the flat map (press Whole city to see all of Asahikawa City).", zonesTitle: "Zoning and jurisdictions",
	addrPrefix: "旭川市", bbox: CITY_BBOX, view: CITY_VIEW, maskBox: MASK_BOX,
	wards: WARDS, spots: SPOTS, tour: TOUR,
	tourIntro: "About 748 km² in the Kamikawa basin. From the Asahi Bridge to Asahiyama Zoo, a tour through the city in 3D.",
	story: { button: "📜 Asahikawa through the ages (1890 to today)", chapters: ASAHIKAWA_STORY, views: HILL_VIEWS, viewsButton: "View the city from Arashiyama", viewsCaption: ["View the city from Arashiyama", "The city across the Ishikari River, as seen from the hills of Arashiyama to the west."] },
	subway: SUBWAY, subwayName: "Subway",
	subwayColor: () => "#888",   // 地下鉄は無い
	subwayRail: /(?!)/,          // どの路線にも当たらない
	subwayNote: "Tap a station or stop to see its lines or routes.",
	busName: "Bus",
	transit: TRANSIT, transitDefault: TRANSIT_DEFAULT, railLinesEn: RAIL_LINES_EN,
	hazards: HAZARDS,
	riskNote: "Tilt the map to compare flood depths with building heights. Scenarios are official estimates by the national government, Hokkaido and others; real disasters can exceed them.",
	hinanUrl: HINAN_URL,
	lod2Prefetch: LOD2_PREFETCH, bldSets: BLD_SETS,
	bldNames: () => [],   // PLATEAU の無い市
	emergency: {
		night: { centers: NIGHT_CENTERS, label: "Night emergency center", hours: "Internal medicine and pediatrics every night 19:00–07:00. Call ahead to check." },
	},
	majorHospitals: MAJOR_HOSPITALS,
	groundCenter: true,   // 盆地を丘と山が囲む（嵐山・神居古潭・旭山）＝注視点を地面に（京都・札幌と同じ）
	homeJuris: true,      // 区が無い＝警察署・消防署の管轄をわが家のカードに出す
	offlineMB: OFFLINE_MB,
};
