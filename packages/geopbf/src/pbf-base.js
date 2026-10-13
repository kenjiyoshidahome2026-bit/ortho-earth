import Pbf from "./modules/pbf.js";
import { bufferTub, readBufs } from "./modules/bufferTub.js";
import { isString, isSimpleObject, isFloat, isBbox } from "./modules/utility.js";
import { antimeridianFeature } from "./modules/antimeridianFeature.js";
import { cleanCoords, } from "./modules/cleanCoords.js";
import { runInWorker } from "./modules/workerPool.js";
import { hasWorkerFactory } from "./modules/workerFactory.js";

// Node（main / worker_threads）には ImageData が無い＝参照するだけで ReferenceError。instanceof の前に存在を見る（2026-10-11・俯瞰 §2-B 4）。
// 旧＝CLI と試験 20 本が globalThis.ImageData のスタブで隠していた。読む側（image()）はファイルに IMAGE 型が入っている時だけ参照する
const isImageData = v => typeof ImageData !== "undefined" && v instanceof ImageData;


const TAGS = { NAME: 1, KEYS: 2, PRECISION: 3, BUFS: 4, FARRAY: 5, FEATURE: 6, GEOMETRY: 7, GTYPE: 8, LENGTH: 9, COORDS: 10, VALUE: 11, INDEX: 12, GARRAY: 13, DESCRIPTION: 14, LICENSE: 15, ATTRIBUTION: 16, MIN_ZOOM: 17, MAX_ZOOM: 18 };
const geometryTypes = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
const geometryMap = {}; geometryTypes.forEach((t, i) => geometryMap[t] = i);
const dataTypeNames = ["NULL", "BOOL", "INTEGER", "FLOAT", "STRING", "DATE", "COLOR", "FUNC", "JSON", "BBOX", "BLOB", "IMAGE"];
const DATATYPE = {}; dataTypeNames.map((s, i) => DATATYPE[s] = i); DATATYPE.UNKNOWN = -1;

class GeoPBF {
	constructor(options = {}) {
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
		// noeval＝FUNC 値（型 7）を new Function で復元せず、関数ソース文字列のまま返す。既定 true（2026-10-11・安全既定）＝
		// 未知のファイルの属性を呼ぶだけで任意コードが走る経路を閉じ、CSP（unsafe-eval 無し）でも復号が落ちない。
		// 旧挙動（関数へ復元）は { noeval: false } の明示 opt-in。書く側（dataType/writeValue）は従来どおり関数のソースを FUNC で書く。
		this.noeval = options.noeval !== false;
		// worker:false＝このインスタンスの set(ArrayBuffer)／setGintBUF を main スレッドで解く（createGeopbf の { worker:false } が各インスタンスへ渡す）。
		// 旧＝クラス静的な _workerFactory だけを見ていた＝一度 createGeopbf() を呼ぶと以後の全インスタンスが worker 経路に固定され、
		// Node では `Worker is not defined` で落ちた（2026-10-11・俯瞰 §2-B 5）。undefined＝クラス既定（createGeopbf が配線していれば worker）
		this._useWorker = options.worker === false ? false : undefined;
		// validate＝符号化の検証層（geopbf 改良点 ⑧'・2026-10-12・俯瞰 §2-C 8「黙った欠損」）。set(geojson)／setFeature が地物を書く前に幾何と属性を検める。
		//   "lenient"（既定）＝直せる物は直して数える（NaN／±Infinity の属性 → null、壊れた座標・空の座標・退化した環 → 落とす、
		//                     幾何なし → 落とす。緯度の範囲外は数えるだけで値は変えない）。何を何件直したかは pbf.issues（先頭 100 件＝{ kind, index, detail }）と pbf.issueCount（種別ごと）に残り、close() で 1 行だけ warn
		//   "strict"        ＝最初の問題で throw（Error.issue に { kind, index, detail }）＝取り込みの門にする時
		//   "legacy"        ＝1.19 までの挙動（NaN → 0、Infinity → 例外、Point の [] → (0,0)、緯度は丸めない、幾何なしは warn 1 行で落とす）
		// 単要素の Multi* を単数型に落とす（ワイヤの約束）のは問題ではない＝issueCount.multiDegraded に数えるだけ（throw しない）
		this.validate = options.validate === "strict" ? "strict" : options.validate === "legacy" ? "legacy" : "lenient";
		this.issues = []; this.issueCount = {}; this._fi = 0;   // _fi＝setFeature が見た地物の通し番号（issues の index）
		this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = [];
	}
	// 検証層の記録（lenient＝数える／strict＝throw）。info＝真なら strict でも投げない（multiDegraded）
	_issue(kind, detail, info = false) {
		this.issueCount[kind] = (this.issueCount[kind] || 0) + 1;
		const index = this._fi - 1;   // setFeature が先に進めた通し番号＝今の地物
		if (this.issues.length < 100) this.issues.push({ kind, index, detail });
		if (this.validate === "strict" && !info) { const e = new Error(`GeoPBF validate: ${kind} at feature ${index}${detail ? ` (${detail})` : ""}`); e.issue = { kind, index, detail }; throw e; }
	}
	static setProperty(name, value) {
		if (isString(name)) {
			(name in GeoPBF) || Object.defineProperty(GeoPBF, name, { value, configurable: false, enumerable: false });
		} else Object.entries(name).map(t => GeoPBF.setProperty(...t));
	}
	static setGetter(name, func) { Object.defineProperty(GeoPBF.prototype, name, { get: func, configurable: false, enumerable: false }); }
	static setPrototype(name, func) { Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false }); }

	name(s) { return (s === undefined) ? this._name : this.updateHeader({ name: this._name = s }); }
	description(s) { return (s === undefined) ? this._description : this.updateHeader({ description: this._description = s }); }
	license(s) { return (s === undefined) ? this._license : this.updateHeader({ license: this._license = s }); }
	attribution(s) { return (s === undefined) ? this._attribution : this.updateHeader({ attribution: this._attribution = s }); }
	minZoom(v) { return (v === undefined) ? this._minZoom : this.updateHeader({ minZoom: this._minZoom = v }); }
	maxZoom(v) { return (v === undefined) ? this._maxZoom : this.updateHeader({ maxZoom: this._maxZoom = v }); }
	// 座標の小数桁（ヘッダ PRECISION）の公開アクセサ＝読み取り専用。変更（再エンコード）は extension/precision.js が pbf.js で precision(n) として被せる。
	precision() { return this._precision; }
	init() { this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = []; delete this.end; delete this.ctx; delete this.proj; return this; }
	empty() { this.pbf = new Pbf(); this.init(); this.name(""); return this; }
	destroy() {
		try {
			if (this.bufs) { this.bufs.length = 0; this.bufs = null; }
			if (this.props) { this.props.length = 0; this.props = null; }
			if (this.keys) { this.keys.length = 0; this.keys = null; }
			this.fmap = this.bin = this.pbf = null;
			this._name = this._description = this._license = this._attribution = null;
			this._minZoom = this._maxZoom = null;
		} catch (e) { }
	}
	async set(q) {
		if (q instanceof ArrayBuffer || ArrayBuffer.isView(q)) {
			// ArrayBuffer は worker へ transfer される＝呼び手の q は detach（byteLength 0）。残したい時は q.slice(0) を渡す（reference.md §2）
			if (canUseWorker(this, GeoPBF._workerFactory, GeoPBF._workerUrl)) return _setViaWorker(this, q instanceof ArrayBuffer ? q : q.buffer.slice(q.byteOffset, q.byteOffset + q.byteLength));
			this.pbf = new Pbf(q);
		} else if (isSimpleObject(q)) {
			const [keys, buffs] = this.noprop ? [[], []] : await makeKeys(q.features.map(t => t.properties));
			this.setHead(keys, buffs).setBody(q).close();
		} else return (console.error("PBF set: setting illegal value", q), this);
		return await this.getPosition();
	}
	// skipProps＝VALUE/INDEX を読み飛ばす（props は空のまま＝main が遅延復号）。decoder:pbf Worker の毎ロード経路用＝旧は全 feature の
	// 全値を復号して捨てていた（decoder→main→decoder:pbf で最大 3 回の同じ全復号・俯瞰レビュー 2026-09-15）。dissolve を使う変換 Worker は従来どおり
	async getPosition({ skipProps = false } = {}) {
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
		this.bufs = await bufsReader.close();
		this._bodyPos = pos;
		this.end = pbf.pos;
		if (!bodyPos) return this;
		pbf.pos = bodyPos;
		const nkeys = keys.length;
		pbf.readMessage(tag => {
			if (tag !== TAGS.FEATURE) return;
			var fpos, gpos, type, garray = null, tarray = null;   // GeometryCollection（type 6）の時だけ確保
			const values = skipProps ? null : [], q = skipProps ? undefined : new Array(nkeys);
			fpos = pbf.pos;
			pbf.readMessage(ftag => {
				if (ftag === TAGS.GEOMETRY) {
					gpos = pbf.pos;
					pbf.readMessage(gtag => {
						if (gtag === TAGS.GTYPE) type = pbf.readVarint();
						else if (gtag === TAGS.GARRAY) pbf.readMessage(gatag => {
							if (gatag === TAGS.GEOMETRY) {
								(garray ??= []).push(pbf.pos); tarray ??= [];
								pbf.readMessage(gaatag => (gaatag === TAGS.GTYPE) && tarray.push(pbf.readVarint()));
							}
						});
					});
				} else if (ftag === TAGS.VALUE) { if (skipProps) pbf.pos = pbf.readVarint() + pbf.pos; else { pbf.readVarint(); values.push(readValue(this)); }   // 長さを先に読む（`pos += readVarint()` は左辺の pos を先に読む＝varint 分ずれる罠）
				} else if (ftag === TAGS.INDEX) {
					const end = pbf.readVarint() + pbf.pos;
					if (skipProps) pbf.pos = end;
					else { let vpos = 0; while (pbf.pos < end) q[pbf.readVarint()] = values[vpos++]; }
				}
			});
			fmap.push(type == 6 ? [fpos, gpos, type, garray ?? [], tarray ?? []] : [fpos, gpos, type]);
			props.push(q);
		});
		return this;
	}

	get size() { return this.end; }
	get length() { return (this.fmap || []).length; }
	each(func) { return (this.fmap || []).map((t, i) => func(i, t)); }
	forEach(func) { const a = this.fmap || []; for (let i = 0, n = a.length; i < n; i++) func(i, a[i]); return this; }

	setMessage(tag, func) { this.pbf.writeMessage(tag, func); return this; }

	setHead(keys, bufs, meta = {}) {
		if (meta.name !== undefined) this._name = meta.name;
		if (meta.description !== undefined) this._description = meta.description;
		if (meta.license !== undefined) this._license = meta.license;
		if (meta.attribution !== undefined) this._attribution = meta.attribution;
		if (meta.precision !== undefined) this.e = Math.pow(10, this._precision = meta.precision);
		if (meta.minZoom !== undefined) this._minZoom = meta.minZoom;
		if (meta.maxZoom !== undefined) this._maxZoom = meta.maxZoom;

		this.keys = keys || this.keys;
		this.bufs = bufs || this.bufs || [];
		this.keytub = {}; this.keys.forEach((t, i) => this.keytub[t] = i);
 
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
	updateHeader(meta = {}) {
		if (!this._bodyPos || !this.end) return this;
		const oldBodyPos = this._bodyPos;
		const bodyData = this.pbf.buf.subarray(oldBodyPos, this.end);
		// 器の見積もりは「これから書く値」（meta優先）で。旧値で測ると、後からdescription等の
		// 長い文字列を足した時に足りず Uint8Array.set が範囲外で落ちる。+64はフィールドタグ/varint余裕。
		const nv = k => meta[k] !== undefined ? meta[k] : this["_" + k];
		const len = new TextEncoder().encode(["name","description","license","attribution"].map(k => nv(k) || "").join("")).length + 64;
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
	copyHead(pbf) {
		const meta = { name:pbf._name, description:pbf._description, license:pbf._license, attribution:pbf._attribution, precision:pbf._precision, minZoom:pbf._minZoom, maxZoom:pbf._maxZoom };
		return this.setHead(pbf.keys, pbf.bufs, meta);
	}

	setBody(obj) {
		const func = (obj instanceof Function) ? obj : () => obj.features.forEach(t => this.setFeature(t))
		return this.setMessage(TAGS.FARRAY, func);
	}
	// FARRAY を非同期に書く＝行の取り出しに await が要る変換器（FileGDB の窓読み・Parquet の row group 単位）用。
	// 長さ後置は Pbf.writeRawMessage と同じ手（1 バイト予約→書いてから足りない分だけ後ろへずらす）。fn の中で setFeature を同期に呼ぶ。
	// setBody（同期）と同じく 1 回だけ呼ぶ（FARRAY メッセージは 1 個）。2026-09-16。
	async setBodyAsync(fn) {
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
	setFeature(q) {
		const fi = this._fi++;
		// 幾何なし（null / 型不明）の地物はワイヤに載せられない＝書かずに数える（旧＝GTYPE 抜けの壊れたレコードを書き、読み側が TypeError で飛ばしていた）
		if (!q.geometry || geometryMap[q.geometry.type] == null) {
			if (this.validate !== "legacy") this._issue("nullGeometry", q.geometry ? `type ${q.geometry.type}` : "geometry null");
			if (!this.dropped++ && this.validate === "legacy") console.warn(`GeoPBF: feature without geometry dropped (type: ${q.geometry?.type})`);
			return this;
		}
		if (this.validate !== "legacy") {   // 検証層：壊れた座標・空の座標・退化した環・緯度の範囲外を直すか落とす（幾何が空になった地物は書かない）
			const g = normalizeGeometry(this, q.geometry);
			if (!g) { this.dropped++; return this; }
			if (g !== q.geometry) q = { ...q, geometry: g };
		}
		q.geometry.coordinates = q.geometry.coordinates ||[];
		antimeridianFeature(q, this._am);
		return this.setMessage(TAGS.FEATURE, () => this.setGeometry(q.geometry).setProperties(q.properties));
	}
	setGeometry(q) { return writeGeometry(this, q); }
	setProperties(q) { return writeProperties(this, q); }
	close() {
		this.end = this.pbf.pos; this.pbf.finish();
		const kinds = Object.entries(this.issueCount).filter(([k]) => k !== "multiDegraded");
		if (kinds.length && this.validate === "lenient") console.warn(`GeoPBF: ${kinds.reduce((a, [, n]) => a + n, 0)} issue(s) found while encoding (${kinds.map(([k, n]) => `${k} ${n}`).join(", ")}) = see pbf.issues`);
		return this;
	}

	getFeature(i) { return { type: "Feature", geometry: this.getGeometry(i), properties: this.getProperties(i) }; }
	getGeometry(i, j) { return readGeometry(this, i, j); }
	getProperties(i) { return readProperties(this, i); }
	getType(i) { return i === undefined ? this.each(i => this.getType(i)) : geometryTypes[this.fmap[i][2]]; }

	getGeometryBuffer(i, j) {
		const map = this.fmap[i];
		const pos = this.pbf.pos = (map[2] == 6 && j !== undefined) ? map[3][j] : map[1], len = this.pbf.readVarint();
		var n = len < 128 ? 1 : len < 16384 ? 2 : len < 2097152 ? 3 : 4;
		return this.pbf.buf.slice(pos - 1, pos + len + n);
	}
	setGeometryBuffer(a) { this.pbf.realloc(a.length); this.pbf.buf.set(a, this.pbf.pos); this.pbf.pos += a.length; return this; }
	copyGeometry(pbf, i) { this.setGeometryBuffer(pbf.getGeometryBuffer(i)) }
	copyProperties(pbf, i) { this.setProperties(pbf.getProperties(i)) }
	get features() { return this.each(i => this.getFeature(i)); }
	get geometries() { return this.each(i => this.getGeometry(i)); }
	get properties() { return this.each(i => this.getProperties(i)); }
	// 地物 i の属性の行（keys 順の値の配列）。worker 復号は props を遅延で埋める＝props[i] を直に読むと未復号の undefined を掴む
	propsRow(i) { return this.props[i] !== undefined ? this.props[i] : decodePropsAt(this, i); }
	get propertiesTable() {
		if (this.props) for (let i = 0; i < this.fmap.length; i++) {
			if (this.props[i] === undefined) decodePropsAt(this, i);
		}
		return [this.keys].concat(this.props);
	}
	get arrayBuffer() { return this.pbf.buf.buffer.slice(0, this.end); }
	get headerBuffer() { return this.pbf.buf.buffer.slice(0, this.pbf.pos = this._bodyPos); }
	get geojson() {
		const features = [];
		(this.fmap || []).forEach((_, i) => {
			let f;
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
		return { type: "FeatureCollection", features, name: this.name() };
	}
}

async function makeKeys(q) {
	const tub = {}, buffs = new bufferTub();
	for (let i = 0; i < q.length; i++) {
		const item = q[i];
		if (!isSimpleObject(item)) continue;
		for (let key in item) {
			const v = item[key]; tub[key] = true;
			if (v instanceof Blob) item[key].id = buffs.set(await v.arrayBuffer());
			else if (isImageData(v)) item[key].id = buffs.set(v.data.buffer);
			else if (isSimpleObject(v)) {
				for (let k in v) {
					const u = v[k]; tub[`${key}.${k}`] = true;
					if (u instanceof Blob) u.id = buffs.set(await u.arrayBuffer());
					if (isImageData(u)) u.id = buffs.set(u.data.buffer);
				}
			}
		}
	}
	return [Object.keys(tub).sort(), await buffs.close()];
}

// 色（DATATYPE.COLOR＝4 バイト）で持つのは「読み戻すと一字一句同じ文字列になる」正規形だけ：rgb(r,g,b)・rgba(r,g,b,0.xx)（空白なし・0〜255）。
// それ以外（#hex・空白入り・小数の rgb・#1234 等）は文字列のまま（2026-09-25・B6）。旧＝#1234/#12345/rgb(1.5,2,3) を色と誤認して
// rgba(0,0,0,0.00) に潰し、#abcdef は rgb(171,205,239) に書き換えていた＝保存すると値が変わった。既存ファイルの読みは不変。
function parseColor(s) {
	let r = s.match(/^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),([\d\.]+)\)$/);
	const b = r ? [+r[1], +r[2], +r[3], ~~(+r[4] * 255)] : (r = s.match(/^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/)) ? [+r[1], +r[2], +r[3], 255] : null;
	return b && b.every(v => v >= 0 && v <= 255) ? b : null;
}
const formatColor = a => a.length == 3 || a[3] == 255 ? `rgb(${a[0]},${a[1]},${a[2]})` : `rgba(${a[0]},${a[1]},${a[2]},${(a[3] / 255).toFixed(2)})`;

function dataType(q) {
	// 色判定は全文字列値に走る（地物数×キー数回）＝正規表現の前に先頭文字（r）で門前払い
	const isColor = s => { if (s.charCodeAt(0) !== 114) return false; const b = parseColor(s); return !!b && formatColor(b) === s; };
	if (q == null) return DATATYPE.NULL;
	const type = typeof q;
	if (type === "string") return isColor(q) ? DATATYPE.COLOR : DATATYPE.STRING;
	// 整数でも |q| > 2^52 は FLOAT（double＝bit 同一）で書く。INTEGER の zigzag は 2 倍して varint に乗せるので 2^53 を越えると
	// 読み戻しの Number で丸まり（-(2^53-1) が +(2^53-2) に化けた）、2^64 以上は varint に入らず例外だった（2026-10-12・t-encode-edge）
	else if (type === "number") return isFloat(q) || (Number.isFinite(q) && Math.abs(q) > 4503599627370496) ? DATATYPE.FLOAT : DATATYPE.INTEGER;   // NaN／±Infinity は validate 層が先に裁く（legacy＝NaN → 0・Infinity → 例外のまま）
	else if (type === "boolean") return DATATYPE.BOOL;
	else if (type === "function") return DATATYPE.FUNC;
	else if (q instanceof Date) return DATATYPE.DATE;
	else if (q instanceof Blob) return DATATYPE.BLOB;
	else if (isImageData(q)) return DATATYPE.IMAGE;
	else if (type === "object") return isBbox(q) ? DATATYPE.BBOX : DATATYPE.JSON;
	return DATATYPE.UNKNOWN;
}

function writeValue(self, q) {
	const { pbf } = self;
	if (q == null || q == undefined) return;
	const type = dataType(q)
	switch (type) {
		case DATATYPE.STRING: return pbf.writeStringField(type, q)
		case DATATYPE.FLOAT: return pbf.writeDoubleField(type, q);
		case DATATYPE.INTEGER: return pbf.writeSVarintField(type, q);
		case DATATYPE.BOOL: return pbf.writeBooleanField(type, q);
		case DATATYPE.JSON: return pbf.writeStringField(type, JSON.stringify(q));
		case DATATYPE.BLOB: return pbf.writeStringField(type, [q.name || "", q.type || "", q.id].join(":"));
		case DATATYPE.FUNC: return pbf.writeStringField(type, q.toString());
		case DATATYPE.IMAGE: return pbf.writeStringField(type, [q.width, q.height, q.id].join(":"));
		case DATATYPE.DATE: return pbf.writeSVarintField(type, Math.round(+q / 1000));
		case DATATYPE.BBOX: return pbf.writePackedDouble(type, q);
		case DATATYPE.COLOR: return pbf.writeBytesField(type, parseColor(q));   // dataType が正規形だけを COLOR にする＝必ず解ける
	}
}

function readValue(self) {
	const { pbf, bufs, bin } = self;
	switch (pbf.readVarint() >> 3) {
		case DATATYPE.STRING: return pbf.readString();
		case DATATYPE.FLOAT: return pbf.readDouble();
		case DATATYPE.INTEGER: return pbf.readSVarint();
		case DATATYPE.BOOL: return pbf.readBoolean();
		case DATATYPE.JSON: return JSON.parse(pbf.readString());
		case DATATYPE.BLOB: return blob(pbf.readString());
		case DATATYPE.FUNC: { const s = pbf.readString(); return self.noeval ? s : new Function(`return ${s}`); }
		case DATATYPE.IMAGE: return image(pbf.readString());
		case DATATYPE.DATE: return new Date(pbf.readSVarint() * 1000);
		case DATATYPE.BBOX: return new Float64Array(pbf.readPackedDouble());
		case DATATYPE.COLOR: return formatColor(pbf.readBytes());
	}
	return null;
	function blob(s) {
		if (s in bin) return bin[s];
		const [name, type, id] = s.split(":"), buf = bufs[+id];
		return bin[s] = name ? new File([buf], name, { type }) : new Blob([buf], { type });
	}
	function image(s) {
		if (s in bin) return bin[s];
		const [width, height, id] = s.split(":").map(t => +t);
		return bin[s] = new ImageData(new Uint8ClampedArray(bufs[id]), width, height);
	}
}

function writeProperties(self, q) {
	const { pbf, keytub } = self;
	var index = []; if (self.noprop) return
	const badNum = (v, k) => typeof v === "number" && !Number.isFinite(v) && self.validate !== "legacy" && (self._issue("badNumber", `${k}: ${v}`), true);   // NaN／±Infinity → null（書かない）。legacy＝NaN → 0・Infinity → 例外
	for (var key in q) if (q[key] != null) {
		var v = q[key];
		if (isSimpleObject(v) && Object.keys(v).every(k => `${key}.${k}` in keytub)) {
			for (let k in v) if (v[k] != null && !badNum(v[k], `${key}.${k}`)) { pbf.writeMessage(TAGS.VALUE, () => writeValue(self, v[k])); index.push(keytub[`${key}.${k}`]); }
		} else if (!badNum(v, key)) { pbf.writeMessage(TAGS.VALUE, () => writeValue(self, v)); index.push(keytub[key]); }
	}
	pbf.writePackedVarint(TAGS.INDEX, index);
}

function decodePropsAt(self, n) {
	const { pbf, keys, fmap } = self;
	const savedPos = pbf.pos;
	pbf.pos = fmap[n][0];
	const q = new Array(keys.length), values = [];
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

function readProperties(self, n) {
	const { keys, props } = self, q = {};
	const row = props[n] !== undefined ? props[n] : decodePropsAt(self, n);
	row.forEach((v, i) => {
		const key = keys[i].split(/\./);
		if (key.length == 1) q[key[0]] = v;
		else { q[key[0]] = q[key[0]] || {}; q[key[0]][key.slice(1).join(".")] = v; }
	});
	return q;
}

// 検証層（validate: lenient／strict）：座標を検めて直した幾何を返す（元のまま使える時は同じオブジェクト）。空になった幾何＝null（呼び手が地物を落とす）
//   位置＝[x, y, …] で x・y が有限の数。そうでない位置は落とす（badCoordinate）。|緯度| > 90 は数えるだけ（latitude・値は不変）。経度は writeGeometry の fix が ±180 に畳む
//   Point: 位置でない → emptyCoords。MultiPoint/LineString: 位置を濾す（LineString は 2 点未満 → emptyCoords）。
//   Polygon: 環ごとに濾し、4 位置未満（閉合込み・= 3 頂点未満）の環は落とす（degenerateRing）。外環が落ちた多角形は落ちる。Multi*: 要素ごと・空になれば落とす。GeometryCollection: 要素ごと
function normalizeGeometry(self, g) {
	const type = g.type, c = g.coordinates;
	let changed = false;
	const pos = p => {
		if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { self._issue("badCoordinate", JSON.stringify(p)?.slice(0, 40)); changed = true; return null; }
		if (p[1] > 90 || p[1] < -90) self._issue("latitude", String(p[1]), true);   // 範囲外の緯度＝数えるだけ（値は変えない＝CRS 無しの図面などを壊さない。strict でも投げない）
		return p;
	};
	const line = (l, min, what) => { if (!Array.isArray(l)) { self._issue(what, "not an array"); changed = true; return null; } const out = l.map(pos).filter(Boolean); if (out.length < min) { if (out.length === l.length) { self._issue(what, `${out.length} position(s)`); changed = true; } return null; } if (out.length !== l.length) changed = true; return out; };
	const ring = r => line(r, 4, "degenerateRing");
	const poly = rs => { if (!Array.isArray(rs) || !rs.length) { self._issue("emptyCoords", "Polygon without rings"); changed = true; return null; } const outer = ring(rs[0]); if (!outer) return null; const holes = rs.slice(1).map(ring).filter(Boolean); if (holes.length !== rs.length - 1) changed = true; return [outer, ...holes]; };
	let out;
	switch (type) {
		case "Point": if (!Array.isArray(c) || !c.length) { self._issue("emptyCoords", "Point []"); return null; } out = pos(c); if (!out) return null; break;
		case "MultiPoint": out = line(c, 1, "emptyCoords"); if (!out) return null; break;
		case "LineString": out = line(c, 2, "emptyCoords"); if (!out) return null; break;
		case "MultiLineString": { if (!Array.isArray(c)) { self._issue("emptyCoords", "not an array"); return null; } out = c.map(l => line(l, 2, "emptyCoords")).filter(Boolean); if (!out.length) { if (!c.length) self._issue("emptyCoords", "MultiLineString []"); return null; } if (out.length !== c.length) changed = true; break; }
		case "Polygon": out = poly(c); if (!out) return null; break;
		case "MultiPolygon": { if (!Array.isArray(c)) { self._issue("emptyCoords", "not an array"); return null; } out = c.map(poly).filter(Boolean); if (!out.length) { if (!c.length) self._issue("emptyCoords", "MultiPolygon []"); return null; } if (out.length !== c.length) changed = true; break; }
		case "GeometryCollection": { const gs = (g.geometries || []).map(x => geometryMap[x.type] == null ? (self._issue("nullGeometry", `type ${x.type}`), null) : normalizeGeometry(self, x)).filter(Boolean); if (!gs.length) { self._issue("emptyCoords", "GeometryCollection []"); return null; } return gs.length === (g.geometries || []).length && gs.every((x, i) => x === g.geometries[i]) ? g : { ...g, geometries: gs }; }
		default: return g;
	}
	return changed ? { ...g, coordinates: out } : g;
}

function writeGeometry(self, q) {
	const { pbf, e } = self;
	return self.setMessage(TAGS.GEOMETRY, () => {
		const fix = n => { while (n < -180) n += 360; while (n > 180) n -= 360; return n; };
		let type = geometryMap[q.type], c = q.coordinates;
		if (type == null) return console.error("illegal geometry type: ", q.type);
		if (type % 2 == 1 && c.length == 1) { type--; c = c[0]; if (self.validate !== "legacy") self._issue("multiDegraded", q.type, true); }   // 単要素の Multi* → 単数型（ワイヤの約束・数えるだけ）
		pbf.writeVarintField(TAGS.GTYPE, type);
		if (type == 6) return pbf.writeMessage(TAGS.GARRAY, () => q.geometries.forEach(t => writeGeometry(self, t)));
		[write0, write1, write1, write2, write2, write3][type]();
		pbf.writePackedSVarint(TAGS.COORDS, c.flat(Infinity));
		function len2() { return c.map(t => t.length); }
		function len3() { const l = [c.length]; c.forEach(t => { l.push(t.length); t.forEach(u => l.push(u.length)); }); return l; }
		function write0() { c = [Math.round(fix(c[0]) * e), Math.round(c[1] * e)]; }
		function write1() { c = diff(c); }
		function write2() { c = c.map(diff).filter(r => r.length > 0); pbf.writePackedVarint(TAGS.LENGTH, len2()); }
		function write3() { c = c.map(t => t.map(diff).filter(r => r.length > 0)).filter(p => p.length > 0); pbf.writePackedVarint(TAGS.LENGTH, len3()); }
		function diff(line) {
			if (!line || !line.length) return [];
			let sum = [0, 0], src = [], p = [];
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

function readGeometry(self, n, m) {
	const { pbf, fmap, e } = self, map = fmap[n];
	return (map[2] < 6) ? read(map[1], map[2]) : m !== undefined ? read(map[3][m], map[4][m]) : { type: geometryTypes[6], geometries: map[3].map((t, i) => read(t, map[4][i])) };
	function read(pos, type) {
		pbf.pos = pos;
		var q = { type: geometryTypes[type] }, isPoly = type > 3, lens = [], end;
		const funcs = [read0, read1, read1, read2, read2, read3][type];
		return pbf.readMessage((tag, q) => {
			if (tag === TAGS.LENGTH) pbf.readPackedVarint(lens);
			else if (tag === TAGS.COORDS) { end = pbf.readVarint() + pbf.pos; q.coordinates = funcs(); }
		}, q);
		function readCoords(p) { p = p || [0, 0]; p[0] += pbf.readSVarint(); p[1] += pbf.readSVarint(); return p; }
		function magCoords(p) { return [p[0] / e, p[1] / e]; }
		function read_n(n) { var c = [], p = [0, 0]; while (n-- > 0) c.push(magCoords(p = readCoords(p))); isPoly && c.length && c.push(c[0]); return c; }
		function read0() { return magCoords(readCoords()); }
		function read1() { var c = [], p = [0, 0]; while (pbf.pos < end) c.push(magCoords(readCoords(p))); return c; }
		function read2() { return lens.map(t => read_n(t)); }
		function read3() { const c = []; let pos = 0; for (var i = 0; i < lens[0]; i++) { var n = lens[++pos]; c[i] = []; for (var j = 0; j < n; j++) c[i].push(read_n(lens[++pos])); } return c; }
	}
}

GeoPBF.setProperty({ TAGS, makeKeys, dataType, dataTypeNames, geometryTypes, geometryMap });

// worker 経路を使うか：インスタンスの worker:false が最優先。次にクラスに配線（createGeopbf）があるか。配線が geopbf 自身の
// 入口（builtinWorker＝new Worker）に頼る時は、その場に Worker が居る時だけ（Node の main には無い＝main スレッドで解く）。
// ホストの入口（setWorkerFactory）があれば Worker の有無はホストの責任
export function canUseWorker(self, factory, url) {
	if (self._useWorker === false) return false;
	if (!factory && !url) return false;
	return hasWorkerFactory() || typeof Worker !== "undefined";
}

function _setViaWorker(self, buf) {
	// ファクトリ優先＝new Worker(new URL(…)) 直書きをバンドラに見せる（URL変数経由はビルドでdata:URL化して死ぬ）。
	// 生成はプールが握る＝1 件ごとの new Worker/terminate をやめ、レーンを使い回す（modules/workerPool.js の由来書き参照）
	const factory = GeoPBF._workerFactory || (() => new Worker(GeoPBF._workerUrl, { type: "module" }));
	return runInWorker("decoder:pbf", factory, { buf }, [buf])
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
const valKey = v => v === null || v === undefined ? "n" : v instanceof Date ? "d" + v.getTime() : typeof v === "object" ? "o" + JSON.stringify(v) : (typeof v)[0] + String(v);
export const propsKeyOf = row => JSON.stringify(row.map(valKey));
export { GeoPBF, makeKeys };   // makeKeys＝ストリームエンコード（set() を自前でなぞる呼び出し側＝geoedit）用に公開 2026-08-20