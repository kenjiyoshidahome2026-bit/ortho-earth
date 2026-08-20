// スナップ用空間ハッシュ（純粋モジュール＝Node試験可）。セル寸＝現在の格子 10^-gridExp 度。
// 問い合わせは 3×3 近傍セルから最近傍1点（tol=セル寸以内）＝「既存頂点への吸着」（v1の吸着先は頂点のみ）。
// 格子切替時は rebuild（1Mでも単純1パス＝Worker/アイドルで数十ms級）。編集中の増分更新は move/add/remove で。
// 経度セルは度で等分＝高緯度で東西の実距離が縮む（吸着が実距離で狭くなる方向＝安全側）。±180の継ぎ目は
// 経度を [-180,180) に正規化した上で、境界セルの問い合わせが両側を見るよう qx を周回させる。

export const normLon = x => { x = ((x + 180) % 360 + 360) % 360 - 180; return x; };

export function createSnapIndex(gridExp) {
	let e = Math.pow(10, gridExp);
	const cells = new Map();   // qx → Map<qy, Array<entry>>   entry={x,y,arcId,idx} | {x,y,eid,ptIdx}
	const QX = () => Math.round(360 * e);   // 経度セル数（周回用）
	const cellOf = (x, y) => [Math.floor(normLon(x) * e), Math.floor(y * e)];
	const listAt = (qx, qy, make) => {
		let col = cells.get(qx);
		if (!col) { if (!make) return null; cells.set(qx, (col = new Map())); }
		let l = col.get(qy);
		if (!l && make) col.set(qy, (l = []));
		return l || null;
	};
	const api = {
		get gridExp() { return Math.log10(e); },
		add(entry) { const [qx, qy] = cellOf(entry.x, entry.y); listAt(qx, qy, true).push(entry); },
		remove(entry) {
			const [qx, qy] = cellOf(entry.x, entry.y);
			const l = listAt(qx, qy, false); if (!l) return;
			const i = l.indexOf(entry); if (i >= 0) l.splice(i, 1);
		},
		move(entry, x, y) { api.remove(entry); entry.x = x; entry.y = y; api.add(entry); },
		// 最近傍1点（tol=1セル寸）。skip(entry)=true は候補から除外（ドラッグ中の自分自身など）
		nearest(x, y, skip) {
			const tol = 1 / e, qn = QX();
			const [qx, qy] = cellOf(x, y);
			let best = null, bd = tol * tol;
			for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
				const l = listAt(((qx + dx) % qn + qn) % qn, qy + dy, false);
				if (l) for (const en of l) {
					if (skip && skip(en)) continue;
					let ddx = normLon(en.x - x);   // 継ぎ目跨ぎの差も最短側で測る
					const d = ddx * ddx + (en.y - y) * (en.y - y);
					if (d < bd) { bd = d; best = en; }
				}
			}
			return best;
		},
		setGrid(gridExp2, entries) {   // 格子切替＝全載せ替え（entries=イテレータ）
			e = Math.pow(10, gridExp2);
			cells.clear();
			for (const en of entries) api.add(en);
		},
		clear() { cells.clear(); },
	};
	return api;
}
