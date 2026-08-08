// 共有シーン台本（type:"scenes"・拡張子 .scenes）の純関数集（書式の正典＝demo/scene-format.md）。
// 行の書式は組み込み台本 demo/scenes.js と同一＝一つの書式（v2・2026-08-08 クリーンブレーク・未公開のうちに）。
//   旧 v1（type:"sceneCollection"）の transition/defaults・hold:0 連続の束ね規約・camera.keys 互換・秒⇄ms 変換はすべて撤去。
//   時間の単位は台本もオプションも全部「秒」（hold/slideHold/travel）＝ms 化は demo.js の内側だけ。

// via 行（通過点）を次の view/glide 行（着点）へ畳む＝scene.path:[{view,travel}…]（末尾＝着点自身）。
// demo.js が台本受領時に必ず通す＝組み込み台本(demo/scenes.js)でも .scenes(JSON) でも同じ書式で連続ドリーが書ける。
// travel＝「その点に到達するまで」の区間尺[秒]（先頭 via は直前シーンの着点→via・着点行の travel＝最終区間）。
//   省略した区間はエンジンの自動尺（経路長比例）。カメラのみ＝道中の l=/c= は触らない（直前シーンで設定しておく）。
// via の無い台本は同じ配列をそのまま返す（恒等）＝▶再押下の識別比較（先読みは1回だけの掟）を壊さない。
export function compileVias(rows) {
	if (!Array.isArray(rows) || !rows.some(r => r?.via != null)) return rows;
	const out = []; let vias = [];
	for (const r of rows) {
		if (r.via != null && !r.view && !r.glide) { vias.push(r); continue; }
		const tgt = r.view ?? r.glide;
		if (vias.length && !tgt) console.warn(`[scene] 着点(view/glide)の無い via ×${vias.length}＝捨てる`);
		out.push(vias.length && tgt ? { ...r, path: [...vias.map(v => ({ view: v.via, travel: v.travel })), { view: tgt, travel: r.travel }] } : r);
		vias = [];
	}
	if (vias.length) console.warn(`[scene] 末尾の via ×${vias.length} は着点が無い＝捨てる`);
	return out;
}

// 台本(JSON) → demo プレーヤーへの受け渡し {scenes, lang, mobile, hold, slideHold, preload, waitLoading}。
// 行は翻訳しない（書式が demo と同一）。やるのは (1)中身の無い行の除去 (2)出発点の無い先頭 via の除去（台本は視点行から）
// (3)先頭が視点行なら jump 印＝「定義したそのまま」その視点で即開始（遠景の弧を作らない）。via の畳み込みは compileVias（demo.js が通す）。
// waitLoading＝重いデータ（3D都市）が立ち上がるまで開始を待つ／preload＝明示先読みリスト（カタログ名・無指定＝視点から自動導出）。
//   キーは汎用名＝書式に固有名詞を入れない掟（Plateau 等は説明にだけ現れる）。
export function parseScenes(obj, langOverride) {
	let rows = (Array.isArray(obj?.scenes) ? obj.scenes : []).filter(r => r && (r.view || r.glide || r.via != null || r.slide));
	const firstView = rows.findIndex(r => r.view || r.glide);
	if (rows.slice(0, Math.max(firstView, 0)).some(r => r.via != null)) {
		console.warn("[scene] 先頭の via は出発点が無い＝捨てる（台本は view/glide 行から）");
		rows = rows.filter((r, i) => i >= firstView || r.via == null);
	}
	if (rows[0] && (rows[0].view || rows[0].glide)) rows[0] = { ...rows[0], jump: true };
	return {
		scenes: rows, lang: langOverride ?? obj?.lang, mobile: obj?.mobile,
		hold: obj?.hold, slideHold: obj?.slideHold, preload: obj?.preload,
		waitLoading: !!obj?.waitLoading,
	};
}
