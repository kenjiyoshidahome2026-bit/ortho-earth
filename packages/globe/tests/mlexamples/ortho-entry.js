// 公式例の門（台帳 §8）の検定だけの包み＝/ortho/dist/maplibre-gl-dev.mjs の中身（vite.config.mjs が書き換える）。
// 通訳（src/maplibre/＝製品の口）をそのまま再公開し、Map だけ継いで：
//   ・作った地図と事象（load/style.load/idle/error）を window.__mlx に積む（本物の包み REF_WRAPPER と同じ形＝走らせ台は両側を同じ手で読む）
//   ・時計を止める（夜面は切ってあるが、太陽の向きで変わる物を残さない）・動的解像度を止める（負荷で絵が縮まない）
//   ・エンジンの地図（標本の projectLL・問い合わせ）を __mlx.engines に（製品の口からは出さない engineOf で）
export * from "../../src/maplibre/index.js";
import * as shim from "../../src/maplibre/index.js";
import { engineOf, whenEngine } from "../../src/maplibre/map.js";

const X = (window.__mlx ||= { side: "ortho", maps: [], ev: [], errors: [], engines: [], added: [] });
const FIXED_TIME = "2026-03-20T12:00:00Z";

// 実験（?mllat=1・走らせ台の --mllat）＝起動の視点のズームに中心緯度の log2(sec φ) を足す＝MapLibre のメルカトル等価の縮尺に合わせたら何本上がるかを数えるだけ。
// 製品の口（src/maplibre/）には入れない（z の目盛りの緯度の差は台帳 §4＝本人裁定の領分）。flyTo 等の途中の視点は直さない＝起動の絵だけの見積り
const ML_LAT = new URLSearchParams(location.search).get("mllat") === "1";
const latZoom = o => {
	if (!ML_LAT || o.zoom == null || o.center == null) return o;
	const lat = Array.isArray(o.center) ? o.center[1] : o.center.lat;
	return { ...o, zoom: o.zoom + Math.log2(1 / Math.max(0.05, Math.cos(lat * Math.PI / 180))) };
};
export class Map extends shim.Map {
	constructor(o = {}) {
		super({ ...latZoom(o), ortho: { time: FIXED_TIME, ...o.ortho } });
		const i = X.maps.push(this) - 1;
		for (const k of ["load", "style.load", "idle"]) this.on(k, () => X.ev.push([i, k, Math.round(performance.now())]));
		this.on("error", e => X.errors.push([i, String(e?.error?.message || e?.error || e?.message || e)]));
		whenEngine(this).then(eng => { if (!eng) return; X.engines[i] = engineOf(this); eng.pinRes?.(true); });
	}
	addLayer(l, b) { if (l?.id) X.added.push(l.id); return super.addLayer(l, b); }   // 例が足した層（本物の包みと同じ）
}
