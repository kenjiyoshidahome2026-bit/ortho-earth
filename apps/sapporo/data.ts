// 札幌市デジタルツインの市の設定（区・名所・ツアー・地下鉄の駅番号・救急・札幌の歴史の物語）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 案内板と機能は共有モジュール @ortho-earth/citytwin（packages/citytwin・共有エンジンの入口）＝横浜市・京都市デジタルツインと同じ芯（2026-11-14）。ここは札幌の物だけ。
// 座標は区の中ほど／名所の建物の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 区の境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-sapporo.mjs（中身は共通の packages/citytwin/scripts/bake-city.mjs）が組んで ortho-data/japan/sapporo/ に置く（GitHub Pages・DATA.md）。
import { HAZARDS as HAZARD_DEFS, RAIL_LAYER, subwayCodes as codesOf, railLinesEn as linesEn, sheltersIn, wardOfAddress as wardOf, facilityIndex as facIndex, parseState as parse, writeState as write, parsePlaces as places } from "@ortho-earth/citytwin/core";
import type { Ward, Spot, Hazard, SubwayLine, TransitLayer, Chapter, View, FacilityRow, HinanRow, TwinState, CityConfig, Clinic } from "@ortho-earth/citytwin/core";
export * from "@ortho-earth/citytwin/core";   // 検定（tests/t-sapporo.mjs）と頁がここから引く共通の物

/** 札幌市の外接矩形（10 区を包む・西と南は南区の山＝定山渓の奥まで）と全景の視点（市街地を中心に） */
export const CITY_BBOX: [number, number, number, number] = [140.98, 42.77, 141.52, 43.20];
export const CITY_VIEW = { lon: 141.36, lat: 43.06, zoom: 11.4, tilt: 35, bearing: 0 };

/** 10 区（市区町村コード順）。座標は区の中ほど（南区は北の市街地寄り）・zoom は区がほぼ画面に収まる値 */
export const WARDS: Ward[] = [
	{ code: "01101", name: "中央区", en: "Chuo-ku", lon: 141.335, lat: 43.050, zoom: 13.2 },
	{ code: "01102", name: "北区", en: "Kita-ku", lon: 141.335, lat: 43.115, zoom: 12.6 },
	{ code: "01103", name: "東区", en: "Higashi-ku", lon: 141.395, lat: 43.105, zoom: 12.8 },
	{ code: "01104", name: "白石区", en: "Shiroishi-ku", lon: 141.420, lat: 43.055, zoom: 13.2 },
	{ code: "01105", name: "豊平区", en: "Toyohira-ku", lon: 141.385, lat: 43.020, zoom: 13.0 },
	{ code: "01106", name: "南区", en: "Minami-ku", lon: 141.250, lat: 42.940, zoom: 11.0 },
	{ code: "01107", name: "西区", en: "Nishi-ku", lon: 141.270, lat: 43.075, zoom: 12.8 },
	{ code: "01108", name: "厚別区", en: "Atsubetsu-ku", lon: 141.475, lat: 43.045, zoom: 13.2 },
	{ code: "01109", name: "手稲区", en: "Teine-ku", lon: 141.225, lat: 43.115, zoom: 12.8 },
	{ code: "01110", name: "清田区", en: "Kiyota-ku", lon: 141.440, lat: 42.975, zoom: 12.8 },
];

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "sapporo-st", wiki: "札幌駅", name: "Sapporo Station", ward: "01102", lon: 141.3508, lat: 43.0686, zoom: 16.8, tilt: 58, bearing: 180, note: "Hokkaido's main rail hub, where JR lines meet the Namboku and Toho subway lines. JR Tower, 173 m, rises above it." },
	{ id: "hokudai", wiki: "北海道大学", name: "Hokkaido University", ward: "01102", lon: 141.3437, lat: 43.0743, zoom: 16.6, tilt: 58, bearing: 0, note: "University founded in 1876 as Sapporo Agricultural College. Its campus just north of the station is lined with elms and ginkgo trees." },
	{ id: "akarenga", wiki: "北海道庁旧本庁舎", name: "Former Hokkaido Government Office (Red Brick)", ward: "01101", lon: 141.3483, lat: 43.0638, zoom: 17.4, tilt: 58, bearing: 270, note: "Red-brick government office completed in 1888 in neo-Baroque style, used until 1968." },
	{ id: "clock-tower", wiki: "札幌市時計台", name: "Sapporo Clock Tower", ward: "01101", lon: 141.3536, lat: 43.0626, zoom: 17.8, tilt: 58, bearing: 0, note: "Built in 1878 as the drill hall of Sapporo Agricultural College. Its clock has struck the hours since 1881." },
	{ id: "odori", wiki: "大通公園", name: "Odori Park", ward: "01101", lon: 141.3480, lat: 43.0597, zoom: 16.2, tilt: 60, bearing: 90, note: "Park about 1.5 km long through the city centre, first laid out in 1871 as a firebreak. Main venue of the Sapporo Snow Festival." },
	{ id: "tv-tower", wiki: "さっぽろテレビ塔", name: "Sapporo TV Tower", ward: "01101", lon: 141.3563, lat: 43.0611, zoom: 17.0, tilt: 55, bearing: 270, note: "Tower at the east end of Odori Park, opened in 1957, 147.2 m tall." },
	{ id: "susukino", wiki: "すすきの", name: "Susukino", ward: "01101", lon: 141.3531, lat: 43.0554, zoom: 17.0, tilt: 58, bearing: 0, note: "Hokkaido's largest entertainment district, around the crossing south of Odori." },
	{ id: "nakajima", wiki: "中島公園", name: "Nakajima Park", ward: "01101", lon: 141.3543, lat: 43.0450, zoom: 16.6, tilt: 58, bearing: 0, note: "Park with a pond and a concert hall, home to Hoheikan, a Western-style guest house built in 1880." },
	{ id: "jingu", wiki: "北海道神宮", name: "Hokkaido Shrine", ward: "01101", lon: 141.3075, lat: 43.0544, zoom: 16.8, tilt: 58, bearing: 270, note: "Shrine to the deities of the settlement of Hokkaido, enshrined in 1869, in the forest beside Maruyama Park." },
	{ id: "maruyama-zoo", wiki: "札幌市円山動物園", name: "Maruyama Zoo", ward: "01101", lon: 141.3035, lat: 43.0515, zoom: 16.8, tilt: 58, bearing: 270, note: "Zoo opened in 1951 at the foot of Mount Maruyama." },
	{ id: "okurayama", wiki: "大倉山ジャンプ競技場", name: "Okurayama Ski Jump Stadium", ward: "01101", lon: 141.2955, lat: 43.0455, zoom: 16.4, tilt: 62, bearing: 240, note: "Ski jump that hosted the large-hill event of the 1972 Winter Olympics. A lift climbs to a view over the city." },
	{ id: "moiwa", wiki: "藻岩山", name: "Mount Moiwa", ward: "01106", lon: 141.3222, lat: 43.0222, zoom: 15.2, tilt: 62, bearing: 30, note: "531 m mountain at the edge of the city. A ropeway and a small cable car climb to a famous night view." },
	{ id: "beer-museum", wiki: "サッポロビール博物館", name: "Sapporo Beer Museum", ward: "01103", lon: 141.3690, lat: 43.0712, zoom: 17.0, tilt: 58, bearing: 0, note: "Red-brick building of 1890, first a sugar factory and later a malt house, now a museum of beer." },
	{ id: "moerenuma", wiki: "モエレ沼公園", name: "Moerenuma Park", ward: "01103", lon: 141.4250, lat: 43.1220, zoom: 15.2, tilt: 60, bearing: 0, note: "Park designed by sculptor Isamu Noguchi on a former landfill, completed in 2005, with a glass pyramid and an artificial hill." },
	{ id: "dome", wiki: "札幌ドーム", name: "Sapporo Dome", ward: "01105", lon: 141.4097, lat: 43.0151, zoom: 16.0, tilt: 58, bearing: 0, note: "Domed stadium opened in 2001, a venue of the 2002 FIFA World Cup." },
	{ id: "hitsujigaoka", wiki: "さっぽろ羊ヶ丘展望台", name: "Hitsujigaoka Observation Hill", ward: "01105", lon: 141.3966, lat: 43.0060, zoom: 16.2, tilt: 60, bearing: 330, note: "Hill of sheep pastures with a statue of William S. Clark, looking over the city." },
	{ id: "kaitaku-mura", wiki: "北海道開拓の村", name: "Historical Village of Hokkaido", ward: "01108", lon: 141.4990, lat: 43.0480, zoom: 16.4, tilt: 58, bearing: 0, note: "Open-air museum of about 50 buildings from the settlement era, moved here from across Hokkaido." },
	{ id: "jozankei", wiki: "定山渓温泉", name: "Jozankei Onsen", ward: "01106", lon: 141.1640, lat: 42.9680, zoom: 15.6, tilt: 62, bearing: 0, note: "Hot-spring town in the mountain valley of the upper Toyohira River." },
	{ id: "teine", wiki: "手稲山", name: "Mount Teine", ward: "01109", lon: 141.1960, lat: 43.0790, zoom: 14.0, tilt: 62, bearing: 0, note: "1,023 m mountain whose slopes held alpine skiing and bobsleigh at the 1972 Winter Olympics." },
];

/** 札幌市営地下鉄の路線と駅番号（駅ナンバリング）。地図の駅は N02 の駅名で引き当てて記号を付ける。乗換駅＝さっぽろ（N06・H07）・大通（N07・T09・H08） */
export const SUBWAY: SubwayLine[] = [
	{ id: "N", name: "Namboku Line", color: "#2e9e48", stations: ["麻生", "北34条", "北24条", "北18条", "北12条", "さっぽろ", "大通", "すすきの", "中島公園", "幌平橋", "中の島", "平岸", "南平岸", "澄川", "自衛隊前", "真駒内"],
		romaji: ["Asabu", "Kita-34-jo", "Kita-24-jo", "Kita-18-jo", "Kita-12-jo", "Sapporo", "Odori", "Susukino", "Nakajima-koen", "Horohira-bashi", "Nakanoshima", "Hiragishi", "Minami-Hiragishi", "Sumikawa", "Jieitai-mae", "Makomanai"] },
	{ id: "T", name: "Tozai Line", color: "#f08300", stations: ["宮の沢", "発寒南", "琴似", "二十四軒", "西28丁目", "円山公園", "西18丁目", "西11丁目", "大通", "バスセンター前", "菊水", "東札幌", "白石", "南郷7丁目", "南郷13丁目", "南郷18丁目", "大谷地", "ひばりが丘", "新さっぽろ"],
		romaji: ["Miyanosawa", "Hassamu-minami", "Kotoni", "Nijuyonken", "Nishi-28-chome", "Maruyama-koen", "Nishi-18-chome", "Nishi-11-chome", "Odori", "Bus Center-mae", "Kikusui", "Higashi-Sapporo", "Shiroishi", "Nango-7-chome", "Nango-13-chome", "Nango-18-chome", "Oyachi", "Hibarigaoka", "Shin-Sapporo"] },
	{ id: "H", name: "Toho Line", color: "#1e88c8", stations: ["栄町", "新道東", "元町", "環状通東", "東区役所前", "北13条東", "さっぽろ", "大通", "豊水すすきの", "学園前", "豊平公園", "美園", "月寒中央", "福住"],
		romaji: ["Sakaemachi", "Shindo-higashi", "Motomachi", "Kanjo-dori-higashi", "Higashi-kuyakusho-mae", "Kita-13-jo-higashi", "Sapporo", "Odori", "Hosui-susukino", "Gakuen-mae", "Toyohira-koen", "Misono", "Tsukisamu-chuo", "Fukuzumi"] },
];
/** 駅名 → 駅番号の並び（"N07"・"H08"…）。乗換駅（さっぽろ・大通）は 2〜3 つ */
export const subwayCodes = (name: string) => codesOf(SUBWAY, name);
/** 交通の層（最初は全部 OFF）。札幌に市営バスは無い（2004 年に民営へ移管）＝路線バスの主な 3 社の停留所（P11：中央バス 1365・JR 北海道バス 605・じょうてつ 189） */
export const TRANSIT: TransitLayer[] = [
	{ id: "subway", name: "Sapporo Municipal Subway (Namboku, Tozai, Toho lines)" },
	RAIL_LAYER,
	{ id: "bus", name: "Bus stops (Chuo Bus, JR Hokkaido Bus, Jotetsu Bus)" },
];
export const TRANSIT_DEFAULT: string[] = [];   // 横浜・京都と同じ＝最初は何も出さない

/** 市の大きな病院（救命救急センター・大学病院・地域医療支援病院）。key＝台帳（KSJ P04）の名に含まれる語、name＝カードに出す短い名。
 *  横浜・京都と同じく病院の「管轄区域」は無い＝わが家のまわりでは近い順で出す */
export const MAJOR_HOSPITALS: { key: string; name: string }[] = [
	{ key: "市立札幌病院", name: "市立札幌病院" },
	{ key: "北海道大学病院", name: "北海道大学病院" },
	{ key: "札幌医科大学附属病院", name: "札幌医科大学附属病院" },
	{ key: "手稲渓仁会病院", name: "手稲渓仁会病院" },
	{ key: "北海道医療センター", name: "国立病院機構北海道医療センター" },
	{ key: "札幌東徳洲会病院", name: "札幌東徳洲会病院" },
	{ key: "ＫＫＲ札幌医療センター", name: "KKR札幌医療センター" },   // 台帳（P04）は全角の ＫＫＲ
	{ key: "札幌徳洲会病院", name: "札幌徳洲会病院" },
];
/** 急病の診療所（夜間・休日）＝札幌市夜間休日急病センター（市内 1 か所・2026-04 に「夜間急病センター」から改称）。区ごとの休日急患診療所は無い
 *  （休日の当番の病院は札幌市医師会の案内）＝holiday は持たない。時間は市の掲載（2026-11-14 Mac で確認）＝変わることがあるので「電話で確かめて」を添える。
 *  位置＝地理院の住所検索「札幌市中央区大通西19丁目1-1」 */
export const NIGHT_CENTERS: Clinic[] = [
	{ name: "札幌市夜間休日急病センター", addr: "中央区大通西19丁目1-1", tel: "011-641-4316", lon: 141.32785, lat: 43.05754, enName: "Sapporo City Night and Holiday Emergency Center", en: "1-1 Odori-nishi 19-chome, Chuo-ku" },
];
/** 台帳の名 → 大きな病院の短い名（でなければ null） */
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
/** 施設の検索の行（区で絞る） */
export const facilityIndex = (rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>) => facIndex(CITY, rows, ward, subs);

/** 札幌の歴史の物語＝開拓使（1869）から今までの章。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake が両方焼く） */
export const SAPPORO_STORY: Chapter[] = [
	{ id: "spr-1869", year: "1869", photo: "jingu", wiki: "北海道神宮", name: "A base for the settlement of Hokkaido", ward: "01101", lon: 141.3075, lat: 43.0544, zoom: 16.6, tilt: 60, bearing: 270, note: "In 1869 the government set up the Hokkaido Development Commission and chose Sapporo as its base. The deities of the settlement, enshrined that year, are worshipped at Hokkaido Shrine." },
	{ id: "spr-1871", year: "1871", wiki: "創成川", name: "A city on a grid", ward: "01101", lon: 141.3575, lat: 43.0600, zoom: 16.2, tilt: 60, bearing: 0, note: "From 1871 the city was laid out on a grid. The Sosei River canal divides east from west, and a wide firebreak, now Odori Park, divides north from south." },
	{ id: "spr-1876", year: "1876", photo: "hokudai", wiki: "北海道大学", name: "Boys, be ambitious", ward: "01102", lon: 141.3437, lat: 43.0743, zoom: 16.6, tilt: 58, bearing: 0, note: "Sapporo Agricultural College opened in 1876 with William S. Clark of Massachusetts as its head. Leaving in 1877, he told his students: 'Boys, be ambitious.'" },
	{ id: "spr-1878", year: "1878", photo: "clock-tower", wiki: "札幌市時計台", name: "The drill hall and its clock", ward: "01101", lon: 141.3536, lat: 43.0626, zoom: 17.6, tilt: 58, bearing: 0, note: "The college's drill hall was built in 1878, and a clock from Boston was added in 1881. Known as the Clock Tower, it became a symbol of the city." },
	{ id: "spr-1888", year: "1888", photo: "akarenga", wiki: "北海道庁旧本庁舎", name: "Red brick for the government", ward: "01101", lon: 141.3483, lat: 43.0638, zoom: 17.2, tilt: 58, bearing: 270, note: "The Hokkaido Government Office, built of bricks made in Hokkaido, was completed in 1888 and served until 1968." },
	{ id: "spr-1950", year: "1950", photo: "odori", wiki: "大通公園", name: "Snow statues in the park", ward: "01101", lon: 141.3480, lat: 43.0597, zoom: 16.4, tilt: 60, bearing: 90, note: "In 1950 local high school students built six snow statues in Odori Park. The Sapporo Snow Festival has grown into a winter event with about two million visitors." },
	{ id: "spr-1971", year: "1971", wiki: "札幌市営地下鉄", name: "A subway on rubber tyres", ward: "01101", lon: 141.3545, lat: 43.0605, zoom: 16.8, tilt: 58, bearing: 0, note: "The Namboku Line opened in December 1971, ahead of the Winter Olympics. Sapporo's subway runs on rubber tyres, quieter than steel wheels." },
	{ id: "spr-1972", year: "1972", photo: "okurayama", wiki: "大倉山ジャンプ競技場", name: "The Winter Olympics", ward: "01101", lon: 141.2955, lat: 43.0455, zoom: 16.4, tilt: 62, bearing: 240, note: "In February 1972 Sapporo held the first Winter Olympics in Asia; the large-hill jump was held here at Okurayama. That April Sapporo became a designated city with seven wards." },
	{ id: "spr-2003", year: "2003", photo: "sapporo-st", wiki: "JRタワー", name: "A tower above the station", ward: "01102", lon: 141.3508, lat: 43.0686, zoom: 16.6, tilt: 58, bearing: 180, note: "JR Tower opened above Sapporo Station in 2003. At 173 m it was then the tallest building in Hokkaido." },
];
/** 藻岩山からの眺め＝南西の山の中腹に立ったつもりで、碁盤の目の街並みを順に見渡す（中心＝見る先・bearing＝向き＝カメラは中心の反対側に立つ） */
export const HILL_VIEWS: View[] = [
	{ lon: 141.3500, lat: 43.0560, zoom: 15.4, tilt: 75, bearing: 30 },    // すすきの・大通の街並みの奥に石狩平野（tilt はエンジンの上限 75）
	{ lon: 141.3530, lat: 43.0640, zoom: 15.4, tilt: 75, bearing: 20 },    // 大通から札幌駅へ
	{ lon: 141.3560, lat: 43.0470, zoom: 15.6, tilt: 75, bearing: 10 },    // 中島公園から都心へ
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["sapporo-st", "hokudai", "akarenga", "clock-tower", "odori", "tv-tower", "susukino", "nakajima", "moiwa", "okurayama", "jingu", "hitsujigaoka", "dome", "moerenuma"];

/** 災害の想定＝海に面さない札幌は洪水と土砂災害（高潮・津波は持たない） */
export const HAZARDS: Hazard[] = HAZARD_DEFS.filter(h => h.id === "flood" || h.id === "dosha");

/** PLATEAU の建物が LOD2（屋根の形まで）で配信される区。白石・豊平・南・厚別・手稲・清田は LOD1（箱）だけ（エンジンの登録簿 plateau-sets.json）。描くのはエンジン */
export const LOD2_WARDS = ["01101", "01102", "01103", "01107"];
/** 先読みする PLATEAU（エンジンの登録簿の名前）＝観光の主役（駅・大通・すすきののあたり）から */
export const LOD2_PREFETCH = ["札幌中央区", "札幌北区"];
export const LOD1_WARDS = WARDS.filter(w => !LOD2_WARDS.includes(w.code));
/** 通信なしの保存で端末に詰める建物＝10 区（エンジンの登録簿の名前・札幌の橋梁は登録簿に無い） */
export const BLD_SETS = WARDS.map(w => "札幌" + w.name);
/** 市の外の覆い（穴＝市の外周）の外枠 [w,s,e,n]。枠の縁が画面に入ったら覆いごと消す */
export const MASK_BOX: [number, number, number, number] = [140.2, 42.3, 142.3, 43.7];

/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語（日本語以外で出す） */
export const RAIL_LINES_EN: Record<string, string> = {
	"札幌市 南北線": "Namboku Line", "札幌市 東西線": "Tozai Line", "札幌市 東豊線": "Toho Line",
	"北海道旅客鉄道 函館線": "JR Hakodate Line", "北海道旅客鉄道 千歳線": "JR Chitose Line", "北海道旅客鉄道 札沼線": "JR Gakuen Toshi Line",
	// 市電（N02 の事業者＝札幌市交通事業振興公社・停留場 24・ループ運転）
	"一般社団法人札幌市交通事業振興公社 1条線": "Sapporo Streetcar", "一般社団法人札幌市交通事業振興公社 山鼻線": "Sapporo Streetcar",
	"一般社団法人札幌市交通事業振興公社 山鼻西線": "Sapporo Streetcar", "一般社団法人札幌市交通事業振興公社 都心線": "Sapporo Streetcar",
};
export const railLinesEn = (s: string) => linesEn(RAIL_LINES_EN, s);
/** 北海道の指定緊急避難場所（census2020 と同じ焼き・gzip の JSON・[経度, 緯度, 名称, 住所, 対応災害ビット]） */
export const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/01.json";
export const sapporoShelters = (rows: HinanRow[]): HinanRow[] => sheltersIn(rows, "札幌市");
/** 住所の「札幌市◯◯区」から区を引く */
export const wardOfAddress = (addr: string): Ward | null => wardOf(CITY, addr);
/** URL の状態（?tab=risk&hz=flood&ward=01101&spot=odori&tr=subway,bus） */
export const parseState = (search: string): TwinState => parse(CITY, search);
export const writeState = (search: string, st: TwinState): string => write(CITY, search, st);
/** 保存した地点（市の外接矩形の外は捨てる） */
export const parsePlaces = (raw: string | null) => places(raw, CITY_BBOX);

/** 端末に詰める物のおおよその大きさ（MB）。保存ボタンの説明に出す（Mac の実測で直す） */
export const OFFLINE_MB = 550;

/** 市の設定（共有モジュールの mountTwin が読む） */
export const CITY: CityConfig = {
	id: "sapporo", key: "sp",
	title: "Sapporo Digital Twin", cityName: "Sapporo City", allWards: "Sapporo City (10 wards)", outside: "Outside Sapporo City.",
	wholeCityTitle: "Show all of Sapporo City", flatNote: "Shown on the flat district map (choose a district or all of Sapporo City).", zonesTitle: "Zoning and jurisdictions",   // 学区は無い（noAreas）
	addrPrefix: "札幌市", bbox: CITY_BBOX, view: CITY_VIEW, maskBox: MASK_BOX,
	wards: WARDS, spots: SPOTS, tour: TOUR,
	tourIntro: "10 wards, about 1,121 km². From the grid of the settlement-era town to Olympic ski jumps, a tour through the city in 3D.",
	story: { button: "📜 Sapporo through the ages (1869 to today)", chapters: SAPPORO_STORY, views: HILL_VIEWS, viewsButton: "View the city from Mount Moiwa", viewsCaption: ["View the city from Mount Moiwa", "The grid city and the Ishikari Plain as seen from the slopes of Mount Moiwa."] },
	subway: SUBWAY, subwayName: "Sapporo Municipal Subway",
	subwayColor: name => /東西/.test(name) ? SUBWAY[1].color : /東豊/.test(name) ? SUBWAY[2].color : SUBWAY[0].color,   // N02 の路線名＝南北線／東西線／東豊線
	subwayRail: /^札幌市 (南北|東西|東豊)線/,
	subwayNote: "Subway stations carry their station numbers (N = Namboku Line, T = Tozai Line, H = Toho Line). Tap a station or stop to see its lines or routes.",
	busName: "Bus",
	transit: TRANSIT, transitDefault: TRANSIT_DEFAULT, railLinesEn: RAIL_LINES_EN,
	hazards: HAZARDS,
	riskNote: "Tilt the map to compare flood depths with building heights. Scenarios are official estimates by the national government, Hokkaido and others; real disasters can exceed them.",
	inland: { text: "Inland flooding (rain the sewers cannot drain) is shown on the city's own flood hazard map.", link: "Sapporo City flood hazard map", url: "https://www.city.sapporo.jp/kikikanri/higoro/fuusui/ssh_map.html" },   // 内水は地理院のタイルに無い（02_naisui_data は札幌で全部 404・2026-11-14）＝市の浸水ハザードマップ（洪水と内水）
	hinanUrl: HINAN_URL,
	lod2Prefetch: LOD2_PREFETCH, bldSets: BLD_SETS,
	bldNames: code => { const w = WARDS.find(x => x.code === code); return w ? ["札幌" + w.name] : []; },
	emergency: {
		night: { centers: NIGHT_CENTERS, label: "Emergency clinic (nights and holidays)", hours: "Internal medicine and pediatrics every night 19:00–07:00 (reception until 06:30); ENT and eye 19:00–23:00; pediatrics on Sundays and holidays 9:00–17:00 by appointment. Call ahead to check." },
		advice: { text: "Unsure whether to call an ambulance? Sapporo emergency advice line, 24 hours:", tel: "#7119" },
	},
	noAreas: ["school-e", "school-j"],   // 国土数値情報の小・中学校区（A27・A32 の -21・-16）に札幌市の面が無い（Mac で確認 2026-11-14）
	majorHospitals: MAJOR_HOSPITALS,
	homeJuris: false,   // 札幌の警察署・消防署は区ごと（区と同じ）＝カードに出さない（横浜と同じ）
	offlineMB: OFFLINE_MB,
};
