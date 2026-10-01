// 内製コードが MapLibre 形の口を呼んでいる所の許可表（MapLibre 互換の台帳 R8・2026-09-26）。
// MapLibre 形の口（addLayer・addSource・setPaintProperty…・ML 形 gadget）は、互換の段で意味（既定値・type とジオメトリ・式・zoom の dz）が
// MapLibre へ寄る。内製の呼び手がそれを知らずに増える／減ると、意図しない見た目の変化が門をすり抜ける＝数を固定して、変わったら人が見る。
// 変わった時：その呼び手が「MapLibre の意味で良い」のか「ネイティブの口（addGint・symCtl 等）へ移すべき」かを決めてから、下の表を直す。
// 使い方：node packages/globe/tests/internal-callers.mjs（--update で表を今の数に書き換えて表示＝貼り直す用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DIRS = ["packages/globe/src", "packages/ortho-core/src", "packages/geoedit/src", "packages/common/src", "packages/jp/src", "apps"];
const SKIP = /(^|\/)(node_modules|dist|lib|build|\.wrangler|tests|test|public|assets)(\/|$)|^apps\/docs\//;   // apps/docs＝文書の見本（実行されない）
const RE = [
	/\b(?:map|this|m|host)\.(?:addLayer|addSource|setPaintProperty|setLayoutProperty|setFilter|setLayerZoomRange|setStyle|queryRenderedFeatures)\(/g,
	/\.gadget\.(?:symbols|heatmap|cluster|extrude)\(/g,
];

// 2026-09-26 の数（段 0）。ファイル→呼び出しの数
const ALLOW = {
	"apps/world/src/worldlayers.js": 4,   // 都市・空港の記号の層（gadget.symbols・エンジン z）＝段 1 で ML の意味を受けるか決める
	"apps/ortho-globe/physical.js": 15,   // 世界の地形（2026-10-01）＝MapLibre の意味で良い（意図して互換の口だけで描く＝ドッグフード。線・記号・線に沿う名前・当たり判定の面・重ねの出し入れ・気候区分の塗りと色の切替。山脈の帯などの絵は anno）
	"apps/www/index.html": 2,             // Get started の見本（start.md と同文＝MapLibre の書き方の見本そのもの）
	"packages/globe/src/globe.js": 4,     // 層イベントの問い合わせ（hitsFor）＋コメント 1。段 1 で描き出し・worldcontent・"los" は内部の入口（*Native・addLayerAt）へ移した
	                                      // ＋検査表示の下地（#174）＝利用者の層を伏せる／戻す setLayoutProperty の visibility 2（利用者の口と同じ意味で伏せる＝戻すと同じ姿）
	"packages/globe/src/gadgets/inspect.js": 2,   // 検査表示（#174・maplibre-gl-inspect 相当）＝検査の層は MapLibre の層の文書（addLayer）・札は queryRenderedFeatures＝MapLibre の意味そのもの
};

const found = {};
const walk = d => {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name), rel = path.relative(ROOT, p);
		if (SKIP.test(rel)) continue;
		if (e.isDirectory()) walk(p);
		else if (/\.(m?js|html)$/.test(e.name)) {
			const s = fs.readFileSync(p, "utf8");
			let n = 0; for (const re of RE) n += (s.match(re) || []).length;
			if (n) found[rel] = n;
		}
	}
};
for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

if (process.argv.includes("--update")) { console.log(JSON.stringify(found, null, "\t")); process.exit(0); }
let bad = 0;
for (const [f, n] of Object.entries(found)) if (ALLOW[f] !== n) { bad++; console.log(`✗ ${f}: ${n} call(s) to MapLibre-shaped entry points (allowed ${ALLOW[f] ?? 0})`); }
for (const [f, n] of Object.entries(ALLOW)) if (!(f in found)) { bad++; console.log(`✗ ${f}: allowed ${n} but none found (lower the table)`); }
console.log(bad ? `internal-callers: ${bad} drift(s) — decide MapLibre semantics vs native entry, then update the table` : `✓ internal-callers PASS（${Object.keys(found).length} files）`);
process.exit(bad ? 1 : 0);
