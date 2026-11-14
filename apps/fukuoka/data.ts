// 福岡市デジタルツインの市の設定（区・名所・ツアー・地下鉄の駅番号・救急・福岡の歴史の物語）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 案内板と機能は共有モジュール @ortho-earth/citytwin（packages/citytwin・共有エンジンの入口）＝横浜市・京都市デジタルツインと同じ芯（2026-11-15）。ここは福岡の物だけ。
// 座標は区の中ほど／名所の建物の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 区の境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-fukuoka.mjs（中身は共通の packages/citytwin/scripts/bake-city.mjs）が組んで ortho-data/japan/fukuoka/ に置く（GitHub Pages・DATA.md）。
import { HAZARDS as HAZARD_DEFS, RAIL_LAYER, subwayCodes as codesOf, railLinesEn as linesEn, sheltersIn, wardOfAddress as wardOf, facilityIndex as facIndex, parseState as parse, writeState as write, parsePlaces as places } from "@ortho-earth/citytwin/core";
import type { Ward, Spot, Hazard, SubwayLine, TransitLayer, Chapter, View, FacilityRow, HinanRow, TwinState, CityConfig, Clinic } from "@ortho-earth/citytwin/core";
export * from "@ortho-earth/citytwin/core";   // 検定（tests/t-fukuoka.mjs）と頁がここから引く共通の物

/** 福岡市の外接矩形（7 区を包む・北西の沖の小呂島まで）と全景の視点（博多・天神を中心に） */
export const CITY_BBOX: [number, number, number, number] = [130.02, 33.42, 130.50, 33.88];
export const CITY_VIEW = { lon: 130.385, lat: 33.585, zoom: 11.8, tilt: 35, bearing: 0 };
/** 区と市の「収める枠」に使う範囲＝沖の小呂島（西区・本土から約 25 km）を外す。島を入れると西区も市全体も小さく描かれる（bake の fitBox） */
export const FIT_BOX: [number, number, number, number] = [130.10, 33.40, 130.55, 33.76];

/** 7 区（市区町村コード順）。座標は区の中ほど（西区・早良区は市街地寄り）・zoom は区がほぼ画面に収まる値 */
export const WARDS: Ward[] = [
	{ code: "40131", name: "東区", en: "Higashi-ku", lon: 130.425, lat: 33.640, zoom: 12.4 },
	{ code: "40132", name: "博多区", en: "Hakata-ku", lon: 130.440, lat: 33.580, zoom: 12.8 },
	{ code: "40133", name: "中央区", en: "Chuo-ku", lon: 130.388, lat: 33.585, zoom: 13.6 },
	{ code: "40134", name: "南区", en: "Minami-ku", lon: 130.415, lat: 33.545, zoom: 13.2 },
	{ code: "40135", name: "西区", en: "Nishi-ku", lon: 130.290, lat: 33.580, zoom: 12.0 },
	{ code: "40136", name: "城南区", en: "Jonan-ku", lon: 130.370, lat: 33.555, zoom: 13.6 },
	{ code: "40137", name: "早良区", en: "Sawara-ku", lon: 130.345, lat: 33.540, zoom: 12.2 },
];

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "hakata-st", wiki: "博多駅", name: "Hakata Station", ward: "40132", lon: 130.4207, lat: 33.5897, zoom: 16.8, tilt: 58, bearing: 0, note: "Fukuoka's main station, the terminus of the Sanyo Shinkansen and the start of the Kyushu Shinkansen. The JR Hakata City building opened in 2011." },
	{ id: "kushida", wiki: "櫛田神社 (福岡市)", name: "Kushida Shrine", ward: "40132", lon: 130.4106, lat: 33.5929, zoom: 17.4, tilt: 58, bearing: 0, note: "Guardian shrine of Hakata and home of the Hakata Gion Yamakasa festival held every July." },
	{ id: "canal-city", wiki: "キャナルシティ博多", name: "Canal City Hakata", ward: "40132", lon: 130.4108, lat: 33.5898, zoom: 17.2, tilt: 58, bearing: 90, note: "Shopping and entertainment complex opened in 1996, built around a canal that runs through its center." },
	{ id: "shofukuji", wiki: "聖福寺 (福岡市)", name: "Shofuku-ji Temple", ward: "40132", lon: 130.4128, lat: 33.5965, zoom: 17.2, tilt: 58, bearing: 0, note: "Founded in 1195 by the monk Eisai as the first Zen temple in Japan." },
	{ id: "nakasu", wiki: "中洲 (福岡市)", name: "Nakasu", ward: "40132", lon: 130.4055, lat: 33.5925, zoom: 17.0, tilt: 60, bearing: 0, note: "Island between the Naka and Hakata rivers, Kyushu's largest nightlife district, known for its riverside food stalls (yatai)." },
	{ id: "city-hall", wiki: "福岡市役所", name: "Fukuoka City Hall", ward: "40133", lon: 130.4017, lat: 33.5902, zoom: 17.4, tilt: 58, bearing: 0, note: "City hall in Tenjin, facing the Tenjin Central Park. The present building was completed in 1988." },
	{ id: "acros", wiki: "アクロス福岡", name: "ACROS Fukuoka", ward: "40133", lon: 130.4019, lat: 33.5913, zoom: 17.4, tilt: 58, bearing: 180, note: "Cultural center opened in 1995, known for its stepped garden terraces that rise from Tenjin Central Park." },
	{ id: "fukuoka-castle", wiki: "福岡城", name: "Fukuoka Castle ruins", ward: "40133", lon: 130.3833, lat: 33.5847, zoom: 16.6, tilt: 58, bearing: 0, note: "Castle of the Kuroda lords, built from 1601. The stone walls and turrets stand in Maizuru Park." },
	{ id: "ohori", wiki: "大濠公園", name: "Ohori Park", ward: "40133", lon: 130.3765, lat: 33.5860, zoom: 16.0, tilt: 55, bearing: 0, note: "Park around a large pond that was once part of the castle's outer moat, opened in 1929." },
	{ id: "dome", wiki: "福岡ドーム", name: "Fukuoka Dome", ward: "40133", lon: 130.3622, lat: 33.5953, zoom: 16.4, tilt: 58, bearing: 0, note: "Japan's first stadium with a retractable roof, opened in 1993. Home of the Fukuoka SoftBank Hawks." },
	{ id: "fukuoka-tower", wiki: "福岡タワー", name: "Fukuoka Tower", ward: "40137", lon: 130.3515, lat: 33.5933, zoom: 16.8, tilt: 58, bearing: 0, note: "Seaside tower 234 m tall, built in 1989 for the Asia-Pacific Expo, with an observation deck at 123 m." },
	{ id: "museum", wiki: "福岡市博物館", name: "Fukuoka City Museum", ward: "40137", lon: 130.3530, lat: 33.5885, zoom: 17.0, tilt: 58, bearing: 0, note: "Museum of the city's history, holding the Gold Seal of the King of Na, a national treasure." },
	{ id: "momochi", wiki: "シーサイドももち海浜公園", name: "Seaside Momochi Beach Park", ward: "40137", lon: 130.3530, lat: 33.5965, zoom: 16.4, tilt: 60, bearing: 180, note: "Man-made beach on reclaimed land at Momochi, facing Hakata Bay." },
	{ id: "hakozaki", wiki: "筥崎宮", name: "Hakozaki Shrine", ward: "40131", lon: 130.4232, lat: 33.6147, zoom: 17.0, tilt: 58, bearing: 0, note: "One of the three great Hachiman shrines, whose gate bears the words 'Surrender of the enemy' from the Mongol invasions." },
	{ id: "port-tower", wiki: "博多ポートタワー", name: "Hakata Port Tower", ward: "40132", lon: 130.4031, lat: 33.6040, zoom: 16.8, tilt: 60, bearing: 180, note: "Lattice tower 100 m tall built in 1964 beside the Bayside Place ferry terminal." },
	{ id: "airport", wiki: "福岡空港", name: "Fukuoka Airport", ward: "40132", lon: 130.4510, lat: 33.5859, zoom: 15.0, tilt: 55, bearing: 0, note: "Airport only two subway stops from Hakata Station, one of the busiest in Japan." },
	{ id: "shikanoshima", wiki: "金印公園", name: "Kin-in Park, Shikanoshima", ward: "40131", lon: 130.3045, lat: 33.6600, zoom: 16.0, tilt: 60, bearing: 0, note: "Park on Shikanoshima island near the spot where the Gold Seal was found by a farmer in 1784." },
];

/** 福岡市地下鉄の路線と駅番号（駅ナンバリング）。地図の駅は N02 の駅名で引き当てて記号を付ける。乗換駅＝中洲川端（K09・H01）・博多（K11・N18）・天神（K08）と天神南（N16）は別の駅 */
export const SUBWAY: SubwayLine[] = [
	{ id: "K", name: "Kuko Line", color: "#f37021", stations: ["姪浜", "室見", "藤崎", "西新", "唐人町", "大濠公園", "赤坂", "天神", "中洲川端", "祇園", "博多", "東比恵", "福岡空港"],
		romaji: ["Meinohama", "Muromi", "Fujisaki", "Nishijin", "Tojinmachi", "Ohorikoen", "Akasaka", "Tenjin", "Nakasu-Kawabata", "Gion", "Hakata", "Higashi-Hie", "Fukuokakuko (Airport)"] },
	{ id: "H", name: "Hakozaki Line", color: "#1e7bc4", stations: ["中洲川端", "呉服町", "千代県庁口", "馬出九大病院前", "箱崎宮前", "箱崎九大前", "貝塚"],
		romaji: ["Nakasu-Kawabata", "Gofukumachi", "Chiyo-Kenchoguchi", "Maidashi-Kyudaibyoinmae", "Hakozakimiyamae", "Hakozaki-Kyudaimae", "Kaizuka"] },
	{ id: "N", name: "Nanakuma Line", color: "#26a69a", stations: ["橋本", "次郎丸", "賀茂", "野芥", "梅林", "福大前", "七隈", "金山", "茶山", "別府", "六本松", "桜坂", "薬院大通", "薬院", "渡辺通", "天神南", "櫛田神社前", "博多"],
		romaji: ["Hashimoto", "Jiromaru", "Kamo", "Noke", "Umebayashi", "Fukudaimae", "Nanakuma", "Kanayama", "Chayama", "Befu", "Ropponmatsu", "Sakurazaka", "Yakuin-odori", "Yakuin", "Watanabe-dori", "Tenjin-minami", "Kushidajinja-mae", "Hakata"] },
];
/** 駅名 → 駅番号の並び（"K11"・"N18"…）。乗換駅（中洲川端・博多）は 2 つ */
export const subwayCodes = (name: string) => codesOf(SUBWAY, name);
/** 交通の層（最初は全部 OFF） */
export const TRANSIT: TransitLayer[] = [
	{ id: "subway", name: "Fukuoka City Subway (Kuko, Hakozaki and Nanakuma lines)" },
	RAIL_LAYER,
	{ id: "bus", name: "Nishitetsu bus stops" },
];
export const TRANSIT_DEFAULT: string[] = [];   // 横浜・京都と同じ＝最初は何も出さない

/** 市の大きな病院（救命救急センター・大学病院・地域医療支援病院）。key＝台帳（KSJ P04）の名に含まれる語、name＝カードに出す短い名。
 *  横浜・京都と同じく病院の「管轄区域」は無い＝わが家のまわりでは近い順で出す */
export const MAJOR_HOSPITALS: { key: string; name: string }[] = [
	{ key: "九州大学病院", name: "九州大学病院" },
	{ key: "福岡大学病院", name: "福岡大学病院" },
	{ key: "九州医療センター", name: "国立病院機構九州医療センター" },
	{ key: "済生会福岡総合病院", name: "済生会福岡総合病院" },
	{ key: "福岡赤十字病院", name: "福岡赤十字病院" },
	{ key: "福岡市民病院", name: "福岡市民病院" },
	{ key: "浜の町病院", name: "浜の町病院" },
	{ key: "九州がんセンター", name: "国立病院機構九州がんセンター" },
];
/** 急病の診療所（夜間・休日）＝福岡市急患診療センター（早良区百道浜・福岡市医師会館の中・内科と小児科ほか）。
 *  時間は市の掲載（2026-11 確認）＝変わることがあるので「電話で確かめて」を添える */
export const NIGHT_CENTERS: Clinic[] = [
	{ name: "福岡市急患診療センター", addr: "早良区百道浜1丁目6-9", tel: "092-847-1099", lon: 130.3555, lat: 33.5862, enName: "Fukuoka City Emergency Medical Center", en: "1-6-9 Momochihama, Sawara-ku" },
];
/** 台帳の名 → 大きな病院の短い名（でなければ null） */
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
/** 施設の検索の行（区で絞る） */
export const facilityIndex = (rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>) => facIndex(CITY, rows, ward, subs);

/** 福岡の歴史の物語＝金印（57）から今までの章。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake が両方焼く） */
export const FUKUOKA_STORY: Chapter[] = [
	{ id: "fk-57", year: "57", photo: "museum", wiki: "漢委奴国王印", name: "The Gold Seal of the King of Na", ward: "40137", lon: 130.3530, lat: 33.5885, zoom: 16.8, tilt: 58, bearing: 0, note: "In 57 AD the Han emperor of China gave a gold seal to the king of Na, a land around Hakata Bay. Found on Shikanoshima in 1784, it is kept at the Fukuoka City Museum." },
	{ id: "fk-688", year: "688", wiki: "鴻臚館", name: "A guesthouse for envoys", ward: "40133", lon: 130.3818, lat: 33.5868, zoom: 17.0, tilt: 60, bearing: 0, note: "From the 7th century the Korokan received envoys and traders from China and Korea. Its remains lie inside the Fukuoka Castle grounds." },
	{ id: "fk-1195", year: "1195", photo: "shofukuji", wiki: "聖福寺 (福岡市)", name: "The first Zen temple", ward: "40132", lon: 130.4128, lat: 33.5965, zoom: 17.2, tilt: 58, bearing: 0, note: "Returning from China, the monk Eisai founded Shofuku-ji in Hakata in 1195, the first Zen temple in Japan." },
	{ id: "fk-1274", year: "1274", photo: "hakozaki", wiki: "元寇防塁", name: "The Mongol invasions", ward: "40131", lon: 130.4232, lat: 33.6147, zoom: 16.8, tilt: 60, bearing: 0, note: "Mongol fleets attacked Hakata Bay in 1274 and 1281. A stone wall was built along the shore in between, and parts of it survive today." },
	{ id: "fk-1601", year: "1601", photo: "fukuoka-castle", wiki: "福岡城", name: "A castle town named Fukuoka", ward: "40133", lon: 130.3833, lat: 33.5847, zoom: 16.6, tilt: 58, bearing: 0, note: "Kuroda Nagamasa began Fukuoka Castle in 1601. The samurai town of Fukuoka grew west of the Naka River, facing the merchant town of Hakata." },
	{ id: "fk-1889", year: "1889", photo: "nakasu", wiki: "福岡市", name: "Fukuoka and Hakata become one city", ward: "40132", lon: 130.4055, lat: 33.5925, zoom: 16.4, tilt: 60, bearing: 0, note: "Fukuoka City was founded in 1889, joining the two towns. The city took the name Fukuoka, while the station that opened that year was named Hakata." },
	{ id: "fk-1975", year: "1975", photo: "hakata-st", wiki: "博多駅", name: "The Shinkansen arrives", ward: "40132", lon: 130.4207, lat: 33.5897, zoom: 16.6, tilt: 58, bearing: 0, note: "The Sanyo Shinkansen reached Hakata in 1975, linking Fukuoka directly with Osaka and Tokyo." },
	{ id: "fk-1989", year: "1989", photo: "fukuoka-tower", wiki: "福岡タワー", name: "A new waterfront", ward: "40137", lon: 130.3515, lat: 33.5933, zoom: 16.4, tilt: 58, bearing: 0, note: "The Asia-Pacific Expo of 1989 was held on reclaimed land at Momochi, and Fukuoka Tower was built for it." },
	{ id: "fk-2023", year: "2023", wiki: "福岡市地下鉄七隈線", name: "The subway reaches Hakata", ward: "40132", lon: 130.4106, lat: 33.5915, zoom: 16.8, tilt: 58, bearing: 0, note: "In 2023 the Nanakuma Line was extended from Tenjin-minami to Hakata, linking all three subway lines at Hakata." },
];
/** 博多湾からの眺め＝湾の上に立ったつもりで、海辺の街並みを順に見渡す（中心＝見る先・bearing＝向き＝カメラは中心の反対側に立つ） */
export const BAY_VIEWS: View[] = [
	{ lon: 130.3540, lat: 33.5900, zoom: 15.4, tilt: 75, bearing: 170 },    // 百道浜の沖から＝福岡タワーと百道の高い建物（tilt はエンジンの上限 75）
	{ lon: 130.3990, lat: 33.5930, zoom: 15.2, tilt: 75, bearing: 185 },    // 博多港から天神・中洲の街並みへ
	{ lon: 130.4150, lat: 33.5950, zoom: 15.2, tilt: 75, bearing: 200 },    // 須崎の埠頭の沖から博多駅のあたりへ
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["hakata-st", "kushida", "canal-city", "nakasu", "acros", "fukuoka-castle", "ohori", "dome", "fukuoka-tower", "port-tower", "hakozaki", "airport"];

/** 災害の想定＝海に面した福岡は 4 つとも（洪水・高潮・津波・土砂災害） */
export const HAZARDS: Hazard[] = HAZARD_DEFS;

/** PLATEAU の建物が LOD2（屋根の形まで）で配信される区。南区・西区・城南区・早良区は LOD1（箱）だけ（エンジンの登録簿 plateau-sets.json）。描くのはエンジン */
export const LOD2_WARDS = ["40131", "40132", "40133"];
/** 先読みする PLATEAU（エンジンの登録簿の名前）＝観光の主役（博多・天神のあたり）から */
export const LOD2_PREFETCH = ["福岡博多区", "福岡中央区"];
export const LOD1_WARDS = WARDS.filter(w => !LOD2_WARDS.includes(w.code));
/** 通信なしの保存で端末に詰める建物＝7 区（エンジンの登録簿の名前・福岡に橋梁の登録は無い） */
export const BLD_SETS = WARDS.map(w => "福岡" + w.name);
/** 市の外の覆い（穴＝市の外周）の外枠 [w,s,e,n]。枠の縁が画面に入ったら覆いごと消す */
export const MASK_BOX: [number, number, number, number] = [129.4, 32.9, 131.1, 34.4];

/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語（日本語以外で出す）。地下鉄の N02 の路線名は bake の後に確かめて足す */
export const RAIL_LINES_EN: Record<string, string> = {
	"福岡市 1号線(空港線)": "Kuko Line", "福岡市 2号線(箱崎線)": "Hakozaki Line", "福岡市 3号線(七隈線)": "Nanakuma Line",
	"福岡市 1号線": "Kuko Line", "福岡市 2号線": "Hakozaki Line", "福岡市 3号線": "Nanakuma Line",
	"福岡市 空港線": "Kuko Line", "福岡市 箱崎線": "Hakozaki Line", "福岡市 七隈線": "Nanakuma Line",
	"西日本旅客鉄道 山陽新幹線": "Sanyo Shinkansen", "九州旅客鉄道 九州新幹線": "Kyushu Shinkansen", "西日本旅客鉄道 博多南線": "Hakata-Minami Line",
	"九州旅客鉄道 鹿児島線": "JR Kagoshima Main Line", "九州旅客鉄道 香椎線": "JR Kashii Line", "九州旅客鉄道 篠栗線": "JR Sasaguri Line (Fukuhoku Yutaka Line)", "九州旅客鉄道 筑肥線": "JR Chikuhi Line",
	"西日本鉄道 天神大牟田線": "Nishitetsu Tenjin Omuta Line", "西日本鉄道 貝塚線": "Nishitetsu Kaizuka Line",
};
export const railLinesEn = (s: string) => linesEn(RAIL_LINES_EN, s);
/** 福岡県の指定緊急避難場所（census2020 と同じ焼き・gzip の JSON・[経度, 緯度, 名称, 住所, 対応災害ビット]） */
export const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/40.json";
export const fukuokaShelters = (rows: HinanRow[]): HinanRow[] => sheltersIn(rows, "福岡市");
/** 住所の「福岡市◯◯区」から区を引く */
export const wardOfAddress = (addr: string): Ward | null => wardOf(CITY, addr);
/** URL の状態（?tab=risk&hz=tsunami&ward=40132&spot=kushida&tr=subway,bus） */
export const parseState = (search: string): TwinState => parse(CITY, search);
export const writeState = (search: string, st: TwinState): string => write(CITY, search, st);
/** 保存した地点（市の外接矩形の外は捨てる） */
export const parsePlaces = (raw: string | null) => places(raw, CITY_BBOX);

/** 端末に詰める物のおおよその大きさ（MB）。保存ボタンの説明に出す（Mac の実測で直す） */
export const OFFLINE_MB = 450;

/** 市の設定（共有モジュールの mountTwin が読む） */
export const CITY: CityConfig = {
	id: "fukuoka", key: "fk",
	title: "Fukuoka Digital Twin", cityName: "Fukuoka City", allWards: "Fukuoka City (7 wards)", outside: "Outside Fukuoka City.",
	wholeCityTitle: "Show all of Fukuoka City", flatNote: "Shown on the flat district map (choose a district or all of Fukuoka City).", zonesTitle: "Zones and districts of Fukuoka",
	addrPrefix: "福岡市", bbox: CITY_BBOX, view: CITY_VIEW, maskBox: MASK_BOX,
	wards: WARDS, spots: SPOTS, tour: TOUR,
	tourIntro: "7 wards, about 343 km². From the merchant town of Hakata to the castle town and the bay, a tour through the city in 3D.",
	story: { button: "🏯 Fukuoka through the ages (57 AD to today)", chapters: FUKUOKA_STORY, views: BAY_VIEWS, viewsButton: "View the city from Hakata Bay", viewsCaption: ["View the city from Hakata Bay", "The waterfront as seen from a ship on Hakata Bay."] },
	subway: SUBWAY, subwayName: "Fukuoka City Subway",
	subwayColor: name => /箱崎|2号/.test(name) ? SUBWAY[1].color : /七隈|3号/.test(name) ? SUBWAY[2].color : SUBWAY[0].color,   // N02 の路線名＝1号線（空港線）・2号線（箱崎線）・3号線（七隈線）
	subwayRail: /^福岡市 /,
	subwayNote: "Subway stations carry their station numbers (K = Kuko Line, H = Hakozaki Line, N = Nanakuma Line). Tap a station or stop to see its lines or routes.",
	busName: "Nishitetsu Bus",
	transit: TRANSIT, transitDefault: TRANSIT_DEFAULT, railLinesEn: RAIL_LINES_EN,
	hazards: HAZARDS,
	riskNote: "Tilt the map to compare flood depths with building heights. Scenarios are official estimates by the national government, Fukuoka Prefecture and others; real disasters can exceed them.",
	inland: { text: "Inland flooding (rain the sewers cannot drain) is shown on the city's own hazard maps.", link: "Fukuoka City hazard maps", url: "https://www.city.fukuoka.lg.jp/shisei/bousai/" },
	hinanUrl: HINAN_URL,
	lod2Prefetch: LOD2_PREFETCH, bldSets: BLD_SETS,
	bldNames: code => { const w = WARDS.find(x => x.code === code); return w ? ["福岡" + w.name] : []; },
	emergency: {
		night: { centers: NIGHT_CENTERS, label: "Emergency medical center (nights and holidays)", hours: "Internal medicine and pediatrics · weekday nights 19:30 to the next morning, Saturdays from 17:00 (pediatrics) or 19:00 (internal medicine), Sundays and holidays from 9:00. Call ahead to check." },
		advice: { text: "Unsure whether to call an ambulance? Fukuoka emergency advice line, 24 hours:", tel: "#7119" },
	},
	majorHospitals: MAJOR_HOSPITALS,
	homeJuris: true,   // 福岡は博多臨港署など警察署の管轄が区と一致しない所がある＝カードに出す
	offlineMB: OFFLINE_MB,
};
