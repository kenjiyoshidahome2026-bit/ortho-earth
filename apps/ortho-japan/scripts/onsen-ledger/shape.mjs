import fs from "node:fs";
// 台帳の工程が共に使う小道具（ledger-build.mjs・ledger-list.mjs）：CSV の読み・よみ → ローマ字・温泉郷の面

// ── CSV（BOM 付き・引用符の中の改行と "" に対応）──
export function readCsv(file) {
	const s = fs.readFileSync(file, "utf8").replace(/^﻿/, ""), rows = []; let row = [], f = "", q = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (q) { if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
		if (ch === '"') q = true; else if (ch === ",") { row.push(f); f = ""; } else if (ch === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (ch !== "\r") f += ch;
	}
	if (f || row.length) { row.push(f); rows.push(row); }
	const head = rows.shift();
	return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ""])));
}

// ── ひらがな → ローマ字（ヘボン式・長音は書かない＝道路標識の書き方：どうご→Dogo・ゆうふいん→Yufuin）──
const KANA = { あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko", さ: "sa", し: "shi", す: "su", せ: "se", そ: "so", た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
	な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho", ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo",
	ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", ゐ: "i", ゑ: "e", を: "o", ん: "n", が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
	だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do", ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo", ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", ゔ: "vu",
	ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o" };
const YOON = { ゃ: "a", ゅ: "u", ょ: "o" };
export function romaji(kana) {
	let out = "";
	for (let i = 0; i < kana.length; i++) {
		const c = kana[i], nx = kana[i + 1];
		if (c === "っ") { const r = KANA[nx] || ""; out += r.startsWith("ch") ? "t" : r[0] || ""; continue; }
		if (c === "ー") continue;
		let r = KANA[c]; if (r == null) { out += c; continue; }
		if (YOON[nx] && /i$/.test(r)) { const b = r.slice(0, -1); r = (/^(sh|ch|j)$/.test(b) ? b : b + "y") + YOON[nx]; i++; }
		out += r;
	}
	return out.replace(/ou/g, "o").replace(/oo/g, "o").replace(/uu/g, "u");   // 長音を落とす
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
// 「くさつおんせん」→ Kusatsu Onsen・「ゆだなかしぶおんせんきょう」→ Yudanakashibu Onsenkyo。よみが無ければ空
export function enFromReading(r) {
	if (!r) return "";
	const m = r.match(/^(.*?)(おんせん|こうせん)(きょう|ぐん|ごう)?$/);
	if (!m) return cap(romaji(r));
	const head = m[1] ? cap(romaji(m[1])) + " " : "";
	return head + (m[2] === "おんせん" ? "Onsen" : "Kosen") + (m[3] ? romaji(m[3]) : "");
}

function hull(P) {   // 単調鎖の凸包（反時計回り・閉じる）
	const pts = [...new Map(P.map(p => [p.join(), p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (pts.length < 3) return null;
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
	for (const p of pts) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
	for (const p of pts.slice().reverse()) { while (up.length >= 2 && cross(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); }
	const ring = [...lo.slice(0, -1), ...up.slice(0, -1)]; ring.push(ring[0]); return ring;
}
// 郷の面＝郷の座標と構成する温泉の点を BUF km 太らせた凸包（items の郷の poly を書き換える）
const BUF = 1.5;   // km
export function kyoPolys(items) {
	for (const g of items.filter(d => d.k === "g")) {
		const pts = [g.c, ...items.filter(d => d.par?.includes(g.id)).map(d => d.c)], ring = [];
		for (const [lon, lat] of pts) for (let i = 0; i < 16; i++) { const a = 2 * Math.PI * i / 16; ring.push([lon + Math.cos(a) * BUF / (111.32 * Math.cos(lat * Math.PI / 180)), lat + Math.sin(a) * BUF / 110.57]); }
		const h = hull(ring); if (h) g.poly = h.map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]);
	}
}
