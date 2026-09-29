// t-antimeridian: encode（setFeature→antimeridianFeature）の跨ぎ切断。
// 混符号の正規化表現（±179.9…＝エディタの normLon 産）でも、範囲外の連続表現（179.9→180.1）でも同じ結果に切れること。
// ±180の縫い目に「接するだけ」のリング（南極型）は切断器に入れず無傷が正解（fix() が +180→-180 に書き換えるため）。
import { GeoPBF } from "../src/pbf-base.js";
globalThis.ImageData ??= class ImageData {};   // node に無い（配列の属性を書く時に型を見る）

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const enc = async features => (await new GeoPBF({ name: "t-am" }).set({ type: "FeatureCollection", features })).features;
const lons = g => { const out = []; const walk = a => typeof a[0] === "number" ? out.push(a[0]) : a.forEach(walk); walk(g.coordinates); return out; };
const span = r => Math.max(...r) - Math.min(...r);
const F = (type, coordinates, properties = {}) => ({ type: "Feature", properties, geometry: { type, coordinates } });

// ① 混符号ポリゴン（エディタ作図/移動産）＝2片の MultiPolygon・各片は縫い目の同じ側で局所的
const mixed = [[[179.9, 35.0], [-179.9, 35.0], [-179.9, 35.2], [179.9, 35.2], [179.9, 35.0]]];
{
	const [f] = await enc([F("Polygon", structuredClone(mixed))]);
	const g = f.geometry;
	ok(g.type === "MultiPolygon" && g.coordinates.length === 2, `混符号ポリゴン＝2片に切断（実際: ${g.type}×${g.coordinates.length ?? "?"}）`);
	const spans = (g.coordinates || []).map(p => span(lons({ coordinates: p })));
	ok(spans.every(s => s <= 0.11), `各片は局所的（span ${spans.map(s => s.toFixed(3)).join("/")}）`);
	ok(lons(g).every(x => x >= -180 && x <= 180), "全経度が [-180,180] 内");
}
// ② 同じ箱の連続表現（範囲外）＝従来経路。①と同じ2片になる
{
	const cont = [[[179.9, 35.0], [180.1, 35.0], [180.1, 35.2], [179.9, 35.2], [179.9, 35.0]]];
	const [f] = await enc([F("Polygon", cont)]);
	ok(f.geometry.type === "MultiPolygon" && f.geometry.coordinates.length === 2, "連続表現（範囲外）も2片（従来経路の不変）");
}
// ③ 混符号ライン＝2本の MultiLineString
{
	const [f] = await enc([F("LineString", [[179.9, 35.0], [-179.9, 35.1], [-179.8, 35.2]])]);
	const g = f.geometry;
	ok(g.type === "MultiLineString" && g.coordinates.length === 2, `混符号ライン＝2本（実際: ${g.type}×${g.coordinates.length ?? "?"}）`);
	ok(lons(g).every(x => x >= -180 && x <= 180), "ライン全経度が [-180,180] 内");
}
// ④ 縫い目接触リング（南極型＝+180 と -180 の両方を含むが跨がない）＝無傷（切断も書き換えもしない）
{
	// 実データの南極型＝隣接差は小さく、縫い目は ±180 の同値ペアで降りる（1頂点だけの巨大差は最短経路規約で跨ぎ扱いが正当＝ここには入れない）
	const ring = [[-180, -85], [-90, -70], [0, -70], [90, -70], [180, -85], [180, -89], [-180, -89], [-180, -85]];
	const [f] = await enc([F("Polygon", [structuredClone(ring)])]);
	const g = f.geometry;
	ok(g.type === "Polygon" && g.coordinates.length === 1, `縫い目接触リング＝切断しない（実際: ${g.type}×${g.coordinates.length}）`);
	ok(lons(g).includes(180) && lons(g).includes(-180), "±180 の頂点が書き換えられていない");
}
// ⑤ 縫い目から遠い普通のポリゴン＝完全無変換
{
	const sq = [[[139.75, 35.68], [139.76, 35.68], [139.76, 35.69], [139.75, 35.69], [139.75, 35.68]]];
	const [f] = await enc([F("Polygon", structuredClone(sq))]);
	ok(f.geometry.type === "Polygon" && span(lons(f.geometry)) < 0.02, "縫い目と無関係なポリゴンは素通り");
}

// ⑥ 縫い目上の頂点で跨ぐリング（量子化で経度ちょうど ±180 に載った円＝geoedit 2026-09-12）＝2片に切れる。
//    片端だけ ±180 のペア（-180→+179.99）は跨ぎ・両端 ±180（④）だけが接触。
{
	// 1e-6 格子へ量子化した円。頂点9（北端）は -180・頂点27（南端）は +180 に**ちょうど**載せる＝両側の縫い目頂点で跨ぐ
	const ring = []; for (let i = 0; i <= 36; i++) { const a = i / 36 * Math.PI * 2; let x = 180 + 0.01 * Math.cos(a); x = x >= 180 ? x - 360 : x; ring.push([Math.round(x * 1e6) / 1e6, Math.round(0.01 * Math.sin(a) * 1e6) / 1e6]); }
	ring[27][0] = 180;
	ok(ring.some(c => c[0] === -180) && ring.some(c => c[0] === 180), "検定データ：頂点が +180 と -180 の両方にちょうど載っている");
	const [f] = await enc([F("Polygon", [ring])]);
	const g = f.geometry;
	ok(g.type === "MultiPolygon" && g.coordinates.length === 2, `縫い目上の頂点で跨ぐ円＝2片（実際: ${g.type}×${g.coordinates.length ?? "?"}）`);
	const spans = (g.coordinates || []).map(p => span(lons({ coordinates: p })));
	ok(spans.every(s => s <= 0.011), `各片は局所的（span ${spans.map(s => s.toFixed(4)).join("/")}）`);
	ok(lons(g).every(x => x >= -180 && x <= 180), "全経度が [-180,180] 内");
}

// ④ 極を囲む環（縫い目跨ぎ1回）＝縫い目→極→縫い目の柱で閉じる（RFC 7946 の極表現）。球面編集（回転で極を越える）で生まれる形
{
	const ring = [[0, 80], [90, 80], [180, 80], [-90, 80], [0, 80]];   // 北極を囲む（頂点の1つが縫い目上）
	const [f] = await enc([F("Polygon", [ring])]);
	const r = f?.geometry?.coordinates?.[0] ?? [];
	const hasPole = r.some(p => p[1] === 90 && p[0] === 180) && r.some(p => p[1] === 90 && p[0] === -180);
	ok(f && f.geometry.type === "Polygon" && hasPole, `極を囲む環＝1面のまま [±180,90] の柱で閉じる（${f?.geometry?.type} ${r.length}点）`);
	ok(r.length === ring.length + 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1], "閉じた環（元の頂点＋柱3点）");
	const ring2 = [[-48.5, 88.9], [88.5, 88.9], [176, 88.3], [-136, 88.3], [-48.5, 88.9]];   // 回転で極を囲んだ環（跨ぎ辺 176→-136）
	const [g] = await enc([F("Polygon", [ring2])]);
	const r2 = g?.geometry?.coordinates?.[0] ?? [];
	ok(g && g.geometry.type === "Polygon" && r2.some(p => p[1] === 90) && span(lons(g.geometry)) === 360, `回転産の極囲み環も柱で閉じる（${r2.length}点・経度スパン ${span(lons(g.geometry))}）`);
	const south = [[0, -80], [-90, -80], [180, -80], [90, -80], [0, -80]];
	const [h] = await enc([F("Polygon", [south])]);
	ok(h && (h.geometry.coordinates[0] ?? []).some(p => p[1] === -90), "南極を囲む環＝[±180,-90] の柱");
}

// ⑩ 時刻・高さ付きの線（GPX の trk・CZML の sampled position＝頂点ごとの配列 time/ele）＝切った部品ごとに揃える（#113 段 1・2026-09-29）。
//    縫い目に足す点の値は跨ぐ辺の上で内挿（経度の割合）。旧＝座標は N+2 点・time/ele は N 点のまま（再生と書き戻しが食い違う）
{
	const t = k => new Date(Date.UTC(2026, 0, 1, 0, k * 10)).toISOString();
	const line = [[178, 10], [179, 11], [-179, 13], [-178, 14]];   // 179→-179 で跨ぐ（割合 0.5）
	const [f] = await enc([F("LineString", structuredClone(line), { time: [t(0), t(1), t(2), t(3)], ele: [0, 100, 300, 400], name: "x" })]);
	const g = f.geometry, p = f.properties;
	ok(g.type === "MultiLineString" && g.coordinates.length === 2, `時刻付きの線＝2 本に切れる（${g.type}）`);
	const lens = g.coordinates.map(l => l.length);
	ok(Array.isArray(p.time?.[0]) && p.time.map(a => a.length).join() === lens.join() && p.ele.map(a => a.length).join() === lens.join(), `time/ele は部品ごとの入れ子・点数と同じ長さ（点 ${lens} time ${p.time?.map?.(a => a.length)} ele ${p.ele?.map?.(a => a.length)}）`);
	const seamT = p.time[0][p.time[0].length - 1], seamE = p.ele[0][p.ele[0].length - 1];
	ok(seamT === null && seamE === 200 && p.time[1][0] === null && p.ele[1][0] === 200, `縫い目の点＝時刻は null（元の標本でない）・高さは跨ぐ辺の真ん中（${seamT} ${seamE}）`);
	// 標本がちょうど ±180 の上＝その側に縫い目の点を足さない（同じ座標が続くと書き込みが 1 点にまとめ、配列とずれる）
	const [z] = await enc([F("LineString", [[179, 0], [180, 1], [-179, 2]], { time: [t(0), t(1), t(2)] })]);
	ok(z.geometry.coordinates.map(l => l.length).join() === z.properties.time.map(a => a.length).join() && z.properties.time[0][1] === t(1), `±180 ちょうどの標本＝縫い目の点を兼ねる・配列とずれない（点 ${z.geometry.coordinates.map(l => l.length)} time ${z.properties.time.map(a => a.length)}）`);
	ok(p.name === "x" && p.time[0][0] === t(0) && p.time[1][p.time[1].length - 1] === t(3), "元の標本はそのまま・他の属性は無傷");
	// 0° を先に跨いでから ±180° を跨ぐ線＝縫い目の点は跨ぐ直前の点の側（旧＝線の最初の点の符号で -180 にしていた）
	const [h] = await enc([F("LineString", [[-10, 0], [10, 1], [179, 2], [-179, 3]])]);
	const a0 = h.geometry.coordinates[0];
	ok(h.geometry.type === "MultiLineString" && a0[a0.length - 1][0] === 180 && h.geometry.coordinates[1][0][0] === -180, `0° を先に跨いだ線の縫い目＝179 の側は +180（${a0[a0.length - 1]}）`);
	// GPX の trkseg 2 本（MultiLineString・入れ子の time）＝跨ぐ本だけ切れ、跨がない本はそのまま
	const [m] = await enc([F("MultiLineString", [[[170, 0], [171, 0]], [[179.5, 1], [-179.5, 1]]], { time: [[t(0), t(1)], [t(2), t(3)]] })]);
	ok(m.geometry.coordinates.length === 3 && m.properties.time.length === 3 && m.properties.time.map(a => a.length).join() === m.geometry.coordinates.map(l => l.length).join(), `入れ子の time（GPX の trkseg）も部品ごと（${m.properties.time.map(a => a.length)}）`);
	// 点数の合わない配列は触らない（頂点ごとの配列でない）
	const [q] = await enc([F("LineString", [[179, 0], [-179, 0]], { time: ["a"] })]);
	ok(JSON.stringify(q.properties.time) === '["a"]', "点数と合わない time は触らない");
}

console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
