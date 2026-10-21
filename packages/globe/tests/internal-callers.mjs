// 内製コードが MapLibre 形の口を呼んでいる所の許可表（MapLibre 互換の台帳 R8・2026-09-26）。
// MapLibre 形の口（addLayer・addSource・setPaintProperty…・ML 形 gadget）は、互換の段で意味（既定値・type とジオメトリ・式・zoom の dz）が
// MapLibre へ寄る。内製の呼び手がそれを知らずに増える／減ると、意図しない見た目の変化が門をすり抜ける＝数を固定して、変わったら人が見る。
// 変わった時：その呼び手が「MapLibre の意味で良い」のか「ネイティブの口（addGint・symCtl 等）へ移すべき」かを決めてから、下の表を直す。
// 使い方：node packages/globe/tests/internal-callers.mjs（--update で表を今の数に書き換えて表示＝貼り直す用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DIRS = ["packages/globe/src", "packages/ortho-core/src", "packages/geoedit/src", "packages/common/src", "packages/jp/src", "packages/world/src", "apps"];
const SKIP = /(^|\/)(node_modules|dist|lib|build|\.wrangler|tests|test|public|assets)(\/|$)|^apps\/docs\//;   // apps/docs＝文書の見本（実行されない）
const RE = [
	/\b(?:map|this|m|host)\.(?:addLayer|addSource|setPaintProperty|setLayoutProperty|setFilter|setLayerZoomRange|setStyle|queryRenderedFeatures)\(/g,
	/\.gadget\.(?:symbols|heatmap|cluster|extrude)\(/g,
];

// 2026-09-26 の数（段 0）。ファイル→呼び出しの数
const ALLOW = {
	"packages/world/src/worldlayers.ts": 4,   // 都市・空港の記号の層（gadget.symbols・エンジン z）＝段 1 で ML の意味を受けるか決める
	"apps/ortho-globe/physical.ts": 15,   // 世界の地形（2026-10-01）＝MapLibre の意味で良い（意図して互換の口だけで描く＝ドッグフード。線・記号・線に沿う名前・当たり判定の面・重ねの出し入れ・気候区分の塗りと色の切替。山脈の帯などの絵は anno）
	"apps/ortho-globe/hex.ts": 5,   // 世界の人口の六角形（issue #310・2026-10-14）＝setFilter 2（密度のつまみ＝DataFilterExtension 相当）・setLayoutProperty 1（柱の出し入れ）・setPaintProperty 2（自分の点の柱の高さと色）＝addH3／addCells の層に MapLibre の意味で（deck.gl 相当を互換の口で見せる頁）
	"apps/ortho-japan/terrain.ts": 11,   // 日本の地形（2026-10-06）＝/globe/physical の日本版＝同じく MapLibre の意味で良い（互換の口だけで描くドッグフード）
	"apps/ortho-japan/onsen.ts": 16,   // 日本の温泉（2026-10-12）＝terrain と同じく MapLibre の意味で良い（互換の口だけで描くドッグフード）
	"apps/ortho-japan/pointcloud.ts": 7,   // 静岡県の点群（2026-10-18）＝図郭の区画を addSource 2・addLayer 4・setLayoutProperty 1（visibility）＝onsen と同じく MapLibre の意味で良い
	"apps/choju/choju.ts": 7,   // 鳥獣の捕獲記録（2026-10-14）＝onsen と同じ骨格＝MapLibre の意味で良い（addSource 1・addLayer 1・setFilter 3・setPaintProperty 2＝互換の口だけで描くドッグフード）
	"apps/yokohama/twin.ts": 41,   // 横浜市デジタルツイン（2026-10-21）＝区の覆いと線・公共施設・鉄道と地下鉄・バス停・避難場所・地点と徒歩圏の線と輪・平面の区域（用途地域・校区・管轄）（addSource 11・addLayer 15・setLayoutProperty 11＝出し入れ・setFilter 3＝区の塗り・施設の区分・対応災害・queryRenderedFeatures 1＝区域の吹き出しで点を優先）＝onsen と同じく MapLibre の意味で良い（互換の口だけで描くドッグフード）
	"apps/www/index.html": 2,             // Get started の見本（start.md と同文＝MapLibre の書き方の見本そのもの）
	"packages/globe/src/api/query.ts": 1,   // 層イベントの問い合わせ（hitsFor）＝globe.js から切り出した（globe.js の分割 ②・2026-10-15）
	"packages/globe/src/globe.ts": 1,     // コメント 1（層イベントの hitsFor は api/query.ts へ）。段 1 で描き出し・worldcontent・"los" は内部の入口（*Native・addLayerAt）へ移した
	"packages/globe/src/api/tools.ts": 2,   // 検査表示の下地（#174）＝利用者の層を伏せる／戻す setLayoutProperty の visibility 2（利用者の口と同じ意味で伏せる＝戻すと同じ姿）。globe.js から切り出した（分割 ⑪）
	"packages/globe/src/api/data.ts": 4,   // map.addData の面・線・柱（deck.gl 差分 PR-4・2026-10-12）＝addSource・addLayer・setLayoutProperty（visibility）・queryRenderedFeatures（h.pick）
	                                      //   ＝利用者の層と同じ MapLibre の意味で良い（H3 と同じく既存の層経路に乗せる＝利用者が addLayer で描いたのと同じ姿・当たり）。globe.js から切り出した（分割 ⑤）
	"packages/globe/src/cells/layer.ts": 7,   // セル・等高線の層（deck.gl 差分 PR-5・2026-10-12）＝addSource 2・addLayer 4・setPaintProperty 1＝H3（packages/h3）と同じく意図して MapLibre の意味の層経路（利用者が addLayer で描いたのと同じ姿・当たり）
	"packages/globe/src/gadgets/inspect.ts": 2,   // 検査表示（#174・maplibre-gl-inspect 相当）＝検査の層は MapLibre の層の文書（addLayer）・札は queryRenderedFeatures＝MapLibre の意味そのもの
};

const found = {};
const walk = d => {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name), rel = path.relative(ROOT, p);
		if (SKIP.test(rel)) continue;
		if (e.isDirectory()) walk(p);
		else if (/\.(m?js|ts|html)$/.test(e.name)) {   // .ts＝TS 化した package（world 等）も数える
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
