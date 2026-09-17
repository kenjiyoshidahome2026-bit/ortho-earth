// CSV ドロップ → 国（world の NationDB）へ結合してコロプレス。サーバーなし・ブラウザ内で完結。
// 結合キーは推測する（どの列が国を指すかをユーザーに聞かない＝落とせば塗れる）：
//   全列 × 国の索引（world key・ISO 2/3/数値・IOC・QID のコード＋英語名/正式名/記事名・日本語名/記事名/略称）で一致数を数え、最多の列を採る。
// 値の列は数値として読める値が最多の列（同数は右＝世界銀行 CSV の「データが揃った最新年」）。

// 文字コード：UTF-8（BOM 可）→ だめなら Shift_JIS（e-Stat・Excel 日本語版の CSV）
export function decodeText(buf) {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, ""); }
	catch { return new TextDecoder("shift_jis").decode(buf); }
}

// RFC 4180（引用符・引用符内の改行と区切り）。区切りは先頭行の引用外の出現数で , \t ; から選ぶ
export function parseCSV(text) {
	const head = text.slice(0, text.indexOf("\n") >>> 0 || text.length);
	const count = d => { let n = 0, q = false; for (const ch of head) { if (ch === '"') q = !q; else if (!q && ch === d) n++; } return n; };
	const delim = [",", "\t", ";"].reduce((a, d) => count(d) > count(a) ? d : a, ",");
	const rows = []; let row = [], cell = "", q = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (q) {
			if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
			else cell += ch;
		} else if (ch === '"') q = true;
		else if (ch === delim) { row.push(cell); cell = ""; }
		else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(cell); cell = ""; rows.push(row); row = [];
		} else cell += ch;
	}
	if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
	const out = rows.filter(r => r.some(c => c.trim() !== ""));
	out.delim = delim;
	return out;
}

const norm = s => String(s ?? "").replace(/\0/g, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
	.toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");
// 索引：正規化キー → 国番号（NationDB の並び）。コードを先に・名前は後（同じ綴りならコード優先）・先勝ち
export function buildNationIndex(world) {
	const idx = new Map();
	const add = (k, i) => { if (k && !idx.has(k)) idx.set(k, i); };
	const code = v => { const t = String(v ?? "").trim(); return !t ? "" : /^\d+$/.test(t) ? String(+t) : norm(t); };
	world.items.forEach((n, i) => { add(code(n.key), i); (n.iso || []).forEach(c => add(code(c), i)); add(code(n.ioc), i); add(code(n.qid), i); });
	world.items.forEach((n, i) => {
		const en = n.name?.en;
		add(norm(en), i); add(norm(n.wiki?.en), i);
		if (n.official && en) add(norm(n.official.replace("_", en)), i);   // "People's Republic of _" → 正式名
		const ja = world.ja[n.key];
		if (ja) {
			add(norm(ja.name), i); add(norm(ja.wiki), i);
			const paren = /[(（]([^)）]+)[)）]/.exec(ja.official || "");   // "_(中国)" → 略称「中国」
			if (paren) add(norm(paren[1]), i);
		}
	});
	return idx;
}
const keyOf = v => { const s = String(v ?? "").trim(); return /^\d+$/.test(s) ? String(+s) : norm(s); };

// 数値：";" 区切りの CSV は欧州式（小数点＝カンマ・千の位＝ドット/空白）、それ以外はカンマ＝千の位
const toNum = (v, euro = false) => {
	let s = String(v ?? "").trim().replace(/[\s%]/g, "");
	s = euro ? s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".") : s.replace(/,/g, "");
	if (!s || /^[-–—…x.]+$/i.test(s)) return null;
	const n = Number(s); return Number.isFinite(n) ? n : null;
};

// fidOfRow＝行 → 国番号（-1＝外れ）。→ { name, header, rows, keyCol, fidOfRow, matched, unmatched[], columns:[{i,name,type:"number"|"category",count}], defaultCol }
export function joinCSV(name, text, index) {
	let rows = parseCSV(text);
	const euro = rows.delim === ";";
	if (rows.length < 2) throw new Error("CSV has no data rows");
	// 見出し行：前置きのメタ行（世界銀行 CSV の "Data Source" 等）を飛ばす＝最頻の列数（＝データ行の幅）以上を持つ最初の行
	// （見出しだけ末尾カンマで 1 列多い CSV もある＝「等しい」でなく「以上」）
	const freq = new Map(); rows.slice(0, 50).forEach(r => freq.set(r.length, (freq.get(r.length) || 0) + 1));
	const width = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
	const h = rows.findIndex(r => r.length >= width);
	const header = rows[h].map((c, i) => c.trim() || `column ${i + 1}`);
	rows = rows.slice(h + 1);

	// 結合キー列＝国の索引に最も多く当たる列
	let keyCol = -1, best = 0;
	for (let c = 0; c < header.length; c++) {
		let n = 0; for (const r of rows) if (index.has(keyOf(r[c]))) n++;
		if (n > best) { best = n; keyCol = c; }
	}
	if (keyCol < 0 || best < 2) throw new Error("No column matches country codes or names");   // 2 行当たれば結合列と見なす（小さな検定用 CSV も通す）
	const fidOfRow = rows.map(r => index.has(keyOf(r[keyCol])) ? index.get(keyOf(r[keyCol])) : -1);
	const unmatched = rows.filter((_, i) => fidOfRow[i] < 0).map(r => String(r[keyCol] ?? "").trim()).filter(Boolean);

	const columns = [];
	for (let c = 0; c < header.length; c++) {
		if (c === keyCol) continue;
		const vals = rows.map((r, i) => fidOfRow[i] >= 0 ? r[c] : null).filter(v => v != null && String(v).trim() !== "");
		if (!vals.length) continue;
		const nums = vals.filter(v => toNum(v, euro) != null).length;
		if (nums >= vals.length * 0.7) columns.push({ i: c, name: header[c], type: "number", count: nums });
		else { const cats = new Set(vals.map(v => String(v).trim())); if (cats.size <= 20) columns.push({ i: c, name: header[c], type: "category", count: vals.length }); }
	}
	if (!columns.length) throw new Error("No numeric or categorical value column");
	const numCols = columns.filter(c => c.type === "number");
	const pool = numCols.length ? numCols : columns;
	const defaultCol = pool.reduce((a, c) => c.count >= a.count ? c : a).i;
	return { name, header, rows, euro, keyCol, fidOfRow, matched: rows.length - unmatched.length, unmatched, columns, defaultCol };
}

// 列 → コロプレスの主題（buildChoropleth の opts）。同じ国に複数行が当たれば先勝ち
export function csvPreset(ds, colIndex) {
	const col = ds.columns.find(c => c.i === colIndex) || ds.columns[0];
	const byFid = new Map();
	ds.rows.forEach((r, k) => {
		const fid = ds.fidOfRow[k]; if (fid < 0 || byFid.has(fid)) return;
		const v = col.type === "number" ? toNum(r[col.i], ds.euro) : (String(r[col.i] ?? "").trim() || null);
		if (v != null) byFid.set(fid, v);
	});
	// 数値の分類は値の形で選ぶ：正負をまたぐ→発散（0 が中央）・正で桁が 3 つ以上広い→対数の等間隔・それ以外→分位
	let type = "categorical", scale;
	if (col.type === "number") {
		const vs = [...byFid.values()], lo = Math.min(...vs), hi = Math.max(...vs);
		if (lo < 0 && hi > 0) type = "diverging"; else if (lo > 0 && hi / lo >= 1000) { type = "equal"; scale = "log"; } else type = "quantile";
	}
	return {
		label: col.name, csv: true, column: col.i, type, scale, ramp: "purple",
		value: (_n, i) => byFid.has(i) ? byFid.get(i) : null,
	};
}
