// GeoPBF の器（"geopbf/pbf-base"・"geopbf/core"）＝符号化・復号・ヘッダ・地物の読み書き。解析・操作・位相・書き出しは pbf.ts の GeoPBF（extends GeoPBFBase）。
// TS 化 段 4（2026-10-16）：旧＝同じ class に pbf.js／index.js が import 時に prototype を足していた＝器だけのはずの core にも拡張が生えた。今は別の class。
import Pbf from "./modules/pbf.ts";
import type { WriteFn } from "./modules/pbf.ts";
import { bufferTub, readBufs } from "./modules/bufferTub.ts";
import { isString, isSimpleObject, isFloat, isBbox } from "./modules/utility.ts";
import { antimeridianFeature } from "./modules/antimeridianFeature.ts";
import type { AMFeature } from "./modules/antimeridianFeature.ts";
import { cleanCoords, } from "./modules/cleanCoords.ts";
import { runInWorker } from "./modules/workerPool.ts";
import type { LaneFactory } from "./modules/workerPool.ts";
import { hasWorkerFactory } from "./modules/workerFactory.ts";
import type { PbfDecodeResponse } from "./worker-msg.ts";
import type {
	Feature, FeatureCollection, Geometry, GeometryCollection, GeometryType, GeoPBFOptions, HeaderMeta, IssueKind, MakeKeys,
	Position, Properties, UnPackGint, ValidateIssue, ValidateMode, WireTags,
} from "../types/geopbf.js";
export type { Feature, FeatureCollection, Geometry, GeometryType, Properties, Position, GeoPBFOptions, HeaderMeta, UnPackGint, WireTags } from "../types/geopbf.js";

/** fmap の 1 行＝[fpos, gpos, type]。GeometryCollection（type 6）だけ [fpos, gpos, 6, garray, tarray] */
export type FMapEntry = [fpos: number, gpos: number, type: number, garray?: number[], tarray?: number[]];
/** setHead の meta（HeaderMeta に精度を足した物＝copyHead が写す） */
type HeadMeta = HeaderMeta & { precision?: number };
/** 検証層が投げる Error（issue に { kind, index, detail }） */
type IssueError = Error & { issue?: ValidateIssue };
/** 属性値の Blob／ImageData に書き込む BUFS の通し番号 */
type WithId = { id?: number };

// Node（main / worker_threads）には ImageData が無い＝参照するだけで ReferenceError。instanceof の前に存在を見る（2026-10-11・俯瞰 §2-B 4）。
// 旧＝CLI と試験 20 本が globalThis.ImageData のスタブで隠していた。読む側（image()）はファイルに IMAGE 型が入っている時だけ参照する
const isImageData = (v: unknown): v is ImageData => typeof ImageData !== "undefined" && v instanceof ImageData;


const TAGS: WireTags = { NAME: 1, KEYS: 2, PRECISION: 3, BUFS: 4, FARRAY: 5, FEATURE: 6, GEOMETRY: 7, GTYPE: 8, LENGTH: 9, COORDS: 10, VALUE: 11, INDEX: 12, GARRAY: 13, DESCRIPTION: 14, LICENSE: 15, ATTRIBUTION: 16, MIN_ZOOM: 17, MAX_ZOOM: 18 };
const geometryTypes: GeometryType[] = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
const geometryMap = {} as Record<GeometryType, number>; geometryTypes.forEach((t, i) => geometryMap[t] = i);
const dataTypeNames = ["NULL", "BOOL", "INTEGER", "FLOAT", "STRING", "DATE", "COLOR", "FUNC", "JSON", "BBOX", "BLOB", "IMAGE"];
const DATATYPE: Record<string, number> = {}; dataTypeNames.map((s, i) => DATATYPE[s] = i); DATATYPE.UNKNOWN = -1;

export class GeoPBFBase {
	// ── 静的な名簿（クラスの定義の後で defineProperty＝書き換え不可・非列挙。旧 GeoPBF.setProperty と同じ）
	declare static readonly TAGS: WireTags;
	declare static readonly makeKeys: MakeKeys;
	/** 属性値のワイヤ型（dataTypeNames の添字・不明＝-1） */
	declare static readonly dataType: (value: unknown) => number;
	declare static readonly dataTypeNames: readonly string[];
	declare static readonly geometryTypes: readonly GeometryType[];
	declare static readonly geometryMap: Readonly<Record<GeometryType, number>>;
	/** @internal createGeopbf（index.ts）が配線する復号 worker の入口（ブラウザ用） */
	declare static _workerFactory?: () => Worker | null;
	/** @internal */
	declare static _gintWorkerFactory?: () => Worker | null;
	// 旧 static setProperty／setGetter／setPrototype は 2.0 で撤去（使い手は pbf.js／index.js の後付けだけだった＝今は class のメンバー）

	// ── 欄（declare＝実行時の欄は今までどおり constructor と各メソッドが置く＝無い欄を undefined で生やさない）
	/** @internal ワイヤの読み書き手（decoder/moj は entry ごとに差し替える・convert/geoparquet が幾何を整数のまま読む） */
	declare pbf: Pbf;
	/** @internal */
	declare _name: string; declare _description: string; declare _license: string; declare _attribution: string;
	/** @internal */
	declare _minZoom: number | null; declare _maxZoom: number | null;
	/** @internal 精度（10^n）と 10^_precision */
	declare _precision: number; declare e: number;
	/** 幾何なし・修復不能で落とした地物数 */
	declare dropped: number;
	/** 属性を書かない */
	declare readonly noprop: boolean;
	/** antimeridian で切った地物数 */
	declare cutCount: number;
	/** @internal */
	declare _am: { cut: boolean; onCut: () => void };
	/** @internal */
	declare _useWorker: false | undefined;
	/** 符号化の検証層 */
	declare readonly validate: ValidateMode;
	/** 符号化の検証層が見つけた問題（先頭 100 件） */
	declare readonly issues: ValidateIssue[];
	/** 種類ごとの件数 */
	declare readonly issueCount: Partial<Record<IssueKind, number>>;
	/** @internal setFeature が見た地物の通し番号 */
	declare _fi: number;
	/** 属性の鍵（keys の順が propsRow の順） */
	declare keys: string[];
	/** @internal */
	declare bufs: ArrayBuffer[];
	/** @internal */
	declare fmap: FMapEntry[];
	/** @internal 属性の Blob／ImageData の控え（同じ値は同じ物） */
	declare bin: Record<string, Blob | ImageData>;
	/** @internal 地物ごとの属性の行（keys の順・worker 復号では遅延＝undefined） */
	declare props: unknown[][];
	/** @internal getPosition（_bodyPos）・close（end） */
	declare _bodyPos: number; declare end: number;
	/** @internal setHead が組む（鍵 → 添字） */
	declare keytub?: Record<string, number>;
	/** Gint を焼いた後に付く（setGintBUF／gint()） */
	declare unPackGint?: UnPackGint | null;
	declare _gintBuffer?: ArrayBuffer | SharedArrayBuffer | null;
	/** 入口が URL の控えから返した時の URL（index.ts） */
	declare originalURL?: string;
	/** geopbf(input, { cacheKey }) で置いた鍵・meta */
	declare _cacheKey?: string; declare cacheMeta?: Record<string, unknown> | null;
	/** @internal 入口（index.ts）の File の控えの鍵・旧版 GINT の印 */
	declare _fileKey?: string; declare _staleGint?: boolean;
	/** @internal pbf-io の版（ETag） */
	declare _etag?: string | null;

	constructor(options: GeoPBFOptions = {}) {
		this.pbf = new Pbf();
		this._name = options.name || "";
		this._description = options.description || "";
		this._license = options.license || "";
		this._attribution = options.attribution || "";
		this._minZoom = options.minZoom ?? null;
		this._maxZoom = options.maxZoom ?? null;
		this.e = Math.pow(10, this._precision = options.precision || 6);
		this.dropped = 0;   // setFeature が幾何なしで落とした地物数
		this.noprop = !!options.noprop;
		// cut:false＝エンコード時の antimeridian 切断（antimeridianFeature）を掛けない＝geopbf を「往復しても形が変わらない
		// 器」として使う時（geoedit のセッション保存）。既定は切断（表示/識別/相互運用の正典）。cutCount＝切断した feature 数。
		this.cutCount = 0;
		this._am = { cut: options.cut !== false, onCut: () => { this.cutCount++; } };
		// FUNC 値（型 7）は常に関数ソース文字列のまま返す（1.19 で既定・2.0 で唯一の挙動＝{ noeval: false } の new Function 復元は撤去）。
		// 未知のファイルの属性を呼ぶだけで任意コードが走る経路は無く、CSP（unsafe-eval 無し）でも復号が落ちない。書く側（dataType/writeValue）は従来どおり関数のソースを FUNC で書く。
		// worker:false＝このインスタンスの set(ArrayBuffer)／setGintBUF を main スレッドで解く（createGeopbf の { worker:false } が各インスタンスへ渡す）。
		// 旧＝クラス静的な _workerFactory だけを見ていた＝一度 createGeopbf() を呼ぶと以後の全インスタンスが worker 経路に固定され、
		// Node では `Worker is not defined` で落ちた（2026-10-11・俯瞰 §2-B 5）。undefined＝クラス既定（createGeopbf が配線していれば worker）
		this._useWorker = options.worker === false ? false : undefined;
		// validate＝符号化の検証層（geopbf 改良点 ⑧'・2026-10-12・俯瞰 §2-C 8「黙った欠損」）。set(geojson)／setFeature が地物を書く前に幾何と属性を検める。
		//   "lenient"（既定）＝直せる物は直して数える（NaN／±Infinity の属性 → null、壊れた座標・空の座標・退化した環 → 落とす、
		//                     幾何なし → 落とす。緯度の範囲外は数えるだけで値は変えない）。何を何件直したかは pbf.issues（先頭 100 件＝{ kind, index, detail }）と pbf.issueCount（種別ごと）に残り、close() で 1 行だけ warn
		//   "strict"        ＝最初の問題で throw（Error.issue に { kind, index, detail }）＝取り込みの門にする時
		//   （"legacy"＝1.19 までの挙動（NaN → 0・Point の [] → (0,0)）は 2.0 で撤去＝lenient に落ちる）
		// 単要素の Multi* を単数型に落とす（ワイヤの約束）のは問題ではない＝issueCount.multiDegraded に数えるだけ（throw しない）
		this.validate = options.validate === "strict" ? "strict" : "lenient";
		this.issues = []; this.issueCount = {}; this._fi = 0;   // _fi＝setFeature が見た地物の通し番号（issues の index）
		this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = [];
	}
	// 検証層の記録（lenient＝数える／strict＝throw）。info＝真なら strict でも投げない（multiDegraded）
	/** @internal */
	_issue(kind: IssueKind, detail?: string, info = false): void {
		this.issueCount[kind] = (this.issueCount[kind] || 0) + 1;
		const index = this._fi - 1;   // setFeature が先に進めた通し番号＝今の地物
		if (this.issues.length < 100) this.issues.push({ kind, index, detail });
		if (this.validate === "strict" && !info) { const e: IssueError = new Error(`GeoPBF validate: ${kind} at feature ${index}${detail ? ` (${detail})` : ""}`); e.issue = { kind, index, detail }; throw e; }
	}

	name(): string; name(s: string): this;
	name(s?: string): string | this { return (s === undefined) ? this._name : this.updateHeader({ name: this._name = s }); }
	description(): string; description(s: string): this;
	description(s?: string): string | this { return (s === undefined) ? this._description : this.updateHeader({ description: this._description = s }); }
	license(): string; license(s: string): this;
	license(s?: string): string | this { return (s === undefined) ? this._license : this.updateHeader({ license: this._license = s }); }
	attribution(): string; attribution(s: string): this;
	attribution(s?: string): string | this { return (s === undefined) ? this._attribution : this.updateHeader({ attribution: this._attribution = s }); }
	minZoom(): number | null; minZoom(v: number | null): this;
	minZoom(v?: number | null): number | null | this { return (v === undefined) ? this._minZoom : this.updateHeader({ minZoom: this._minZoom = v }); }
	maxZoom(): number | null; maxZoom(v: number | null): this;
	maxZoom(v?: number | null): number | null | this { return (v === undefined) ? this._maxZoom : this.updateHeader({ maxZoom: this._maxZoom = v }); }
	// 座標の小数桁（ヘッダ PRECISION）の公開アクセサ＝読み取り専用。変更（再エンコード）は extension/precision.ts が pbf.ts の GeoPBF で precision(n) として被せる。
	precision(): number { return this._precision; }
	/** @internal */
	init(): this { this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = []; const w = this as Partial<Record<"end" | "ctx" | "proj", unknown>>; delete w.end; delete w.ctx; delete w.proj; return this; }
	empty(): this { this.pbf = new Pbf(); this.init(); this.name(""); return this; }
	destroy(): void {
		// 解放＝欄を null にする（型の上は非 null の欄＝壊した後は使わない約束）
		const w = this as unknown as Record<"bufs" | "props" | "keys" | "fmap" | "bin" | "pbf" | "_name" | "_description" | "_license" | "_attribution" | "_minZoom" | "_maxZoom", unknown>;
		try {
			if (this.bufs) { this.bufs.length = 0; w.bufs = null; }
			if (this.props) { this.props.length = 0; w.props = null; }
			if (this.keys) { this.keys.length = 0; w.keys = null; }
			w.fmap = w.bin = w.pbf = null;
			w._name = w._description = w._license = w._attribution = null;
			w._minZoom = w._maxZoom = null;
		} catch (e) { }
	}
	/** FeatureCollection・ArrayBuffer・TypedArray（SharedArrayBuffer の上の view も可）を読む。ArrayBuffer は worker 経路では転送されて detached になる */
	async set(q: FeatureCollection | ArrayBuffer | ArrayBufferView): Promise<this> {
		if (q instanceof ArrayBuffer || ArrayBuffer.isView(q)) {
			// ArrayBuffer は worker へ transfer される＝呼び手の q は detach（byteLength 0）。残したい時は q.slice(0) を渡す（reference.md §2）
			if (canUseWorker(this, GeoPBFBase._workerFactory)) return _setViaWorker(this, q instanceof ArrayBuffer ? q : q.buffer.slice(q.byteOffset, q.byteOffset + q.byteLength) as ArrayBuffer);
			this.pbf = new Pbf(q);
		} else if (isSimpleObject(q)) {
			const [keys, buffs] = this.noprop ? [[], []] : await makeKeys(q.features.map(t => t.properties));
			this.setHead(keys, buffs).setBody(q).close();
		} else return (console.error("PBF set: setting illegal value", q), this);
		return await this.getPosition();
	}
	// skipProps＝VALUE/INDEX を読み飛ばす（props は空のまま＝main が遅延復号）。decoder:pbf Worker の毎ロード経路用＝旧は全 feature の
	// 全値を復号して捨てていた（decoder→main→decoder:pbf で最大 3 回の同じ全復号・俯瞰レビュー 2026-09-15）。dissolve を使う変換 Worker は従来どおり
	/** ヘッダ（と skipProps でなければ属性）を読んで fmap を組む（close() の後に呼ぶ＝length・props が揃う） */
	async getPosition({ skipProps = false }: { skipProps?: boolean } = {}): Promise<this> {
		this.init();
		const pbf = this.pbf, keys = this.keys, fmap = this.fmap, props = this.props;
		const bufsReader = new readBufs();
		let pos = 0, bodyPos = 0;
		pbf.readFields(tag => {
			if (tag === TAGS.NAME) this.name(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.DESCRIPTION) this.description(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.LICENSE) this.license(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.ATTRIBUTION) this.attribution(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.MIN_ZOOM) this._minZoom = pbf.readVarint(), pos = pbf.pos;
			else if (tag === TAGS.MAX_ZOOM) this._maxZoom = pbf.readVarint(), pos = pbf.pos;
			else if (tag === TAGS.KEYS) keys.push(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.BUFS) bufsReader.set(pbf.readBytes()), pos = pbf.pos;
			else if (tag === TAGS.PRECISION) this.e = Math.pow(10, this._precision = pbf.readVarint()), pos = pbf.pos;
			else if (tag === TAGS.FARRAY) bodyPos = pbf.pos;
		});
		this.bufs = await bufsReader.close() as ArrayBuffer[];
		this._bodyPos = pos;
		this.end = pbf.pos;
		if (!bodyPos) return this;
		pbf.pos = bodyPos;
		const nkeys = keys.length;
		pbf.readMessage(tag => {
			if (tag !== TAGS.FEATURE) return;
			var fpos: number, gpos: number | undefined, type: number | undefined, garray: number[] | null = null, tarray: number[] | null = null;   // GeometryCollection（type 6）の時だけ確保
			const values: unknown[] | null = skipProps ? null : [], q: unknown[] | undefined = skipProps ? undefined : new Array(nkeys);
			fpos = pbf.pos;
			pbf.readMessage(ftag => {
				if (ftag === TAGS.GEOMETRY) {
					gpos = pbf.pos;
					pbf.readMessage(gtag => {
						if (gtag === TAGS.GTYPE) type = pbf.readVarint();
						else if (gtag === TAGS.GARRAY) pbf.readMessage(gatag => {
							if (gatag === TAGS.GEOMETRY) {
								(garray ??= []).push(pbf.pos); tarray ??= [];
								pbf.readMessage(gaatag => (gaatag === TAGS.GTYPE) && tarray!.push(pbf.readVarint()));
							}
						});
					});
				} else if (ftag === TAGS.VALUE) { if (skipProps) pbf.pos = pbf.readVarint() + pbf.pos; else { pbf.readVarint(); values!.push(readValue(this)); }   // 長さを先に読む（`pos += readVarint()` は左辺の pos を先に読む＝varint 分ずれる罠）
				} else if (ftag === TAGS.INDEX) {
					const end = pbf.readVarint() + pbf.pos;
					if (skipProps) pbf.pos = end;
					else { let vpos = 0; while (pbf.pos < end) q![pbf.readVarint()] = values![vpos++]; }
				}
			});
			fmap.push(type == 6 ? [fpos, gpos!, type, garray ?? [], tarray ?? []] : [fpos, gpos!, type!]);
			props.push(q!);
		});
		return this;
	}

	/** 符号化した bytes */
	get size(): number { return this.end; }
	/** 地物数 */
	get length(): number { return (this.fmap || []).length; }
	each<T>(func: (index: number, fmap: FMapEntry) => T): T[] { return (this.fmap || []).map((t, i) => func(i, t)); }
	forEach(func: (index: number, fmap: FMapEntry) => void): this { const a = this.fmap || []; for (let i = 0, n = a.length; i < n; i++) func(i, a[i]); return this; }

	/** FEATURE 等のメッセージを直に書く（fn の中で copyGeometry／setProperties） */
	setMessage(tag: number, func: WriteFn<undefined>): this { this.pbf.writeMessage(tag, func); return this; }

	/** ストリーム符号化（set() を自前でなぞる呼び手向け）。setHead → setFeature… → close */
	setHead(keys: string[], bufs?: ArrayBuffer[], meta: HeadMeta = {}): this {
		if (meta.name !== undefined) this._name = meta.name;
		if (meta.description !== undefined) this._description = meta.description;
		if (meta.license !== undefined) this._license = meta.license;
		if (meta.attribution !== undefined) this._attribution = meta.attribution;
		if (meta.precision !== undefined) this.e = Math.pow(10, this._precision = meta.precision);
		if (meta.minZoom !== undefined) this._minZoom = meta.minZoom;
		if (meta.maxZoom !== undefined) this._maxZoom = meta.maxZoom;

		this.keys = keys || this.keys;
		this.bufs = bufs || this.bufs || [];
		const keytub: Record<string, number> = this.keytub = {}; this.keys.forEach((t, i) => keytub[t] = i);

		this._name && this.pbf.writeStringField(TAGS.NAME, this._name);
		this._description && this.pbf.writeStringField(TAGS.DESCRIPTION, this._description);
		this._license && this.pbf.writeStringField(TAGS.LICENSE, this._license);
		this._attribution && this.pbf.writeStringField(TAGS.ATTRIBUTION, this._attribution);
		this._minZoom != null && this.pbf.writeVarintField(TAGS.MIN_ZOOM, this._minZoom);
		this._maxZoom != null && this.pbf.writeVarintField(TAGS.MAX_ZOOM, this._maxZoom);
		this.pbf.writeVarintField(TAGS.PRECISION, this._precision);
		this.keys.forEach((t, i) => { this.pbf.writeStringField(TAGS.KEYS, t); });
		this.bufs.forEach((t, i) => { this.pbf.writeBytesField(TAGS.BUFS, new Uint8Array(t)) });
		return this;
	}
	updateHeader(meta: HeadMeta = {}): this {
		if (!this._bodyPos || !this.end) return this;
		const oldBodyPos = this._bodyPos;
		const bodyData = this.pbf.buf.subarray(oldBodyPos, this.end);
		// 器の見積もりは「これから書く値」（meta優先）で。旧値で測ると、後からdescription等の
		// 長い文字列を足した時に足りず Uint8Array.set が範囲外で落ちる。+64はフィールドタグ/varint余裕。
		const nv = (k: "name" | "description" | "license" | "attribution"): string => meta[k] !== undefined ? meta[k] : this[`_${k}`];
		const len = new TextEncoder().encode((["name","description","license","attribution"] as const).map(k => nv(k) || "").join("")).length + 64;
		const buffer = new ArrayBuffer(this.end + len);
		this.pbf = new Pbf(buffer);
		this.setHead(this.keys, this.bufs, meta);
		const newBodyPos = this.pbf.pos;
		this.pbf.buf.set(bodyData, this.pbf.pos); this.pbf.pos += bodyData.length;
		this.close();
		this._bodyPos = newBodyPos;
		const diff = newBodyPos - oldBodyPos;
		if (this.fmap && diff !== 0) {
			this.fmap.forEach(f => {
				f[0] += diff; f[1] += diff;
				if (f[2] === 6 && f[3]) f[3] = f[3].map(p => p + diff);
			});
		}
		return this;
	}
	copyHead(pbf: GeoPBFBase): this {
		const meta = { name:pbf._name, description:pbf._description, license:pbf._license, attribution:pbf._attribution, precision:pbf._precision, minZoom:pbf._minZoom, maxZoom:pbf._maxZoom };
		return this.setHead(pbf.keys, pbf.bufs, meta);
	}

	/** FARRAY を書く＝FeatureCollection の全地物か、setFeature／setMessage を自前で呼ぶ関数 */
	setBody(obj: FeatureCollection | (() => void)): this {
		const func = (obj instanceof Function) ? obj : () => obj.features.forEach(t => this.setFeature(t))
		return this.setMessage(TAGS.FARRAY, func);
	}
	// FARRAY を非同期に書く＝行の取り出しに await が要る変換器（FileGDB の窓読み・Parquet の row group 単位）用。
	// 長さ後置は Pbf.writeRawMessage と同じ手（1 バイト予約→書いてから足りない分だけ後ろへずらす）。fn の中で setFeature を同期に呼ぶ。
	// setBody（同期）と同じく 1 回だけ呼ぶ（FARRAY メッセージは 1 個）。2026-09-16。
	async setBodyAsync(fn: () => Promise<void>): Promise<this> {
		const pbf = this.pbf;
		pbf.writeTag(TAGS.FARRAY, 2);   // BYTES
		pbf.pos++;
		const startPos = pbf.pos;
		await fn();
		const len = pbf.pos - startPos;
		if (len >= 0x80) {
			let extra = 0; for (let n = len; n > 0x7f; n = Math.floor(n / 128)) extra++;
			pbf.realloc(extra);
			pbf.buf.copyWithin(startPos + extra, startPos, pbf.pos);
		}
		pbf.pos = startPos - 1;
		pbf.writeVarint(len);
		pbf.pos += len;
		return this;
	}
	setFeature(q: Feature): this {
		this._fi++;
		// 幾何なし（null / 型不明）の地物はワイヤに載せられない＝書かずに数える（旧＝GTYPE 抜けの壊れたレコードを書き、読み側が TypeError で飛ばしていた）
		if (!q.geometry || geometryMap[q.geometry.type] == null) {
			this._issue("nullGeometry", q.geometry ? `type ${q.geometry.type}` : "geometry null");
			this.dropped++;
			return this;
		}
		{   // 検証層：壊れた座標・空の座標・退化した環・緯度の範囲外を直すか落とす（幾何が空になった地物は書かない）
			const g = normalizeGeometry(this, q.geometry);
			if (!g) { this.dropped++; return this; }
			if (g !== q.geometry) q = { ...q, geometry: g };
		}
		const geometry = q.geometry as Geometry & { coordinates?: unknown };
		geometry.coordinates = geometry.coordinates ||[];
		antimeridianFeature(q as AMFeature, this._am);
		return this.setMessage(TAGS.FEATURE, () => this.setGeometry(q.geometry!).setProperties(q.properties));
	}
	/** 幾何そのものを書く（setFeature の内側・検証層は通らない） */
	setGeometry(q: Geometry): this { return writeGeometry(this, q); }
	/** 属性そのものを書く（返り値なし） */
	setProperties(q: Properties | undefined): void { return writeProperties(this, q); }
	close(): this {
		this.end = this.pbf.pos; this.pbf.finish();
		const kinds = (Object.entries(this.issueCount) as [IssueKind, number][]).filter(([k]) => k !== "multiDegraded");
		if (kinds.length && this.validate === "lenient") console.warn(`GeoPBF: ${kinds.reduce((a, [, n]) => a + n, 0)} issue(s) found while encoding (${kinds.map(([k, n]) => `${k} ${n}`).join(", ")}) = see pbf.issues`);
		return this;
	}

	getFeature(i: number): Feature { return { type: "Feature", geometry: this.getGeometry(i), properties: this.getProperties(i) }; }
	getGeometry(i: number, j?: number): Geometry | null { return readGeometry(this, i, j); }
	getProperties(i: number): Properties { return readProperties(this, i); }
	getType(): GeometryType[]; getType(i: number): GeometryType;
	getType(i?: number): GeometryType | GeometryType[] { return i === undefined ? this.each(i => this.getType(i)) : geometryTypes[this.fmap[i][2]]; }

	getGeometryBuffer(i: number, j?: number): Uint8Array {
		const map = this.fmap[i];
		const pos = this.pbf.pos = (map[2] == 6 && j !== undefined) ? map[3]![j] : map[1], len = this.pbf.readVarint();
		var n = len < 128 ? 1 : len < 16384 ? 2 : len < 2097152 ? 3 : 4;
		return this.pbf.buf.slice(pos - 1, pos + len + n);
	}
	setGeometryBuffer(a: Uint8Array): this { this.pbf.realloc(a.length); this.pbf.buf.set(a, this.pbf.pos); this.pbf.pos += a.length; return this; }
	copyGeometry(pbf: GeoPBFBase, i: number): void { this.setGeometryBuffer(pbf.getGeometryBuffer(i)) }
	copyProperties(pbf: GeoPBFBase, i: number): void { this.setProperties(pbf.getProperties(i)) }
	get features(): Feature[] { return this.each(i => this.getFeature(i)); }
	get geometries(): (Geometry | null)[] { return this.each(i => this.getGeometry(i)); }
	get properties(): Properties[] { return this.each(i => this.getProperties(i)); }
	// 地物 i の属性の行（keys 順の値の配列）。worker 復号は props を遅延で埋める＝props[i] を直に読むと未復号の undefined を掴む
	/** keys の順の属性値（遅延復号） */
	propsRow(i: number): unknown[] { return this.props[i] !== undefined ? this.props[i] : decodePropsAt(this, i); }
	get propertiesTable(): unknown[][] {
		if (this.props) for (let i = 0; i < this.fmap.length; i++) {
			if (this.props[i] === undefined) decodePropsAt(this, i);
		}
		return ([this.keys] as unknown[][]).concat(this.props);
	}
	get arrayBuffer(): ArrayBuffer { return this.pbf.buf.buffer.slice(0, this.end) as ArrayBuffer; }
	get headerBuffer(): ArrayBuffer { return this.pbf.buf.buffer.slice(0, this.pbf.pos = this._bodyPos) as ArrayBuffer; }
	get geojson(): FeatureCollection {
		const features: Feature[] = [];
		(this.fmap || []).forEach((_, i) => {
			let f: Feature;
			try {
				f = this.getFeature(i);
			} catch (e) {
				console.warn(`GeoPBF: Feature[${i}] could not be read and was skipped.`, e);
				return;
			}
			const g = f.geometry;
			if (g != null && g.type !== "GeometryCollection" && !Array.isArray(g.coordinates)) {
				console.warn(`GeoPBF: Feature[${i}] has invalid geometry (coordinates missing) and was skipped.`);
				return;
			}
			features.push({ type: "Feature", geometry: g ?? null, properties: f.properties });
		});
		return { type: "FeatureCollection", features, name: this.name() } as FeatureCollection;
	}
}

async function makeKeys(q: readonly (object | null | undefined)[]): Promise<[keys: string[], bufs: ArrayBuffer[]]> {
	const tub: Record<string, boolean> = {}, buffs = new bufferTub();
	for (let i = 0; i < q.length; i++) {
		const item = q[i] as Record<string, unknown>;
		if (!isSimpleObject(item)) continue;
		for (let key in item) {
			const v = item[key]; tub[key] = true;
			if (v instanceof Blob) (item[key] as WithId).id = buffs.set(await v.arrayBuffer());
			else if (isImageData(v)) (item[key] as WithId).id = buffs.set(v.data.buffer);
			else if (isSimpleObject(v)) {
				const o = v as Record<string, unknown>;
				for (let k in o) {
					const u = o[k]; tub[`${key}.${k}`] = true;
					if (u instanceof Blob) (u as WithId).id = buffs.set(await u.arrayBuffer());
					if (isImageData(u)) (u as WithId).id = buffs.set(u.data.buffer);
				}
			}
		}
	}
	return [Object.keys(tub).sort(), await buffs.close() as ArrayBuffer[]];
}

// 色（DATATYPE.COLOR＝4 バイト）で持つのは「読み戻すと一字一句同じ文字列になる」正規形だけ：rgb(r,g,b)・rgba(r,g,b,0.xx)（空白なし・0〜255）。
// それ以外（#hex・空白入り・小数の rgb・#1234 等）は文字列のまま（2026-09-25・B6）。旧＝#1234/#12345/rgb(1.5,2,3) を色と誤認して
// rgba(0,0,0,0.00) に潰し、#abcdef は rgb(171,205,239) に書き換えていた＝保存すると値が変わった。既存ファイルの読みは不変。
function parseColor(s: string): number[] | null {
	let r = s.match(/^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),([\d\.]+)\)$/);
	const b = r ? [+r[1], +r[2], +r[3], ~~(+r[4] * 255)] : (r = s.match(/^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/)) ? [+r[1], +r[2], +r[3], 255] : null;
	return b && b.every(v => v >= 0 && v <= 255) ? b : null;
}
const formatColor = (a: ArrayLike<number>): string => a.length == 3 || a[3] == 255 ? `rgb(${a[0]},${a[1]},${a[2]})` : `rgba(${a[0]},${a[1]},${a[2]},${(a[3] / 255).toFixed(2)})`;

function dataType(q: unknown): number {
	// 色判定は全文字列値に走る（地物数×キー数回）＝正規表現の前に先頭文字（r）で門前払い
	const isColor = (s: string): boolean => { if (s.charCodeAt(0) !== 114) return false; const b = parseColor(s); return !!b && formatColor(b) === s; };
	if (q == null) return DATATYPE.NULL;
	const type = typeof q;
	if (type === "string") return isColor(q as string) ? DATATYPE.COLOR : DATATYPE.STRING;
	// 整数でも |q| > 2^52 は FLOAT（double＝bit 同一）で書く。INTEGER の zigzag は 2 倍して varint に乗せるので 2^53 を越えると
	// 読み戻しの Number で丸まり（-(2^53-1) が +(2^53-2) に化けた）、2^64 以上は varint に入らず例外だった（2026-10-12・t-encode-edge）
	else if (type === "number") return isFloat(q) || (Number.isFinite(q) && Math.abs(q as number) > 4503599627370496) ? DATATYPE.FLOAT : DATATYPE.INTEGER;   // NaN／±Infinity は validate 層が先に裁く（badNumber＝書かない）
	else if (type === "boolean") return DATATYPE.BOOL;
	else if (type === "function") return DATATYPE.FUNC;
	else if (q instanceof Date) return DATATYPE.DATE;
	else if (q instanceof Blob) return DATATYPE.BLOB;
	else if (isImageData(q)) return DATATYPE.IMAGE;
	else if (type === "object") return isBbox(q) ? DATATYPE.BBOX : DATATYPE.JSON;
	return DATATYPE.UNKNOWN;
}

function writeValue(self: GeoPBFBase, q: unknown): void {
	const { pbf } = self;
	if (q == null || q == undefined) return;
	const type = dataType(q)
	switch (type) {
		case DATATYPE.STRING: return pbf.writeStringField(type, q as string)
		case DATATYPE.FLOAT: return pbf.writeDoubleField(type, q as number);
		case DATATYPE.INTEGER: return pbf.writeSVarintField(type, q as number);
		case DATATYPE.BOOL: return pbf.writeBooleanField(type, q as boolean);
		case DATATYPE.JSON: return pbf.writeStringField(type, JSON.stringify(q));
		case DATATYPE.BLOB: { const b = q as Blob & { name?: string } & WithId; return pbf.writeStringField(type, [b.name || "", b.type || "", b.id].join(":")); }
		case DATATYPE.FUNC: return pbf.writeStringField(type, (q as Function).toString());
		case DATATYPE.IMAGE: { const m = q as ImageData & WithId; return pbf.writeStringField(type, [m.width, m.height, m.id].join(":")); }
		case DATATYPE.DATE: return pbf.writeSVarintField(type, Math.round(+(q as Date) / 1000));
		case DATATYPE.BBOX: return pbf.writePackedDouble(type, q as number[]);
		case DATATYPE.COLOR: return pbf.writeBytesField(type, parseColor(q as string)!);   // dataType が正規形だけを COLOR にする＝必ず解ける
	}
}

function readValue(self: GeoPBFBase): unknown {
	const { pbf, bufs, bin } = self;
	switch (pbf.readVarint() >> 3) {
		case DATATYPE.STRING: return pbf.readString();
		case DATATYPE.FLOAT: return pbf.readDouble();
		case DATATYPE.INTEGER: return pbf.readSVarint();
		case DATATYPE.BOOL: return pbf.readBoolean();
		case DATATYPE.JSON: return JSON.parse(pbf.readString());
		case DATATYPE.BLOB: return blob(pbf.readString());
		case DATATYPE.FUNC: return pbf.readString();   // 関数のソース文字列のまま（new Function で復元しない＝2.0 で唯一の挙動）
		case DATATYPE.IMAGE: return image(pbf.readString());
		case DATATYPE.DATE: return new Date(pbf.readSVarint() * 1000);
		case DATATYPE.BBOX: return new Float64Array(pbf.readPackedDouble());
		case DATATYPE.COLOR: return formatColor(pbf.readBytes());
	}
	return null;
	function blob(s: string): Blob | ImageData {
		if (s in bin) return bin[s];
		const [name, type, id] = s.split(":"), buf = bufs[+id];
		return bin[s] = name ? new File([buf], name, { type }) : new Blob([buf], { type });
	}
	function image(s: string): Blob | ImageData {
		if (s in bin) return bin[s];
		const [width, height, id] = s.split(":").map(t => +t);
		return bin[s] = new ImageData(new Uint8ClampedArray(bufs[id]), width, height);
	}
}

function writeProperties(self: GeoPBFBase, q: Properties | undefined): void {
	const { pbf } = self, keytub = self.keytub!;
	var index: number[] = []; if (self.noprop) return
	const badNum = (v: unknown, k: string): boolean => typeof v === "number" && !Number.isFinite(v) && (self._issue("badNumber", `${k}: ${v}`), true);   // NaN／±Infinity → null（書かない）
	for (var key in q) if (q[key] != null) {
		var v: unknown = q[key];
		if (isSimpleObject(v) && Object.keys(v as object).every(k => `${key}.${k}` in keytub)) {
			const o = v as Record<string, unknown>;
			for (let k in o) if (o[k] != null && !badNum(o[k], `${key}.${k}`)) { pbf.writeMessage(TAGS.VALUE, () => writeValue(self, o[k])); index.push(keytub[`${key}.${k}`]); }
		} else if (!badNum(v, key)) { pbf.writeMessage(TAGS.VALUE, () => writeValue(self, v)); index.push(keytub[key]); }
	}
	pbf.writePackedVarint(TAGS.INDEX, index);
}

function decodePropsAt(self: GeoPBFBase, n: number): unknown[] {
	const { pbf, keys, fmap } = self;
	const savedPos = pbf.pos;
	pbf.pos = fmap[n][0];
	const q: unknown[] = new Array(keys.length), values: unknown[] = [];
	pbf.readMessage(ftag => {
		if (ftag === TAGS.VALUE) { pbf.readVarint(); values.push(readValue(self)); }
		else if (ftag === TAGS.INDEX) {
			const end = pbf.readVarint() + pbf.pos; let vpos = 0;
			while (pbf.pos < end) q[pbf.readVarint()] = values[vpos++];
		}
		// Unknown fields (e.g. GEOMETRY) are left to readFields' automatic skip logic.
	});
	pbf.pos = savedPos;
	return self.props[n] = q;
}

function readProperties(self: GeoPBFBase, n: number): Properties {
	const { keys, props } = self, q: Record<string, unknown> = {};
	const row = props[n] !== undefined ? props[n] : decodePropsAt(self, n);
	row.forEach((v, i) => {
		const key = keys[i].split(/\./);
		if (key.length == 1) q[key[0]] = v;
		else { const o = (q[key[0]] = q[key[0]] || {}) as Record<string, unknown>; o[key.slice(1).join(".")] = v; }
	});
	return q;
}

// 検証層（validate: lenient／strict）：座標を検めて直した幾何を返す（元のまま使える時は同じオブジェクト）。空になった幾何＝null（呼び手が地物を落とす）
//   位置＝[x, y, …] で x・y が有限の数。そうでない位置は落とす（badCoordinate）。|緯度| > 90 は数えるだけ（latitude・値は不変）。経度は writeGeometry の fix が ±180 に畳む
//   Point: 位置でない → emptyCoords。MultiPoint/LineString: 位置を濾す（LineString は 2 点未満 → emptyCoords）。
//   Polygon: 環ごとに濾し、4 位置未満（閉合込み・= 3 頂点未満）の環は落とす（degenerateRing）。外環が落ちた多角形は落ちる。Multi*: 要素ごと・空になれば落とす。GeometryCollection: 要素ごと
function normalizeGeometry(self: GeoPBFBase, g: Geometry): Geometry | null {
	const type = g.type, c = (g as { coordinates?: unknown }).coordinates;
	let changed = false;
	const pos = (p: unknown): Position | null => {
		if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { self._issue("badCoordinate", JSON.stringify(p)?.slice(0, 40)); changed = true; return null; }
		if (p[1] > 90 || p[1] < -90) self._issue("latitude", String(p[1]), true);   // 範囲外の緯度＝数えるだけ（値は変えない＝CRS 無しの図面などを壊さない。strict でも投げない）
		return p;
	};
	const line = (l: unknown, min: number, what: IssueKind): Position[] | null => { if (!Array.isArray(l)) { self._issue(what, "not an array"); changed = true; return null; } const out = l.map(pos).filter(Boolean) as Position[]; if (out.length < min) { if (out.length === l.length) { self._issue(what, `${out.length} position(s)`); changed = true; } return null; } if (out.length !== l.length) changed = true; return out; };
	const ring = (r: unknown): Position[] | null => line(r, 4, "degenerateRing");
	const poly = (rs: unknown): Position[][] | null => { if (!Array.isArray(rs) || !rs.length) { self._issue("emptyCoords", "Polygon without rings"); changed = true; return null; } const outer = ring(rs[0]); if (!outer) return null; const holes = rs.slice(1).map(ring).filter(Boolean) as Position[][]; if (holes.length !== rs.length - 1) changed = true; return [outer, ...holes]; };
	let out: unknown;
	switch (type) {
		case "Point": if (!Array.isArray(c) || !c.length) { self._issue("emptyCoords", "Point []"); return null; } out = pos(c); if (!out) return null; break;
		case "MultiPoint": out = line(c, 1, "emptyCoords"); if (!out) return null; break;
		case "LineString": out = line(c, 2, "emptyCoords"); if (!out) return null; break;
		case "MultiLineString": { if (!Array.isArray(c)) { self._issue("emptyCoords", "not an array"); return null; } const o = c.map(l => line(l, 2, "emptyCoords")).filter(Boolean); out = o; if (!o.length) { if (!c.length) self._issue("emptyCoords", "MultiLineString []"); return null; } if (o.length !== c.length) changed = true; break; }
		case "Polygon": out = poly(c); if (!out) return null; break;
		case "MultiPolygon": { if (!Array.isArray(c)) { self._issue("emptyCoords", "not an array"); return null; } const o = c.map(poly).filter(Boolean); out = o; if (!o.length) { if (!c.length) self._issue("emptyCoords", "MultiPolygon []"); return null; } if (o.length !== c.length) changed = true; break; }
		case "GeometryCollection": { const gs = (g.geometries || []).map(x => geometryMap[x.type] == null ? (self._issue("nullGeometry", `type ${x.type}`), null) : normalizeGeometry(self, x)).filter(Boolean) as Geometry[]; if (!gs.length) { self._issue("emptyCoords", "GeometryCollection []"); return null; } return gs.length === (g.geometries || []).length && gs.every((x, i) => x === g.geometries[i]) ? g : { ...g, geometries: gs }; }
		default: return g;
	}
	return changed ? { ...g, coordinates: out } as Geometry : g;
}

function writeGeometry<T extends GeoPBFBase>(self: T, q: Geometry): T {
	const { pbf, e } = self;
	return self.setMessage(TAGS.GEOMETRY, () => {
		const fix = (n: number): number => { while (n < -180) n += 360; while (n > 180) n -= 360; return n; };
		let type = geometryMap[q.type], c = (q as { coordinates?: unknown }).coordinates as unknown[];
		if (type == null) return console.error("illegal geometry type: ", q.type);
		if (type % 2 == 1 && c.length == 1) { type--; c = c[0] as unknown[]; self._issue("multiDegraded", q.type, true); }   // 単要素の Multi* → 単数型（ワイヤの約束・数えるだけ）
		pbf.writeVarintField(TAGS.GTYPE, type);
		if (type == 6) return pbf.writeMessage(TAGS.GARRAY, () => (q as GeometryCollection).geometries.forEach(t => writeGeometry(self, t)));
		[write0, write1, write1, write2, write2, write3][type]();
		pbf.writePackedSVarint(TAGS.COORDS, c.flat(Infinity) as number[]);
		function len2(): number[] { return (c as unknown[][]).map(t => t.length); }
		function len3(): number[] { const cc = c as unknown[][][], l = [cc.length]; cc.forEach(t => { l.push(t.length); t.forEach(u => l.push((u as unknown[]).length)); }); return l; }
		function write0(): void { const p = c as number[]; c = [Math.round(fix(p[0]) * e), Math.round(p[1] * e)]; }
		function write1(): void { c = diff(c as Position[]); }
		function write2(): void { c = (c as Position[][]).map(diff).filter(r => r.length > 0); pbf.writePackedVarint(TAGS.LENGTH, len2()); }
		function write3(): void { c = (c as Position[][][]).map(t => t.map(diff).filter(r => r.length > 0)).filter(p => p.length > 0); pbf.writePackedVarint(TAGS.LENGTH, len3()); }
		function diff(line: Position[]): number[][] {
			if (!line || !line.length) return [];
			let sum = [0, 0], src: number[][] = [], p: number[][] = [];
			for (let i = 0, len = line.length; i < len; i++) {
				let x = Math.round(fix(line[i][0]) * e), y = Math.round(line[i][1] * e);
				if (src.length > 0 && src[src.length - 1][0] === x && src[src.length - 1][1] === y) continue;
				src.push([x, y]);
			}
			if (type > 3 && src.length >= 3) src = cleanCoords(src);
			for (let i = 0; i < src.length; i++) {
				let t = src[i]; p.push([t[0] - sum[0], t[1] - sum[1]]);
				sum[0] = t[0]; sum[1] = t[1];
			}
			if (type > 3 && p.length > 0) p.pop();
			return p;
		}
	});
}

/** fmap に積んだ幾何の型の番号（geometryTypes の添字＝0 Point … 5 MultiPolygon・6 GeometryCollection） */
type GeometryTypeIndex = number;

function readGeometry(self: GeoPBFBase, n: number, m?: number): Geometry | null {
	const { pbf, fmap, e } = self, map = fmap[n];
	return (map[2] < 6) ? read(map[1], map[2]) : m !== undefined ? read(map[3]![m], map[4]![m]) : { type: geometryTypes[6], geometries: map[3]!.map((t, i) => read(t, map[4]![i])) } as Geometry;
	/** type＝geometryTypes の添字（ファイルのバイト由来＝壊れたファイルでは 0–5 の外もありうる） */
	function read(pos: number, type: GeometryTypeIndex): Geometry {
		pbf.pos = pos;
		var q: { type: GeometryType; coordinates?: unknown } = { type: geometryTypes[type] }, isPoly = type > 3, lens: number[] = [], end: number;
		const funcs: (() => unknown) | undefined = [read0, read1, read1, read2, read2, read3][type];
		return pbf.readMessage((tag, q) => {
			if (tag === TAGS.LENGTH) pbf.readPackedVarint(lens);
			else if (tag === TAGS.COORDS) {
				// 読み手の無い型（壊れたファイル）＝はっきりした Error（旧＝TypeError: funcs is not a function・CodeQL）。投げる時機は旧と同じ（COORDS を読む時）
				if (typeof funcs !== "function") throw new Error(`geopbf: unknown geometry type ${type}`);
				end = pbf.readVarint() + pbf.pos; q.coordinates = funcs();
			}
		}, q) as Geometry;
		function readCoords(p?: number[]): number[] { p = p || [0, 0]; p[0] += pbf.readSVarint(); p[1] += pbf.readSVarint(); return p; }
		function magCoords(p: number[]): number[] { return [p[0] / e, p[1] / e]; }
		function read_n(n: number): number[][] { var c: number[][] = [], p = [0, 0]; while (n-- > 0) c.push(magCoords(p = readCoords(p))); isPoly && c.length && c.push(c[0]); return c; }
		function read0(): number[] { return magCoords(readCoords()); }
		function read1(): number[][] { var c: number[][] = [], p = [0, 0]; while (pbf.pos < end) c.push(magCoords(readCoords(p))); return c; }
		function read2(): number[][][] { return lens.map(t => read_n(t)); }
		function read3(): number[][][][] { const c: number[][][][] = []; let pos = 0; for (var i = 0; i < lens[0]; i++) { var n = lens[++pos]; c[i] = []; for (var j = 0; j < n; j++) c[i].push(read_n(lens[++pos])); } return c; }
	}
}

// 静的な名簿（旧 GeoPBF.setProperty と同じ＝既にあれば足さない・書き換え不可・非列挙）
for (const [name, value] of Object.entries({ TAGS, makeKeys, dataType, dataTypeNames, geometryTypes, geometryMap })) {
	(name in GeoPBFBase) || Object.defineProperty(GeoPBFBase, name, { value, configurable: false, enumerable: false });
}

// worker 経路を使うか：インスタンスの worker:false が最優先。次にクラスに配線（createGeopbf の _workerFactory／_gintWorkerFactory）があるか。
// 配線が geopbf 自身の入口（builtinWorker＝new Worker）に頼る時は、その場に Worker が居る時だけ（Node の main には無い＝main スレッドで解く）。
// ホストの入口（setWorkerFactory）があれば Worker の有無はホストの責任。
// 旧の _workerUrl（URL 変数から new Worker）の経路は 2.0 で撤去＝誰も代入していなかった（URL 変数経由はビルドで data:URL 化して死ぬので factory 直書きが正）
/** worker 経路を使うか＝インスタンスの worker:false → クラスの配線（factory）→ その場に Worker が居るか */
export function canUseWorker(self: GeoPBFBase, factory?: (() => Worker | null) | null): boolean {
	if (self._useWorker === false) return false;
	if (!factory) return false;
	return hasWorkerFactory() || typeof Worker !== "undefined";
}

function _setViaWorker<T extends GeoPBFBase>(self: T, buf: ArrayBuffer): Promise<T> {
	// 生成はプールが握る＝1 件ごとの new Worker/terminate をやめ、レーンを使い回す（modules/workerPool.ts の由来書き参照）
	return runInWorker<PbfDecodeResponse>("decoder:pbf", GeoPBFBase._workerFactory as LaneFactory, { buf }, [buf])
		.then(r => {
			self.init();
			self.pbf          = new Pbf(r.buf);
			self.fmap         = r.fmap;
			self.props        = new Array(r.fmap.length); // pre-allocated empty array for lazy property decoding
			self.keys         = r.keys;
			self.bufs         = r.bufs;
			self._name        = r._name;
			self._description = r._description;
			self._license     = r._license;
			self._attribution = r._attribution;
			self._minZoom     = r._minZoom;
			self._maxZoom     = r._maxZoom;
			self.e            = Math.pow(10, self._precision = r._precision);
			self._bodyPos     = r._bodyPos;
			self.end          = r.end;
			return self;
		});
}

// 属性の行 → 同一判定の鍵（型ごと：1 と "1"、"" と null、["a|","b"] と ["a","|b"] を別にする）。dissolve・gint の地物台帳で共通
const valKey = (v: unknown): string => v === null || v === undefined ? "n" : v instanceof Date ? "d" + v.getTime() : typeof v === "object" ? "o" + JSON.stringify(v) : (typeof v)[0] + String(v);
export const propsKeyOf = (row: unknown[]): string => JSON.stringify(row.map(valKey));
// makeKeys＝ストリームエンコード（set() を自前でなぞる呼び出し側＝geoedit）用に公開 2026-08-20。
// GeoPBF＝器の旧名（"geopbf/pbf-base"・"geopbf/core" の GeoPBF は器だけ＝拡張メソッドは "geopbf" の GeoPBF）
export { GeoPBFBase as GeoPBF, makeKeys };
