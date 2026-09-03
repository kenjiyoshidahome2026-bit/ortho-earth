// 確定層＝gint 現行6ハンドル（applyGintData/paintTable…）の封じ込め（gint draw spec.md §10.2）。
// v2 の map.addGint() が来たら差し替えるのはこのファイルだけ、が設計契約。
//
// コミット＝model.toGeoJSON({eid:true}) → geopbf(fc,{gint:true}) → applyGintData。__eid が全フィーチャで
// 一意＝topology() の propTub 併合が起きない＝fid はコミットfcの並び（eid昇順）と1:1。
// スタイル＝@fill/@stroke/@width をコミット時に fid→RGBA32UI 表へ焼く（前処理で吸収＝エンジン改修ゼロ）。
// 表レコード（ortho-core style.js §7.1）: R=fill RGBA8 / G=line・circle色 / B=width(1/8px)<<24|dash<<16|radius(1/4px)<<8|flags / flags bit0=visible
import { geopbf } from "geopbf";                      // side-effect込み＝GeoPBF.prototype に gint()/identifyAt/*File が載る
import { GeoPBF, makeKeys } from "geopbf/pbf-base";   // ストリームエンコード用（set() を自前でなぞる）
import { stitchGeometry, smoothGeom } from "geopbf/edit/model";

// #rgb / #rgba / #rrggbb / #rrggbbaa → u32(r<<24|g<<16|b<<8|a)。それ以外は null（既定色へ）
export function hexColor(s) {
	if (typeof s !== "string") return null;
	const m = s.trim().match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
	if (!m) return null;
	let h = m[1];
	if (h.length <= 4) h = [...h].map(c => c + c).join("");   // 短縮形＝各桁を倍に（#rgb→rrggbb・#rgba→rrggbbaa）
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

export function buildStyleTable(featsArr, { forceVisible = false } = {}) {   // featsArr＝fid順の feature 参照列（type と properties を見る）
	const n = featsArr.length, u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) {
		const f = featsArr[i], p = f?.properties || {};
		const fill = cssColor(p["@fill"]) ?? DEF.fill;
		const stroke = cssColor(p["@stroke"]) ?? DEF.stroke;
		const w = Math.max(1, Math.min(255, Math.round((+p["@width"] > 0 ? +p["@width"] : DEF.widthPx) * 8)));
		const r = Math.max(1, Math.min(255, Math.round(DEF.radiusPx * 4)));
		// 点＝overlayのシンボルが唯一の描画。@blur＝overlay(canvas2D)のぼかし塗り（stroke無し）。
		// @poly＝ポリゴン化した線（帯＝塗り+輪郭+端形状）＝overlay(canvas2D)が描く。
		// いずれも gint は描かない（visible bit を落とす）。識別は幾何ベースで生きる。
		// forceVisible＝大規模モード（オーバレイ無し＝gint が唯一の描画）は全て点灯。
		const isPoint = f?.type === "Point" || f?.type === "MultiPoint";
		const blurred = +p["@blur"] > 0;
		const banded = !!p["@poly"] && (f?.type === "LineString" || f?.type === "MultiLineString");   // 端形状=@start/@end（旧@cap0/1）
		u32[i * 4] = fill;
		u32[i * 4 + 1] = stroke;
		u32[i * 4 + 2] = (w << 24) | (r << 8) | ((!forceVisible && (isPoint || blurred || banded)) ? 0 : 1);
	}
	return u32;
}

// モデル→GeoPBF の直列エンコード（GeoJSON FC を一度も作らない＝8/20「根性で全部」）。
// set() と同じ手順（makeKeys→setHead→setBody→close→getPosition）を、setBody の**関数渡し**で
// 1フィーチャずつ縫合→書き込み→即GC。setFeature は q.geometry へ書き戻す（strictでgetter即死）ため
// 遅延オブジェクトではなく都度生成の素のオブジェクトを渡す。
// smooth＝表示用の焼き（gint）だけ true＝@spline を密点に細分。保存/書き出しは false＝制御点のまま（＋@splineフラグ）
// ＝再読込のたびに再細分する多重化を防ぐ（曲線は制御点からの描画時解釈に一本化）。
export async function encodeModel(model, { withEid = false, name = "geoedit", precision, smooth = false } = {}) {
	const eids = [...model.feats.keys()].sort((a, b) => a - b);
	const propsArr = eids.map(e => withEid ? { ...model.feats.get(e).properties, __eid: e } : model.feats.get(e).properties);
	const pbf = new GeoPBF({ name, precision: precision ?? model.gridExp });
	const [keys, bufs] = await makeKeys(propsArr);
	pbf.setHead(keys, bufs).setBody(() => {
		for (let i = 0; i < eids.length; i++) {
			let geometry = stitchGeometry(model.arcs, model.feats.get(eids[i]));
			if (smooth && propsArr[i] && propsArr[i]["@spline"]) geometry = smoothGeom(geometry);   // 表示用のみ曲線化（保存は制御点維持）
			pbf.setFeature({ type: "Feature", geometry, properties: propsArr[i] });
		}
	}).close();
	await pbf.getPosition();
	return { pbf, eids };
}

export function createGintLayer(map) {
	let pbf = null;              // 現在コミット済みの geopbf（identify の真実源）
	let fidEid = [];             // fid → eid
	let eidFid = new Map();      // eid → fid
	let baseTable = null;        // @スタイル込みの素の表
	let hidden = new Set();      // 編集中に隠す eid 群
	let gen = 0;                 // コミット世代（後勝ち）
	let large = false;           // 大規模モード（点/blur/帯も gint が描く＝styleTable 全点灯）
	let focusEids = null;        // 大規模モードの編集近傍（選択+arc共有隣接）＝gint消灯・オーバレイが正確に描く

	const push = () => {
		if (!baseTable) return;
		let t = baseTable;
		const mut = () => (t === baseTable ? (t = baseTable.slice()) : t);
		if (hidden.size) {
			mut();
			for (const eid of hidden) { const f = eidFid.get(eid); if (f !== undefined) t[f * 4 + 2] &= ~1; }   // visible bit を落とす
		}
		if (focusEids?.size) {   // 編集近傍＝gint（LODキャップ/間引きの簡略線）を消してオーバレイの正確な線に一本化
			mut();
			for (const eid of focusEids) { const f = eidFid.get(eid); if (f !== undefined) t[f * 4 + 2] &= ~1; }
		}
		map.paintTable(t, fidEid.length);
	};

	let saveBuf = null;          // セッション保存用バッファ＝常に制御点のまま（@spline は表示焼きだけ細分＝再読込の多重細分を封じる）
	const largeOpts = () => {
		const st = new Float32Array(256 * 4);
		st.set([0x78 / 255, 0xaa / 255, 0xdd / 255, 0.30]);        // style0: ポリゴン（低ズーム単色塗り＝DEF.fill 系）
		st.set([0x2b / 255, 0x5f / 255, 0x8f / 255, 0.88], 4);     // style1: 線（per-fid paint が主役＝これは保険）
		return { interactive: true, hover: false, minZoom: 2, lowFill: true, style: { styleTable: st } };
	};
	return {
		get pbf() { return pbf; },
		get saveBuffer() { return saveBuf; },
		eidOf: fid => fidEid[fid],
		async commit(model, { moveCamera = false } = {}) {
			const g = ++gen;
			large = false; focusEids = null;   // 通常コミット＝大規模モードの終了（全消去→新規セッション等）
			if (!model.feats.size) {
				// 空＝前の表示を消灯してから手放す（applyGintData は空データを受けない＝可視bitを落として封じる）
				if (baseTable && fidEid.length) { const t = baseTable.slice(); for (let i = 0; i < fidEid.length; i++) t[i * 4 + 2] &= ~1; map.paintTable(t, fidEid.length); }
				pbf = null; saveBuf = null; baseTable = null; fidEid = []; eidFid = new Map(); hidden = new Set();
				return null;
			}
			const hasSpline = [...model.feats.values()].some(f => f.properties?.["@spline"]);
			const { pbf: built, eids } = await encodeModel(model, { withEid: true, name: "geoedit/session", smooth: true });   // __eid一意＝propTub併合の無害化（fid=並び順）。表示用＝@splineは細分
			await built.gint();           // gint は明示ベイク（worker/WASM、なければJS）
			if (g !== gen) return null;   // 後発コミットに追い抜かれた＝破棄
			pbf = built;
			// 保存用＝制御点のまま。@spline が無ければ表示用と同一＝再エンコードしない
			saveBuf = hasSpline ? (await encodeModel(model, { withEid: true, name: "geoedit/session" })).pbf.arrayBuffer : built.arrayBuffer;
			if (g !== gen) return null;
			fidEid = eids;
			eidFid = new Map(eids.map((e, i) => [e, i]));
			map.applyGintData(pbf, "geoedit", moveCamera, { interactive: true, hover: false, minZoom: 2 });
			baseTable = buildStyleTable(eids.map(e => model.feats.get(e)));
			push();
			return pbf;
		},
		// 大規模モードの点火（Phase1取込ルーター 8/25）：位相抽出せず geopbf を真実源のまま
		// gint(WASM) 焼き→GPU直行＝ビューアと同じ経路。fid=eid 恒等・スタイルは表で全点灯。
		// lowFill＝fillOff級でも低ズーム帯（z<outlineZoom）の単色ベタ塗りは生かす（間引き表示にfill＝本人裁定 8/25）。
		// style0＝その単色塗りの色（無指定はエンジン既定のオレンジ＝14条筆系統）＝geoedit の青灰 DEF.fill に合わせる。
		async applyLarge(built, featsArr, { moveCamera = true } = {}) {
			const g = ++gen;
			await built.gint();   // WASM worker焼き（topology_full＝ZCTA級実証済）。焼き済みなら即返る
			if (g !== gen) return null;
			pbf = built; saveBuf = null;   // 自動保存なし（セッションはPhase4＝base丸ごとIDB＋ジャーナル）
			large = true; hidden = new Set();
			fidEid = featsArr.map(f => f.fid);
			eidFid = new Map(fidEid.map((e, i) => [e, i]));
			map.applyGintData(pbf, "geoedit", moveCamera, largeOpts());
			baseTable = buildStyleTable(featsArr, { forceVisible: true });
			push();
			return pbf;
		},
		// g再送（Phase2 ジオメトリ編集のコミット）：in-place 変異済みの unPackGint typed array を
		// そのまま bake worker へ再送＝GPU束の再焼き。onReady＝焼き上がって表示束が差し替わった瞬間
		//（それまで旧座標の絵が出ている＝隠し解除はこの後＝小規模コミットの「着地で引き継ぐ」と同じ規約）。
		async resendLarge(model) {
			if (!large || !pbf) return null;
			const g = ++gen;
			model.refreshDirty();   // arcMeta/fid別bbox の部分再計算（identifyAt の正気）
			await new Promise(res => {
				const t = setTimeout(res, 15000);   // 焼きが差し替えで捨てられた等＝保険（genガードが後始末）
				map.applyGintData(pbf, "geoedit", false, { ...largeOpts(), onReady: () => { clearTimeout(t); res(); } });
			});
			if (g !== gen) return null;
			push();   // paintTable 再送（applyUserSlot 後の着色を確実に）
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
		focus(eids) { focusEids = eids && eids.size ? new Set(eids) : null; if (large) push(); },   // 大規模モードの編集近傍消灯（null=解除）
		unhide() { if (hidden.size) { hidden = new Set(); push(); } },
		restyleProps(model) {   // @スタイルだけ即時再焼き（再コミット不要＝色変更のワンテンポ遅れの根治）
			if (!fidEid.length) return;
			baseTable = buildStyleTable(fidEid.map(e => model.feats.get(e)), { forceVisible: large });
			push();
		},
		restyle() { push(); },   // 表の再送（スロット切替で剥がれた疑いがある時の再点火にも）
		async exportPbf(model) {   // エクスポート用＝__eid 無しの直列エンコード（precision=格子段・FCなし）
			const { pbf: out } = await encodeModel(model, { withEid: false, name: "geoedit-export", precision: model.gridExp });
			return out;
		},
	};
}
