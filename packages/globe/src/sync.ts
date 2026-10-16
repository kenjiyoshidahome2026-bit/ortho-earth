// 地図どうしのカメラ連動（#173 段 4・2026-09-30）＝MapLibre の mapbox-gl-sync-move と同じ所作。
// どれを動かしても、他の地図が同じ視点へ jumpTo で追う（主従は固定しない＝今動いている地図が主）。
// ・追っている最中の印（syncing）で、追う側の move（jumpTo が同期で出す）には応えない＝往復が止まる
// ・主の飛行（flyTo/easeTo）は止めない：主は自分の move を出し続け、従は毎回 jumpTo で追う（従の飛行は止まる＝追う側だから）
// ・zoomDelta＝地図ごとのズームのずらし（虫めがね・ロケータ）：地図 i のズーム＝主のズーム − 主の delta ＋ i の delta
// 始めに 2 枚目以降を 1 枚目の視点へ揃える。maps＝createGlobe の地図（か MapLibre 互換の Map）。戻り値＝連動を解く関数。Compare（段 5）が中で使う＝公開の口ではない。
export function syncMaps(maps, { zoomDelta = null } = {}) {
	const dz = i => (zoomDelta && Number.isFinite(zoomDelta[i]) ? zoomDelta[i] : 0);
	let syncing = false;
	const follow = i => () => {
		if (syncing) return;
		syncing = true;
		try {
			const m = maps[i], c = m.getCenter(), z = m.getZoom() - dz(i), bearing = m.getBearing(), pitch = m.getPitch();
			maps.forEach((o, j) => { if (j !== i) o.jumpTo({ center: [c.lng, c.lat], zoom: z + dz(j), bearing, pitch }); });
		} finally { syncing = false; }
	};
	const handlers = maps.map((m, i) => { const h = follow(i); m.on("move", h); return h; });
	if (maps.length > 1) handlers[0]();   // 始めに 1 枚目の視点へ揃える（Compare の 2 枚が最初からずれない）
	return () => maps.forEach((m, i) => m.off("move", handlers[i]));
}
