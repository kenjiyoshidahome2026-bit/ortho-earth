// 横浜市デジタルツインの台帳（区・名所・ツアー・地下鉄の駅番号・公共施設の区分・ハザード・URL の状態）＝描画を持たない純データ（Node の検定がそのまま読む）。
// 座標は区の中ほど／名所の建物の位置（WGS84）。ズームはこの地図の z（MapLibre の z＋1）・tilt と bearing は度。
// 画像タイルは国土地理院（重ねるハザードマップ）を、ブラウザが直に取る。区の境界・鉄道・バス停・公共施設・名所の写真は scripts/bake-yokohama.mjs が組んで
// ortho-data/japan/yokohama/ に置く（GitHub Pages・DATA.md）。年代の航空写真（旧「時間」）は継ぎ目と色むらが目立つので外した（本人 2026-10-21）。

export interface Ward { code: string; name: string; lon: number; lat: number; zoom: number }
export interface Spot { id: string; /** ja.wikipedia の記事名（写真の出どころ） */ wiki: string; name: string; ward: string; lon: number; lat: number; zoom: number; tilt: number; bearing: number; note: string }
export interface Legend { color: string; label: string }
export interface Hazard { id: string; name: string; urls: string[]; maxZoom: number; legend: Legend[]; note: string }
export interface TwinState { tab: Tab; ward: string; hz: string[]; spot: string; tr: string[] }
/** 面＝観光・交通・防災・解析（2026-10-21 に「まち」→「観光」・「時間」を外し「交通」を足した） */
export type Tab = "sight" | "transit" | "risk" | "tools";
export const TAB_NAMES: Record<Tab, string> = { sight: "観光", transit: "交通", risk: "防災", tools: "解析" };

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
	{ id: "yokohama-st", wiki: "横浜駅", name: "横浜駅", ward: "14103", lon: 139.6223, lat: 35.4657, zoom: 17.0, tilt: 58, bearing: 30, note: "鉄道 6 社が乗り入れる横浜の玄関口。駅の東西にビルが集まる。" },
	{ id: "mm21", wiki: "みなとみらい21", name: "みなとみらい 21", ward: "14103", lon: 139.6315, lat: 35.4546, zoom: 16.4, tilt: 62, bearing: -20, note: "造船所と操車場の跡地に築いた新しい都心。横浜ランドマークタワー（高さ 296m・1993 年開業）が建つ。" },
	{ id: "akarenga", wiki: "横浜赤レンガ倉庫", name: "横浜赤レンガ倉庫", ward: "14104", lon: 139.6425, lat: 35.4529, zoom: 17.6, tilt: 60, bearing: 20, note: "明治末から大正初めに建てられた国の保税倉庫。いまは商業と文化の施設。" },
	{ id: "osanbashi", wiki: "横浜港大さん橋国際客船ターミナル", name: "大さん橋", ward: "14104", lon: 139.6475, lat: 35.4513, zoom: 17.2, tilt: 60, bearing: 140, note: "大型客船が着く国際客船ターミナル。屋上は誰でも歩ける広場。" },
	{ id: "yamashita", wiki: "山下公園", name: "山下公園", ward: "14104", lon: 139.6505, lat: 35.4460, zoom: 17.2, tilt: 60, bearing: 60, note: "関東大震災のがれきで海を埋め立てて造った臨海公園（1930 年開園）。" },
	{ id: "chinatown", wiki: "横浜中華街", name: "横浜中華街", ward: "14104", lon: 139.6460, lat: 35.4425, zoom: 17.6, tilt: 62, bearing: 45, note: "開港後に生まれた日本最大級の中華街。" },
	{ id: "marine-tower", wiki: "横浜マリンタワー", name: "横浜マリンタワー", ward: "14104", lon: 139.6506, lat: 35.4437, zoom: 17.8, tilt: 55, bearing: -30, note: "1961 年に開業した港のタワー。" },
	{ id: "stadium", wiki: "横浜スタジアム", name: "横浜スタジアム", ward: "14104", lon: 139.6400, lat: 35.4433, zoom: 17.6, tilt: 58, bearing: 0, note: "横浜公園の中にある球場。" },
	{ id: "city-hall", wiki: "横浜市役所", name: "横浜市役所", ward: "14104", lon: 139.6330, lat: 35.4513, zoom: 17.6, tilt: 58, bearing: 200, note: "2020 年に北仲通の新庁舎へ移った市役所。" },
	{ id: "baybridge", wiki: "横浜ベイブリッジ", name: "横浜ベイブリッジ", ward: "14104", lon: 139.6740, lat: 35.4545, zoom: 16.0, tilt: 65, bearing: -60, note: "1989 年に開通した斜張橋。橋は PLATEAU の橋梁モデルで立つ。" },
	{ id: "daikoku", wiki: "大黒ふ頭", name: "大黒ふ頭", ward: "14101", lon: 139.6800, lat: 35.4620, zoom: 16.0, tilt: 55, bearing: 20, note: "コンテナや自動車を扱う埠頭。" },
	{ id: "sankeien", wiki: "三溪園", name: "三溪園", ward: "14104", lon: 139.6620, lat: 35.4170, zoom: 17.0, tilt: 55, bearing: 0, note: "実業家 原三溪が造り 1906 年に公開した日本庭園。" },
	{ id: "shin-yokohama", wiki: "新横浜駅", name: "新横浜", ward: "14109", lon: 139.6150, lat: 35.5085, zoom: 16.2, tilt: 58, bearing: -30, note: "新幹線の駅と日産スタジアムのある北の拠点。" },
	{ id: "center-kita", wiki: "港北ニュータウン", name: "港北ニュータウン", ward: "14118", lon: 139.5785, lat: 35.5470, zoom: 16.2, tilt: 55, bearing: 0, note: "丘陵を開いて計画的に造った住宅都市。センター北・センター南が核。" },
	{ id: "hakkeijima", wiki: "横浜・八景島シーパラダイス", name: "八景島", ward: "14108", lon: 139.6420, lat: 35.3380, zoom: 16.4, tilt: 58, bearing: 30, note: "金沢の海に造った人工島。" },
];

/** 名所の写真の 1 件（photos.json・Wikimedia Commons の代表画像） */
export interface Photo { src: string; file: string; artist: string; license: string; page: string }

/** 横浜市営地下鉄の路線と駅番号（駅ナンバリング）。地図の駅は N02 の駅名で引き当てて記号を付ける */
export interface SubwayLine { id: "B" | "G"; name: string; color: string; stations: string[] }
export const SUBWAY: SubwayLine[] = [
	{ id: "B", name: "ブルーライン", color: "#1f6fc5", stations: ["湘南台", "下飯田", "立場", "中田", "踊場", "戸塚", "舞岡", "下永谷", "上永谷", "港南中央", "上大岡", "弘明寺", "蒔田", "吉野町", "阪東橋", "伊勢佐木長者町", "関内", "桜木町", "高島町", "横浜", "三ツ沢下町", "三ツ沢上町", "片倉町", "岸根公園", "新横浜", "北新横浜", "新羽", "仲町台", "センター南", "センター北", "中川", "あざみ野"] },
	{ id: "G", name: "グリーンライン", color: "#1e9b4f", stations: ["中山", "川和町", "都筑ふれあいの丘", "センター南", "センター北", "北山田", "東山田", "高田", "日吉本町", "日吉"] },
];
/** 駅名 → 駅番号の並び（"B29"・"G04"…）。乗換駅（センター南・北）は 2 つ。名前の揺れ（ヶ・ケ）は畳む */
const normSta = (n: string) => String(n || "").replace(/ケ/g, "ヶ").replace(/駅$/, "").trim();
export function subwayCodes(name: string): { code: string; line: SubwayLine }[] {
	const n = normSta(name), out: { code: string; line: SubwayLine }[] = [];
	for (const l of SUBWAY) { const i = l.stations.findIndex(s => normSta(s) === n); if (i >= 0) out.push({ code: `${l.id}${String(i + 1).padStart(2, "0")}`, line: l }); }
	return out;
}
/** 交通の層（既定は地下鉄だけ） */
export const TRANSIT = [
	{ id: "subway", name: "横浜市営地下鉄（ブルーライン・グリーンライン）" },
	{ id: "bus", name: "横浜市営バスの停留所" },
	{ id: "rail", name: "JR・私鉄の駅と線路" },
] as const;
export const TRANSIT_DEFAULT = ["subway"];

/** 公共施設の区分（bake-yokohama.mjs の CATS と同じ並び＝facilities.json の区分の番号）。色＝地図の点と凡例 */
export const FACILITY_CATS = [
	{ name: "区役所・行政", color: "#d84315" }, { name: "地区センター・集会", color: "#8e24aa" }, { name: "学校", color: "#1e88e5" },
	{ name: "図書館・文化", color: "#00897b" }, { name: "消防", color: "#e53935" }, { name: "警察", color: "#3949ab" }, { name: "病院", color: "#43a047" },
];
/** 施設の 1 行＝[経度, 緯度, 名称, 区分の番号, 住所, 種別] */
export type FacilityRow = [number, number, string, number, string, string];
/** 鉄道の駅の 1 行＝[経度, 緯度, 駅名, "事業者 路線・…", 地下鉄なら 1] */
export type StationRow = [number, number, string, string, number];
/** 市営バスの停留所の 1 行＝[経度, 緯度, 停留所名, "系統・…"] */
export type BusRow = [number, number, string, string];

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
		legend: [{ color: "#f5e95c", label: "警戒区域" }, { color: "#e5463c", label: "特別警戒区域" }, { color: "#00008b", label: "急傾斜地崩壊危険区域（急傾斜地法）" }],
		note: "土石流・急傾斜地の崩壊（がけ崩れ）・地すべりの警戒区域。紺は急傾斜地法に基づく危険区域。" },
];

/** PLATEAU の建物が LOD2（屋根の形まで）で配信される区＝エンジンの登録簿（plateau-sets.json）が自動で読む 5 区。残り 13 区は LOD1（箱）だけ＝この頁が任意で足す（2026-10-18 の配信を確認） */
export const LOD2_WARDS = ["14101", "14102", "14103", "14104", "14114"];
export const LOD1_WARDS = WARDS.filter(w => !LOD2_WARDS.includes(w.code));
/** 区の LOD1 建築物の 3D Tiles（PLATEAU の datacatalog・texture 版しか無い＝読む時にテクスチャは落とす） */
export const lod1Url = (code: string) => `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${code}-bldg-lod1-texture-latest/tileset.json`;

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

// ── URL の状態（共有できる）：?tab=risk&hz=flood,tsunami&ward=14104&spot=mm21&tr=subway,bus ──
export const TABS: Tab[] = ["sight", "transit", "risk", "tools"];
const OLD_TABS: Record<string, Tab> = { city: "sight", time: "tools" };   // 2026-10-21 より前の共有 URL
export function parseState(search: string): TwinState {
	const q = new URLSearchParams(search);
	const t = q.get("tab") || "";
	const tab = TABS.includes(t as Tab) ? t as Tab : OLD_TABS[t] || "sight";
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
	set("tab", st.tab, "sight"); set("hz", st.hz.join(","), ""); set("ward", st.ward, ""); set("spot", st.spot, "");
	const tr = TRANSIT.filter(x => st.tr.includes(x.id)).map(x => x.id).join(",");
	if (tr === TRANSIT_DEFAULT.join(",")) q.delete("tr"); else q.set("tr", tr);   // 全部消した＝"tr=" を残す（既定の地下鉄に戻さない）
	q.delete("era");   // 旧「時間」の鍵
	const s = q.toString();
	return s ? "?" + s : "";
}
