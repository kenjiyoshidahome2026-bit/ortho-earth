// 診断（使い捨て）：PDOK 3D Basisvoorziening の Delft 中心の葉を数枚 decodeBatch して、壁の法線を調べる。
// node packages/globe/scripts/probe-nl-walls.mjs
import { collectLeafTiles, decodeBatch } from "../src/meshdecode.ts";
const TS = "https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1/collections/gebouwen/3dtiles/tileset.json";
const clip = [4.355, 52.010, 4.359, 52.013];
const leaves = await collectLeafTiles(TS, 0, null, null, clip);
console.log("leaves", leaves.length, leaves.slice(0, 3).map(l => l.uri));
// 生の glb の見出し
const ab = await (await fetch(leaves[0].uri)).arrayBuffer(); const dv = new DataView(ab);
if (dv.getUint32(0, true) === 0x46546C67) { const j = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, dv.getUint32(12, true))));
	console.log("extensionsUsed", j.extensionsUsed); console.log("nodes", JSON.stringify(j.nodes).slice(0, 400));
	for (const m of j.meshes) for (const p of m.primitives) console.log("attrs", JSON.stringify(p.attributes), "mode", p.mode); }
else console.log("magic", dv.getUint32(0, true).toString(16));
const mesh = await decodeBatch("probe/", leaves.slice(0, 4), null, null);
const { pos, nrm, idx, origin } = mesh;
let walls = 0, wallHoriz = 0, agree = 0, disagree = 0, roofs = 0, roofAgree = 0;
for (let k = 0; k < idx.length; k += 3) {
	const a = idx[k], b = idx[k+1], c = idx[k+2];
	const P = i => [pos[i*3] + origin[0], pos[i*3+1] + origin[1], pos[i*3+2] + origin[2]];
	const A = P(a), B = P(b), C = P(c);
	const u = [B[0]-A[0], B[1]-A[1], B[2]-A[2]], v = [C[0]-A[0], C[1]-A[1], C[2]-A[2]];
	const g = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]; const gl = Math.hypot(...g); if (!gl) continue;
	const up = A.map(x => x / Math.hypot(...A));
	const gu = (g[0]*up[0] + g[1]*up[1] + g[2]*up[2]) / gl;
	const n = [0, 1, 2].map(j => nrm[a*4+j] + nrm[b*4+j] + nrm[c*4+j]); const nl = Math.hypot(...n) || 1;
	const nu = (n[0]*up[0] + n[1]*up[1] + n[2]*up[2]) / nl;
	const gn = (g[0]*n[0] + g[1]*n[1] + g[2]*n[2]) / gl / nl;
	if (Math.abs(gu) < 0.2) { walls++; if (Math.abs(nu) < 0.3) wallHoriz++; if (gn > 0.5) agree++; else if (gn < -0.5) disagree++; }
	else if (gu > 0.2) { roofs++; if (nu > 0.2) roofAgree++; }
}
console.log({ tris: idx.length / 3, walls, wallAttrNormalHorizontal: wallHoriz, wallWindingAgreesNormal: agree, wallWindingOpposesNormal: disagree, upFacingByWinding: roofs, upFacingAttrUp: roofAgree, twoSided: mesh.twoSided });
