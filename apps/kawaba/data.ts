// 川場村デジタルツインの村の設定（村・名所・ツアー・救急・川場の歴史の物語）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 案内板と機能は共有モジュール @ortho-earth/citytwin（packages/citytwin・共有エンジンの入口）＝横浜・京都・福岡・札幌・旭川と同じ芯（2026-11-21）。ここは川場の物だけ。
// 川場は人口 3 千人ほどの村＝「町村」の型（docs/citytwin-guide.md）：鉄道の駅・警察の本署・消防署・大きな病院は村の外（沼田市）＝焼きの生活圏の枠（BAKE.lifeBox）で村の外の物も台帳に入れる。用途地域は無い（noAreas）。PLATEAU は無い（群馬県の配信は前橋・桐生・館林）。
// 座標は名所の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-kawaba.mjs（中身は共通の packages/citytwin/scripts/bake-city.mjs）が組んで ortho-data/japan/kawaba/ に置く（GitHub Pages・DATA.md）。作り方の指針＝docs/citytwin-guide.md。
import { HAZARDS as HAZARD_DEFS, RAIL_LAYER, subwayCodes as codesOf, railLinesEn as linesEn, sheltersIn, wardOfAddress as wardOf, facilityIndex as facIndex, parseState as parse, writeState as write, parsePlaces as places } from "@ortho-earth/citytwin/core";
import type { Ward, Spot, Hazard, SubwayLine, TransitLayer, Chapter, View, FacilityRow, HinanRow, TwinState, CityConfig, Clinic } from "@ortho-earth/citytwin/core";
export * from "@ortho-earth/citytwin/core";   // 検定（tests/t-kawaba.mjs）と頁がここから引く共通の物

/** 川場村の外接矩形（N03 の面）と全景の視点 */
export const CITY_BBOX: [number, number, number, number] = [139.07, 36.66, 139.2, 36.81];
export const CITY_VIEW = { lon: 139.125, lat: 36.715, zoom: 13.2, tilt: 35, bearing: 0 };

/** 区の無い自治体＝村そのもの 1 つ（コード 10444）。芯は 1 行なら区の選びを出さない */
export const WARDS: Ward[] = [
	{ code: "10444", name: "川場村", en: "Kawaba Village", lon: 139.125, lat: 36.715, zoom: 12.6 },
];
const W = WARDS[0].code;

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "denen-plaza", wiki: "道の駅川場田園プラザ", name: "Kawaba Denen Plaza", ward: W, lon: 139.1107, lat: 36.694, zoom: 16.8, tilt: 58, bearing: 0, note: "Roadside station among the fields, with a farmers' market, a brewery, a bakery and a dairy." },
	{ id: "kichijoji", wiki: "吉祥寺 (川場村)", name: "Kichijo-ji Temple", ward: W, lon: 139.1272, lat: 36.7239, zoom: 17, tilt: 58, bearing: 0, note: "Zen temple of the Kencho-ji school founded in 1339, known as a temple of flowers for its gardens through the seasons." },
	{ id: "kawaba-onsen", wiki: "川場温泉", name: "Kawaba Onsen", ward: W, lon: 139.1262, lat: 36.7068, zoom: 16.6, tilt: 58, bearing: 0, note: "Hot spring by the Usune River. A legend says the monk Kobo Daishi struck the ground with his staff and the spring came out." },
	{ id: "nagai-shuzo", wiki: "永井酒造", name: "Nagai Sake Brewery", ward: W, lon: 139.1046, lat: 36.6996, zoom: 17, tilt: 58, bearing: 0, note: "Sake brewery founded in 1886, which brews with the spring water of Mount Hotaka." },
	{ id: "kenkomura", wiki: "世田谷区民健康村", name: "Setagaya Health Village", ward: W, lon: 139.14, lat: 36.716, zoom: 16.4, tilt: 58, bearing: 0, note: "Lodges and fields where residents of Setagaya, Tokyo, stay and take part in farming and forest work, under the partnership the two made in 1981." },
	{ id: "minzoku", wiki: "川場村歴史民俗資料館", name: "Kawaba Village Museum of History and Folklore", ward: W, lon: 139.112, lat: 36.7, zoom: 17.2, tilt: 58, bearing: 0, note: "Museum of village life and farming, in a wooden school building of the Meiji period." },
	{ id: "kawaba-ski", wiki: "川場スキー場", name: "Kawaba Ski Resort", ward: W, lon: 139.14, lat: 36.787, zoom: 15.2, tilt: 62, bearing: 0, note: "Ski resort high on the slopes of Mount Hotaka, opened in 1989." },
];

/** 地下鉄は無い＝路線なし */
export const SUBWAY: SubwayLine[] = [];
export const subwayCodes = (name: string) => codesOf(SUBWAY, name);
/** 交通の層（最初は全部 OFF） */
export const TRANSIT: TransitLayer[] = [
	{ ...RAIL_LAYER, name: "Nearest JR stations and lines (outside the village)" },
	{ id: "bus", name: "Bus stops (village buses)" },
];
export const TRANSIT_DEFAULT: string[] = [];

/** 大きな病院。key＝台帳（KSJ P04）の名に含まれる語、name＝カードに出す短い名。村の外（沼田市）の病院も生活圏として入れる（焼きの lifeBox） */
export const MAJOR_HOSPITALS: { key: string; name: string; en: string }[] = [
	{ key: "利根中央病院", name: "利根中央病院", en: "Tone Chuo Hospital" },
	{ key: "沼田病院", name: "国立病院機構沼田病院", en: "NHO Numata Hospital" },
	{ key: "群馬パース病院", name: "群馬パース病院", en: "Gunma Paz Hospital" },
];
/** 急病の夜間の診療所（公式の頁で確かめた物だけ・無ければ空） */
export const NIGHT_CENTERS: Clinic[] = [

];
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
export const facilityIndex = (rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>) => facIndex(CITY, rows, ward, subs);

/** 川場の歴史の物語。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake が両方焼く） */
export const STORY: Chapter[] = [
	{ id: "kw-1339", year: "1339", photo: "kichijoji", wiki: "吉祥寺 (川場村)", name: "A Zen temple", ward: W, lon: 139.1272, lat: 36.7239, zoom: 16.6, tilt: 58, bearing: 0, note: "Kichijo-ji was founded in 1339 as a temple of the Kencho-ji school of Rinzai Zen." },
	{ id: "kw-1889", year: "1889", wiki: "川場村", name: "One village", ward: W, lon: 139.11, lat: 36.6975, zoom: 14.8, tilt: 58, bearing: 0, note: "In 1889 several villages along the Usune River joined to form Kawaba Village. It has kept the same borders ever since." },
	{ id: "kw-1981", year: "1981", photo: "kenkomura", wiki: "世田谷区民健康村", name: "A partnership with Setagaya", ward: W, lon: 139.14, lat: 36.716, zoom: 15.8, tilt: 58, bearing: 0, note: "In 1981 Kawaba and Setagaya, Tokyo, signed a partnership to build a second home in the country for Setagaya's residents." },
	{ id: "kw-1989", year: "1989", photo: "kawaba-ski", wiki: "川場スキー場", name: "A ski resort", ward: W, lon: 139.14, lat: 36.787, zoom: 15, tilt: 62, bearing: 0, note: "Kawaba Ski Resort opened on Mount Hotaka in 1989, bringing winter visitors to the village." },
	{ id: "kw-1998", year: "1998", photo: "denen-plaza", wiki: "道の駅川場田園プラザ", name: "Farming plus tourism", ward: W, lon: 139.1107, lat: 36.694, zoom: 16.4, tilt: 58, bearing: 0, note: "Denen Plaza, built under the village's policy of farming plus tourism, opened fully in 1998 and became the village's front door." },
];
/** 眺め＝見渡す 3 つ（中心＝見る先・bearing＝向き） */
export const HILL_VIEWS: View[] = [
	{ lon: 139.115, lat: 36.7, zoom: 14.4, tilt: 75, bearing: 180 },
	{ lon: 139.127, lat: 36.722, zoom: 14.4, tilt: 75, bearing: 200 },
	{ lon: 139.135, lat: 36.76, zoom: 14.0, tilt: 75, bearing: 170 },
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["denen-plaza", "kichijoji", "kawaba-onsen", "nagai-shuzo", "kenkomura", "minzoku", "kawaba-ski"];

/** 災害の想定＝海に面さない＝洪水と土砂災害 */
export const HAZARDS: Hazard[] = HAZARD_DEFS.filter(h => h.id === "flood" || h.id === "dosha");

/** PLATEAU の建物は無い（2026-11-21 配信カタログで確認）＝建物は基図（地理院 optimal_bvmap）の押し出し */
export const LOD2_PREFETCH: string[] = [];
export const BLD_SETS: string[] = [];
/** 外の覆い（穴＝外周）の外枠 [w,s,e,n] */
export const MASK_BOX: [number, number, number, number] = [138.6, 36.3, 139.7, 37.2];

/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語 */
export const RAIL_LINES_EN: Record<string, string> = {
	"東日本旅客鉄道 上越線": "JR Joetsu Line",
	"東日本旅客鉄道 上越新幹線": "Joetsu Shinkansen",
};
export const railLinesEn = (s: string) => linesEn(RAIL_LINES_EN, s);
/** 群馬県の指定緊急避難場所（census2020 と同じ焼き） */
export const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/10.json";
export const cityShelters = (rows: HinanRow[]): HinanRow[] => sheltersIn(rows, "川場村");
export const wardOfAddress = (addr: string): Ward | null => wardOf(CITY, addr);
export const parseState = (search: string): TwinState => parse(CITY, search);
export const writeState = (search: string, st: TwinState): string => write(CITY, search, st);
export const parsePlaces = (raw: string | null) => places(raw, CITY_BBOX);

/** 端末に詰める物のおおよその大きさ（MB）。保存ボタンの説明に出す（Mac の実測で直す） */
export const OFFLINE_MB = 60;

/** 設定（共有モジュールの mountTwin が読む） */
export const CITY: CityConfig = {
	id: "kawaba", key: "kw",
	title: "Kawaba Digital Twin", cityName: "Kawaba Village", allWards: "Kawaba Village", outside: "Outside Kawaba Village.",
	wholeCityTitle: "Show all of Kawaba Village", flatNote: "Shown on the flat map (press Whole city to see all of Kawaba Village).", zonesTitle: "Zoning and jurisdictions",
	addrPrefix: "川場村", bbox: CITY_BBOX, view: CITY_VIEW, maskBox: MASK_BOX,
	wards: WARDS, spots: SPOTS, tour: TOUR,
	tourIntro: "A village of about 85 km² at the southern foot of Mount Hotaka. From the roadside station among the fields to the temple of flowers, a tour through the village in 3D.",
	story: { button: "📜 Kawaba through the ages (1339 to today)", chapters: STORY, views: HILL_VIEWS, viewsButton: "View the village from Mount Hotaka", viewsCaption: ["View the village from Mount Hotaka", "The fields along the Usune River, as seen from the slopes of Mount Hotaka to the north."] },
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
	majorHospitals: MAJOR_HOSPITALS,
	noAreas: ["zoning"],   // 用途地域の無い村（都市計画区域の外）
	groundCenter: true,   // 山と谷の地形＝注視点を地面に（京都・札幌・旭川と同じ）
	homeJuris: true,      // 区が無い＝警察署・消防署の管轄をわが家のカードに出す
	offlineMB: OFFLINE_MB,
};
