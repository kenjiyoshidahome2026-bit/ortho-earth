// 世界の地震ビューア（quakes.html）の読み込み worker。
// GeoPBF（gzip 可）→ GPU に渡す列（Float32Array）へ展開して main へ transfer する。main をブロックしない。
//   pos   : 震源の 3D 座標（単位球ワールド＝ortho-core の lonlatTo3D と同式・深さぶん内側へ）
//   attr  : [mag, depth(km), 年（小数）] ×N
//   lon/lat/time : クリック時の情報表示用
// 並び順＝マグニチュード昇順（小さい地震を先に描き、大きい地震を上に重ねる＝アルファ合成の順序）。
import { GeoPBF } from "geopbf/pbf-base";

const D2R = Math.PI / 180;
const Y0 = Date.UTC(1967, 0, 1), YEAR_MS = 365.2425 * 86400000;

self.onmessage = async e => {
	const { url, buffer, rAx = 1, earthM = 6371000 } = e.data;
	try {
		let u8;
		if (buffer) u8 = new Uint8Array(buffer);
		else {
			self.postMessage({ type: "progress", text: "ダウンロード中…" });
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
			u8 = new Uint8Array(await res.arrayBuffer());
		}
		if (u8[0] === 0x1f && u8[1] === 0x8b) {   // gzip は署名で判定（拡張子を信用しない）
			self.postMessage({ type: "progress", text: "展開中…" });
			u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
		}
		self.postMessage({ type: "progress", text: "GeoPBF を読み込み中…" });
		const pbf = await new GeoPBF().set(u8);
		const N = pbf.length;
		const lon = new Float32Array(N), lat = new Float32Array(N), mag = new Float32Array(N), dep = new Float32Array(N);
		const time = new Float64Array(N);
		let n = 0;
		for (let i = 0; i < N; i++) {
			const g = pbf.getGeometry(i);
			if (!g || g.type !== "Point") continue;
			const p = pbf.getProperties(i) || {};
			const t = p.date instanceof Date ? p.date.getTime() : Date.parse(p.date);
			if (p.mag == null || !Number.isFinite(t)) continue;
			lon[n] = g.coordinates[0]; lat[n] = g.coordinates[1];
			mag[n] = p.mag; dep[n] = p.depth == null ? 0 : p.depth; time[n] = t;
			n++;
			if ((i & 0x3ffff) === 0) self.postMessage({ type: "progress", text: `GeoPBF を読み込み中… ${Math.round(i / N * 100)}%` });
		}
		// マグニチュード昇順
		const order = new Uint32Array(n);
		for (let i = 0; i < n; i++) order[i] = i;
		order.sort((a, b) => mag[a] - mag[b]);

		const pos = new Float32Array(n * 3), attr = new Float32Array(n * 3);
		const oLon = new Float32Array(n), oLat = new Float32Array(n), oTime = new Float64Array(n);
		for (let k = 0; k < n; k++) {
			const i = order[k];
			// lonlatTo3D（β単位球）＋深さ＝測地法線に沿って内側へ（球では動径を縮めるのと同じ）
			const a = lon[i] * D2R, b = lat[i] * D2R;
			let sb = Math.sin(b), cb = Math.cos(b);
			const nx = cb * Math.cos(a), ny = sb / rAx, nz = cb * Math.sin(a);   // ellNormal3D
			if (rAx !== 1) { const w = Math.hypot(cb, rAx * sb); sb = rAx * sb / w; cb = cb / w; }
			const h = -dep[i] * 1000 / earthM;
			pos[k * 3] = cb * Math.cos(a) + h * nx;
			pos[k * 3 + 1] = sb + h * ny;
			pos[k * 3 + 2] = cb * Math.sin(a) + h * nz;
			attr[k * 3] = mag[i];
			attr[k * 3 + 1] = dep[i];
			attr[k * 3 + 2] = 1967 + (time[i] - Y0) / YEAR_MS;
			oLon[k] = lon[i]; oLat[k] = lat[i]; oTime[k] = time[i];
		}
		const meta = { name: pbf.name?.(), description: pbf.description?.(), attribution: pbf.attribution?.(), license: pbf.license?.() };
		self.postMessage({ type: "done", n, pos, attr, lon: oLon, lat: oLat, time: oTime, meta },
			[pos.buffer, attr.buffer, oLon.buffer, oLat.buffer, oTime.buffer]);
	} catch (err) {
		self.postMessage({ type: "error", message: String(err?.message || err) });
	}
};
