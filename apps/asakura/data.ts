// 朝倉市デジタルツインの市の設定（市・名所・ツアー・救急・朝倉の歴史の物語）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 案内板と機能は共有モジュール @ortho-earth/citytwin（packages/citytwin・共有エンジンの入口）＝横浜・京都・福岡・札幌・旭川と同じ芯（2026-11-21）。ここは朝倉の物だけ。
// 朝倉は区の無い市・地下鉄の無い市・PLATEAU の無い市（福岡県の配信は北九州・福岡・大牟田・久留米・飯塚・宗像・古賀・うきは・筑前町）＝旭川と同じ「一般市」の型。警察署・消防本部・病院・駅が市の中に揃う＝市の中だけで暮らしの台帳が閉じる。
// 座標は名所の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-asakura.mjs（中身は共通の packages/citytwin/scripts/bake-city.mjs）が組んで ortho-data/japan/asakura/ に置く（GitHub Pages・DATA.md）。作り方の指針＝docs/citytwin-guide.md。
import { HAZARDS as HAZARD_DEFS, RAIL_LAYER, subwayCodes as codesOf, railLinesEn as linesEn, sheltersIn, wardOfAddress as wardOf, facilityIndex as facIndex, parseState as parse, writeState as write, parsePlaces as places } from "@ortho-earth/citytwin/core";
import type { Ward, Spot, Hazard, SubwayLine, TransitLayer, Chapter, View, FacilityRow, HinanRow, TwinState, CityConfig, Clinic } from "@ortho-earth/citytwin/core";
export * from "@ortho-earth/citytwin/core";   // 検定（tests/t-asakura.mjs）と頁がここから引く共通の物

/** 朝倉市の外接矩形（N03 の面）と全景の視点 */
export const CITY_BBOX: [number, number, number, number] = [130.61, 33.34, 130.87, 33.5];
export const CITY_VIEW = { lon: 130.72, lat: 33.41, zoom: 12.2, tilt: 35, bearing: 0 };

/** 区の無い自治体＝市そのもの 1 つ（コード 40228）。芯は 1 行なら区の選びを出さない */
export const WARDS: Ward[] = [
	{ code: "40228", name: "朝倉市", en: "Asakura City", lon: 130.72, lat: 33.41, zoom: 11.6 },
];
const W = WARDS[0].code;

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "akizuki-castle", wiki: "秋月城", name: "Akizuki Castle Ruins", ward: W, lon: 130.69556, lat: 33.46556, zoom: 16.6, tilt: 58, bearing: 30, note: "Seat of the Akizuki domain from 1623. The Kuromon gate and the Nagayamon gate remain, along an avenue lined with cherry trees." },
	{ id: "akizuki-town", wiki: "秋月 (朝倉市)", name: "Akizuki Castle Town", ward: W, lon: 130.6936, lat: 33.4695, zoom: 16.2, tilt: 58, bearing: 0, note: "Castle town in a small basin below Mount Kosho, with old samurai houses and merchant houses. It is a national preservation district for groups of traditional buildings." },
	{ id: "suisha", wiki: "朝倉の揚水車群", name: "Asakura Water Wheels", ward: W, lon: 130.7427, lat: 33.3714, zoom: 17, tilt: 58, bearing: 0, note: "Triple and double water wheels that lift water from the Horikawa canal to the fields. They have turned every summer since the Edo period." },
	{ id: "yamada-zeki", wiki: "山田堰 (福岡県)", name: "Yamada Weir", ward: W, lon: 130.7591, lat: 33.3649, zoom: 16.6, tilt: 58, bearing: 150, note: "Slanted stone weir across the Chikugo River, completed in its present form in 1790. It still sends water to the Horikawa canal." },
	{ id: "eso-hachiman", wiki: "恵蘇八幡宮", name: "Eso Hachimangu Shrine", ward: W, lon: 130.7588, lat: 33.366, zoom: 17, tilt: 58, bearing: 0, note: "Shrine on the hill above the Yamada Weir, linked by tradition to the court that Empress Saimei set up in Asakura in 661." },
	{ id: "harazuru", wiki: "原鶴温泉", name: "Harazuru Onsen", ward: W, lon: 130.7813, lat: 33.3517, zoom: 16.6, tilt: 58, bearing: 160, note: "Hot spring town on the bank of the Chikugo River, the largest hot spring resort in Fukuoka Prefecture." },
	{ id: "amagi-koen", wiki: "甘木公園", name: "Amagi Park", ward: W, lon: 130.6663, lat: 33.4273, zoom: 16.4, tilt: 58, bearing: 0, note: "Park around a pond, known for about 4,000 cherry trees." },
	{ id: "hiratsuka", wiki: "平塚川添遺跡", name: "Hiratsuka Kawazoe Site", ward: W, lon: 130.65107, lat: 33.3944, zoom: 16.6, tilt: 58, bearing: 0, note: "Remains of a Yayoi-period village ringed by several moats, now a park with rebuilt houses. It is a national historic site." },
	{ id: "amagi-st", wiki: "甘木駅", name: "Amagi Station", ward: W, lon: 130.65519, lat: 33.41833, zoom: 16.8, tilt: 58, bearing: 0, note: "Last stop of both the Amagi Railway from Kiyama and the Nishitetsu Amagi Line from Kurume. The two stations stand a short walk apart." },
	{ id: "terauchi-dam", wiki: "寺内ダム", name: "Terauchi Dam", ward: W, lon: 130.7226, lat: 33.4305, zoom: 15.6, tilt: 58, bearing: 40, note: "Rock-fill dam on the Sata River, completed in 1978, that supplies water to the Fukuoka area." },
];

/** 地下鉄は無い＝路線なし */
export const SUBWAY: SubwayLine[] = [];
export const subwayCodes = (name: string) => codesOf(SUBWAY, name);
/** 交通の層（最初は全部 OFF） */
export const TRANSIT: TransitLayer[] = [
	{ ...RAIL_LAYER, name: "Amagi Railway, Nishitetsu and JR stations and lines" },
	{ id: "bus", name: "Bus stops (Nishitetsu Bus, Amagi Kanko Bus, city buses)" },
];
export const TRANSIT_DEFAULT: string[] = [];

/** 大きな病院。key＝台帳（KSJ P04）の名に含まれる語、name＝カードに出す短い名 */
export const MAJOR_HOSPITALS: { key: string; name: string; en: string }[] = [
	{ key: "朝倉医師会病院", name: "朝倉医師会病院", en: "Asakura Medical Association Hospital" },
	{ key: "朝倉健生病院", name: "朝倉健生病院", en: "Asakura Kensei Hospital" },
	{ key: "甘木中央病院", name: "甘木中央病院", en: "Amagi Chuo Hospital" },
];
/** 急病の夜間の診療所（公式の頁で確かめた物だけ・無ければ空） */
export const NIGHT_CENTERS: Clinic[] = [
	{ name: "朝倉地域休日夜間急患センター", addr: "来春422-1（朝倉医師会病院内）", tel: "0946-23-0077", lon: 130.66547, lat: 33.41066, enName: "Asakura Area Holiday and Night Emergency Center", en: "422-1 Raiharu (in Asakura Medical Association Hospital)" },   // 公式の頁で確認 2026-11-21 https://www.asakura-med.or.jp/emergency.html
];
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
export const facilityIndex = (rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>) => facIndex(CITY, rows, ward, subs);

/** 朝倉の歴史の物語。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake が両方焼く） */
export const STORY: Chapter[] = [
	{ id: "as-661", year: "661", wiki: "朝倉橘広庭宮", name: "A court in Asakura", ward: W, lon: 130.7365, lat: 33.3923, zoom: 15.4, tilt: 58, bearing: 0, note: "In 661 Empress Saimei moved her court to Asakura on the way to send troops to Korea, and died here the same year." },
	{ id: "as-1623", year: "1623", photo: "akizuki-castle", wiki: "秋月藩", name: "The Akizuki domain", ward: W, lon: 130.69556, lat: 33.46556, zoom: 16, tilt: 58, bearing: 0, note: "In 1623 Kuroda Nagaoki, a son of the lord of Fukuoka, founded the Akizuki domain of 50,000 koku. The castle town kept its shape for 250 years." },
	{ id: "as-1790", year: "1790", photo: "yamada-zeki", wiki: "山田堰 (福岡県)", name: "A weir of stone", ward: W, lon: 130.7591, lat: 33.3649, zoom: 16.6, tilt: 58, bearing: 150, note: "In 1790 the village headman Koga Hyakko rebuilt the Yamada Weir as a slanted stone weir, bringing water to far more fields." },
	{ id: "as-1876", year: "1876", photo: "akizuki-town", wiki: "秋月の乱", name: "The Akizuki Rebellion", ward: W, lon: 130.6936, lat: 33.4695, zoom: 16, tilt: 58, bearing: 0, note: "In October 1876 former samurai of Akizuki rose against the new government. The rebellion was put down within days." },
	{ id: "as-1939", year: "1939", photo: "amagi-st", wiki: "甘木鉄道甘木線", name: "The railway to Amagi", ward: W, lon: 130.65519, lat: 33.41833, zoom: 16.6, tilt: 58, bearing: 0, note: "In 1939 the national railway opened the Amagi Line from Kiyama. Since 1986 it has been run by the local Amagi Railway." },
	{ id: "as-2006", year: "2006", wiki: "朝倉市", name: "Asakura City", ward: W, lon: 130.66553, lat: 33.42342, zoom: 15.6, tilt: 58, bearing: 0, note: "In 2006 the city of Amagi and the towns of Asakura and Haki merged to form Asakura City." },
	{ id: "as-2017", year: "2017", wiki: "平成29年7月九州北部豪雨", name: "The heavy rain of 2017", ward: W, lon: 130.8353, lat: 33.3932, zoom: 14.6, tilt: 58, bearing: 0, note: "In July 2017 record rain in northern Kyushu caused floods and landslides in the hills of Asakura, with many lives lost." },
];
/** 眺め＝見渡す 3 つ（中心＝見る先・bearing＝向き） */
export const HILL_VIEWS: View[] = [
	{ lon: 130.69, lat: 33.462, zoom: 14.6, tilt: 75, bearing: 200 },
	{ lon: 130.667, lat: 33.425, zoom: 14.6, tilt: 75, bearing: 215 },
	{ lon: 130.765, lat: 33.365, zoom: 14.6, tilt: 75, bearing: 150 },
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["akizuki-castle", "akizuki-town", "suisha", "yamada-zeki", "eso-hachiman", "harazuru", "amagi-koen", "hiratsuka", "amagi-st", "terauchi-dam"];

/** 災害の想定＝海に面さない＝洪水と土砂災害 */
export const HAZARDS: Hazard[] = HAZARD_DEFS.filter(h => h.id === "flood" || h.id === "dosha");

/** PLATEAU の建物は無い（2026-11-21 配信カタログで確認）＝建物は基図（地理院 optimal_bvmap）の押し出し */
export const LOD2_PREFETCH: string[] = [];
export const BLD_SETS: string[] = [];
/** 外の覆い（穴＝外周）の外枠 [w,s,e,n] */
export const MASK_BOX: [number, number, number, number] = [130.1, 32.9, 131.4, 33.9];

/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語 */
export const RAIL_LINES_EN: Record<string, string> = {
	"甘木鉄道 甘木線": "Amagi Railway Amagi Line",
	"西日本鉄道 甘木線": "Nishitetsu Amagi Line",
	"九州旅客鉄道 久大線": "JR Kyudai Line",
	"西日本鉄道 天神大牟田線": "Nishitetsu Tenjin Omuta Line",
	"九州旅客鉄道 日田彦山線": "JR Hitahikosan Line",
};
export const railLinesEn = (s: string) => linesEn(RAIL_LINES_EN, s);
/** 福岡県の指定緊急避難場所（census2020 と同じ焼き） */
export const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/40.json";
export const cityShelters = (rows: HinanRow[]): HinanRow[] => sheltersIn(rows, "朝倉市");
export const wardOfAddress = (addr: string): Ward | null => wardOf(CITY, addr);
export const parseState = (search: string): TwinState => parse(CITY, search);
export const writeState = (search: string, st: TwinState): string => write(CITY, search, st);
export const parsePlaces = (raw: string | null) => places(raw, CITY_BBOX);

/** 端末に詰める物のおおよその大きさ（MB）。保存ボタンの説明に出す（Mac の実測で直す） */
export const OFFLINE_MB = 120;

/** 設定（共有モジュールの mountTwin が読む） */
export const CITY: CityConfig = {
	id: "asakura", key: "as",
	title: "Asakura Digital Twin", cityName: "Asakura City", allWards: "Asakura City", outside: "Outside Asakura City.",
	wholeCityTitle: "Show all of Asakura City", flatNote: "Shown on the flat map (press Whole city to see all of Asakura City).", zonesTitle: "Zoning and jurisdictions",
	addrPrefix: "朝倉市", bbox: CITY_BBOX, view: CITY_VIEW, maskBox: MASK_BOX,
	wards: WARDS, spots: SPOTS, tour: TOUR,
	tourIntro: "About 247 km² between the Chikugo River and the Kosho mountains. From the castle town of Akizuki to the water wheels by the river, a tour through the city in 3D.",
	story: { button: "📜 Asakura through the ages (661 to today)", chapters: STORY, views: HILL_VIEWS, viewsButton: "View the plain from above Akizuki", viewsCaption: ["View the plain from above Akizuki", "The Chikugo plain and the river, as seen from the hills in the north of the city."] },
	subway: SUBWAY, subwayName: "Subway",
	subwayColor: () => "#888",
	subwayRail: /(?!)/,
	subwayNote: "Tap a station or stop to see its lines or routes.",
	busName: "Bus",
	transit: TRANSIT, transitDefault: TRANSIT_DEFAULT, railLinesEn: RAIL_LINES_EN,
	hazards: HAZARDS,
	riskNote: "Tilt the map to compare flood depths with building heights. Scenarios are official estimates by the national government, Fukuoka Prefecture and others; real disasters can exceed them.",
	hinanUrl: HINAN_URL,
	lod2Prefetch: LOD2_PREFETCH, bldSets: BLD_SETS,
	bldNames: () => [],
	emergency: {
		night: { centers: NIGHT_CENTERS, label: "Emergency medical center (nights and holidays)", hours: "Internal medicine and surgery · weekdays 20:00 to 7:00 the next morning, Saturdays from 12:30 and Sundays and holidays from 9:00; pediatrics until 23:00. Call ahead to check." },
		advice: { text: "Unsure whether to call an ambulance? Fukuoka emergency advice line, 24 hours:", tel: "#7119" },
	},
	majorHospitals: MAJOR_HOSPITALS,
	groundCenter: true,   // 山と谷の地形＝注視点を地面に（京都・札幌・旭川と同じ）
	homeJuris: true,      // 区が無い＝警察署・消防署の管轄をわが家のカードに出す
	offlineMB: OFFLINE_MB,
};
