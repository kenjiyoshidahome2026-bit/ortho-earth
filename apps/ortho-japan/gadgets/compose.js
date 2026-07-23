// スナップショット合成（層重ね）＝shot・print・palette(見本の実写化) の共用最小部品。
// shot.js から独立させた理由：palette は「合成」だけ欲しい（保存UIは不要）。ここを核に置く事で
// 将来 shot 本体を初回import()へ隔離する時（bundle TODO）も合成だけは静的に残せる。

// 生ピクセル(RGBA ArrayBuffer)を source 寸法の一時canvasへ置き、出力 W×H へ伸ばして重ねる。flip=true は GL の上下反転を戻す。
function blit(ctx, buf, w, h, W, H, flip) {
	if (!buf || !w || !h) return;
	const tmp = new OffscreenCanvas(w, h);
	tmp.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
	ctx.save();
	if (flip) { ctx.translate(0, H); ctx.scale(1, -1); }   // GL は原点左下＝上下反転で来る
	ctx.drawImage(tmp, 0, 0, W, H);
	ctx.restore();
}

// スナップショット各層（基図GL＝知性gint込み・ラベル2D・計測2D）を1枚のcanvasへ＝shot と print（平面図）と palette で共用。
// （gint は 1canvas統合で基図GLの1枚に写り込む＝旧・別層合成は撤去）
export function composeLayersToCanvas({ W, H, render }, measureCanvas) {
	const out = new OffscreenCanvas(W, H);
	const ctx = out.getContext("2d");
	if (render?.base) blit(ctx, render.base, render.w, render.h, W, H, true);   // GL＝上下反転で戻す。動的解像度で縮む事があるので W×H へ伸ばす
	if (render?.labels) blit(ctx, render.labels, render.lw, render.lh, W, H, false);   // 2D＝そのまま
	if (measureCanvas && measureCanvas.width) ctx.drawImage(measureCanvas, 0, 0, W, H);   // 計測の線・距離・面積
	return out;
}
