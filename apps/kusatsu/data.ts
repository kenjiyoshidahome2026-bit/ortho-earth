// 草津町デジタルツインの町の設定（町・名所・ツアー・救急・草津の歴史の物語）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 案内板と機能は共有モジュール @ortho-earth/citytwin（packages/citytwin・共有エンジンの入口）＝横浜・京都・福岡・札幌・旭川と同じ芯（2026-11-21）。ここは草津の物だけ。
// 草津は人口 6 千人ほどの温泉の町＝「町村」の型（docs/citytwin-guide.md）：鉄道の駅・警察の本署は町の外（長野原町）＝焼きの生活圏の枠（BAKE.lifeBox）で町の外の物も台帳に入れる。用途地域・学区・消防署・バスターミナルは町の中にある。PLATEAU は無い（群馬県の配信は前橋・桐生・館林）。
// 座標は名所の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-kusatsu.mjs（中身は共通の packages/citytwin/scripts/bake-city.mjs）が組んで ortho-data/japan/kusatsu/ に置く（GitHub Pages・DATA.md）。作り方の指針＝docs/citytwin-guide.md。
import { HAZARDS as HAZARD_DEFS, RAIL_LAYER, subwayCodes as codesOf, railLinesEn as linesEn, sheltersIn, wardOfAddress as wardOf, facilityIndex as facIndex, parseState as parse, writeState as write, parsePlaces as places } from "@ortho-earth/citytwin/core";
import type { Ward, Spot, Hazard, SubwayLine, TransitLayer, Chapter, View, FacilityRow, HinanRow, TwinState, CityConfig, Clinic } from "@ortho-earth/citytwin/core";
export * from "@ortho-earth/citytwin/core";   // 検定（tests/t-kusatsu.mjs）と頁がここから引く共通の物

/** 草津町の外接矩形（N03 の面）と全景の視点 */
export const CITY_BBOX: [number, number, number, number] = [138.52, 36.56, 138.64, 36.66];
export const CITY_VIEW = { lon: 138.595, lat: 36.62, zoom: 13.6, tilt: 35, bearing: 0 };

/** 区の無い自治体＝町そのもの 1 つ（コード 10426）。芯は 1 行なら区の選びを出さない */
export const WARDS: Ward[] = [
	{ code: "10426", name: "草津町", en: "Kusatsu Town", lon: 138.59, lat: 36.62, zoom: 13.0 },
];
const W = WARDS[0].code;

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "yubatake", wiki: "湯畑", name: "Yubatake", ward: W, lon: 138.59664, lat: 36.62281, zoom: 17.4, tilt: 58, bearing: 0, note: "Hot spring field in the middle of the town, where water at over 50 degrees runs down wooden flumes to cool. It is the symbol of Kusatsu." },
	{ id: "netsunoyu", wiki: "熱乃湯", name: "Netsu-no-yu", ward: W, lon: 138.5971, lat: 36.6226, zoom: 17.6, tilt: 58, bearing: 0, note: "Hall beside Yubatake where yumomi is shown: stirring the hot water with long boards to cool it without adding cold water." },
	{ id: "kosenji", wiki: "光泉寺", name: "Kosen-ji Temple", ward: W, lon: 138.5953, lat: 36.6218, zoom: 17.6, tilt: 58, bearing: 0, note: "Temple at the top of the stone steps above Yubatake, dedicated to the Buddha of healing who watches over the hot springs." },
	{ id: "sainokawara", wiki: "西の河原公園", name: "Sai-no-kawara Park", ward: W, lon: 138.589, lat: 36.6245, zoom: 16.8, tilt: 58, bearing: 280, note: "Park in a valley where hot water springs from the riverbed and flows as a warm stream, with a large open-air bath at the far end." },
	{ id: "otakinoyu", wiki: "大滝乃湯", name: "Otaki-no-yu", ward: W, lon: 138.6017, lat: 36.623, zoom: 17.4, tilt: 58, bearing: 0, note: "Bathhouse known for awase-yu, a row of baths at different temperatures taken from cooler to hotter." },
	{ id: "bus-terminal", wiki: "草津温泉バスターミナル", name: "Kusatsu Onsen Bus Terminal", ward: W, lon: 138.59644, lat: 36.62083, zoom: 17.2, tilt: 58, bearing: 0, note: "Gateway to the town. Buses from Naganohara-Kusatsuguchi Station on the JR Agatsuma Line arrive here in about 25 minutes." },
	{ id: "concert-hall", wiki: "草津音楽の森国際コンサートホール", name: "Kusatsu International Concert Hall", ward: W, lon: 138.5961, lat: 36.6355, zoom: 16.8, tilt: 58, bearing: 0, note: "Concert hall in the forest, home of the Kusatsu International Summer Music Academy and Festival held every August." },
	{ id: "tenguyama", wiki: "草津温泉スキー場", name: "Kusatsu Onsen Ski Resort", ward: W, lon: 138.58583, lat: 36.62917, zoom: 15.8, tilt: 62, bearing: 270, note: "Ski slopes on Mount Tengu at the edge of the town. Skiing here goes back to the 1910s." },
	{ id: "yugama", wiki: "湯釜", name: "Yugama Crater Lake", ward: W, lon: 138.5283, lat: 36.6453, zoom: 15.4, tilt: 62, bearing: 300, note: "Crater lake of Mount Kusatsu-Shirane with milky green, strongly acid water. Access depends on the volcanic alert level." },
];

/** 地下鉄は無い＝路線なし */
export const SUBWAY: SubwayLine[] = [];
export const subwayCodes = (name: string) => codesOf(SUBWAY, name);
/** 交通の層（最初は全部 OFF） */
export const TRANSIT: TransitLayer[] = [
	{ ...RAIL_LAYER, name: "Nearest JR stations and lines (outside the town)" },
	{ id: "bus", name: "Bus stops (JR Bus Kanto, Kusakaru Kotsu, Seibu Kanko Bus and others)" },
];
export const TRANSIT_DEFAULT: string[] = [];

/** 大きな病院。key＝台帳（KSJ P04）の名に含まれる語、name＝カードに出す短い名。町の外（長野原町）の病院も生活圏として入れる（焼きの lifeBox） */
export const MAJOR_HOSPITALS: { key: string; name: string; en: string }[] = [
	{ key: "西吾妻福祉病院", name: "西吾妻福祉病院", en: "Nishi-Agatsuma Welfare Hospital" },
	{ key: "草津こまくさ病院", name: "草津こまくさ病院", en: "Kusatsu Komakusa Hospital" },
];
/** 急病の夜間の診療所（公式の頁で確かめた物だけ・無ければ空） */
export const NIGHT_CENTERS: Clinic[] = [

];
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
export const facilityIndex = (rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>) => facIndex(CITY, rows, ward, subs);

/** 草津の歴史の物語。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake が両方焼く） */
export const STORY: Chapter[] = [
	{ id: "ks-1878", year: "1878", photo: "yubatake", wiki: "エルヴィン・フォン・ベルツ", name: "Dr. Baelz praises Kusatsu", ward: W, lon: 138.59664, lat: 36.62281, zoom: 16.8, tilt: 58, bearing: 0, note: "The German doctor Erwin von Baelz, who taught medicine in Tokyo, first came to Kusatsu in 1878 and told the world of its hot springs and mountain air." },
	{ id: "ks-1900", year: "1900", wiki: "草津町", name: "A town", ward: W, lon: 138.59608, lat: 36.62069, zoom: 15.8, tilt: 58, bearing: 0, note: "In 1900 the village of Kusatsu became a town." },
	{ id: "ks-1926", year: "1926", wiki: "草軽電気鉄道", name: "A light railway from Karuizawa", ward: W, lon: 138.59644, lat: 36.62083, zoom: 16.2, tilt: 58, bearing: 0, note: "In 1926 the light railway from Karuizawa reached Kusatsu Onsen, 55 km through the highlands. It closed in 1962." },
	{ id: "ks-1932", year: "1932", wiki: "国立療養所栗生楽泉園", name: "Kuryu Rakusen-en", ward: W, lon: 138.62639, lat: 36.61806, zoom: 15.8, tilt: 58, bearing: 0, note: "In 1932 the national sanatorium Kuryu Rakusen-en opened east of the town for people with Hansen's disease. A museum there records the history of their isolation." },
	{ id: "ks-1948", year: "1948", photo: "tenguyama", wiki: "草津温泉スキー場", name: "A ski lift on Mount Tengu", ward: W, lon: 138.58583, lat: 36.62917, zoom: 15.6, tilt: 62, bearing: 0, note: "In 1948 a ski lift, one of the first in Japan, began running on Mount Tengu." },
	{ id: "ks-1980", year: "1980", photo: "concert-hall", wiki: "草津音楽の森国際コンサートホール", name: "Music in summer", ward: W, lon: 138.5961, lat: 36.6355, zoom: 16.4, tilt: 58, bearing: 0, note: "The Kusatsu International Summer Music Academy and Festival began in 1980, bringing musicians from around the world every summer." },
	{ id: "ks-2018", year: "2018", wiki: "草津白根山", name: "An eruption", ward: W, lon: 138.5391, lat: 36.6238, zoom: 14.6, tilt: 62, bearing: 0, note: "On 23 January 2018 Mount Moto-Shirane, part of Mount Kusatsu-Shirane, erupted without warning beside the ski slopes." },
];
/** 眺め＝見渡す 3 つ（中心＝見る先・bearing＝向き） */
export const HILL_VIEWS: View[] = [
	{ lon: 138.5966, lat: 36.6229, zoom: 15.0, tilt: 75, bearing: 90 },
	{ lon: 138.59, lat: 36.624, zoom: 15.0, tilt: 75, bearing: 80 },
	{ lon: 138.605, lat: 36.618, zoom: 14.6, tilt: 75, bearing: 100 },
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["yubatake", "netsunoyu", "kosenji", "sainokawara", "otakinoyu", "bus-terminal", "concert-hall", "tenguyama", "yugama"];

/** 災害の想定＝海に面さない＝洪水と土砂災害 */
export const HAZARDS: Hazard[] = HAZARD_DEFS.filter(h => h.id === "flood" || h.id === "dosha");

/** PLATEAU の建物は無い（2026-11-21 配信カタログで確認）＝建物は基図（地理院 optimal_bvmap）の押し出し */
export const LOD2_PREFETCH: string[] = [];
export const BLD_SETS: string[] = [];
/** 外の覆い（穴＝外周）の外枠 [w,s,e,n] */
export const MASK_BOX: [number, number, number, number] = [138.1, 36.2, 139.1, 37.0];

/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語 */
export const RAIL_LINES_EN: Record<string, string> = {
	"東日本旅客鉄道 吾妻線": "JR Agatsuma Line",
};
export const railLinesEn = (s: string) => linesEn(RAIL_LINES_EN, s);
/** 群馬県の指定緊急避難場所（census2020 と同じ焼き） */
export const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/10.json";
export const cityShelters = (rows: HinanRow[]): HinanRow[] => sheltersIn(rows, "草津町");
export const wardOfAddress = (addr: string): Ward | null => wardOf(CITY, addr);
export const parseState = (search: string): TwinState => parse(CITY, search);
export const writeState = (search: string, st: TwinState): string => write(CITY, search, st);
export const parsePlaces = (raw: string | null) => places(raw, CITY_BBOX);

/** 端末に詰める物のおおよその大きさ（MB）。保存ボタンの説明に出す（Mac の実測で直す） */
export const OFFLINE_MB = 60;

/** 設定（共有モジュールの mountTwin が読む） */
export const CITY: CityConfig = {
	id: "kusatsu", key: "ks",
	title: "Kusatsu Digital Twin", cityName: "Kusatsu Town", allWards: "Kusatsu Town", outside: "Outside Kusatsu Town.",
	wholeCityTitle: "Show all of Kusatsu Town", flatNote: "Shown on the flat map (press Whole city to see all of Kusatsu Town).", zonesTitle: "Zoning and jurisdictions",
	addrPrefix: "草津町", bbox: CITY_BBOX, view: CITY_VIEW, maskBox: MASK_BOX,
	wards: WARDS, spots: SPOTS, tour: TOUR,
	tourIntro: "A hot spring town about 1,200 m above the sea, at the foot of Mount Kusatsu-Shirane. From Yubatake to the crater lake, a tour through the town in 3D.",
	story: { button: "📜 Kusatsu through the ages (1878 to today)", chapters: STORY, views: HILL_VIEWS, viewsButton: "View the town from Mount Tengu", viewsCaption: ["View the town from Mount Tengu", "The hot spring town around Yubatake, as seen from the slopes of Mount Tengu to the west."] },
	subway: SUBWAY, subwayName: "Subway",
	subwayColor: () => "#888",
	subwayRail: /(?!)/,
	subwayNote: "Tap a station or stop to see its lines or routes.",
	busName: "Bus",
	transit: TRANSIT, transitDefault: TRANSIT_DEFAULT, railLinesEn: RAIL_LINES_EN,
	hazards: HAZARDS,
	riskNote: "Tilt the map to compare flood depths with building heights. Scenarios are official estimates by the national government, Gunma Prefecture and others; real disasters can exceed them.",
	hinanUrl: HINAN_URL,
	lod2Prefetch: LOD2_PREFETCH, bldSets: BLD_SETS,
	bldNames: () => [],
	emergency: {
		advice: { text: "Unsure whether to call an ambulance? Gunma emergency advice line, 24 hours:", tel: "#7119" },   // 群馬県救急安心センター（2025-10-01 開始・県の頁で確認 2026-11-21）
	},
	majorHospitals: MAJOR_HOSPITALS,
	groundCenter: true,   // 山と谷の地形＝注視点を地面に（京都・札幌・旭川と同じ）
	homeJuris: true,      // 区が無い＝警察署・消防署の管轄をわが家のカードに出す
	offlineMB: OFFLINE_MB,
};
