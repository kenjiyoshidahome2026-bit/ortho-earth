import { GeoPBF } from "../pbf-base.js";
const enc = new TextEncoder();
import { escXML } from "../modules/xml.js";   // " も逃がす（旧＝逃がさず属性値の " で壊れた）

// GeoPBF → GPX。Point＝wpt、LineString/MultiLineString＝trk（route:true なら rte）。
//   点ごとの <ele> <time> は属性の配列から戻す（decoder/gpx.js の対称）＝LineString は平の配列、MultiLineString は trkseg ごとの入れ子。
//   旧＝<trkpt lat lon /> の空要素だけを書き、標高と時刻を出す欄が無かった（2026-09-17）。
//   time は Date でも ISO 文字列でも受ける（GPX は ISO 8601・UTC）。

const iso = t => t == null ? null : t instanceof Date ? t.toISOString() : String(t);
// 配列属性から「セグメント s の点 i」の値。LineString（平の配列）・MultiLineString（入れ子）のどちらでも引ける。
const at = (arr, s, i, nseg) => {
	if (!Array.isArray(arr)) return null;
	const seg = nseg === 1 && !Array.isArray(arr[0]) ? arr : arr[s];
	return Array.isArray(seg) ? seg[i] ?? null : null;
};

onmessage = async (e) => {
	const { buf, name, opts } = e.data, gz = opts && opts.gz;
	try {
		const pbf = await new GeoPBF().name(name).set(buf);
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
		const bPromise = new Response(out).blob();

		(async () => {
			await writer.write(enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="geopbf" xmlns="http://www.topografix.com/GPX/1/1">\n'));

			// 点 1 個＝<tag lat lon> + 子要素（無ければ自己閉じ）
			const point = (tag, lon, lat, ele, time, indent) => {
				const e = ele != null && Number.isFinite(+ele) ? `<ele>${+ele}</ele>` : "";
				const t = iso(time);
				const kids = e + (t ? `<time>${escXML(t)}</time>` : "");
				return kids ? `${indent}<${tag} lat="${lat}" lon="${lon}">${kids}</${tag}>\n` : `${indent}<${tag} lat="${lat}" lon="${lon}" />\n`;
			};

			for (let i = 0, len = pbf.length; i < len; i++) {
				const f = pbf.getFeature(i);
				const { type, coordinates: c } = f.geometry;
				const p = f.properties;

				if (type === "Point") {
					let wpt = `<wpt lat="${c[1]}" lon="${c[0]}">\n`;
					if (p.ele != null && Number.isFinite(+p.ele)) wpt += `  <ele>${+p.ele}</ele>\n`;
					if (p.time != null) wpt += `  <time>${escXML(iso(p.time))}</time>\n`;
					if (p.name != null) wpt += `  <name>${escXML(p.name)}</name>\n`;
					if (p.desc != null) wpt += `  <desc>${escXML(p.desc)}</desc>\n`;
					if (p.type != null) wpt += `  <type>${escXML(p.type)}</type>\n`;
					wpt += `</wpt>\n`;
					await writer.write(enc.encode(wpt));
				} else if (type === "LineString" || type === "MultiLineString") {
					const segs = type === "MultiLineString" ? c : [c];
					const meta = () => (p.name != null ? `  <name>${escXML(p.name)}</name>\n` : "")
						+ (p.desc != null ? `  <desc>${escXML(p.desc)}</desc>\n` : "")
						+ (p.type != null ? `  <type>${escXML(p.type)}</type>\n` : "");
					if (p.route) {
						// rte に trkseg 相当は無い＝MultiLineString はセグメントごとに 1 本の <rte>（同じ name）
						for (let s = 0; s < segs.length; s++) {
							let rte = `<rte>\n` + meta();
							segs[s].forEach(([lon, lat], j) => { rte += point("rtept", lon, lat, at(p.ele, s, j, segs.length), at(p.time, s, j, segs.length), "  "); });
							rte += `</rte>\n`;
							await writer.write(enc.encode(rte));
						}
					} else {
						await writer.write(enc.encode(`<trk>\n` + meta()));
						for (let s = 0; s < segs.length; s++) {
							// Each coordinate array of a MultiLineString maps to a separate trkseg.
							let segStr = `  <trkseg>\n`;
							segs[s].forEach(([lon, lat], j) => { segStr += point("trkpt", lon, lat, at(p.ele, s, j, segs.length), at(p.time, s, j, segs.length), "    "); });
							segStr += `  </trkseg>\n`;
							await writer.write(enc.encode(segStr));
						}
						await writer.write(enc.encode(`</trk>\n`));
					}
				}
			}

			await writer.write(enc.encode('</gpx>'));
			await writer.close();
		})();

		const b = await bPromise;
		postMessage(new File([b], `${name}.gpx${gz ? ".gz" : ""}`, { type: "application/gpx+xml" }));
	} catch (err) { postMessage(null); }
};
