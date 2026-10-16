#!/usr/bin/env node
// t-safety: 外から来るファイルを開く経路の安全既定（2026-10-11・geopbf 俯瞰 §2-A の 1・2）。
//   ・FUNC 型（型 7）は関数に復元しない（常にソース文字列。1.19 の noeval 既定＝2.0 で唯一の挙動・{ noeval: false } は撤去）
//   ・SQLite リーダ: 循環する子ポインタ・自己参照ページ・ページ外のセルポインタで無限ループ／範囲外読みにならず例外で止まる
//   ・snappy: 宣言サイズの上限・リテラル／複写の境界検査
//   ・decodeZIP: 宣言サイズを越える伸長（zip 爆弾）・中央ディレクトリの範囲外を例外で止める（decodeZIP は null を返す）
globalThis.ImageData ??= class ImageData { };
import { readFileSync } from "node:fs";
import { GeoPBF } from "../src/pbf-base.js";
import { openSqlite } from "../src/convert/sqlite.js";
import { snappy, MAX_PAGE } from "../src/convert/parquet-read.js";
import { encodeZIP } from "../src/modules/encodeZIP.ts";
import { decodeZIP } from "../src/modules/decodeZIP.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const throws = (fn, re, msg) => { try { fn(); ok(false, msg + "（例外が出ない）"); } catch (e) { ok(re.test(String(e.message)), `${msg}: ${e.message.slice(0, 90)}`); } };

// ── FUNC ─────────────────────────────────────────────────────────────────────
{
	const fc = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { f: function hello(a) { return a + 1; }, n: 1 } }] };
	const enc = await new GeoPBF().set(fc);
	const bytes = enc.arrayBuffer;
	const dflt = await new GeoPBF().set(bytes.slice(0));
	const p = dflt.getProperties(0);
	ok(typeof p.f === "string" && p.f.includes("a + 1"), "FUNC は関数ソース文字列のまま");
	ok(p.n === 1, "他の属性は従来どおり");
	const optin = await new GeoPBF({ noeval: false }).set(bytes.slice(0));
	const q = optin.getProperties(0);
	ok(typeof q.f === "string" && q.f.includes("a + 1") && !("noeval" in optin), "{ noeval:false } を渡しても関数へ復元しない（2.0 で撤去＝new Function の経路が無い）");
}

// ── SQLite ───────────────────────────────────────────────────────────────────
{
	const fx = new Uint8Array(readFileSync(new URL("./fixtures/gpkg/mixed.gpkg", import.meta.url)));
	const good = openSqlite(fx);
	ok(good.count("places") === 1200, "健全なファイルは従来どおり読める");
	const root = good.tables.get("places").rootpage, ps = good.pageSize;
	// (a) root を「子が自分自身」の内部ページに書き換える（旧＝_pages/_rows/get が無限ループ）
	const a = fx.slice(); { const dv = new DataView(a.buffer); const hdr = (root - 1) * ps; a[hdr] = 0x05; dv.setUint16(hdr + 3, 0); dv.setUint32(hdr + 8, root); }
	const dbA = openSqlite(a);
	throws(() => dbA.count("places"), /cycle|twice/, "自己参照ページ: count が循環を検出");
	throws(() => { for (const r of dbA.rows("places")) void r; }, /cycle|twice/, "自己参照ページ: rows が循環を検出");
	throws(() => dbA.get("places", 5), /cycle|twice/, "自己参照ページ: get が循環を検出");
	// (b) 内部ページの子が互いを指す 2 ページ循環
	const b = fx.slice(); { const dv = new DataView(b.buffer); const h1 = (root - 1) * ps; const child = dv.getUint32(h1 + 8); const h2 = (child - 1) * ps; b[h2] = 0x05; dv.setUint16(h2 + 3, 0); dv.setUint32(h2 + 8, root); }
	throws(() => openSqlite(b).count("places"), /cycle|twice/, "2 ページ循環: 検出");
	// (c) 葉のセルポインタがページの外
	const c = fx.slice(); { const dv = new DataView(c.buffer); const h1 = (root - 1) * ps; const leaf = dv.getUint32(h1 + dv.getUint16(h1 + 12)); const h = (leaf - 1) * ps; ok(c[h] === 0x0d, `root の最初の子（page ${leaf}）は葉`); dv.setUint16(h + 8, 0xFFFF); }
	throws(() => { for (const r of openSqlite(c).rows("places")) void r; }, /outside its page|outside the file|cycle|twice|RangeError|Offset/, "セルポインタがページ外: 例外で止まる");
	// (d) ページ番号 0（旧＝ (0-1)*pageSize の負のオフセット）
	const d = fx.slice(); { const dv = new DataView(d.buffer); const h = (root - 1) * ps; d[h] = 0x05; dv.setUint16(h + 3, 0); dv.setUint32(h + 8, 0); }
	throws(() => openSqlite(d).count("places"), /outside the file/, "ページ 0 への参照: 範囲外として拒否");
}

// ── snappy ───────────────────────────────────────────────────────────────────
{
	const lit = (s) => { const b = new TextEncoder().encode(s); return new Uint8Array([b.length, (b.length - 1) << 2, ...b]); };
	ok(new TextDecoder().decode(snappy(lit("hello"))) === "hello", "snappy: リテラルの復号");
	// 複写: "ab" + copy(len 4, off 2) → "ababab"
	const cp = new Uint8Array([6, 1 << 2, 0x61, 0x62, ((4 - 4) << 2) | 1 | (0 << 5), 2]);
	ok(new TextDecoder().decode(snappy(cp)) === "ababab", "snappy: 重なる複写");
	throws(() => snappy(new Uint8Array([10, (100 - 1) << 2, 1, 2])), /literal runs past/, "snappy: 宣言より長いリテラル");
	throws(() => snappy(new Uint8Array([6, 1 << 2, 0x61, 0x62, 1, 0])), /copy offset/, "snappy: 複写オフセット 0");
	throws(() => snappy(new Uint8Array([6, 1 << 2, 0x61, 0x62, 1, 9])), /copy offset/, "snappy: まだ書いていない所からの複写");
	throws(() => snappy(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x10, 0])), /exceeds limit/, `snappy: 宣言 2^32 は上限（${MAX_PAGE}）で拒否`);
	throws(() => snappy(new Uint8Array([100, 0]), 10), /exceeds limit/, "snappy: 呼び手の上限（ページヘッダ）を越える宣言");
	throws(() => snappy(new Uint8Array([3, 1 << 2, 0x61, 0x62])), /does not match declared/, "snappy: 宣言に満たない出力");
}

// ── decodeZIP ────────────────────────────────────────────────────────────────
{
	const big = new Uint8Array(300_000); for (let i = 0; i < big.length; i++) big[i] = i & 3;   // よく縮む
	const zip = new Uint8Array(await (await encodeZIP([new File([big], "bomb.bin")])).arrayBuffer());
	ok((await decodeZIP(new Blob([zip])))?.[0]?.size === big.length, "健全な zip は従来どおり展開");
	// 中央ディレクトリの uSiz を小さく偽る＝伸長が宣言を越えた時点で止まる（null）
	const dv = new DataView(zip.buffer);
	let eocd = -1; for (let i = zip.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
	const cdOff = dv.getUint32(eocd + 16, true);
	const lie = zip.slice(); new DataView(lie.buffer).setUint32(cdOff + 24, 1000, true);
	const warn = console.warn; let msg = ""; console.warn = (...a) => { msg += a.join(" "); };
	const r1 = await decodeZIP(new Blob([lie]));
	ok(r1 === null && /declared size/.test(msg), "宣言サイズを越える伸長（zip 爆弾の形）は null＋警告");
	msg = "";
	const r2 = await decodeZIP(new Blob([zip]), { maxEntrySize: 1000 });
	ok(r2 === null && /exceeds the limit/.test(msg), "maxEntrySize を越える宣言は展開前に拒否");
	msg = "";
	const cdLie = zip.slice(); new DataView(cdLie.buffer).setUint32(eocd + 12, 0x7FFFFFFF, true);
	const r3 = await decodeZIP(new Blob([cdLie]));
	ok(r3 === null && /central directory/.test(msg), "中央ディレクトリの範囲外は読む前に拒否");
	console.warn = warn;
}

console.log(fails ? `\nFAIL ${fails}` : "\nPASS t-safety");
process.exit(fails ? 1 : 0);
