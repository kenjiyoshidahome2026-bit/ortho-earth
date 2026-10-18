// 行カバレッジの「公称値」の範囲（2026-10-18 本人「描画・UI・アプリ本体を除いた公称値を作りませんか」）。
// 公称値＝node の単体テストで測れる「計算・データ処理」のコード（packages/*/src・sdk/*/src）だけの行カバレッジ。
// 下の類に入るファイルは公称値の分母から外す＝ブラウザ（GPU・DOM・地図オブジェクト）の上でしか動かず、実ブラウザの検定で確かめている物。
// 外す範囲はファイル名の型で決める（テストの有無では決めない＝外した中にテスト済みの行があっても公称値には数えない）。
// 迷うファイルは範囲に残す（公称値を甘くしない側へ倒す）。範囲を変えたら公称値も変わる＝変えた PR に前後の値を書くこと。
export const EXCLUDE = [
	{ name: "アプリ", why: "apps と、アプリの入口だけの package", globs: ["apps/**", "packages/regions/**"] },
	{ name: "型だけ", why: "実行される行が無い（型の宣言だけ）", globs: ["**/types.ts", "**/types/**", "**/*-types.ts"] },
	{ name: "GPU 描画", why: "WebGL2・WebGPU の上でしか動かない", globs: [
		"packages/ortho-core/src/gl/**", "packages/ortho-core/src/gpu/**", "packages/equal/src/renderer*.ts",
		"packages/globe/src/renderworker.ts", "**/*-gl.ts", "**/*-draw.ts"] },
	{ name: "地図本体", why: "ブラウザの地図オブジェクト（Map・その API）＝canvas と worker 群を立ち上げて初めて動く", globs: [
		"packages/globe/src/globe.ts", "packages/globe/src/api/**", "packages/globe/src/maplibre/map.ts", "packages/globe/src/page.ts", "packages/equal/src/equal.ts"] },
	{ name: "UI・DOM", why: "画面の部品（DOM・d3・ガジェット・編集画面）", globs: [
		"packages/common/src/dom/**", "packages/common/src/d3/**", "packages/common/src/screenLogger.ts",
		"packages/globe/src/gadgets/**", "packages/globe/src/maplibre/controls.ts",
		"packages/geoedit/src/{controller,overlay,styleform,drag,sketch,properties,toolbar,contextmenu,tip,pop-layer,gint-layer}.ts"],
		except: ["packages/globe/src/gadgets/*-core.ts"] },   // ガジェットの計算部分（*-core）は範囲に残す
];

// glob → 正規表現（**・*・{a,b} だけ）
const toRe = g => new RegExp("^" + g.replace(/[.+^$()|[\]\\]/g, "\\$&")
	.replace(/\{([^}]*)\}/g, (_, a) => `(?:${a.split(",").join("|")})`)
	.replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*") + "$");
const RES = EXCLUDE.map(c => ({ ...c, res: c.globs.map(toRe), keep: (c.except || []).map(toRe) }));
/** repo 相対パス → 外す類の名前（公称値の範囲なら null） */
export const excludedBy = rel => RES.find(c => c.res.some(r => r.test(rel)) && !c.keep.some(r => r.test(rel)))?.name ?? null;
