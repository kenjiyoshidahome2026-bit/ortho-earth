// 道路標識のベクター描画。ラベルcanvas（DPRスケール済み）へ viewBox 座標で直接描く＝
// 焼き付け画像を挟まず常にシャープ。国道おにぎり／高速ナンバリング盾。番号ごとにキャッシュ。

// 国道おにぎり標識：番号(2901)は素の数字でなく本物の標識で描く。
const SHIELD_H = 20, SHIELD_VW = 455, SHIELD_VH = 435, SHIELD_W = Math.round(SHIELD_H * SHIELD_VW / SHIELD_VH);
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
		g.font = `bold ${num.length >= 3 ? 135 : 150}px sans-serif`;   // 国道/ROUTEの小字は省き番号だけ大きく（2桁以下は少し控えめ）
		g.fillText(num, 238, 200);
		g.restore();
	} };
	shieldCache.set(num, s);
	return s;
}
// 高速道路ナンバリング（E1・E1A・E88・C4・CA…）：緑の角丸長方形＋白フチ＋白文字。実標識に準拠。
const EXP_H = 18, EXP_VW = 220, EXP_VH = 150, EXP_W = Math.round(EXP_H * EXP_VW / EXP_VH);
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
		g.font = `bold ${text.length >= 3 ? 66 : 78}px sans-serif`;   // 2文字以下は少し控えめ
		g.fillText(text, EXP_VW / 2, EXP_VH / 2 + 4);
		g.restore();
	} };
	expCache.set(text, s);
	return s;
}
// 測量点：地形図の作法どおり地物別の記号＋標高値。公式コード表（optbv_featurecodes）に厳密準拠：
// 7102=三角点△ / 7201・7221=標高点・ / 7103=水準点◎ / 7101=電子基準点◇。色は等高線と同じ茶(セピア)。
const SURVEY_COLOR = "#6b4d2e";
const surveyCache = new Map();
function surveySymbol(code, num) {
	const key = code + ":" + num;
	let s = surveyCache.get(key); if (s) return s;
	const R = 5;                                  // 記号の半径(px)
	s = { w: R * 2 + num.length * 5 + 4, h: R * 2, draw(g, cx, cy) {
		g.save();
		g.strokeStyle = SURVEY_COLOR; g.fillStyle = SURVEY_COLOR; g.lineWidth = 1.1; g.lineJoin = "round";
		if (code === 7102) {                       // 三角点＝△（正三角形の輪郭）＋中心に点＝正確な位置。実物も中心に点石が埋まる＝国家の礎
			g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx + R * 0.87, cy + R * 0.5); g.lineTo(cx - R * 0.87, cy + R * 0.5); g.closePath(); g.stroke();
			g.beginPath(); g.arc(cx, cy, 1.6, 0, 6.2832); g.fill();   // 中心の点（標高点・と同じ）
		} else if (code === 7103) {                // 水準点＝◎（二重丸）
			g.beginPath(); g.arc(cx, cy, R, 0, 6.2832); g.stroke();
			g.beginPath(); g.arc(cx, cy, R * 0.4, 0, 6.2832); g.fill();
		} else if (code === 7101) {                // 電子基準点＝◇（菱形の輪郭）
			g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx + R, cy); g.lineTo(cx, cy + R); g.lineTo(cx - R, cy); g.closePath(); g.stroke();
		} else {                                   // 標高点(7201/7221)＝・（小さい点）
			g.beginPath(); g.arc(cx, cy, 1.7, 0, 6.2832); g.fill();
		}
		g.font = "bold 8px sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";   // 標高値は記号の右に小さく
		g.fillText(num, cx + R + 2, cy);
		g.restore();
	} };
	surveyCache.set(key, s); return s;
}
// 空港（441・鉄道チップに相乗り＝交通ハブ）：飛行機シルエット＋名称。記号は落ち着いた青、名称は通常ラベルと同トーン。
// Material Icons "flight" のパス（viewBox 24）＝上向きの飛行機。
const PLANE_PATH = new Path2D("M21.5 15.5v-2l-8-5v-5.5c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v5.5l-8 5v2l8-2.5v5.5l-2 1.5v1.5l3.5-1 3.5 1v-1.5l-2-1.5v-5.5l8 2.5z");
const PLANE_S = 13;                             // 記号サイズ(px)
const airportCache = new Map();
function airportSymbol(text, markOnly) {
	const key = (markOnly ? "#" : "") + text;    // markOnly=マークのみ（低ズームの静的台帳。名称はタイル注記が出るz11+から）
	let s = airportCache.get(key); if (s) return s;
	const tw = markOnly ? 0 : 3 + text.length * 10;   // 名称の概算幅（10px 和文）
	s = { w: PLANE_S + tw, h: PLANE_S, draw(g, cx, cy) {
		const x0 = cx - s.w / 2;                 // 記号+名称ブロック全体をアンカー中心に
		g.save();
		g.translate(x0, cy - PLANE_S / 2); g.scale(PLANE_S / 24, PLANE_S / 24);
		g.lineJoin = "round"; g.strokeStyle = "#f6f6f4"; g.lineWidth = 3.5; g.stroke(PLANE_PATH);   // 地色ハロー
		g.fillStyle = "#3f6d9e"; g.fill(PLANE_PATH);
		g.restore();
		if (markOnly) return;
		g.font = "10px sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
		g.strokeStyle = "#f6f6f4"; g.lineWidth = 2.2; g.lineJoin = "round"; g.strokeText(text, x0 + PLANE_S + 3, cy);
		g.fillStyle = "#6b6c66"; g.fillText(text, x0 + PLANE_S + 3, cy);
	} };
	airportCache.set(key, s); return s;
}
export function shieldFor(L) {   // 道路ON時のみ抽出済み。2901=国道おにぎり／2903・2904=高速ナンバリング盾
	if (L.code === 2901) return kokudoShield(L.text);
	if (L.code === 2903 || L.code === 2904) return expresswayShield(L.text);
	if (L.code === 7102 || L.code === 7201 || L.code === 7221) return surveySymbol(L.code, L.text);   // 測量点（三角点△/標高点・/火山標高）。水準点7103・電子基準点7101は膨大でクラッタ＝出さない
	if (L.code === 441 && /(空港|飛行場)$/.test(L.text || "")) return airportSymbol(L.text, !!L.markOnly);   // 空港＝✈＋名称（ターミナル名等は通常テキストのまま）
	return null;
}
