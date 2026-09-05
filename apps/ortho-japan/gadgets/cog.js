// COG 表示ガジェット: geopbf/cog リーダ → 等経緯度 RGBA アトラス → renderer cogTex スロット
// （GLOBE_FS/TERRAIN_FS が lon/lat→uv 線形1本でドレープ＝CRS はシェーダに入れない）。
// 四戒: 独立（エンジンへは注入 setCogTex/fit のみ）／遅延（app.js が dynamic import）／抽象アクセス／UI 無し。
// 窓モデル v1: まず全域アトラス（粗 overview＝1 range で即表示）→ カメラ静定（≈0.5s 不動）でビュー窓へ
// 絞って精細化・引いたら全域へ戻す。飛行中は発火しない（静定検出が兼ねる＝トランジション通過点で重い層を
// 発火させない一般則）。lowMem はアトラス半辺（2048→1024）＝メモリと帯域の両方が半分以下。
import { openCog } from "geopbf/cog";

export function createCog(map, { setCogTex, fit, lowMem, signal } = {}) {
	const ATLAS_W = lowMem ? 1024 : 2048;
	let cog = null, unsub = null, busy = false, cur = null;   // cur＝現アトラスが覆う bbox
	let last = null, still = 0, rc = null;                    // rc＝進行中レンダの AbortController

	const renderWindow = async (bb) => {
		if (!cog || busy) return;
		busy = true;
		rc = new AbortController();
		const onOuter = () => rc.abort();
		signal?.addEventListener("abort", onOuter, { once: true });
		try {
			const [w, s, e, n] = bb;
			const H = Math.max(64, Math.min(ATLAS_W, Math.round(ATLAS_W * (n - s) / Math.max(e - w, 1e-9))));
			const rgba = await cog.renderTo({ bbox: bb, w: ATLAS_W, h: H }, { signal: rc.signal });
			if (!rgba || !cog) return;   // 圏外 or 途中で clear/中断
			cur = bb;
			setCogTex({ rgba, w: ATLAS_W, h: H, bboxLL: bb });
			map.requestDraw?.();
		} catch (e) { if (e?.name !== "AbortError") console.warn("[cog] render", e.message); }
		finally { busy = false; rc = null; signal?.removeEventListener("abort", onOuter); }
	};

	// ビュー窓＝画面四隅+中心の unproject ∩ COG bbox（20% 余白）。
	// 隅が球外（unproject=null）＝視野が球の縁を越えている＝COG 全域より広い ⇒ 全域を返す（ズームアウト追従の要）
	const viewWindow = () => {
		if (!cog) return null;
		const el = map.mapEl, W = el.clientWidth, H = el.clientHeight;
		const pts = [[W / 2, H / 2], [0, 0], [W, 0], [0, H], [W, H]].map(p => map.unprojectXY(p[0], p[1]));
		if (pts.some(p => !p)) return cog.bboxLL.slice();
		let w = 1e9, s = 1e9, e = -1e9, n = -1e9;
		for (const [lo, la] of pts) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
		const mx = (e - w) * 0.2, my = (n - s) * 0.2;
		const [cw, cs, ce, cn] = cog.bboxLL;
		const bb = [Math.max(w - mx, cw), Math.max(s - my, cs), Math.min(e + mx, ce), Math.min(n + my, cn)];
		return (bb[2] > bb[0] && bb[3] > bb[1]) ? bb : null;
	};

	// 望ましい窓と現アトラスの差分判定（null＝現状維持）
	const wantWindow = () => {
		const bb = viewWindow();
		if (!bb) return null;
		const curSpan = cur ? cur[2] - cur[0] : 1e9, newSpan = bb[2] - bb[0];
		const full = cog.bboxLL;
		if (newSpan < curSpan * 0.6) return bb;                // 寄った＝窓を絞って精細化
		if (cur && (newSpan > curSpan * 2.5 || bb[0] < cur[0] || bb[1] < cur[1] || bb[2] > cur[2] || bb[3] > cur[3]))
			return newSpan > (full[2] - full[0]) * 0.7 ? full.slice() : bb;   // 出た/引いた＝広い窓 or 全域へ
		return null;
	};

	const tick = () => {
		if (!cog) return;
		const el = map.mapEl;
		const c = map.unprojectXY(el.clientWidth / 2, el.clientHeight / 2);
		const key = c ? `${map.getZoom().toFixed(2)}/${c[0].toFixed(4)}/${c[1].toFixed(4)}` : `out/${map.getZoom().toFixed(2)}`;
		if (key !== last) {   // 動いている＝発火しない（飛行中抑制）。ただし窓が明後日になった読み込みは今すぐ中断
			last = key; still = 0;
			if (busy && rc && wantWindow()) rc.abort();   // 古い窓のタイル取得を捨てる＝ズームアウト即応（回線が細いほど効く）
			return;
		}
		if (++still < 30) return;    // 静定 ≈0.5s から
		if (busy) return;            // 前のレンダ中＝次フレーム再試行（⚠一発発火にしない: busy に飲まれると引き戻しが永久に来ない）
		const bb = wantWindow();
		if (bb) renderWindow(bb);    // 実行後は cur が変わり wantWindow()=null＝静かになる
	};

	return {
		async load(src) {
			this.clear();
			cog = await openCog(src, { signal });
			await renderWindow(cog.bboxLL.slice());   // 全域＝最粗 overview（ヘッダ直後に連続＝実質 range 1-2 本）
			fit?.(cog.bboxLL);
			unsub = map.onFrame(tick);
			console.info("[cog] loaded", cog.width + "x" + cog.height, "EPSG:" + cog.epsg, cog.metrics());
			return cog;
		},
		clear() {
			unsub?.(); unsub = null;
			cog?.close(); cog = null; cur = null; last = null; still = 0;
			setCogTex(null); map.requestDraw?.();
		},
		metrics: () => cog?.metrics() ?? null,
	};
}
