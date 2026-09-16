import { GeoPBF } from "../pbf-base.js";
import { unescXML } from "../modules/xml.js";

// GPX → GeoPBF。wpt / trk / rte の 3 種を読む。
//   幾何は 2D（GeoPBF の頂点に Z も時刻も無い）＝trkpt / rtept ごとの <ele> <time> は地物の属性に「点数と同じ長さの配列」で残す
//   （LineString＝平の配列、MultiLineString＝trkseg ごとの入れ子）。旧＝trkpt は lat/lon だけ拾い ele/time を全て捨てていた
//   ＝GPS ロガーの記録（ほぼ全てが trk）から時刻列が 100% 消え、再生も断面もできなかった（2026-09-17）。
//   rte は route:true を立てて LineString にする（encoder が <rte> に戻す）。
//   点の属性は lat/lon の並び順・改行・自己閉じ（<trkpt … />）を問わない（旧＝lat="…" lon="…" の順固定で取りこぼした）。
//   テキストは unescXML で戻す（旧＝encoder が escXML した "A&amp;B" が往復で二重に逃げていた）。

const TAG_RE = Object.create(null);   // タグ名ごとに 1 回だけコンパイル（g 無し＝lastIndex 状態を持たないので使い回せる）
const tagContent = (src, tag) => {
	const m = (TAG_RE[tag] ??= new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')).exec(src);
	return m ? unescXML(m[1].trim()) : null;
};
// 直下の <name> だけ＝trk の name を取るとき、中の trkpt/link に <name> があっても拾わない（trkseg より前で切る）
const headOf = (inner, childTag) => { const i = inner.search(new RegExp(`<${childTag}\\b`, 'i')); return i < 0 ? inner : inner.slice(0, i); };
const attr = (attrs, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs); return m ? +m[1] : NaN; };
const num = s => { if (s == null || s === "") return null; const v = +s; return Number.isFinite(v) ? v : null; };

// <tag lat lon …/> と <tag lat lon …>…</tag> の両方＝[attrs, inner]
const pointRegex = tag => new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'gi');

// 点列 → { coords, ele, time }。ele/time は 1 点でも値があれば点数と同じ長さの配列（無い点は null）、全点無ければ null。
function readPoints(src, tag) {
	const coords = [], ele = [], time = [];
	let hasEle = false, hasTime = false, m;
	const re = pointRegex(tag);
	while ((m = re.exec(src)) !== null) {
		const lat = attr(m[1], "lat"), lon = attr(m[1], "lon");
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		coords.push([lon, lat]);
		const inner = m[2] || "";
		const e = num(tagContent(inner, "ele")), t = inner ? tagContent(inner, "time") : null;
		if (e != null) hasEle = true;
		if (t != null) hasTime = true;
		ele.push(e); time.push(t);
	}
	return { coords, ele: hasEle ? ele : null, time: hasTime ? time : null };
}

onmessage = async (e) => {
	const { file, precision } = e.data;
	try {
		const text = await file.text();
		const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 6 });

		const keys = ["name", "desc", "ele", "time", "type", "route"].sort();
		pbf.setHead(keys);

		pbf.setBody(() => {
			// ---- wpt：Point。ele は数値、time は ISO 文字列（GPX の表記のまま＝往復対称）----
			const wptRe = pointRegex("wpt");
			let match;
			while ((match = wptRe.exec(text)) !== null) {
				const lat = attr(match[1], "lat"), lon = attr(match[1], "lon");
				if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
				const inner = match[2] || "";
				pbf.setFeature({
					type: "Feature",
					geometry: { type: "Point", coordinates: [lon, lat] },
					properties: {
						name: tagContent(inner, "name") || "Waypoint",
						desc: tagContent(inner, "desc"),
						ele: num(tagContent(inner, "ele")),
						time: tagContent(inner, "time"),
						type: tagContent(inner, "type"),
					}
				});
			}

			// ---- trk：trkseg 1 本＝LineString、複数＝MultiLineString（trkseg ごとに ele/time を入れ子）----
			const trkRe = /<trk\b[^>]*>([\s\S]*?)<\/trk>/gi;
			while ((match = trkRe.exec(text)) !== null) {
				const inner = match[1], head = headOf(inner, "trkseg");
				const segs = [];
				const segRe = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi;
				let segMatch;
				while ((segMatch = segRe.exec(inner)) !== null) {
					const s = readPoints(segMatch[1], "trkpt");
					if (s.coords.length > 0) segs.push(s);
				}
				if (segs.length === 0) continue;
				const some = k => segs.some(s => s[k]) ? segs.map(s => s[k] || s.coords.map(() => null)) : null;
				pbf.setFeature({
					type: "Feature",
					geometry: segs.length === 1
						? { type: "LineString", coordinates: segs[0].coords }
						: { type: "MultiLineString", coordinates: segs.map(s => s.coords) },
					properties: {
						name: tagContent(head, "name") || file.name,
						desc: tagContent(head, "desc"),
						type: tagContent(head, "type"),
						ele: segs.length === 1 ? segs[0].ele : some("ele"),
						time: segs.length === 1 ? segs[0].time : some("time"),
					}
				});
			}

			// ---- rte：rtept の列＝LineString + route:true ----
			const rteRe = /<rte\b[^>]*>([\s\S]*?)<\/rte>/gi;
			while ((match = rteRe.exec(text)) !== null) {
				const inner = match[1], head = headOf(inner, "rtept");
				const r = readPoints(inner, "rtept");
				if (r.coords.length === 0) continue;
				pbf.setFeature({
					type: "Feature",
					geometry: { type: "LineString", coordinates: r.coords },
					properties: {
						name: tagContent(head, "name") || file.name,
						desc: tagContent(head, "desc"),
						type: tagContent(head, "type"),
						ele: r.ele, time: r.time, route: true,
					}
				});
			}
		});

		pbf.close();
		const res = pbf.arrayBuffer;
		postMessage({ type: "gpxdec", data: res }, [res]);
	} catch (err) {
		console.error("GPX decode Worker Error:", err);
		postMessage(null);
	}
};
