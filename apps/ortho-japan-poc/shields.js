// 道路標識のベクター描画。ラベルcanvas（DPRスケール済み）へ viewBox 座標で直接描く＝
// 焼き付け画像を挟まず常にシャープ。国道おにぎり／高速ナンバリング盾。番号ごとにキャッシュ。

// 国道おにぎり標識：番号(2901)は素の数字でなく本物の標識で描く。
const SHIELD_H = 24, SHIELD_VW = 455, SHIELD_VH = 435, SHIELD_W = Math.round(SHIELD_H * SHIELD_VW / SHIELD_VH);
const SHIELD_PATH = new Path2D("m227 425c25 0 48-10 66-26 69-69 120-155 146-249 3-8 5-19 5-30 0-45-31-83-74-94-46-11-92-17-143-17s-97 6-143 17c-43 11-74 49-74 94 0 11 2 21 5 30 26 94 77 180 146 249 18 16 41 26 66 26z");
const shieldCache = new Map();
function kokudoShield(num) {
	let s = shieldCache.get(num);
	if (s) return s;
	s = { w: SHIELD_W, h: SHIELD_H, draw(g, cx, cy) {
		g.save();
		g.translate(cx - SHIELD_W / 2, cy - SHIELD_H / 2); g.scale(SHIELD_W / SHIELD_VW, SHIELD_H / SHIELD_VH);
		g.fillStyle = "#0140ff"; g.fill(SHIELD_PATH);
		g.lineJoin = "round"; g.strokeStyle = "#fff"; g.lineWidth = 16; g.stroke(SHIELD_PATH);
		g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
		g.font = `bold ${num.length >= 3 ? 135 : 170}px sans-serif`;   // 国道/ROUTEの小字は省き番号だけ大きく
		g.fillText(num, 238, 200);
		g.restore();
	} };
	shieldCache.set(num, s);
	return s;
}
// 高速道路ナンバリング（E1・E1A・E88・C4・CA…）：緑の角丸長方形＋白フチ＋白文字。実標識に準拠。
const EXP_H = 22, EXP_VW = 220, EXP_VH = 150, EXP_W = Math.round(EXP_H * EXP_VW / EXP_VH);
const expCache = new Map();
function expresswayShield(text) {
	let s = expCache.get(text);
	if (s) return s;
	s = { w: EXP_W, h: EXP_H, draw(g, cx, cy) {
		g.save();
		g.translate(cx - EXP_W / 2, cy - EXP_H / 2); g.scale(EXP_W / EXP_VW, EXP_H / EXP_VH);
		g.beginPath(); g.roundRect(4, 4, EXP_VW - 8, EXP_VH - 8, 30); g.fillStyle = "#0a7a3e"; g.fill();   // 緑の角丸
		g.beginPath(); g.roundRect(17, 17, EXP_VW - 34, EXP_VH - 34, 18); g.lineWidth = 10; g.strokeStyle = "#fff"; g.stroke();   // 白フチ
		g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
		g.font = `bold ${text.length >= 3 ? 66 : 86}px sans-serif`;
		g.fillText(text, EXP_VW / 2, EXP_VH / 2 + 4);
		g.restore();
	} };
	expCache.set(text, s);
	return s;
}
export function shieldFor(L) {   // 道路ON時のみ抽出済み。2901=国道おにぎり／2903・2904=高速ナンバリング盾
	if (L.code === 2901) return kokudoShield(L.text);
	if (L.code === 2903 || L.code === 2904) return expresswayShield(L.text);
	return null;
}
