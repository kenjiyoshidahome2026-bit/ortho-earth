// PLATEAU PoC Step 2b: GLB内 CESIUM_RTC / node transform / POSITION accessor を確認

const BASE = 'https://assets.cms.plateau.reearth.io/assets/3f/e07412-5455-40c0-9f64-2ac43086a209/13101_chiyoda-ku_pref_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod1/';
const B3DM_URL = BASE + 'data/data0.b3dm';

const R = 180 / Math.PI;
const EARTH_R = 6378137;

function ecefToLonLat(x, y, z) {
	const r = Math.sqrt(x*x + y*y + z*z);
	return [Math.atan2(y, x) * R, Math.asin(z / r) * R];
}

const buf = Buffer.from(await (await fetch(B3DM_URL, { signal: AbortSignal.timeout(15000) })).arrayBuffer());

const ftJsonLen = buf.readUInt32LE(12);
const ftBinLen  = buf.readUInt32LE(16);
const btJsonLen = buf.readUInt32LE(20);
const btBinLen  = buf.readUInt32LE(24);

const glbOffset = 28 + ftJsonLen + ftBinLen + btJsonLen + btBinLen;
const jsonChunkLen = buf.readUInt32LE(glbOffset + 12);
const gltf = JSON.parse(buf.slice(glbOffset + 20, glbOffset + 20 + jsonChunkLen).toString('utf8'));

// --- CESIUM_RTC 拡張 ---
if (gltf.extensions?.CESIUM_RTC) {
	const [cx, cy, cz] = gltf.extensions.CESIUM_RTC.center;
	const [lon, lat] = ecefToLonLat(cx, cy, cz);
	const alt = Math.sqrt(cx*cx + cy*cy + cz*cz) - EARTH_R;
	console.log('CESIUM_RTC.center ECEF:', cx.toFixed(1), cy.toFixed(1), cz.toFixed(1));
	console.log(`→ lon=${lon.toFixed(6)}, lat=${lat.toFixed(6)}, alt=${alt.toFixed(1)}m`);
} else {
	console.log('CESIUM_RTC: not found');
}

// --- extensionsUsed ---
console.log('extensionsUsed:', gltf.extensionsUsed);
console.log('extensionsRequired:', gltf.extensionsRequired);

// --- nodes ---
console.log(`\nnodes (${gltf.nodes?.length || 0}):`)
gltf.nodes?.forEach((n, i) => {
	console.log(`  node[${i}]: mesh=${n.mesh}, name="${n.name}"`);
	if (n.matrix) console.log(`    matrix: [${n.matrix.map(v => v.toFixed(2)).join(', ')}]`);
	if (n.translation) console.log(`    translation: ${n.translation}`);
});

// --- accessors ---
console.log(`\naccessors (${gltf.accessors?.length || 0}):`);
gltf.accessors?.forEach((a, i) => {
	const ctName = {5120:'BYTE',5121:'UBYTE',5122:'SHORT',5123:'USHORT',5125:'UINT',5126:'FLOAT',5130:'DOUBLE'}[a.componentType] || a.componentType;
	console.log(`  [${i}] ${a.type} ${ctName} count=${a.count}  min=${a.min?.map(v=>v.toFixed(2))}  max=${a.max?.map(v=>v.toFixed(2))}`);
});

// --- mesh primitives ---
console.log(`\nmeshes[0].primitives:`);
gltf.meshes?.[0]?.primitives?.forEach((p, i) => {
	console.log(`  prim[${i}]: attributes=${JSON.stringify(p.attributes)}, indices=${p.indices}`);
});
