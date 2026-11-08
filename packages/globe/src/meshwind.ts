// 巻き順を法線に揃える（?meshcull・2026-11-08）＝PLATEAU の建物メッシュは面の向き（巻き順）が揃っていないので、裏面の捨ては
// FS が属性法線と視線で判定して discard していた（cullMode none）。Mali-G615 実測：丸の内の静止でメッシュ 40 ms のうち三角形数
// に比例する分は 2 割＝大部分が画素の塗りで、裏面（約半分の画素）もシェーダを走らせてから捨てている。
// ここで三角形ごとに「幾何法線 cross(b−a, c−a)」と「頂点法線の和」の向きを比べ、逆なら 2 頂点を入れ替える＝外向き＝反時計回りに揃う。
// 揃えた後は renderer が cullMode で裏面をラスタライザで捨てられる（FS の判定は残る＝揃え漏れの保険）。
// 退化（幾何法線ゼロ）と法線の和がゼロの三角形は触らない。橋梁（twoSided）・両面配信の区（noCull）は呼び手が外す。
/** idx をその場で揃える（入れ替えた三角形の数を返す）。nrm＝snorm8 xyz+pad（stride 4） */
export function windToNormals(pos: Float32Array, nrm: Int8Array, idx: Uint32Array): number {
	let flipped = 0;
	const nTri = idx.length / 3 | 0;
	for (let t = 0; t < nTri; t++) {
		const ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2];
		const a = ia * 3, b = ib * 3, c = ic * 3;
		const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
		const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
		const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
		const na = ia * 4, nb = ib * 4, nc = ic * 4;
		const nx = nrm[na] + nrm[nb] + nrm[nc], ny = nrm[na + 1] + nrm[nb + 1] + nrm[nc + 1], nz = nrm[na + 2] + nrm[nb + 2] + nrm[nc + 2];
		if (gx * nx + gy * ny + gz * nz < 0) { idx[t * 3 + 1] = ic; idx[t * 3 + 2] = ib; flipped++; }
	}
	return flipped;
}
