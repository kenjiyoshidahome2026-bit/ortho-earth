// ガジェット：注釈レイヤ（geoedit の @スタイル付き geopbf を canvas2D で再生）。
// 「エディタで作った表現がビューアで同じ動きで再生される」を**実装の共有**で担保する正典＝
// 図形/帯/曲線のプリミティブ（PICTO/SHAPE_SCALE/smoothRing/buildLinePath/makeTracer）は anno-draw.js が正本で、
// ここが再輸出し、geoedit（overlay/model/styleform）はここから import する（pop/tip ガジェット共有と同じ型）。
// 描画は全て canvas2D（地形ドレープなし＝本人裁定・注釈スケールなら十分軽い）。gint は使わない＝
// fid⇄feature の propTub 併合問題も styleTable も無縁。識別は pbf.identifyAt（JS幾何・描画レス）。
// 対応 @属性：@shape(@fill/@stroke/@size・pin=3Dピン)/@icon(画像・中央クロップ)/@text/@width/
//             @spline(曲線)/@blur(ぼかし面・線なし)/@poly+@start/@end(帯+端形状)/@tip(ホバー)/@pop(クリック吹き出し)
//
// 描く場所（2026-09-20・#13）＝レンダーワーカー内の同一フレームのオーバーレイ（map.overlay → anno-draw.js）。
// main の onFrame で自前 canvas に描いていた頃は地球より 1〜2 フレーム先行し、3D ピンの接地標高も非同期メモ（届くまで 0m）だった。
// いまは地球・注記と同じ rAF・同じ cam で描き、標高は worker の terrain から同期で引く。main に残るのは
// geopbf の積み込み（@spline の細分）・識別（tip/pop）・DOM。シンボルの画面矩形（hover/click 用）は worker から毎フレーム届く。
import { sanitizeHTML } from "geopbf/sanitize";
export { sanitizeHTML };   // @tip/@pop の HTML 消毒（正典は geopbf/sanitize・8/29）＝再輸出（geoedit は overlay.js 経由で同じ一本）
// ★import してから export する（`export … from` は再輸出だけでローカル束縛を作らない＝下の set() が smoothRing を呼んだ瞬間 ReferenceError。
//   輸入側（geoedit）は再輸出でも解決できるため、エディタでは曲線が出るのにビューアだけ落ちる非対称バグの再発防止・2026-09-01）。
import { smoothRing, smoothGeom, wrapLon } from "geopbf/edit/spline";
export { smoothRing, smoothGeom, wrapLon };
export { SHAPE_NAMES, SHAPE_SCALE, PICTO, BOTTOM_ANCHOR, makeTracer, dLon, buildLinePath } from "./anno-draw.js";
import annoDrawUrl from "./anno-draw.js?url";   // worker が import() する URL＝vite はこのファイルをそのまま置く（依存ゼロが掟。⚠?worker&url は export が tree-shake される）

// ---- ビューア再生本体（createAnno）：map の公開口だけで完結（overlay/tip/pop/unproject/getZoom）----
export function createAnno(map, { signal } = {}) {
	const mapEl = map.mapEl;
	const ov = map.overlay(annoDrawUrl, { name: "anno" });
	ov.el.classList.add("anno-overlay");

	let pbf = null, items = [];   // items[fid]＝前処理済み（@spline は set 時に一度だけ細分）＝worker へ写しを送り、main は識別と pop の錨に使う
	let tipSet = null, popFn = null, symHits = [];   // symHits＝worker が描いたシンボルの画面矩形（毎フレーム届く）
	let tipRaw = null, tipClean = null;   // 消毒キャッシュ（毎 move の DOMParser を避ける）
	const openedPops = new Map();   // fid → pop div
	const probes = new Map(); let probeSeq = 0;   // pixels()（検定用）の待ち行列
	ov.onmessage = d => {
		if (d.type === "hits") symHits = d.hits;
		else if (d.type === "pixels") { const r = probes.get(d.id); if (r) { probes.delete(d.id); r(d); } }
	};

	function set(newPbf) {   // 積み込み＝@spline の細分はここで一度だけ（毎フレやらない）
		pbf = newPbf;
		clearPops(); tipSet?.(null);
		items = [];
		const feats = pbf ? pbf.features : [];
		for (let i = 0; i < feats.length; i++) {
			const f = feats[i], g = f?.geometry;
			if (!g) { items.push(null); continue; }
			const p = f.properties || {};
			const it = { p };
			if (g.type === "Point") it.pts = [g.coordinates];
			else if (g.type === "MultiPoint") it.pts = g.coordinates;
			else if (g.type === "LineString") it.lines = [g.coordinates];
			else if (g.type === "MultiLineString") it.lines = g.coordinates;
			else if (g.type === "Polygon") it.rings = g.coordinates;
			else if (g.type === "MultiPolygon") it.rings = g.coordinates.flat();
			else { items.push(null); continue; }
			if (p["@spline"]) {
				if (it.lines) it.lines = it.lines.map(l => smoothRing(l, false));
				if (it.rings) it.rings = it.rings.map(r => smoothRing(r, true));
			}
			items.push(it);
		}
		ov.post({ type: "set", items });   // structured clone（@icon の Blob もそのまま渡る）
	}
	function clear() { pbf = null; items = []; symHits = []; clearPops(); tipSet?.(null); ov.post({ type: "clear" }); }
	function clearPops() { for (const [, div] of openedPops) div._remove?.(); openedPops.clear(); }
	// 検定用：worker の実画素（transfer 後の canvas は main から読めない）
	const pixels = () => new Promise(res => { const id = ++probeSeq; probes.set(id, res); ov.post({ type: "probe", id }); });

	// ---- 識別（tip/pop）＝pbf.identifyAt（JS幾何）＋シンボルの画面矩形。geoedit と同じ許容量（画面px基準）----
	const identify = (lng, lat) => {
		const zoom = map.getZoom();
		const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, zoom));
		const fid = pbf?.identifyAt?.(lng, lat, { point: Math.max(50, 12 * mpp), polyline: Math.max(30, 8 * mpp) });
		return fid == null || fid < 0 ? null : fid;
	};
	const symbolAt = (x, y) => {
		for (let i = symHits.length - 1; i >= 0; i--) {
			const r = symHits[i];
			if (x >= r.x0 - 4 && x <= r.x1 + 4 && y >= r.y0 - 4 && y <= r.y1 + 4) return r.fid;
		}
		return null;
	};
	const localXY = e => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	// nearestOnLine（pop の錨＝クリック点に最寄りの線分上・経度は cos 補正）
	const nearestOnLine = (lines, ll) => {
		const k = Math.cos(ll[1] * Math.PI / 180) || 1;
		let best = null, bd = Infinity;
		for (const cs of lines) for (let i = 0; i + 1 < cs.length; i++) {
			const ax = cs[i][0] * k, ay = cs[i][1], bx = cs[i + 1][0] * k, by = cs[i + 1][1];
			const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
			let t = l2 ? ((ll[0] * k - ax) * dx + (ll[1] - ay) * dy) / l2 : 0;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
			const qx = (ax + t * dx) / k, qy = ay + t * dy;
			const ddx = (qx - ll[0]) * k, ddy = qy - ll[1], dd = ddx * ddx + ddy * ddy;
			if (dd < bd) { bd = dd; best = [qx, qy]; }
		}
		return best;
	};

	mapEl.addEventListener("pointermove", e => {   // @tip＝ホバー即時（geoedit と同じ：位置も内容も毎move・離れたら即消す）
		if (!items.length || e.buttons) return;
		const [x, y] = localXY(e);
		const ll = map.unprojectXY(x, y);
		const fid = symbolAt(x, y) ?? (ll ? identify(ll[0], ll[1]) : null);
		const tip = fid != null ? items[fid]?.p["@tip"] : null;
		const raw = tip != null && tip !== "" ? String(tip) : null;
		if (raw !== tipRaw) { tipRaw = raw; tipClean = raw == null ? null : sanitizeHTML(raw); }   // 内容変化時だけ消毒
		tipSet ??= map.gadget.tip();
		tipSet(tipClean);
	}, { signal, passive: true });
	let downXY = null;
	mapEl.addEventListener("pointerdown", e => { downXY = localXY(e); }, { signal, passive: true });
	mapEl.addEventListener("click", e => {   // @pop＝クリックで開く（ビューアは通常クリック＝本人裁定）。×は閉じるだけ
		if (!items.length || e.target.tagName !== "CANVAS") return;   // pop箱やUI上のクリックは素通し
		const [x, y] = localXY(e);
		if (downXY && Math.hypot(x - downXY[0], y - downXY[1]) >= 4) return;   // ドラッグ＝パン
		const ll = map.unprojectXY(x, y);
		if (!ll) return;
		const fid = symbolAt(x, y) ?? identify(ll[0], ll[1]);
		const it = fid != null ? items[fid] : null;
		const pop = it?.p["@pop"];
		if (pop == null || pop === "" || openedPops.has(fid)) return;
		// 参照点＝点:座標・線:クリック点に最寄りの線分上・面:クリック点そのもの（geoedit と同じ規約）
		const a = it.pts ? it.pts[0] : it.lines ? (nearestOnLine(it.lines, ll) || ll) : ll;
		popFn ??= map.gadget.pop();
		const div = popFn(sanitizeHTML(pop), { lng: a[0], lat: a[1], x, y, hideOffscreen: true, onClose: () => { openedPops.delete(fid); div._remove?.(); } });
		if (div) openedPops.set(fid, div);
	}, { signal });

	signal?.addEventListener("abort", () => { clearPops(); ov.remove(); });
	return { set, clear, pixels, get pbf() { return pbf; }, get count() { return items.filter(Boolean).length; }, get hits() { return symHits; } };   // hits＝worker が最後に描いたシンボル矩形（検定・診断用）
}
