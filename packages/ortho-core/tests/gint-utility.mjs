// gint/utility.ts の小さな計算（遠方の要・層 bbox・fid の可視・ズーム範囲の導出）の検定。純関数＝外部データ不要。
//   ・farPivotParams：無効（FAR_PIVOT.off・vbb なし・向きなし）は null・窓座標モードは経緯度の軸・big＝視野×FAR_BIG
//   ・layerBboxOf：fid の bbox の和・縫い目跨ぎ（x>360e7）は null・同じ Map は覚えておく
//   ・farPivotGlobal：層が視野の FAR_BIG 倍以下は null・張り出し最小の側の反対へ FAR_K
//   ・fidVisible：表なし＝null・visible ビット・表の外は通す
//   ・checkZoomRange：precision の上限で頭打ち・minZoom 未指定は arcMeta の bbox から導く
import { farPivotParams, layerBboxOf, farPivotGlobal, fidVisible, checkZoomRange, FAR_PIVOT, FAR_K, FAR_BIG } from "../src/gint/utility.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const E7 = 1e7, bb = (x0, y0, x1, y1) => [x0 * E7, y0 * E7, x1 * E7, y1 * E7];
const d = { farAxes: [1, 0, 0, 1], farScale: [0.8, 1] };
const vbb = bb(100, 100, 101, 101);   // 1°×1° の視野（e7・Morton＝経度+180, 緯度+90）

// ── farPivotParams ──
{
	const p = farPivotParams(d, vbb);
	ok("farPivotParams：軸と重みは drawData から・big＝視野×FAR_BIG", p.axes.join() === "1,0,0,1" && p.q.join() === "0.8,1" && p.big[0] === E7 * FAR_BIG && p.big[1] === E7 * FAR_BIG);
	ok("farPivotParams：vbb なし・向きなしは null", farPivotParams(d, null) === null && farPivotParams({}, vbb) === null);
	const a = farPivotParams({ atlas: { inv: [2, 3] } }, vbb);
	ok("farPivotParams：窓座標モード＝軸は経緯度・重みは inv", a.axes.join() === "1,0,0,1" && a.q.join() === "2,3");
	ok("farPivotParams：big は u32 で頭打ち", farPivotParams(d, [0, 0, 0xFFFFFFFF, 1]).big[0] === 0xFFFFFFFF);
	FAR_PIVOT.on = false;
	ok("farPivotParams：FAR_PIVOT.on=false は null（旧挙動）", farPivotParams(d, vbb) === null);
	FAR_PIVOT.on = true;
}

// ── layerBboxOf ──
{
	const m = new Map([[1, bb(10, 10, 11, 11)], [2, bb(20, 5, 21, 30)]]);
	const b = layerBboxOf(m);
	ok("layerBboxOf：fid の bbox の和", b.join() === bb(10, 5, 21, 30).join());
	ok("layerBboxOf：同じ Map は同じ答え（覚えておく）", layerBboxOf(m) === b);
	ok("layerBboxOf：縫い目跨ぎ（x > 360e7）は null", layerBboxOf(new Map([[1, bb(350, 0, 370, 1)]])) === null);
	ok("layerBboxOf：空・null は null", layerBboxOf(new Map()) === null && layerBboxOf(null) === null);
}

// ── farPivotGlobal ──
{
	ok("farPivotGlobal：層が視野の FAR_BIG 倍以下は null", farPivotGlobal(d, vbb, bb(99.5, 99.5, 101.5, 101.5)) === null);
	ok("farPivotGlobal：層 bbox なしは null", farPivotGlobal(d, vbb, null) === null);
	// 視野より大きな層＝張り出しが最小の側の反対の遠方へ要を置く（pivotClip と同じ選び方）
	const w = farPivotGlobal(d, vbb, bb(99.9, 90, 120, 120));
	ok("farPivotGlobal：西の張り出しが最小＝要は東の遠方（+x・FAR_K）", w && w[0] === 1 * FAR_K && w[1] === 0, w && w.join());
	const e = farPivotGlobal(d, vbb, bb(80, 90, 101.1, 120));
	ok("farPivotGlobal：東が最小＝要は西の遠方（-x）", e && e[0] === -FAR_K && e[1] === 0);
	const s = farPivotGlobal(d, vbb, bb(80, 99.95, 120, 120));
	ok("farPivotGlobal：南が最小＝要は北の遠方（+y）", s && s[0] === 0 && s[1] === FAR_K);
	const n = farPivotGlobal(d, vbb, bb(80, 80, 120, 101.05));
	ok("farPivotGlobal：北が最小＝要は南の遠方（-y）", n && n[0] === 0 && n[1] === -FAR_K);
}

// ── fidVisible ──
{
	ok("fidVisible：表なしは null", fidVisible(null) === null && fidVisible({}) === null && fidVisible({ _fidStyleData: { u32: null, count: 0 } }) === null);
	const u32 = new Uint32Array(3 * 4); u32[0 * 4 + 2] = 1; u32[1 * 4 + 2] = 0; u32[2 * 4 + 2] = 3;
	const v = fidVisible({ _fidStyleData: { u32, count: 3 } });
	ok("fidVisible：visible ビット（bit0）", v(0) && !v(1) && v(2));
	ok("fidVisible：表の外の fid は通す", v(3) && v(100));
}

// ── checkZoomRange ──
{
	const warn = console.warn, info = console.info; let warned = 0; console.warn = () => warned++; console.info = () => {};
	const pmax = Math.floor(0.491 + 6 * 3.322);
	const a = checkZoomRange({ maxZoom: 30 });
	ok("checkZoomRange：maxZoom は precision の上限で頭打ち（警告）", a.maxZoom === pmax && warned === 1 && a.minZoom === null);
	ok("checkZoomRange：precision 7 は上限が上がる", checkZoomRange({ precision: 7 }).maxZoom === Math.floor(0.491 + 7 * 3.322));
	const meta = new Uint32Array(16);   // 2 本の arc の bbox（[4..7]）＝全体で 11.25° 幅
	meta.set([0, 0, 0, 0, 100 * E7, 50 * E7, 105 * E7, 52 * E7], 0);
	meta.set([0, 0, 0, 0, 108 * E7, 50 * E7, 111.25 * E7, 51 * E7], 8);
	const b = checkZoomRange({ arcMeta: meta });
	ok("checkZoomRange：minZoom 未指定＝bbox から log2(360/幅)", b.minZoom === 5, `minZoom=${b.minZoom}`);
	ok("checkZoomRange：明示の minZoom が優先", checkZoomRange({ arcMeta: meta, minZoom: 2 }).minZoom === 2);
	const g = new Uint32Array(8); g.set([0, 0, 0, 0, 0, 0, 360 * E7, 180 * E7]);
	ok("checkZoomRange：全球のデータは自動の minZoom を付けない", checkZoomRange({ arcMeta: g }).minZoom === null);
	console.warn = warn; console.info = info;
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ gint-utility 全 PASS");
process.exit(fail ? 1 : 0);
