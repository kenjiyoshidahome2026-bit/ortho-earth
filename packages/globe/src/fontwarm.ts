// 字の温め（?fontwarm=）：冷えた端末では最初に漢字を描く時に OS の書体（Noto Sans CJK ≈ 20MB）を読み込む＝
// 注記の字焼き（gpu/text.ts）の最初の 1 字が数秒止まる（Galaxy/Mali-G615 の実測 2026-11-05：同じコードで
// 直後の起動は lab 192 ms・数時間あけた起動は 4.9〜5.5 秒）。起動の最初に代表的な字を描いて書体を温める。
// 1＝main が別の worker（blob）で温める（render worker と並行・OS のページキャッシュを温める）
// 2＝render worker 自身が init で同期に温める（worker のプロセス内の書体キャッシュも温まる・その分 frame1 は遅れる）
// どちらも計器＝掛かった ms を boot 行に出す（冷えた端末の書体の読み込みがいくらかを直接測る）。

/** 温めに描く字：地名に多い漢字・かな・カナ（≈300 字） */
export const WARM_TEXT = "東京都新宿区渋谷港千代田中央文京台東墨田江戸川品川目黒大田世田谷杉並豊島北荒川板橋練馬足立葛飾横浜川崎千葉埼玉大宮浦和船橋市川松戸柏所沢川越熊谷高崎前橋宇都宮水戸成田木更津鎌倉藤沢小田原厚木相模原八王子立川府中調布三鷹武蔵野国分寺多摩町田日野青梅名古屋大阪京都神戸札幌仙台広島福岡那覇あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ山川田原森林池湖海島岬浜橋駅空港公園神社寺城学校病院市役所警察消防郵便局銀行会社工場倉庫住宅団地丁目番地通り街道線高速南西上下本新旧大小一二三四五六七八九十百千万";

/** 字の書体＝注記の焼き場と同じ（SDF_BASE px・書体の束は style のものだが、漢字の落ち先の OS 書体は同じ） */
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
