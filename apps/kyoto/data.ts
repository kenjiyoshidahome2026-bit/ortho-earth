// 京都市デジタルツインの市の設定（区・名所・ツアー・地下鉄の駅番号・救急・京都の歴史の物語）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 案内板と機能は共有モジュール @ortho-earth/citytwin（packages/citytwin・共有エンジンの入口）＝横浜市デジタルツインと同じ芯（2026-11-14）。ここは京都の物だけ。
// 座標は区の中ほど／名所の建物の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 区の境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-kyoto.mjs（中身は共通の packages/citytwin/scripts/bake-city.mjs）が組んで ortho-data/japan/kyoto/ に置く（GitHub Pages・DATA.md）。
import { HAZARDS as HAZARD_DEFS, RAIL_LAYER, subwayCodes as codesOf, railLinesEn as linesEn, sheltersIn, wardOfAddress as wardOf, facilityIndex as facIndex, parseState as parse, writeState as write, parsePlaces as places } from "@ortho-earth/citytwin/core";
import type { Ward, Spot, Hazard, SubwayLine, TransitLayer, Chapter, View, FacilityRow, HinanRow, TwinState, CityConfig, Clinic } from "@ortho-earth/citytwin/core";
export * from "@ortho-earth/citytwin/core";   // 検定（tests/t-kyoto.mjs）と頁がここから引く共通の物

/** 京都市の外接矩形（11 区を包む・北は左京区の久多、西は右京区の京北まで）と全景の視点（市街地を中心に） */
export const CITY_BBOX: [number, number, number, number] = [135.55, 34.87, 135.88, 35.33];
export const CITY_VIEW = { lon: 135.76, lat: 35.03, zoom: 11.6, tilt: 35, bearing: 0 };

/** 11 区（市区町村コード順）。座標は区の中ほど（北区・左京区・右京区は南の市街地寄り）・zoom は区がほぼ画面に収まる値 */
export const WARDS: Ward[] = [
	{ code: "26101", name: "北区", en: "Kita-ku", lon: 135.735, lat: 35.075, zoom: 12.4 },
	{ code: "26102", name: "上京区", en: "Kamigyo-ku", lon: 135.755, lat: 35.028, zoom: 14.3 },
	{ code: "26103", name: "左京区", en: "Sakyo-ku", lon: 135.795, lat: 35.110, zoom: 11.8 },
	{ code: "26104", name: "中京区", en: "Nakagyo-ku", lon: 135.748, lat: 35.010, zoom: 14.0 },
	{ code: "26105", name: "東山区", en: "Higashiyama-ku", lon: 135.779, lat: 34.991, zoom: 14.2 },
	{ code: "26106", name: "下京区", en: "Shimogyo-ku", lon: 135.750, lat: 34.993, zoom: 14.4 },
	{ code: "26107", name: "南区", en: "Minami-ku", lon: 135.738, lat: 34.966, zoom: 13.8 },
	{ code: "26108", name: "右京区", en: "Ukyo-ku", lon: 135.665, lat: 35.105, zoom: 11.6 },
	{ code: "26109", name: "伏見区", en: "Fushimi-ku", lon: 135.785, lat: 34.930, zoom: 12.8 },
	{ code: "26110", name: "山科区", en: "Yamashina-ku", lon: 135.823, lat: 34.983, zoom: 13.4 },
	{ code: "26111", name: "西京区", en: "Nishikyo-ku", lon: 135.665, lat: 34.977, zoom: 13.0 },
];

/** 名所（ツアーの止まり先を兼ねる）。note＝止まった時に出す一行（事実だけ） */
export const SPOTS: Spot[] = [
	{ id: "kyoto-st", wiki: "京都駅", name: "Kyoto Station", ward: "26106", lon: 135.7588, lat: 34.9858, zoom: 16.8, tilt: 58, bearing: 0, note: "Kyoto's main gateway, served by the Tokaido Shinkansen, JR lines, the Kintetsu Line and the Karasuma subway line. The present station building opened in 1997." },
	{ id: "kyoto-tower", wiki: "京都タワー", name: "Kyoto Tower", ward: "26106", lon: 135.7593, lat: 34.9875, zoom: 17.4, tilt: 55, bearing: 180, note: "Observation tower opened in 1964, 131 m tall including the building it stands on, across from Kyoto Station." },
	{ id: "toji", wiki: "東寺", name: "To-ji Temple", ward: "26107", lon: 135.7477, lat: 34.9806, zoom: 17.2, tilt: 58, bearing: 30, note: "Temple founded in 796 near the capital's southern gate. Its five-story pagoda, about 55 m, is the tallest wooden pagoda in Japan." },
	{ id: "nishiki", wiki: "錦市場", name: "Nishiki Market", ward: "26104", lon: 135.7649, lat: 35.0050, zoom: 17.6, tilt: 60, bearing: 90, note: "A narrow covered street of food shops, about 390 m long, known as Kyoto's kitchen." },
	{ id: "city-hall", wiki: "京都市役所", name: "Kyoto City Hall", ward: "26104", lon: 135.7681, lat: 35.0112, zoom: 17.6, tilt: 58, bearing: 0, note: "City hall on Oike Street. The main building dates from 1927–1931." },
	{ id: "nijo", wiki: "元離宮二条城", name: "Nijo Castle", ward: "26104", lon: 135.7481, lat: 35.0142, zoom: 16.8, tilt: 58, bearing: 0, note: "Castle built in 1603 for the Tokugawa shoguns. In 1867 the shogun announced here the return of power to the Emperor." },
	{ id: "gosho", wiki: "京都御所", name: "Kyoto Imperial Palace", ward: "26102", lon: 135.7621, lat: 35.0254, zoom: 16.2, tilt: 55, bearing: 0, note: "The imperial residence until 1869, inside the Kyoto Gyoen National Garden." },
	{ id: "shimogamo", wiki: "賀茂御祖神社", name: "Shimogamo Shrine", ward: "26103", lon: 135.7727, lat: 35.0389, zoom: 16.8, tilt: 58, bearing: 0, note: "Shrine in the Tadasu-no-mori forest, where the Kamo and Takano rivers meet." },
	{ id: "kinkaku", wiki: "鹿苑寺", name: "Kinkaku-ji (Golden Pavilion)", ward: "26101", lon: 135.7292, lat: 35.0394, zoom: 17.2, tilt: 58, bearing: 0, note: "Zen temple whose pavilion is covered in gold leaf. The present pavilion was rebuilt in 1955 after a fire in 1950." },
	{ id: "ginkaku", wiki: "慈照寺", name: "Ginkaku-ji (Silver Pavilion)", ward: "26103", lon: 135.7982, lat: 35.0270, zoom: 17.2, tilt: 58, bearing: 90, note: "Temple built from the retreat of shogun Ashikaga Yoshimasa. Its Kannon Hall, finished in 1489, is known as the Silver Pavilion." },
	{ id: "heian", wiki: "平安神宮", name: "Heian Shrine", ward: "26103", lon: 135.7824, lat: 35.0160, zoom: 16.8, tilt: 58, bearing: 0, note: "Shrine built in 1895 for the 1,100th anniversary of the capital, with a giant vermilion torii on the approach." },
	{ id: "nanzenji", wiki: "南禅寺", name: "Nanzen-ji Temple", ward: "26103", lon: 135.7932, lat: 35.0113, zoom: 17.0, tilt: 58, bearing: 90, note: "Zen temple whose grounds hold Suirokaku, the brick aqueduct of the Lake Biwa Canal (1888)." },
	{ id: "yasaka", wiki: "八坂神社", name: "Yasaka Shrine", ward: "26105", lon: 135.7785, lat: 35.0037, zoom: 17.2, tilt: 58, bearing: 90, note: "Shrine at the east end of Shijo Street that holds the Gion Festival every July." },
	{ id: "kiyomizu", wiki: "清水寺", name: "Kiyomizu-dera Temple", ward: "26105", lon: 135.7850, lat: 34.9949, zoom: 17.0, tilt: 60, bearing: 100, note: "Temple on the slopes of Higashiyama, known for its wooden stage over the hillside." },
	{ id: "sanjusangendo", wiki: "三十三間堂", name: "Sanjusangen-do", ward: "26105", lon: 135.7718, lat: 34.9879, zoom: 17.2, tilt: 58, bearing: 0, note: "Temple hall about 120 m long, holding 1,001 statues of the Thousand-armed Kannon." },
	{ id: "fushimi-inari", wiki: "伏見稲荷大社", name: "Fushimi Inari Taisha", ward: "26109", lon: 135.7727, lat: 34.9671, zoom: 16.8, tilt: 60, bearing: 90, note: "Head shrine of Inari shrines across Japan, known for thousands of vermilion torii gates climbing Mount Inari." },
	{ id: "arashiyama", wiki: "渡月橋", name: "Arashiyama (Togetsukyo Bridge)", ward: "26108", lon: 135.6776, lat: 35.0129, zoom: 16.4, tilt: 62, bearing: -30, note: "Bridge over the Katsura River at Arashiyama, a scenic area at the western edge of the city." },
];

/** 京都市営地下鉄の路線と駅番号（駅ナンバリング）。地図の駅は N02 の駅名で引き当てて記号を付ける。乗換駅＝烏丸御池（K08・T13） */
export const SUBWAY: SubwayLine[] = [
	{ id: "K", name: "Karasuma Line", color: "#15975a", stations: ["国際会館", "松ヶ崎", "北山", "北大路", "鞍馬口", "今出川", "丸太町", "烏丸御池", "四条", "五条", "京都", "九条", "十条", "くいな橋", "竹田"],
		romaji: ["Kokusaikaikan", "Matsugasaki", "Kitayama", "Kitaoji", "Kuramaguchi", "Imadegawa", "Marutamachi", "Karasuma Oike", "Shijo", "Gojo", "Kyoto", "Kujo", "Jujo", "Kuinabashi", "Takeda"] },
	{ id: "T", name: "Tozai Line", color: "#e2572c", stations: ["六地蔵", "石田", "醍醐", "小野", "椥辻", "東野", "山科", "御陵", "蹴上", "東山", "三条京阪", "京都市役所前", "烏丸御池", "二条城前", "二条", "西大路御池", "太秦天神川"],
		romaji: ["Rokujizo", "Ishida", "Daigo", "Ono", "Nagitsuji", "Higashino", "Yamashina", "Misasagi", "Keage", "Higashiyama", "Sanjo Keihan", "Kyoto Shiyakusho-mae", "Karasuma Oike", "Nijojo-mae", "Nijo", "Nishioji Oike", "Uzumasa Tenjingawa"] },
];
/** 駅名 → 駅番号の並び（"K11"・"T13"…）。乗換駅（烏丸御池）は 2 つ */
export const subwayCodes = (name: string) => codesOf(SUBWAY, name);
/** 交通の層（最初は全部 OFF） */
export const TRANSIT: TransitLayer[] = [
	{ id: "subway", name: "Kyoto Municipal Subway (Karasuma Line, Tozai Line)" },
	RAIL_LAYER,
	{ id: "bus", name: "Kyoto City Bus stops" },
];
export const TRANSIT_DEFAULT: string[] = [];   // 横浜と同じ＝最初は何も出さない

/** 市の大きな病院（救命救急センター・大学病院・地域医療支援病院）。key＝台帳（KSJ P04）の名に含まれる語、name＝カードに出す短い名。
 *  横浜と同じく病院の「管轄区域」は無い＝わが家のまわりでは近い順で出す */
export const MAJOR_HOSPITALS: { key: string; name: string }[] = [
	{ key: "京都市立病院", name: "京都市立病院" },
	{ key: "京都大学医学部附属病院", name: "京都大学医学部附属病院" },
	{ key: "京都府立医科大学附属病院", name: "京都府立医科大学附属病院" },
	{ key: "京都第一赤十字病院", name: "京都第一赤十字病院" },
	{ key: "京都第二赤十字病院", name: "京都第二赤十字病院" },
	{ key: "京都医療センター", name: "国立病院機構京都医療センター" },
	{ key: "京都桂病院", name: "京都桂病院" },
	{ key: "音羽病院", name: "洛和会音羽病院" },
];
/** 急病の診療所（夜間・休日）＝京都市急病診療所（市内 1 か所・内科と小児科）。区ごとの休日急患診療所は無い＝holiday は持たない。
 *  時間は医療情報の掲載（2026-11 確認）＝変わることがあるので「電話で確かめて」を添える。位置＝JR 二条駅の南東（地理院の住所検索で確かめる） */
export const NIGHT_CENTERS: Clinic[] = [
	{ name: "京都市急病診療所", addr: "中京区西ノ京東栂尾町6", tel: "075-354-6021", lon: 135.7425, lat: 35.0104, enName: "Kyoto City Emergency Clinic", en: "6 Nishinokyo Higashitoganoocho, Nakagyo-ku" },
];
/** 台帳の名 → 大きな病院の短い名（でなければ null） */
export const majorHospital = (name: string): string | null => MAJOR_HOSPITALS.find(h => name.includes(h.key))?.name ?? null;
/** 施設の検索の行（区で絞る） */
export const facilityIndex = (rows: readonly FacilityRow[], ward: string, subs: ReadonlySet<number>) => facIndex(CITY, rows, ward, subs);

/** 京都の歴史の物語＝平安京（794）から今までの章。写真は photo（名所の id）か、無ければ章の id で photos.json を引く（bake が両方焼く） */
export const KYOTO_STORY: Chapter[] = [
	{ id: "kyo-794", year: "794", photo: "heian", wiki: "平安神宮", name: "A new capital, Heian-kyo", ward: "26103", lon: 135.7824, lat: 35.0160, zoom: 16.6, tilt: 60, bearing: 0, note: "In 794 the capital moved to Heian-kyo, a grid city laid out on the model of Chang'an. Heian Shrine (1895) recreates part of its palace at reduced scale." },
	{ id: "kyo-796", year: "796", photo: "toji", wiki: "東寺", name: "A temple by the southern gate", ward: "26107", lon: 135.7477, lat: 34.9806, zoom: 17.0, tilt: 60, bearing: 30, note: "To-ji was founded in 796 beside Rashomon, the capital's southern gate, and still stands on its original site." },
	{ id: "kyo-1397", year: "1397", photo: "kinkaku", wiki: "鹿苑寺", name: "The Golden Pavilion", ward: "26101", lon: 135.7292, lat: 35.0394, zoom: 17.2, tilt: 58, bearing: 0, note: "In 1397 shogun Ashikaga Yoshimitsu began a villa in Kitayama. After his death it became the temple Rokuon-ji, famous for its golden pavilion." },
	{ id: "kyo-1489", year: "1489", photo: "ginkaku", wiki: "慈照寺", name: "The Silver Pavilion", ward: "26103", lon: 135.7982, lat: 35.0270, zoom: 17.2, tilt: 58, bearing: 90, note: "Shogun Ashikaga Yoshimasa's Kannon Hall in Higashiyama, finished in 1489, reflects the quiet taste of the Higashiyama culture." },
	{ id: "kyo-1603", year: "1603", photo: "nijo", wiki: "元離宮二条城", name: "The shoguns' castle", ward: "26104", lon: 135.7481, lat: 35.0142, zoom: 16.8, tilt: 58, bearing: 0, note: "Tokugawa Ieyasu built Nijo Castle in 1603. In 1867 the last shogun announced here the return of power to the Emperor." },
	{ id: "kyo-1890", year: "1890", wiki: "琵琶湖疏水", name: "Water and power from Lake Biwa", ward: "26105", lon: 135.7912, lat: 35.0073, zoom: 16.8, tilt: 60, bearing: 60, note: "After the capital moved to Tokyo, Kyoto built the Lake Biwa Canal (1890). Japan's first commercial hydroelectric plant opened at Keage in 1891 and powered the city's streetcars." },
	{ id: "kyo-1964", year: "1964", photo: "kyoto-tower", wiki: "京都タワー", name: "A tower for a new era", ward: "26106", lon: 135.7593, lat: 34.9875, zoom: 17.0, tilt: 55, bearing: 180, note: "Kyoto Tower opened in 1964, the year the Tokaido Shinkansen began service." },
	{ id: "kyo-1994", year: "1994", photo: "kiyomizu", wiki: "清水寺", name: "World Heritage", ward: "26105", lon: 135.7850, lat: 34.9949, zoom: 16.8, tilt: 60, bearing: 100, note: "In 1994, seventeen temples, shrines and a castle in Kyoto, Uji and Otsu were listed as the World Heritage site Historic Monuments of Ancient Kyoto." },
	{ id: "kyo-1997", year: "1997", photo: "kyoto-st", wiki: "京都駅", name: "A station for the modern city", ward: "26106", lon: 135.7588, lat: 34.9858, zoom: 16.6, tilt: 58, bearing: 0, note: "The present Kyoto Station building, designed by Hiroshi Hara, opened in 1997 with a vast glass-roofed concourse." },
];
/** 東山からの眺め＝東の山の中腹に立ったつもりで、盆地の街並みを順に見渡す（中心＝見る先・bearing＝向き＝カメラは中心の反対側に立つ） */
export const HILL_VIEWS: View[] = [
	{ lon: 135.7640, lat: 35.0040, zoom: 15.6, tilt: 75, bearing: -90 },    // 八坂・円山のあたりから西へ＝祇園・四条の街並みの奥に西山（tilt はエンジンの上限 75）
	{ lon: 135.7620, lat: 34.9900, zoom: 15.6, tilt: 75, bearing: -110 },   // 清水寺の下から京都駅・南区へ
	{ lon: 135.7650, lat: 35.0230, zoom: 15.2, tilt: 75, bearing: -100 },   // 吉田山・大文字の麓から御所と北の山へ（2026-11-14 実機：z14 台は高すぎて街が地図に見えた）
];

/** ツアー＝全景から始めて名所を巡り全景へ戻る（SPOTS の id の並び） */
export const TOUR = ["kyoto-st", "toji", "fushimi-inari", "sanjusangendo", "kiyomizu", "yasaka", "heian", "ginkaku", "gosho", "nijo", "kinkaku", "arashiyama"];

/** 災害の想定＝海の無い京都は洪水と土砂災害（高潮・津波は持たない） */
export const HAZARDS: Hazard[] = HAZARD_DEFS.filter(h => h.id === "flood" || h.id === "dosha");

/** PLATEAU の建物が LOD2（屋根の形まで）で配信される区。山科区・西京区は LOD1（箱）だけ（エンジンの登録簿 plateau-sets.json）。描くのはエンジン */
export const LOD2_WARDS = ["26101", "26102", "26103", "26104", "26105", "26106", "26107", "26108", "26109"];
/** 先読みする PLATEAU（エンジンの登録簿の名前）＝観光の主役（駅・祇園・御所のあたり）から */
export const LOD2_PREFETCH = ["京都下京区", "京都中京区", "京都東山区", "京都上京区", "京都市（橋梁）"];
export const LOD1_WARDS = WARDS.filter(w => !LOD2_WARDS.includes(w.code));
/** 通信なしの保存で端末に詰める建物＝11 区＋橋梁（エンジンの登録簿の名前） */
export const BLD_SETS = [...WARDS.map(w => "京都" + w.name), "京都市（橋梁）"];
/** 市の外の覆い（穴＝市の外周）の外枠 [w,s,e,n]。枠の縁が画面に入ったら覆いごと消す */
export const MASK_BOX: [number, number, number, number] = [134.8, 34.4, 136.8, 35.9];

/** 鉄道の路線名（rail.json の「事業者 路線」）→ 英語（日本語以外で出す） */
export const RAIL_LINES_EN: Record<string, string> = {
	"京都市 烏丸線": "Karasuma Line", "京都市 東西線": "Tozai Line",
	"東海旅客鉄道 東海道新幹線": "Tokaido Shinkansen", "西日本旅客鉄道 東海道線": "JR Kyoto Line", "西日本旅客鉄道 山陰線": "JR Sagano Line", "西日本旅客鉄道 奈良線": "JR Nara Line", "西日本旅客鉄道 湖西線": "JR Kosei Line",
	"京阪電気鉄道 京阪本線": "Keihan Main Line", "京阪電気鉄道 鴨東線": "Keihan Oto Line", "京阪電気鉄道 宇治線": "Keihan Uji Line", "京阪電気鉄道 京津線": "Keihan Keishin Line",
	"阪急電鉄 京都線": "Hankyu Kyoto Line", "阪急電鉄 嵐山線": "Hankyu Arashiyama Line", "近畿日本鉄道 京都線": "Kintetsu Kyoto Line",
	"京福電気鉄道 嵐山本線": "Randen Arashiyama Line", "京福電気鉄道 北野線": "Randen Kitano Line", "叡山電鉄 叡山本線": "Eizan Main Line", "叡山電鉄 鞍馬線": "Eizan Kurama Line",
	"嵯峨野観光鉄道 嵯峨野観光線": "Sagano Scenic Railway", "京福電気鉄道 鋼索線": "Eizan Cable Car", "鞍馬寺 鞍馬山鋼索鉄道": "Kurama-dera Cable Car",
};
export const railLinesEn = (s: string) => linesEn(RAIL_LINES_EN, s);
/** 京都府の指定緊急避難場所（census2020 と同じ焼き・gzip の JSON・[経度, 緯度, 名称, 住所, 対応災害ビット]） */
export const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/26.json";
export const kyotoShelters = (rows: HinanRow[]): HinanRow[] => sheltersIn(rows, "京都市");
/** 住所の「京都市◯◯区」から区を引く */
export const wardOfAddress = (addr: string): Ward | null => wardOf(CITY, addr);
/** URL の状態（?tab=risk&hz=flood&ward=26104&spot=kiyomizu&tr=subway,bus） */
export const parseState = (search: string): TwinState => parse(CITY, search);
export const writeState = (search: string, st: TwinState): string => write(CITY, search, st);
/** 保存した地点（市の外接矩形の外は捨てる） */
export const parsePlaces = (raw: string | null) => places(raw, CITY_BBOX);

/** 端末に詰める物のおおよその大きさ（MB）。保存ボタンの説明に出す（Mac の実測で直す） */
export const OFFLINE_MB = 550;   // 実測（MacBook・本番と同じ build を手元で配信・新しいプロファイル 390px・2026-11-14）：保存 220 秒・カード 549 MB・端末の使用量 +616 MB（エンジンの置き場を含む）

/** 市の設定（共有モジュールの mountTwin が読む） */
export const CITY: CityConfig = {
	id: "kyoto", key: "kt",
	title: "Kyoto Digital Twin", cityName: "Kyoto City", allWards: "Kyoto City (11 wards)", outside: "Outside Kyoto City.",
	wholeCityTitle: "Show all of Kyoto City", flatNote: "Shown on the flat district map (choose a district or all of Kyoto City).", zonesTitle: "Zoning and jurisdictions",   // 学区は無い（noAreas）
	addrPrefix: "京都市", bbox: CITY_BBOX, view: CITY_VIEW, maskBox: MASK_BOX,
	wards: WARDS, spots: SPOTS, tour: TOUR,
	tourIntro: "11 wards, about 828 km². From the grid of the old capital to temples on the hills, a tour through the city in 3D.",
	story: { button: "📜 Kyoto through the ages (794 to today)", chapters: KYOTO_STORY, views: HILL_VIEWS, viewsButton: "View the city from the eastern hills", viewsCaption: ["View the city from the eastern hills", "The basin city as seen from the slopes of Higashiyama."] },
	subway: SUBWAY, subwayName: "Kyoto Municipal Subway",
	subwayColor: name => /東西/.test(name) ? SUBWAY[1].color : SUBWAY[0].color,   // N02 の路線名＝烏丸線／東西線
	subwayRail: /^京都市 (烏丸|東西)線/,
	subwayNote: "Subway stations carry their station numbers (K = Karasuma Line, T = Tozai Line). Tap a station or stop to see its lines or routes.",
	busName: "Kyoto City Bus",
	transit: TRANSIT, transitDefault: TRANSIT_DEFAULT, railLinesEn: RAIL_LINES_EN,
	hazards: HAZARDS,
	riskNote: "Tilt the map to compare flood depths with building heights. Scenarios are official estimates by the national government, Kyoto Prefecture and others; real disasters can exceed them.",
	inland: { text: "Inland flooding (rain the sewers cannot drain) is shown on the city's own disaster information map.", link: "Kyoto City disaster information map", url: "https://www.bousaimap.city.kyoto.lg.jp/" },   // 内水ハザードマップ（2026-06 公開）は市の防災情報マップで見る
	hinanUrl: HINAN_URL,
	lod2Prefetch: LOD2_PREFETCH, bldSets: BLD_SETS,
	bldNames: code => { const w = WARDS.find(x => x.code === code); return w ? ["京都" + w.name, ...(code === "26104" || code === "26105" ? ["京都市（橋梁）"] : [])] : []; },   // 鴨川の橋＝中京・東山の境
	emergency: {
		night: { centers: NIGHT_CENTERS, label: "Emergency clinic (nights and holidays)", hours: "Internal medicine and pediatrics · weekday nights 20:00–23:00, Saturdays 14:00–17:00 and from 18:00 overnight, Sundays and holidays 10:00–17:00 and 18:00–23:00. Call ahead to check." },
		advice: { text: "Unsure whether to call an ambulance? Kyoto emergency advice line, 24 hours:", tel: "#7119" },
	},
	noAreas: ["school-e", "school-j"],   // 国土数値情報の小・中学校区（A27・A32）に京都市の面が無い（2016・2021 とも・Mac で確認 2026-11-14）
	majorHospitals: MAJOR_HOSPITALS,
	homeJuris: true,   // 京都は警察署・消防署の管轄が区と一致しない所がある＝カードに出す
	offlineMB: OFFLINE_MB,
};
