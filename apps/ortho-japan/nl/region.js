// オランダの地域宣言（3DBAG）。日本と同じ形＝建物の枠は国に依らないことの実証（jp/region.js を見よ）。
//
// TU Delft が BAG（建物登記）＋AHN（国土 LiDAR）から自動生成した全国 1000 万棟の LoD2.2・CC BY 4.0。
// PLATEAU と違い「国土まるごと 1 枚のタイルセット」（外部 tileset 474 本）なので、街ごとの矩形（clip）で
// 走査を枝刈りして「区」相当の粒度に切る。
//   base       … 識別キー（worker 振り分け・キャッシュ・OPFS のファイル名）＝同じ tileset を街ごとに
//                別枠で持つため、実 URL は tilesetUrl で別に渡す
//   tilesetUrl … 3D Tiles 1.1 の glb＝頂点が int16 量子化（plateauworker が解除）
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
	view: "#16/52.0116/4.3571/45t",   // 裸で開いた時はデルフト上空へ
};

// この入口が当地域か（アドレス欄が /nl/ のまま＝共有 URL として日本と混ざらない）
export const isNL = () => /[?&]nl=1/.test(location.search) || /^\/nl(\/|$)/.test(location.pathname);
