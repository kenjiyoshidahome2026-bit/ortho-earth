// t-healpix-vt-flow: HEALPix のベクタタイルの出し入れの流れ（src/healpix-vt-flow.ts）の検定。
// 偽の読み口（遅れを手で進める）で：視点 → 選ぶ → 取る → 組む → 結合 → onScene。
// 守るもの：出す集合に重なりが無い／段の切り替えの途中で穴を作らない（前のタイルを出し続ける）／同時の本数／要らなくなった取得は止める／
//          遠すぎる視点・束の無い面は取りに行かない／持ちすぎを捨てる
import { encodeHpxVt } from "../src/healpixvt.ts";
import { decodeTile, loadTileFormat } from "../src/decode.ts";
import { lonLatToNest } from "../src/healpix.ts";
import { createHpxVtFlow, hpxOverlap } from "../src/healpix-vt-flow.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
globalThis.self ??= globalThis;
await loadTileFormat("mvt");
const sleep = ms => new Promise(r => setTimeout(r, ms));

ok(hpxOverlap({ order: 5, npix: 7 }, { order: 7, npix: 7 * 16 + 9 }) && hpxOverlap({ order: 7, npix: 121 }, { order: 5, npix: 7 }) && hpxOverlap({ order: 5, npix: 7 }, { order: 5, npix: 7 }) && !hpxOverlap({ order: 5, npix: 7 }, { order: 7, npix: 8 * 16 }), "重なり＝祖先かどうか");

// どのタイルにも中身（タイルの真ん中を通る 1 本の線）を返す読み口。gate を開けるまで待たせる
const one = decodeTile(encodeHpxVt([{ name: "roads", features: [{ type: "line", parts: [[[100, 2048], [3996, 2048]]], props: { kind: "major_road" } }] }]), null, "mvt");
function fakeSource({ minOrder = 6, maxOrder = 12, faces = [1], empty = () => false } = {}) {
	const waiting = [], log = []; let live = 0, peak = 0, open = false;
	return {
		log, waiting, get peak() { return peak; },
		release(n = Infinity) { while (n-- > 0 && waiting.length) waiting.shift()(); },
		openAll() { open = true; this.release(); },
		index: async () => ({ minOrder, maxOrder, extent: 4096, layers: ["roads"], faces: faces.map(face => ({ face, file: `face${face}.pmtiles`, tiles: 1, bytes: 1 })) }),
		raw: async () => null, nearest: async () => null,
		tile: (order, npix, signal) => new Promise((res, rej) => {
			log.push({ order, npix }); live++; peak = Math.max(peak, live);
			const done = () => { live--; signal?.aborted ? rej(new DOMException("aborted", "AbortError")) : res(empty(order, npix) ? { __empty: true } : structuredClone(one)); };
			signal?.addEventListener("abort", () => { const i = waiting.indexOf(done); if (i >= 0) { waiting.splice(i, 1); done(); } });
			open ? done() : waiting.push(done);
		}),
	};
}
const W = 1600, H = 1000, TOKYO = [139.767, 35.681];
const camAt = (zoom, center = TOKYO) => ({ center, zoom, pitch: 0, bearing: 0 });
const noOverlap = ts => ts.every((a, i) => ts.every((b, j) => i >= j || !hpxOverlap(a, b)));

// ── 1. 普通の流れ：選んだタイルが全部届いて 1 つの scene になる ──
{
	const src = fakeSource(), scenes = [];
	const flow = createHpxVtFlow({ source: src, li0: 1 << 20, mergeWait: 5, onScene: (s, i) => scenes.push({ s, i }) });
	flow.update(camAt(15), W, H); await sleep(5);
	flow.update(camAt(15), W, H);   // 目録が来た後
	await sleep(5);
	const st0 = flow.stats();
	ok(st0.wanted > 9 && st0.wanted < 80 && st0.fetching === 6 && src.peak === 6 && st0.shown === 0, `z15 の東京：欲しい ${st0.wanted} 枚・同時に取るのは 6 本まで・届くまでは何も出さない`);
	src.openAll(); await sleep(40);
	const st = flow.stats(), last = scenes.at(-1);
	ok(st.pending === 0 && st.shown === st.wanted && src.peak <= 6 && st.orders.join() === "12", `全部届く（${st.shown} 枚・段 12・同時の最大 ${src.peak}）`);
	ok(last?.s && last.s.layers.length === 1 && last.s.layers[0].li === (1 << 20) + 4 && last.s.origin[0] === TOKYO[0] && last.s.origin[1] === TOKYO[1], "結合した scene：幹線の層 1 つ（li の帯）・原点＝注視点");
	ok(last.s.layers[0].P1.length / 2 >= st.shown, `線分はタイルの枚数ぶん以上（${last.s.layers[0].P1.length / 2}）`);
	ok(scenes.length <= 6, `結合は届くたびでなく、まとめて（${scenes.length} 回）`);
	// 同じ視点をもう一度＝取りに行かない・結合もしない
	const n = src.log.length, m = flow.stats().merges; flow.update(camAt(15), W, H); await sleep(20);
	ok(src.log.length === n && flow.stats().merges === m, "同じ視点では取り直さない・結合し直さない");
	flow.destroy();
}

// ── 2. 段の切り替え：新しい段が届くまで前の段を出し続ける（穴なし・重なりなし） ──
{
	const src = fakeSource(), seen = [];
	const flow = createHpxVtFlow({ source: src, mergeWait: 1, onScene: () => {} });
	flow.update(camAt(13), W, H); await sleep(5); flow.update(camAt(13), W, H); src.openAll(); await sleep(30);
	const coarse = flow.stats();
	ok(coarse.pending === 0 && coarse.orders.join() === "10", `z13 では段 10（${coarse.shown} 枚）`);
	// 寄る（細かい段へ）。届かせない
	const hold = fakeSource();   // 以後の取得を待たせるため、tile を差し替える
	src.tile = hold.tile;
	flow.update(camAt(15), W, H); await sleep(10);
	const mid = flow.stats();
	ok(mid.pending === mid.wanted && mid.shown > 0 && mid.orders.join() === "10", `寄った直後：細かい段はまだ 0 枚・前の段 10 を出し続ける（${mid.shown} 枚）`);
	// 半分だけ届かせる
	hold.release(3); await sleep(15); hold.release(3); await sleep(15);
	const half = flow.stats();
	ok(half.pending > 0 && half.pending < half.wanted && half.shown > 0, `途中（残り ${half.pending}/${half.wanted}）も何か出ている（${half.shown} 枚・段 ${half.orders.join("・")}）`);
	// 全部届かせる
	for (let i = 0; i < 40 && flow.stats().pending; i++) { hold.release(); await sleep(8); }
	const fin = flow.stats();
	ok(fin.pending === 0 && fin.orders.join() === "12" && fin.shown === fin.wanted, `届き切ったら細かい段だけ（${fin.shown} 枚・段 12）`);
	flow.destroy();
}
// 出す集合そのものを見る：途中のどの時点でも重なりが無く、注視点を含むタイルがある
{
	const src = fakeSource();
	const flow = createHpxVtFlow({ source: src, mergeWait: 0, onScene: () => {} });
	flow.update(camAt(12), W, H); await sleep(5); flow.update(camAt(12), W, H); src.openAll(); await sleep(30);
	const a = flow.stats();
	const hold = fakeSource(); src.tile = hold.tile;
	flow.update(camAt(14.6), W, H); await sleep(5);
	const home = lonLatToNest(TOKYO[0], TOKYO[1], 12), holds = t => hpxOverlap(t, { order: 12, npix: home });
	let bad = 0, steps = 0;
	while (flow.stats().pending && steps++ < 200) { hold.release(1); await sleep(4); const s = flow.stats(); if (!noOverlap(s.tiles) || s.tiles.filter(holds).length !== 1) bad++; }
	ok(a.shown > 0 && bad === 0 && steps > 3 && noOverlap(flow.stats().tiles), `1 枚ずつ届く間（${steps} 歩）ずっと：出すタイルに重なりが無く、注視点を含むタイルがちょうど 1 枚`);
	flow.destroy();
}

// ── 3. 要らなくなった取得は止める ──
{
	const src = fakeSource();
	const flow = createHpxVtFlow({ source: src, mergeWait: 1, onScene: () => {} });
	flow.update(camAt(15), W, H); await sleep(5); flow.update(camAt(15), W, H); await sleep(5);
	const before = flow.stats();
	flow.update(camAt(15, [135.5, 34.7]), W, H); await sleep(10);   // 大阪へ飛ぶ
	const after = flow.stats();
	ok(before.fetching === 6 && after.aborted === 6 && after.fetching === 6, "視点が離れたら、取得中の 6 本を止めて、新しい所の 6 本を取り始める");
	flow.destroy();
}

// ── 4. 遠すぎる視点・束の無い面 ──
{
	const src = fakeSource({ minOrder: 6 }), scenes = [];
	const flow = createHpxVtFlow({ source: src, mergeWait: 1, onScene: s => scenes.push(s) });
	flow.update(camAt(5), W, H); await sleep(5); flow.update(camAt(5), W, H); await sleep(10);
	ok(flow.stats().wanted === 0 && src.log.length === 0, "z5（段 2 相当）は目録の最小の段 6 より粗すぎる＝取りに行かない");
	flow.update(camAt(15, [-0.12, 51.5]), W, H); await sleep(10);   // ロンドン＝面 1 ではない
	ok(flow.stats().wanted === 0 && src.log.length === 0, "束の無い面（ロンドン）は取りに行かない");
	// 出していた物があれば消える（null が届く）
	flow.update(camAt(15), W, H); src.openAll(); await sleep(40);
	const had = scenes.filter(Boolean).length;
	flow.update(camAt(5), W, H); await sleep(20);
	ok(had > 0 && scenes.at(-1) === null, "遠ざかったら null（消す）が届く");
	flow.destroy();
}

// ── 5. 空のタイル・持ちすぎ ──
{
	const src = fakeSource({ empty: () => true }), scenes = [];
	const flow = createHpxVtFlow({ source: src, mergeWait: 1, onScene: s => scenes.push(s) });
	flow.update(camAt(15), W, H); await sleep(5); flow.update(camAt(15), W, H); src.openAll(); await sleep(40);
	const n = src.log.length;
	flow.update(camAt(15), W, H); await sleep(10);
	ok(flow.stats().pending === 0 && scenes.filter(Boolean).length === 0 && src.log.length === n, "空のタイルは「届いた」と数え、scene は出さず、取り直さない");
	flow.destroy();
	const src2 = fakeSource(); src2.openAll();
	const flow2 = createHpxVtFlow({ source: src2, mergeWait: 1, cacheMax: 40, onScene: () => {} });
	flow2.update(camAt(15), W, H); await sleep(5);
	for (let i = 0; i < 12; i++) { flow2.update(camAt(15, [TOKYO[0] + i * 0.05, TOKYO[1]]), W, H); await sleep(25); }
	const s2 = flow2.stats();
	ok(s2.cached <= Math.max(40, s2.shown + s2.wanted) && s2.fetched > 80 && s2.pending === 0, `動き回っても持つのは上限まで（取った ${s2.fetched} 枚・持っている ${s2.cached} 枚）`);
	flow2.destroy();
}
if (fails) { console.error(`${fails} failed`); process.exit(1); }
console.log("all passed");
