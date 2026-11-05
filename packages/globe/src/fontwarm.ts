// 字の温め（?fontwarm=）：冷えた端末では最初に CJK の字を描く時に OS の書体（Noto Sans CJK ≈ 20MB）を読み込む＝
// 注記の字焼き（gpu/text.ts）の最初の 1 字が数秒止まる（Galaxy/Mali-G615 の実測 2026-11-05：同じコードで
// 直後の起動は lab 192 ms・数時間あけた起動は 4.9〜5.5 秒）。起動の最初に代表的な字を描いて書体を温める。
// 1＝main が別の worker（blob）で温める（render worker と並行・OS のページキャッシュを温める）
// 2＝render worker 自身が init で同期に温める（worker のプロセス内の書体キャッシュも温まる・その分 frame1 は遅れる）
// どちらも計器＝掛かった ms を boot 行に出す（冷えた端末の書体の読み込みがいくらかを直接測る）。

/** 温めに描く字＝CJK の書体を読ませるのが目的なので字の意味は問わない：かな・カナと CJK 統合漢字の先頭 256 字（符号位置から作る＝硬い層に地名の語を書かない） */
export const WARM_TEXT = (() => {
	let t = "";
	for (let c = 0x3041; c <= 0x3096; c++) t += String.fromCharCode(c);   // ひらがな
	for (let c = 0x30a1; c <= 0x30fa; c++) t += String.fromCharCode(c);   // カタカナ
	for (let c = 0x4e00; c < 0x4e00 + 256; c++) t += String.fromCharCode(c);   // CJK 統合漢字の先頭
	return t;
})();

/** 字の書体＝注記の焼き場と同じ大きさ（書体の束は style のものだが、CJK の字の落ち先の OS 書体は同じ） */
export const WARM_FONT = "32px sans-serif";   // 32＝ortho-core sdf.ts の SDF_BASE（焼き場の字の大きさ・口が無いので値を写す）

/** 同期に温める（worker でも main でも）：WARM_TEXT を 1 字ずつ measureText + fillText。返り＝掛かった ms */
export function warmFonts(font = WARM_FONT, text = WARM_TEXT): number {
	const t0 = performance.now();
	const cv = new OffscreenCanvas(64, 64), ctx = cv.getContext("2d", { willReadFrequently: true });
	if (!ctx) return 0;
	ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff";
	for (const ch of text) { ctx.measureText(ch); ctx.fillText(ch, 32, 32); }
	ctx.getImageData(0, 0, 4, 4);   // 描き切る（ラスタの遅延を flush）
	return performance.now() - t0;
}

/** 別の worker で温める（main から・?fontwarm=1）：済んだら ms を返す。worker を作れない環境は 0 */
export function warmFontsInWorker(font = WARM_FONT, text = WARM_TEXT): Promise<number> {
	return new Promise(res => {
		try {
			const src = `const t0=performance.now();const cv=new OffscreenCanvas(64,64),ctx=cv.getContext("2d",{willReadFrequently:true});ctx.font=${JSON.stringify(font)};ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#fff";for(const ch of ${JSON.stringify(text)}){ctx.measureText(ch);ctx.fillText(ch,32,32);}ctx.getImageData(0,0,4,4);postMessage(performance.now()-t0);close();`;
			const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" })), w = new Worker(url);
			w.onmessage = e => { URL.revokeObjectURL(url); res(Number(e.data) || 0); };
			w.onerror = () => { URL.revokeObjectURL(url); res(0); };
		} catch { res(0); }
	});
}
