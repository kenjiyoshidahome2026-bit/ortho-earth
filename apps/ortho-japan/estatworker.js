// e-Stat 小地域 worker：fetch→gunzip→行単位JSON.parse→fan/線ジオメトリ生成、までを main から追い出す。
// 東京23区で数千ポリゴン＝main でやると数百ms ブロックしていた。identify（点in面）もここで実行＝
// feature 実体は worker に住み、main へは typed array（transfer）とヒット時の properties しか渡らない。
import { buildGeoJSONOverlay, pointInFeature } from "ortho-japan";

let features = null, origin = [138, 37];

async function gunzipText(bytes) {
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
	return new TextDecoder().decode(bytes);
}
const overlayBufs = s => [s.fanPos.buffer, s.P1.buffer, s.P2.buffer, s.lineCol.buffer, s.lineHalf.buffer];

self.onmessage = async (e) => {
	const m = e.data;
	if (m.type === "load") {
		const feats = [];
		await Promise.all(m.codes.map(async code => {
			try {
				const r = await fetch(`https://api.ortho-earth.com/bucket/estat/${code}.geojsonl`);
				if (!r.ok) return;
				const text = await gunzipText(new Uint8Array(await r.arrayBuffer()));
				for (const line of text.split("\n")) { const s = line.trim(); if (s) { try { feats.push(JSON.parse(s)); } catch { /* skip */ } } }
			} catch (err) { console.warn("estat", code, err); }
		}));
		if (!feats.length) { self.postMessage({ type: "loaded", ok: false }); return; }
		features = feats;
		let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90;
		const walk = c => { if (typeof c[0] === "number") { if (c[0] < lo0) lo0 = c[0]; if (c[0] > lo1) lo1 = c[0]; if (c[1] < la0) la0 = c[1]; if (c[1] > la1) la1 = c[1]; } else c.forEach(walk); };
		for (const f of feats) if (f.geometry?.coordinates) walk(f.geometry.coordinates);
		origin = [(lo0 + lo1) / 2, (la0 + la1) / 2];
		const s = buildGeoJSONOverlay(feats, origin);
		self.postMessage({ type: "loaded", ok: true, count: feats.length, center: origin, overlay: s }, overlayBufs(s));
	} else if (m.type === "identify") {
		const hit = features ? features.findIndex(f => pointInFeature(m.lon, m.lat, f.geometry)) : -1;
		if (hit < 0) { self.postMessage({ type: "identify", hit: -1 }); return; }
		const s = buildGeoJSONOverlay([features[hit]], origin);   // ヒット地物だけの強調ジオメトリ（小さい）
		self.postMessage({ type: "identify", hit, props: features[hit].properties || {}, overlay: s }, overlayBufs(s));
	}
};
