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

export class Map extends shim.Map {
	constructor(o = {}) {
		super({ ...o, ortho: { time: FIXED_TIME, ...o.ortho } });
		const i = X.maps.push(this) - 1;
		for (const k of ["load", "style.load", "idle"]) this.on(k, () => X.ev.push([i, k, Math.round(performance.now())]));
		this.on("error", e => X.errors.push([i, String(e?.error?.message || e?.error || e?.message || e)]));
		whenEngine(this).then(eng => { if (!eng) return; X.engines[i] = engineOf(this); eng.pinRes?.(true); });
	}
	addLayer(l, b) { if (l?.id) X.added.push(l.id); return super.addLayer(l, b); }   // 例が足した層（本物の包みと同じ）
}
