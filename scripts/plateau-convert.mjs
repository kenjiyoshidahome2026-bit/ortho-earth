// PLATEAU B3DM → 上向き面のみの軽量バイナリに変換するスクリプト
// 出力: apps/plateau-poc/public/plateau/index.json + tile-N.bin
//
// 使い方: node scripts/plateau-convert.mjs

import { load } from '@loaders.gl/core';
import { Tiles3DLoader } from '@loaders.gl/3d-tiles';
import { DracoLoader } from '@loaders.gl/draco';
import { writeFileSync } from 'fs';
import draco3d from 'draco3d';  // Node.js ネイティブ Draco decoder

const TILESET_URL = 'https://assets.cms.plateau.reearth.io/assets/3f/e07412-5455-40c0-9f64-2ac43086a209/13101_chiyoda-ku_pref_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod1/tileset.json';
const OUT = 'apps/plateau-poc/public/plateau';

const a_wgs = 6378137, e2 = 0.00669437999014;

function ecefToGeodetic(x, y, z) {
	const p = Math.sqrt(x*x + y*y);
	const lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2));
	for (let i = 0; i < 6; i++) {
		const N = a_wgs / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
		lat = Math.atan2(z + e2 * N * Math.sin(lat), p);
	}
	return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

console.log('Fetching tileset...');
const tileset = await load(TILESET_URL, Tiles3DLoader, { '3d-tiles': { loadGLTF: false } });

const BASE = TILESET_URL.replace('tileset.json', '');
const leafUrls = [];
(function walk(node) {
	const ch = node.children || [];
	if (node.content?.uri && ch.length === 0) leafUrls.push(BASE + node.content.uri);
	ch.forEach(walk);
})(tileset.root);

console.log(`${leafUrls.length} leaf tiles found`);

const index = []; // index.json に書くメタデータ

for (let i = 0; i < leafUrls.length; i++) {
	const url = leafUrls[i];
	console.log(`[${i+1}/${leafUrls.length}] ${url.split('/').at(-1)}`);

	const tile = await load(url, Tiles3DLoader, {
		'3d-tiles': { loadGLTF: true },
		gltf: { decompressMeshes: true },
		DracoLoader,
		modules: { draco3d },
	});

	const rtcEcef = tile.rtcCenter;
	if (!rtcEcef) { console.warn('  no rtcCenter, skip'); continue; }

	const [cx, cy, cz] = rtcEcef;
	const earthR  = Math.sqrt(cx*cx + cy*cy + cz*cz);
	const upVec   = [cx/earthR, cy/earthR, cz/earthR];
	const lonlat  = ecefToGeodetic(cx, cy, cz);
	const lon_r   = lonlat[0] * Math.PI / 180;
	const lat_r   = lonlat[1] * Math.PI / 180;
	const eastVec  = [-Math.sin(lon_r), Math.cos(lon_r), 0];
	const northVec = [-Math.sin(lat_r)*Math.cos(lon_r), -Math.sin(lat_r)*Math.sin(lon_r), Math.cos(lat_r)];

	const buf = [];
	for (const mesh of tile.gltf?.meshes ?? []) {
		for (const prim of mesh.primitives ?? []) {
			const pos  = prim.attributes?.POSITION?.value ?? prim.attributes?.POSITION;
			const norm = prim.attributes?.NORMAL?.value   ?? prim.attributes?.NORMAL;
			const idx  = prim.indices?.value ?? prim.indices;
			if (!pos || !idx) continue;

			for (let t = 0; t < idx.length; t += 3) {
				const i0 = idx[t], i1 = idx[t+1], i2 = idx[t+2];
				if (norm) {
					const nx = (norm[i0*3]+norm[i1*3]+norm[i2*3])/3;
					const ny = (norm[i0*3+1]+norm[i1*3+1]+norm[i2*3+1])/3;
					const nz = (norm[i0*3+2]+norm[i1*3+2]+norm[i2*3+2])/3;
					if (nx*upVec[0]+ny*upVec[1]+nz*upVec[2] <= 0) continue;
				}
				buf.push(
					pos[i0*3], pos[i0*3+1], pos[i0*3+2],
					pos[i1*3], pos[i1*3+1], pos[i1*3+2],
					pos[i2*3], pos[i2*3+1], pos[i2*3+2]
				);
			}
		}
	}

	if (!buf.length) { console.warn('  no upward triangles, skip'); continue; }

	const triCount = buf.length / 9;
	const binFile  = `tile-${i}.bin`;
	writeFileSync(`${OUT}/${binFile}`, Buffer.from(new Float32Array(buf).buffer));

	index.push({ file: binFile, lonlat, earthR, eastVec, northVec, triCount });
	console.log(`  → ${triCount.toLocaleString()} triangles, ${(buf.length * 4 / 1024).toFixed(0)} KB`);
}

writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 2));
console.log(`\nDone. ${index.length} tiles written to ${OUT}/`);
