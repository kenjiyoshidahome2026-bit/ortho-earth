// build.ts の塗りの残り（極への扇・図郭外の全面水域・sort-key の並べ替え）の検定。外部データ不要。
//   ・extendToPole：低ズーム（z≤6）の一番上／下の行のタイルだけ、端に沿う塗りを極（緯度 ±90）まで扇で延ばす
//   ・buildEmptySeaOps：style.emptySea の層を、z≥8 の 404 タイル・WA だけの図郭縁スライバに全面で敷く（擬似 li 帯）
//   ・fill-sort-key：filter に通った地物だけを鍵の昇順に（安定）・鍵に NaN が混ざれば旧来の順
import { buildTileDrawList, buildEmptySeaOps } from "../src/build.ts";
import { SEA_FB_BASE } from "../src/scene.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const E = 4096;
const rect = (x0, y0, x1, y1, props = {}, id = 0) => ({ type: "Polygon", id, props, geom: { coords: new Int32Array([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]), ends: [10] } });
const fillStyle = (extra = {}) => ({ layers: [{ id: "sea", type: "fill", "source-layer": "WA", paint: { "fill-color": "#0000ff" }, ...extra }] });
const lats = op => { const out = []; for (let i = 1; i < op.pos.length; i += 2) out.push(op.pos[i]); return out; };
const maxAbs = a => Math.max(...a.map(Math.abs));

// ── extendToPole ──
{
	const t = (z, y, f = rect(0, 0, E, E)) => buildTileDrawList({ z, x: 0, y, layers: { WA: { extent: E, features: [f] } } }, fillStyle(), [0, 0]).ops[0];
	const top = t(1, 0), bot = t(1, 1);
	ok("z1 上の行：極（緯度 90）の頂点が増える", Math.max(...lats(top)) === 90, `max=${Math.max(...lats(top))}`);
	ok("z1 下の行：南極（緯度 -90）の頂点が増える", Math.min(...lats(bot)) === -90);
	ok("極の頂点の経度＝タイルの中心", (() => { const i = lats(top).indexOf(90); return Math.abs(top.pos[i * 2] - (0.5 / 2 * 360 - 180)) < 1e-4; })());
	const mid = t(2, 1);
	ok("z2 中の行は極に延ばさない", maxAbs(lats(mid)) < 85.06);
	const z7 = t(7, 0);
	ok("z7 は延ばさない（細分なしの段）", Math.max(...lats(z7)) < 85.06);
	const inner = t(1, 0, rect(1000, 1000, 2000, 2000));
	ok("上端に触れない塗りは延ばさない", Math.max(...lats(inner)) < 85);
	const idxMax = Math.max(...top.idx), nV = top.pos.length / 2;
	ok("極の扇の三角形は極の頂点を指す（index は頂点数の内）", idxMax === nV - 1);
}

// ── buildEmptySeaOps ──
{
	const style = { emptySea: "sea", layers: [{ id: "land", type: "fill", "source-layer": "AdmArea", paint: { "fill-color": "#fff" } }, ...fillStyle().layers, { id: "sea2", type: "fill", "source-layer": "WA", paint: { "fill-color": "#00f" } }] };
	const at = { z: 10, x: 900, y: 400 };
	const e = buildEmptySeaOps({ __empty: true }, at, style, [0, 0]);
	ok("404 タイル（z10）＝WA を読む fill 層の数だけ全面水域", e && e.length === 2, e && e.map(o => o.id).join());
	ok("擬似 li 帯＝SEA_FB_BASE＋実 li・id は empty-sea:", e && e[0].li === SEA_FB_BASE + 1 && e[1].li === SEA_FB_BASE + 2 && e[0].id === "empty-sea:sea");
	ok("z<8 は敷かない", buildEmptySeaOps({ __empty: true }, { ...at, z: 7 }, style, [0, 0]) === null);
	ok("style.emptySea 無しは敷かない", buildEmptySeaOps({ __empty: true }, at, { layers: style.layers }, [0, 0]) === null);
	ok("emptySea が無い層名は敷かない", buildEmptySeaOps({ __empty: true }, at, { ...style, emptySea: "nope" }, [0, 0]) === null);
	const sliver = { WA: { extent: E, features: [rect(0, 0, 100, E)] } };
	ok("WA だけの図郭縁スライバ（覆率 < 99.5%）は敷く", buildEmptySeaOps(sliver, at, style, [0, 0])?.length === 2);
	const full = { WA: { extent: E, features: [rect(0, 0, E, E)] } };
	ok("WA が全面を覆う（外洋）は敷かない", buildEmptySeaOps(full, at, style, [0, 0]) === null);
	const withLand = { WA: sliver.WA, AdmArea: { extent: E, features: [rect(0, 0, 10, 10)] } };
	ok("WA の他に層がある（陸がある）は敷かない", buildEmptySeaOps(withLand, at, style, [0, 0]) === null);
	const pos = e[0].pos; let x0 = Infinity, x1 = -Infinity;
	for (let i = 0; i < pos.length; i += 2) { x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]); }
	const w = 360 / 1024;
	ok("全面＝タイルの経度幅を覆う", Math.abs(x0 - (900 * w - 180)) < 1e-4 && Math.abs(x1 - (901 * w - 180)) < 1e-4);
}

// ── fill-sort-key ──
{
	const feats = [rect(0, 0, 10, 10, { k: 3, keep: 1 }, 1), rect(100, 0, 110, 10, { k: 1, keep: 1 }, 2), rect(200, 0, 210, 10, { k: 2, keep: 0 }, 3), rect(300, 0, 310, 10, { k: 0, keep: 1 }, 4)];
	const firstX = (layout, filter) => {
		const op = buildTileDrawList({ z: 10, x: 0, y: 0, layers: { WA: { extent: E, features: feats } } }, fillStyle({ layout, filter }), [0, 0]).ops[0];
		const xs = []; for (let i = 0; i < op.pos.length; i += 10) xs.push(op.pos[i]); return xs;   // 四角 1 つ＝閉じた環の 5 頂点（10 値）
	};
	const order = xs => xs.map(x => Math.round((x + 180) / 360 * 1024 * E / 100));   // タイル単位の x/100＝0,1,2,3
	ok("sort-key 無し＝元の順", order(firstX(undefined, undefined)).join() === "0,1,2,3");
	ok("fill-sort-key＝鍵の昇順", order(firstX({ "fill-sort-key": ["get", "k"] })).join() === "3,1,2,0");
	ok("filter が先＝落ちた地物は並ばない", order(firstX({ "fill-sort-key": ["get", "k"] }, ["==", ["get", "keep"], 1])).join() === "3,1,0");
	const tie = [rect(0, 0, 10, 10, { k: 1 }), rect(100, 0, 110, 10, { k: 1 }), rect(200, 0, 210, 10, { k: 0 })];
	const op = buildTileDrawList({ z: 10, x: 0, y: 0, layers: { WA: { extent: E, features: tie } } }, fillStyle({ layout: { "fill-sort-key": ["get", "k"] } }), [0, 0]).ops[0];
	const xs = []; for (let i = 0; i < op.pos.length; i += 10) xs.push(Math.round((op.pos[i] + 180) / 360 * 1024 * E / 100));
	ok("同じ鍵は元の順（安定）", xs.join() === "2,0,1");
	const nan = [rect(0, 0, 10, 10, { k: "a", keep: 1 }), rect(100, 0, 110, 10, { k: 1, keep: 1 }), rect(200, 0, 210, 10, { k: 0, keep: 0 })];
	const op2 = buildTileDrawList({ z: 10, x: 0, y: 0, layers: { WA: { extent: E, features: nan } } }, fillStyle({ layout: { "fill-sort-key": ["get", "k"] }, filter: ["==", ["get", "keep"], 1] }), [0, 0]).ops[0];
	ok("鍵に NaN が混ざっても落ちない（旧来の順で filter 後の 2 つ）", op2 && op2.pos.length === 2 * 10, op2 && String(op2.pos.length));
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ build-pole-sea 全 PASS");
process.exit(fail ? 1 : 0);
