// t-dts の消費者（TypeScript）＝公開面を strict で型検査する。@ts-expect-error の行は「型が効いている」ことの証（消すと tsc が落ちる）
import { createGeopbf, geopbf, geopbfCached, geopbfCachePrune, setWorkerFactory, GeoPBF } from "geopbf";
import type { GeopbfOptions, ValidateIssue, FeatureCollection, UnPackGint } from "geopbf";
import { GeoPBF as CoreGeoPBF, loadGeopbf, decodeToGeojson, gunzip } from "geopbf/core";
import { GeoPBF as BaseGeoPBF, makeKeys } from "geopbf/pbf-base";
import Pbf from "geopbf/pbf";
import { geopbfProtocol, makeGeopbfProtocol, parseTileUrl } from "geopbf/maplibre";
import { extendLeaflet } from "geopbf/leaflet";
import { makeGeopbfLoader } from "geopbf/openlayers";
import { GeoPBFLoader } from "geopbf/loaders";
import { findPolygon, hitGridOf, hitGridMode } from "geopbf/identify";
import { unPackGintBuffer, repackGintBuffer } from "geopbf/topology";
import { toPMTiles } from "geopbf/pmtiles";          // 省略宣言（any）の subpath
import { gzip } from "geopbf/gzip";
import { sphere } from "geopbf/edit/sphere";          // ワイルドカードの省略宣言

const fc: FeatureCollection = { type: "FeatureCollection", features: [
	{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }, properties: { name: "a", n: 1 } },
] };

async function main() {
	// ── full の入口
	const g = createGeopbf(undefined, { worker: false, prewarm: false });
	const opts: GeopbfOptions = { name: "x", gint: true, clean: { maxPasses: 2 }, cacheKey: "k", validate: "strict", noeval: false };
	const pbf = await g(fc, opts);
	if (!pbf) return;
	const n: number = pbf.length;
	const fid: number | null = pbf.identifyAt(0.5, 0.5, { point: 10, accept: f => f !== 2 });
	const c: number | null = pbf.contain([0.5, 0.5]);
	const area: number = pbf.area(0);
	const name: string = pbf.name();
	const self1: GeoPBF = pbf.name("y").description("d");
	const prec: number = pbf.precision();
	const re: Promise<GeoPBF> = pbf.precision(7);
	const issues: ValidateIssue[] = pbf.issues;
	const k: number | undefined = pbf.issueCount.badNumber;
	const u: UnPackGint | null | undefined = pbf.unPackGint;
	const fc2: FeatureCollection = pbf.geojson;
	const d: GeoPBF = await pbf.dissolve("name");
	const m: GeoPBF = await pbf.map(p => ({ ...p, z: 1 }));
	const cls: Record<string, GeoPBF> = await pbf.classify("name");
	const f: File | Blob | null = await pbf.shapeFile({ gz: true });
	const cached: GeoPBF | null = await geopbfCached("k", { maxAge: 1000 });
	const pruned = await geopbfCachePrune({ prefix: "k", maxEntries: 10 });
	const legacy: GeoPBF | null = await geopbf(fc, "named");
	setWorkerFactory(role => role.startsWith("decoder:") ? null : undefined);
	setWorkerFactory(null);
	const joined: GeoPBF = GeoPBF.concatinate([pbf, d], "both");
	void [n, fid, c, area, name, self1, prec, re, issues, k, u, fc2, m, cls, f, cached, pruned, legacy, joined];

	// ── core（器だけ）
	const core = await new CoreGeoPBF({ precision: 7, validate: "lenient" }).set(fc);
	const bytes: ArrayBuffer = core.arrayBuffer;
	const loaded = await loadGeopbf("geopbf://https://example.com/x.geopbf", { sanitize: false });
	const feats: FeatureCollection = loaded.geojson;
	const attribution: string | undefined = loaded.attribution;
	const dec = await decodeToGeojson(await gunzip(new Blob([bytes])));
	const base = new BaseGeoPBF();
	const wire = new Pbf(); wire.writeStringField(1, "x"); const raw: Uint8Array = wire.finish();
	void [bytes, feats, attribution, dec.meta.name, makeKeys(["a"]), base.length, raw];

	// ── 地図ライブラリの統合
	const h = makeGeopbfProtocol({ onMeta: (url, meta) => void [url, meta], tiler: { layer: "x" } });
	const res = await geopbfProtocol({ url: "geopbf://https://example.com/x.geopbf" }, new AbortController());
	await h.tiles.dispose("https://example.com/x.geopbf");
	const t = parseTileUrl("geopbf://https://h/a.geopbf/3/7/3");
	const L = extendLeaflet({ Layer: class {} });
	const loader = makeGeopbfLoader("https://h/a.geopbf", {}, { sanitize: true });
	void [res.data, t?.z, L, loader, GeoPBFLoader.parse];

	// ── 素関数
	if (pbf.unPackGint?.arcBuffer && pbf.unPackGint.arcMeta && pbf.unPackGint.polyStream) {
		const grid = hitGridOf(pbf.unPackGint.polyStream, pbf.unPackGint.arcMeta);
		const owner = findPolygon(pbf.unPackGint.arcBuffer, pbf.unPackGint.arcMeta, pbf.unPackGint.polyStream, 1, 1, pbf.unPackGint.polyBboxByFid);
		hitGridMode.on = false;
		const back: ArrayBuffer = repackGintBuffer(pbf.unPackGint);
		const again = unPackGintBuffer(back);
		void [grid.G, owner, again?.polygonCount];
	}
	void [toPMTiles, gzip, sphere];
}
void main;

// ── 型が効いている証（この 4 行の error が消えたら d.ts が緩んだ＝tsc が TS2578 で落ちる）
// @ts-expect-error validate は "lenient" | "strict" | "legacy"
new GeoPBF({ validate: "loose" });
// @ts-expect-error identifyAt の引数は数
new GeoPBF().identifyAt("0", 0);
// @ts-expect-error core の GeoPBF は拡張メソッド（centroid）を持たない
new CoreGeoPBF().centroid(0);
// @ts-expect-error precision(値) は Promise（同期の number ではない）
const p: number = new GeoPBF().precision(7);
