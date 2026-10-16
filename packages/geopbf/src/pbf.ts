// GeoPBF（"geopbf"）＝器（pbf-base の GeoPBFBase）＋解析・操作・位相・書き出しのメソッド（TS 化 段 4・2026-10-16）。
// 旧＝pbf.js が 27 個、index.js が 14 個を import 時に GeoPBF.prototype へ後付けしていた（器と同じ class＝"geopbf/core" にも生えた）。
// 今は class のメンバー。本体は extension/*.ts の関数（self を受ける）＝ここは薄い委譲だけ。
// 書き出し・保存・縮小図・gint の 14 個の実体は入口（index.ts）が wireEntry で配線する（worker を作る口＝builtinWorkers は入口だけが持つ。
// この class を読む encoder worker（encoder/fgb・shape・preview・profile・topojson）の閉包に入れない）。
import { GeoPBFBase, canUseWorker } from "./pbf-base.ts";
import { centroid, lineLength, area, getBbox, bboxes, bbox } from "./extension/spatial.ts";
import { concatinate, clone, cloneHead, cloneMap, classify, getPropertyTable, getCSV } from "./extension/manipulate.ts";
import type { FeatureCallback, CloneMapOptions } from "./extension/manipulate.ts";
import { dissolve } from "./extension/dissolve.ts";
import { topojson, neighbors, mesh, merge } from "./extension/topojson.ts";
import type { TopoJSON } from "./extension/topojson.ts";
import { identify, identifyAt, contain } from "./extension/identify.ts";
import { simplified } from "./extension/simplify.ts";
import { unPackGintBuffer, repackGintBuffer, attachLazyStreams } from "./extension/topology.ts";
import { cleanTopology } from "./extension/clean.ts";
import { precision } from "./extension/precision.ts";
import { runInWorker } from "./modules/workerPool.ts";
import type { LaneFactory } from "./modules/workerPool.ts";
import type { GintDecodeResponse } from "./worker-msg.ts";
import type {
	BBox, CleanTopologyOptions, ExportOptions, FeatureCollection, GintOptions, IdentifyAtOptions, IdentifyOptions, LngLat,
	MultiLineString, MultiPolygon, Projection, Properties, TopoFilterOptions,
} from "../types/geopbf.js";
export type { FeatureCallback, CloneMapOptions } from "./extension/manipulate.ts";

/** DOM の HTMLCanvasElement（worker の program＝lib webworker には無い＝never） */
type HTMLCanvas = typeof globalThis extends { HTMLCanvasElement: { prototype: infer C } } ? C : never;

/** 入口（index.ts）が配線する 14 個の実体（書き出し・保存・縮小図・Gint 焼き）。this＝呼ばれた GeoPBF */
export interface GeoPBFEntryMethods {
	save(this: GeoPBF): Promise<GeoPBF | null>;
	preview(this: GeoPBF, canvas?: HTMLCanvas | OffscreenCanvas | Record<string, unknown>, props?: Record<string, unknown>): Promise<ImageBitmap | null>;
	profile(this: GeoPBF, opts?: ExportOptions): Promise<unknown>;
	gintbuf(this: GeoPBF, opts?: ExportOptions): Promise<ArrayBuffer | null>;
	geopbfFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	geojsonFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	topojsonFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	shapeFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	kmzFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	gpxFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	czmlFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	gmlFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	fgbFile(this: GeoPBF, opts?: ExportOptions): Promise<File | Blob | null>;
	gint(this: GeoPBF, opts?: GintOptions): Promise<GeoPBF>;
}
let entry: GeoPBFEntryMethods | null = null;
/** @internal 入口（index.ts）が読まれた時に 1 回だけ呼ぶ */
export function wireEntry(methods: GeoPBFEntryMethods): void { entry = methods; }
// 配線前（入口を読まずにこの class だけを読んだ worker 等）＝旧と同じくメソッドが使えない（旧＝"is not a function" の TypeError）
const fromEntry = (name: keyof GeoPBFEntryMethods): GeoPBFEntryMethods => { if (!entry) throw new TypeError(`GeoPBF.${name}: needs the "geopbf" entry (src/index.ts) to be loaded`); return entry; };

export class GeoPBF extends GeoPBFBase {
	/** @internal fileSize() の控え */
	declare _fileSize?: number;
	/** @internal 解析の控え（extension/spatial.ts） */
	declare _centroid?: LngLat[]; declare _lineLength?: number[]; declare _area?: number[]; declare _bbox?: BBox; declare _bboxes?: BBox[];

	// ── 幾何の解析（extension/spatial.ts）
	centroid(i: number): LngLat { return centroid(this, i); }
	/** m */
	lineLength(i: number): number { return lineLength(this, i); }
	/** m² */
	area(i: number): number { return area(this, i); }
	/** 地物 i の bbox。i 無し＝全地物の bbox を組んで控え、その配列を返す（全体の外接は pbf.bbox） */
	getBbox(): BBox[]; getBbox(i: number): BBox;
	getBbox(i?: number): BBox | BBox[] { return getBbox(this, i); }
	get bbox(): BBox { return bbox(this); }
	get bboxes(): BBox[] { return bboxes(this); }

	// ── 操作（extension/manipulate.ts・dissolve.ts＝arrayBuffer を読み直す＝非同期）
	/** 丸ごとの写し */
	clone(): Promise<GeoPBF> { return clone(this); }
	/** ヘッダだけの写し（keys・bufs・meta） */
	cloneHead(): Promise<GeoPBF> { return cloneHead(this); }
	/** map の関数をそのまま渡してもよい */
	cloneMap(opts: FeatureCallback<Properties> | CloneMapOptions = {}): Promise<GeoPBF> { return cloneMap(this, opts); }
	// 旧 closeFilter(filter)（＝cloneMap({ filter })）は 2.0 で撤去（使い手なし）。絞り込みは cloneMap({ filter })
	map(map: FeatureCallback<Properties>): Promise<GeoPBF> { return cloneMap(this, { map }); }
	/** 鍵の値ごとの GeoPBF（鍵の昇順の配列・名前は `${name}@${値}`） */
	classify(k: string | FeatureCallback<string | number | undefined>): Promise<GeoPBF[]> { return classify(this, k); }
	// 旧 static GeoPBF.concatinate は 2.0 で撤去（setProperty に descriptor を値として渡していた＝object で呼べなかった）。結合は pbf.concat(...others)
	/** 自分と others を 1 つに（名前は自分の name・precision が揃っていなければ null・others が無ければ自分） */
	concat(...args: GeoPBF[]): Promise<GeoPBF | null> { return concatinate([this, ...args], this.name()); }

	getPropertyTable(): unknown[][] | null { return getPropertyTable(this); }
	getCSV(): string { return getCSV(this); }

	/** 同じ属性（key＝その鍵だけ・true＝全部同じ・false／無し＝全属性）の地物を併合 */
	dissolve(p?: string | boolean): Promise<this> { return dissolve(this, p); }

	// ── 位相（extension/topojson.ts・Gint が要る）
	topojson(): TopoJSON { return topojson(this); }
	neighbors(): number[][]; neighbors(id: number): number[];
	neighbors(id?: number): number[] | number[][] { return neighbors(this, id); }
	mesh(f?: TopoFilterOptions & { arc?: false }): MultiLineString;
	mesh(f: TopoFilterOptions & { arc: true }): { type: "Topology"; arcs: number[] };
	mesh(f?: TopoFilterOptions): MultiLineString | { type: "Topology"; arcs: number[] } { return mesh(this, f); }
	merge(f?: TopoFilterOptions & { arc?: false }): MultiPolygon;
	merge(f: TopoFilterOptions & { arc: true }): { type: "Topology"; arcs: number[][] };
	merge(f?: TopoFilterOptions): MultiPolygon | { type: "Topology"; arcs: number[][] } { return merge(this, f); }
	// ── 識別（extension/identify.ts・Gint が無ければ null）
	identify(mx: number, my: number, proj: Projection, options?: IdentifyOptions): number | null { return identify(this, mx, my, proj, options); }
	/** 描画レス識別（proj 不要・許容半径 m） */
	identifyAt(lng: number, lat: number, options?: IdentifyAtOptions): number | null { return identifyAt(this, lng, lat, options); }
	/** 点を含む最小のポリゴンの fid */
	contain([lng, lat]: LngLat): number | null { return contain(this, lng, lat); }

	/** Gint の rank ≥ minRank の頂点に間引いた FeatureCollection（Gint が無ければ null） */
	simplified(minRank?: number): FeatureCollection | null { return simplified(this, minRank); }   // VWランク間引きFC（描画でなく専用データ焼き用）
	// 入れ子配列・stream だけでなく、描画と保存が読む GintBUF（_gintBuffer）も作り直す（2026-09-25・旧は GintBUF が古いまま）
	cleanTopology(options?: CleanTopologyOptions | true): this {
		if (!this.unPackGint) return this;
		cleanTopology(this.unPackGint, options);
		const buf = repackGintBuffer(this.unPackGint);
		if (typeof SharedArrayBuffer !== "undefined") { this._gintBuffer = new SharedArrayBuffer(buf.byteLength); new Uint8Array(this._gintBuffer).set(new Uint8Array(buf)); }
		else this._gintBuffer = buf;
		return this;
	}
	// 引数なし＝同期の読み取り（pbf-base の precision() と同じ・CLI/Node からも素直に読める）。引数あり＝再エンコードして新インスタンスを返す（Promise）。
	precision(): number; precision(s: number): Promise<GeoPBF>;
	precision(s?: number): number | Promise<GeoPBF> { return s === undefined ? this._precision : precision(this, s); }

	/** GintBUF を掴む（所有権を取る＝残したい時は buf.slice(0) を渡す） */
	async setGintBUF(buf: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Promise<this> {
		if (!buf) throw new Error("setGintBUF: buf is null — gint encoding failed");
		// SAB＝worker へのゼロコピー共有（最適化）であって必須ではない。Safari は COEP:credentialless を認識せず
		// crossOriginIsolated が立たない＝SAB 不在。ここで throw すると海岸線/14条筆が Safari/iPhone で全滅する
		//（実際に起きた）ので、無い環境は通常 ArrayBuffer＝structured clone のコピー1回を払って動かす。
		// 所有権＝buf は渡した側がもう使わない（encoder Worker の返り便・IDB の読み出し・repack の新品＝全呼び手がそう）。
		// 2026-10-11 ゼロコピー: 既に SAB ならそのまま（encoder/gint が shared で組んだ時）、SAB の無い環境は buf をそのまま掴む
		//（旧＝常に .slice(0)＝GintBUF 1 本ぶんの余分な写し）。残したい呼び手は buf.slice(0) を渡す
		let payload: ArrayBuffer | SharedArrayBuffer;
		if (ArrayBuffer.isView(buf)) buf = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		if (typeof SharedArrayBuffer !== "undefined" && buf instanceof SharedArrayBuffer) payload = this._gintBuffer = buf;
		else if (typeof SharedArrayBuffer !== "undefined") {
			payload = this._gintBuffer = new SharedArrayBuffer(buf.byteLength);
			new Uint8Array(payload).set(new Uint8Array(buf));
		} else {
			payload = this._gintBuffer = buf;
		}
		if (canUseWorker(this, GeoPBF._gintWorkerFactory)) {
			// 生成はプールが握る＝1 件ごとの new Worker/terminate をやめ、レーンを使い回す（modules/workerPool.ts の由来書き参照）。
			// postMessage は AB の場合 structured clone（unpack は内部でコピーする設計＝どちらでも正しい）。
			// Worker 越し＝遅延 accessor（非列挙）は clone に乗らない＝受け側で attachLazyStreams を掛け直す
			this.unPackGint = attachLazyStreams(await runInWorker<GintDecodeResponse>("decoder:gint", GeoPBF._gintWorkerFactory as LaneFactory, { sab: payload }));
		} else {
			this.unPackGint = unPackGintBuffer(payload);
		}
		return this;
	}

	async fileSize(): Promise<number> { if (this._fileSize! > 0) return this._fileSize!;
		const stream = new Blob([this.arrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'));
		return this._fileSize = (await new Response(stream).arrayBuffer()).byteLength;
	}

	// ── 書き出し・保存・縮小図・Gint（実体は入口＝index.ts。createGeopbf() を呼んだ後に使える・worker が無い環境は null）
	/** 設定した bucket へ保存（無ければ null） */
	save(): Promise<this | null> { return fromEntry("save").save.call(this) as Promise<this | null>; }
	/** 縮小図を描く（HTMLCanvasElement へ描く・OffscreenCanvas を渡す・props だけ渡して ImageBitmap を受ける） */
	preview(canvas?: HTMLCanvas | OffscreenCanvas, props?: Record<string, unknown>): Promise<ImageBitmap | null>;
	preview(props: Record<string, unknown>): Promise<ImageBitmap | null>;
	preview(canvas?: HTMLCanvas | OffscreenCanvas | Record<string, unknown>, props?: Record<string, unknown>): Promise<ImageBitmap | null> { return fromEntry("preview").preview.call(this, canvas, props); }
	profile(opts?: ExportOptions): Promise<unknown> { return fromEntry("profile").profile.call(this, opts); }
	gintbuf(opts?: ExportOptions): Promise<ArrayBuffer | null> { return fromEntry("gintbuf").gintbuf.call(this, opts); }
	geopbfFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("geopbfFile").geopbfFile.call(this, opts); }
	geojsonFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("geojsonFile").geojsonFile.call(this, opts); }
	topojsonFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("topojsonFile").topojsonFile.call(this, opts); }
	shapeFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("shapeFile").shapeFile.call(this, opts); }
	kmzFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("kmzFile").kmzFile.call(this, opts); }
	gpxFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("gpxFile").gpxFile.call(this, opts); }
	czmlFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("czmlFile").czmlFile.call(this, opts); }
	gmlFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("gmlFile").gmlFile.call(this, opts); }
	fgbFile(opts?: ExportOptions): Promise<File | Blob | null> { return fromEntry("fgbFile").fgbFile.call(this, opts); }
	/** GintBUF を焼く（opts.gint === false は何もしない・encoder worker → 無ければ呼んだスレッドの wasm） */
	gint(opts?: GintOptions): Promise<this> { return fromEntry("gint").gint.call(this, opts) as Promise<this>; }
}
