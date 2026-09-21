// 全球の基図＝背景画像（ER 正距円筒）と Natural Earth のベクタ → bucket GIS/base・GIS/pbf。
// 読む側：ortho-japan の世界ビュー・apps/equal（名前慣習で load＝クライアントに毎回 zip→shp デコードを払わせない）。
import { comma, thenEach } from "common";
import { Layers } from "ortho-map/modules/Layers.js";
import { tiff2canvas, tile2canvas } from "./lib/file2canvas.js";
import { bakeEach, neZip, NE_HEADER } from "./lib/bake.js";

// 背景画像（ortho-map の Layers が名指しする base の .webp）→ GIS/base。既にあれば焼かずに IDB へ温めるだけ
export async function baseImages(q, { Bucket, Cache, Fetch }) {
	const list = Object.values(Layers);
	const dire = `GIS/base`;
	const bucket = await Bucket(dire);
	const cache = await Cache(dire);
	q.clear();
	q.title("base ER pictures");
	const baseMap = {};
	await thenEach(list, async t => {
		const base = t.base; if (base in baseMap) return;
		baseMap[base] = await bucket.get(base) || await createBaseMap(t);
		q.success(base);
		q.log(baseMap[base]);
		await cache(base, await createImageBitmap(baseMap[base]))
	});
	q.log(await bucket.list());
	async function createBaseMap(layer) {
		const base = layer.base;
		switch (base) {
			case "naturalEarth.webp": await NaturalEarth("HYP_LR_SR_OB_DR"); break;
			case "whiteEarth.webp": await NaturalEarth("GRAY_LR_SR_OB_DR"); break;
			case "google.satellite.webp": await tile2rect(layer.tile); break;
			case "osm.satellite.webp": await tile2rect(layer.tile); break;
		}
		async function tile2rect(url) { await saveWEBPs(await tile2canvas(url)); }
		async function NaturalEarth(target) {
			const url = `https://naciscdn.org/naturalearth/10m/raster/${target}.zip`;
			const tiff = await Fetch(url, { target: `${target}.tif`, cors: true });
			await saveWEBPs(await tiff2canvas(tiff));
		}
		async function saveWEBPs(canvas) {
			const dstX = 10000, dstY = dstX / 2;
			const type = `image/webp`, quality = 0.8;
			const blob = await canvas.convertToBlob({ type, quality });
			const img = await createImageBitmap(blob), w = canvas.width, h = canvas.height;
			const target = new OffscreenCanvas(dstX, dstY);
			target.getContext("2d").drawImage(img, 0, 0, w, h, 0, 0, dstX, dstY);
			const file = new File([await target.convertToBlob({ type, quality })], base, { type });
			await bucket.put(file);
			console.log(`%c${file.name}: [ ${comma(dstX)} x ${comma(dstY)} ] ${comma(file.size)} bytes`, "font-size:1.5em");
		}
	}
}

// 陸・経緯線・国境線・星（旧来の小さな基図一式）。NE は GitHub の geojson、星は d3-celestial
export function borders(q) {
	const nvkelso = _ => `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${_}.geojson`;
	const ofrohn = _ => `https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/${_}.json`;
	return bakeEach(q, "borders and stars", [
		...["ne_110m_land", "ne_110m_graticules_10", "ne_50m_admin_0_boundary_lines_land",
			"ne_50m_admin_0_boundary_lines_maritime_indicator", "ne_50m_geographic_lines"].map(name => ({ name, url: nvkelso(name) })),
		...["stars.6"].map(name => ({ name, url: ofrohn(name) })),
	]);
}

// ※旧 coastline（ne_{50m,10m}_coastline）は 2026-08-30 に admin0 へ置換＝ボタン撤去（bucket の既存データは ortho-core の検定
//   tests/prep-data.mjs が読むので残す）。国ポリゴン・湖を 50m/10m 両方置く理由＝50m を bucket 未収録にすると
//   モバイルは毎回 S3 生zip フォールバック（shape デコード）に落ちる＝(a) 404 がコンソールに出る、(b) WebKit で
//   props.join TypeError の既知バグ経路。bucket 収録で両方を根から断つ。50m を先に焼く（モバイルの本命）。
// 世界の国ポリゴン（Natural Earth admin_0_countries）→ GIS/pbf。ortho-japan 世界ビュー（?world=1）の
// gint 束＝海岸線+国境線+国名identify(NAME_JA) の一本データ（旧 coastline スロットの後継・2026-08-31）。
// 50m=LOW_MEM（モバイル）用。焼けるまでアプリは S3 zip フォールバックで動く（毎初回3.2MB＝焼けば無通信）。
export function admin0(q) {
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
export function lakes(q) {
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
export function riversAirports(q) {
	const items = [
		{ group: "physical", name: "ne_10m_rivers_lake_centerlines", description: "世界の河川（Natural Earth 10m rivers_lake_centerlines）＝全球ビューの水系ライン" },
		{ group: "cultural", name: "ne_10m_airports", description: "世界の空港（Natural Earth 10m airports）＝全球ビューの空港マーカー" },
		{ group: "cultural", name: "ne_10m_admin_0_boundary_lines_maritime_indicator", description: "海洋境界線（Natural Earth 10m boundary_lines_maritime_indicator）＝海上の中間線・領海の指示線" },
	];
	return bakeEach(q, "NE rivers + airports + maritime (10m)", items.map(({ group, name, description }) =>
		({ name, url: neZip("10m", group, name), header: { description, ...NE_HEADER } })));
}
