// 全球の基図＝背景画像（ER 正距円筒）と Natural Earth のベクタ → bucket GIS/base・GIS/pbf。
// 読む側：ortho-japan の世界ビュー・apps/equal（名前慣習で load＝クライアントに毎回 zip→shp デコードを払わせない）。
import { comma, thenEach } from "common";
import { tiff2canvas, tile2canvas } from "./lib/file2canvas.ts";
import { bakeEach, neZip, NE_HEADER } from "./lib/bake.ts";
import type { TileURL } from "./lib/file2canvas.ts";
import type { screenLogger } from "common/screenLogger";
import type { NativeBucket } from "native-bucket";

// 背景画像（正距円筒 .webp）の一覧。旧＝ortho-map（v1）の Layers から借りていた＝v1 撤去に伴い必要な分だけここへ写した
// （2026-09-21・挙動は写す前と同一：名前・タイル URL の式とも packages/ortho-map/src/modules/Layers.js のまま）。
// 読む側は v1 の地球儀（base.js）だけだった＝v2（ortho-japan/equal）は GIS/base を読まない。
const quadkey = ([x, y, z]: number[]) => { let s = ""; for (let i = z - 1; i >= 0; i--) s += ((y >> i & 1) << 1 | (x >> i & 1)); return s || "0"; };
let googleN = 0;
const BASES: { base: string; tile?: TileURL }[] = [
	{ base: "whiteEarth.webp" },
	{ base: "naturalEarth.webp" },
	{ base: "google.satellite.webp", tile: ([x, y, z]) => z < 7 ? null : `https://mt${(googleN++) % 4}.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}` },
	{ base: "osm.satellite.webp", tile: t => `/bing/${quadkey(t)}` },   // v1 と同じく tilerBase 空＝相対
];

// 背景画像 → GIS/base。既にあれば焼かずに IDB へ温めるだけ
export async function baseImages(q: screenLogger, { Bucket, Cache, Fetch }: NativeBucket) {
	const list = BASES;
	const dire = `GIS/base`;
	const bucket = (await Bucket(dire))!;
	const cache = await Cache(dire);
	q.clear();
	q.title("base ER pictures");
	const baseMap: Record<string, Blob | null | void> = {};
	await thenEach(list, async t => {
		const base = t.base; if (base in baseMap) return;
		baseMap[base] = await bucket.get(base) || await createBaseMap(t);
		q.success(base);
		q.log(baseMap[base]);
		await cache(base, await createImageBitmap(baseMap[base] as Blob))   // 焼いた直後も createBaseMap が焼いた File を返す（旧＝何も返さず undefined で落ちた・2026-10-17）
	});
	q.log(await bucket.list());
	async function createBaseMap(layer: typeof BASES[number]) {
		const base = layer.base;
		switch (base) {
			case "naturalEarth.webp": return NaturalEarth("HYP_LR_SR_OB_DR");
			case "whiteEarth.webp": return NaturalEarth("GRAY_LR_SR_OB_DR");
			case "google.satellite.webp": return tile2rect(layer.tile!);
			case "osm.satellite.webp": return tile2rect(layer.tile!);
		}
		async function tile2rect(url: TileURL) { return saveWEBPs(await tile2canvas(url)); }
		async function NaturalEarth(target: string) {
			const url = `https://naciscdn.org/naturalearth/10m/raster/${target}.zip`;
			const tiff = await Fetch(url, { target: `${target}.tif`, cors: true });
			return saveWEBPs(await tiff2canvas(tiff as File));
		}
		async function saveWEBPs(canvas: OffscreenCanvas) {
			const dstX = 10000, dstY = dstX / 2;
			const type = `image/webp`, quality = 0.8;
			const blob = await canvas.convertToBlob({ type, quality });
			const img = await createImageBitmap(blob), w = canvas.width, h = canvas.height;
			const target = new OffscreenCanvas(dstX, dstY);
			target.getContext("2d")!.drawImage(img, 0, 0, w, h, 0, 0, dstX, dstY);
			const file = new File([await target.convertToBlob({ type, quality })], base, { type });
			await bucket.put(file);
			console.log(`%c${file.name}: [ ${comma(dstX)} x ${comma(dstY)} ] ${comma(file.size)} bytes`, "font-size:1.5em");
			return file;
		}
	}
}

// 陸・経緯線・国境線（旧来の小さな基図一式）。NE は GitHub の geojson
// 星（stars.6）は 2026-10-15 に外した＝星空のデータは GitHub Pages の sky/（packages/world の npm run sky が焼く）
export function borders(q: screenLogger) {
	const nvkelso = (_: string) => `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${_}.geojson`;
	return bakeEach(q, "borders", [
		...["ne_110m_land", "ne_110m_graticules_10", "ne_50m_admin_0_boundary_lines_land",
			"ne_50m_admin_0_boundary_lines_maritime_indicator", "ne_50m_geographic_lines"].map(name => ({ name, url: nvkelso(name) })),
	]);
}

// ※旧 coastline（ne_{50m,10m}_coastline）は 2026-08-30 に admin0 へ置換＝ボタン撤去（bucket の既存データは ortho-core の検定
//   tests/prep-data.mjs が読むので残す）。国ポリゴン・湖を 50m/10m 両方置く理由＝50m を bucket 未収録にすると
//   モバイルは毎回 S3 生zip フォールバック（shape デコード）に落ちる＝(a) 404 がコンソールに出る、(b) WebKit で
//   props.join TypeError の既知バグ経路。bucket 収録で両方を根から断つ。50m を先に焼く（モバイルの本命）。
// 世界の国ポリゴン（Natural Earth admin_0_countries）→ GIS/pbf。ortho-japan 世界ビュー（?world=1）の
// gint 束＝海岸線+国境線+国名identify(NAME_JA) の一本データ（旧 coastline スロットの後継・2026-08-31）。
// 50m=LOW_MEM（モバイル）用。焼けるまでアプリは S3 zip フォールバックで動く（毎初回3.2MB＝焼けば無通信）。
export function admin0(q: screenLogger) {
	return bakeEach(q, "admin_0_countries (50m + 10m)", ["50m", "10m"].map(res => {
		const name = `ne_${res}_admin_0_countries`;
		return { name, url: neZip(res, "cultural", name),
			header: { description: `世界の国ポリゴン（Natural Earth ${res} admin_0_countries）＝国境線・海岸線・国名`, ...NE_HEADER } };
	}));
}

// 湖（Natural Earth lakes）→ GIS/pbf。ortho-japan 世界ビュー（world 既定）のエンジン lakes スロット
// （wdepr の兄弟＝worldPal.sea の平色塗り・app.js loadLakes）用。旧・Protomaps 世界タイル world-water 層の
// 後継（2026-09-03 本人裁定「湖はNE経由＝B案」＝© OpenStreetMap/ODbL 出典義務の撤去）。
// 10m=デスクトップ／50m=LOW_MEM（モバイル）。
export function lakes(q: screenLogger) {
	return bakeEach(q, "ne_lakes (50m + 10m)", ["50m", "10m"].map(res => {
		const name = `ne_${res}_lakes`;
		return { name, url: neZip(res, "physical", name),
			header: { description: `世界の湖（Natural Earth ${res} lakes）＝全球ビューの湖面塗り`, ...NE_HEADER } };
	}));
}

// 川（rivers_lake_centerlines）・空港（airports）・海洋境界線（boundary_lines_maritime_indicator）→ GIS/pbf。apps/equal 用。
// なぜ bucket へ置くか＝lakes/admin0 と同じ理由の実測版：この 2 つだけ bucket に無く、equal は毎訪問
// 「名前引き→404（本番実測 0.6s×2 本）→ S3 生 zip へ退避→ shp デコード」を払っていた（2026-09-18）。
// IDB が温まっても 404 の往復は毎回発生する＝焼いて置けば根から消える。
// 解像度は 10m のみ＝equal の NE() ヘルパが 10m 固定（coast/lakes と違い 50m を使う経路が無い）。
// 増やす時はこの表に足すだけ（group/name/description）。
export function riversAirports(q: screenLogger) {
	const items = [
		{ group: "physical", name: "ne_10m_rivers_lake_centerlines", description: "世界の河川（Natural Earth 10m rivers_lake_centerlines）＝全球ビューの水系ライン" },
		{ group: "cultural", name: "ne_10m_airports", description: "世界の空港（Natural Earth 10m airports）＝全球ビューの空港マーカー" },
		{ group: "cultural", name: "ne_10m_admin_0_boundary_lines_maritime_indicator", description: "海洋境界線（Natural Earth 10m boundary_lines_maritime_indicator）＝海上の中間線・領海の指示線" },
	];
	return bakeEach(q, "NE rivers + airports + maritime (10m)", items.map(({ group, name, description }) =>
		({ name, url: neZip("10m", group, name), header: { description, ...NE_HEADER } })));
}
