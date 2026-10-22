// ベンチ頁の共通の回し方（t-perfbench・ortho-nl の t-labelbench）。回帰検定ではない＝verify には載せない。
// シーンごとに：着地を待つ（LOAD_MS）→ 計測窓（MEASURE_MS）はカメラを毎フレーム少し動かして連続描画にする（3D は方位を回す・2D は中心を流す）→ 窓の後半で __perf を 3 回読んで中央値。
// 引っ掛かり（計器 a/b の 4ms 超）はシーン全体の累計差分。結果は <title> に "PASS {json}"（runRealtime の作法）。
// lab＝注記の計器（テキスト GPU 化 T-P0）＝labels2d の draw の ms（EMA）・衝突判定の ms・描いた注記と字の数
// vt＝計器 e／f（vt perf plan §2）＝基図のタイルの「必要になった→画面」（主層・ms）と main merge の回数・変わった枚数を、着地窓（load）と移動窓（move）で切る（__vtLog の環を at で窓切り・無い器は 0）
const Q = new URLSearchParams(location.search);
const LOAD_MS = +Q.get("load") || 18000, MEASURE_MS = +Q.get("measure") || 9000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const vtWin = (a, b) => {
	const log = window.__vtLog ? window.__vtLog() : { lat: [], merge: [] };
	const L = log.lat.filter(r => r.at >= a && r.at < b), M = log.merge.filter(r => r.at >= a && r.at < b);
	const q = (arr, f) => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))].toFixed(0); };
	const tot = L.map(r => r.total);
	return { n: L.length, med: q(tot, 0.5), p90: q(tot, 0.9), wait: q(L.map(r => r.wait), 0.5), fetch: q(L.map(r => r.fetch), 0.5), build: +(q(L.map(r => r.build * 10), 0.5) / 10).toFixed(1),
		merges: M.length, changed: M.length ? +(M.reduce((s, r) => s + r.add + r.del, 0) / M.length).toFixed(1) : 0, tiles: M.length ? Math.round(M.reduce((s, r) => s + r.n, 0) / M.length) : 0 };
};
export async function runBench(boot, scenes) {
	const only = Q.get("scene");   // 1 シーンだけ回す（名前）
	try {
		const map = await boot();
		const perf = () => (window.__perf ? window.__perf() : null);
		if (!perf()) throw new Error("__perf が無い（debugGlobals）か ?hud= の旗が無い（mem テレメトリ）");
		await sleep(3000);
		const out = { flags: location.search, backend: null, gpu: null, scenes: [] };
		for (const sc of scenes) {
			if (only && sc.name !== only) continue;
			const h0 = perf()?.hitch || { elev: 0, scene: 0 };
			const tJump = performance.now();
			map.jumpTo({ center: sc.center, zoom: sc.zoom, pitch: sc.pitch, bearing: sc.bearing });
			await sleep(LOAD_MS);   // タイル・標高・PLATEAU の着地
			const hLoad = perf()?.hitch || h0, tLoad = performance.now();
			// 計測窓＝連続描画（静止すると描かない＝gpuMap が更新されない）。3D は方位を毎フレーム 0.25° 回す・2D は中心を東へ流す
			const t0 = performance.now(); let b = sc.bearing, x = sc.center[0], samples = [];
			let raf = 0;
			const tick = () => {
				if (performance.now() - t0 > MEASURE_MS) return;
				if (sc.spin) { b = (b + 0.25) % 360; map.jumpTo({ bearing: b }); }
				else { x += 0.00004 * 2 ** (13 - sc.zoom); map.jumpTo({ center: [x, sc.center[1]] }); }   // 2D＝z13 で 0.00004°／フレーム（z が低いほど広く流す＝画面の上の速さを揃える）
				raf = requestAnimationFrame(tick);
			};
			raf = requestAnimationFrame(tick);
			await sleep(MEASURE_MS * 0.5);
			for (let k = 0; k < 3; k++) { const p = perf(); if (p) samples.push(p); await sleep(Math.max(500, MEASURE_MS * 0.5 / 3)); }
			cancelAnimationFrame(raf);
			await sleep(600);
			const hEnd = perf()?.hitch || hLoad, tEnd = performance.now();
			const vt = { load: vtWin(tJump, tLoad), move: vtWin(tLoad, tEnd) };
			const pick = key => median(samples.map(s => +s[key] || 0));
			const pickLab = key => median(samples.map(s => +(s.lab?.[key]) || 0));
			const last = samples[samples.length - 1] || {};
			out.backend = last.backend || out.backend; out.gpu = last.gpu || out.gpu;
			// 標高セルの実測（着地〜計測窓の全体）：セル数・1 枚あたりの平均 ms（resample＋upload）・最大（perf plan P1 の前後比較の物差し＝GPU や読み込みの揺れに依らない CPU の数字）
			const dn = (hEnd.cellN || 0) - (h0.cellN || 0), dres = (hEnd.resMs || 0) - (h0.resMs || 0), dup = (hEnd.upMs || 0) - (h0.upMs || 0);
			const cell = { n: dn, avgMs: dn ? +((dres + dup) / dn).toFixed(2) : 0, avgResMs: dn ? +(dres / dn).toFixed(2) : 0, avgUpMs: dn ? +(dup / dn).toFixed(2) : 0, maxResMs: +((hEnd.resMax || 0)).toFixed(1), maxUpMs: +((hEnd.upMax || 0)).toFixed(1) };
			out.scenes.push({ name: sc.name, gpuMap: +pick("gpuMap").toFixed(2), gpuGint: +pick("gpuGint").toFixed(2), frameMs: +pick("frameMs").toFixed(1), fps: pick("fps"),
				res: last.res, aa: last.aa, hitchLoad: { elev: hLoad.elev - h0.elev, scene: hLoad.scene - h0.scene }, hitchMove: { elev: hEnd.elev - hLoad.elev, scene: hEnd.scene - hLoad.scene }, cell, terr: last.terr || null,   // terr＝地形チャンクの描いた数/総数（P4）
				lab: { ms: +pickLab("ms").toFixed(2), collideMs: +pickLab("collideMs").toFixed(2), labels: pickLab("labels"), glyphs: pickLab("glyphs") }, vt });
		}
		document.title = "PASS " + JSON.stringify(out);
	} catch (e) { document.title = "FAIL " + (e && e.message || e); }
}
