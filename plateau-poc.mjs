// PLATEAU PoC Step 1: tileset.json の構造と座標を確認する
// PLATEAU 3D Tiles (notexture) → boundingVolume.region → lat/lon

// 千代田区 LOD1（2025年）- 実際のタイルセット
const TILESET_URL = 'https://assets.cms.plateau.reearth.io/assets/3f/e07412-5455-40c0-9f64-2ac43086a209/13101_chiyoda-ku_pref_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod1/tileset.json';
const R = 180 / Math.PI;

console.log('Fetching:', TILESET_URL);
const res = await fetch(TILESET_URL, { signal: AbortSignal.timeout(10000) });
console.log(`HTTP ${res.status}  content-type: ${res.headers.get('content-type')}`);
if (!res.ok) { console.error('FAILED'); process.exit(1); }

const tileset = await res.json();
console.log('asset:', JSON.stringify(tileset.asset));
console.log('geometricError:', tileset.geometricError);
console.log('');

function walkNode(node, depth = 0) {
	const indent = '  '.repeat(depth);
	const bv = node.boundingVolume;
	if (bv?.region) {
		const [west, south, east, north, minH, maxH] = bv.region;
		const clon = ((west + east) / 2 * R).toFixed(5);
		const clat = ((south + north) / 2 * R).toFixed(5);
		const spanLon = ((east - west) * R * 111000 * Math.cos((south + north) / 2)).toFixed(0);
		const spanLat = ((north - south) * R * 111000).toFixed(0);
		console.log(`${indent}region [${clon}, ${clat}]  span≈${spanLon}m×${spanLat}m  err=${node.geometricError}`);
	} else if (bv?.sphere) {
		const [cx, cy, cz] = bv.sphere;
		const r = Math.sqrt(cx*cx + cy*cy + cz*cz);
		const lon = (Math.atan2(cy, cx) * R).toFixed(5);
		const lat = (Math.asin(cz / r) * R).toFixed(5);
		console.log(`${indent}sphere ECEF→[${lon}, ${lat}]  radius=${bv.sphere[3].toFixed(0)}m  err=${node.geometricError}`);
	} else if (bv?.box) {
		console.log(`${indent}box  err=${node.geometricError}`);
	}
	if (node.content?.uri) console.log(`${indent}  → ${node.content.uri}`);

	const children = node.children || [];
	children.slice(0, 4).forEach(c => walkNode(c, depth + 1));
	if (children.length > 4) console.log(`${indent}  ... (${children.length - 4} more children)`);
}

walkNode(tileset.root);
