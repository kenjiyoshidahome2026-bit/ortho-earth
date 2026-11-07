// 読んだ点（map.readPointCloud の PointCloudDump）→ Unity 向けの PLY（binary little endian・純関数＝node の検定 tests/t-pc-ply.mjs）。
//   位置＝錨からのメートルを glTF の向き (E, U, −N) で（docs/notes/unity-roundtrip.md §3.3＝ortho-export の GLB と同じ約束・Unity の PlyImporter が Z を反転して北＝+Z）。
//   色＝RGB u8（無ければ白）・classification u8（ASPRS）。錨は見出しの comment に（orthoEarth anchor <lon> <lat> <h> orthometric）＝Unity の Place が
//   書き出しフォルダの錨（anchor.json）との差を足して置く。標高（ジオイド上）のまま＝楕円体高は anchor.json の geoid を足す側が持つ。
import type { PointCloudDump } from "@ortho-earth/globe";

export interface PlyOptions { /** 書く点の上限（0＝全部）＝均等に間引く */ maxPoints?: number; /** 見出しに残す出典 */ source?: string | null }

/** PointCloudDump → PLY のバイト列 */
export function dumpToPly(d: Pick<PointCloudDump, "n" | "anchor" | "pts" | "rgb" | "cls">, { maxPoints = 0, source = null }: PlyOptions = {}): Uint8Array {
	const step = maxPoints && d.n > maxPoints ? d.n / maxPoints : 1, n = step > 1 ? maxPoints : d.n;
	const head = [
		"ply", "format binary_little_endian 1.0",
		"comment ortho-earth pointcloud (positions: metres from the anchor, x=east y=up z=south = glTF frame; Unity flips z)",
		`comment orthoEarth anchor ${d.anchor[0]} ${d.anchor[1]} ${d.anchor[2]} orthometric`,
		...(source ? [`comment source ${source.replace(/[\r\n]+/g, " ")}`] : []),
		`element vertex ${n}`,
		"property float x", "property float y", "property float z",
		"property uchar red", "property uchar green", "property uchar blue",
		"property uchar classification",
		"end_header", "",
	].join("\n");
	const hb = new TextEncoder().encode(head), stride = 16;
	const out = new Uint8Array(hb.length + n * stride), dv = new DataView(out.buffer);
	out.set(hb, 0);
	let o = hb.length;
	for (let k = 0; k < n; k++) {
		const i = step > 1 ? Math.floor(k * step) : k, p = i * 3;
		dv.setFloat32(o, d.pts[p], true); dv.setFloat32(o + 4, d.pts[p + 2], true); dv.setFloat32(o + 8, -d.pts[p + 1], true);   // (E, N, U) → (E, U, −N)
		if (d.rgb) { out[o + 12] = d.rgb[p]; out[o + 13] = d.rgb[p + 1]; out[o + 14] = d.rgb[p + 2]; } else { out[o + 12] = out[o + 13] = out[o + 14] = 255; }
		out[o + 15] = d.cls ? d.cls[i] : 0;
		o += stride;
	}
	return out;
}
