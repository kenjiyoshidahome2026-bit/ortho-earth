// ラベルを Canvas2D オーバーレイで描く（GL幾何の上に重ねる最前面レイヤ）。
// 衝突判定（どのラベルを出すか）は間引き（recollideMs毎）で安定化し、描画位置は毎フレーム・ライブ投影。
// これで文字は地図と一緒に滑らかに動きつつ、当選集合が安定して明滅しない。距離フェードでフォグと連動。
// 向き（段 5）＝text-rotate・rotation-alignment map・pitch-alignment map＝錨での地面の基底から transform を組む（orient）。線の字は上向きを地面の直角へ。
// 線に沿う注記（symbol-placement line・段 4）も同じ経路＝折れ線を毎フレーム投影して字を線に沿わせる（lineLayout）・字ごとの箱で衝突。
// 記号（icon-image・段 3）も同じ経路＝記号帳（setImage）を名前で引き、文字の箱と一緒に裁く（icon-text-fit・text/icon-optional・icon-allow-overlap/ignore-placement・icon-padding）。
import { cameraState, projectInto, unproject, distTo, worldRadiusM } from "./camera.js";
import { clipDistanceM } from "./clip.js";   // 断面（#111 段 3）＝切られた側に錨がある注記は出さない
import { fontCss } from "./fontstack.js";
import { charRotated, verticalize } from "./vertical.js";   // 縦書き（text-writing-mode・2026-10-03）
import { labelKey } from "./labelkey.js";
import { clockNow } from "@ortho-earth/ephem/clock";   // 共通の時計（#42）＝星空の注記も星（renderer）と同じ時刻で回す
import { gmstAt } from "@ortho-earth/ephem/sun";       // 恒星時の正本（renderer の星と同じ式）

const FONT_STACK = `"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif`;
const ANCH = { center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5], "top-left": [0, 0], "top-right": [1, 0], "bottom-left": [0, 1], "bottom-right": [1, 1] };   // text-anchor＝箱のどの点を錨に置くか（MapLibre）
// 色の文字列＝色の配列ごとに直前の (不透明度, 文字列) を覚える（静止中は毎フレーム同じ＝文字列を組み直さない。フェード中だけ組む）
const cssMemo = new WeakMap();
const css = (c, op = 1) => {
	let m = cssMemo.get(c);
	if (m !== undefined && m.op === op) return m.s;
	const s = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * op})`;
	if (m !== undefined) { m.op = op; m.s = s; } else cssMemo.set(c, { op, s });
	return s;
};
const PJ = new Float64Array(3), PE = new Float64Array(3), PS = new Float64Array(3);   // projectInto の作業域（錨・東・南の投影＝衝突判定・毎フレームの描画）
let prBuf = new Float64Array(3 * 64);   // lineLayout の頂点投影の作業域（[x, y, front] × 頂点）
const NO_CHARS = Object.freeze([]);   // 文字の無いラベル（記号だけ）の字の並び
const ICOL0 = [0, 0, 0, 1];   // icon-color の既定（黒）
// k＝利用者層 id（層またぎのキー衝突防止）・icon＝記号だけのラベル（text ""）の区別・MapLibre 由来の層（mlp）は層の添字 li も＝同じ点・同じ文字の別の層を 1 つに畳まない（tilemanager.labels の重複排除と同じ区別・poi_transit／poi_r1 2026-09-28）。
// 鍵はラベルごとに一度だけ作って覚える（__k）＝衝突判定（150ms 毎）と rebuild のたびに toFixed を回さない。ラベルは届くたびに新しい物（structured clone）＝覚えは古くならない
const keyOf = L => L.__k ??= (L.k ? L.k + "|" : "") + labelKey(L);   // 鍵の式は labelkey.js（tile worker が焼いた L.key があれば文字列を組まない）
const GALAXY = new Set(["s", "e", "i", "gx", "gg"]);   // メシエの種別のうち銀河（星空の注記の記号＝楕円）
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
// 伸びる記号（MapLibre の stretchX／stretchY／content）＝icon-text-fit の時、文字の箱 t＝[x0,y0,x1,y1] に余白 p＝[上,右,下,左] を足した箱へ content が重なるよう、伸びる区間だけを同じ倍率で伸ばす（伸びない区間は元の大きさ）。
// 戻り＝{ box:[x0,y0,x1,y1], X, Y, s }（X/Y の segs＝[元の始点, 元の幅, 先の始点, 先の幅]（元 px）・s＝元 px→CSS px）。drawStretched が区間の組ごとに drawImage（9 分割の一般形）。symbols-2d と ortho-core/labels2d に同じ式（overlay は依存ゼロ）
export function stretchFit(im, size, fit, t, p) {
	const s = size / im.pr, W = im.bm.width, H = im.bm.height, c = im.ct || [0, 0, W, H];
	const axis = (zones, len, c0, c1, want) => {
		const Z = (zones || []).filter(z => Array.isArray(z) && z[1] > z[0]);
		const Sc = Z.reduce((a, [z0, z1]) => a + Math.max(0, Math.min(z1, c1) - Math.max(z0, c0)), 0), Fc = (c1 - c0) - Sc;
		const k = want != null && Sc > 0 ? Math.max(0, (want / s - Fc) / Sc) : 1;
		const cuts = [...new Set([0, len, ...Z.flat()])].filter(v => v >= 0 && v <= len).sort((a, b) => a - b), segs = [];
		let d = 0;
		for (let i = 0; i + 1 < cuts.length; i++) { const a = cuts[i], b = cuts[i + 1], st = Z.some(([z0, z1]) => a >= z0 && b <= z1), dw = (b - a) * (st ? k : 1); segs.push([a, b - a, d, dw]); d += dw; }
		const map = x => { for (const [a, w, dd, dw] of segs) if (x <= a + w) return dd + (x - a) * (w ? dw / w : 0); return d; };
		return { segs, total: d, map };
	};
	const X = axis(im.sx, W, c[0], c[2], fit === "height" ? null : t[2] - t[0] + p[1] + p[3]);
	const Y = axis(im.sy, H, c[1], c[3], fit === "width" ? null : t[3] - t[1] + p[0] + p[2]);
	const x0 = fit === "height" ? (t[0] + t[2]) / 2 - X.total * s / 2 : t[0] - p[3] - X.map(c[0]) * s;
	const y0 = fit === "width" ? (t[1] + t[3]) / 2 - Y.total * s / 2 : t[1] - p[0] - Y.map(c[1]) * s;
	return { box: [x0, y0, x0 + X.total * s, y0 + Y.total * s], X, Y, s };
}
function drawStretched(g, src, f, ox = 0, oy = 0) { const x0 = f.box[0] + ox, y0 = f.box[1] + oy; for (const [ax, aw, dx, dw] of f.X.segs) for (const [ay, ah, dy, dh] of f.Y.segs) if (aw > 0 && ah > 0 && dw > 0 && dh > 0) g.drawImage(src, ax, ay, aw, ah, x0 + dx * f.s, y0 + dy * f.s, dw * f.s, dh * f.s); }
export const isStretch = im => !!(im && (im.sx?.length || im.sy?.length || im.ct));
// 置いた箱の格子（衝突判定の索引）＝画面を CELL px の升に切り、箱は重なる升すべてに入れる。hit は升の中の箱だけを厳密な不等号で当てる
// （旧＝置いた箱の全件を線形に当てる＝O(候補×当選)。結果は同じ＝升の添字は単調に丸めるので、重なる 2 箱は必ず同じ升を共有する）。
// 升の添字は [-LIM, LIM] に丸める＝画面のはるか外の箱（線の注記の字・変換後の箱）で升の数が膨れない。NaN の箱はどこにも入らず何にも当たらない（旧と同じ）
const CELL = 64, LIM = 256, BIG = 256;
export function boxGrid() {
	const cells = new Map(), big = [];   // big＝升を BIG 個より多く跨ぐ箱（まれ）＝升に配らず線形に当てる
	const ci = v => Math.max(-LIM, Math.min(LIM, Math.floor(v / CELL)));
	const key = (x, y) => (x + LIM) * (2 * LIM + 1) + (y + LIM);
	const hit1 = (box, b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1];
	return {
		push(b) {
			const x0 = ci(b[0]), x1 = ci(b[2]), y0 = ci(b[1]), y1 = ci(b[3]);
			if ((x1 - x0 + 1) * (y1 - y0 + 1) > BIG) { big.push(b); return; }
			for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = key(x, y), c = cells.get(k); if (c) c.push(b); else cells.set(k, [b]); }
		},
		hit(box) {
			for (const b of big) if (hit1(box, b)) return true;
			const x0 = ci(box[0]), x1 = ci(box[2]), y0 = ci(box[1]), y1 = ci(box[3]);
			if ((x1 - x0 + 1) * (y1 - y0 + 1) > BIG) { for (const c of cells.values()) for (const b of c) if (hit1(box, b)) return true; return false; }   // 大きな問い＝升を歩かず全件
			for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
				const c = cells.get(key(x, y)); if (!c) continue;
				for (const b of c) if (hit1(box, b)) return true;
			}
			return false;
		},
	};
}


// shieldFor(L) → { img:CanvasImageSource, w, h }（CSS px）を返すとテキストの代わりにその絵を描く。
// 国道おにぎり等の標識をアプリ側で供給する差し込み口（エンジンは汎用のまま）。
// elevBase = 誇張/地球半径m（地物の u_elevScale の pitch非依存部分）。各ラベルを L.elev(m) 分だけ
// 地形に乗せて投影＝傾き時に地物とラベルの位置が一致する（標高視差のズレを解消）。
// glyphAtlas＝線に沿う注記の字を版（字を 1 回だけ焼いた画像）から貼る（既定）。false＝字ごとに strokeText／fillText（検定・切り分け）
// lineFlatPx＝[消える, 全部出る]（CSS px）＝地面に寝た線の注記の字が、傾きで潰れた向きにこの高さ（書体の大きさ×潰れ）を下回ると薄くなり、消える（読めない字はノイズ）。null＝潰れても出す（MapLibre と同じ）
export function createLabelLayer(canvas, { pad = 5, fadeMs = 300, recollideMs = 150, shieldFor = null, elevBase = 0, glyphAtlas = true, lineFlatPx = [4.5, 5.5] } = {}) {
	// pitch ゲート（renderer の elevScaleEff=elev.scale×pf と同式）。真俯瞰0→11.5°で全開。
	// 旧 cityFlat 項（z13.5→16でラベル標高を畳む）は撤去＝地形側の cityFlat 撤去（renderer 2026-07-26・
	// DEM10B=DTM化）に追随。残すと都市ズームのチルトで地形は起伏のまま・ラベルだけ楕円体へ沈み位置がズレる。
	const pitchScale = (pitch, zoom) => {
		const t = Math.max(0, Math.min(1, ((pitch || 0) - 0.06) / 0.14));
		return elevBase * t * t * (3 - 2 * t);
	};
	// 標高の持ち上げは地形の遠景平坦化(df・TERRAIN_VSと同式)にも追随＝平坦化された遠くの山の上で
	// ラベルだけがフル標高で浮かない。fogF=フォグ終端（renderer の fogFarCap と同式・camDist近似）。
	// elevOf＝錨の高さ（m）＝地表の標高（L.elev）＋symbol-height-offset（L.hoff・C5）。symbol-height-anchor absolute（L.habs）は海面から＝地表を読まない
	const elevOf = L => (L.habs ? 0 : (L.elev || 0)) + (L.hoff || 0);
	const radiusOf = (L, eScale, st, fogF) => {
		const e = elevOf(L);
		if (!e || !eScale) return 1;
		const d = distTo(L.anchor[0], L.anchor[1], st.eye);
		const t = Math.max(0, Math.min(1, (d - fogF * 0.8) / (fogF * 1.2)));
		return 1 + e * eScale * (1 - t * t * (3 - 2 * t));
	};
	const ctx = canvas.getContext("2d");
	const hasLS = "letterSpacing" in ctx;   // 字間（Chrome 99+・無い環境は 0 扱い）
	let curFont = "";   // ctx.font の覚え（collide/draw/textLayout で共有＝設定は変わる時だけ）
	const setFont = f => { if (f !== curFont) { ctx.font = curFont = f; } };
	const fontOf = (L, size) => fontCss(L.fnt, size, FONT_STACK);   // ラベルの書体（text-font → family/weight/style・無ければ既定の束）
	// format の区間（L.sec＝[{ t, fs?, col?, fnt? }]・2026-10-03）＝区間ごとの書体（font-scale・text-font）と色。無ければ 1 つ（ラベルの書体）
	const secStyles = (L, size) => L.sec ? L.sec.map(q => ({ fs: q.fs || 1, font: fontCss(q.fnt || L.fnt, size * (q.fs || 1), FONT_STACK), col: q.col || null, img: q.img || null, va: q.va || null })) : [{ fs: 1, font: fontOf(L, size), col: null, img: null, va: null }];   // img＝記号の区間・va＝vertical-align（C5）
	// 字の列＝[字…] と、区間を持つ時は字ごとの区間の添字（__cs）。文字そのものは不変＝ラベルごとに覚える
	const charsOf = L => { if (L.__ch) return L.__ch; if (L.sec) { const ch = [], cs = []; L.sec.forEach((q, si) => { if (q.img) return; for (const c of q.t) { ch.push(c); cs.push(si); } }); L.__cs = cs; return (L.__ch = ch); } return (L.__ch = [...String(L.text)]); };   // 記号の区間は字の列に入れない（線の注記＝横書きの run だけが差し込む）
	// 記号帳（段 3・2026-09-28）＝名前 → { bm: ImageBitmap, pr: pixelRatio, sdf }。main の記号帳（addImage / sprite）の写し＝届いた時に衝突判定をやり直す（名前だけ持って待っていたラベルが出る）
	// SDF の記号は icon-color で塗る（縁 0.7〜0.8＝symbols-2d と同式・名前×色で一度だけ焼いて覚える）
	const images = new Map(), tinted = new Map();
	function setImage(name, { bitmap, pixelRatio = 1, sdf = false, stretchX = null, stretchY = null, content = null }) {
		const prev = images.get(name), pr = pixelRatio || 1;
		images.set(name, { bm: bitmap, pr, sdf: !!sdf, sx: stretchX, sy: stretchY, ct: content });   // sx/sy/ct＝伸びる記号（stretchFit）
		dropTinted(name);   // 差し替えた SDF の記号＝古い絵で焼いた写しを捨てる（旧＝この行がコメントの後ろに入っていて効いていなかった）
		if (!prev || prev.bm.width !== bitmap.width || prev.bm.height !== bitmap.height || prev.pr !== pr) { dirty = true; if (imgSecNames.has(name)) { fontGen++; widthCache.clear(); } }   // 箱が変わる時だけ衝突判定をやり直す（動く記号＝毎フレームの差し替えで全件の再衝突をしない）。文字に差し込む記号（format の image）の寸が変わった＝行の組み直し
		if (prev?.bm !== bitmap) prev?.bm?.close?.();
	}
	function dropTinted(name) { for (const k of [...tinted.keys()]) if (k.startsWith(name + "|")) tinted.delete(k); }
	function removeImage(name) { images.get(name)?.bm?.close?.(); images.delete(name); dropTinted(name); dirty = true; if (imgSecNames.has(name)) { fontGen++; widthCache.clear(); } }
	const imgSecNames = new Set();   // format の image で参照される記号の名前（寸が変わったら行を組み直す）
	// SDF の記号を塗る（icon-color）。halo＝{ col: css, w: 元の px, b: 元の px }（icon-halo-*・C5）＝縁（0.75）から w だけ外へ halo の色（MapLibre の SDF は 1px＝1/8）・blur は外側を b/8 だけ滑らかに
	function sdfTint(name, im, color, halo = null) {
		const key = name + "|" + color + (halo ? "|" + halo.col + "/" + halo.w.toFixed(2) + "/" + halo.b.toFixed(2) : "");
		let c = tinted.get(key);
		if (c) return c;
		const w = im.bm.width, h = im.bm.height, cv = new OffscreenCanvas(w, h), g = cv.getContext("2d");
		g.drawImage(im.bm, 0, 0);
		const px = g.getImageData(0, 0, w, h), a = px.data;
		g.fillStyle = color; g.fillRect(0, 0, 1, 1); const [r, gg, b, al] = g.getImageData(0, 0, 1, 1).data;
		let hr = 0, hg = 0, hb = 0, ha = 0, th = 0, soft = 0.1;
		if (halo) { g.fillStyle = halo.col; g.fillRect(0, 0, 1, 1); [hr, hg, hb, ha] = g.getImageData(0, 0, 1, 1).data; th = 0.75 - halo.w / 8; soft = 0.1 + halo.b / 8; }
		const sm = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
		for (let i = 0; i < a.length; i += 4) {
			const d = a[i + 3] / 255, ia = sm((d - 0.7) / 0.1) * al / 255;
			if (!halo) { a[i] = r; a[i + 1] = gg; a[i + 2] = b; a[i + 3] = Math.round(ia * 255); continue; }
			const hA = sm((d - (th - soft / 2)) / soft) * ha / 255, oa = ia + hA * (1 - ia);   // 記号を halo の上に（事前乗算で合成して戻す）
			if (oa <= 0) { a[i + 3] = 0; continue; }
			a[i] = Math.round((r * ia + hr * hA * (1 - ia)) / oa); a[i + 1] = Math.round((gg * ia + hg * hA * (1 - ia)) / oa); a[i + 2] = Math.round((b * ia + hb * hA * (1 - ia)) / oa); a[i + 3] = Math.round(oa * 255);
		}
		g.putImageData(px, 0, 0);
		tinted.set(key, cv);
		return cv;
	}
	const haloOf = (L, im) => L.ihw > 0 || L.ihb > 0 ? { col: css(L.ihc || [0, 0, 0, 0]), w: (L.ihw || 0) * im.pr / (L.isz || 1), b: (L.ihb || 0) * im.pr / (L.isz || 1) } : null;   // 画面 px → 記号の元の px
	const missing = new Set(), reported = new Set();   // 記号帳に無い名前（styleimagemissing の材料）＝takeMissing で 1 回だけ渡す
	const iconImg = L => { if (!L.icon) return null; const im = images.get(L.icon); if (!im && !reported.has(L.icon)) missing.add(L.icon); return im || null; };   // 記号帳に無い名前＝記号は描かない（main が styleimagemissing を鳴らす）＝文字だけ残る
	function takeMissing() { if (!missing.size) return null; const out = [...missing]; for (const n of out) reported.add(n); missing.clear(); return out; }
	// 記号の自然な箱（icon-size 倍・icon-anchor／icon-offset（px×size）で錨に置く）＝[x0, y0, w, h]（錨からの相対）
	const iconBox = (L, im) => { const sz = L.isz ?? 1, w = im.bm.width / im.pr * sz, h = im.bm.height / im.pr * sz, a = ANCH[L.ian] || ANCH.center, off = L.ioff || [0, 0]; return [off[0] * sz - a[0] * w, off[1] * sz - a[1] * h, w, h]; };
	// icon-text-fit＝文字の箱（相対 [x0,y0,w,h]）＋余白（上・右・下・左 px）へ伸ばす（width/height は片方だけ・もう片方は自然の大きさで中央）
	const iconFit = (L, im, t) => {
		if (isStretch(im)) { const f = stretchFit(im, L.isz ?? 1, L.ifit, [t[0], t[1], t[0] + t[2], t[1] + t[3]], L.ifp || [0, 0, 0, 0]), q = f.box, r = [q[0], q[1], q[2] - q[0], q[3] - q[1]]; r.i9 = f; return r; }   // 伸びる記号＝伸びる区間だけ（箱に i9 を添える＝描く側が区間ごとに）
		const [pt, pr, pb, pl] = L.ifp || [0, 0, 0, 0], sz = L.isz ?? 1, nw = im.bm.width / im.pr * sz, nh = im.bm.height / im.pr * sz, cx = t[0] + t[2] / 2, cy = t[1] + t[3] / 2, fit = L.ifit;
		const x0 = fit === "height" ? cx - nw / 2 : t[0] - pl, x1 = fit === "height" ? cx + nw / 2 : t[0] + t[2] + pr, y0 = fit === "width" ? cy - nh / 2 : t[1] - pt, y1 = fit === "width" ? cy + nh / 2 : t[1] + t[3] + pb; return [x0, y0, x1 - x0, y1 - y0]; };
	const overlaps = (placed, box) => placed.hit(box);   // 重なり＝厳密な不等号（接しているだけは重ならない＝MapLibre の格子と同じ）・格子（boxGrid）で近くの箱だけ当てる
	const grow = (b, p) => [b[0] - p, b[1] - p, b[2] + p, b[3] + p];
	// ── 向き（段 5・2026-09-28）＝錨での「地面の基底」：東と南へ画面 20px 相当だけ進めた点を投影した画面ベクトル（列＝東・南＝画面の利き手と同じ）。地図の回転（bearing）・傾き（pitch＝直角方向の縮み）・遠近が入る
	const groundBasis = (st, lon, lat, r, sx, sy, dpr, zoom) => {
		const d = 20 * 360 / (256 * Math.pow(2, zoom ?? 10)), dl = d * Math.max(0.05, Math.cos(lat * Math.PI / 180));
		const e = projectInto(st, lon + d, lat, r, PE), so = projectInto(st, lon, Math.max(-89, lat - dl), r, PS);
		if (e[2] < 0 || so[2] < 0) return null;
		return { a: (e[0] / dpr - sx) / 20, b: (e[1] / dpr - sy) / 20, c: (so[0] / dpr - sx) / 20, d: (so[1] / dpr - sy) / 20 };
	};
	const sigMax = M => { const S = M.a * M.a + M.b * M.b + M.c * M.c + M.d * M.d, D = Math.abs(M.a * M.d - M.b * M.c); return Math.sqrt((S + Math.sqrt(Math.max(0, S * S - 4 * D * D))) / 2); };
	const mul = (m, n) => ({ a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d });
	const rotM = t => ({ a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t) });
	// 点の注記の transform（錨を原点）：rotation-alignment map＝東の向きへ回す・pitch-alignment map＝地面の基底（一番伸びている向きを 1 に正規化＝傾けた直角方向が縮む）・text-rotate＝その上で回す。何も無ければ null
	function orient(st, lon, lat, r, sx, sy, dpr, zoom, ra, pa, rot) {
		if (pa === "auto") pa = ra;
		const th = (rot || 0) * Math.PI / 180;
		if (ra !== "map" && pa !== "map") return th ? rotM(th) : null;
		const M = groundBasis(st, lon, lat, r, sx, sy, dpr, zoom); if (!M) return th ? rotM(th) : null;
		if (pa === "map") { const k = sigMax(M) || 1, T = { a: M.a / k, b: M.b / k, c: M.c / k, d: M.d / k }; return th ? mul(T, rotM(th)) : T; }
		return rotM(Math.atan2(M.b, M.a) + th);   // rotation map・pitch viewport＝回すだけ
	}
	// transform した矩形（原点 (ox,oy)・左上 (lx,ly)・幅 w 高 h）を囲む画面の箱
	const aabb = (T, ox, oy, lx, ly, w, h) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [px, py] of [[lx, ly], [lx + w, ly], [lx, ly + h], [lx + w, ly + h]]) { const x = ox + T.a * px + T.c * py, y = oy + T.b * px + T.d * py; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
	const textT = (L, st, r, sx, sy, dpr, zoom) => (L.rot || L.ra === "map" || L.pa === "map") ? orient(st, L.anchor[0], L.anchor[1], r, sx, sy, dpr, zoom, L.ra === "map" ? "map" : "viewport", L.pa ?? "auto", L.rot) : null;   // 点＝auto は viewport
	// ズームに連続な文字の大きさ（MapLibre の compositeTextSize と同じ＝タイルの z と隣の z の値を表示の z で線形に補間）：labels.js が焼いた szn=[size(z−1), size(z+1)]・tz＝タイルの z。倍率（L.size に対する）
	const sizeK = (L, zoom) => { const n = L.szn; if (!n || zoom == null) return 1; const s0 = L.size || 12, d = Math.max(-1, Math.min(1, zoom - L.tz)); return (d >= 0 ? s0 + (n[1] - s0) * d : s0 + (n[0] - s0) * -d) / s0; };
	// text-translate／icon-translate（px）：anchor map（既定）＝地図の回転に追随（ベクトルを −bearing で回す＝MapLibre の translatePosition と同じ）・viewport＝画面のまま。戻り＝[dx, dy]（CSS px）
	const TR0 = [0, 0];
	const translateOf = (t, anchor, bearing) => { if (!t) return TR0; if (anchor === "viewport" || !bearing) return t; const c = Math.cos(-bearing), s = Math.sin(-bearing); return [t[0] * c - t[1] * s, t[0] * s + t[1] * c]; };
	// 文字の transform ＝ 向き（T0）に大きさの倍率 k を掛けた物（文字は L.size で組み・描き、倍率は transform で）。k＝1 なら T0 のまま（旧と同じ）
	const scaleT = (T0, k) => k === 1 ? T0 : T0 ? { a: T0.a * k, b: T0.b * k, c: T0.c * k, d: T0.d * k } : { a: k, b: 0, c: 0, d: k };
	const iconT = (L, st, r, sx, sy, dpr, zoom) => (L.ira === "map" || L.ipa === "map") ? orient(st, L.anchor[0], L.anchor[1], r, sx, sy, dpr, zoom, L.ira === "map" ? "map" : "viewport", L.ipa ?? "auto", L.irot) : null;   // 記号＝map の時だけ錨を原点に transform（それ以外の icon-rotate は箱の中心で回す＝従来）
	// ── 線に沿う注記（段 4・2026-09-28）＝折れ線（経緯度・labels.js の path）を画面（CSS px）へ投影し、錨（path[ai]）を中心に字を 1 字ずつ線の上へ置く。
	// null＝置けない（裏側・窓に収まらない・隣の字との角が text-max-angle を超える）。keep-upright＝並びが右から左になる時は逆から並べる（字は常に正立）。
	// text-offset の y＝線と直角の向き（em）。字送りは measureText（font×字で覚える）＋letter-spacing。毎フレーム投影し直す（点の注記と同じくライブ）
	const advCache = new Map();
	const advOf = (font, ch) => { const k = font + "\u0001" + ch; let v = advCache.get(k); if (v == null) { if (advCache.size > 8192) advCache.clear(); setFont(font); if (hasLS) ctx.letterSpacing = "0px"; v = ctx.measureText(ch).width; advCache.set(k, v); } return v; };
	// 記号（icon）は錨に置く＝線の向きに回す（icon-rotation-alignment auto/map＋icon-rotate）か正立（viewport）。文字が無い層（road_oneway の矢印）は記号だけ
	// ── 字の版（線に沿う注記・2026-10-13）＝（書体・色・縁）ごとに字を 1 回だけ焼き、字ごとの描画は drawImage（字の変換つき）。
	// 旧＝字ごとに変換を据えて strokeText＋fillText（縁のぼかしは shadowBlur）＝Canvas2D は変換の違う字を使い回せず毎フレーム字の形から塗り直す＝
	// 傾けた街（道の名 100 本余・字 600 個）で描画が 60→20fps に落ちていた（JS は 3ms＝重いのは塗り）。版から貼れば同じ画面で 60fps。
	// 版＝1024² の頁（字を足すたび棚に詰める）・倍率 ss（画面の 2 倍＝回しても縮めても字が痩せない）・頁が尽きたら全部捨てて焼き直す。
	// 貼る元は頁の写し（ImageBitmap）＝字を足している最中の canvas を元にすると貼るたびに写しを取り直す＝足し終えたフレームの後で写しを作り、次から使う
	const GA_PAGE = 1024, GA_MAX = 6, GA_ON = glyphAtlas && typeof OffscreenCanvas === "function";
	const ga = { pages: [], sets: new Map(), pi: 0, x: 1, y: 1, rowH: 0, ss: 0, epoch: 0 };
	function gaReset(ss) { for (const pg of ga.pages) { pg.ctx.setTransform(1, 0, 0, 1, 0, 0); pg.ctx.clearRect(0, 0, GA_PAGE, GA_PAGE); pg.bm?.close?.(); pg.bm = null; pg.gen = 0; pg.bmGen = -1; } ga.sets.clear(); ga.pi = 0; ga.x = 1; ga.y = 1; ga.rowH = 0; ga.ss = ss; ga.epoch++; }
	// 字の組（書体・塗り・縁の色と幅・ぼかし）＝字 → 版の中の位置。注記 1 本につき 1 回引く
	function glyphSet(font, fill, halo, haloW, blur, dpr) {
		const ss = dpr >= 1.5 ? 3 : 2; if (ss !== ga.ss) gaReset(ss);   // 動的解像度で dpr が細かく動いても焼き直さない（境は 1.5 だけ）
		const key = font + "\u0001" + fill + "\u0001" + (halo || "") + "\u0001" + haloW + "\u0001" + blur;
		let set = ga.sets.get(key); if (!set) ga.sets.set(key, set = { font, fill, halo, haloW, blur, px: parseFloat(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 12), m: new Map(), epoch: ga.epoch });
		return set;
	}
	function glyphSprite(set, ch) {
		let sp = set.m.get(ch); if (sp) return sp;
		let pg = ga.pages[ga.pi] ??= (cv => ({ cv, ctx: cv.getContext("2d"), bm: null, gen: 0, bmGen: -1, busy: false }))(new OffscreenCanvas(GA_PAGE, GA_PAGE)), c = pg.ctx;
		const pad = (set.halo ? set.haloW : 0) + set.blur + 1, hw0 = set.px * 0.3;
		c.setTransform(1, 0, 0, 1, 0, 0); c.font = set.font; c.textAlign = "center"; c.textBaseline = "middle";
		const mt = c.measureText(ch), hw = (mt.width || 0) / 2 || hw0;   // 字の箱＝実際の字の形（斜体のはみ出し・上下の飾り）＋縁。測れない環境は字送りと書体の大きさから
		const l = Math.max(mt.actualBoundingBoxLeft ?? hw, hw) + pad, r = Math.max(mt.actualBoundingBoxRight ?? hw, hw) + pad, up = (mt.actualBoundingBoxAscent ?? set.px * 0.85) + pad, dn = (mt.actualBoundingBoxDescent ?? set.px * 0.85) + pad;
		const k = Math.min(ga.ss, (GA_PAGE - 2) / (l + r), (GA_PAGE - 2) / (up + dn)), W = Math.ceil((l + r) * k), H = Math.ceil((up + dn) * k);   // 頁に収まらない大きな字は倍率を落とす
		if (ga.x + W + 1 > GA_PAGE) { ga.x = 1; ga.y += ga.rowH + 1; ga.rowH = 0; }
		if (ga.y + H + 1 > GA_PAGE) {
			if (ga.pi + 1 >= GA_MAX) { const ss = ga.ss; gaReset(ss); set.m = new Map(); set.epoch = ga.epoch; ga.sets.set(set.font + "\u0001" + set.fill + "\u0001" + (set.halo || "") + "\u0001" + set.haloW + "\u0001" + set.blur, set); }   // 尽きた＝全部捨てる（今引いている組は残して詰め直す）
			else { ga.pi++; ga.x = 1; ga.y = 1; ga.rowH = 0; }
			pg = ga.pages[ga.pi] ??= (cv => ({ cv, ctx: cv.getContext("2d"), bm: null, gen: 0, bmGen: -1, busy: false }))(new OffscreenCanvas(GA_PAGE, GA_PAGE)); c = pg.ctx;
			c.font = set.font; c.textAlign = "center"; c.textBaseline = "middle";
		}
		c.setTransform(k, 0, 0, k, ga.x + l * k, ga.y + up * k); c.lineJoin = "round"; c.miterLimit = 2;
		if (set.blur > 0 && set.halo) { c.shadowColor = set.halo; c.shadowBlur = set.blur * k; } else c.shadowBlur = 0;   // 縁のぼかし（text-halo-blur）は焼き込む（shadowBlur は変換が掛からない＝倍率を掛ける）
		if (set.halo) { c.strokeStyle = set.halo; c.lineWidth = set.haloW * 2; c.strokeText(ch, 0, 0); }
		c.fillStyle = set.fill; c.fillText(ch, 0, 0); c.shadowBlur = 0;
		sp = { pg, gen: ++pg.gen, x: ga.x, y: ga.y, W, H, ox: -l, oy: -up, w: W / k, h: H / k };
		set.m.set(ch, sp); ga.x += W + 1; if (H > ga.rowH) ga.rowH = H;
		return sp;
	}
	// 字を足した頁の写しを作る（描き終えた後）。写しが出来るまでは canvas から貼る（遅いが正しい）
	function gaBake() {
		if (typeof createImageBitmap !== "function") return;
		for (const pg of ga.pages) if (pg.bmGen !== pg.gen && !pg.busy) { const g = pg.gen, e = ga.epoch; pg.busy = true; createImageBitmap(pg.cv).then(bm => { pg.busy = false; if (e !== ga.epoch) { bm.close?.(); return; } pg.bm?.close?.(); pg.bm = bm; pg.bmGen = g; }, () => { pg.busy = false; }); }   // 古い写しは閉じる（貼り終えたフレームの後＝描画には残らない）
	}
	// 潰れた線の注記の濃さ（0＝出さない〜1）＝lineFlatPx の間を滑らかに
	const flatK = sq => { if (!lineFlatPx || sq >= lineFlatPx[1]) return 1; const t = (sq - lineFlatPx[0]) / ((lineFlatPx[1] - lineFlatPx[0]) || 1); return t <= 0 ? 0 : t * t * (3 - 2 * t); };
	let nullWhy = "", fitDbg = null, angDbg = null;   // 診断＝lineLayout が null を返した理由（placedDebug の line）
	// 線の字送り（ラベルごとに覚える・書体の世代・書体で有効）＝毎フレーム（線の注記は毎フレーム敷き直す）measureText の覚えを引き直さない。区間（format）があれば字ごとの書体（fonts）・大きさ（fs）。
	// 部分を丸ごと持つ注記（lp 2）の錨（子）は親の覚えを共有する（par）
	function advancesOf(L, chars, csi, size0, font, ls) {
		const H = L.par ?? L; let la = H.__la;
		if (la !== undefined && la.gen === fontGen && la.font === font) return la;
		const sty = csi ? secStyles(L, size0) : null, fonts = csi ? csi.map(si => sty[si].font) : null, fss = csi ? csi.map(si => sty[si].fs) : null, cols = csi ? csi.map(si => sty[si].col) : null;
		const a = chars.map((ch, i) => advOf(fonts ? fonts[i] : font, ch) + ls * (fss ? fss[i] : 1));
		la = H.__la = { gen: fontGen, font, adv: a, W: chars.length ? a.reduce((a, b) => a + b, 0) - ls : 0, fonts, fss, cols, hmax: fss ? Math.max(1, ...fss) : 1 };
		// 縦書き（text-writing-mode に vertical・縦書きにできる文字）＝正立の字は 1 字分（size×fs）・回す字（ラテン）は測った幅＝線が縦に近い時に使う
		if (L.wm?.includes("v") && L.ra !== "viewport-glyph") { const av = chars.map((ch, i) => (charRotated(ch) ? advOf(fonts ? fonts[i] : font, verticalize(ch)) : size0 * (fss ? fss[i] : 1)) + ls * (fss ? fss[i] : 1)); la.vadv = av; la.VW = chars.length ? av.reduce((a, b) => a + b, 0) - ls : 0; }
		return la;
	}
	// 折れ線の投影＝部分を丸ごと持つ注記（lp 2）は同じフレーム・同じ半径なら子（錨）の間で 1 回だけ（親に覚える・projGen＝描画のフレーム番号）
	let projGen = 0;
	function projectPath(L, st, r) {
		const P = L.path, n = P.length >> 1, H = L.par ?? L;
		let pr;
		if (L.lp === 2) {
			const c = H.__pr;
			if (c && c.n === n) { if (c.gen === projGen && c.r === r) return c.buf; pr = c.buf; c.gen = projGen; c.r = r; }   // 同じフレーム・同じ半径＝そのまま。違えば同じ作業域に投影し直す
			else { pr = new Float64Array(3 * n); H.__pr = { gen: projGen, r, n, buf: pr }; }
		} else { if (prBuf.length < 3 * n) prBuf = new Float64Array(3 * n * 2); pr = prBuf; }
		for (let i = 0; i < n; i++) { projectInto(st, P[i * 2], P[i * 2 + 1], r, PJ); pr[i * 3] = PJ[0]; pr[i * 3 + 1] = PJ[1]; pr[i * 3 + 2] = PJ[2]; }
		return pr;
	}
	function lineLayout(L, st, dpr, r, zoom) {
		const P = L.path, n = P.length >> 1; if (n < 2) { nullWhy = "empty"; return null; }
		const im = iconImg(L), chars = L.text ? charsOf(L) : NO_CHARS, csi = L.sec ? L.__cs : null;
		if (!chars.length && !im) { nullWhy = "empty"; return null; }
		// 投影＝錨を含む「表側の連続区間」だけ使う（全球ビューの赤道など＝窓の端が地球の裏に届いても錨の周りは置ける・旧＝裏の頂点が 1 つでもあれば丸ごと却下）。
		// 重なる点＝長さ 0 の線分は捨てる（錨が頂点と一致した時に角度が跳んで max-angle で落ちていた）。s0＝錨の弧長。錨は頂点 ai と ai+1 の間（at＝0〜1・lp 2 の子）か頂点 ai の上（従来）
		const ai = Math.min(L.ai ?? 0, n - 1), at = L.at || 0, bi = at > 0 ? Math.min(ai + 1, n - 1) : ai;
		const pr = projectPath(L, st, r);
		if (pr[ai * 3 + 2] < 0 || pr[bi * 3 + 2] < 0) { nullWhy = "back"; return null; }
		let lo = ai, hi = bi; while (lo > 0 && pr[(lo - 1) * 3 + 2] >= 0) lo--; while (hi < n - 1 && pr[(hi + 1) * 3 + 2] >= 0) hi++;
		const xs = [], ys = [], cum = [];
		let ka = 0, kb = 0;
		for (let i = lo; i <= hi; i++) {
			const dx = pr[i * 3], dy = pr[i * 3 + 1];
			const x = dx / dpr, y = dy / dpr, k = xs.length;
			if (k && Math.hypot(x - xs[k - 1], y - ys[k - 1]) < 1e-3) { if (i === ai) ka = k - 1; if (i === bi) kb = k - 1; continue; }
			xs.push(x); ys.push(y); cum.push(k ? cum[k - 1] + Math.hypot(x - xs[k - 1], y - ys[k - 1]) : 0);
			if (i === ai) ka = k; if (i === bi) kb = k;
		}
		const m_n = xs.length; if (m_n < 2) { nullWhy = "empty"; return null; }
		const total = cum[m_n - 1]; if (!(total > 0)) { nullWhy = "empty"; return null; }
		const sA = cum[ka] + (cum[kb] - cum[ka]) * at;   // 錨の弧長（画面 px）
		let s0 = sA;
		// 大きさ＝L.size（タイルの z）× 表示の z の倍率 sk（sizeK）：字送りは L.size で測って覚え（書体の文字列は不変＝覚えが効く）、幅・間隔は sk 倍・字は transform で sk 倍に描く
		const size0 = L.size || 12, sk = sizeK(L, zoom), size = size0 * sk, font = fontOf(L, size0), ls = (L.ls || 0) * size0;
		const la = advancesOf(L, chars, csi, size0, font, ls);
		let adv = la.adv, W = la.W * sk, vert = false;
		// 地面の基底（pitch-alignment map）＝錨そのものの投影を原点に測る（旧＝線に収めるために滑らせた後の位置 m を原点にしていた＝滑った分（〜文字の 3/4）が 20px の基線に混ざり、
		// 基底が壊れて字が鏡像・数倍に化けた＝傾けた街路で頻発）。裏返った基底（det ≤ 0）は使わない＝画面で回すだけ
		const paMap = L.ra !== "viewport-glyph" && (L.pa ?? "auto") !== "viewport";
		let M = null, det = 0, smax = 1;
		if (paMap && chars.length) {
			projectInto(st, L.anchor[0], L.anchor[1], r, PJ);
			if (PJ[2] >= 0) { M = groundBasis(st, L.anchor[0], L.anchor[1], r, PJ[0] / dpr, PJ[1] / dpr, dpr, zoom); det = M ? M.a * M.d - M.b * M.c : 0; if (det > 1e-9) smax = sigMax(M) || 1; else M = null; }
		}
		// 画面の向き (dx, dy)（単位）へ地面で 1 進んだ時の画面の長さ（一番伸びている向きを 1 に正規化＝奥へ向かう線は cos(pitch) に縮む）。
		// 1% までの縮みは 1 に丸める＝真俯瞰でも基底は東西と南北で僅かに違う（楕円体の曲率半径の差 〜0.7%）＝傾けていない地図の字送りを向きで変えない
		const shrink = (dx, dy) => { const gx = (M.d * dx - M.c * dy) / det, gy = (-M.b * dx + M.a * dy) / det, n = Math.hypot(gx, gy) * smax / 1.01; return n > 1 ? 1 / n : 1; };
		// 弧長 q の点と向き＝二分探索（部分を丸ごと持つ線は頂点が多い＝字ごとの線形探索をしない）
		const at_ = q => { let a = 1, b = m_n - 1; while (a < b) { const c = (a + b) >> 1; if (cum[c] < q) a = c + 1; else b = c; } const i = a, t = (q - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [xs[i - 1] + (xs[i] - xs[i - 1]) * t, ys[i - 1] + (ys[i] - ys[i - 1]) * t, Math.atan2(ys[i] - ys[i - 1], xs[i] - xs[i - 1])]; };
		// 縦書き（MapLibre の線の注記＝横と縦の両方を組み、錨の所の線の向きが縦に近い（45° 超）なら縦）＝字送りを縦の物に替える・読む向きは上→下
		if (la.vadv && chars.length) { const q0 = Math.max(0, s0 - W / 2), q1 = Math.min(total, s0 + W / 2), p0 = at_(q0), p1 = at_(q1); if (Math.abs(p1[1] - p0[1]) > Math.abs(p1[0] - p0[0])) { vert = true; adv = la.vadv; W = la.VW * sk; } }
		// 字は地面に寝る＝字送りも地面の長さ（旧＝字送りは画面 px のまま・字の高さだけ地面＝奥へ向かう道の名が 1/cos(pitch) 倍に膨れた）。f＝錨の所の線の向きの縮み（文字 1 本で 1 つ）
		let f = 1;
		if (M) { const p0 = at_(Math.max(0, sA - W / 2)), p1 = at_(Math.min(total, sA + W / 2)), dx = p1[0] - p0[0], dy = p1[1] - p0[1], dn = Math.hypot(dx, dy), a = at_(sA)[2]; f = dn > 1e-3 ? shrink(dx / dn, dy / dn) : shrink(Math.cos(a), Math.sin(a)); W *= f; }
		const skf = sk * f, sizeF = size * f;
		if (W > total) { nullWhy = "fit"; fitDbg = [Math.round(s0), Math.round(W), Math.round(total), L.text, size, L.ls || 0, n, lo, hi]; return null; }
		// 錨の弧長 s0 は、文字が線（地球の縁で切れた分も）に収まる範囲へ寄せる（旧＝錨に固定＝縁の近くや短い窓で「fit」で落ちた。symbol-spacing は寄せた後の位置で裁く）。
		// 部分を丸ごと持つ線（lp 2）は錨から文字の 3/4＋2 字分まで（窓）＝隣の錨の持ち場へ滑らない
		const win = L.lp === 2 ? W * 0.75 + sizeF * 2 : Infinity, qlo = Math.max(W / 2, sA - win), qhi = Math.min(total - W / 2, sA + win);
		if (qlo > qhi) { nullWhy = "fit"; fitDbg = [Math.round(s0), Math.round(W), Math.round(total), L.text, size, L.ls || 0, n, lo, hi]; return null; }
		s0 = Math.min(Math.max(s0, qlo), qhi);
		const m = at_(s0);
		let rev = false;
		if (chars.length && vert) { const a = at_(s0 - W / 2), b = at_(s0 + W / 2); rev = b[1] < a[1]; }   // 縦書き＝常に上から下へ
		else if (chars.length && L.ku !== false) {   // 縦に近い線は向きが 1 フレームごとに入れ替わり得る＝前の向きを覚え、縦から 6° 余り越えるまで替えない（最初は素の判定＝MapLibre と同じ）
			const a = at_(s0 - W / 2), b = at_(s0 + W / 2), ddx = b[0] - a[0], tol = Math.abs(b[1] - a[1]) * 0.11;
			rev = L.__rev == null ? ddx < 0 : L.__rev ? ddx < tol : ddx < -tol; L.__rev = rev;
		}
		const g = [], ma = (L.ma ?? 45) * Math.PI / 180, oy = (L.off?.[1] || 0) * size;
		let q = s0 - W / 2, prev = null;
		// 字の向き＝字の中心を挟む弦（幅＝max(字送り, 1.5 字)＝微小な線分の向きは字ごとに振れる＝小川のジグザグで max-angle に当たっていた・タイルの z が MapLibre より細かい分だけ折れ線が粗い）。弦が潰れていれば線分の向き
		const chord = (q0, q1) => { const p0 = at_(Math.max(0, q0)), p1 = at_(Math.min(total, q1)), dx = p1[0] - p0[0], dy = p1[1] - p0[1]; return dx * dx + dy * dy > 1e-6 ? Math.atan2(dy, dx) : p1[2]; };
		for (let i = 0; i < chars.length; i++) {
			const k = rev ? chars.length - 1 - i : i, ak = adv[k] * skf, half = ak / 2, cw = Math.max(ak, sizeF * 1.5) / 2;
			const [x, y] = at_(q + half), a0 = chord(q + half - cw, q + half + cw), a = rev ? a0 + Math.PI : a0;
			if (prev != null) { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; if (Math.abs(d) > ma) { nullWhy = "angle"; if (!angDbg) angDbg = { text: L.text, i, q: Math.round(q), s0: Math.round(s0), W: Math.round(W), total: Math.round(total), a: Math.round(a * 180 / Math.PI), prev: Math.round(prev * 180 / Math.PI), rev, pts: xs.map((x, j) => [Math.round(x), Math.round(ys[j]), Math.round(cum[j])]), gl: g.map(c => [Math.round(c.x), Math.round(c.y), Math.round(c.a * 180 / Math.PI)]) }; return null; } }
			prev = a;
			// 縦書きの正立の字＝字の上を「線の進む向きの逆（上）」へ＝向きを 90° 戻す（線が真下へ向く時に字が正立）。回す字（ラテン）は横書きと同じ向き（線に沿って寝る）・句読点は縦の形
			const vr = vert && !charRotated(chars[k]);
			g.push({ ch: vert ? verticalize(chars[k]) : chars[k], x: x - Math.sin(a) * oy, y: y + Math.cos(a) * oy, a: vr ? a - Math.PI / 2 : a, w: adv[k] - ls, ...(la.fonts ? { f: la.fonts[k], col: la.cols[k] } : {}) });
			q += ak;
		}
		if (rev) g.reverse();
		// 字の transform（段 5）：pitch-alignment map（既定）＝字の上向きを「地面で線と直角」の向きへ（傾けると字が地面に寝る）。viewport＝画面で直角（回すだけ）。rotation-alignment viewport-glyph＝字は正立のまま線に沿って並ぶ
		for (const c of g) {
			if (L.ra === "viewport-glyph") { c.a = 0; c.t = scaleT(null, sk); continue; }
			if (M) { const dx = Math.cos(c.a), dy = Math.sin(c.a), gx = (M.d * dx - M.c * dy) / det, gy = (-M.b * dx + M.a * dy) / det, px = -gy, py = gx; c.t = scaleT({ a: dx, b: dy, c: M.a * px + M.c * py, d: M.b * px + M.d * py }, skf); }   // 地面の向き d_g＝M⁻¹d_s・直角 p_g＝rot90(d_g)・画面へ M（大きさの倍率と地面の縮み込み）
			else c.t = scaleT(rotM(c.a), sk);
		}
		let icon = null;
		if (im) { const sz = L.isz ?? 1, iw = im.bm.width / im.pr * sz, ih = im.bm.height / im.pr * sz, a0 = chord(Math.max(0, s0 - iw / 2), Math.min(total, s0 + iw / 2)), a = (L.ira === "viewport" ? 0 : (rev ? a0 + Math.PI : a0)) + (L.irot || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)); icon = { x: m[0], y: m[1], a, w: iw, h: ih, bw: iw * c + ih * sn, bh: iw * sn + ih * c }; }   // bw/bh＝回した記号を囲む箱
		const ang = prev ?? m[2];
		// 潰れ＝字の行列の縮む側の倍率（＝基底の σmin/σmax＝線の向きに依らず錨の画面位置で決まる）×書体の大きさ＝潰れた向きの字の高さ（CSS px）。地面に寝ない字は潰れない
		return { g, w: W, h: size * la.hmax, hl: size0 * la.hmax, sq: M ? det / (smax * smax) * size : Infinity, x: m[0] - Math.sin(ang) * oy, y: m[1] + Math.cos(ang) * oy, font, icon, vert };
	}
	// 部分を丸ごと持つ線の注記（lp 2）の錨＝表示の整数 z（zi）で symbol-spacing の間隔に置く（MapLibre の getAnchors＝過拡大のタイルごとに組み直すのと同じ答え）。整数 z ごとに覚える（鍵＝親の鍵＋"#zi:番号"＝z を跨ぐと入れ替わりフェード）。
	// 間隔＝文字の長さに対して spacing−長さ＜spacing/4 なら 長さ＋spacing/4・最初の錨＝枠に続く線は spacing/2・そうでなければ（長さ/2＋2 字分）% spacing（T 字路の衝突を避ける）・
	// 錨は文字が線に収まる所（±長さ/2 が線の中）かつタイルの枠の中（隣のタイルの続きと二重に出さない）。1 つも置けず枠に続かない線（短い線・過拡大）＝線の中心に 1 つ（MapLibre の placeAtMiddle）
	const kidByKey = new Map();   // 子の鍵 → 子（フェードアウト中の描画が引く）
	function kidsOf(L, zi) {
		const c = L.__kids; if (c && c.zi === zi && c.gen === fontGen) return c.list;
		const list = [], P = L.path, n = P.length >> 1, cum = L.cum;
		if (n >= 2 && cum && cum.length === n) {
			const im = iconImg(L), chars = L.text ? charsOf(L) : NO_CHARS, csi = L.sec ? L.__cs : null, size0 = L.size || 12, sk = sizeK(L, zi), size = size0 * sk;
			let len = 0;   // 文字（記号）の長さ＝表示 z の px
			if (chars.length) len = advancesOf(L, chars, csi, size0, fontOf(L, size0), (L.ls || 0) * size0).W * sk;
			if (im) len = Math.max(len, im.bm.width / im.pr * (L.isz ?? 1));
			if (len > 0 || (!chars.length && im)) {
				const k = Math.pow(2, zi - (L.tz ?? zi)) / (L.upp || 16) * Math.cos(L.anchor[1] * Math.PI / 180), total = cum[n - 1] * k;   // タイル単位 → 表示 z の画面 px（正射の球＝メルカトルのタイルは緯度の cos 分だけ狭く見える）
				let sp = Math.max(1, L.sp || 250); if (sp - len < sp / 4) sp = len + sp / 4;
				const cont = L.lc || 0, offset = (cont & 1) ? (sp / 2) % sp : (len / 2 + size * 2) % sp, tb = L.tbx;
				const at = d => { const q = d / k; let a = 1, b = n - 1; while (a < b) { const c = (a + b) >> 1; if (cum[c] < q) a = c + 1; else b = c; } const i = a, t = (q - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [P[i * 2 - 2] + (P[i * 2] - P[i * 2 - 2]) * t, P[i * 2 - 1] + (P[i * 2 + 1] - P[i * 2 - 1]) * t, i - 1, t]; };
				const push = d => { const [lon, lat, i, t] = at(d); if (tb && (lon < tb[0] || lon >= tb[2] || lat <= tb[1] || lat > tb[3])) return; list.push({ ...L, anchor: [lon, lat], ai: i, at: t, key: (L.key ?? keyOf(L)) + "#" + zi + ":" + list.length, par: L, __k: undefined, __la: undefined, __kids: undefined, __pr: undefined }); };
				for (let d = offset; d <= total; d += sp) if (d - len / 2 >= 0 && d + len / 2 <= total) push(d);
				if (!list.length && !(cont & 1) && len <= total) push(total / 2);
			}
		}
		for (const kid of list) kidByKey.set(keyOf(kid), kid);
		if (c) for (const kid of c.list) { const k = keyOf(kid); if (!fades.has(k)) kidByKey.delete(k); }   // 前の整数 z の子＝フェードアウト中だけ鍵の表に残す
		L.__kids = { zi, gen: fontGen, list };
		return list;
	}
	let labels = [];
	const fades = new Map();        // key → 不透明度（フェード）
	let winners = new Map();         // key → L（現在の当選集合。間引きで更新）
	let lastCollide = -1e9, dirty = true, lastShowFlat = true, lastZi = -1;   // showFlat=傾き閾値下（真俯瞰）だけ測量点等の flat ラベルを出す
	let lastDraw = -1; const lastMvp = new Float64Array(16);   // フェードの時計・前の描画のカメラ（止まっているか）
	let fontGen = 0;                // 書体の世代（clearFontCache で進む）＝ラベルごとの textLayout の覚え（__tl）の有効性
	const widthCache = new Map();   // "size|text" → measureText 幅。measureText は高コスト＝再衝突判定(150ms毎)の度に全ラベル分呼ばない
	let labelByKey = new Map();     // key → L（フェードアウト中ラベルの逆引き。draw 毎の線形探索を排除）

	function setLabels(list) {
		labels = list.slice();
		rebuild();
	}
	// ── 利用者層のラベル集合（gint 多層の text-field・2026-09-09）＝基図ラベルと同じ衝突/フェード/標高投影に相乗り。
	// id 別に持ち、層の setVisible/remove と連動。minZoom/maxZoom＝層の属性（ラベルへ焼き込み・collide で裁く）。
	// sort 既定 -1＝利用者データのラベルが基図注記に勝つ（「今載せたデータを見たい」）。
	const userSets = new Map();   // id → { list, visible }
	function rebuild() {
		const u = [];
		for (const st of userSets.values()) if (st.visible) u.push(...st.list);
		// 優先順＝MapLibre の層（ml）は「後の層が先に置く」（層の添字 li の降順）→ 層の中は symbol-sort-key 昇順。ネイティブの層は従来どおり sort だけ（この地図の注記の設計＝sort に焼いてある）。
		// 利用者の層（vtdraw/gint）は sort に −1e6 − 層順×1e3 を焼いてある＝常に基図より先（MapLibre の「後から足した層が勝つ」と同じ）
		const pri = L => (L.sort ?? 0) - (L.mlp && L.li != null ? L.li * 1e3 : 0);
		const all = [...u, ...labels].sort((a, b) => pri(a) - pri(b));
		labelByKey = new Map(all.map(L => [keyOf(L), L]));
		if (kidByKey.size) { const alive = new Set(all); for (const [k, kid] of kidByKey) if (!alive.has(kid.par)) kidByKey.delete(k); }   // 親が集合から消えた子は捨てる
		combined = all;
		zoAny = all.some(zoY);
		dirty = true;
	}
	let combined = [];
	// symbol-z-order（C5）：zo＝"viewport-y"｜"source"（無指定＝auto）・sk＝sort-key あり。MapLibre の sortFeaturesByY＝(viewport-y か auto で sort-key 無し) かつ (allow-overlap か ignore-placement)
	const zoY = L => (L.zo === "viewport-y" || (L.zo !== "source" && !L.sk)) && !!(L.ov || L.ig || L.iov || L.iig);
	let zoAny = false;
	function setUserLabels(id, list, meta = {}) {
		if (!list?.length) userSets.delete(id);
		else userSets.set(id, {
			visible: userSets.get(id)?.visible ?? true,
			list: list.map(L => ({ sort: -1, size: 12, color: [0.15, 0.18, 0.22, 1], halo: [1, 1, 1, 0.9], haloW: 2, ...L,
				k: String(id), minZ: meta.minZoom ?? null, maxZ: meta.maxZoom ?? null })),
		});
		rebuild();
	}
	// 標高の付け直し（DEM が後から届いた・生き替わった時＝render worker が呼ぶ）：基図と利用者層の全ラベルに fn(L) の標高を入れ、衝突判定をやり直す
	function setElev(fn) { for (const L of labels) L.elev = fn(L); for (const st of userSets.values()) for (const L of st.list) L.elev = fn(L); dirty = true; }
	function setUserVisible(id, v) {
		const st = userSets.get(id);
		if (st && st.visible !== !!v) { st.visible = !!v; rebuild(); }
	}
	// 星空劇場の注記（星座名・メシエ天体）。データは { constellations:[{cel,name}], messier:[{cel,name,type}] }、
	// cel＝天球単位ベクトル（RA/Dec焼き込み・アプリが供給）。null＝非表示（星座線のトグルと同期）。
	let sky = null;
	function setSky(data) { sky = data; }
	// 断面（#111 段 3）：面（clip.js clipPlanes の列・null＝切らない）。錨（標高の持ち上げ込み）が切られた側の注記は当選集合に入れない
	let clipPl = null;
	function setClip(planes) { clipPl = planes && planes.length ? planes : null; dirty = true; }
	// 月＝満ち欠けの円盤（注記トグルと独立＝天体なので常設）。{ cel, sunCel, k }＝方向・太陽方向・輝面比。
	let moon = null;
	function setMoon(data) { moon = data; }
	// 共通の時計の基準（#42・{sim,wall,rate}｜null＝実時刻）＝render worker が renderer の view.clock と同じ物を渡す
	let clock = null;
	function setClock(c) { clock = c || null; }
	function clear() {
		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
		fades.clear(); winners.clear();
	}

	// 衝突判定（優先度順の貪欲）。当選集合 winners を更新。
	let winBox = new Map();   // key → { sx, sy, tw, h, dx, dy, tl, an, txt, ib }（当選ラベルの画面上の箱＝placed() と draw の材料・公式例の門 段 0）。txt＝文字を置いた・ib＝置いた記号の箱 [dx, dy, w, h]（錨からの相対）
	let dbg = { zoom: null, outOfZoom: {}, total: 0 };   // 診断（placedDebug）＝直近の衝突判定の地図 z と、zoom 域で外した数（層の添字/利用者層 id ごと・minZ/maxZ の見本）
	function collide(st, dpr, Wc, Hc, eScale, showFlat, fogF, zoomV, bearing = 0) {
		const placed = boxGrid(), w = new Map(), wb = new Map(), lineGrp = new Map();   // lineGrp＝線の注記の群（層＋文字）→ 置いた位置＝symbol-spacing（画面 px）を課す
		dbg = { zoom: zoomV, outOfZoom: {}, total: combined.length, line: { n: 0, layout: 0, off: 0, overlap: 0, spacing: 0, ok: 0 }, pt: {} };   // line＝線の注記の落ちた理由・pt＝点の注記の層ごとの結果（診断）
		const ptDbg = (L, k, eg) => { const key = L.k ?? ("li" + L.li), e = dbg.pt[key] ??= { n: 0, back: 0, noimg: 0, text: 0, icon: 0, off: 0, spacing: 0, ok: 0 }; e[k]++; if (k !== "n") e.n++; if (eg && !e[k + "Eg"]) e[k + "Eg"] = eg(); };   // eg＝見本を作る関数（最初の 1 件だけ作る＝落ちたラベルのたびに配列を組まない）
		const zi = Math.floor(zoomV);
		for (const L0 of combined) {
			if (L0.flat && !showFlat) continue;
			const kids = L0.lp === 2 ? kidsOf(L0, zi) : null;
			for (let ki = 0, kn = kids ? kids.length : 1; ki < kn; ki++) {
			const L = kids ? kids[ki] : L0; if (kids) L.elev = L0.elev;
			if ((L.minZ != null && zoomV < L.minZ - 1e-3) || (L.maxZ != null && zoomV > L.maxZ + 1e-3)) { const key = L.k ?? ("li" + L.li); const e = dbg.outOfZoom[key] ??= { n: 0, minZ: L.minZ, maxZ: L.maxZ }; e.n++; continue; }   // 層の zoom 域で裁く（利用者層＝meta・基図＝labels.js の minZ/maxZ）。1e-3＝整数の境（MapLibre の zoom 3＝こちらの換算で 2.999998）を落とさない   // 傾けたら測量点(真俯瞰の作法)は当選集合から外す＝以降フェードアウト（等高線と対称）
			const rad = radiusOf(L, eScale, st, fogF); projectInto(st, L.anchor[0], L.anchor[1], rad, PJ);
			const dx = PJ[0], dy = PJ[1], front = PJ[2];
			if (clipPl && clipDistanceM(clipPl, L.anchor[0], L.anchor[1], (rad - 1) * worldRadiusM()) < 0) continue;   // 断面で切られた側（#111 段 3）
			if (front < 0) { if (!L.lp) ptDbg(L, "back", () => [String(L.text).slice(0, 20), +L.anchor[0].toFixed(2), +L.anchor[1].toFixed(2), +front.toFixed(3), +rad.toFixed(4)]); continue; }
			const tr = L.tt ? translateOf(L.tt, L.tta, bearing) : TR0, sx = dx / dpr + tr[0], sy = dy / dpr + tr[1];   // text-translate＝錨の画面位置に足す（線に沿う注記は読まない）
			if (L.lp) {   // 線に沿う注記（段 4）＝字ごとの箱（text-padding 込み）で裁く。全部の字が画面の外なら出さない
				const dl = dbg.line; dl.n++;
				const lb = (dbg.lineBy ??= {})[L.k ?? ("li" + L.li)] ??= { n: 0, layout: 0, off: 0, overlap: 0, spacing: 0, ok: 0 }; lb.n++;   // 層ごと（診断）
				const ll = lineLayout(L, st, dpr, rad, zoomV); if (!ll) { dl.layout++; lb.layout++; dl[nullWhy] = (dl[nullWhy] || 0) + 1; if (nullWhy === "fit" && !dl.fitEg) dl.fitEg = fitDbg; if (angDbg && !dl.angEg) dl.angEg = angDbg; continue; }
				if (ll.g.length && flatK(ll.sq) <= 0) { dl.layout++; lb.layout++; dl.flat = (dl.flat || 0) + 1; continue; }   // 潰れて読めない＝出さない（場所も取らない）
				const padL = L.pad ?? pad, boxes = ll.g.map(c => grow(c.t ? aabb(c.t, c.x, c.y, -c.w / 2, -ll.hl / 2, c.w, ll.hl) : [c.x - c.w / 2, c.y - ll.hl / 2, c.x + c.w / 2, c.y + ll.hl / 2], padL));
				let bb = null; for (const b of boxes) bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])] : b.slice();   // 全部の字を囲む箱（placed の w/h）
				if (ll.icon) { const ic = ll.icon, ip = L.ipad ?? 2; boxes.push([ic.x - ic.bw / 2 - ip, ic.y - ic.bh / 2 - ip, ic.x + ic.bw / 2 + ip, ic.y + ic.bh / 2 + ip]); }   // 記号の箱（icon-padding）＝文字と一緒に裁く（両方置けなければ出さない）
				if (boxes.every(b => b[2] < 0 || b[0] > Wc || b[3] < 0 || b[1] > Hc)) { dl.off++; lb.off++; continue; }
				if (!L.ov && boxes.some(b => overlaps(placed, b))) { dl.overlap++; lb.overlap++; continue; }
				const grp = L.sp && L.lp !== 2 ? (L.k ?? "b" + L.li) + "\u0001" + (L.lg ?? L.text) : null, ga = grp ? lineGrp.get(grp) : null;   // 群＝1 本の線（lg）・無ければ文字。丸ごとの線（lp 2）の錨は置く時に間隔を取ってある＝ここでは裁かない（傾けた画面で縮んでも落とさない＝MapLibre と同じ）
				if (ga && ga.some(p => Math.hypot(p[0] - ll.x, p[1] - ll.y) < L.sp - 1)) { dl.spacing++; lb.spacing++; continue; }   // symbol-spacing＝同じ文字の線の注記は画面 px でこの間隔より近くに置かない（候補はタイルが細かく焼く＝表示 z に追随）
				if (grp) { if (ga) ga.push([ll.x, ll.y]); else lineGrp.set(grp, [[ll.x, ll.y]]); }
				if (!L.ig) for (const b of boxes) placed.push(b);
				dl.ok++; lb.ok++;
				w.set(keyOf(L), L); wb.set(keyOf(L), { sx, sy, tw: ll.w, h: ll.h, dx: ll.x - sx - ll.w / 2, dy: ll.y - sy - ll.h / 2, tl: null, an: "center", txt: ll.g.length > 0, ib: null, ln: ll, bb: bb ? [bb[2] - bb[0] - 2 * padL, bb[3] - bb[1] - 2 * padL] : null });
				continue;
			}
			const shield = shieldFor && shieldFor(L), im = iconImg(L), hasText = !!shield || !!(L.text && String(L.text).length);
			if (!hasText && !im) { ptDbg(L, "noimg"); continue; }   // 記号だけのラベルで記号帳にまだ無い＝出さない（届いたら setImage が dirty にする）
			// 箱＝標識ならその絵・文字なら layout（折り返し・字間・行の高さ）で組んだ行の束（textLayout）。錨からの置き方＝text-anchor/offset（variable-anchor は候補を順に試す）
			// 向き（text-writing-mode・2026-10-03）＝"vh"／"hv"／"v"＝並びの順に組んで置けた物（MapLibre の placementModes）。無ければ横書きだけ
			const ors = L.wm && hasText && !shield ? [...L.wm] : ["h"];
			let tw = 0, h = 0, tl = null;
			const padL = L.pad ?? pad, ipad = L.ipad ?? 2, k = shield ? 1 : sizeK(L, zoomV);
			const T0 = textT(L, st, rad, sx, sy, dpr, zoomV), T = scaleT(T0, k), Ti = im ? (iconT(L, st, rad, sx, sy, dpr, zoomV) ?? T0) : null;   // 向き（段 5）＝文字の transform（大きさの倍率込み）・記号は自分の map 指定があればそれ・無ければ文字の向き（倍率は掛けない＝icon-size の領分）
			const tb = (Tm, lx, ly, w, h) => Tm ? aabb(Tm, sx, sy, lx, ly, w, h) : [sx + lx, sy + ly, sx + lx + w, sy + ly + h];   // 錨からの箱 → 画面の箱（transform 込み）
			// 記号と文字の裁き（MapLibre の placement と同じ）：既定＝両方置けなければ両方出さない。text-optional＝記号だけでも出す・icon-optional＝文字だけでも出す
			const iconAlone = L.topt || !hasText, textAlone = L.iopt || !im;
			const judge = (tOK, iOK) => !textAlone && !iconAlone ? [tOK && iOK, tOK && iOK] : !textAlone ? [tOK && iOK, iOK] : !iconAlone ? [tOK, iOK && tOK] : [tOK, iOK];   // → [文字を置く, 記号を置く]
			const nat = im ? iconBox(L, im) : null, itr = im && L.itt ? translateOf(L.itt, L.itta, bearing) : TR0;   // 記号の自然な箱（fit しない時＝候補に依らない）・icon-translate
			if (nat && itr !== TR0) { nat[0] += itr[0]; nat[1] += itr[1]; }
			const iOKof = ib => !im || L.iov || !overlaps(placed, grow(tb(Ti, ib[0], ib[1], ib[2], ib[3]), ipad));
			let hit = null, lastWhy = "off";
			if (hasText) {
				const cands = shield ? [["center", 0, 0]] : anchorCands(L, winBox.get(keyOf(L))?.an);   // variable-anchor＝前回置けた錨を先に試す（MapLibre と同じ＝衝突判定のたびに錨が飛ばない）
				for (const or of ors) {
				if (shield) { tw = shield.w; h = shield.h; } else { tl = textLayout(L, or === "v"); tw = tl.w; h = tl.h; }
				for (const [an, ox, oy] of cands) {
					const a = ANCH[an] || ANCH.center, lx0 = ox - a[0] * tw, ly0 = oy - a[1] * h, x0 = sx + lx0, y0 = sy + ly0;   // 箱の左上（錨＋offset を箱のどの点に合わせるか）
					const bb = tb(T, lx0, ly0, tw, h);
					if (bb[2] < 0 || bb[0] > Wc || bb[3] < 0 || bb[1] > Hc) continue;
					const box = grow(bb, padL);
					const ib = im ? (L.ifit ? iconFit(L, im, [lx0 * k, ly0 * k, tw * k, h * k]) : nat) : null;   // icon-text-fit＝文字の箱（向きの空間・倍率込み）
					if (ib && ib !== nat && itr !== TR0) { ib[0] += itr[0]; ib[1] += itr[1]; }
					const tOK = L.ov || !overlaps(placed, box), iOK = iOKof(ib), [pt, pi] = judge(tOK, iOK);
					if (!pt) { lastWhy = !tOK ? "text" : !iOK ? "icon" : "text"; continue; }   // 文字が置けない候補＝次の候補（variable-anchor）
					hit = { box, x0, y0, an, txt: true, ib: pi ? ib : null, bb: [bb[2] - bb[0], bb[3] - bb[1]] }; break;
				}
				if (hit) break;
				}
				if (!hit && im && iconAlone) { const [, pi] = judge(false, iOKof(nat)); if (pi) hit = { box: null, x0: sx, y0: sy, an: L.an || "center", txt: false, ib: nat }; }   // 文字はどの候補も置けない＝text-optional なら記号だけ
			} else { const [, pi] = judge(false, iOKof(nat)), nb = tb(Ti, nat[0], nat[1], nat[2], nat[3]); if (pi && !(nb[2] < 0 || nb[0] > Wc || nb[3] < 0 || nb[1] > Hc)) hit = { box: null, x0: sx, y0: sy, an: "center", txt: false, ib: nat }; }
			if (!hit) { ptDbg(L, hasText ? lastWhy : "icon", () => [String(L.text).slice(0, 20), Math.round(sx), Math.round(sy), Math.round(tw), Math.round(h), Math.round(Wc), Math.round(Hc)]); continue; }
			if (L.sp) {   // 線の錨に回さず置く注記（text-rotation-alignment viewport＝道路の盾）＝symbol-spacing を同じ群に課す
				const grp = (L.k ?? "b" + L.li) + "\u0001" + (L.lg ?? L.text + "\u0001" + (L.icon || "")), ga = lineGrp.get(grp);
				if (ga && ga.some(p => Math.hypot(p[0] - sx, p[1] - sy) < L.sp)) { ptDbg(L, "spacing"); continue; }
				if (ga) ga.push([sx, sy]); else lineGrp.set(grp, [[sx, sy]]);
			}
			ptDbg(L, "ok");
			if (hit.txt && !L.ig) placed.push(hit.box);   // ignore-placement＝他を押しのけない（自分は置く）
			if (hit.ib && !L.iig) placed.push(grow(tb(Ti, hit.ib[0], hit.ib[1], hit.ib[2], hit.ib[3]), ipad));
			w.set(keyOf(L), L); wb.set(keyOf(L), { sx, sy, tw, h, dx: hit.x0 - sx, dy: hit.y0 - sy, tl, an: hit.an, txt: hit.txt, ib: hit.ib, bb: hit.bb ?? null, T: hit.txt ? T : null, ibb: hit.ib ? (q => [q[2] - q[0], q[3] - q[1]])(tb(Ti, hit.ib[0], hit.ib[1], hit.ib[2], hit.ib[3])) : null });   // dx,dy＝錨から箱の左上（描く時はライブ投影の錨に足す・T があれば T の空間）
			}
		}
		// フェードアウト中（当選から外れた）のラベルは最後の箱を持ち越す＝消えていく間も text-anchor／offset／variable-anchor／icon-text-fit の位置のまま（旧＝箱を失い中央・自然な記号の箱へ跳んでいた）
		for (const k of fades.keys()) if (!wb.has(k)) { const o = winBox.get(k); if (o) wb.set(k, o); }
		winners = w; winBox = wb;
	}
	// 錨の候補＝[anchor, 画面 x の足し, y の足し]。text-offset は em（size 倍）。variable-anchor＝候補ごとに錨の反対側へ離す（radial-offset か offset の大きさ・MapLibre と同じ・symbols-2d と同式）
	function anchorCands(L, prevAn = null) {
		const size = L.size || 12, off = L.off || [0, 0];
		if (L.va?.length) {
			if (L.vao) { const c = L.va.map(an => { const o = L.vao[an] || [0, 0]; return [an, o[0] * size, o[1] * size]; }); if (prevAn && c.length > 1) { const i = c.findIndex(x => x[0] === prevAn); if (i > 0) { const [p] = c.splice(i, 1); c.unshift(p); } } return c; }   // text-variable-anchor-offset＝錨ごとのずらし（em・text-offset と同じ向き）
			const r = (L.ro ?? Math.max(Math.abs(off[0]), Math.abs(off[1]))) * size;
			const c = L.va.map(an => { const k = an.includes("-") ? Math.SQRT1_2 : 1; return [an, (an.includes("left") ? r : an.includes("right") ? -r : 0) * k, (an.startsWith("top") ? r : an.startsWith("bottom") ? -r : 0) * k]; });
			if (prevAn && c.length > 1) { const i = c.findIndex(x => x[0] === prevAn); if (i > 0) { const [p] = c.splice(i, 1); c.unshift(p); } }   // 前回の錨を先頭に
			return c;
		}
		return [[L.an || "center", off[0] * size, off[1] * size]];
	}
	// 文字の行の束（折り返し＝text-max-width（em）・"\n"＝改行・字間＝letter-spacing（em）・行の高さ＝line-height（em））。key で覚える（measureText は高い）
	// vert＝縦書き（text-writing-mode vertical・列は右から左・字は上から下・ラテンは 90° 回す）。区間（format）があれば行は run の列（runs）＝区間ごとの書体・大きさ・色
	function textLayout(L, vert = false) {
		if (vert) { if (L.__tlvg === fontGen) return L.__tlv; L.__tlv = textLayout1(L, true); L.__tlvg = fontGen; return L.__tlv; }
		if (L.__tlg === fontGen) return L.__tl;   // ラベルごとの覚え（書体が載ると fontGen が進む）＝衝突判定のたびに書体の文字列と鍵を組まない
		L.__tl = textLayout1(L, false); L.__tlg = fontGen;
		return L.__tl;
	}
	function textLayout1(L, vert) {
		const size = L.size || 12, ls = L.ls || 0, lh = L.lh || 1, mw = L.mw ?? 0;   // layout を持たないラベル（gint・旧い利用者層）＝折り返し無し・行高 1＝従来の箱
		const font = fontOf(L, size), sty = L.sec ? secStyles(L, size) : null;
		const wk = (vert ? "V|" : "") + (sty ? sty.map(q => q.font + "/" + (q.col ? q.col.join(",") : "") + (q.va ? "/" + q.va : "") + (q.img ? "/img:" + q.img : "")).join("\u0002") + "|" + L.sec.map(q => q.t).join("\u0002") : font + "|" + L.text) + "|" + ls + "|" + mw + "|" + lh;
		let tl = widthCache.get(wk);
		if (tl) return tl;
		if (vert || sty) { tl = vert ? vertLayout(L, size, ls, lh, mw, sty || secStyles(L, size)) : runLayout(L, size, ls, lh, mw, sty); widthCache.set(wk, tl); if (widthCache.size > 4096) widthCache.clear(); return tl; }
		setFont(font);
		if (hasLS) ctx.letterSpacing = ls ? `${ls * size}px` : "0px";
		const measure = t => ctx.measureText(t).width;
		const maxPx = mw > 0 ? mw * size : Infinity, lines = [];
		for (const para of String(L.text).split("\n")) {
			if (measure(para) <= maxPx || !para) { lines.push(para); continue; }
			// 折り返し（MapLibre の考え方の近似）：空白で区切れる語は語ごと・区切れない（CJK）は字ごとに詰める。行が maxPx を超える手前で折る
			const units = /\s/.test(para) ? para.split(/(\s+)/).filter(Boolean) : [...para];
			let cur = "";
			for (const u of units) { const t = cur + u; if (cur && measure(t.trimEnd()) > maxPx && !/^\s+$/.test(u)) { lines.push(cur.trimEnd()); cur = u.trimStart(); } else cur = t; }
			if (cur.trim()) lines.push(cur.trimEnd());
		}
		const ws = lines.map(measure), w = Math.max(0, ...ws), h = Math.max(1, lines.length) * lh * size;
		tl = { lines, ws, w, h, size, ls, lh, font };
		widthCache.set(wk, tl);
		if (widthCache.size > 4096) widthCache.clear();   // 念のための上限（テキスト種は高々数千）
		return tl;
	}
	const isWS = t => /^\s+$/.test(t);
	// 区間つきの横書き（format・2026-10-03）＝語（空白で区切れる）／字（CJK）の単位に区間の添字を添えて折り返し、行は run（同じ区間の続き）の列。行の高さ＝line-height×size×行の中で最大の font-scale（MapLibre と同じ）
	function runLayout(L, size, ls, lh, mw, sty) {
		const measure = (t, si) => { setFont(sty[si].font); if (hasLS) ctx.letterSpacing = ls ? `${ls * size * sty[si].fs}px` : "0px"; return ctx.measureText(t).width; };
		const maxPx = mw > 0 ? mw * size : Infinity;
		const paras = [[]];
		// 記号の区間（format の ["image"]・C5）＝1 単位（幅・高さ＝絵の px×size/24×font-scale＝MapLibre の shaping）。記号帳に無い名前＝幅 0（届いたら setImage が組み直す）
		const imgDim = si => { const q = sty[si], im = images.get(q.img); imgSecNames.add(q.img); if (!im) { if (!reported.has(q.img)) missing.add(q.img); return null; } const k = size / 24 * q.fs; return { w: im.bm.width / im.pr * k, h: im.bm.height / im.pr * k }; };
		L.sec.forEach((q, si) => { if (q.img) { paras[paras.length - 1].push({ t: "", si, img: true }); return; } const parts = String(q.t).split("\n"); parts.forEach((p, j) => { if (j) paras.push([]); if (p) paras[paras.length - 1].push({ t: p, si }); }); });
		const runs = [], lhs = [], ws = [];
		const flush = cur => {
			while (cur.length && !cur[cur.length - 1].img && isWS(cur[cur.length - 1].t)) cur.pop();
			while (cur.length && !cur[0].img && isWS(cur[0].t)) cur.shift();
			const rs = [];   // 同じ区間の単位を 1 つの run に（幅は繋いで測り直す＝字間の詰まりを保つ）・記号は 1 単位＝1 run
			for (const u of cur) { const r = rs[rs.length - 1]; if (r && r.si === u.si && !u.img) r.t += u.t; else rs.push({ t: u.t, si: u.si, ...(u.img ? { img: sty[u.si].img, w: u.w, h: u.h } : {}) }); }
			let w = 0, fsMax = 1, hMax = 0;
			for (const r of rs) { if (!r.img) r.w = measure(r.t, r.si); r.font = sty[r.si].font; r.col = sty[r.si].col; r.fs = sty[r.si].fs; r.va = sty[r.si].va; w += r.w; if (r.img) { if (r.h > hMax) hMax = r.h; } else if (r.fs > fsMax) fsMax = r.fs; }
			runs.push(rs); ws.push(w); lhs.push(Math.max(lh * size * fsMax, hMax));
		};
		for (const para of paras) {
			const units = [];
			for (const r of para) { if (r.img) { const d = imgDim(r.si); units.push({ t: "", si: r.si, img: true, w: d ? d.w : 0, h: d ? d.h : 0 }); continue; } const us = /\s/.test(r.t) ? r.t.split(/(\s+)/).filter(Boolean) : [...r.t]; for (const u of us) units.push({ t: u, si: r.si, w: measure(u, r.si) }); }
			let cur = [], curW = 0;
			for (const u of units) { if (cur.length && (u.img || !isWS(u.t)) && curW + u.w > maxPx) { flush(cur); cur = []; curW = 0; } cur.push(u); curW += u.w; }
			flush(cur);
		}
		const w = Math.max(0, ...ws), h = lhs.reduce((a, b) => a + b, 0);
		return { lines: runs.map(rs => rs.map(r => r.t).join("")), ws, w, h, size, ls, lh, font: sty[0].font, runs, lhs };
	}
	// 縦書き（text-writing-mode vertical・2026-10-03）＝列は "\n" と text-max-width（em＝列の長さ）で折り、右から左へ並べる。正立の字は 1 字分（size×fs）を送り、回す字（ラテン・数字）は測った幅＝90° 回して描く。句読点は縦の形。
	// 列の幅＝line-height×size×（列の中で最大の font-scale）。箱＝幅は列の和・高さは最長の列（MapLibre の縦の shaping と同じ）
	function vertLayout(L, size, ls, lh, mw, sty) {
		const chars = []; if (L.sec) L.sec.forEach((q, si) => { for (const ch of q.t) chars.push({ ch, si }); }); else for (const ch of String(L.text)) chars.push({ ch, si: 0 });
		const maxPx = mw > 0 ? mw * size : Infinity;
		const cols = [[]]; let cur = 0;
		for (const c of chars) {
			if (c.ch === "\n") { cols.push([]); cur = 0; continue; }
			const q = sty[c.si], v = verticalize(c.ch), rot = charRotated(c.ch);
			let adv;
			if (rot) { setFont(q.font); if (hasLS) ctx.letterSpacing = "0px"; adv = ctx.measureText(v).width; } else adv = size * q.fs;
			adv += ls * size * q.fs;
			if (cols[cols.length - 1].length && cur + adv > maxPx) { cols.push([]); cur = 0; }
			cols[cols.length - 1].push({ ch: v, rot, adv, font: q.font, col: q.col, fs: q.fs });
			cur += adv;
		}
		for (const c of cols) while (c.length && isWS(c[c.length - 1].ch)) c.pop();
		const cw = cols.map(c => lh * size * Math.max(1, ...c.map(g => g.fs))), hs = cols.map(c => c.reduce((a, g) => a + g.adv, 0));
		const w = cw.reduce((a, b) => a + b, 0), h = Math.max(size, ...hs);
		return { lines: cols.map(c => c.map(g => g.ch).join("")), ws: cw, w, h, size, ls, lh, font: sty[0].font, vcols: cols, vhs: hs, vert: true };
	}
	// 置いたラベル（直近の衝突判定の当選集合）＝{ text, lon, lat, x, y（CSS px・中心）, w, h, size, li（基図の層の添字）, set（利用者層の id） }。
	// 公式例の門 段 0（文字を測る）＝本物の queryRenderedFeatures の symbol と突き合わせる材料。描いた物の申告＝描画は変えない
	// 記号（段 3）＝icon（置いた記号の名前・置けなかった／無い＝null）・ibox＝[中心 x, 中心 y, w, h]。文字を置いていないラベル（記号だけ）は text null・x,y,w,h＝記号の箱
	function placed() {
		const out = [];
		for (const [k, L] of winners) {
			const b = winBox.get(k); if (!b) continue;
			const ibox = b.ib ? [b.sx + b.ib[0] + b.ib[2] / 2, b.sy + b.ib[1] + b.ib[3] / 2, ...(b.ibb ?? [b.ib[2], b.ib[3]])] : b.ln?.icon ? [b.ln.icon.x, b.ln.icon.y, b.ln.icon.bw, b.ln.icon.bh] : null;
			const cx = b.dx + b.tw / 2, cy = b.dy + b.h / 2, bx = b.txt ? [b.sx + (b.T ? b.T.a * cx + b.T.c * cy : cx), b.sy + (b.T ? b.T.b * cx + b.T.d * cy : cy), ...(b.bb ?? [b.tw, b.h])] : ibox;   // w,h＝画面の箱（向きの transform 込み・段 5）・中心も T（向き・大きさの倍率）を通す
			out.push({ text: b.txt ? L.text : null, icon: (b.ib || b.ln?.icon) ? L.icon : null, ibox, line: !!b.ln, lon: L.anchor[0], lat: L.anchor[1], x: bx[0], y: bx[1], w: bx[2], h: bx[3], size: L.size, li: L.li ?? null, set: L.k ?? null, font: b.txt ? (b.tl?.font ?? b.ln?.font ?? null) : null });   // line＝線に沿う注記（x,y＝錨の字の位置・w＝字送りの和）   // x,y＝箱の中心（錨＋dx,dy＋w/2,h/2）・font＝据えた書体（検定）
		}
		return out;
	}

	// 戻り値: フェード継続中か（true なら次フレーム継続）。
	function draw(cam) {
		const dpr = cam.dpr || 1, W = canvas.width, H = canvas.height, Wc = W / dpr, Hc = H / dpr;
		const st = cameraState(cam, W, H);
		const eScale = pitchScale(cam.pitch, cam.zoom);   // 標高→単位球（pitch連動＝renderer elevScaleEff と同式）
		// フォグ終端（renderer の fogFarCap と同式・camDist近似）＝遠景平坦化 df の基準
		const pfFog = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.35) / 0.45));
		const showFlat = (cam.pitch || 0) < 0.06;      // 等高線と同じゲート（pitch 0.06rad で 3D と入れ替わり消える）
		const now = nowMs();
		// フェードは時計で進める（MapLibre と同じ 300ms の線形）＝フレーム率に依らず同じ速さ（旧＝フレームごとに 0.3 ずつ寄せる＝120Hz では倍速）。前の描画から 100ms 超は 100ms として進める（止まっていた間に一気に消えない）
		const step = lastDraw < 0 ? 1 : Math.min(100, now - lastDraw) / fadeMs; lastDraw = now;
		// 動いている間は点の注記を画素に丸めない（旧＝CSS px に丸め＝ゆっくり動かすと 1px ずつ跳ぶ）。止まったら丸める＝文字は常に鮮明
		let still = true; for (let i = 0; i < 16; i++) if (st.mvp[i] !== lastMvp[i]) { still = false; break; } if (!still) lastMvp.set(st.mvp);
		if (showFlat !== lastShowFlat) { dirty = true; lastShowFlat = showFlat; }   // 閾値跨ぎで即再衝突判定→flat を外す/戻す
		const zi = Math.floor(cam.zoom ?? 99); if (zi !== lastZi) { dirty = true; lastZi = zi; }   // 整数 z を跨いだら即再衝突判定＝丸ごとの線（lp 2）の錨を表示 z で置き直す
		const fogF = Math.max(st.camDist * 5.0, 0.026 * pfFog);
		projGen++;   // 折れ線の投影の覚え（lp 2）はこのフレームの間だけ
		if (dirty || now - lastCollide > recollideMs) { collide(st, dpr, Wc, Hc, eScale, showFlat, fogF, cam.zoom ?? 99, cam.bearing || 0); lastCollide = now; dirty = false; }

		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.scale(dpr, dpr);
		ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;
		curFont = "";   // 前のフレームの末尾（星空の注記・標識）が ctx.font を触っている＝覚えを捨てて据え直す

		const fNear = st.camDist * 2, fFar = st.camDist * 9, eye = st.eye;   // 距離フェード（フォグ連動）
		const distOp = (lon, lat) => { const d = distTo(lon, lat, eye); return 1 - Math.min(1, Math.max(0, (d - fNear) / (fFar - fNear))); };

		let animating = false;
		// 描く順＝当選集合（優先順）→ フェードアウト中だけのもの（旧＝毎フレーム両方を Set に広げていた・順は同じ）
		// 描く順＝当選の順（優先順）。symbol-z-order（C5）＝viewport-y（か auto で sort-key が無い）かつ重ねを許す層は、層の中を画面の y で並べ直す（下＝手前が上に描かれる＝MapLibre の sortFeaturesByY）
		let order = [...winners.keys()];
		if (zoAny) {
			const groups = new Map();
			order.forEach((k, i) => { const L = winners.get(k); if (!zoY(L)) return; const g = L.k ?? ("li" + L.li), e = groups.get(g) ?? (groups.set(g, { s: [], it: [] }), groups.get(g)); projectInto(st, L.anchor[0], L.anchor[1], radiusOf(L, eScale, st, fogF), PJ); e.s.push(i); e.it.push([k, PJ[1]]); });
			for (const e of groups.values()) { e.it.sort((a, b) => a[1] - b[1]); e.s.forEach((slot, j) => { order[slot] = e.it[j][0]; }); }
		}
		for (const k of order) drawOne(k);
		for (const k of fades.keys()) if (!winners.has(k)) drawOne(k);
		if (GA_ON) gaBake();
		function drawOne(k) {
			const L = winners.get(k) || labelByKey.get(k) || kidByKey.get(k);   // 子（lp 2 の錨）はフェードアウト中も鍵で引く
			if (!L) { fades.delete(k); return; }
			const target = winners.has(k) ? 1 : 0;
			let op = fades.get(k) ?? 0; op = target ? Math.min(1, op + step) : Math.max(0, op - step);
			if (op === target) { if (!op) { fades.delete(k); if (!winners.has(k) && !labelByKey.has(k) && L.par && L.par.__kids?.list.indexOf(L) < 0) kidByKey.delete(k); return; } } else animating = true;   // 消え終わった古い子（lp 2）は鍵の表から外す
			fades.set(k, op);
			const rad = radiusOf(L, eScale, st, fogF); projectInto(st, L.anchor[0], L.anchor[1], rad, PJ);   // ライブ投影（標高込み）
			const dx = PJ[0], dy = PJ[1], front = PJ[2];
			if (front < 0) return;
			const dop = op * distOp(L.anchor[0], L.anchor[1]), o = dop * (L.op ?? 1);   // dop＝フェード×距離（文字と記号で共有＝lonlatTo3D を 1 回だけ）
			if (o <= 0.01) return;
			const tr = L.tt && !L.lp ? translateOf(L.tt, L.tta, cam.bearing || 0) : TR0;   // text-translate（衝突判定と同じ値）
			const sx = (still ? Math.round(dx / dpr) : dx / dpr) + tr[0], sy = (still ? Math.round(dy / dpr) : dy / dpr) + tr[1];
			const shield = shieldFor && shieldFor(L);
			if (shield) {
				ctx.globalAlpha = o;
				shield.draw(ctx, sx, sy);   // ベクター直描き（DPRスケール済みctx上＝常にシャープ）
				ctx.globalAlpha = 1;
				curFont = "";   // 標識は ctx.font／textAlign を restore の外で触ることがある（空港＝名称）＝覚えを捨てる（旧＝次のラベルが標識の書体で描かれた）
				return;
			}
			const b = winBox.get(k);
			if (L.lp) {   // 線に沿う注記（段 4）＝毎フレーム投影し直して字ごとに回して描く（フェードアウト中も同じ）。裏へ回った・角が急＝描かない
				const ll = lineLayout(L, st, dpr, rad, cam.zoom); if (!ll) return;
				if (ll.icon) {   // 線の記号＝錨で線の向きに回す（viewport なら正立）・SDF は icon-color
					const im = iconImg(L), ic = ll.icon, oi = dop * (L.iop ?? 1);
					if (im && oi > 0.01) { const src = im.sdf ? sdfTint(L.icon, im, css(L.icol || ICOL0), haloOf(L, im)) : im.bm; ctx.save(); ctx.globalAlpha = oi; ctx.translate(ic.x, ic.y); ctx.rotate(ic.a); ctx.drawImage(src, -ic.w / 2, -ic.h / 2, ic.w, ic.h); ctx.restore(); }
				}
				if (!ll.g.length) return;
				const oL = o * flatK(ll.sq); if (oL <= 0.003) return;   // 傾きで潰れた字は薄く（lineFlatPx）
				if (GA_ON) {   // 字の版から貼る（色は版に焼いた不透明の色・フェードは globalAlpha）
					const haloA = L.haloW > 0 ? css(L.halo, 1) : null, fillA = css(L.color, 1), hW = haloA ? L.haloW : 0, blur = haloA && L.blur > 0 ? L.blur : 0;
					const set0 = glyphSet(ll.font, fillA, haloA, hW, blur, dpr);
					ctx.shadowBlur = 0; ctx.globalAlpha = oL;
					for (const c of ll.g) {
						if (!c.ch.trim()) continue;   // 空白は貼らない
						let set = c.f || c.col ? glyphSet(c.f || ll.font, c.col ? css(c.col, 1) : fillA, haloA, hW, blur, dpr) : set0; if (set.epoch !== ga.epoch) set = glyphSet(set.font, set.fill, set.halo, set.haloW, set.blur, dpr);   // 版を捨てた後の組は引き直す
						const sp = glyphSprite(set, c.ch), src = sp.pg.bm && sp.gen <= sp.pg.bmGen ? sp.pg.bm : sp.pg.cv;
						if (c.t) ctx.setTransform(dpr * c.t.a, dpr * c.t.b, dpr * c.t.c, dpr * c.t.d, dpr * c.x, dpr * c.y); else { const cs = Math.cos(c.a) * dpr, sn = Math.sin(c.a) * dpr; ctx.setTransform(cs, sn, -sn, cs, dpr * c.x, dpr * c.y); }
						ctx.drawImage(src, sp.x, sp.y, sp.W, sp.H, sp.ox, sp.oy, sp.w, sp.h);
					}
					ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1;
					return;
				}
				setFont(ll.font); if (hasLS) ctx.letterSpacing = "0px";
				ctx.textAlign = "center"; ctx.textBaseline = "middle";
				if (L.blur > 0) { ctx.shadowColor = css(L.halo, oL); ctx.shadowBlur = L.blur; } else ctx.shadowBlur = 0;
				const halo = L.haloW > 0 ? css(L.halo, oL) : null, fill = css(L.color, oL);
				for (const c of ll.g) {   // 字ごとに錨へ移して回す＝終わりは基底の変換（dpr の拡大）へ据え直す（旧＝save/restore＝字ごとに描画状態を丸ごと積み下ろし）
					ctx.translate(c.x, c.y); if (c.t) ctx.transform(c.t.a, c.t.b, c.t.c, c.t.d, 0, 0); else ctx.rotate(c.a);
					if (c.f) setFont(c.f);   // 区間（format）の書体
					if (halo) { ctx.strokeStyle = halo; ctx.lineWidth = L.haloW * 2; ctx.strokeText(c.ch, 0, 0); }
					ctx.fillStyle = c.col ? css(c.col, oL) : fill; ctx.fillText(c.ch, 0, 0);
					ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				}
				ctx.shadowBlur = 0;
				return;
			}
			// 記号（段 3）＝当選の箱（fit 済み）・フェードアウト中は自然な箱。SDF は icon-color で焼いた写し・icon-rotate は箱の中心で回す・icon-opacity
			const im = iconImg(L), ib = b ? b.ib : (im ? iconBox(L, im) : null);
			if (!b && ib && L.itt) { const itr = translateOf(L.itt, L.itta, cam.bearing || 0); ib[0] += itr[0]; ib[1] += itr[1]; }
			const T0 = textT(L, st, rad, sx, sy, dpr, cam.zoom), T = scaleT(T0, sizeK(L, cam.zoom)), Ti = im ? (iconT(L, st, rad, sx, sy, dpr, cam.zoom) ?? T0) : null;   // 向き（段 5）＝毎フレーム（回転・傾きに追随）・文字は大きさの倍率込み
			if (im && ib) {
				const src = im.sdf ? sdfTint(L.icon, im, css(L.icol || ICOL0), haloOf(L, im)) : im.bm, oi = dop * (L.iop ?? 1);
				if (oi > 0.01) {
					ctx.globalAlpha = oi;
					if (ib.i9) { if (Ti) { ctx.save(); ctx.translate(sx, sy); ctx.transform(Ti.a, Ti.b, Ti.c, Ti.d, 0, 0); drawStretched(ctx, src, ib.i9); ctx.restore(); } else drawStretched(ctx, src, ib.i9, sx, sy); }   // 伸びる記号＝区間ごと（9 分割）
					else if (Ti) { ctx.save(); ctx.translate(sx, sy); ctx.transform(Ti.a, Ti.b, Ti.c, Ti.d, 0, 0); ctx.drawImage(src, ib[0], ib[1], ib[2], ib[3]); ctx.restore(); }   // 錨を原点に transform（map の向き・傾き）
					else if (L.irot) { ctx.save(); ctx.translate(sx + ib[0] + ib[2] / 2, sy + ib[1] + ib[3] / 2); ctx.rotate(L.irot * Math.PI / 180); ctx.drawImage(src, -ib[2] / 2, -ib[3] / 2, ib[2], ib[3]); ctx.restore(); }
					else ctx.drawImage(src, sx + ib[0], sy + ib[1], ib[2], ib[3]);
					ctx.globalAlpha = 1;
				}
			}
			if (!(L.text && String(L.text).length) || (b && !b.txt)) return;   // 文字が無い・置かなかった（text-optional）
			const tl = b?.tl ?? textLayout(L);
			setFont(tl.font || fontOf(L, L.size));   // textLayout が別の書体を据えた後でも、この行の描画は自分の書体で
			if (hasLS) ctx.letterSpacing = tl.ls ? `${tl.ls * tl.size}px` : "0px";
			// 箱の左上＝ライブ投影の錨＋衝突判定の時の相対位置（winBox の dx,dy）。フェードアウト中（当選集合に無い）は最後の箱の位置＝無ければ中央。向きの transform があれば錨を原点に描く（段 5）
			const ox = T ? 0 : sx, oy = T ? 0 : sy;
			if (T) { ctx.save(); ctx.translate(sx, sy); ctx.transform(T.a, T.b, T.c, T.d, 0, 0); }
			const x0 = b ? ox + b.dx : ox - tl.w / 2, y0 = b ? oy + b.dy : oy - tl.h / 2;
			const just = L.just === "auto" ? ((b?.an || L.an || "center").includes("left") ? "left" : (b?.an || L.an || "center").includes("right") ? "right" : "center") : (L.just || "center");
			ctx.textAlign = just === "left" ? "left" : just === "right" ? "right" : "center"; ctx.textBaseline = "middle";
			const ax = just === "left" ? x0 : just === "right" ? x0 + tl.w : x0 + tl.w / 2;
			const halo = L.haloW > 0 || L.blur > 0 ? css(L.halo, o) : null, fill = css(L.color, o);   // 色の文字列は行ごとでなくラベルごとに 1 回
			if (L.blur > 0) { ctx.shadowColor = halo; ctx.shadowBlur = L.blur; } else ctx.shadowBlur = 0;
			if (tl.vcols) {   // 縦書き＝列は右から左・字は上から下（回す字は 90° 回して）
				ctx.textAlign = "center";
				let cx = x0 + tl.w;
				for (let i = 0; i < tl.vcols.length; i++) {
					cx -= tl.ws[i]; const x = cx + tl.ws[i] / 2; let y = y0;
					for (const g of tl.vcols[i]) {
						setFont(g.font); const gy = y + g.adv / 2, f = g.col ? css(g.col, o) : fill;
						if (g.rot) { ctx.translate(x, gy); ctx.rotate(Math.PI / 2); if (L.haloW > 0) { ctx.strokeStyle = halo; ctx.lineWidth = L.haloW * 2; ctx.strokeText(g.ch, 0, 0); } ctx.fillStyle = f; ctx.fillText(g.ch, 0, 0); ctx.rotate(-Math.PI / 2); ctx.translate(-x, -gy); }
						else { if (L.haloW > 0) { ctx.strokeStyle = halo; ctx.lineWidth = L.haloW * 2; ctx.strokeText(g.ch, x, gy); } ctx.fillStyle = f; ctx.fillText(g.ch, x, gy); }
						y += g.adv;
					}
				}
			} else if (tl.runs) {   // 区間つき（format）＝run ごとに書体・色を据えて左から詰める（寄せは行の幅で）
				ctx.textAlign = "left";
				let ly = y0;
				for (let i = 0; i < tl.runs.length; i++) {
					const lhI = tl.lhs[i]; let x = just === "left" ? x0 : just === "right" ? x0 + tl.w - tl.ws[i] : x0 + (tl.w - tl.ws[i]) / 2;
					for (const r of tl.runs[i]) {
						// vertical-align（C5）＝run の高さ（字＝size×font-scale・記号＝絵の高さ）を行の上／中央／下に揃える。無指定＝行の中央（従来）
						const rh = r.img ? r.h : tl.size * r.fs, cy = r.va === "top" ? ly + rh / 2 : r.va === "bottom" ? ly + lhI - rh / 2 : ly + lhI / 2;
						if (r.img) { const im = images.get(r.img); if (im && r.w > 0) { const ga = ctx.globalAlpha; ctx.globalAlpha = o; ctx.drawImage(im.bm, x, cy - r.h / 2, r.w, r.h); ctx.globalAlpha = ga; } x += r.w; continue; }   // 記号の区間（format の image）
						setFont(r.font); if (hasLS) ctx.letterSpacing = tl.ls ? `${tl.ls * tl.size * r.fs}px` : "0px";
						if (L.haloW > 0) { ctx.strokeStyle = halo; ctx.lineWidth = L.haloW * 2; ctx.strokeText(r.t, x, cy); }
						ctx.fillStyle = r.col ? css(r.col, o) : fill; ctx.fillText(r.t, x, cy);
						x += r.w;
					}
					ly += tl.lhs[i];
				}
			} else for (let i = 0; i < tl.lines.length; i++) {
				const ly = y0 + (i + 0.5) * tl.lh * tl.size;
				if (L.haloW > 0) { ctx.strokeStyle = halo; ctx.lineWidth = L.haloW * 2; ctx.strokeText(tl.lines[i], ax, ly); }
				ctx.fillStyle = fill; ctx.fillText(tl.lines[i], ax, ly);
			}
			ctx.shadowBlur = 0;
			if (T) ctx.restore();
		}
		drawSky(st, cam, Wc, Hc, dpr);
		return animating;
	}

	// 星空劇場の注記：GL星空(renderer)と厳密に同じ変換＝GMST回転→mvp×(dir,0)→天球倍率(u_sky同式)のNDCスケール。
	// 出現タイミング・フェードも星座線と同一（z<5・z5→4.5）。地球の背後は unproject（光線が球に当たる＝手前に地球）で遮蔽。
	function drawSky(st, cam, Wc, Hc, dpr) {
		if ((!sky && !moon) || cam.zoom >= 5) return;
		const fade = Math.min(1, (5 - cam.zoom) / 0.5);
		const gmst = gmstAt(clockNow(clock));   // 星（renderer＝gmstAt(clockNow(view.clock))）と同じ時刻・同じ式（旧＝実時刻の近似式＝時計を早送りすると星座名が星からずれた）
		const cg = Math.cos(gmst), sg = Math.sin(gmst);
		const skyK = (0.4 + 0.3 * cam.zoom) / 1.6;
		const m = st.mvp;
		const put = cel => {
			const x = cel[0] * cg + cel[2] * sg, y = cel[1], z = cel[2] * cg - cel[0] * sg;   // 天球→地球固定（STARS_VSと同式）
			const cx = m[0] * x + m[4] * y + m[8] * z, cy = m[1] * x + m[5] * y + m[9] * z, cw = m[3] * x + m[7] * y + m[11] * z;
			if (cw <= 1e-9) return null;   // 背後
			const sx = (cx / cw * skyK * 0.5 + 0.5) * Wc, sy = (1 - (cy / cw * skyK * 0.5 + 0.5)) * Hc;
			if (sx < -30 || sx > Wc + 30 || sy < -30 || sy > Hc + 30) return null;
			if (unproject(st, sx * dpr, sy * dpr)) return null;   // その画素は地球＝星は隠れる
			return [sx, sy];
		};
		// 月の円盤（満ち欠け）：暗い側は赤黒（地球照の佇まい）、輝面は暖白。輝面比 k と太陽の画面方位から
		// 半円＋半楕円（x方向スケール 2k-1＝符号で三日月/十三夜を自動で描き分け）の古典構成。
		if (moon) {
			const p = put(moon.cel);
			if (p) {
				// 太陽の画面方位：月の天球位置から太陽へ接線方向に一歩進めて再投影（w=0方向の射影は対蹠と縮退するため差分で取る）
				const mc = moon.cel, sc = moon.sunCel, dm = mc[0] * sc[0] + mc[1] * sc[1] + mc[2] * sc[2];
				let tx = sc[0] - mc[0] * dm, ty = sc[1] - mc[1] * dm, tz = sc[2] - mc[2] * dm;
				const tl = Math.hypot(tx, ty, tz) || 1;
				const p2 = put([mc[0] + tx / tl * 0.02, mc[1] + ty / tl * 0.02, mc[2] + tz / tl * 0.02]);
				const th = p2 ? Math.atan2(p2[1] - p[1], p2[0] - p[0]) : 0;
				const R = 8, k = Math.max(0, Math.min(1, moon.k));
				ctx.save();
				ctx.translate(p[0], p[1]); ctx.rotate(th);   // +x＝太陽方向
				ctx.globalAlpha = fade;
				ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
				ctx.fillStyle = "rgb(72,22,15)"; ctx.fill();                     // 欠けている側＝赤黒
				ctx.beginPath();
				ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2);                     // 太陽側の半円
				ctx.scale(Math.max(1e-3, Math.abs(2 * k - 1)) * Math.sign(2 * k - 1 || 1), 1);
				ctx.arc(0, 0, R, Math.PI / 2, Math.PI * 1.5);                    // 終端線＝半楕円（負スケール＝三日月側へ折り返し）
				ctx.fillStyle = "rgb(250,246,232)"; ctx.fill();                  // 輝面＝暖白
				ctx.globalAlpha = 1;
				ctx.restore();
			}
		}
		if (!sky) return;
		if (sky.constellations) {
			ctx.font = `11px ${FONT_STACK}`;
			ctx.fillStyle = `rgba(160,200,255,${0.65 * fade})`;   // v1 border.js と同色
			for (const L of sky.constellations) { const p = put(L.cel); if (p) ctx.fillText(L.name, p[0], p[1]); }
		}
		if (sky.planets) {
			ctx.font = `10px ${FONT_STACK}`;
			ctx.fillStyle = `rgba(255,235,200,${0.85 * fade})`;   // 惑星名＝暖色の白（点の少し下に添える）
			for (const L of sky.planets) { const p = put(L.cel); if (p) ctx.fillText(L.name, p[0], p[1] + 11); }
		}
		if (sky.messier) {
			// v1 の記号語彙：gc=球状星団 銀河=楕円 oc=散開星団 他=矩形。銀河は d3-celestial の種別で s/e/i（渦巻・楕円・不規則）
			// で来る＝旧版は gx/gg だけを見ていて銀河が全部矩形になっていた（2026-09-19・packages/space README と solar の messierKind と同じ読み）
			const sz = 5, P2 = Math.PI * 2;
			ctx.lineWidth = 0.8;
			ctx.strokeStyle = `rgba(255,200,100,${0.75 * fade})`;
			ctx.font = `8px ${FONT_STACK}`;
			for (const Mo of sky.messier) {
				const p = put(Mo.cel); if (!p) continue;
				const [px, py] = p;
				ctx.beginPath();
				if (Mo.type === "gc") {
					ctx.arc(px, py, sz, 0, P2);
					ctx.moveTo(px - sz, py); ctx.lineTo(px + sz, py);
					ctx.moveTo(px, py - sz); ctx.lineTo(px, py + sz);
					ctx.stroke();
				} else if (GALAXY.has(Mo.type)) {
					ctx.ellipse(px, py, sz * 1.5, sz * 0.6, 0.4, 0, P2); ctx.stroke();
				} else if (Mo.type === "oc") {
					ctx.setLineDash([2, 2]); ctx.arc(px, py, sz, 0, P2); ctx.stroke(); ctx.setLineDash([]);
				} else {
					ctx.rect(px - sz, py - sz, sz * 2, sz * 2); ctx.stroke();
				}
				ctx.fillStyle = `rgba(255,220,150,${0.65 * fade})`;
				ctx.fillText(Mo.name, px, py + sz + 6);
			}
		}
	}

	function placedDebug() { return dbg; }
	function clearFontCache() { widthCache.clear(); advCache.clear(); fontGen++; curFont = ""; dirty = true; if (ga.ss) gaReset(ga.ss); }   // 書体が載った（addFontFace）＝幅の覚え（行の束・線の字送り）を捨てて衝突判定からやり直す（旧＝字送りの覚えが代替書体の幅のまま残った）
	return { setLabels, setUserLabels, setUserVisible, setElev, setSky, setClip, setMoon, setClock, setImage, removeImage, takeMissing, draw, clear, placed, placedDebug, clearFontCache };
}
