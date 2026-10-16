import { GeoPBF } from "../pbf-base.js";
import { encodeZIP } from "../modules/encodeZIP.ts";
import type { EncodeRequest } from "../worker-msg.ts";

import { escXML } from "../modules/xml.ts";

/** 幾何の形（coordinates の深さは type ごと・GeometryCollection は geometries） */
interface GmlGeometry { type: string; coordinates?: unknown; geometries?: GmlGeometry[] }
type XY = number[];

onmessage = async (e: MessageEvent<EncodeRequest>) => {
	const { buf, name, opts } = e.data, gz = opts && opts.gz;
	try {
		const pbf = await new GeoPBF().name(name).set(buf);
		const pos = (c: XY): string => `${c[1]} ${c[0]}`;
		const posList = (r: XY[]): string => r.map(pos).join(" ");
		// 幾何（2026-09-25・B9）：Multi 系と GeometryCollection も GML 3.2 の標準形で書く（旧＝Point/LineString/Polygon 以外は幾何なしの地物になった）
		const polyXML = (c: XY[][], id: string, ind: string): string => `${ind}<gml:Polygon gml:id="s${id}">\n` + c.map((ring, j) => {
			const tag = j === 0 ? "exterior" : "interior";
			return `${ind}  <gml:${tag}><gml:LinearRing><gml:posList>${posList(ring)}</gml:posList></gml:LinearRing></gml:${tag}>\n`;
		}).join("") + `${ind}</gml:Polygon>\n`;
		const geomXML = (g: GmlGeometry | null | undefined, id: string, ind: string): string => {
			if (!g) return "";
			const { type, coordinates: c } = g;
			if (type === "Point") return `${ind}<gml:Point gml:id="p${id}"><gml:pos>${pos(c as XY)}</gml:pos></gml:Point>\n`;
			if (type === "LineString") return `${ind}<gml:LineString gml:id="l${id}"><gml:posList>${posList(c as XY[])}</gml:posList></gml:LineString>\n`;
			if (type === "Polygon") return polyXML(c as XY[][], id, ind);
			if (type === "MultiPoint") return `${ind}<gml:MultiPoint gml:id="mp${id}">\n` + (c as XY[]).map((p, k) => `${ind}  <gml:pointMember><gml:Point gml:id="p${id}_${k}"><gml:pos>${pos(p)}</gml:pos></gml:Point></gml:pointMember>\n`).join("") + `${ind}</gml:MultiPoint>\n`;
			if (type === "MultiLineString") return `${ind}<gml:MultiCurve gml:id="mc${id}">\n` + (c as XY[][]).map((l, k) => `${ind}  <gml:curveMember><gml:LineString gml:id="l${id}_${k}"><gml:posList>${posList(l)}</gml:posList></gml:LineString></gml:curveMember>\n`).join("") + `${ind}</gml:MultiCurve>\n`;
			if (type === "MultiPolygon") return `${ind}<gml:MultiSurface gml:id="ms${id}">\n` + (c as XY[][][]).map((pg, k) => `${ind}  <gml:surfaceMember>\n${polyXML(pg, `${id}_${k}`, ind + "    ")}${ind}  </gml:surfaceMember>\n`).join("") + `${ind}</gml:MultiSurface>\n`;
			if (type === "GeometryCollection") return `${ind}<gml:MultiGeometry gml:id="mg${id}">\n` + g.geometries!.map((m, k) => `${ind}  <gml:geometryMember>\n${geomXML(m, `${id}_${k}`, ind + "    ")}${ind}  </gml:geometryMember>\n`).join("") + `${ind}</gml:MultiGeometry>\n`;
			return "";
		};
		// 属性：Date は ISO 8601・入れ子（object/配列）は JSON 文字列（旧＝落ちた）。バイナリは書かない
		const propText = (v: unknown): string | null => v == null || (typeof Blob !== "undefined" && v instanceof Blob) || ArrayBuffer.isView(v) ? null
			: v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
		// 要素名：XML の名前に使える文字（Unicode の文字・数字・_ . -）はそのまま＝日本語のキーを保つ（旧＝ASCII 以外を _ にして「名前」と「住所」が衝突した）。
		// 使えない文字は _ に・先頭が数字等なら _ を前置・それでも衝突したら _2, _3…（キーごとに一度だけ決める）
		const tags = new Map<string, string>(), used = new Set<string>();
		const tagOf = (k: string): string => {
			let t = tags.get(k); if (t) return t;
			t = k.replace(/[^\p{L}\p{N}_.\-]/gu, "_"); if (!/^[\p{L}_]/u.test(t)) t = "_" + t;
			for (let n = 2, b = t; used.has(t); n++) t = `${b}_${n}`;
			used.add(t); tags.set(k, t); return t;
		};
		// 逐次書き出し（gpx/geojson と同じ TransformStream 流儀）＝全文を 1 本の JS 文字列で抱えない
		const enc = new TextEncoder();
		const { readable, writable } = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>();
		const writer = writable.getWriter();
		const bPromise = new Response(readable).blob();
		(async () => {
			// Explicit srsName fixes axis-order detection in the decoder.
			await writer.write(enc.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" srsName="urn:ogc:def:crs:EPSG::4326">\n`));

			for (let i = 0, len = pbf.length; i < len; i++) {
				const f = pbf.getFeature(i);
				const fid = f.id ?? `f${i}`;

				let xml = `  <gml:featureMember>\n    <gml:GenericFeature gml:id="${escXML(fid)}">\n      <gml:geometryProperty>\n`;
				xml += geomXML(f.geometry as GmlGeometry | null, `${i}`, "        ");
				xml += `      </gml:geometryProperty>\n`;

				for (const [k, v] of Object.entries(f.properties as Record<string, unknown>)) {
					const text = propText(v);
					if (text !== null && k !== "id") xml += `      <${tagOf(k)}>${escXML(text)}</${tagOf(k)}>\n`;
				}
				xml += `    </gml:GenericFeature>\n  </gml:featureMember>\n`;
				await writer.write(enc.encode(xml));
			}
			await writer.write(enc.encode(`</gml:FeatureCollection>`));
			await writer.close();
		})().catch(err => writer.abort(err));

		const gmlFile = new File([await bPromise], `${name}.gml`, { type: "application/gml+xml" });

		if (gz) {
			const zip = await encodeZIP([gmlFile], `${name}_gml.zip`);
			postMessage(zip);
		} else {
			postMessage(gmlFile);
		}
	} catch (err) { postMessage(null); }
};
