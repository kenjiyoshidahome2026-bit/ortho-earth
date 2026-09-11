// convert/sqlite.js ── 読み専用の SQLite3 ファイルリーダ（依存ゼロ・SQL 無し）。
// GeoPackage を「配布物としてそのまま」ブラウザ/Node で開くために、B-tree のページを歩いて表の行を取り出すだけの最小実装。
// 書き込み・索引・WHERE は持たない（索引は使わず表 B-tree を全走査＝GeoPackage の層を丸ごと読む用途には十分）。
//
//   const db = openSqlite(u8);                 // Uint8Array（ファイル全体）
//   db.tables                                   // Map name → { name, rootpage, sql, columns:[{name,type,pk}], rowidAlias, withoutRowid }
//   for (const row of db.rows("places")) …      // row = { col: value }  value: null | number | bigint | string | Uint8Array
//   db.count("places")                          // 行数（payload を復号せず葉のセル数だけ数える）
//   db.get("tiles", rowid)                      // rowid 直引き（B-tree を鍵で降りる・タイル表のランダムアクセス）
//   db.rowsProjected("tiles", 4)                // 先頭 4 列だけ復号して { rowid, values } を流す（索引作り）
//
// 仕様は https://www.sqlite.org/fileformat.html のとおり：
//   ・100 バイトのヘッダ（ページ長・予約長・文字符号化）／ページ 1 だけ B-tree ヘッダが 100 バイト目から
//   ・表 B-tree の葉（0x0d）セル = 長さ varint・rowid varint・record・[overflow 先頭ページ]／内部（0x05）セル = 左子ページ・鍵
//   ・record = ヘッダ長 varint・serial type の並び・値の並び（NULL / 1〜8 バイト整数 / double / 0・1 / BLOB / TEXT）
//   ・INTEGER PRIMARY KEY の列は record 内が NULL で rowid が値（rowid 別名）
// 対応外（明示して投げる）: WITHOUT ROWID 表・読みかけの WAL（-wal ファイルの未チェックポイント分は見えない＝警告）。

const MAGIC = "SQLite format 3\0";
const SAFE = 2n ** 53n;

export function openSqlite(u8, opts = {}) {
	if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
	for (let i = 0; i < 16; i++) if (u8[i] !== MAGIC.charCodeAt(i)) throw new Error("sqlite: SQLite3 ファイルでない（先頭 16 バイトの署名が違う）");
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	let pageSize = dv.getUint16(16); if (pageSize === 1) pageSize = 65536;
	const reserved = u8[20];
	const usable = pageSize - reserved;
	const enc = dv.getUint32(56);
	const encoding = enc === 2 ? "utf-16le" : enc === 3 ? "utf-16be" : "utf-8";
	const warnings = [];
	if (u8[18] === 2 || u8[19] === 2) warnings.push("WAL モードのファイル＝チェックポイント前の更新（-wal 側）は読めない");
	if (u8.length < pageSize * 2 && dv.getUint32(28) > 1) warnings.push("ファイルがページ数より短い（切れている）");
	return new Db(u8, dv, { pageSize, usable, encoding, warnings }, opts);
}

class Db {
	constructor(u8, dv, h, opts) {
		this.u8 = u8; this.dv = dv; this.pageSize = h.pageSize; this.usable = h.usable; this.encoding = h.encoding; this.warnings = h.warnings;
		this.decoder = new TextDecoder(h.encoding);
		this.tables = new Map();
		this.views = new Map();
		// sqlite_master（root=1・列は固定: type name tbl_name rootpage sql）
		for (const r of this._rows(1, null)) {
			const [type, name, , rootpage, sql] = r.values;
			if (type === "table") this.tables.set(name, { name, rootpage, sql, ...parseCreate(sql) });
			else if (type === "view") this.views.set(name, { name, sql });
		}
	}
	table(name) {
		const t = this.tables.get(name);
		if (!t) throw new Error(`sqlite: 表 "${name}" が無い（表: ${[...this.tables.keys()].join(", ")}）`);
		if (t.withoutRowid) throw new Error(`sqlite: 表 "${name}" は WITHOUT ROWID＝未対応`);
		if (!t.rootpage) throw new Error(`sqlite: 表 "${name}" は仮想表＝実体が無い`);
		return t;
	}
	/** 行を { 列名: 値 } で順に返す（rowid 順）。 */
	*rows(name) {
		const t = this.table(name);
		const cols = t.columns, n = cols.length, alias = t.rowidAlias;
		for (const r of this._rows(t.rootpage, t)) {
			const o = {}, v = r.values;
			for (let i = 0; i < n; i++) o[cols[i].name] = i < v.length ? v[i] : null;   // ALTER TABLE ADD COLUMN 後の短い record は末尾 null
			if (alias >= 0) o[cols[alias].name] = r.rowid;
			yield o;
		}
	}
	/** 先頭 limit 列だけ復号した { rowid, values } を順に返す（タイル表の索引作り＝BLOB 列を触らない）。 */
	*rowsProjected(name, limit) {
		const t = this.table(name);
		yield* this._rows(t.rootpage, t, limit);
	}
	/** rowid 直引き（表 B-tree を鍵で降りる）。無ければ null。 */
	get(name, rowid) {
		const t = this.table(name), { u8, dv } = this, vi = { v: 0, p: 0 };
		let page = t.rootpage;
		for (;;) {
			const base = this._off(page), hdr = base + (page === 1 ? 100 : 0);
			const type = u8[hdr], cells = dv.getUint16(hdr + 3);
			if (type === 0x05) {
				let next = dv.getUint32(hdr + 8);   // 右端の子（全鍵より大きい時）
				let lo = 0, hi = cells;             // 内部セルは鍵昇順＝二分探索で「key >= rowid」の最初のセル
				while (lo < hi) { const mid = (lo + hi) >> 1, c = base + dv.getUint16(hdr + 12 + mid * 2); varint(u8, c + 4, vi); if (vi.v < rowid) lo = mid + 1; else hi = mid; }
				if (lo < cells) next = dv.getUint32(base + dv.getUint16(hdr + 12 + lo * 2));
				page = next; continue;
			}
			if (type !== 0x0d) throw new Error(`sqlite: 表 B-tree に索引ページ（0x${type.toString(16)}）が混ざっている（ページ ${page}）`);
			for (let i = 0; i < cells; i++) {
				let p = base + dv.getUint16(hdr + 8 + i * 2);
				varint(u8, p, vi); const P = vi.v; p = vi.p;
				varint(u8, p, vi); const id = vi.v; p = vi.p;
				if (id === rowid) {
					const o = {}, v = this._record(this._payload(p, P)), cols = t.columns;
					for (let k = 0; k < cols.length; k++) o[cols[k].name] = k < v.length ? v[k] : null;
					if (t.rowidAlias >= 0) o[cols[t.rowidAlias].name] = rowid;
					return o;
				}
				if (id > rowid) return null;
			}
			return null;
		}
	}
	/** 行数＝葉のセル数の合計（record は読まない）。 */
	count(name) {
		const t = this.table(name);
		let n = 0;
		for (const { type, cells } of this._pages(t.rootpage)) if (type === 0x0d) n += cells;
		return n;
	}
	// ── 内部 ─────────────────────────────────────────────────────────────
	_off(page) {
		const o = (page - 1) * this.pageSize;
		if (page < 1 || o + this.pageSize > this.u8.length) throw new Error(`sqlite: ページ ${page} がファイルの外（壊れているか切れている）`);
		return o;
	}
	/** 表 B-tree を rowid 順に歩き、ページ種別とセル数を返す（count 用・葉は復号しない）。 */
	*_pages(root) {
		const stack = [root];
		while (stack.length) {
			const page = stack.pop(), base = this._off(page), hdr = base + (page === 1 ? 100 : 0);
			const type = this.u8[hdr], cells = this.dv.getUint16(hdr + 3);
			yield { type, cells };
			if (type === 0x05) {
				stack.push(this.dv.getUint32(hdr + 8));   // 右端の子（最後に）
				for (let i = cells - 1; i >= 0; i--) stack.push(this.dv.getUint32(base + this.dv.getUint16(hdr + 12 + i * 2)));
			}
		}
	}
	/** 葉セルを { rowid, values[] } で順に返す（limit＝先頭何列まで復号するか・省略で全列）。 */
	*_rows(root, t, limit) {
		const { u8, dv } = this, vi = { v: 0, p: 0 };
		const stack = [root];
		while (stack.length) {
			const page = stack.pop(), base = this._off(page), hdr = base + (page === 1 ? 100 : 0);
			const type = u8[hdr], cells = dv.getUint16(hdr + 3);
			if (type === 0x05) {
				stack.push(dv.getUint32(hdr + 8));
				for (let i = cells - 1; i >= 0; i--) stack.push(dv.getUint32(base + dv.getUint16(hdr + 12 + i * 2)));
				continue;
			}
			if (type !== 0x0d) throw new Error(`sqlite: 表 B-tree に索引ページ（0x${type.toString(16)}）が混ざっている（ページ ${page}）`);
			for (let i = 0; i < cells; i++) {
				let p = base + dv.getUint16(hdr + 8 + i * 2);
				varint(u8, p, vi); const P = vi.v; p = vi.p;
				varint(u8, p, vi); const rowid = vi.v; p = vi.p;
				yield { rowid, values: this._record(this._payload(p, P), limit) };
			}
		}
	}
	/** payload を（overflow を継いで）一続きの Uint8Array にする。ローカルに収まれば subarray（コピー無し）。 */
	_payload(p, P) {
		const U = this.usable, X = U - 35;
		if (P <= X) return this.u8.subarray(p, p + P);
		const M = (((U - 12) * 32 / 255) | 0) - 23, K = M + ((P - M) % (U - 4));
		const local = K <= X ? K : M;
		const out = new Uint8Array(P);
		out.set(this.u8.subarray(p, p + local), 0);
		let done = local, next = this.dv.getUint32(p + local);
		while (done < P) {
			if (!next) throw new Error("sqlite: overflow の鎖が途中で切れている");
			const o = this._off(next);
			const n = Math.min(U - 4, P - done);
			out.set(this.u8.subarray(o + 4, o + 4 + n), done);
			done += n; next = this.dv.getUint32(o);
		}
		return out;
	}
	/** record → 値の配列（limit＝先頭何列で打ち切るか）。 */
	_record(b, limit = Infinity) {
		const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), vi = { v: 0, p: 0 };
		varint(b, 0, vi); const hend = vi.v; let hp = vi.p, p = hend;
		const out = [];
		while (hp < hend && out.length < limit) {
			varint(b, hp, vi); const s = vi.v; hp = vi.p;
			switch (s) {
				case 0: out.push(null); break;
				case 1: out.push(dv.getInt8(p)); p += 1; break;
				case 2: out.push(dv.getInt16(p)); p += 2; break;
				case 3: out.push((dv.getInt8(p) << 16) | dv.getUint16(p + 1)); p += 3; break;
				case 4: out.push(dv.getInt32(p)); p += 4; break;
				case 5: out.push(dv.getInt16(p) * 4294967296 + dv.getUint32(p + 2)); p += 6; break;
				case 6: { const v = dv.getBigInt64(p); out.push(v >= -SAFE && v <= SAFE ? Number(v) : v); p += 8; break; }
				case 7: out.push(dv.getFloat64(p)); p += 8; break;
				case 8: out.push(0); break;
				case 9: out.push(1); break;
				case 10: case 11: throw new Error("sqlite: 予約された serial type " + s);
				default: {
					const n = (s - 12) >> 1;
					if (s & 1) out.push(this.decoder.decode(b.subarray(p, p + n)));
					else out.push(b.slice(p, p + n));
					p += n;
				}
			}
		}
		return out;
	}
}

/** SQLite の varint（最大 9 バイト・big-endian 7 bit・9 バイト目は 8 bit 全部）。out.v は安全整数なら Number、超えれば BigInt。 */
export function varint(u8, p, out) {
	let b = u8[p++];
	if (!(b & 0x80)) { out.v = b; out.p = p; return; }
	let v = b & 0x7f;
	for (let i = 1; i < 7; i++) {           // 2〜7 バイト目＝49 bit まで Number で正確
		b = u8[p++]; v = v * 128 + (b & 0x7f);
		if (!(b & 0x80)) { out.v = v; out.p = p; return; }
	}
	let big = BigInt(v);
	b = u8[p++];
	if (!(b & 0x80)) big = (big << 7n) | BigInt(b & 0x7f);   // 8 バイト目（56 bit）
	else big = BigInt.asIntN(64, (((big << 7n) | BigInt(b & 0x7f)) << 8n) | BigInt(u8[p++]));   // 9 バイト目＝下位 8 bit 全部・64 bit 二の補数
	out.v = big >= -SAFE && big <= SAFE ? Number(big) : big;
	out.p = p;
}

// ── CREATE TABLE の最小解釈（列名・型・rowid 別名だけ。制約や式は読まない） ─────────────
const CONSTRAINT_HEAD = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;
const COL_CONSTRAINT = /^(CONSTRAINT|PRIMARY|NOT|NULL|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|GENERATED|AS)\b/i;
export function parseCreate(sql) {
	const columns = [];
	if (!sql) return { columns, rowidAlias: -1, withoutRowid: false };
	const open = sql.indexOf("("), close = sql.lastIndexOf(")");
	if (open < 0 || close < open) return { columns, rowidAlias: -1, withoutRowid: false };   // CREATE TABLE x AS SELECT … は列を持てない
	const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(sql.slice(close + 1));
	let rowidAlias = -1;
	for (const def of splitTop(sql.slice(open + 1, close))) {
		const d = def.trim();
		if (!d || CONSTRAINT_HEAD.test(d)) continue;
		const { name, rest } = ident(d);
		// 型＝制約キーワードの手前まで（TEXT(50) や DECIMAL(10,2) の括弧は型の一部）
		let type = "", r = rest.trim();
		while (r && !COL_CONSTRAINT.test(r)) {
			const m = r.match(/^(\([^)]*\)|[^\s(]+)\s*/); if (!m) break;
			type += (type && !m[1].startsWith("(") ? " " : "") + m[1]; r = r.slice(m[0].length);
		}
		const pk = /\bPRIMARY\s+KEY\b/i.test(r);
		if (pk && /^INTEGER$/i.test(type) && rowidAlias < 0) rowidAlias = columns.length;
		columns.push({ name, type: type.toUpperCase(), pk });
	}
	return { columns, rowidAlias, withoutRowid };
}
function splitTop(s) {
	const out = []; let depth = 0, q = null, start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) { if (c === q) { if (s[i + 1] === q) i++; else q = null; } continue; }
		if (c === '"' || c === "'" || c === "`") q = c;
		else if (c === "[") q = "]";
		else if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (c === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
	}
	out.push(s.slice(start));
	return out;
}
function ident(d) {
	const c = d[0];
	if (c === '"' || c === "`" || c === "'" || c === "[") {
		const close = c === "[" ? "]" : c; let i = 1, name = "";
		for (; i < d.length; i++) { if (d[i] === close) { if (d[i + 1] === close && close !== "]") { name += close; i++; } else break; } else name += d[i]; }
		return { name, rest: d.slice(i + 1) };
	}
	const m = d.match(/^[^\s(,]+/);
	return { name: m[0], rest: d.slice(m[0].length) };
}
