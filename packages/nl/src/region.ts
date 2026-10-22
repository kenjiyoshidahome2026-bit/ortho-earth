// オランダの地域宣言（建物＝PDOK の 3D Basisvoorziening）。日本と同じ形＝建物の枠は国に依らないことの実証（packages/jp/src/region.ts を見よ）。
//
// Kadaster（国土地理院）が BAG（建物登記）＋AHN（国土 LiDAR）・航空写真の標高から作る全国の建物（AHN のある所は LoD2.2）・CC BY 4.0。
// 2026-10-22 に 3DBAG（TU Delft・data.3dbag.nl）から替えた＝3DBAG の配信が丸一日落ちた（Kenji 裁定「PDOKでやりましょう」）。同じ素性・同じ glb の型。
// 違い＝tileset の根に ECEF の transform（3DBAG は glb の node 行列）＝meshdecode が根から積んで頂点に掛ける（#557）。
// PLATEAU と違い「国土まるごと 1 枚のタイルセット」（外部 tileset に枝分かれ）なので、街ごとの矩形（clip）で
// 走査を枝刈りして「区」相当の粒度に切る。
//   base       … 識別キー（worker 振り分け・キャッシュ・OPFS のファイル名）＝同じ tileset を街ごとに
//                別枠で持つため、実 URL は tilesetUrl で別に渡す
//   tilesetUrl … 3D Tiles 1.1 の glb＝頂点が int16 量子化（meshworker が解除）
//   bakeBase   … R2 焼き（PLQ）の置き場＝日本と同じ第三の入口（2026-10-22）。焼きのある街は tileset を辿らず・glb を
//                解かずに R2 から取って立てる（配信元が止まっていても出る）。焼きの無い街は 404 → 黙って生経路（上の tilesetUrl）。
//                焼く＝apps/ortho-japan/scripts/bake-plateau.mjs --region=nl --upload（配信元に届く所で・書込キーが要る）。
//                置き場の名（GIS/3dbag/）と識別キー（nl-3dbag-*）は 3DBAG の頃のまま＝端末の写し・R2 の鍵を作り直さない
//
// 入口は /nl/（本番＝deploy-worker が japan の資産をそのまま出す独立 URL）と ?nl=1（開発・日本に重ねて
// 確認する時）。どちらも**日本の台帳に足す**形＝?nl=1 のまま日本へ飛べば日本の建物も出る（2026-09-17 の
// 移設でもこの振る舞いを変えていない）。
const TILESET = "https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1/collections/gebouwen/3dtiles/tileset.json";
const BLD_HREF = "https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1/collections/gebouwen";   // 出典の行き先（PDOK の集まりの頁）

/** 矩形 [west, south, east, north]（度） */
export type NlBBox = [number, number, number, number];
/** 視点 [経度, 緯度, ズーム, チルト°, 方位°] */
export type NlView = [number, number, number, number, number];
export interface NlPlace { key: string; name: string; bbox: NlBBox; view: NlView }

// 街の一覧＝建物の枠（bbox で全国の tileset を切る）と、その街へ飛んだ時の視点 [経度, 緯度, ズーム, チルト°, 方位°]。
// /nl/ の街のボタン（apps/ortho-nl/index.html）もこの表を読む＝街を足すのはここ 1 か所。名前は現地の綴り（26 言語の画面で共通）。
export const NL_PLACES: NlPlace[] = [
	{ key: "delft", name: "Delft", bbox: [4.336, 51.978, 4.393, 52.026], view: [4.3571, 52.0116, 16, 45, 0] },
	{ key: "rotterdam", name: "Rotterdam", bbox: [4.452, 51.905, 4.510, 51.935], view: [4.4800, 51.9195, 16.2, 62, 20] },
	{ key: "amsterdam", name: "Amsterdam", bbox: [4.869, 52.360, 4.925, 52.386], view: [4.8930, 52.3731, 16, 55, -20] },
	{ key: "denhaag", name: "Den Haag", bbox: [4.290, 52.065, 4.345, 52.092], view: [4.3180, 52.0790, 16, 60, 40] },
	{ key: "utrecht", name: "Utrecht", bbox: [5.095, 52.078, 5.150, 52.104], view: [5.1195, 52.0905, 16, 58, -30] },
	{ key: "eindhoven", name: "Eindhoven", bbox: [5.455, 51.428, 5.505, 51.455], view: [5.4790, 51.4405, 16, 58, 15] },
	{ key: "groningen", name: "Groningen", bbox: [6.540, 53.205, 6.595, 53.232], view: [6.5670, 53.2185, 16, 55, 0] },
	{ key: "maastricht", name: "Maastricht", bbox: [5.665, 50.835, 5.720, 50.862], view: [5.6925, 50.8490, 15.6, 60, 170] },   // 南向き＝奥にシント・ピーテルスベルフの丘（標高が効く唯一の街）
];

/** MapLibre の style（必要な所だけ）。sources の type と layers の type／source で絞る */
export interface NlStyleSource { type?: string; attribution?: string; [k: string]: unknown }
export interface NlStyleLayer { type?: string; source?: string; [k: string]: unknown }
export interface NlStyle { sources?: Record<string, NlStyleSource>; layers?: NlStyleLayer[]; [k: string]: unknown }

// 基図＝OpenFreeMap（OpenMapTiles の形のベクタタイル・OSM）の style「liberty」を外来 style の口（opts.style）で描く（2026-10-01）。
// 自前のベクタ基図は持たない国＝旧は basemap:null で白い地面に建物だけ＝貧相だった。鍵も登録も要らない配信を借りる。
//   ・style 側の建物の押し出し（fill-extrusion）は外す＝3D の建物と二重になる（足元の fill は残す＝建物を切っていない街でも街区が読める）
//   ・塗りの下の画像（Natural Earth の陰影）は描けない層＝source ごと外す（無駄な取得を出さない）
//   ・出典は source の attribution に**全部**書く＝外来 style で起動すると地域宣言の出典の行は出ない（エンジンは基図の出典だけを出す）。
//     3D Basisvoorziening は CC BY 4.0＝表示が義務・標高（Mapterhorn）も同じ欄へ
const NL_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const NL_ATTR_HTML = `<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>`
	+ `・<a href="${BLD_HREF}" target="_blank">3D Basisvoorziening (Kadaster/PDOK), CC BY 4.0</a>・<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>`;
// 取れなければ null＝基図なしの従来の絵で起動する（借り物の配信が落ちていても建物は出る）。8 秒で見切る＝起動を人質に取らせない。
export async function nlStyle(): Promise<NlStyle | null> {
	try {
		const r = await fetch(NL_STYLE_URL, { credentials: "omit", signal: AbortSignal.timeout(8000) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const ms = await r.json() as NlStyle;
		const sources: Record<string, NlStyleSource> = Object.fromEntries(Object.entries(ms.sources || {}).filter(([, sp]) => sp.type === "vector").map(([id, sp]) => [id, { ...sp, attribution: NL_ATTR_HTML }]));
		return { ...ms, sources, layers: (ms.layers || []).filter(L => L.type !== "fill-extrusion" && (!L.source || sources[L.source])) };
	} catch (err) { console.warn("[nl] basemap style unavailable — starting without a basemap", err); return null; }
}
// 標高＝Mapterhorn（terrarium・512px・z14 まで）。dtm:true＝裸地として扱う＝建物を地面へ載せる（R01 の JAXA は表層＝屋根が裂ける）。
export const NL_TERRAIN = { source: { type: "raster-dem", tiles: ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"], encoding: "terrarium" as const, tileSize: 512, maxzoom: 14, dtm: true } };

/** 建物の 1 枠（3D Tiles の tileset を街の矩形で切った物） */
export interface NlBuildingSet { name: string; bbox: NlBBox; base: string; tilesetUrl: string; clip: NlBBox }
/** R2 焼きの置き場（bake-plateau.mjs --region=nl の置き先もここから決まる） */
export const NL_BAKE_BASE = "https://api.ortho-earth.com/bucket/GIS/3dbag/";
/** 出典の 1 片（key＝辞書の鍵・text＝そのままの文） */
export interface NlAttributionItem { href?: string; key?: string; text?: string }
export interface NlRegion {
	code: string;
	dtm: null;
	buildings: { sets: NlBuildingSet[]; bakeBase: string };
	basemap: null;
	attribution: { lines: NlAttributionItem[][]; note: string };
	view: string;
}

export const NL_REGION: NlRegion = {
	code: "nl",
	dtm: null,                    // AHN の焼き直しは持っていない＝標高は外来の標高タイル（上の NL_TERRAIN）を入口が渡す
	buildings: {
		sets: NL_PLACES.map(s => ({ name: `${s.name} (PDOK)`, bbox: s.bbox, base: `nl-3dbag-${s.key}/`, tilesetUrl: TILESET, clip: s.bbox })),
		bakeBase: NL_BAKE_BASE,   // globe が各 set へ刻む（stampBake）
	},
	// 自前のベクタ基図は持たない＝地域の基図の口（basemap）は空のまま。/nl/ の入口は外来 style（上の nlStyle）で描く。
	// style が取れなかった時・?nl=1（日本に重ねる）の時はこの宣言どおり＝タイルを要求せず図郭外と同じ扱い。
	basemap: null,
	// 3D Basisvoorziening は CC BY 4.0＝表示が義務。日本のデータを出していない画面に地理院・PLATEAU を並べるのは、
	// 義務以前に嘘になる（だから入口ごとに出典を差し替える）。外来 style で起動した時は NL_ATTR_HTML が出る＝ここは style が取れなかった時の文面。
	attribution: {
		lines: [
			[{ href: BLD_HREF, key: "3D Basisvoorziening (Kadaster/PDOK), CC BY 4.0" }, { href: "https://mapterhorn.com/attribution", text: "© Mapterhorn" }],
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
export type NlEntry = "only" | "with-jp";
export const nlEntry = (): NlEntry | null => /^\/nl(\/|$)/.test(location.pathname) ? "only"
	: /[?&]nl=1/.test(location.search) ? "with-jp" : null;
