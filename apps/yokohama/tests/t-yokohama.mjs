#!/usr/bin/env node
// data.ts の常設検定（Node だけ・外部網なし）＝区と名所の台帳・ツアーの並び・地下鉄の駅番号・ハザードの URL の形・避難場所の選び方・URL の状態の往復。
import { makeEn, romaji } from "../scripts/en-names.mjs";
import { WARDS, SPOTS, TOUR, HAZARDS, CITY_BBOX, HINAN_FLAGS, SUBWAY, FACILITY_CATS, TRANSIT, subwayCodes, yokohamaShelters, wardOfAddress, flagsOf, parseState, writeState, DEPTH, tilePixel, legendIndex, floorsOfDepth, distM, nearestRows, nearestSites, siteName, walkMin, WALK_RINGS, walkRadius, circleRing, countRings, PORT_STORY, SEA_VIEWS, FACILITY_SUBS, subOf, facilityIndex, normJa, ZONES, AREAS , BUILDINGS_MIN_ZOOM, LOD1_WARDS, MASK_BOX, insideBox, SUBWAY_MIN_ZOOM, CITY_VIEW, TABS, inGeometry, featureAt, MAJOR_HOSPITALS, majorHospital, HOLIDAY_CLINICS, clinicHours, NIGHT_CENTERS, walkKind, encodeWalk, decodeWalk, walkCells, buildWalkGraph, walkSnap, walkSearch, walkTo, walkPath, WALK_Q, railLinesEn } from "../data.ts";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const inCity = (lon, lat) => lon >= CITY_BBOX[0] && lon <= CITY_BBOX[2] && lat >= CITY_BBOX[1] && lat <= CITY_BBOX[3];

t("区：18 区・コードは 14101〜14118 の連番", WARDS.length === 18 && WARDS.every((w, i) => w.code === String(14101 + i)), WARDS.map(w => w.code).join());
t("区：名前は「区」で終わり重複しない", WARDS.every(w => w.name.endsWith("区")) && new Set(WARDS.map(w => w.name)).size === 18);
t("区・名所：座標は横浜市の外接矩形の中", [...WARDS, ...SPOTS].every(p => inCity(p.lon, p.lat)), [...WARDS, ...SPOTS].filter(p => !inCity(p.lon, p.lat)).map(p => p.name).join());
t("名所：id が重複せず、区は台帳にある", new Set(SPOTS.map(s => s.id)).size === SPOTS.length && SPOTS.every(s => WARDS.some(w => w.code === s.ward)));
t("名所：写真の記事名がある", SPOTS.every(s => typeof s.wiki === "string" && s.wiki.length > 1));
t("名所：視点の値が地図の域（z 12〜19・tilt 0〜75）", SPOTS.every(s => s.zoom >= 12 && s.zoom <= 19 && s.tilt >= 0 && s.tilt <= 75));
t("ツアー：並びは全部名所の id・重複なし", TOUR.length >= 5 && TOUR.every(id => SPOTS.some(s => s.id === id)) && new Set(TOUR).size === TOUR.length);
t("ハザード：URL は {z}/{x}/{y} の型紙（https）・凡例あり", HAZARDS.every(h => h.urls.length && h.urls.every(u => /^https:\/\/disaportaldata\.gsi\.go\.jp\/raster\/[\w]+\/\{z\}\/\{x\}\/\{y\}\.png$/.test(u)) && h.legend.length));
t("地下鉄：ブルー 32 駅・グリーン 10 駅・駅名の重複なし", SUBWAY[0].stations.length === 32 && SUBWAY[1].stations.length === 10 && SUBWAY.every(l => new Set(l.stations).size === l.stations.length));
t("地下鉄：駅番号（横浜＝B20・日吉＝G10・センター南＝B29 と G04）", subwayCodes("横浜")[0]?.code === "B20" && subwayCodes("日吉駅")[0]?.code === "G10" && subwayCodes("センター南").map(c => c.code).join() === "B29,G04" && subwayCodes("渋谷").length === 0);
t("公共施設：区分は 7・色は #rrggbb", FACILITY_CATS.length === 7 && FACILITY_CATS.every(c => /^#[0-9a-f]{6}$/.test(c.color)));
t("表記の揺れ：保土ｹ谷・保土ヶ谷・全角数字も同じ区／同じ文字に", wardOfAddress("横浜市保土ｹ谷区岩間町1-7-15")?.code === "14106" && wardOfAddress("横浜市保土ヶ谷区川辺町2-9")?.code === "14106" && normJa("１－２") === "1-2");
{
	const fr = [[139.6, 35.4, "中図書館", 3, "横浜市中区本町1", "図書館"], [139.6, 35.4, "港南図書館", 3, "横浜市港南区港南1", "図書館"], [139.6, 35.4, "南小学校", 2, "横浜市南区南太田1", "小学校"], [139.6, 35.4, "保土ケ谷図書館", 3, "横浜市保土ｹ谷区天王町1", "図書館"]];
	const all = new Set(FACILITY_SUBS.map((_, i) => i)), lib = new Set([subOf(3, "図書館")]);
	t("施設の検索：全市・全種別＝全部（台帳の並び）", facilityIndex(fr, "", all).join() === "0,1,2,3");
	t("施設の検索：南区は港南区を含めない・保土ケ谷は半角表記でも拾う", facilityIndex(fr, "14105", all).join() === "2" && facilityIndex(fr, "14106", all).join() === "3");
	t("施設の検索：種別のチップで絞る", facilityIndex(fr, "", lib).join() === "0,1,3" && facilityIndex(fr, "", new Set()).length === 0);
}

const rows = [[139.63, 35.45, "みなとみらい本町小学校", "神奈川県横浜市西区みなとみらい4-3-1", 0b11001], [139.70, 35.53, "川崎の公園", "神奈川県川崎市川崎区", 1], [NaN, 35.4, "壊れ", "横浜市中区", 1], [139.6, 35.4, "住所なし", null, 1]];
const ys = yokohamaShelters(rows);
t("避難場所：住所が横浜市の行だけ・座標の壊れた行は落とす", ys.length === 1 && ys[0][2] === "みなとみらい本町小学校", JSON.stringify(ys));
t("避難場所：住所から区", wardOfAddress(ys[0][3])?.code === "14103" && wardOfAddress("神奈川県川崎市") === null);
t("避難場所：対応災害のビット", HINAN_FLAGS.length === 8 && flagsOf(0b11001).join() === "Flood,Earthquake,Tsunami");

const s = parseState("?tab=risk&hz=flood,bogus,tsunami,flood&era=1974&ward=14104&spot=mm21&tr=bus,x,subway&data=x");
t("状態：読む（知らない値は落とし重複は畳む）", s.tab === "risk" && s.hz.join() === "flood,tsunami" && s.ward === "14104" && s.spot === "mm21" && s.tr.join() === "subway,bus", JSON.stringify(s));
const DEF = { tab: "life", ward: "", hz: [], spot: "", tr: [] };
t("状態：既定値は書かず、他の鍵は残す（旧 era は消す）", writeState("?data=x&era=1974", DEF) === "?data=x");
t("状態：交通は最初は何も出さない（地下鉄も OFF・旧 URL の tr= も同じ）", parseState("").tr.length === 0 && parseState("?tr=").tr.length === 0 && writeState("", DEF) === "" && writeState("", { ...DEF, tr: ["subway"] }) === "?tr=subway");
t("状態：旧い面の名（city→観光・time→解析・area→暮らし）・既定＝暮らし", parseState("?tab=area").tab === "life" && parseState("").tab === "life" && parseState("?tab=sight").tab === "sight" && TABS.join() === "life,transit,sight,risk,tools" && parseState("?tab=city").tab === "sight" && parseState("?tab=time").tab === "tools" && TRANSIT[0].id === "subway");
t("状態：往復", JSON.stringify(parseState(writeState("", s))) === JSON.stringify(s));
t("状態：壊れた値は既定へ", JSON.stringify(parseState("?tab=x&era=1800&ward=13101")) === JSON.stringify(DEF));

const tp = tilePixel(139.6380, 35.4437, 17);
t("地点：タイルと画素（z17・横浜駅付近）", tp.x === Math.floor((139.6380 + 180) / 360 * 2 ** 17) && tp.px >= 0 && tp.px < 256 && tp.py >= 0 && tp.py < 256 && tilePixel(-180, 0, 1).x === 0 && tilePixel(0, 0, 1).py === 0, JSON.stringify(tp));
const c0 = parseInt(DEPTH[2].color.slice(1), 16);
t("地点：画素の色→凡例（透明は -1・近い色・遠い色は -1）", legendIndex(DEPTH, c0 >> 16, c0 >> 8 & 255, c0 & 255, 255) === 2 && legendIndex(DEPTH, c0 >> 16, c0 >> 8 & 255, c0 & 255, 0) === -1 && legendIndex(DEPTH, 0, 0, 0, 255) === -1);
t("地点：浸水の帯→階（床下 0・5m 帯で 2 階・20m 以上 7）", floorsOfDepth(0) === 0 && floorsOfDepth(2) === 2 && floorsOfDepth(5) === 7 && floorsOfDepth(9) === 0);
const d = distM([139.6380, 35.4437], [139.6380, 35.4537]);
t("地点：距離（緯度 0.01 度＝約 1112m）・徒歩分（80m/分×1.3）", Math.abs(d - 1112) < 3 && walkMin(d) === 18 && walkMin(0) === 1, String(d));
const nr = nearestRows([[139.70, 35.44, "遠"], [139.64, 35.444, "近"], [139.65, 35.45, "中"]], [139.638, 35.4437], 2);
t("地点：近い順に k 件", nr.length === 2 && nr[0].row[2] === "近" && nr[1].row[2] === "中" && nr[0].m < nr[1].m);
t("地点：タイルの実際の色（0.5〜1m #f8e1a6・0.3m 未満 #ffffb3・土砂 #fae600／#fa2800）を正しい帯に", legendIndex(DEPTH, 248, 225, 166, 255) === 1 && legendIndex(DEPTH, 255, 255, 179, 255) === 0 && legendIndex(HAZARDS.find(h => h.id === "dosha").legend, 250, 230, 0, 255) === 0 && legendIndex(HAZARDS.find(h => h.id === "dosha").legend, 250, 40, 0, 255) === 1);
const ns = nearestSites([[139.6381, 35.4437, "甲小学校　校舎１"], [139.6382, 35.4437, "甲小学校　体育館"], [139.6383, 35.4437, "乙中学校 校舎"], [139.64, 35.4437, "丙公園"]], [139.638, 35.4437], 3);
t("地点：避難場所は同じ場所の棟違いを 1 件に（全角・半角の空白より前で束ねる）", ns.map(x => x.row[2]).join() === "甲小学校　校舎１,乙中学校 校舎,丙公園" && siteName("横浜市立岡野中学校　校舎７（２階以上）") === "横浜市立岡野中学校");
const ring = circleRing([139.638, 35.4437], 500, 64);
t("徒歩圏：円は閉じ、どの点も中心から半径の距離（±1%）", ring.length === 65 && ring[0][0] === ring[64][0] && ring.every(p => Math.abs(distM([139.638, 35.4437], p) - 500) < 5));
t("徒歩圏：5・10・15 分＝直線 約 308・615・923m", WALK_RINGS.join() === "5,10,15" && Math.round(walkRadius(10)) === 615);
t("徒歩圏：輪ごとの数（内側の輪は外側にも数える・絞り込み）", JSON.stringify(countRings([[139.638, 35.4457, 0], [139.638, 35.4487, 1], [139.638, 35.47, 0]], [139.638, 35.4437])) === "[1,2,2]" && JSON.stringify(countRings([[139.638, 35.4457, 0], [139.638, 35.4487, 1]], [139.638, 35.4437], r => r[2] === 1)) === "[0,1,1]");
t("港の物語：章の id は port- で重複なし・年は昇順・借りる写真は名所にある", new Set(PORT_STORY.map(c => c.id)).size === PORT_STORY.length && PORT_STORY.every((c, i) => c.id === "port-" + c.year && (!i || +c.year > +PORT_STORY[i - 1].year) && (!c.photo || SPOTS.some(s => s.id === c.photo))));
t("港の物語・海の眺め：視点は横浜市の中・地図の域", [...PORT_STORY, ...SEA_VIEWS].every(v => inCity(v.lon, v.lat) && v.zoom >= 12 && v.zoom <= 19 && v.tilt >= 0 && v.tilt <= 75) && PORT_STORY.every(c => WARDS.some(w => w.code === c.ward)));
t("公共施設の種別：どの区分にも 1 つ以上・種別名は重ならない・知らない種別は区分の先頭へ", FACILITY_CATS.every((_, i) => FACILITY_SUBS.some(x => x.cat === i)) && new Set(FACILITY_SUBS.flatMap(x => x.kinds.map(k => x.cat + k))).size === FACILITY_SUBS.reduce((n, x) => n + x.kinds.length, 0) && subOf(5, "交番") === FACILITY_SUBS.findIndex(x => x.name === "Police boxes") && subOf(2, "謎の学校") === FACILITY_SUBS.findIndex(x => x.cat === 2));
t("用途地域：13 種・正式名と色は重ならない／区域：id とファイルは重ならない", ZONES.length === 13 && new Set(ZONES.map(z => z.ja)).size === 13 && new Set(ZONES.map(z => z.color)).size === 13 && ZONES.every(z => /地域$/.test(z.ja)) && new Set(AREAS.map(a => a.id)).size === AREAS.length && new Set(AREAS.map(a => a.file)).size === AREAS.length);
t("覆いの外枠：市の中の視野は内側・球の縁（null）や枠をはみ出す視野は外／地下鉄は全市の眺めで出る", insideBox([139.4, 35.3, 139.8, 35.6], MASK_BOX) && !insideBox(null, MASK_BOX) && !insideBox([138.0, 35.3, 139.8, 35.6], MASK_BOX) && CITY_VIEW.zoom >= SUBWAY_MIN_ZOOM);
t("建物：LOD1 を出すズームの下限は地区の平面（区の zoom）より上・LOD1 の区の名所はその下限以上で寄る（ツアーで建物が出ない名所を作らない）", BUILDINGS_MIN_ZOOM > Math.max(...WARDS.map(w => w.zoom)) && BUILDINGS_MIN_ZOOM >= 15 && BUILDINGS_MIN_ZOOM <= 18 && SPOTS.filter(s => LOD1_WARDS.some(w => w.code === s.ward)).every(s => s.zoom >= BUILDINGS_MIN_ZOOM), SPOTS.filter(s => LOD1_WARDS.some(w => w.code === s.ward) && s.zoom < BUILDINGS_MIN_ZOOM).map(s => s.id).join());
{	// わが家のまわり：点の内外（穴・MultiPolygon）と、点を含む地物の properties
	const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
	const donut = { type: "Polygon", coordinates: [sq(0, 0, 10, 10), sq(4, 4, 6, 6)] }, multi = { type: "MultiPolygon", coordinates: [[sq(0, 0, 1, 1)], [sq(5, 5, 6, 6)]] };
	const fc = { features: [{ geometry: donut, properties: { n: "A" } }, { geometry: multi, properties: { n: "B" } }] };
	t("わが家のまわり：面の内外（穴は外・MultiPolygon の 2 つ目も中）・含む地物", inGeometry(donut, [1, 1]) && !inGeometry(donut, [5, 5]) && !inGeometry(donut, [11, 5]) && inGeometry(multi, [5.5, 5.5]) && !inGeometry(null, [0, 0])
		&& featureAt(fc, [2, 2])?.n === "A" && featureAt(fc, [5.5, 5.5])?.n === "B" && featureAt(fc, [20, 20]) === null && featureAt(null, [0, 0]) === null);
	t("大きな病院：11 院・台帳の長い名から短い名・ほかの病院は null", MAJOR_HOSPITALS.length === 11
		&& majorHospital("社会福祉法人恩賜財団済生会支部神奈川県済生会横浜市南部病院") === "済生会横浜市南部病院" && majorHospital("昭和大学横浜市北部病院") === "昭和医科大学横浜市北部病院"
		&& majorHospital("公立大学法人 横浜市立大学附属市民総合医療センター") === "横浜市立大学附属市民総合医療センター" && majorHospital("横浜市立大学附属病院") === "横浜市立大学附属病院" && majorHospital("鶴見大学歯学部附属病院") === null);
	t("休日急患診療所：18 区すべて（住所は区の名で始まる・電話は 045-）・青葉区だけ昼休み・夜間急病センター 3 か所は市内", WARDS.every(w => HOLIDAY_CLINICS[w.code]?.addr.startsWith(w.name) && /^045-\d{3}-\d{4}$/.test(HOLIDAY_CLINICS[w.code].tel))
		&& Object.keys(HOLIDAY_CLINICS).length === 18 && clinicHours("14117") !== clinicHours("14109") && NIGHT_CENTERS.length === 3 && NIGHT_CENTERS.every(c => (c.lon > CITY_BBOX[0] && c.lon < CITY_BBOX[2] && c.lat > CITY_BBOX[1] && c.lat < CITY_BBOX[3])));
}
{
	// 歩ける道：札の種別・詰めて戻す・区画の境で切った線が繋がる・遠回りでも繋がる方を通る・網から遠い行き先は null
	t("歩ける道：札（高速・私道・歩行者お断りは外す・階段は 2）", walkKind({ highway: "footway" }) === 1 && walkKind({ highway: "steps" }) === 2 && walkKind({ highway: "residential" }) === 0
		&& walkKind({ highway: "motorway" }) === -1 && walkKind({ highway: "service", access: "private" }) === -1 && walkKind({ highway: "service", access: "private", foot: "yes" }) === 0 && walkKind({ highway: "primary", foot: "no" }) === -1);
	const q = v => Math.round(v / WALK_Q), cx = 6982, cy = 1777;   // 日吉のあたりの区画
	const A = [139.6401, 35.5501], B = [139.6400 + 0.0002, 35.5501], C = [139.6401, 35.5503], D = [139.6450, 35.5503];
	const lines = [{ kind: 0, pts: [q(A[0]), q(A[1]), q(C[0]), q(C[1])] }, { kind: 1, pts: [q(C[0]), q(C[1]), q(D[0]), q(D[1])] }, { kind: 2, pts: [q(A[0]), q(A[1]), q(B[0]), q(B[1])] }];
	const back = decodeWalk(encodeWalk(lines, cx, cy), cx, cy);
	t("歩ける道：詰めて戻すと同じ", JSON.stringify(back) === JSON.stringify(lines));
	const g = buildWalkGraph(back), h = walkSnap(g, A), r = walkSearch(g, h.i), to = walkTo(g, r, h, D);
	const ab = Math.hypot((B[0] - A[0]) * Math.cos(A[1] * Math.PI / 180), B[1] - A[1]) * 111195;
	t("歩ける道：網（同じ座標は 1 点）・道のり・道順・階段は 1.5 倍・遠い行き先は null", g.x.length === 4 && to && Math.abs(to.m - (22.2 + 444)) < 15
		&& walkPath(g, r.prev, to.i, A, D).length === 5 && Math.abs(r.dist[walkSnap(g, B).i] - ab * 1.5) < 1 && walkTo(g, r, h, [139.70, 35.60]) === null
		&& walkCells([139.645, 35.555], 2500).length >= 9 && walkCells([139.645, 35.555], 2500).includes(`${cx}_${cy}`));
}
{
	// 施設の英語：ローマ字（長音は書かない・オオは残す・促音）・種類の語の英訳・住所（横浜市は書かない）
	const E = makeEn({ towns: [["日吉台", "ヒヨシダイ"], ["菊名", "キクナ"], ["菅田町", "スゲタチョウ"], ["下田町", "シモダチョウ"]], wards: WARDS.map(w => [w.name.replace(/区$/, ""), w.en.replace(/-ku$/, "")]), tokenize: null });
	t("施設の英語：ローマ字・名前・住所", romaji("カミオオオカ") === "kamiooka" && romaji("コウホク") === "kohoku" && romaji("ニッパ") === "nippa" && romaji("シンヨコハマ") === "shinyokohama"
		&& E.name("横浜市立日吉台小学校", 2) === "Hiyoshidai Elementary School" && E.name("横浜市港北図書館", 3) === "Kohoku Library" && E.name("横浜市消防局神奈川消防署菅田消防出張所", 4) === "Sugeta Fire Station Branch"
		&& E.name("港北警察署下田町交番", 5) === "Shimodacho Police Box" && E.name("医療法人社団◯◯会 港北病院", 6) === "Kohoku Hospital" && E.name("横浜市立市民病院", 6) === "Yokohama Municipal Citizen's Hospital"
		&& E.addr("横浜市港北区菊名7-8-27", "Kohoku-ku") === "7-8-27 Kikuna, Kohoku-ku" && E.addr("横浜市港北区菊名七丁目8番27号", "Kohoku-ku") === "7-8-27 Kikuna, Kohoku-ku"
		&& E.name("鶴見駅西口行政サービスコーナー", 7) === "Tsurumi Station West Exit Administrative Service Corner" && E.name("日本新聞博物館（ニュースパーク）", 3) === "Japan Newspaper Museum (Newspark)"
		&& E.name("南高等学校附属中学校", 2) === "Minami High School Affiliated Junior High School" && E.name("神奈川県社会福祉会館", 7) === "Kanagawa Social Welfare Hall" && E.name("日下小学校", 2) === "Kusaka Elementary School"
		&& E.name("横浜市立盲特別支援学校", 2) === "Yokohama School for the Blind" && E.name("南が丘中学校", 2) === "Minamigaoka Junior High School" && E.name("在横浜ブルガリア共和国名誉領事館", 7) === "Honorary Consulate of Bulgaria in Yokohama"
		&& E.stop("鶴見駅西口") === "Tsurumi Station West Exit" && E.stop("菊名小学校前") === "Kikuna Elementary School-mae" && E.station("新横浜") === "Shin-Yokohama" && E.shelter("横浜市立日吉台小学校　校舎２８（３階以上）") === "Hiyoshidai Elementary School, Building 28 (3rd floor and above)" && E.shelter("日吉台小学校 体育館２－２") === "Hiyoshidai Elementary School, Gymnasium 2-2" && E.shelter("日吉台小学校　校舎１（２階以上）（※洪水は計画規模）") === "Hiyoshidai Elementary School, Building 1 (2nd floor and above; planned-scale flood)"
		&& railLinesEn("京浜急行電鉄 本線・横浜市 1号線・横浜市 3号線") === "Keikyu Main Line・Blue Line"
		&& WARDS.every(w => HOLIDAY_CLINICS[w.code].en.endsWith(w.en)) && NIGHT_CENTERS.every(c => c.enName && c.en));
}
console.log(`\n${ng ? "✗" : "✓"} yokohama: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
