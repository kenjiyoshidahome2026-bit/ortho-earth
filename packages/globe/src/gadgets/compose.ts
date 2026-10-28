// スナップショット合成（層重ね）＝shot・print・palette(見本の実写化) の共用最小部品。
// shot.js から独立させた理由：palette は「合成」だけ欲しい（保存UIは不要）。ここを核に置く事で
// 将来 shot 本体を初回import()へ隔離する時（bundle TODO）も合成だけは静的に残せる。

/** 重ねる 1 枚（RGBA の生画素・flip＝上下が逆＝GL） */
export interface ComposeLayer { buf: ArrayBuffer; w: number; h: number; flip?: boolean }
/** 生スナップの render（requestSnapshot の答え・base＝基図・labels＝注記 2D・overlays／overlaysAbove＝同一フレームのオーバーレイ） */
export interface ComposeRender {
	base?: ArrayBuffer | null; w?: number; h?: number; flip?: boolean;
	labels?: ArrayBuffer | null; lw?: number; lh?: number;
	overlays?: ComposeLayer[]; overlaysAbove?: ComposeLayer[];
}
/** 生スナップ（W×H＝出力の寸法） */
export interface ComposeSnapshot { W: number; H: number; render?: ComposeRender | null }

// 生ピクセル(RGBA ArrayBuffer)を source 寸法の一時canvasへ置き、出力 W×H へ伸ばして重ねる。flip=true は GL の上下反転を戻す。
function blit(ctx: OffscreenCanvasRenderingContext2D, buf: ArrayBuffer | null | undefined, w: number | undefined, h: number | undefined, W: number, H: number, flip: boolean | undefined) {
	if (!buf || !w || !h) return;
	const tmp = new OffscreenCanvas(w, h);
	tmp.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
	ctx.save();
	if (flip) { ctx.translate(0, H); ctx.scale(1, -1); }   // GL は原点左下＝上下反転で来る
	ctx.drawImage(tmp, 0, 0, W, H);
	ctx.restore();
}

// スナップショット各層（基図GL＝知性gint込み・同一フレームのオーバーレイ・ラベル2D・計測2D）を1枚のcanvasへ＝shot と print（平面図）と palette で共用。
// （gint は 1canvas統合で基図GLの1枚に写り込む＝旧・別層合成は撤去）
// 太陽系圏（z<1）は main の Canvas2D（#solar-sky・solarsky.ts）＝worker のスナップに入らない＝見えている時だけ基図の直上へ重ねる（撮影・🎞 書き出しに太陽系が写らなかった・2026-10-28）
export function solarSkyOf(mapEl: HTMLElement): HTMLCanvasElement | null {
	const cv = mapEl.querySelector<HTMLCanvasElement>("#solar-sky");
	return cv && cv.width && cv.style.display !== "none" ? cv : null;
}
export function composeLayersToCanvas({ W, H, render }: ComposeSnapshot, measureCanvas?: HTMLCanvasElement | OffscreenCanvas | null, skyCanvas?: HTMLCanvasElement | null): OffscreenCanvas {
	const out = new OffscreenCanvas(W, H);
	const ctx = out.getContext("2d")!;
	if (render?.base) blit(ctx, render.base, render.w, render.h, W, H, render.flip !== false);   // GL＝上下反転で戻す(flip:true)／WebGPU＝top-down(flip:false)。動的解像度で縮む事があるので W×H へ伸ばす
	if (skyCanvas) ctx.drawImage(skyCanvas, 0, 0, W, H);   // 太陽系圏（画面と同じ重ね順＝エンジン球の直上・注記の下）
	for (const o of render?.overlays || []) blit(ctx, o.buf, o.w, o.h, W, H, o.flip);   // 同一フレームのオーバーレイ（地震・衛星・点群等）＝注記の下・画面の重ね順（GL 系は flip:true）
	if (render?.labels) blit(ctx, render.labels, render.lw, render.lh, W, H, false);   // 2D＝そのまま
	for (const o of render?.overlaysAbove || []) blit(ctx, o.buf, o.w, o.h, W, H, o.flip);   // above＝注記より上（覆う画像）
	if (measureCanvas && measureCanvas.width) ctx.drawImage(measureCanvas, 0, 0, W, H);   // 計測の線・距離・面積
	return out;
}
