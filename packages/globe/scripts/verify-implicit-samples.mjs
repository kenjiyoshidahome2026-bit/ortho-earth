#!/usr/bin/env node
// 公開の implicit tiling 試料（CesiumGS/3d-tiles-samples の 1.1）を src/tiles3d-implicit.ts で辿って数を照合する（2026-10-16）。
// 網に依り、試料はライセンスを確かめていないので取り込まない＝常設の関門（npm test）には入れず、手で回す（verify-net と同じ扱い）。
// 照合＝各試料の README に書かれた数（content を持つタイルの数）と、content の URI が実在すること（HEAD）。
import { implicitOf, isAvailable, indexIn, childSubtreeIndex, childCoord, expandUri, parseSubtree } from "../src/tiles3d-implicit.ts";

const BASE = "https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.1/";
const SAMPLES = [   // [名前, content を持つタイルの数（README）]
	["SparseImplicitQuadtree", 32],   // 段 5 に 32 個（README）・祖先は content 無し
	["SparseImplicitOctree", 31],
];
const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.arrayBuffer(); };
let fail = 0;
for (const [name, want] of SAMPLES) {
	const tsUrl = `${BASE}${name}/tileset.json`, ts = JSON.parse(new TextDecoder().decode(await get(tsUrl))), T = implicitOf(ts.root);
	const contents = [];
	let subtrees = 0, tiles = 0;
	const walkSubtree = async r => {
		const url = new URL(expandUri(T.subtreeUri, r), tsUrl).href, st = await parseSubtree(await get(url), T, uri => get(new URL(uri, url).href)); subtrees++;
		const visit = async c => {
			if (c.level - r.level === T.subtreeLevels) { if (c.level < T.availableLevels && isAvailable(st.child, childSubtreeIndex(r, c, T.n))) await walkSubtree(c); return; }
			const i = indexIn(r, c, T.n);
			if (!isAvailable(st.tile, i)) return;
			tiles++;
			if (st.content[0] && isAvailable(st.content[0], i)) contents.push(new URL(expandUri(ts.root.content.uri, c), tsUrl).href);
			for (let k = 0; k < T.n; k++) await visit(childCoord(c, k));
		};
		await visit(r);
	};
	await walkSubtree(T.n === 8 ? { level: 0, x: 0, y: 0, z: 0 } : { level: 0, x: 0, y: 0 });
	const missing = (await Promise.all(contents.map(async u => (await fetch(u, { method: "HEAD" })).ok ? null : u))).filter(Boolean);
	const good = contents.length === want && !missing.length;
	if (!good) fail++;
	console.log(`${good ? "PASS" : "FAIL"}  ${name}  subtrees=${subtrees} tiles=${tiles} contents=${contents.length}（README ${want}）${missing.length ? ` 無い URI ${missing.length}: ${missing[0]}` : ""}`);
}
process.exit(fail ? 1 : 0);
