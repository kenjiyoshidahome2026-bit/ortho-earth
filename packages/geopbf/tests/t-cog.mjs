// t-cog: src/cog/* の検定（Node 20+・外部データ不要＝決定的）。
// 合成 COG（tests/cog/build-cog.mjs）を Range 対応のインメモリ HTTP サーバから配り、
// リクエスト記録で「ヘッダ一発読み」「coalesce」「Range 拒否フォールバック」まで数字で確かめる。
import { createServer } from "node:http";
import { buildCog, lzwEncode } from "./cog/build-cog.mjs";
import { openCog, lonlatTarget, xyzTarget } from "../src/cog/core.js";
import { lzwDecode, mergeJPEGTables, decodeTile } from "../src/cog/decode.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- Range 対応サーバ（noRange で 200 全量に切り替え）------------------------------------------
const files = new Map();   // path → {body, noRange}
const log = [];            // {path, range}
const server = createServer((req, res) => {
	const f = files.get(req.url);
	if (!f) { res.writeHead(404); return res.end(); }
	log.push({ path: req.url, range: req.headers.range || null });
	const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
	if (m && !f.noRange) {
		const from = +m[1], to = Math.min(+m[2], f.body.length - 1);
		res.writeHead(206, { "content-range": `bytes ${from}-${to}/${f.body.length}`, "content-type": "application/octet-stream" });
		return res.end(Buffer.from(f.body.subarray(from, to + 1)));
	}
	res.writeHead(200, { "content-type": "application/octet-stream" });
	res.end(Buffer.from(f.body));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const reqCount = (path) => log.filter(l => l.path === path).length;

// ---- 1) 基本: RGB u8 deflate+predictor UTM54N・overview 2段・ヘッダ一発読み --------------------
{
	const px = (x, y) => [x & 255, y & 255, (x + y) & 255];
	files.set("/a.tif", { body: buildCog({ width: 64, height: 48, tileW: 16, tileH: 16, epsg: 32654, origin: [300000, 4000000], scale: [10, 10], compression: "deflate", predictor: true, overviews: [2, 4], pixel: px }) });
	const cog = await openCog(`${base}/a.tif`);
	ok(reqCount("/a.tif") === 1, `open はヘッダ一発読み＝1リクエスト（実測 ${reqCount("/a.tif")}）`);
	ok(log[0].range === "bytes=0-16383", `初回 range が bytes=0-16383（実測 ${log[0].range}）`);
	ok(cog.width === 64 && cog.height === 48 && cog.epsg === 32654, "寸法と EPSG");
	ok(cog.overviews.length === 3, `overview 3段（実測 ${cog.overviews.length}）`);
	ok(Math.abs(cog.bbox[0] - 300000) < 1e-9 && Math.abs(cog.bbox[3] - 4000000) < 1e-9, "bbox 北西角＝tiepoint");
	ok(cog.bboxLL[0] > 138 && cog.bboxLL[0] < 140 && cog.bboxLL[3] > 36 && cog.bboxLL[3] < 37, `bboxLL が UTM54N の期待域（実測 ${cog.bboxLL.map(v => v.toFixed(3))}）`);

	const t = await cog.getTile(0, 1, 1);   // タイル(1,1)＝global(16..31, 16..31)
	const at = (i, j, k) => t[(j * 16 + i) * 4 + k];
	ok(at(3, 5, 0) === 19 && at(3, 5, 1) === 21 && at(3, 5, 2) === 40, "deflate+predictor 経由の画素値が一致");
	ok(at(0, 0, 3) === 255, "alpha=255");

	// coalesce: 連続レイアウトの 4 タイルが 1 リクエストに合体
	const before = reqCount("/a.tif");
	await cog.getTiles(0, [[0, 0], [1, 0], [2, 0], [3, 0]]);
	ok(reqCount("/a.tif") === before + 1, `隣接4タイルが coalesce＝+1リクエスト（実測 +${reqCount("/a.tif") - before}）`);
	const mt = cog.metrics();
	ok(mt.coalescedFrom >= 4 && mt.rangeRequests < mt.coalescedFrom + 1, `metrics: ${mt.coalescedFrom}要求→${mt.rangeRequests}リクエスト`);

	// levelFor: 粗い解像度要求で coarsest
	ok(cog.levelFor(10) === 0 && cog.levelFor(45) === 2, `levelFor（10→0, 45→2 実測 ${cog.levelFor(10)},${cog.levelFor(45)}）`);
	cog.close();
}

// ---- 2) sparse タイル → null ----------------------------------------------------------------
{
	files.set("/sp.tif", { body: buildCog({ sparse: [1, 0] }) });
	const cog = await openCog(`${base}/sp.tif`);
	ok(await cog.getTile(0, 1, 0) === null, "sparse(offset=0) タイルは null");
	ok((await cog.getTile(0, 0, 0)) !== null, "隣の実タイルは読める");
	cog.close();
}

// ---- 3) palette → RGBA ----------------------------------------------------------------------
{
	const pal = new Uint8Array(256 * 4);
	for (let i = 0; i < 256; i++) { pal[i * 4] = i; pal[i * 4 + 1] = 255 - i; pal[i * 4 + 2] = 7; pal[i * 4 + 3] = 255; }
	files.set("/pal.tif", { body: buildCog({ bands: 1, palette: pal, pixel: (x, y) => (x + y) & 255 }) });
	const cog = await openCog(`${base}/pal.tif`);
	const t = await cog.getTile(0, 0, 0);
	const v = (5 + 3) & 255;
	ok(t[(3 * 16 + 5) * 4] === v && t[(3 * 16 + 5) * 4 + 1] === 255 - v && t[(3 * 16 + 5) * 4 + 2] === 7, "palette 引きの RGBA");
	cog.close();
}

// ---- 4) u16 単バンド: auto stretch + nodata → alpha 0 ----------------------------------------
{
	files.set("/u16.tif", { body: buildCog({ bands: 1, dtype: "u16", compression: "deflate", nodata: 65535, pixel: (x, y) => x === 0 ? 65535 : x * 100 }) });
	const cog = await openCog(`${base}/u16.tif`);
	ok(cog.dtype === "u16" && cog.nodata === 65535, "dtype/nodata 読み");
	const t = await cog.getTile(0, 0, 0);
	ok(t[(2 * 16 + 0) * 4 + 3] === 0, "nodata 画素は alpha 0");
	const g1 = t[(2 * 16 + 3) * 4], g2 = t[(2 * 16 + 12) * 4];
	ok(g2 > g1 && t[(2 * 16 + 3) * 4 + 3] === 255, `auto stretch のグレーが単調増加（${g1}→${g2}）`);
	cog.close();
}

// ---- 5) strip 型の正規化 ---------------------------------------------------------------------
{
	files.set("/strip.tif", { body: buildCog({ strip: true, compression: "deflate" }) });
	const cog = await openCog(`${base}/strip.tif`);
	ok(cog.tileW === 64 && cog.overviews[0].tilesX === 1, `strip→幅=画像幅のタイル正規化（tileW=${cog.tileW}）`);
	const t = await cog.getTile(0, 0, 1);   // 2段目 strip（th=8）＝global y 8..15
	ok(t[(2 * 64 + 5) * 4] === 5 && t[(2 * 64 + 5) * 4 + 1] === 10, "strip 画素値一致");
	cog.close();
}

// ---- 6) BigTIFF ------------------------------------------------------------------------------
{
	files.set("/big.tif", { body: buildCog({ bigtiff: true, compression: "deflate" }) });
	const cog = await openCog(`${base}/big.tif`);
	ok(cog.bigtiff === true && cog.width === 64, "BigTIFF が開ける");
	const t = await cog.getTile(0, 1, 1);
	ok(t[(5 * 16 + 3) * 4] === (19 & 255), "BigTIFF 画素値一致");
	cog.close();
}

// ---- 7) Range 拒否ホスト → 全量フォールバック -------------------------------------------------
{
	files.set("/nr.tif", { body: buildCog({ compression: "deflate" }), noRange: true });
	const cog = await openCog(`${base}/nr.tif`);
	const t = await cog.getTile(0, 1, 1);
	ok(t && t[(5 * 16 + 3) * 4] === 19, "200 全量フォールバックでも画素値一致");
	ok(reqCount("/nr.tif") === 1, `全量モードはリクエスト1本のみ（実測 ${reqCount("/nr.tif")}）`);
	cog.close();
}

// ---- 8) LZW ----------------------------------------------------------------------------------
{
	const src = new Uint8Array(3000).map((_, i) => (i * 7 + (i >> 5)) & 255);
	ok(Buffer.compare(Buffer.from(lzwDecode(lzwEncode(src), src.length)), Buffer.from(src)) === 0, "LZW encode→decode 往復一致（幅遷移 9→12bit 跨ぎ）");
	files.set("/lzw.tif", { body: buildCog({ compression: "lzw", predictor: true }) });
	const cog = await openCog(`${base}/lzw.tif`);
	const t = await cog.getTile(0, 1, 1);
	ok(t[(5 * 16 + 3) * 4] === 19 && t[(5 * 16 + 3) * 4 + 1] === 21, "LZW+predictor タイル画素値一致");
	cog.close();
}

// ---- 9) JPEGTables マージ（バイト組み立てのみ＝デコードはブラウザゲート）-----------------------
{
	const tables = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x04, 1, 2, 0xFF, 0xD9]);
	const tile = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x04, 3, 4, 0xFF, 0xD9]);
	const m = mergeJPEGTables(tables, tile);
	ok(m[0] === 0xFF && m[1] === 0xD8, "マージ後 SOI で始まる");
	ok(m.length === tables.length - 2 + tile.length - 2, "テーブル EOI とタイル SOI が落ちる");
	let soi = 0; for (let i = 0; i < m.length - 1; i++) if (m[i] === 0xFF && m[i + 1] === 0xD8) soi++;
	ok(soi === 1, "SOI は1つ");
	const dec = decodeTile(tile, { compression: 7, jpegTables: tables, tileW: 1, tileH: 1, samples: 3, bits: [8] }, true);
	ok(dec.kind === "image" && dec.mime === "image/jpeg", "compression=7 は image kind で返る");
}

// ---- 10) render: 3857 チェッカーボード → lonlat/XYZ ターゲット --------------------------------
{
	// 3857 で 40×40、(x<20,y<20)=赤 / 他=青 の 4 象限
	const px = (x, y) => (x < 20) === (y < 20) ? [200, 0, 0] : [0, 0, 200];
	files.set("/chk.tif", { body: buildCog({ width: 40, height: 40, tileW: 16, tileH: 16, epsg: 3857, origin: [1000000, 5000000], scale: [1000, 1000], pixel: px, compression: "deflate" }) });
	const cog = await openCog(`${base}/chk.tif`);
	const tgt = lonlatTarget(cog.bboxLL, 40, 40);
	const img = await cog.render(tgt);
	const at = (i, j) => [img[(j * 40 + i) * 4], img[(j * 40 + i) * 4 + 2]];
	ok(at(8, 8)[0] === 200 && at(8, 8)[1] === 0, "lonlat render: 左上象限＝赤");
	ok(at(32, 8)[0] === 0 && at(32, 8)[1] === 200, "lonlat render: 右上象限＝青");
	ok(at(32, 32)[0] === 200, "lonlat render: 右下象限＝赤");
	// XYZ ターゲット（bboxLL 中心を含む z14 タイル）
	const [cw, cs, ce, cn] = cog.bboxLL;
	const cx = (cw + ce) / 2, cy = (cs + cn) / 2, z = 14, n = 1 << z;
	const tx = Math.floor((cx / 360 + 0.5) * n);
	const ty = Math.floor((1 - Math.log(Math.tan(cy * Math.PI / 180) + 1 / Math.cos(cy * Math.PI / 180)) / Math.PI) / 2 * n);
	const xyz = await cog.render(xyzTarget(z, tx, ty));
	ok(xyz && xyz.some((v, i) => i % 4 === 3 && v > 0), "XYZ render が不透明画素を返す");
	cog.close();
}

// ---- 11) 4326 直・Blob ソース -----------------------------------------------------------------
{
	const body = buildCog({ epsg: 4326, origin: [139, 36], scale: [0.001, 0.001] });
	const cog = await openCog(new Blob([body]));
	ok(Math.abs(cog.bboxLL[0] - 139) < 1e-12 && Math.abs(cog.bboxLL[3] - 36) < 1e-12, "4326: bboxLL＝bbox そのまま・Blob ソース可");
	cog.close();
}

// ---- 12) 非対応 CRS の明示エラー --------------------------------------------------------------
{
	files.set("/bad.tif", { body: buildCog({ epsg: 6677 }) });
	let msg = "";
	try { await openCog(`${base}/bad.tif`); } catch (e) { msg = e.message; }
	ok(/unsupported CRS.*6677/.test(msg), `非対応 CRS は明示エラー（${msg}）`);
}

server.close();
console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
