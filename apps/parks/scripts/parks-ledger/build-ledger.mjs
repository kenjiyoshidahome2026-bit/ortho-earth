// 国立公園の台帳 parks.json を書く（2026-10-18 に build-ledger.py から移植）：node build-ledger.mjs
// 入力＝parks-raw.json（fetch-parks.mjs）・prefs-labels.json・parks-boundary.geojson（dissolve.mjs）。公式値は下の OFF 表が正（README の ⚠）。
// parks-boundary.geojson の属性も id を持つ形に書き戻す（そのあと geopbf enc で parks.geopbf）。
import fs from "node:fs";

const read = f => JSON.parse(fs.readFileSync(f, "utf8"));
const raw = read("parks-raw.json"), prefs = read("prefs-labels.json"), bnd = read("parks-boundary.geojson");
const PREF = ",北海道,青森県,岩手県,宮城県,秋田県,山形県,福島県,茨城県,栃木県,群馬県,埼玉県,千葉県,東京都,神奈川県,新潟県,富山県,石川県,福井県,山梨県,長野県,岐阜県,静岡県,愛知県,三重県,滋賀県,京都府,大阪府,兵庫県,奈良県,和歌山県,鳥取県,島根県,岡山県,広島県,山口県,徳島県,香川県,愛媛県,高知県,福岡県,佐賀県,長崎県,熊本県,大分県,宮崎県,鹿児島県,沖縄県".split(",");
const code = n => { const i = PREF.indexOf(n); if (i < 1) throw new Error(`都道府県名が無い: ${n}`); return String(i).padStart(2, "0"); };
// 公式値（環境省 国立公園一覧・2024）：id, 名称(nps_all), 地方, 陸域面積ha, 指定日, 都道府県, 環境省の頁の名前（env.go.jp/park/<名前>/）
const OFF = [
	["rishiri-rebun-sarobetsu", "利尻礼文サロベツ", "hokkaido", 24512, "1974-09-20", ["北海道"], "rishiri"],
	["shiretoko", "知床", "hokkaido", 38954, "1964-06-01", ["北海道"], "shiretoko"],
	["akan-mashu", "阿寒摩周", "hokkaido", 91413, "1934-12-04", ["北海道"], "akan"],
	["kushiro-shitsugen", "釧路湿原", "hokkaido", 28788, "1987-07-31", ["北海道"], "kushiro"],
	["daisetsuzan", "大雪山", "hokkaido", 226764, "1934-12-04", ["北海道"], "daisetsu"],
	["shikotsu-toya", "支笏洞爺", "hokkaido", 99473, "1949-05-16", ["北海道"], "shikotsu"],
	["hidaka", "日高山脈襟裳十勝", "hokkaido", 245668, "2024-06-25", ["北海道"], "hidaka"],
	["towada-hachimantai", "十和田八幡平", "tohoku", 85551, "1936-02-01", ["青森県", "岩手県", "秋田県"], "towada"],
	["sanriku-fukko", "三陸復興", "tohoku", 28539, "2013-05-24", ["青森県", "岩手県", "宮城県"], "sanriku"],
	["bandai-asahi", "磐梯朝日", "tohoku", 186389, "1950-09-05", ["山形県", "福島県", "新潟県"], "bandai"],
	["nikko", "日光", "kanto", 114908, "1934-12-04", ["福島県", "栃木県", "群馬県"], "nikko"],
	["oze", "尾瀬", "kanto", 37222, "2007-08-30", ["福島県", "栃木県", "群馬県", "新潟県"], "oze"],
	["joshinetsu-kogen", "上信越高原", "chubu", 148194, "1949-09-07", ["群馬県", "新潟県", "長野県"], "joshinetsu"],
	["chichibu-tama-kai", "秩父多摩甲斐", "kanto", 126259, "1950-07-10", ["埼玉県", "東京都", "山梨県", "長野県"], "chichibu"],
	["ogasawara", "小笠原", "kanto", 6629, "1972-10-16", ["東京都"], "ogasawara"],
	["fuji-hakone-izu", "富士箱根伊豆", "kanto", 121749, "1936-02-01", ["東京都", "神奈川県", "山梨県", "静岡県"], "fujihakone"],
	["chubu-sangaku", "中部山岳", "chubu", 174323, "1934-12-04", ["新潟県", "富山県", "長野県", "岐阜県"], "chubu"],
	["myoko-togakushi", "妙高戸隠連山", "chubu", 39772, "2015-03-27", ["新潟県", "長野県"], "myokotogakushi"],
	["hakusan", "白山", "chubu", 49900, "1962-11-12", ["富山県", "石川県", "福井県", "岐阜県"], "hakusan"],
	["minami-alps", "南アルプス", "chubu", 35752, "1964-06-01", ["山梨県", "長野県", "静岡県"], "minamialps"],
	["ise-shima", "伊勢志摩", "chubu", 55544, "1946-11-20", ["三重県"], "iseshima"],
	["yoshino-kumano", "吉野熊野", "kinki", 61406, "1936-02-01", ["三重県", "奈良県", "和歌山県"], "yoshino"],
	["sanin-kaigan", "山陰海岸", "kinki", 8783, "1963-07-15", ["京都府", "兵庫県", "鳥取県"], "sanin"],
	["setonaikai", "瀬戸内海", "kinki", 67308, "1934-03-16", ["大阪府", "兵庫県", "和歌山県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "福岡県", "大分県"], "setonaikai"],
	["daisen-oki", "大山隠岐", "chugoku-shikoku", 35353, "1936-02-01", ["鳥取県", "島根県", "岡山県"], "daisen"],
	["ashizuri-uwakai", "足摺宇和海", "chugoku-shikoku", 11345, "1972-11-10", ["愛媛県", "高知県"], "ashizuri"],
	["saikai", "西海", "kyushu-okinawa", 24646, "1955-03-16", ["長崎県"], "saikai"],
	["unzen-amakusa", "雲仙天草", "kyushu-okinawa", 28279, "1934-03-16", ["長崎県", "熊本県", "鹿児島県"], "unzen"],
	["aso-kuju", "阿蘇くじゅう", "kyushu-okinawa", 73017, "1934-12-04", ["熊本県", "大分県"], "aso"],
	["kirishima-kinkowan", "霧島錦江湾", "kyushu-okinawa", 36605, "1934-03-16", ["宮崎県", "鹿児島県"], "kirishima"],
	["yakushima", "屋久島", "kyushu-okinawa", 24566, "2012-03-16", ["鹿児島県"], "yakushima"],
	["amami-gunto", "奄美群島", "kyushu-okinawa", 42196, "2017-03-07", ["鹿児島県"], "amami"],
	["yanbaru", "やんばる", "kyushu-okinawa", 17352, "2016-09-15", ["沖縄県"], "yambaru"],
	["kerama", "慶良間諸島", "kyushu-okinawa", 3520, "2014-03-05", ["沖縄県"], "kerama"],
	["iriomote-ishigaki", "西表石垣", "kyushu-okinawa", 40653, "1972-05-15", ["沖縄県"], "iriomote"],
];
const byja = Object.fromEntries(raw.map(p => [p.name.ja.replace("国立公園", ""), p]));
const bb = {};
const walk = (c, b) => {
	if (typeof c[0] === "number") { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); }
	else for (const x of c) walk(x, b);
};
for (const f of bnd.features) { const b = [1e9, 1e9, -1e9, -1e9]; walk(f.geometry.coordinates, b); bb[f.properties.name] = b.map(x => Number(x.toFixed(4))); }
const out = [], keys = new Set();
for (const [pid, key, region, ha, date, pf, moe] of OFF) {
	const w = byja[key]; keys.add(key);
	const ph = w.photo || null;
	out.push({ id: pid, key, qid: w.qid, region, designated: date, areaHa: ha, prefs: pf.map(code),
		coord: w.coord ?? null, bbox: bb[key], name: w.name, wiki: w.wiki, site: `https://www.env.go.jp/park/${moe}/index.html`, siteEn: `https://www.env.go.jp/en/nature/nps/park/${moe}/index.html`,   // 公式サイトは Wikidata（P856）を使わない＝見どころの頁（/point/）・英語版・観光協会が混じり、無い公園もあった
		photo: ph && Object.keys(ph).length ? { src: ph.thumb ?? null, page: ph.page ?? null, artist: ph.artist ?? null, license: ph.license ?? null, licenseUrl: ph.licenseUrl ?? null } : null });
}
const extra = Object.keys(bb).filter(k => !keys.has(k));
if (extra.length || keys.size !== Object.keys(bb).length) throw new Error(`外周と OFF 表が食い違う: ${extra}`);
// 都道府県名の表（Wikidata ラベル・ja は PREF の正本）
const pt = Object.fromEntries(Object.entries(prefs).map(([c, v]) => [c, { ...v, ja: PREF[+c] }]));
// 外周 GeoPBF の属性も id を持たせる
const idOf = Object.fromEntries(OFF.map(([pid, key]) => [key, pid]));
for (const f of bnd.features) f.properties = { id: idOf[f.properties.name], name: f.properties.name };
fs.writeFileSync("parks-boundary.geojson", JSON.stringify(bnd));
const doc = { _: "日本の国立公園 35 の台帳（parks.html）。名前 26 言語・Wikipedia の頁名＝Wikidata（CC0）／写真＝Wikimedia Commons（各写真の artist/license を表示する義務）／面積（陸域 ha）・指定日・都道府県＝環境省 国立公園一覧（2024）／外周 bbox＝環境省 nps_all（apps/uploader）から zones を溶かした parks.geopbf。生成＝scripts/parks-ledger（scratchpad の fetch-parks.mjs + build-ledger.py を移植したもの）",
	source: { boundary: "環境省 環境ジオポータル 国立公園区域等（nps_all／nps_hokkaido）", facts: "環境省 国立公園一覧", names: "Wikidata", photos: "Wikimedia Commons" },
	prefNames: pt, parks: out };
fs.writeFileSync("parks.json", JSON.stringify(doc, null, 1));
console.log(out.length, "parks", fs.statSync("parks.json").size, "bytes"); console.log(out.filter(p => !p.photo || !p.photo.src).map(p => p.id));
console.log(JSON.stringify(out[6]).slice(0, 600));
