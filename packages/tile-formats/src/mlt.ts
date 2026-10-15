// MLT（MapLibre Tile・maplibre-tile-spec）→ @ortho-earth/core の中間表現（decodeMVT と同じ形・#88）。
//   decodeMLT(bytes, need?) → { [層名]: { extent, features: [{ type: "Point"|"LineString"|"Polygon", props, geom: { coords: Int32Array, ends }, id }] } }
// 解読の本体は公式ライブラリ @maplibre/mlt（decodeTile → FeatureTable[]）。ここは列指向の FeatureTable を地物の列に組み直すだけ。
//
// 幾何：ライブラリの getGeometries() は頂点ごとに Point オブジェクトを作り、MultiPolygon では外周／穴の構造を捨てて輪を平らに並べる。
// ここでは位相（topologyVector＝geometry／part／ring の offsets）を自分で歩き、頂点をフラットな Int32Array へ直に詰める
// （ライブラリの geometryVectorConverter と同じ歩き方・辞書／Morton 符号化の頂点は getVertex に任せる・三角形分割済み（GpuVector）は頂点が並び順）。
// リングは MVT の loadGeometry 互換で閉じる（先頭点の複製を末尾に）。
// 面の向き：輪の順も向きも**書かれたまま**返す（構造で向きを直さない）。下流（core の polygons()・globe の classifyRings）は MVT と同じく
// 符号付き面積＝巻き方で外周と穴を分け、MapLibre も MLT の輪を巻き方で分ける（@maplibre/mlt の classifyRings）。MVT から変換した MLT は
// MVT と同じ輪の列に解けるので「同じタイルは同じ絵」になる（向きの規約を破った MVT を許す既存の寛容さも、MLT でそのまま効く）。
// Multi*＝MVT と同じく同じ型の複数パート（MultiPoint＝点ごとに ends・MultiLineString＝線ごと・MultiPolygon＝輪ごと・外周→穴の順）。
//
// 属性：列（propertyVectors）の名前がそのままキー。struct（共有辞書＝name／name:en／name:ja…）はライブラリが親の列名＋子の名前の平たいキーに展開して
// 返すので MVT と同じキー名になる。MAP（入れ子）は値がオブジェクト／配列のまま入る（expr の ["get", key, obj]／["at"] で引ける）。
// int64／uint64 の値と id は bigint で来る＝MVT（readVarint64＝Number）に合わせて Number へ（2^53 を超える精度は落ちる＝MVT と同じ）。
//
// 層ごとの独立：MLT のタイルは「長さ＋タグ＋層」のブロックの連結＝ブロックを自分で切り分けて 1 層ずつライブラリに渡す。
//   ・need（style が参照する source-layer）の外の層はブロックの頭で名前だけ読んで捨てる＝復号しない（MVT の未参照層の素通りと同じ）
//   ・1 層の失敗（未対応の列型など）はその層だけ空にして一度警告し、他の層と描画は止めない
import { decodeTile as decodeFeatureTables } from "@maplibre/mlt";

const POINT = 0, LINESTRING = 1, POLYGON = 2, MULTIPOINT = 3, MULTILINESTRING = 4, MULTIPOLYGON = 5;   // @maplibre/mlt GEOMETRY_TYPE
const TYPE_OF = ["Point", "LineString", "Polygon", "Point", "LineString", "Polygon"];
const utf8 = new TextDecoder();
const warned = new Set();
const warnOnce = (key, msg) => { if (warned.has(key)) return; warned.add(key); console.warn(msg); };

export function decodeMLT(bytes, need) {
	const out = {}, n = bytes.length;
	let pos = 0;
	while (pos < n) {
		const [len, bodyStart] = varint(bytes, pos);
		const end = bodyStart + len;
		if (end > n) throw new Error(`MLT block overruns tile (${end} > ${n})`);
		const [tag, p] = varint(bytes, bodyStart);
		if (tag === 1 || tag === 2) {   // 埋め込みメタデータ付きの層（ライブラリが読む 2 種のタグ・他は読み飛ばす）
			const name = peekName(bytes, p, end);
			if (!need || name == null || need.has(name)) {
				try { for (const ft of decodeFeatureTables(bytes.subarray(pos, end))) out[ft.name] = convertTable(ft); }
				catch (err) { warnOnce(`${name}|${err?.message}`, `[mlt] layer "${name ?? "?"}": ${err?.message || err} — this layer is drawn empty`); }
			}
		}
		pos = end;
	}
	return out;
}

// ブロックの頭＝[長さ][タグ][層名の長さ][層名 utf8][extent]…＝名前だけ覗く（ライブラリの embeddedTilesetMetadata と同じ並び）
function peekName(b, p, end) {
	try { const [len, q] = varint(b, p); if (q + len > end) return null; return utf8.decode(b.subarray(q, q + len)); } catch { return null; }
}
function varint(b, p) {
	let v = 0, s = 1, byte;
	do { byte = b[p++]; v += (byte & 0x7f) * s; s *= 128; } while (byte & 0x80);
	return [v, p];
}

// ── FeatureTable → { extent, features } ──
function convertTable(ft) {
	const gv = ft.geometryVector, n = gv.numGeometries;
	const idv = ft.idVector ?? null, pvs = ft.propertyVectors.filter(Boolean);
	const geoms = walkGeometry(gv, n);
	const features = new Array(n);
	for (let i = 0; i < n; i++) {
		const props = Object.create(null);
		for (const pv of pvs) { const v = pv.getValue(i); if (v !== null && v !== undefined) props[pv.name] = typeof v === "bigint" ? Number(v) : v; }
		let id;
		if (idv) { const v = idv.getValue(i); if (v !== null && v !== undefined) id = typeof v === "bigint" ? Number(v) : v; }
		features[i] = { type: geoms[i].type, props, geom: geoms[i].geom, id };
	}
	return { extent: ft.extent, features };
}

// 位相を歩いてフラットな coords＋ends へ（共有スクラッチに展開し地物ごとに 1 回の slice で確定＝core/decode.js と同じ流儀）
let scratch = new Int32Array(1 << 12);
function grow(min) { const b = new Int32Array(Math.max(scratch.length * 2, min)); b.set(scratch); scratch = b; }
function walkGeometry(gv, n) {
	const topo = gv.topologyVector || {}, gOff = topo.geometryOffsets, pOff = topo.partOffsets, rOff = topo.ringOffsets;
	const vb = gv.vertexBuffer;
	const direct = !!gv.triangleOffsets || !gv.vertexOffsets || gv.vertexOffsets.length === 0;   // GpuVector（三角形分割済み）と辞書なし＝頂点は並び順
	let containsPolygon = false;
	for (let i = 0; i < n; i++) { const t = gv.geometryType(i); if (t === POLYGON || t === MULTIPOLYGON) { containsPolygon = true; break; } }
	let g = 1, p = 1, r = 1, k = 0, m = 0;   // offsets の走査位置（[0]＝0 の番兵）・k＝頂点の通し番号・m＝スクラッチの書き込み位置
	const out = new Array(n);
	let ends;
	const push = () => {
		if (m + 2 > scratch.length) grow(m + 2);
		if (direct) { scratch[m++] = vb[k * 2]; scratch[m++] = vb[k * 2 + 1]; } else { const v = gv.getVertex(k); scratch[m++] = v[0]; scratch[m++] = v[1]; }
		k++;
	};
	const line = nv => { for (let j = 0; j < nv; j++) push(); ends.push(m); };
	const ring = nv => {
		const s = m;
		for (let j = 0; j < nv; j++) push();
		if (nv > 0) { if (m + 2 > scratch.length) grow(m + 2); scratch[m] = scratch[s]; scratch[m + 1] = scratch[s + 1]; m += 2; }   // 閉じる（loadGeometry 互換）
		ends.push(m);
	};
	const polygon = numRings => { for (let j = 0; j < numRings; j++) { const nv = rOff[r] - rOff[r - 1]; r++; ring(nv); } };
	const nextLen = () => { let nv; if (containsPolygon) { nv = rOff[r] - rOff[r - 1]; r++; } else nv = pOff[p] - pOff[p - 1]; p++; return nv; };   // 線の頂点数（面が混ざる層では ring の段に入る）
	for (let i = 0; i < n; i++) {
		const t = gv.geometryType(i);
		m = 0; ends = [];
		switch (t) {
			case POINT: push(); ends.push(m); if (gOff) g++; if (pOff) p++; if (rOff) r++; break;
			case MULTIPOINT: { const np = gOff[g] - gOff[g - 1]; g++; for (let j = 0; j < np; j++) { push(); ends.push(m); } p += np; r += np; break; }
			case LINESTRING: line(nextLen()); if (gOff) g++; break;
			case MULTILINESTRING: { const nl = gOff[g] - gOff[g - 1]; g++; for (let j = 0; j < nl; j++) line(nextLen()); break; }
			case POLYGON: { const nr = pOff[p] - pOff[p - 1]; p++; polygon(nr); if (gOff) g++; break; }
			case MULTIPOLYGON: { const npg = gOff[g] - gOff[g - 1]; g++; for (let j = 0; j < npg; j++) { const nr = pOff[p] - pOff[p - 1]; p++; polygon(nr); } break; }
			default: throw new Error(`unsupported geometry type ${t}`);
		}
		out[i] = { type: TYPE_OF[t], geom: { coords: scratch.slice(0, m), ends } };
	}
	return out;
}
