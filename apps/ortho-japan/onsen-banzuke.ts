// 温泉番付を SVG 文字列で返す（日本の温泉 /japan/onsen 用・外への依存なし＝ブラウザでも Node でも動く）
//   import { 温泉番付, 現代番付 } from "./onsen-banzuke.ts";
//   const svg = 温泉番付();                                   // 現代の番付（既定）
//   const svg = 温泉番付({ 東: [...], 西: [...], 行司: [...] }); // 一部だけ差し替え（渡さない所は 現代番付 のまま）
// 一湯は「県:温泉名」の文字列か [県, 温泉名] の配列。段は東西それぞれ 4 段へ自動で割る（42 湯＝10・10・11・11）。
// 名の長さはまちまちでよい：県名（小さめ）を上に、温泉名を段の下端へ揃え、余れば散らし、足りなければ縦だけ詰める（長体）。
// 焼いた SVG＝public/onsen-banzuke.svg（scripts/onsen-banzuke.mjs）。江戸の番付（諸國温泉効能鑑の原本どおり）は public/onsen-banzuke-edo.svg＝手で詰めた一枚もの。

export type 一湯 = string | [string, string];
export interface 番付 {
	表題: string;
	表題の向き?: "ltr" | "rtl";   // 上の横書きの向き。既定 rtl（江戸の番付どおり右から左）
	御覧: string;
	三役: string[];
	東: 一湯[];
	西: 一湯[];
	段割: number[] | null;
	行司: 一湯[];
	勧進元: 一湯;
	差添人: 一湯;
}

export const 現代番付: 番付 = {
	表題: "日本温泉効能鑑",   // 上の横書き
	表題の向き: "ltr",         // 現代の番付は左から右へ
	御覧: "爲御覧",           // 中央の大きな縦書き
	三役: ["横綱", "大関", "関脇", "小結"],   // この後は「前頭」
	東: [
		"群馬:草津温泉", "神奈川:箱根温泉郷", "北海道:登別温泉", "静岡:熱海温泉", "群馬:伊香保温泉", "栃木:鬼怒川温泉", "北海道:定山渓温泉",
		"宮城:秋保温泉", "宮城:鳴子温泉", "長野:野沢温泉", "秋田:乳頭温泉郷", "群馬:万座温泉", "山形:銀山温泉", "新潟:月岡温泉",
		"北海道:十勝川温泉", "栃木:那須湯本温泉", "山形:蔵王温泉", "北海道:湯の川温泉", "群馬:四万温泉", "長野:湯田中渋温泉郷", "長野:白骨温泉",
		"静岡:伊東温泉", "北海道:洞爺湖温泉", "栃木:日光湯元温泉", "神奈川:湯河原温泉", "静岡:修善寺温泉", "北海道:阿寒湖温泉", "山梨:石和温泉",
		"岩手:花巻温泉", "福島:会津東山温泉", "静岡:稲取温泉", "北海道:支笏湖温泉", "長野:昼神温泉", "山形:小野川温泉", "福島:高湯温泉",
		"神奈川:七沢温泉", "山梨:富士河口湖温泉郷", "静岡:伊豆長岡温泉", "北海道:川湯温泉", "静岡:下田温泉", "群馬:水上温泉", "新潟:越後湯沢温泉"],
	西: [
		"大分:別府温泉郷", "兵庫:有馬温泉", "兵庫:城崎温泉", "岐阜:下呂温泉", "愛媛:道後温泉", "大分:由布院温泉", "熊本:黒川温泉",
		"石川:和倉温泉", "和歌山:白浜温泉", "石川:加賀温泉郷", "兵庫:神戸みなと温泉", "岐阜:奥飛騨温泉郷", "島根:玉造温泉", "佐賀:嬉野温泉",
		"鹿児島:指宿温泉", "山口:油谷湾温泉", "福井:あわら温泉", "大分:奥湯布院温泉", "鳥取:三朝温泉", "鳥取:皆生温泉", "熊本:平山温泉",
		"鹿児島:南霧島温泉", "長崎:雲仙温泉", "大分:長湯温泉", "岡山:湯原温泉郷", "和歌山:南紀勝浦温泉", "山口:湯田温泉", "兵庫:湯村温泉",
		"三重:榊原温泉", "兵庫:洲本温泉", "三重:長島温泉", "富山:宇奈月温泉", "大分:湯平温泉", "和歌山:龍神温泉", "愛知:西浦温泉",
		"福岡:原鶴温泉", "山口:長門湯本温泉", "京都:天橋立温泉", "奈良:洞川温泉", "岐阜:下島温泉", "長崎:小浜温泉", "熊本:阿蘇内牧温泉"],
	段割: null,   // 例 [10, 10, 11, 11]（東西共通）。null＝湯の数から自動
	行司: ["和歌山:龍神の湯", "静岡:熱海の湯", "群馬:沢渡の湯", "青森:大鰐の湯"],   // 右から左へ
	勧進元: "和歌山熊野:本宮の湯",
	差添人: "和歌山熊野:新宮の湯",
};

const W = 77, PAD = 1.5;   // 東西それぞれの欄の幅・罫線からの余白
const 段の罫 = [0, 72, 132, 182, 232];   // 4 段の上下の罫線（y）
const 段の字 = [7, 6.5, 6, 6];            // 段ごとの温泉名の字の大きさ（県名はその 0.75 倍）

const num = (v: number): number => +v.toFixed(3);
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const split = (t: 一湯): string[] => Array.isArray(t) ? t : t.split(":");

// 縦一列＝全角 1 字ぶん戻して（dx=-fs）下へ送る（dy）。中心 y0 から step ずつ
const col = (s: string, x: number, y0: number, step: number, fs: number): string => {
	const n = [...s].length, dx = ["0", ...Array(n - 1).fill(num(-fs))].join(" "), dy = ["0", ...Array(n - 1).fill(num(step))].join(" ");
	return `<text x="${num(x)}" y="${num(y0)}" dx="${dx}" dy="${dy}" font-size="${num(fs)}">${esc(s)}</text>`;
};
// 上端 top から縦だけ k 倍に詰めた一列（長体）
const squeezed = (s: string, x: number, top: number, fs: number, k: number): string => col(s, 0, fs / 2, fs, fs).replace(/^<text x="0"/, `<text transform="translate(${num(x)},${num(top)}) scale(1,${num(k)})" x="0"`);

// 一湯＝[頭の字（役名・「同」）] → 県名 → 温泉名（下端揃え）。top/bottom は字を置ける上端・下端
function 一湯の列(q: string, item: 一湯, x: number, top: number, bottom: number, fn: number, fp: number, head = ""): string {
	const [pref = "", name = ""] = split(item), out: string[] = [];
	let y = top;
	if (head) { out.push(col(head, x, y + fn / 2, fn, fn)); y += [...head].length * fn + 2.5; }
	if (pref) { out.push(col(pref, x, y + fp / 2, fp, fp)); y += [...pref].length * fp + 2; }
	const n = [...name].length, avail = bottom - y;
	if (n * fn > avail) out.push(squeezed(name, x, y, fn, avail / (n * fn)));
	else if (n) {
		const step = n > 1 ? Math.min((avail - fn) / (n - 1), fn * 2.2) : 0;
		out.push(col(name, x, bottom - fn / 2 - (n - 1) * step, step, fn));
	}
	return `<g class="hover" name="${esc(q)}"><title>${esc(q)} ${esc(pref)} ${esc(name)}</title>${out.join("")}</g>`;
}

// n 湯を 4 段へ＝余りは下の段から 1 つずつ足す（42＝10・10・11・11）
const 自動段割 = (n: number): number[] => [0, 1, 2, 3].map(k => Math.floor(n / 4) + (k >= 4 - n % 4 ? 1 : 0));

export function 温泉番付(opt: Partial<番付> = {}): string {
	const o: 番付 = { ...現代番付, ...opt };
	const 役 = (i: number): string => o.三役[i] || "前頭" + (i - o.三役.length + 1);
	const 役名 = (i: number): string => o.三役[i] || "前頭";
	const sides = ([["東", o.東, "E"], ["西", o.西, "W"]] as const).map(([side, list, key]) => {
		const 割 = o.段割 || 自動段割(list.length);
		if (割.length != 4 || 割.reduce((a, b) => a + b, 0) != list.length) throw new Error(`${side}: 段割 ${割} が ${list.length} 湯と合わない`);
		let a = 0;
		return 割.map((n, k) => {
			const gap = W / n, top = 段の罫[k] + PAD, bottom = 段の罫[k + 1] - PAD, fn = 段の字[k];
			// 東＝左端が罫線 14 に揃う・西＝右端が中央の罫線 -14 に揃う（列は右から左へ）
			const T = side == "東" ? 14 + (n - 1) * gap : -14 - gap;
			const body = list.slice(a, a + n).map((item, j) => {
				const i = a + j, head = k == 0 ? 役名(i) : k == 1 ? "同" : "";
				return "\n\t\t" + 一湯の列(side + 役(i), item, (0.5 - j) * gap, top, bottom, fn, fn * 0.75, head);
			}).join("");
			a += n;
			return `\t<g name="${key}${k + 1}" transform="translate(${num(T)},0)">${body}\n\t</g>`;
		}).join("\n");
	});
	// 表題＝横書き（1 字ずつ置く）。rtl＝右から左へ・ltr＝左から右へ
	const t = [...o.表題], tstep = t.length > 1 ? Math.min(26, 156 / (t.length - 1)) : 0, tdir = o.表題の向き === "ltr" ? -1 : 1;
	const 表題 = t.map((c, i) => `<text x="${num(tdir * ((t.length - 1) / 2 * tstep - i * tstep))}" y="-10" font-size="17">${esc(c)}</text>`).join("");
	// 御覧＝中央の縦書き（3 字で字 20・送り 21＝旧版どおり）
	const g = [...o.御覧], gfs = Math.min(20, 63 / g.length);
	const 御覧 = col(o.御覧, 0, 2 + gfs / 2, gfs * 1.05, gfs);
	// 行司＝右から左へ並ぶ列・勧進元（右）と差添人（左）
	const lgap = 6.66, ln = o.行司.length;
	const 行司 = o.行司.map((item, i) => 一湯の列("行司" + (i + 1), item, ((ln - 1) / 2 - i) * lgap, 89, 136, 6.5, 6)).join("\n\t");
	const 勧進元 = 一湯の列("勧進元", o.勧進元, 7, 167, 230.5, 8, 6);
	const 差添人 = 一湯の列("差添人", o.差添人, -7, 167, 230.5, 8, 6);
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-95 -23 190 258" height="100%" style="height:100%;margin:0 auto;display:block;">
<style type="text/css">.hover:hover {fill:#a00; cursor:pointer; stroke:#000; stroke-width:0.2}</style>
<rect x="-95" y="-23" width="190" height="258" fill="#eec"/>
<g dominant-baseline="central" text-anchor="middle" font-family="游教科書体, YuKyokasho, 'Hiragino Mincho ProN', 'Yu Mincho', serif" font-weight="900" fill="#444">
	${表題}
	${御覧}
	<text x="0" y ="72" dx="0 -8" dy="0 8" font-size="8">行司</text>
	<text x="7" y ="136" dx="0 -8 -8" dy="8 8 8" font-size="8">勧進元</text>
	<text x="-7" y ="136" dx="0 -8 -8" dy="8 8 8" font-size="8">差添人</text>
	${行司}
	${勧進元}
	${差添人}
${sides.join("\n")}
</g>
<path d="M-91-19h182v18h-182zM14 0V232zM14 72H92zM14 132H92zzM14 182H92zM-14 0V232zM-14 72H-92zM-14 132H-92zzM-14 182H-92zM-14 138h28zM-14 66h28z" fill="none" stroke="#aaa" stroke-width="0.2"/>
<rect x="-92" y="-20" width="184" height="20" fill="none" stroke="#444" stroke-width="1"/>
<rect x="-92" y="0" width="184" height="232" fill="none" stroke="#444" stroke-width="1"/>
</svg>
`;
}

// ── 番付の名 → 台帳（ortho-data/japan/onsen.json）の温泉 ─────────────────────────
// 頁（onsen.ts）は SVG の name（"東横綱"・"西前頭12"・"行司1"・"勧進元"…）から「県:台帳の名」を引き、台帳の県と名で温泉を当てる。null＝比定できない（押しても地図は動かない）。

// 現代の番付で、番付の書き方と台帳の名が違う物（無い物は番付の名のまま台帳を引く）
export const 現代の読み替え: Record<string, string | null> = {
	"神奈川:箱根温泉郷": "神奈川:箱根温泉", "大分:別府温泉郷": "大分:別府温泉", "岡山:湯原温泉郷": "岡山:湯原温泉",
	"栃木:那須湯本温泉": "栃木:那須温泉郷",
	"福島:会津東山温泉": "福島:東山温泉",
	"和歌山:白浜温泉": "和歌山:南紀白浜温泉",
	"福井:あわら温泉": "福井:芦原温泉",
	"大分:奥湯布院温泉": "大分:湯布院温泉郷",
	"鹿児島:南霧島温泉": "鹿児島:新川渓谷温泉郷",   // new-banduke.js（本人の突合）の読み替え
	"兵庫:神戸みなと温泉": null,                      // 台帳に無い（街なかの日帰り施設）
	"和歌山熊野:本宮の湯": "和歌山:湯の峰温泉",       // 熊野本宮の湯＝湯の峰
	"和歌山熊野:新宮の湯": null,
	"和歌山:龍神の湯": "和歌山:龍神温泉", "静岡:熱海の湯": "静岡:熱海温泉", "群馬:沢渡の湯": "群馬:沢渡温泉", "青森:大鰐の湯": "青森:大鰐温泉",
};

// 江戸の番付（諸國温泉効能鑑・public/onsen-banzuke-edo.svg）の比定＝番付の並び順（東西とも大関から 45 湯）。旧国名・旧名から今の温泉へ。
// 確かでない物は null（不明）。台帳に個別の記事が無い箱根の湯（湯本・木賀・塔ノ沢）は箱根温泉（郷）へ。
const 江戸東: (string | null)[] = [
	"群馬:草津温泉", "栃木:那須温泉郷", "長野:上諏訪温泉", "神奈川:湯河原温泉", "神奈川:芦之湯温泉", "福島:岳温泉", "群馬:伊香保温泉"/* 湯川尾 */, "宮城:鳴子温泉"/* 成子 */, "山形:蔵王温泉"/* 最上高湯 */, "東京:鶴の湯温泉"/* 小河内 */,
	"青森:嶽温泉", "神奈川:箱根温泉"/* 湯本 */, null/* 豆刕小名 */, "長野:渋温泉", "福島:東山温泉"/* 天寧寺の湯 */, "新潟:松之山温泉", "青森:恐山温泉", "山形:湯田川温泉", "福島:いわき湯本温泉", "山形:赤湯温泉", "栃木:日光湯元温泉"/* 中禅寺の麓 */,
	"秋田:大滝温泉", "福島:飯坂温泉", null/* 南部鹿角 */, "神奈川:姥子温泉", "静岡:修善寺温泉", "宮城:川渡温泉", "山形:あつみ温泉", "青森:温湯温泉", null/* 米沢湯澤 */, "静岡:伊豆山温泉"/* 走湯権現 */, "福島:熱塩温泉", "神奈川:箱根温泉"/* 木賀 */,
	"栃木:塩原温泉郷", "山形:湯野浜温泉", "青森:板留温泉", "長野:別所温泉", "新潟:関温泉", "岩手:台温泉", null/* 伊達湯ノ村 */, "山形:銀山温泉", "宮城:鎌先温泉", null/* 会津滝の湯 */, null/* 米沢谷沢 */, null/* 南部麻水 */];
const 江戸西: (string | null)[] = [
	"兵庫:有馬温泉", "兵庫:城崎温泉", "愛媛:道後温泉", "石川:山中温泉", null/* 肥後阿蘇 */, "大分:浜脇温泉", "長崎:雲仙温泉"/* 温泉＝うんぜん */, "鹿児島:霧島温泉郷", "大分:別府温泉", "熊本:山鹿温泉"/* 山家 */,
	"岐阜:下呂温泉"/* 下良 */, "熊本:日奈久温泉", null/* 能刕底倉 */, null/* 備中長府 */, null/* 薩摩硫黄 */, null/* 紀刕田辺 */, null/* 但馬湯川原 */, null/* 藝刕川治 */, null/* 紀刕大ぜち */, null/* 加刕白山 */, null/* 伯刕徒見 */,
	null/* 薩摩桜島 */, "佐賀:武雄温泉"/* 竹尾 */, null/* 石刕川村 */, "山口:湯田温泉"/* 周防山口 */, null/* 肥前うるし */, null/* 越中足倉 */, null/* 越後塩沢 */, "神奈川:箱根温泉"/* 塔ノ沢 */, "秋田:小安峡温泉"/* おやす */, null/* 薩摩関外 */, "神奈川:宮ノ下温泉", "秋田:矢立温泉",
	null/* 信刕湯瀬 */, "神奈川:堂ヶ島温泉", "青森:浅虫温泉", "宮城:秋保温泉", "新潟:出湯温泉", "山形:上山温泉", "長野:浅間温泉", "神奈川:底倉温泉", "群馬:老神温泉", "新潟:湯田上温泉", null/* 津軽倉立 */, null/* 能刕足の湯 */];
const 江戸の中央: Record<string, string | null> = { 行司1: "和歌山:龍神温泉", 行司2: "静岡:熱海温泉", 行司3: "群馬:沢渡温泉", 行司4: "青森:大鰐温泉", 勧進元: "和歌山:湯の峰温泉", 差添: null };

// 役の名（"東大関"・"西前頭12"）→ 並びの番号。三役の後が 前頭1
const 役の番号 = (役: string, 三役: string[]): number => { const i = 三役.indexOf(役); if (i >= 0) return i; const m = /^前頭(\d+)$/.exec(役); return m ? 三役.length + +m[1] - 1 : -1; };

// 番付の SVG の name → 「県:台帳の名」（null＝不明・undefined＝番付に無い name）
export function 番付の比定(版: "現代" | "江戸", name: string, 番付: 番付 = 現代番付): string | null | undefined {
	if (版 === "江戸") {
		if (name in 江戸の中央) return 江戸の中央[name];
		const side = name[0] === "東" ? 江戸東 : name[0] === "西" ? 江戸西 : null, i = 役の番号(name.slice(1), ["大関", "関脇", "小結"]);
		return side && i >= 0 && i < side.length ? side[i] : undefined;
	}
	const pick = (v: 一湯 | undefined): string | null | undefined => { if (v == null) return undefined; const s = split(v).join(":"); return s in 現代の読み替え ? 現代の読み替え[s] : s; };
	const m = /^行司(\d+)$/.exec(name);
	if (m) return pick(番付.行司[+m[1] - 1]);
	if (name === "勧進元" || name === "差添人") return pick(番付[name]);
	const side = name[0] === "東" ? 番付.東 : name[0] === "西" ? 番付.西 : null;
	return side ? pick(side[役の番号(name.slice(1), 番付.三役)]) : undefined;
}
