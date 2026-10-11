#!/usr/bin/env node
// t-cog-source: src/cog/source.js（range の合体・並行・URL の 206/200/404）の単体検定（改良点 17・2026-10-12）。
//   t-cog は COG 越しに coalesce を見るが、gapBytes / maxReq / 入力順 / 重なり / 並行数 / fetch 注入の端はここで直接見る。
import { openSource } from "../src/cog/source.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const data = new Uint8Array(1 << 20); for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 8)) & 255;
const same = (u8, from) => u8.every((v, i) => v === data[from + i]);

// {read,size} 注入＝呼び出しを記録
const mk = async (opts = {}) => {
	const calls = []; let active = 0, peak = 0;
	const read = async (from, len) => { calls.push([from, len]); active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return data.subarray(from, from + len); };
	const s = await openSource({ read, size: data.length }, { headerBytes: 16, gapBytes: 100, maxReq: 1000, concurrency: 2, ...opts });
	return { s, calls, peak: () => peak };
};
{
	const { s, calls } = await mk();
	ok(s.head.length === 16 && same(s.head, 0) && calls.length === 1 && calls[0].join() === "0,16", "probe: headerBytes だけ先に読む");
	calls.length = 0;
	const out = await s.readMany([{ from: 500, len: 10 }, { from: 100, len: 50 }, { from: 160, len: 30 }]);
	ok(calls.length === 2 && calls[0].join() === "100,90" && calls[1].join() === "500,10", `gap < gapBytes は 1 本に合体（${calls.map(c => c.join("+")).join(" / ")}）`);
	ok(out.length === 3 && out[0].length === 10 && same(out[0], 500) && same(out[1], 100) && same(out[2], 160), "戻りは入力順・中身一致");
	ok(s.metrics.coalescedFrom === 3, "metrics.coalescedFrom＝要求数");
	calls.length = 0;
	await s.readMany([{ from: 0, len: 10 }, { from: 110, len: 10 }]);
	ok(calls.length === 2, "gap ≥ gapBytes（100）は別本");
	calls.length = 0;
	await s.readMany([{ from: 0, len: 10 }, { from: 109, len: 10 }]);
	ok(calls.length === 1 && calls[0].join() === "0,119", "gap = 99 は合体");
	calls.length = 0;
	await s.readMany([{ from: 0, len: 600 }, { from: 650, len: 600 }]);
	ok(calls.length === 2, "合体後が maxReq（1000）を越えるなら別本");
	calls.length = 0;
	const ov = await s.readMany([{ from: 10, len: 100 }, { from: 50, len: 20 }, { from: 10, len: 100 }]);
	ok(calls.length === 1 && calls[0].join() === "10,100" && same(ov[1], 50) && ov[1].length === 20 && ov[2].length === 100, "重なる要求は 1 本から切り出す");
	ok((await s.readMany([])).length === 0, "空の要求は何も読まない");
}
{
	const { s, calls, peak } = await mk({ gapBytes: 1 });
	calls.length = 0;
	const rs = []; for (let i = 0; i < 9; i++) rs.push({ from: i * 2000, len: 10 });
	const out = await s.readMany(rs);
	ok(calls.length === 9 && out.every((u, i) => same(u, i * 2000)) && peak() === 2, `並行数は concurrency（2）まで（実測 ${peak()}）`);
}
{
	const { s, calls } = await mk({ gapBytes: 1 });
	calls.length = 0;
	await s.readMany([{ from: 5, len: 1 }, { from: 3, len: 1 }, { from: 4, len: 1 }]);
	ok(calls.length === 1 && calls[0].join() === "3,3", "隣接（gap 0）は gapBytes=1 でも合体＝1 本");
}
// Blob
{
	const s = await openSource(new Blob([data]), { headerBytes: 8 });
	ok(s.size === data.length && s.head.length === 8 && same(s.head, 0), "Blob: size と head");
	const out = await s.readMany([{ from: 1000, len: 5 }, { from: 999999, len: 5 }]);
	ok(same(out[0], 1000) && same(out[1], 999999) && out[1].length === 5, "Blob: slice で読む");
	const t = await openSource(new Blob([data]), { tailBytes: 32 });
	ok(t.tail.length === 32 && same(t.tail, data.length - 32) && t.head.length === 0, "Blob: tailBytes は末尾を先に");
}
// URL（fetch 注入）: 206・200 全量・404・切れた応答・過剰応答
{
	const log = [];
	const fetch206 = async (url, init) => {
		const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); log.push(init.headers.Range);
		const from = +m[1], to = Math.min(+m[2], data.length - 1);
		return new Response(data.subarray(from, to + 1), { status: 206, headers: { "content-range": `bytes ${from}-${to}/${data.length}`, etag: '"abc"' } });
	};
	const s = await openSource("http://x/a.tif", { fetch: fetch206, headerBytes: 64, gapBytes: 10 });
	ok(s.size === data.length && s.head.length === 64 && s.etag === '"abc"' && log[0] === "bytes=0-63" && !s.wholeFile, "206: Content-Range から総長・etag・head");
	const out = await s.readMany([{ from: 100, len: 4 }, { from: 200, len: 4 }]);
	ok(out.length === 2 && same(out[0], 100) && same(out[1], 200) && log.length === 3 && s.metrics.rangeRequests === 3 && s.metrics.bytesFetched === 72, `206: readMany が Range を撃つ（${log.slice(1).join(", ")}）`);
	const t = await openSource("http://x/a.parquet", { fetch: fetch206, tailBytes: 16 });
	ok(t.tail.length === 16 && same(t.tail, data.length - 16) && t.metrics.rangeRequests === 2, "206 + tailBytes: 0-0 で総長→末尾の 2 本");
	const fetch200 = async () => new Response(data, { status: 200 });
	const w = await openSource("http://x/b.tif", { fetch: fetch200, headerBytes: 64 });
	ok(w.wholeFile && w.size === data.length && w.head.length === 64 && same((await w.readMany([{ from: 777, len: 3 }]))[0], 777), "200（Range 非対応）: 応答を丸ごと持って全量モード");
	let msg = ""; try { await openSource("http://x/c.tif", { fetch: async () => new Response("", { status: 404 }) }); } catch (e) { msg = e.message; }
	ok(/HTTP 404/.test(msg), `404 は例外（${msg}）`);
	const short = async (url, init) => { const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); const from = +m[1]; const len = Math.min(+m[2] - from + 1, 3); return new Response(data.subarray(from, from + len), { status: 206, headers: { "content-range": `bytes ${from}-${from + len - 1}/${data.length}` } }); };
	const sh = await openSource("http://x/d.tif", { fetch: short, headerBytes: 3 });
	let m2 = ""; try { await sh.readMany([{ from: 0, len: 10 }]); } catch (e) { m2 = e.message; }
	ok(/truncated 3\/10/.test(m2), `切れた応答は例外（${m2}）`);
	const over = async (url, init) => { const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); const from = +m[1]; return new Response(data.subarray(from, from + 50), { status: 206, headers: { "content-range": `bytes ${from}-${from + 49}/${data.length}` } }); };
	const ov = await openSource("http://x/e.tif", { fetch: over, headerBytes: 8 });
	const o = (await ov.readMany([{ from: 20, len: 4 }]))[0];
	ok(o.length === 4 && same(o, 20), "過剰応答は切り詰める");
	let m3 = ""; try { await openSource(42); } catch (e) { m3 = e.message; }
	ok(/unsupported source/.test(m3), "未知のソースは例外");
}
if (fails) { console.error(`${fails} 件失敗`); process.exit(1); }
console.log("全件通過");
