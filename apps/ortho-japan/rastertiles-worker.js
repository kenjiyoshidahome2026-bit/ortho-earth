// ローカル容器（GeoPackage / MBTiles）の画像タイルを z/x/y で配るプロバイダ worker（2026-09-21）。
// 所有者は main（入れ子 worker 禁止の掟）。main が MessageChannel を作り、port1 をここへ・port2 を render worker の
// 画像タイル層（ortho-core/raster-src の "port" 契約）へ渡す＝タイルは main を経由せず worker→worker で流れる。
//
// 受け口（main → ここ）: { type:"open", file: File, table?: string, port: MessagePort }
// 返事（ここ → main）:   { type:"opened", info } | { type:"error", error, vectorLayers?: number }
// 契約（port）:          最初に { type:"info", info } を 1 通・要求 { id, z, x, y } → { id, bitmap|null }（bitmap は transfer）・{ id, abort } は無視（同期読みなので中断は無意味）
//
// 読み口＝geopbf（自前 SQLite リーダ・依存ゼロ）：openGpkgTiles（gpkg_tile_matrix が Web Mercator XYZ 同型の表だけ）／openMBTiles（TMS 反転済）。
// ベクタ（MVT）のタイルは対象外＝理由を言って断る（黙って空にしない）。
let src = null;

function isImage(mime) { return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || mime === "image/avif" || mime === "image/gif"; }

self.onmessage = async e => {
	const m = e.data || {};
	if (m.type !== "open") return;
	try {
		const u8 = new Uint8Array(await m.file.arrayBuffer());
		const name = String(m.file.name || "");
		let t, info;
		if (/\.mbtiles$/i.test(name)) {
			const { openMBTiles } = await import("geopbf/mbtiles");
			t = openMBTiles(u8);
			const fmt = String(t.format || t.metadata?.format || "").toLowerCase();
			if (fmt === "pbf" || fmt === "mvt") throw new Error("MBTiles holds vector tiles (MVT), not images");
			info = { tileSize: 256, minZoom: t.zooms[0] ?? 0, maxZoom: t.zooms[t.zooms.length - 1] ?? 18, bbox: t.bboxLonLat || null,
				name: t.name || t.metadata?.name || name, attribution: t.metadata?.attribution || null, count: t.count };
		} else {
			const { readGeoPackage, openGpkgTiles } = await import("geopbf/gpkg");
			const g = readGeoPackage(u8);
			if (!g.tiles || !g.tiles.length) { self.postMessage({ type: "error", error: "no tile table", vectorLayers: g.layers?.length || 0 }); return; }
			t = openGpkgTiles(u8, m.table);
			if (!t.xyz) throw new Error(`tile matrix of "${t.table}" is not Web Mercator XYZ (256px, 2^z × 2^z)`);
			info = { tileSize: 256, minZoom: t.zooms[0] ?? 0, maxZoom: t.zooms[t.zooms.length - 1] ?? 18, bbox: t.bboxLonLat || null,
				name: t.identifier || t.table || name, attribution: null, count: t.count, vectorLayers: g.layers?.length || 0 };
		}
		// 先頭の 1 枚で画像か検分（MVT/gzip なら断る）
		{
			let probe = null;
			for (const z of t.zooms) { const n = 1 << z; probeLoop: for (let y = 0; y < n && !probe; y++) for (let x = 0; x < n; x++) { if (t.has(z, x, y)) { probe = t.get(z, x, y); break probeLoop; } if (x > 64) break; } if (probe) break; }
			const mime = probe ? t.mimeOf(probe) : null;
			if (probe && !isImage(mime)) throw new Error(`tiles are ${mime || "unknown"} (not images)`);
			info.mime = mime;
		}
		src = t;
		const port = m.port;
		port.onmessage = async ev => {
			const q = ev.data || {};
			if (q.abort || q.id == null) return;
			try {
				const bytes = src.get(q.z, q.x, q.y);
				if (!bytes || !bytes.length) { port.postMessage({ id: q.id, bitmap: null }); return; }
				const bm = await createImageBitmap(new Blob([bytes], { type: src.mimeOf(bytes) || "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
				port.postMessage({ id: q.id, bitmap: bm }, [bm]);
			} catch (err) { port.postMessage({ id: q.id, error: String(err && err.message || err) }); }
		};
		port.postMessage({ type: "info", info });
		self.postMessage({ type: "opened", info });
	} catch (err) {
		self.postMessage({ type: "error", error: String(err && err.message || err) });
	}
};
