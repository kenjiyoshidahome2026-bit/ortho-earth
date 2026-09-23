// 共有シーン台本（type:"scenes"・拡張子 .scenes）の純関数集（書式の正典＝demo/scene-format.md）。
// 行の書式は組み込み台本 demo/scenes.js と同一＝一つの書式（v2・2026-08-08 クリーンブレーク・未公開のうちに）。
//   旧 v1（type:"sceneCollection"）の transition/defaults・hold:0 連続の束ね規約・camera.keys 互換・秒⇄ms 変換はすべて撤去。
//   時間の単位は台本もオプションも全部「秒」（hold/slideHold/travel）＝ms 化は demo.js の内側だけ。
// 言語：台本側に言語指定は無い（旧 top-level lang は撤去 2026-08-08）＝既定で見せたい言語を title にそのまま書く。
//   他言語は行の言語兄弟（en:/jp:…）で足し、選ぶのは視聴者の ?lang=（demo の scene[lang] ?? title）。
// issues＝任意の診断コレクタ（エディタ用・scene-format.md §7）：渡すと {row, code, msg} を push し console.warn しない
//   ＝行内エラー表示は呼び出し側の仕事。code＝"empty-row" | "leading-via" | "orphan-via"。row＝0起点の行番号。

// via 行（通過点）を次の view/glide 行（着点）へ畳む＝scene.path:[{view,travel}…]（末尾＝着点自身）。
// demo.js が台本受領時に必ず通す＝組み込み台本(demo/scenes.js)でも .scenes(JSON) でも同じ書式で連続ドリーが書ける。
// travel＝「その点に到達するまで」の区間尺[秒]（先頭 via は直前シーンの着点→via・着点行の travel＝最終区間）。
//   省略した区間はエンジンの自動尺（経路長比例）。カメラのみ＝道中の l=/c= は触らない（直前シーンで設定しておく）。
// via の無い台本は同じ配列をそのまま返す（恒等）＝▶再押下の識別比較（先読みは1回だけの掟）を壊さない。
// trace（任意）＝{ group: 入力行 i → 畳み込み後の index（捨てられた via は -1） }＝エディタの行ハイライト/試写開始行の写像。
// 規則の正本はここ一箇所（エディタ側で同じ裁きを別に書かない）。
export function compileVias(rows, issues, trace) {
	if (!Array.isArray(rows)) return rows;
	if (trace) trace.group = rows.map((_, i) => i);
	if (!rows.some(r => r?.via != null)) return rows;   // via 無し＝恒等（同じ配列＝▶再押下の識別比較を壊さない）
	const say = (row, code, msg) => issues ? issues.push({ row, code, msg }) : console.warn(`[scene] ${msg}`);
	const out = []; let vias = [];
	const group = trace ? trace.group.fill(-1) : null;
	rows.forEach((r, i) => {
		if (r.via != null && !r.view && !r.glide && !r.fade) { vias.push({ r, i }); return; }
		const tgt = r.view ?? r.glide ?? r.fade;
		if (vias.length && !tgt) vias.forEach(v => say(v.i, "orphan-via", `row ${v.i + 1}: via has no destination (view/glide); dropped`));
		if (group) { group[i] = out.length; if (tgt) for (const v of vias) group[v.i] = out.length; }
		out.push(vias.length && tgt ? { ...r, path: [...vias.map(v => ({ view: v.r.via, travel: v.r.travel })), { view: tgt, travel: r.travel }] } : r);
		vias = [];
	});
	if (vias.length) vias.forEach(v => say(v.i, "orphan-via", `row ${v.i + 1}: trailing via has no destination; dropped`));
	return out;
}

// 台本(JSON) → demo プレーヤーへの受け渡し {scenes, mobile, hold, slideHold, preload, waitLoading}。
// 行は翻訳しない（書式が demo と同一）。やるのは (1)中身の無い行の除去 (2)出発点の無い先頭 via の除去（台本は視点行から）
// (3)先頭が視点行なら jump 印＝「定義したそのまま」その視点で即開始（遠景の弧を作らない）。via の畳み込みは compileVias（demo.js が通す）。
// waitLoading＝重いデータ（3D都市）が立ち上がるまで開始を待つ／preload＝明示先読みリスト（カタログ名・無指定＝視点から自動導出）。
//   キーは汎用名＝書式に固有名詞を入れない掟（Plateau 等は説明にだけ現れる）。
// trace（任意）＝{ rowIdx: 返す scenes[k] → 元の obj.scenes の行番号 }（捨てた行は現れない）＝compileVias の trace と組で元行の写像を作る。
export function parseScenes(obj, issues, trace) {
	const say = (row, code, msg) => issues ? issues.push({ row, code, msg }) : console.warn(`[scene] ${msg}`);
	const all = Array.isArray(obj?.scenes) ? obj.scenes : [];
	let rows = all.filter((r, i) => (r && (r.view || r.glide || r.fade || r.via != null || r.slide)) || (say(i, "empty-row", `row ${i + 1}: no view/glide/fade/via/slide; dropped`), false));
	const firstView = rows.findIndex(r => r.view || r.glide || r.fade);
	const leading = rows.slice(0, Math.max(firstView, 0)).find(r => r.via != null);
	if (leading) {
		say(all.indexOf(leading), "leading-via", "leading via has no starting point; dropped (script must start with a view row)");
		rows = rows.filter((r, i) => i >= firstView || r.via == null);
	}
	if (trace) trace.rowIdx = rows.map(r => all.indexOf(r));   // jump 印を付ける前＝同一参照で引ける
	if (rows[0] && (rows[0].view || rows[0].glide || rows[0].fade)) rows[0] = { ...rows[0], jump: true };
	return {
		scenes: rows, mobile: obj?.mobile,
		hold: obj?.hold, slideHold: obj?.slideHold, preload: obj?.preload,
		waitLoading: !!obj?.waitLoading,
	};
}
