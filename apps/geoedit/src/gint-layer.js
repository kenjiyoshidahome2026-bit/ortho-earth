// 確定層＝gint 現行6ハンドル（applyGintData/paintTable…）の封じ込め（gint draw spec.md §10.2）。
// v2 の map.addGint() が来たら差し替えるのはこのファイルだけ、が設計契約。
//
// コミット＝model.toGeoJSON({eid:true}) → geopbf(fc,{gint:true}) → applyGintData。__eid が全フィーチャで
// 一意＝topology() の propTub 併合が起きない＝fid はコミットfcの並び（eid昇順）と1:1。
// スタイル＝@fill/@stroke/@width をコミット時に fid→RGBA32UI 表へ焼く（前処理で吸収＝エンジン改修ゼロ）。
// 表レコード（ortho-core style.js §7.1）: R=fill RGBA8 / G=line・circle色 / B=width(1/8px)<<24|dash<<16|radius(1/4px)<<8|flags / flags bit0=visible
import { geopbf } from "geopbf";

// #rgb / #rrggbb / #rrggbbaa → u32(r<<24|g<<16|b<<8|a)。それ以外は null（既定色へ）
export function hexColor(s) {
	if (typeof s !== "string") return null;
	const m = s.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
	if (!m) return null;
	let h = m[1];
	if (h.length === 3) h = [...h].map(c => c + c).join("") + "ff";
	if (h.length === 6) h += "ff";
	return parseInt(h, 16) >>> 0;
}
// CSS色全般（色名 red / rgb() / hsl() …）→ u32。ブラウザのfillStyle正規化に委譲＝手書き色名表を持たない。
// 「#hexしか効かない＝redと書くと黙って既定色」の罠対策（本人報告 8/20）。不正値は null（既定色へ）。
let colCtx = null;
export function cssColor(s) {
	const hx = hexColor(s);
	if (hx != null) return hx;
	if (typeof s !== "string" || !s.trim()) return null;
	colCtx ??= document.createElement("canvas").getContext("2d");
	colCtx.fillStyle = "#010203";               // 番兵：不正値は代入が無視される＝これが残ったら不正
	colCtx.fillStyle = s;
	const v = colCtx.fillStyle;
	if (v === "#010203" && s.trim() !== "#010203") return null;
	if (v.startsWith("#")) return hexColor(v);   // 正規化結果は "#rrggbb" か "rgba(r, g, b, a)"
	const m = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
	if (!m) return null;
	const a = m[4] === undefined ? 255 : Math.round(+m[4] * 255);
	return ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | a) >>> 0;
}

export const DEF = {   // styleform（素人向けUI）が初期値表示に使う＝ここが唯一の既定値台帳
	fill: 0x78aadd40,    // 半透明の青灰（編集対象が下図を殺さない）
	stroke: 0x2b5f8fe0,  // 実線
	widthPx: 1.5,
	radiusPx: 5,         // gint circle はシンボルオーバレイのフォールバック
};

export function buildStyleTable(features) {   // features＝コミットfcの並び（=fid順）
	const n = features.length, u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) {
		const p = features[i].properties || {};
		const fill = cssColor(p["@fill"]) ?? DEF.fill;
		const stroke = cssColor(p["@stroke"]) ?? DEF.stroke;
		const w = Math.max(1, Math.min(255, Math.round((+p["@width"] > 0 ? +p["@width"] : DEF.widthPx) * 8)));
		const r = Math.max(1, Math.min(255, Math.round(DEF.radiusPx * 4)));
		u32[i * 4] = fill;
		u32[i * 4 + 1] = stroke;
		u32[i * 4 + 2] = (w << 24) | (r << 8) | 1;
	}
	return u32;
}

export function createGintLayer(map) {
	let pbf = null;              // 現在コミット済みの geopbf（identify の真実源）
	let fidEid = [];             // fid → eid
	let eidFid = new Map();      // eid → fid
	let baseTable = null;        // @スタイル込みの素の表
	let hidden = new Set();      // 編集中に隠す eid 群
	let gen = 0;                 // コミット世代（後勝ち）

	const push = () => {
		if (!baseTable) return;
		let t = baseTable;
		if (hidden.size) {
			t = baseTable.slice();
			for (const eid of hidden) { const f = eidFid.get(eid); if (f !== undefined) t[f * 4 + 2] &= ~1; }   // visible bit を落とす
		}
		map.paintTable(t, fidEid.length);
	};

	return {
		get pbf() { return pbf; },
		eidOf: fid => fidEid[fid],
		async commit(model, { moveCamera = false } = {}) {
			const g = ++gen;
			const fc = model.toGeoJSON({ eid: true });
			if (!fc.features.length) { pbf = null; baseTable = null; fidEid = []; eidFid = new Map(); return null; }
			const built = await geopbf(fc, { name: "geoedit/session" });
			if (!built) return null;
			await built.gint();           // オブジェクト入力は gint 自動ベイクされない＝明示（worker/WASM、なければJS）
			if (g !== gen) return null;   // 後発コミットに追い抜かれた＝破棄
			pbf = built;
			fidEid = fc.features.map(f => f.properties.__eid);
			eidFid = new Map(fidEid.map((e, i) => [e, i]));
			map.applyGintData(pbf, "geoedit", moveCamera, { interactive: true, hover: false, minZoom: 2 });
			baseTable = buildStyleTable(fc.features);
			push();
			return pbf;
		},
		// クリック座標（経緯度）→ eid。gint識別（点→線→面優先・smallest-wins）。
		// 許容量はメートル固定でなく**画面ピクセル基準**（点12px・線8px）をズームからmへ換算＝
		// 浅いズームで「見えているのにクリックできない」を防ぐ（identifyAt既定の50m/30mは深ズーム前提）。
		identify(lng, lat, zoom = 14) {
			const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, zoom));   // Webメルカトル近似のm/px＝許容量換算用
			const fid = pbf?.identifyAt?.(lng, lat, { point: Math.max(50, 12 * mpp), polyline: Math.max(30, 8 * mpp) });
			return fid == null || fid < 0 ? null : fidEid[fid] ?? null;
		},
		hide(eids) { hidden = new Set(eids); push(); },
		unhide() { if (hidden.size) { hidden = new Set(); push(); } },
		restyle() { push(); },   // 表の再送（スロット切替で剥がれた疑いがある時の再点火にも）
		exportPbf(model) {   // エクスポート用＝__eid 無しの素の fc から新規エンコード（precision=格子段）
			return geopbf(model.toGeoJSON(), { name: "geoedit-export", precision: model.gridExp, gint: false });
		},
	};
}
