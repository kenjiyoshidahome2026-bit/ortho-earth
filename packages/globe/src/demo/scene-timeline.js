// 台本(type:"scenes")→総タイムライン＝時刻評価（スクラブの芯・純関数・再生しない）。正典＝demo/scene-format.md §7。
// プレーヤー（gadgets/demo.js＋app.js playScenes）の再生規則の写しで行を連結する：
//   先頭行=jump（遷移0秒）／view=球面フライト／glide=滑走（travel指定=1区間スプライン・無指定=時分割の自動尺）／
//   via畳み込み=連続ドリー（1本のスプライン）／fade=溶暗(travel・既定1.2)→切替0.3s→溶明(travel)＝cover(黒の濃さ)を返す／
//   pre=見せ玉の近似（pre 着地+1秒で view へカット。実プレーヤーは着地からの実測待ち＝秒単位で一致・拍は同じ）／
//   保持(hold)=着地後から（scene 再生の既定3秒）。slide の幕は時間だけ数える（カメラ据え置き・DOM演出は再現しない）。
// deps＝{plan(flightCtl.plan＝飛行の時刻評価プラン), parseView(parseViewHash), portrait, zoomMin}。
//   portrait＝mobile:Δz の判定（プレーヤーの mobView と同じ＝縦長画面だけ z に差分・zoomMin 床）。
// 返り値＝{dur(総尺・秒), rows:[{i,t0,tArrive,t1,knots[],hash}], at(秒)→{lon,lat,zoom,pitch,bearing(ラジアン),cover(0..1),i,hash}}。
//   時間は外側は全部「秒」（台本の掟）＝ms はプランの内側だけ。knots＝◇通過点の実到達時刻（末尾=着点自身）。
import { parseScenes, compileVias } from "./scene-adapter.js";
const R2D = 180 / Math.PI;

export function buildSceneTimeline(doc, { plan, parseView, portrait = false, zoomMin = 1 } = {}) {
	if (!plan || !parseView) return null;
	const { scenes, mobile, hold: holdD = 3, slideHold: slideHoldD = 4 } = parseScenes(doc);
	const rows = compileVias(scenes);
	if (!rows.length) return null;
	const camOf = (s, hash) => {   // 視点ハッシュ→カメラ（mobile:Δz＝mobView と同じ規則）
		const v = typeof hash === "string" ? parseView(hash) : null;
		if (!v) return null;
		const d = s.mobile ?? mobile;
		const zoom = (portrait && d) ? Math.max(zoomMin, Math.round((v.zoom + d) * 100) / 100) : v.zoom;
		return { lon: v.lon, lat: v.lat, zoom, pitch: v.pitch || 0, bearing: v.bearing || 0 };
	};
	const recs = [];
	let t = 0, cam = null;
	rows.forEach((s, i) => {
		const hash = s.view ?? s.glide ?? s.fade;
		const tgt = hash ? camOf(s, hash) : null;
		const from = cam;
		let trans = 0, knots = [], evalT = null;   // evalT(局所秒)→{lon,lat,zoom,pitch,bearing,cover?}（遷移区間のみ）
		if (tgt && from && !s.jump) {
			if (s.path) {   // via 連続ドリー＝1本のスプライン（glidePathView と同じ pts）
				const pts = s.path.map(p => ({ ...camOf(s, p.view), secs: p.travel })).filter(p => Number.isFinite(p?.lon));
				const pl = pts.length ? plan.path(from, pts) : null;
				if (pl) { trans = pl.dur / 1000; knots = (pl.knots || []).map(ms => ms / 1000); evalT = sec => pl.at(sec * 1000); }
			} else if (s.fade) {   // 溶暗→切替→溶明（fadeViewRun の写し）＝カメラは黒の中でカット
				const f = (Number.isFinite(s.travel) && s.travel > 0) ? s.travel : 1.2;
				trans = f + 0.3 + f;
				evalT = sec => ({ ...(sec < f + 0.15 ? from : tgt),
					cover: sec < f ? sec / f : sec < f + 0.3 ? 1 : Math.max(0, 1 - (sec - f - 0.3) / f) });
			} else if (s.glide != null && s.travel) {   // 尺指定の滑走＝1区間スプライン（同時補間・尺どおり）
				const pl = plan.path(from, [{ ...tgt, secs: s.travel }]);
				if (pl) { trans = pl.dur / 1000; evalT = sec => pl.at(sec * 1000); }
			} else if (s.glide != null) {   // 滑走＝位置→方位→チルトの時分割（自動尺）
				const pl = plan.glide(from, tgt.lon, tgt.lat, tgt.zoom, tgt.pitch * R2D, tgt.bearing * R2D);
				trans = pl.dur / 1000; evalT = sec => pl.at(sec * 1000);
			} else {   // 地図遷移＝球面フライト（pre＝まず pre へ飛び、+1秒で view へカット）
				const pp = s.pre ? camOf(s, s.pre) : null, fl = pp ?? tgt;
				const pl = plan.fly(from, fl.lon, fl.lat, fl.zoom, fl.pitch * R2D, fl.bearing * R2D);
				trans = pl.dur / 1000 + (pp ? 1 : 0);
				evalT = sec => sec * 1000 < pl.dur ? pl.at(sec * 1000) : fl;
			}
		}
		// 保持（着地後から）：slide は時間だけ数える（view併記=地図ひと目+幕+三拍目／幕だけ=slideHold）＝demo.js schedule の写し
		const h = s.hold ?? holdD, sh = s.slideHold ?? slideHoldD;
		const dwell = s.slide ? (s.view ? Math.min(2, h) + sh + Math.min(1.5, h) : sh) : h;
		const t0 = t, tArrive = t0 + trans;
		recs.push({ i, t0, tArrive, t1: tArrive + dwell, knots, hash, evalT, pose: tgt ?? from });
		cam = tgt ?? cam;
		t = tArrive + dwell;
	});
	const dur = t;
	const at = sec => {
		sec = Math.max(0, Math.min(sec ?? 0, dur));
		let r = recs[0];
		for (const q of recs) { if (sec >= q.t0) r = q; else break; }
		const local = sec - r.t0;
		const f = (local < r.tArrive - r.t0 && r.evalT) ? r.evalT(local) : (r.pose ?? { lon: 0, lat: 0, zoom: zoomMin, pitch: 0, bearing: 0 });
		return { lon: f.lon, lat: f.lat, zoom: f.zoom, pitch: f.pitch || 0, bearing: f.bearing || 0, cover: f.cover || 0, i: r.i, hash: r.hash };
	};
	return { dur, rows: recs.map(({ i, t0, tArrive, t1, knots, hash }) => ({ i, t0, tArrive, t1, knots, hash })), at };
}
