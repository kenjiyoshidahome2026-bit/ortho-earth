// 共有シーン(sceneCollection)→ demo プレーヤーの scenes[] へ翻訳する純関数（demo/scene-format.md）。
// フォーマットは平ら：{ type, title, lang, defaults, scenes:[ {view, transition?, hold?, secs?, caption?, <lang>?, pre?, slide?, mobile?} ] }。
//   transition: glide→scene.glide／他(fly/fade/cut)→scene.view。hold は 秒→ms。
//   ★hold:0 が連続する glide キー＝1本のスプライン（隅田川ドリー）＝ scene.path に束ね、demo が glidePath で一続きに流す。
//   caption＝表示言語の解決＝ key[lang] ?? key.caption（言語は1つが基本・en:/jp: 兄弟フィールドがあり lang と一致すればそれ）。
//   ★「定義したそのまま」＝先頭 scene は jump（遠景の弧を作らず、その視点で開始）。末尾の finale（遠景）は呼び出し側で無効化（playScene が finale:null）。
export function sceneCollectionToScenes(obj, langOverride) {
	const keys = obj?.scenes ?? obj?.camera?.keys;   // 平ら scenes（新）／camera.keys（旧・後方互換）
	if (!Array.isArray(keys)) return { scenes: [] };
	const dflt = obj.defaults ?? obj.camera?.defaults ?? {};
	const lang = langOverride ?? obj.lang;
	const transOf = k => k.transition || dflt.transition || "glide";
	const holdOf = k => (k.hold ?? dflt.hold ?? 2);
	const capOf = k => { const c = (lang && k[lang] != null) ? k[lang] : k.caption; return (c != null && c !== "") ? c : null; };

	// 1点キー→ふつうのシーン。glide→scene.glide／他→scene.view。
	const oneScene = k => {
		const s = { hold: Math.max(0, holdOf(k) * 1000) };
		if (transOf(k) === "glide") s.glide = k.view; else s.view = k.view;
		if (k.pre) s.pre = k.pre;
		if (k.slide) s.slide = k.slide;
		if (k.mobile !== undefined) s.mobile = k.mobile;
		const cap = capOf(k); if (cap) { s.caption = cap; s.title = cap; }
		return s;
	};

	const scenes = [];
	let i = 0;
	while (i < keys.length) {
		if (transOf(keys[i]) === "glide") {
			// glide 連続を hold>0（停止）で区切る：先頭から、直前が hold:0 かつ次も glide の間だけ伸ばす（stop で閉じる）。
			const run = [keys[i]]; let j = i;
			while (holdOf(run[run.length - 1]) === 0 && j + 1 < keys.length && transOf(keys[j + 1]) === "glide") { j++; run.push(keys[j]); }
			if (run.length >= 2) {
				const last = run[run.length - 1];
				const s = { path: run.map(k => k.view), hold: Math.max(0, holdOf(last) * 1000), secs: run.reduce((a, k) => a + (k.secs ?? dflt.secs ?? 2.5), 0) };
				const cap = run.map(capOf).find(Boolean); if (cap) { s.caption = cap; s.title = cap; }   // 束の最初の字幕をドリー中の見出しに（複数字幕＝絶対トラックは P1b.2）
				if (run[0].mobile !== undefined) s.mobile = run[0].mobile;
				scenes.push(s);
			} else scenes.push(oneScene(run[0]));
			i = j + 1;
		} else { scenes.push(oneScene(keys[i])); i++; }
	}
	if (scenes[0] && (scenes[0].view || scenes[0].glide)) scenes[0].jump = true;   // 先頭は「定義したそのまま」＝その視点で即開始（遠景の弧を作らない）
	return { scenes, lang, mobile: dflt.mobile, waitPlateau: !!obj.waitPlateau };   // waitPlateau＝PLATEAU が立ち上がるまで開始を待つ（呼び出し側でゲート）
}
