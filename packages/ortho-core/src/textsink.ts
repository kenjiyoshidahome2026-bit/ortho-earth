// 注記の描画命令の受け口（TextSink）と字の寸法の口（GlyphMetrics）＝テキスト GPU 化の T-P0（`text gpu plan.md` §2・2026-10-22）。
// labels2d は「どの字をどこに置くか」（衝突判定・配置・フェード）だけを決め、塗りはここへ命令として渡す。
// Canvas2D 版（createCanvasSink）は切り出す前の labels2d と同じ呼び出しを同じ順で出す＝絵は変わらない（呼び出しの列を前後で突き合わせた）。
// WebGPU 版は T-P1（線に沿う字）から。字の寸法も口にした（measurer）＝今は measureText だけ・T-P4 で glyph PBF の字送りを差す
import { parseRGBA } from "./color.ts";
import type { Color, IconRect, LabelShield, LineGlyph, LineIcon, Mat2, StretchFitResult, TextLayout } from "./labels2d.ts";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// 色の文字列＝色の配列ごとに直前の (不透明度, 文字列) を覚える（静止中は毎フレーム同じ＝文字列を組み直さない。フェード中だけ組む）
const cssMemo = new WeakMap<object, { op: number; s: string }>();
export const css = (c: Color | string | null | undefined, op = 1): string => {
	if (typeof c !== "object" || c === null) c = parseRGBA(c);   // 配列でない色（文字列・欠け）は WeakMap の鍵にならない＝描画の途中で落とさない（入口で直すのが本筋・ここは保険）
	let m = cssMemo.get(c);
	if (m !== undefined && m.op === op) return m.s;
	const s = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * op})`;
	if (m !== undefined) { m.op = op; m.s = s; } else cssMemo.set(c, { op, s });
	return s;
};

/** 2D の文脈と書体の覚え（ctx.font の設定は変わる時だけ）＝字の寸法と Canvas2D 版の描き手が共有する（同じ文脈の ctx.font を互いに据え直す） */
export interface Canvas2D { readonly ctx: Ctx2D; readonly hasLS: boolean; setFont(f: string): void; forget(): void }
export function canvas2d(ctx: Ctx2D): Canvas2D {
	let cur = "";
	return { ctx, hasLS: "letterSpacing" in ctx, setFont(f) { if (f !== cur) { ctx.font = cur = f; } }, forget() { cur = ""; } };   // hasLS＝字間（Chrome 99+・無い環境は 0 扱い）
}

/** 字の寸法の口。measurer＝書体と字間（px）を据え、字の列の幅（px・字間込み）を測る関数を返す（次に measurer を呼ぶまで有効） */
export interface GlyphMetrics { measurer(font: string, lsPx: number): (text: string) => number }
export function canvasMetrics(c: Canvas2D): GlyphMetrics {
	const measure = (t: string) => c.ctx.measureText(t).width;
	return { measurer(font, ls) { c.setFont(font); if (c.hasLS) c.ctx.letterSpacing = ls ? `${ls}px` : "0px"; return measure; } };
}

/** 文字の塗り（Label2D の色・縁・ぼかし） */
export interface TextPaint { color?: Color | null; halo?: Color | null; haloW: number; blur?: number }
/** 直近のフレームで描いた数（?perf=1 の注記の行） */
export interface SinkStats { glyphs: number }
/** 注記の描画命令の受け口。座標は CSS px（dpr は受け口が掛ける）。o＝不透明度（フェード×距離×text-opacity） */
export interface TextSink {
	readonly kind: "2d" | "webgpu";
	/** 2D でしか描けない物（星空劇場の注記・月）の文脈。無い受け口は null＝描かない（T-P3 で移す） */
	readonly ctx2d: Ctx2D | null;
	begin(W: number, H: number, dpr: number): void;
	end(): void;
	clear(W: number, H: number): void;
	/** 書体が載った（addFontFace）＝焼いた字を捨てる */
	fontsChanged(): void;
	shield(sh: LabelShield, sx: number, sy: number, o: number): void;
	/** 線に沿う注記の記号（錨で線の向きに回す） */
	lineIcon(src: CanvasImageSource, ic: LineIcon, o: number): void;
	/** 線に沿う注記の字の列（字ごとの位置・向き・行列） */
	lineText(g: readonly LineGlyph[], font: string, p: TextPaint, o: number, dpr: number): void;
	/** 点の注記の記号（ib＝錨からの箱・i9 は伸びる記号）。Ti＝錨を原点にした向き・irot＝箱の中心で回す（Ti が無い時） */
	pointIcon(src: CanvasImageSource, ib: IconRect, sx: number, sy: number, Ti: Mat2 | null, irot: number | undefined, o: number): void;
	/** 点の注記の文字（行の束・縦書き・format の run）。(x0, y0)＝箱の左上（T があれば錨を原点にした T の空間・無ければ画面）・img＝format の記号の区間の絵 */
	pointText(tl: TextLayout, font: string, T: Mat2 | null, sx: number, sy: number, x0: number, y0: number, just: string, p: TextPaint, o: number, img: (name: string) => CanvasImageSource | null): void;
	stats(): SinkStats;
}

// 書体の文字列（"bold 12.5px …"）から最初の「数（小数可）px」の数の部分（旧＝font.match(/(\d+(?:\.\d+)?)px/)?.[1]）。
// 正規表現は先頭が囲われていない \d+ ＝数の長い並びで多項式の後戻り（CodeQL の指摘）＝添字の走査に（答えは同じ＝無作為の入力で旧の正規表現と突き合わせた）。
// 数の並びの途中から始めても終わりは同じ＝並びの頭だけ試せばよい。小数部（"." と数）があればそれを含めて px を探し、無ければ（か続かなければ）整数部の直後に px
const isDigitAt = (s: string, i: number): boolean => { const c = s.charCodeAt(i); return c >= 48 && c <= 57; };
export function pxNumOf(s: string): string | undefined {
	const n = s.length;
	for (let i = 0; i < n;) {
		if (!isDigitAt(s, i)) { i++; continue; }
		let j = i + 1;
		while (j < n && isDigitAt(s, j)) j++;
		if (s.charCodeAt(j) === 46 && isDigitAt(s, j + 1)) {
			let k = j + 2;
			while (k < n && isDigitAt(s, k)) k++;
			if (s.startsWith("px", k)) return s.slice(i, k);
		}
		if (s.startsWith("px", j)) return s.slice(i, j);
		i = j;
	}
	return undefined;
}
function drawStretched(g: Ctx2D, src: CanvasImageSource, f: StretchFitResult, ox = 0, oy = 0) { const x0 = f.box[0] + ox, y0 = f.box[1] + oy; for (const [ax, aw, dx, dw] of f.X.segs) for (const [ay, ah, dy, dh] of f.Y.segs) if (aw > 0 && ah > 0 && dw > 0 && dh > 0) g.drawImage(src, ax, ay, aw, ah, x0 + dx * f.s, y0 + dy * f.s, dw * f.s, dh * f.s); }

/** 字の版の頁・字の組・字 1 つ（glyph atlas） */
interface GlyphPage { cv: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D; bm: ImageBitmap | null; gen: number; bmGen: number; busy: boolean }
interface GlyphSet { font: string; fill: string; halo: string | null; haloW: number; blur: number; px: number; m: Map<string, GlyphSprite>; epoch: number }
interface GlyphSprite { pg: GlyphPage; gen: number; x: number; y: number; W: number; H: number; ox: number; oy: number; w: number; h: number }

/** Canvas2D 版の受け口（WebGL2 の時・`?text=2d`）。glyphAtlas＝線に沿う注記の字を版から貼る（既定 true・false＝字ごとに strokeText／fillText＝検定・切り分け） */
export function createCanvasSink(c: Canvas2D, { glyphAtlas = true }: { glyphAtlas?: boolean } = {}): TextSink {
	const ctx = c.ctx, setFont = c.setFont;
	let glyphs = 0;
	// ── 字の版（線に沿う注記・2026-10-13）＝（書体・色・縁）ごとに字を 1 回だけ焼き、字ごとの描画は drawImage（字の変換つき）。
	// 旧＝字ごとに変換を据えて strokeText＋fillText（縁のぼかしは shadowBlur）＝Canvas2D は変換の違う字を使い回せず毎フレーム字の形から塗り直す＝
	// 傾けた街（道の名 100 本余・字 600 個）で描画が 60→20fps に落ちていた（JS は 3ms＝重いのは塗り）。版から貼れば同じ画面で 60fps。
	// 版＝1024² の頁（字を足すたび棚に詰める）・倍率 ss（画面の 2 倍＝回しても縮めても字が痩せない）・頁が尽きたら全部捨てて焼き直す。
	// 貼る元は頁の写し（ImageBitmap）＝字を足している最中の canvas を元にすると貼るたびに写しを取り直す＝足し終えたフレームの後で写しを作り、次から使う
	const GA_PAGE = 1024, GA_MAX = 6, GA_ON = glyphAtlas && typeof OffscreenCanvas === "function";
	const ga = { pages: [] as GlyphPage[], sets: new Map<string, GlyphSet>(), pi: 0, x: 1, y: 1, rowH: 0, ss: 0, epoch: 0 };
	function gaReset(ss: number) { for (const pg of ga.pages) { pg.ctx.setTransform(1, 0, 0, 1, 0, 0); pg.ctx.clearRect(0, 0, GA_PAGE, GA_PAGE); pg.bm?.close?.(); pg.bm = null; pg.gen = 0; pg.bmGen = -1; } ga.sets.clear(); ga.pi = 0; ga.x = 1; ga.y = 1; ga.rowH = 0; ga.ss = ss; ga.epoch++; }
	// 字の組（書体・塗り・縁の色と幅・ぼかし）＝字 → 版の中の位置。注記 1 本につき 1 回引く
	function glyphSet(font: string, fill: string, halo: string | null, haloW: number, blur: number, dpr: number): GlyphSet {
		const ss = dpr >= 1.5 ? 3 : 2; if (ss !== ga.ss) gaReset(ss);   // 動的解像度で dpr が細かく動いても焼き直さない（境は 1.5 だけ）
		const key = font + "\u0001" + fill + "\u0001" + (halo || "") + "\u0001" + haloW + "\u0001" + blur;
		let set = ga.sets.get(key); if (!set) ga.sets.set(key, set = { font, fill, halo, haloW, blur, px: parseFloat(pxNumOf(font) ?? 12 as unknown as string), m: new Map(), epoch: ga.epoch });
		return set;
	}
	function glyphSprite(set: GlyphSet, ch: string): GlyphSprite {
		let sp = set.m.get(ch); if (sp) return sp;
		let pg = ga.pages[ga.pi] ??= ((cv: OffscreenCanvas): GlyphPage => ({ cv, ctx: cv.getContext("2d")!, bm: null, gen: 0, bmGen: -1, busy: false }))(new OffscreenCanvas(GA_PAGE, GA_PAGE)), g = pg.ctx;
		const pad = (set.halo ? set.haloW : 0) + set.blur + 1, hw0 = set.px * 0.3;
		g.setTransform(1, 0, 0, 1, 0, 0); g.font = set.font; g.textAlign = "center"; g.textBaseline = "middle";
		const mt = g.measureText(ch), hw = (mt.width || 0) / 2 || hw0;   // 字の箱＝実際の字の形（斜体のはみ出し・上下の飾り）＋縁。測れない環境は字送りと書体の大きさから
		const l = Math.max(mt.actualBoundingBoxLeft ?? hw, hw) + pad, r = Math.max(mt.actualBoundingBoxRight ?? hw, hw) + pad, up = (mt.actualBoundingBoxAscent ?? set.px * 0.85) + pad, dn = (mt.actualBoundingBoxDescent ?? set.px * 0.85) + pad;
		const k = Math.min(ga.ss, (GA_PAGE - 2) / (l + r), (GA_PAGE - 2) / (up + dn)), W = Math.ceil((l + r) * k), H = Math.ceil((up + dn) * k);   // 頁に収まらない大きな字は倍率を落とす
		if (ga.x + W + 1 > GA_PAGE) { ga.x = 1; ga.y += ga.rowH + 1; ga.rowH = 0; }
		if (ga.y + H + 1 > GA_PAGE) {
			if (ga.pi + 1 >= GA_MAX) { const ss = ga.ss; gaReset(ss); set.m = new Map(); set.epoch = ga.epoch; ga.sets.set(set.font + "\u0001" + set.fill + "\u0001" + (set.halo || "") + "\u0001" + set.haloW + "\u0001" + set.blur, set); }   // 尽きた＝全部捨てる（今引いている組は残して詰め直す）
			else { ga.pi++; ga.x = 1; ga.y = 1; ga.rowH = 0; }
			pg = ga.pages[ga.pi] ??= ((cv: OffscreenCanvas): GlyphPage => ({ cv, ctx: cv.getContext("2d")!, bm: null, gen: 0, bmGen: -1, busy: false }))(new OffscreenCanvas(GA_PAGE, GA_PAGE)); g = pg.ctx;
			g.font = set.font; g.textAlign = "center"; g.textBaseline = "middle";
		}
		g.setTransform(k, 0, 0, k, ga.x + l * k, ga.y + up * k); g.lineJoin = "round"; g.miterLimit = 2;
		if (set.blur > 0 && set.halo) { g.shadowColor = set.halo; g.shadowBlur = set.blur * k; } else g.shadowBlur = 0;   // 縁のぼかし（text-halo-blur）は焼き込む（shadowBlur は変換が掛からない＝倍率を掛ける）
		if (set.halo) { g.strokeStyle = set.halo; g.lineWidth = set.haloW * 2; g.strokeText(ch, 0, 0); }
		g.fillStyle = set.fill; g.fillText(ch, 0, 0); g.shadowBlur = 0;
		sp = { pg, gen: ++pg.gen, x: ga.x, y: ga.y, W, H, ox: -l, oy: -up, w: W / k, h: H / k };
		set.m.set(ch, sp); ga.x += W + 1; if (H > ga.rowH) ga.rowH = H;
		return sp;
	}
	// 字を足した頁の写しを作る（描き終えた後）。写しが出来るまでは canvas から貼る（遅いが正しい）
	function gaBake() {
		if (typeof createImageBitmap !== "function") return;
		for (const pg of ga.pages) if (pg.bmGen !== pg.gen && !pg.busy) { const g = pg.gen, e = ga.epoch; pg.busy = true; createImageBitmap(pg.cv).then(bm => { pg.busy = false; if (e !== ga.epoch) { bm.close?.(); return; } pg.bm?.close?.(); pg.bm = bm; pg.bmGen = g; }, () => { pg.busy = false; }); }   // 古い写しは閉じる（貼り終えたフレームの後＝描画には残らない）
	}

	function begin(W: number, H: number, dpr: number) {
		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.scale(dpr, dpr);
		ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;
		c.forget();   // 前のフレームの末尾（星空の注記・標識）が ctx.font を触っている＝覚えを捨てて据え直す
		glyphs = 0;
	}
	function end() { if (GA_ON) gaBake(); }
	function clear(W: number, H: number) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); }
	function fontsChanged() { c.forget(); if (ga.ss) gaReset(ga.ss); }
	function shield(sh: LabelShield, sx: number, sy: number, o: number) {
		ctx.globalAlpha = o;
		sh.draw(ctx, sx, sy);   // ベクター直描き（DPRスケール済みctx上＝常にシャープ）
		ctx.globalAlpha = 1;
		c.forget();   // 標識は ctx.font／textAlign を restore の外で触ることがある（空港＝名称）＝覚えを捨てる（旧＝次のラベルが標識の書体で描かれた）
	}
	function lineIcon(src: CanvasImageSource, ic: LineIcon, o: number) { ctx.save(); ctx.globalAlpha = o; ctx.translate(ic.x, ic.y); ctx.rotate(ic.a); ctx.drawImage(src, -ic.w / 2, -ic.h / 2, ic.w, ic.h); ctx.restore(); }
	function lineText(gl: readonly LineGlyph[], font: string, L: TextPaint, oL: number, dpr: number) {
		glyphs += gl.length;
		if (GA_ON) {   // 字の版から貼る（色は版に焼いた不透明の色・フェードは globalAlpha）
			const haloA = L.haloW! > 0 ? css(L.halo, 1) : null, fillA = css(L.color, 1), hW = haloA ? L.haloW! : 0, blur = haloA && L.blur! > 0 ? L.blur! : 0;
			const set0 = glyphSet(font, fillA, haloA, hW, blur, dpr);
			ctx.shadowBlur = 0; ctx.globalAlpha = oL;
			for (const g of gl) {
				if (!g.ch.trim()) continue;   // 空白は貼らない
				let set = g.f || g.col ? glyphSet(g.f || font, g.col ? css(g.col, 1) : fillA, haloA, hW, blur, dpr) : set0; if (set.epoch !== ga.epoch) set = glyphSet(set.font, set.fill, set.halo, set.haloW, set.blur, dpr);   // 版を捨てた後の組は引き直す
				const sp = glyphSprite(set, g.ch), src = sp.pg.bm && sp.gen <= sp.pg.bmGen ? sp.pg.bm : sp.pg.cv;
				if (g.t) ctx.setTransform(dpr * g.t.a, dpr * g.t.b, dpr * g.t.c, dpr * g.t.d, dpr * g.x, dpr * g.y); else { const cs = Math.cos(g.a) * dpr, sn = Math.sin(g.a) * dpr; ctx.setTransform(cs, sn, -sn, cs, dpr * g.x, dpr * g.y); }
				ctx.drawImage(src, sp.x, sp.y, sp.W, sp.H, sp.ox, sp.oy, sp.w, sp.h);
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1;
			return;
		}
		setFont(font); if (c.hasLS) ctx.letterSpacing = "0px";
		ctx.textAlign = "center"; ctx.textBaseline = "middle";
		if (L.blur! > 0) { ctx.shadowColor = css(L.halo, oL); ctx.shadowBlur = L.blur!; } else ctx.shadowBlur = 0;
		const halo = L.haloW > 0 ? css(L.halo, oL) : null, fill = css(L.color, oL);
		for (const g of gl) {   // 字ごとに錨へ移して回す＝終わりは基底の変換（dpr の拡大）へ据え直す（旧＝save/restore＝字ごとに描画状態を丸ごと積み下ろし）
			ctx.translate(g.x, g.y); if (g.t) ctx.transform(g.t.a, g.t.b, g.t.c, g.t.d, 0, 0); else ctx.rotate(g.a);
			if (g.f) setFont(g.f);   // 区間（format）の書体
			if (halo) { ctx.strokeStyle = halo!; ctx.lineWidth = L.haloW * 2; ctx.strokeText(g.ch, 0, 0); }
			ctx.fillStyle = g.col ? css(g.col, oL) : fill; ctx.fillText(g.ch, 0, 0);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
		ctx.shadowBlur = 0;
	}
	function pointIcon(src: CanvasImageSource, ib: IconRect, sx: number, sy: number, Ti: Mat2 | null, irot: number | undefined, oi: number) {
		if (!(oi > 0.01)) return;
		ctx.globalAlpha = oi;
		if (ib.i9) { if (Ti) { ctx.save(); ctx.translate(sx, sy); ctx.transform(Ti.a, Ti.b, Ti.c, Ti.d, 0, 0); drawStretched(ctx, src, ib.i9); ctx.restore(); } else drawStretched(ctx, src, ib.i9, sx, sy); }   // 伸びる記号＝区間ごと（9 分割）
		else if (Ti) { ctx.save(); ctx.translate(sx, sy); ctx.transform(Ti.a, Ti.b, Ti.c, Ti.d, 0, 0); ctx.drawImage(src, ib[0], ib[1], ib[2], ib[3]); ctx.restore(); }   // 錨を原点に transform（map の向き・傾き）
		else if (irot) { ctx.save(); ctx.translate(sx + ib[0] + ib[2] / 2, sy + ib[1] + ib[3] / 2); ctx.rotate(irot * Math.PI / 180); ctx.drawImage(src, -ib[2] / 2, -ib[3] / 2, ib[2], ib[3]); ctx.restore(); }
		else ctx.drawImage(src, sx + ib[0], sy + ib[1], ib[2], ib[3]);
		ctx.globalAlpha = 1;
	}
	function pointText(tl: TextLayout, font: string, T: Mat2 | null, sx: number, sy: number, x0: number, y0: number, just: string, L: TextPaint, o: number, img: (name: string) => CanvasImageSource | null) {
		setFont(font);   // textLayout が別の書体を据えた後でも、この行の描画は自分の書体で
		if (c.hasLS) ctx.letterSpacing = tl.ls ? `${tl.ls * tl.size}px` : "0px";
		if (T) { ctx.save(); ctx.translate(sx, sy); ctx.transform(T.a, T.b, T.c, T.d, 0, 0); }
		ctx.textAlign = just === "left" ? "left" : just === "right" ? "right" : "center"; ctx.textBaseline = "middle";
		const ax = just === "left" ? x0 : just === "right" ? x0 + tl.w : x0 + tl.w / 2;
		const halo = L.haloW > 0 || L.blur! > 0 ? css(L.halo, o) : null, fill = css(L.color, o);   // 色の文字列は行ごとでなくラベルごとに 1 回
		if (L.blur! > 0) { ctx.shadowColor = halo!; ctx.shadowBlur = L.blur!; } else ctx.shadowBlur = 0;
		if (tl.vcols) {   // 縦書き＝列は右から左・字は上から下（回す字は 90° 回して）
			ctx.textAlign = "center";
			let cx = x0 + tl.w;
			for (let i = 0; i < tl.vcols.length; i++) {
				cx -= tl.ws[i]; const x = cx + tl.ws[i] / 2; let y = y0;
				for (const g of tl.vcols[i]) {
					setFont(g.font); const gy = y + g.adv / 2, f = g.col ? css(g.col, o) : fill;
					if (g.rot) { ctx.translate(x, gy); ctx.rotate(Math.PI / 2); if (L.haloW > 0) { ctx.strokeStyle = halo!; ctx.lineWidth = L.haloW * 2; ctx.strokeText(g.ch, 0, 0); } ctx.fillStyle = f; ctx.fillText(g.ch, 0, 0); ctx.rotate(-Math.PI / 2); ctx.translate(-x, -gy); }
					else { if (L.haloW > 0) { ctx.strokeStyle = halo!; ctx.lineWidth = L.haloW * 2; ctx.strokeText(g.ch, x, gy); } ctx.fillStyle = f; ctx.fillText(g.ch, x, gy); }
					y += g.adv; glyphs++;
				}
			}
		} else if (tl.runs) {   // 区間つき（format）＝run ごとに書体・色を据えて左から詰める（寄せは行の幅で）
			ctx.textAlign = "left";
			let ly = y0;
			for (let i = 0; i < tl.runs.length; i++) {
				const lhI = tl.lhs![i]; let x = just === "left" ? x0 : just === "right" ? x0 + tl.w - tl.ws[i] : x0 + (tl.w - tl.ws[i]) / 2;
				for (const r of tl.runs[i]) {
					// vertical-align（C5）＝run の高さ（字＝size×font-scale・記号＝絵の高さ）を行の上／中央／下に揃える。無指定＝行の中央（従来）
					const rh = r.img ? r.h : tl.size * r.fs, cy = r.va === "top" ? ly + rh / 2 : r.va === "bottom" ? ly + lhI - rh / 2 : ly + lhI / 2;
					if (r.img) { const bm = img(r.img); if (bm && r.w > 0) { const ga = ctx.globalAlpha; ctx.globalAlpha = o; ctx.drawImage(bm, x, cy - r.h / 2, r.w, r.h); ctx.globalAlpha = ga; } x += r.w; continue; }   // 記号の区間（format の image）
					setFont(r.font); if (c.hasLS) ctx.letterSpacing = tl.ls ? `${tl.ls * tl.size * r.fs}px` : "0px";
					if (L.haloW > 0) { ctx.strokeStyle = halo!; ctx.lineWidth = L.haloW * 2; ctx.strokeText(r.t, x, cy); }
					ctx.fillStyle = r.col ? css(r.col, o) : fill; ctx.fillText(r.t, x, cy);
					x += r.w; glyphs += r.t.length;
				}
				ly += tl.lhs![i];
			}
		} else for (let i = 0; i < tl.lines.length; i++) {
			const ly = y0 + (i + 0.5) * tl.lh * tl.size;
			if (L.haloW > 0) { ctx.strokeStyle = halo!; ctx.lineWidth = L.haloW * 2; ctx.strokeText(tl.lines[i], ax, ly); }
			ctx.fillStyle = fill; ctx.fillText(tl.lines[i], ax, ly);
			glyphs += tl.lines[i].length;
		}
		ctx.shadowBlur = 0;
		if (T) ctx.restore();
	}
	return { kind: "2d", ctx2d: ctx, begin, end, clear, fontsChanged, shield, lineIcon, lineText, pointIcon, pointText, stats: () => ({ glyphs }) };
}
