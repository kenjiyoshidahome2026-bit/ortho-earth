// オランダの地域宣言（3DBAG）。日本と同じ形＝建物の枠は国に依らないことの実証（packages/jp/src/region.js を見よ）。
//
// TU Delft が BAG（建物登記）＋AHN（国土 LiDAR）から自動生成した全国 1000 万棟の LoD2.2・CC BY 4.0。
// PLATEAU と違い「国土まるごと 1 枚のタイルセット」（外部 tileset 474 本）なので、街ごとの矩形（clip）で
// 走査を枝刈りして「区」相当の粒度に切る。
//   base       … 識別キー（worker 振り分け・キャッシュ・OPFS のファイル名）＝同じ tileset を街ごとに
//                別枠で持つため、実 URL は tilesetUrl で別に渡す
//   tilesetUrl … 3D Tiles 1.1 の glb＝頂点が int16 量子化（meshworker が解除）
//
// 入口は /nl/（本番＝deploy-worker が japan の資産をそのまま出す独立 URL）と ?nl=1（開発・日本に重ねて
// 確認する時）。どちらも**日本の台帳に足す**形＝?nl=1 のまま日本へ飛べば日本の建物も出る（2026-09-17 の
// 移設でもこの振る舞いを変えていない）。
const TILESET = "https://data.3dbag.nl/v20250903/cesium3dtiles/lod22/tileset.json";

export const NL_REGION = {
	code: "nl",
	dtm: null,                    // AHN の焼き直しは持っていない＝R01 は JAXA の表層標高＝接地リフトしない
	buildings: {
		sets: [
			{ key: "delft", name: "デルフト（3DBAG）", bbox: [4.336, 51.978, 4.393, 52.026] },
			{ key: "rotterdam", name: "ロッテルダム（3DBAG）", bbox: [4.452, 51.905, 4.510, 51.935] },
			{ key: "amsterdam", name: "アムステルダム（3DBAG）", bbox: [4.869, 52.360, 4.925, 52.386] },
		].map(s => ({ name: s.name, bbox: s.bbox, base: `nl-3dbag-${s.key}/`, tilesetUrl: TILESET, clip: s.bbox })),
	},
	// 自前のベクタ基図は持たない＝タイルを要求せず、図郭外と同じ「標高ゲート付き全面水域」を敷く
	// （日本の配信圏の外なので、これは移設前の見え方と同じ）。世界の下地（ハイプソ・国界・湖）はズーム域で別に出る。
	basemap: null,
	// 3DBAG は CC BY 4.0＝表示が義務。日本のデータを出していない画面に地理院・PLATEAU を並べるのは、
	// 義務以前に嘘になる（だから入口ごとに出典を差し替える）。
	attribution: {
		lines: [
			[{ href: "https://3dbag.nl/", key: "3DBAG (TU Delft), CC BY 4.0" }],
			[{ key: "Auto-generated from BAG (building registry) and AHN (national LiDAR)" }],
		],
		note: "(Created by processing the data)",
	},
	view: "#16/52.0116/4.3571/45t",   // 裸で開いた時はデルフト上空へ
};

// この入口がどの形でオランダを求めているか。
//   "only"    … /nl/ ＝独立の入口。**この地域だけ**（日本の台帳も基図も持ち込まない）。アドレス欄が /nl/ のまま
//                ＝共有 URL として日本と混ざらない。基図を宣言しない地域の既定（＝全面水域）はこの道で効く。
//   "with-jp" … ?nl=1 ＝開発の重ね確認。日本に**足す**（そのまま日本へ飛べば日本の建物も出る）。
export const nlEntry = () => /^\/nl(\/|$)/.test(location.pathname) ? "only"
	: /[?&]nl=1/.test(location.search) ? "with-jp" : null;
