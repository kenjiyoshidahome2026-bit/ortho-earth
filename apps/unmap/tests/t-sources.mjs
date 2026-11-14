// 源の置き場（?osm=・?gel= の門）と PMTiles ヘッダの読み（probe）の検定
import { safeUrl, sourcesFrom, gelTerrain, archiveUrl, kindOfTileType, DEFAULT_OSM, DEFAULT_GEL } from "../sources.ts";
import { parseHeader, probe } from "../probe.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };

{
	const s = sourcesFrom("https://x.example/unmap/");
	ok("既定＝Source Cooperative の OSM planet と GEL", s.osm === DEFAULT_OSM && s.gel === DEFAULT_GEL);
	const t = sourcesFrom("https://x.example/unmap/?osm=https://un.example/a.pmtiles&gel=/data/gel.pmtiles");
	ok("?osm= ?gel= で差し替え（相対は頁基準）", t.osm === "https://un.example/a.pmtiles" && t.gel === "https://x.example/data/gel.pmtiles");
	ok("http の他オリジンは門で落とす", safeUrl("http://evil.example/a.pmtiles", "https://x.example/") === null);
	ok("localhost の http は可", safeUrl("http://localhost:8080/a.pmtiles", "https://x.example/") === "http://localhost:8080/a.pmtiles");
	ok("javascript: は落とす", safeUrl("javascript:alert(1)", "https://x.example/") === null);
	const g = gelTerrain("https://a/gel.pmtiles").source;
	ok("GEL の地形＝pmtiles:// のアーカイブ 1 つ・mapbox・z2–12", g.tiles.length === 1 && g.tiles[0] === "pmtiles://https://a/gel.pmtiles" && g.encoding === "mapbox" && g.minzoom === 2 && g.maxzoom === 12);
}

{
	ok("既定はオンラインを読む・?online=0 で読まない", sourcesFrom("https://x.example/").online === true && sourcesFrom("https://x.example/?online=0").online === false);
	const comp = urls => "C[" + urls.join("|") + "]";
	ok("端末の物なし＝オンラインの 1 本（複合にしない）", archiveUrl([], "https://a/p.pmtiles", comp) === "pmtiles://https://a/p.pmtiles");
	ok("端末の物が先・オンラインが最後（複合）", archiveUrl(["unmap/map/a.pmtiles", "unmap/map/b.pmtiles"], "https://a/p.pmtiles", comp) === "C[pmtiles://opfs:unmap/map/a.pmtiles|pmtiles://opfs:unmap/map/b.pmtiles|pmtiles://https://a/p.pmtiles]");
	ok("端末の 1 本だけ（?online=0）＝その 1 本", archiveUrl(["unmap/map/a.pmtiles"], null, comp) === "pmtiles://opfs:unmap/map/a.pmtiles");
	ok("何も無い＝null", archiveUrl([], null, comp) === null);
	ok("tileType：mvt/mlt＝地図・png/jpeg/webp/avif＝地形・他＝null", kindOfTileType(1) === "map" && kindOfTileType(6) === "map" && kindOfTileType(4) === "terrain" && kindOfTileType(2) === "terrain" && kindOfTileType(0) === null && kindOfTileType(7) === null);
	ok("地形：pmtiles:// 付きの URL はそのまま", gelTerrain("pmtiles://composite:x").source.tiles[0] === "pmtiles://composite:x");
}

// PMTiles v3 のヘッダ（127 バイト）を組んで読む
const header = ({ tileType = 1, minZoom = 0, maxZoom = 15, bounds = [-180, -85, 180, 85] } = {}) => {
	const b = new ArrayBuffer(127), v = new DataView(b), u = new Uint8Array(b);
	u.set([..."PMTiles"].map(c => c.charCodeAt(0)), 0); v.setUint8(7, 3);
	v.setUint8(99, tileType); v.setUint8(100, minZoom); v.setUint8(101, maxZoom);
	bounds.forEach((d, i) => v.setInt32(102 + i * 4, Math.round(d * 1e7), true));
	return b;
};
{
	const h = parseHeader(header({ tileType: 4, minZoom: 2, maxZoom: 12 }));
	ok("ヘッダ：webp・z2–12・bounds", h && h.tileType === "webp" && h.minZoom === 2 && h.maxZoom === 12 && Math.abs(h.bounds[0] + 180) < 1e-6 && Math.abs(h.bounds[3] - 85) < 1e-6);
	ok("ヘッダ：短い・魔法の語が違う・v2 は null", parseHeader(new ArrayBuffer(10)) === null && parseHeader(new ArrayBuffer(127)) === null && (() => { const b = header(); new DataView(b).setUint8(7, 2); return parseHeader(b) === null; })());
}
{
	const resp = (status, body) => async (_u, init) => { ok(`probe は Range: bytes=0-126 を送る（${status}）`, init.headers.Range === "bytes=0-126"); return new Response(body, { status }); };
	const a = await probe("https://a/x.pmtiles", resp(206, header({ tileType: 1, maxZoom: 15 })));
	ok("probe：206＋PMTiles＝OK", a.ok && a.range && a.tileType === "mvt" && a.maxZoom === 15);
	const b = await probe("https://a/x.pmtiles", resp(200, header()));
	ok("probe：200＝Range を無視＝NG", !b.ok && /Range ignored/.test(b.reason));
	const c = await probe("https://a/x.pmtiles", resp(403, "no"));
	ok("probe：403＝NG", !c.ok && c.reason === "HTTP 403");
	const d = await probe("https://a/x.pmtiles", async () => { throw new TypeError("Failed to fetch"); });
	ok("probe：fetch が投げる（CORS・回線）＝NG", !d.ok && /CORS/.test(d.reason));
	const e = await probe("https://a/x.pmtiles", resp(206, new ArrayBuffer(127)));
	ok("probe：206 でも PMTiles でない＝NG", !e.ok && /not a PMTiles/.test(e.reason));
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-sources 全 PASS");
process.exit(fail ? 1 : 0);
