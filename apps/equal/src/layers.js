// 層の台帳：Natural Earth 10m だけを Gint で描く（本人裁定 2026-09-18「10mのみ」）。データは共有が第一：
//   source:"world" ＝packages/world の ne-cultural（国・道路・鉄道・市街地＝world と同じ切り分け）。group base（国＝起動時）/ detail（道路など＝z≥4.5 で読む）
//   それ以外＝ortho-japan と同じ作法＝bucket の GeoPBF を名前で引き（湖は japan と同じキャッシュ）、未収録なら NE S3 の生 zip
//   （geopbf が shp をデコードして GintBUF まで焼き、IDB にキャッシュ＝初回だけ重い）。サーバー焼きはしない。
// loadZoom＝このズーム以上で初めて取りに行く（見えない層のための通信をしない）。
// minZoom は NE の属性（min_zoom / scalerank）を地物ごとに使う＝ズームで道路・鉄道が段階的に現れる。
// z の定義は ortho と同一（正射スケール）＝NE の min_zoom（Web 地図の z）をそのまま使える。
import { WORLD_Z } from "@ortho-earth/core/worldcontent";   // 出しズームの正本（globe の世界帯と同じ値）
const rgb = (hex, a = 1) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, a];
const str = v => String(v ?? "").replace(/\0/g, "").trim();   // shp の DBF はナル詰め文字列がある
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
// 属性名は大小無視（bucket 版と shp 版で揺れる）
const f = (p, k) => { if (k in p) return p[k]; const lo = k.toLowerCase(); for (const q in p) if (q.toLowerCase() === lo) return p[q]; };

// 地図面の色＝配色テーマ（themes.js）が起動時と切替時に**この配列の中身を書き換える**（配列の identity は変えない）。
// 層の定義（下の LAYERS）と GRATICULE はここの配列を参照で掴んでいて、描画は毎フレームその中身を読む＝
// テーマ切替で焼き直し（bake）も層の作り直しも要らない。既定値は mono（白地図）＝themes.js の mono と同値。
// 【掟】地図面に出る色はリテラルで層へ書かない＝必ずここへキーを作る。書くとそのテーマだけ色が変わらない層になる。
export const PALETTE = {
	sea: rgb("#c1d8e3"),
	land: rgb("#f6f6f4"),
	urban: rgb("#9a5a52", 0.5),   // くすんだ赤（ハイプソの緑〜砂色と被らない・本人 2026-09-18）・半透明＝コロプレスを殺さない
	bg: rgb("#e4e8ec"),           // 外形の外（縮小下限付近で極の上下・四隅に出る）
	edge: rgb("#9aa6b2", 0.8),    // 外形の輪郭線
	coast: rgb("#9aa6b2"),
	border: rgb("#a99cb2"),
	admin1: rgb("#a99cb2", 0.45),   // 州境（同じ key の admin1 境界）
	lakeShore: rgb("#9fb4c2"),
	river: rgb("#86aecb"),
	maritime: rgb("#8fa9bb", 0.85),   // 海洋境界線（NE の中間線・指示線）＝海の上に薄く
	disputed: rgb("#9a6e90", 0.28),
	disputedLine: rgb("#8a5f80", 0.9),
	road: rgb("#d9a86c"),
	rail: rgb("#7d7f86"),
	port: rgb("#2b6e9e"),
	airport: rgb("#6a3d9a"),   // 空港の✈（ラベル層が描く）
	grat: rgb("#ffffff", 0.45),
	grat10: rgb("#ffffff", 0.25),
};

const NE = (group, name) => ({ bucket: name, zip: `https://naturalearth.s3.amazonaws.com/10m_${group}/${name}.zip` });

export const LAYERS = [
	{
		// 国＝world の定義そのもの：packages/world の ne-cultural（NE admin_1 を world key で束ね済み・layer="admin_1"・属性 key）。
		// unit（ID 塗りの番号＝NationDB の並び）と輪郭の分類は main.js が World DB を読んでから差し込む
		// ids: true＝この層の面から国 ID バッファを作る（renderer.drawIds）。塗りは drawLand（陸色＋ハイプソ）。
		// ID はコロプレス・ホバー識別・面の塗りが共有する材料＝この層の持ち物ではない（2026-09-18 の分離）。
		id: "countries", label: "Countries", fixed: true, ids: true, source: "world", group: "base", kind: "poly", loadZoom: -Infinity,
		fillColor: PALETTE.land,
		lineStyles: [{ color: PALETTE.coast, width: 0.8 }, { color: PALETTE.border, width: 0.8 }, { color: PALETTE.admin1, width: 0.5 }],   // 海岸線・国境・州境（同じ key の admin1 境界）
		order: { fill: 10, lines: 60 },
	},
	{
		// 係争地の重ね（world の admin_0＝admin_1 に形の無い主体：北キプロス・SADR・ソマリランド・アブハジア…10 件）＝主の分割と重複＝薄い塗りで重ねる
		id: "disputed", label: "Disputed", on: true, source: "world", group: "base", kind: "poly", loadZoom: -Infinity,
		spec: { include: p => p.layer === "admin_0", fill: () => 0, outline: () => ({ cls: 0, minZoom: 0 }) },
		fillColor: PALETTE.disputed,
		lineStyles: [{ color: PALETTE.disputedLine, width: 0.8 }],
		order: { fill: 11, lines: 61 },
	},
	{
		// 道路・鉄道・市街地＝world の ne-cultural（国境で切って key ごとに 1 地物・属性なし）＝world とデータを共有（本人 2026-09-18）。
		// 属性（min_zoom）が無い＝地物ごとの出し分けはせず、一定以上の z でまとめて出す
		id: "urban", label: "Urban areas", on: true, source: "world", group: "detail", kind: "poly", loadZoom: WORLD_Z.detailLoad,
		spec: { include: p => p.layer === "urban_areas", fill: () => WORLD_Z.urban },
		fillColor: PALETTE.urban,
		order: { fill: 12 },
	},
	{
		id: "lakes", label: "Lakes", fixed: true, water: true, ...NE("physical", "ne_10m_lakes"), kind: "poly", loadZoom: -Infinity,
		spec: {
			fill: p => num(f(p, "min_zoom"), 0),
			outline: p => ({ cls: 0, minZoom: num(f(p, "min_zoom"), 0) }),
		},
		fillColor: PALETTE.sea,
		lineStyles: [{ color: PALETTE.lakeShore, width: 0.6 }],
		order: { fill: 14, lines: 22 },
	},
	{
		id: "rivers", label: "Rivers", on: true, water: true, ...NE("physical", "ne_10m_rivers_lake_centerlines"), kind: "line", loadZoom: WORLD_Z.worldLines,
		spec: {
			line: p => {
				const cla = str(f(p, "featurecla"));
				if (cla.startsWith("Lake Centerline")) return null;   // 湖の中の中心線＝湖の塗りの下に隠れる線は描かない
				const sr = num(f(p, "scalerank"), 8);
				return { cls: sr <= 4 ? 0 : sr <= 7 ? 1 : 2, minZoom: num(f(p, "min_zoom"), WORLD_Z.riverDefault) };
			},
		},
		lineStyles: [{ color: PALETTE.river, width: 1.2 }, { color: PALETTE.river, width: 0.9 }, { color: PALETTE.river, width: 0.6 }],
		order: { lines: 20 },
	},
	{
		// 海洋境界線＝NE admin_0 boundary_lines_maritime_indicator（中間線・領海の指示線・221 本）。
		// 陸の国境（countries の lineStyles）とは別物＝海の上にだけ出る細い線。NE の MIN_ZOOM を地物ごとに使う。
		id: "maritime", label: "Maritime boundaries", on: true, ...NE("cultural", "ne_10m_admin_0_boundary_lines_maritime_indicator"), kind: "line", loadZoom: WORLD_Z.worldLines,
		spec: { line: p => ({ cls: 0, minZoom: num(f(p, "min_zoom"), WORLD_Z.maritimeDefault) }) },
		lineStyles: [{ color: PALETTE.maritime, width: 0.6 }],
		order: { lines: 58 },
	},
	{
		id: "roads", label: "Roads", accent: "road", on: true, source: "world", group: "detail", kind: "line", loadZoom: WORLD_Z.detailLoad,
		spec: { line: p => p.layer === "roads" ? { cls: 0, minZoom: WORLD_Z.roads } : null },
		lineStyles: [{ color: PALETTE.road, width: 0.8 }],
		order: { lines: 30 },
	},
	{
		id: "rail", label: "Rail", accent: "rail", on: true, source: "world", group: "detail", kind: "line", loadZoom: WORLD_Z.detailLoad,
		spec: { line: p => p.layer === "railroads" ? { cls: 0, minZoom: WORLD_Z.rail } : null },
		lineStyles: [{ color: PALETTE.rail, width: 0.8 }],
		order: { lines: 40 },
	},
	{
		id: "ports", label: "Ports", accent: "facility", on: false, ...NE("cultural", "ne_10m_ports"), kind: "point", loadZoom: 3.5,
		spec: { point: p => ({ cls: 0, minZoom: Math.max(4.5, num(f(p, "scalerank"), 8) + 1) }) },
		pointStyles: [{ color: PALETTE.port, size: 5 }],
		order: { points: 80 },
	},
	{
		// 空港＝ラベル層に ✈（ortho-japan と同じ Material Icons "flight"）で置く＝都市の丸と形で区別する。
		// mark:"plane" が立つ層は GL の点を描かない（main.js の draw）＝記号はラベル層の衝突判定に乗る。
		// 出すのは z>5（本人 2026-09-18）＝loadZoom も 5 に合わせる（見えない層のために通信しない）。
		// 出所＝world の ne-cultural detail の airports（2026-09-24）＝道路・鉄道と同じ 1 本・globe と同じ実体（旧＝ne_10m_airports を別に取得＝同じデータの 2 つ持ち）
		id: "airports", label: "Airports", accent: "facility", on: true, source: "world", group: "detail", kind: "point", loadZoom: WORLD_Z.airport,
		mark: "plane", markMinZoom: WORLD_Z.airport, markLayer: "airports",
		spec: { point: p => p.layer === "airports" ? { cls: 0, minZoom: Math.max(WORLD_Z.airport, num(f(p, "scalerank"), 8) + 1) } : null },
		pointStyles: [{ color: PALETTE.airport, size: 7 }],
		order: { points: 81 },
	},
];

export const GRATICULE = {
	id: "graticule", label: "Graticule", on: true,
	lineStyles: [{ color: PALETTE.grat, width: 0.8 }, { color: PALETTE.grat10, width: 0.6 }],
	order: { lines: 70 },
};
