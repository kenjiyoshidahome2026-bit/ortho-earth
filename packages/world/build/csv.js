// 見出し付き CSV（RFC 4180 風・BOM 可）⇄ オブジェクト配列。依存無し＝Node/ブラウザ共用
export function parseCSV(text) {
	const rows = [], s = text.replace(/^﻿/, "");
	let row = [], cell = "", q = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) { if (c == '"') { if (s[i + 1] == '"') { cell += '"'; i++; } else q = false; } else cell += c; }
		else if (c == '"') q = true;
		else if (c == ",") { row.push(cell); cell = ""; }
		else if (c == "\n" || c == "\r") { if (c == "\r" && s[i + 1] == "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
		else cell += c;
	}
	if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
	const head = rows.shift() || [];
	return rows.filter(r => r.some(v => v !== "")).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? "" : r[i]])));
}
export function toCSV(rows, columns) {
	const cols = columns || Object.keys(rows[0] || {});
	const esc = v => { v = v == null ? "" : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
	return [cols.join(",")].concat(rows.map(r => cols.map(c => esc(r[c])).join(","))).join("\n") + "\n";
}
