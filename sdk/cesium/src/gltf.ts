// The bounding sphere Cesium's Model gives a glTF (the scene's POSITION min/max through the node transforms, then the y-up/forward-Z
// axis correction): zoomTo, flyTo and trackedEntity frame a model by it, so the facade reads it from the file the same way.
type V3 = [number, number, number];
type M4 = number[];   // column-major 4x4

const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a: M4, b: M4): M4 => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const xf = (m: M4, p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
function trs(n: any): M4 {
	if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix;
	const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
	return [
		(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
		2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
		2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
		tx, ty, tz, 1,
	];
}
async function gltfJson(url: string): Promise<any> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`${r.status} ${url}`);
	const buf = await r.arrayBuffer(), dv = new DataView(buf);
	if (buf.byteLength >= 20 && dv.getUint32(0, true) === 0x46546c67) {   // "glTF" (binary): the first chunk is the JSON
		const len = dv.getUint32(12, true);
		return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
	}
	return JSON.parse(new TextDecoder().decode(buf));
}
const memo = new Map<string, Promise<{ center: V3; radius: number } | null>>();
/** the model's bounding sphere in Cesium's model frame (z-up, +X forward), or null when the file has no bounds */
export function gltfSphere(url: string): Promise<{ center: V3; radius: number } | null> {
	let p = memo.get(url);
	if (!p) {
		p = gltfJson(url).then(g => {
			const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
			const visit = (i: number, parent: M4) => {
				const n = g.nodes?.[i]; if (!n) return;
				const m = mul(parent, trs(n));
				for (const pr of g.meshes?.[n.mesh]?.primitives ?? []) {
					const a = g.accessors?.[pr.attributes?.POSITION];
					if (!a?.min || !a?.max) continue;
					for (let k = 0; k < 8; k++) {
						const q = xf(m, [k & 1 ? a.max[0] : a.min[0], k & 2 ? a.max[1] : a.min[1], k & 4 ? a.max[2] : a.min[2]]);
						for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], q[d]); hi[d] = Math.max(hi[d], q[d]); }
					}
				}
				for (const c of n.children ?? []) visit(c, m);
			};
			for (const i of g.scenes?.[g.scene ?? 0]?.nodes ?? []) visit(i, I4);
			if (!(hi[0] >= lo[0])) return null;
			const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
			const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
			return { center: [c[2], c[0], c[1]] as V3, radius };   // glTF (x, y-up, z-forward) → Cesium's model frame (z-forward → +X, y-up → +Z)
		}).catch(() => null);
		memo.set(url, p);
	}
	return p;
}

/** the names of the glTF's nodes (Model.getNode, model._nodesByName) */
export async function gltfNodeNames(url: string): Promise<string[]> {
	try { const g = await gltfJson(url); return (g.nodes ?? []).map((n: any, i: number) => n.name ?? `node${i}`); } catch { return []; }
}
