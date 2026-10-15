// t-dts の消費者（TypeScript）＝公開面を strict で型検査する。@ts-expect-error の行は「型が効いている」ことの証（消すと tsc が落ちる）
import { createGeopbf, geopbf, geopbfCached, geopbfCachePrune, setWorkerFactory, GeoPBF } from "geopbf";
import type { GeopbfOptions, ValidateIssue, FeatureCollection, UnPackGint, GeoPBFBase, BucketProvider, Properties } from "geopbf";
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

// bucket provider（createGeopbf(apiBase, { bucket })）の形＝(apiBase, options) → { Bucket, Cache, Fetch }
const provider: BucketProvider = (apiBase, options) => ({
	Bucket: async (dir, opts) => ({ url: apiBase ? `${apiBase}/${dir}/` : null, list: async () => [], put: async () => {}, del: async () => {}, etag: async () => null, lazy: opts?.lazy }),
	Cache: async () => async () => null,
	Fetch: async (url, opts) => new File([], url + (opts?.target ?? ""), { type: String(options.worker) }),
});

async function main() {
	// ── full の入口
	const g = createGeopbf(undefined, { worker: false, prewarm: false, bucket: provider, tky2jgd: null });
	const opts: GeopbfOptions = { name: "x", gint: true, clean: { maxPasses: 2 }, cacheKey: "k", validate: "strict", noeval: false, tky2jgd: null };
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
	const copy: GeoPBF = await pbf.clone();
	const head: GeoPBF = await pbf.cloneHead();
	const joined: GeoPBF | null = await pbf.concat(d, m);
	const asBase: GeoPBFBase = pbf;   // 器の型は型だけの名前（実行時の export ではない）
	void [n, fid, c, area, name, self1, prec, re, issues, k, u, fc2, m, cls, f, cached, pruned, legacy, copy, head, joined, asBase];

	// ── core（器だけ）
	const core = await new CoreGeoPBF({ precision: 7, validate: "lenient" }).set(fc);
	const bytes: ArrayBuffer = core.arrayBuffer;
	const loaded = await loadGeopbf("geopbf://https://example.com/x.geopbf", { sanitize: false });
	const feats: FeatureCollection = loaded.geojson;
	const attribution: string | undefined = loaded.attribution;
	const dec = await decodeToGeojson(await gunzip(new Blob([bytes])));
	// ── ストリーム符号化（setHead → setBody（関数）→ close）と静的な名簿
	const rows: Properties[] = [{ a: 1 }, null];
	const [keys, bufs]: [string[], ArrayBuffer[]] = await makeKeys(rows);
	const [keys2]: [string[], ArrayBuffer[]] = await BaseGeoPBF.makeKeys(rows);
	const base = new BaseGeoPBF().setHead(keys, bufs);
	base.setBody(() => { base.setGeometry({ type: "Point", coordinates: [0, 0] }); const none: void = base.setProperties({ a: 1 }); void none; }).close();
	const tag: 6 = BaseGeoPBF.TAGS.FEATURE;
	const gi: number = GeoPBF.geometryMap.Polygon;
	const dt: number = GeoPBF.dataType("x");
	const names: readonly string[] = GeoPBF.dataTypeNames;
	// ── wire（geopbf/pbf）
	const wire = new Pbf(); wire.writeStringField(1, "x"); wire.writeFixed64Field(2, 2 ** 40); wire.writeSFixed32Field(3, -1); const raw: Uint8Array = wire.finish();
	const seen: number[] = [];
	new Pbf(raw).readFields(tag => { seen.push(tag); });   // result 無し
	const o = new Pbf(raw).readMessage((tag, out) => { if (tag === 2) out.v = new Pbf().readVarint64(); }, { v: 0 });
	void [bytes, feats, attribution, dec.meta.name, keys2, base.length, tag, gi, dt, names, raw, seen, o.v, GeoPBF.geometryTypes[0]];

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

// ── 型が効いている証（この行の error が消えたら d.ts が緩んだ＝tsc が TS2578 で落ちる）
// @ts-expect-error validate は "lenient" | "strict" | "legacy"
new GeoPBF({ validate: "loose" });
// @ts-expect-error identifyAt の引数は数
new GeoPBF().identifyAt("0", 0);
// @ts-expect-error core の GeoPBF は拡張メソッド（centroid）を持たない
new CoreGeoPBF().centroid(0);
// @ts-expect-error precision(値) は Promise（同期の number ではない）
const p: number = new GeoPBF().precision(7);
// @ts-expect-error clone() は Promise（同期の GeoPBF ではない）
const q: GeoPBF = new GeoPBF().clone();
// @ts-expect-error set() は Feature 単体を受けない（FeatureCollection か bytes）
new GeoPBF().set(fc.features[0]);
// @ts-expect-error static concatinate は 2.0 で撤去（concat を使う）
GeoPBF.concatinate([]);
// @ts-expect-error GeoPBFBase は型だけ（実行時の export ではない＝値として使えない）
import { GeoPBFBase as RuntimeBase } from "geopbf"; void RuntimeBase;
void [p, q];
