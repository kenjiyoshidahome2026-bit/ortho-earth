// ortho-export の出力フォルダ（anchor.json・terrain.glb・buildings.glb）→ Minecraft（docs/notes/minecraft.md）。
//   Java 版のワールドのフォルダ・WorldEdit の .schem・統合版の .mcworld。どれも同じ格子から書く。
//   錨とブロックの対応は ortho-earth.json（ワールドの中と横に置く）＝取り込み（Minecraft → GLB）が元の場所へ戻すのに使う。
import fs from "node:fs";
import path from "node:path";
import { glbToScene } from "glbconv";
import { decodePng, encodePng } from "../png.mjs";
import { findImageConverter } from "../textures.mjs";
import { voxelize, blockAt, AIR } from "./voxelize.mjs";
import { writeJavaWorld, JAVA } from "./anvil.mjs";
import { writeSchem } from "./schem.mjs";
import { writeMcworld, BEDROCK } from "./bedrock.mjs";
import { VERSION } from "../export.mjs";

/** 画像（jpeg・png・webp）→ { w, h, px, bpp }：png はそのまま・他は手元の変換器で png に */
export async function makeImageDecoder({ tool = null, maxSize = 1024, log = () => {} } = {}) {
	let conv;
	return async (bytes, mime) => {
		if (mime === "image/png") { try { return decodePng(bytes); } catch { /* 8bit RGB(A) 以外は変換器へ */ } }
		if (conv === undefined) { conv = await findImageConverter(tool); if (!conv) log("warning: no image converter (sharp / sips / ffmpeg / magick): colours come from material colours only"); else log(`images: decoding with ${conv.name}`); }
		if (!conv) return null;
		return decodePng(await conv.convert(bytes, mime, "image/png", { maxSize }));
	};
}

/** 上から見た 64×64 の絵（Java のワールド一覧の icon.png） */
export function topIcon(g, size = 64) {
	const rgb = new Uint8Array(size * size * 3), s = Math.max(g.W, g.D) / size;
	for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
		const x = g.x0 + Math.floor((i + 0.5) * s), z = g.z0 + Math.floor((j + 0.5) * s);
		for (let y = g.y0 + g.H - 1; y >= g.y0; y--) { const b = blockAt(g, x, y, z); if (b !== AIR) { rgb.set(g.blocks[b].rgb || [0, 0, 0], (j * size + i) * 3); break; } }
	}
	return encodePng(size, size, rgb);
}

/**
 * @param {object} o
 * @param {string} o.from   ortho-export の出力フォルダ
 * @param {string} o.out    書き出し先
 * @param {string[]} [o.editions=["java","bedrock"]]  "java"（ワールド＋.schem）・"bedrock"（.mcworld）・"schem"（.schem だけ）
 */
export async function exportMinecraft({ from, out, name = null, editions = ["java", "bedrock"], scale = 1, floors = 4, yOrigin = null, roofFromImagery = true, decodeImage = undefined, imageTool = null, log = () => {} }) {
	const anchor = JSON.parse(fs.readFileSync(path.join(from, "anchor.json"), "utf8"));
	const load = async (f) => fs.existsSync(path.join(from, f)) ? glbToScene(new Uint8Array(fs.readFileSync(path.join(from, f))), { anchor: false }) : null;
	const terrain = await load("terrain.glb"), buildings = await load("buildings.glb");
	log(`read ${from}: terrain ${terrain ? terrain.prims.length + " prims" : "none"}, buildings ${buildings ? buildings.prims.length + " prims" : "none"}`);
	if (decodeImage === undefined) decodeImage = await makeImageDecoder({ tool: imageTool, log });
	const g = await voxelize({ terrain, buildings, scale, floors, yOrigin, roofFromImagery, decodeImage, log });
	name = name || path.basename(path.resolve(from));
	fs.mkdirSync(out, { recursive: true });
	let sy = g.y0; for (let y = g.y0 + g.H - 1; y >= g.y0; y--) if (blockAt(g, 0, y, 0) !== AIR) { sy = y + 1; break; }
	const spawn = [0, sy, 0];
	const meta = {
		version: 1, generator: `ortho-export ${VERSION} minecraft`, anchor: anchor.anchor, geoid: anchor.geoid, bbox: anchor.bbox,
		minecraft: {
			note: "Block (0, yOrigin, 0) is the anchor (its bottom-north-west corner). +X = east, +Y = up, +Z = south. One block = scale metres. glTF (E, U, -N) = ((x) * scale, (y - yOrigin) * scale, (z) * scale).",
			scale, yOrigin: g.yOrigin, axes: { x: "east", y: "up", z: "south" }, grid: { x0: g.x0, z0: g.z0, y0: g.y0, width: g.W, length: g.D, height: g.H },
			java: { dataVersion: JAVA.dataVersion, version: JAVA.name }, bedrock: { blockVersion: BEDROCK.version.join(".") }, spawn,
		},
		source: anchor.source,
	};
	const metaBytes = new TextEncoder().encode(JSON.stringify(meta, null, "\t") + "\n");
	const files = [];
	fs.writeFileSync(path.join(out, "ortho-earth.json"), metaBytes); files.push({ name: "ortho-earth.json", bytes: metaBytes.length });
	if (editions.includes("java")) {
		const dir = path.join(out, name);
		const r = writeJavaWorld(g, dir, { name, spawn, icon: topIcon(g) });
		fs.writeFileSync(path.join(dir, "ortho-earth.json"), metaBytes);
		files.push({ name: `${name}/`, bytes: r.bytes, regions: r.regions, chunks: r.chunks });
		log(`java: ${name}/ (${r.regions} region files, ${r.chunks} chunks, ${(r.bytes / 1e6).toFixed(1)} MB)`);
	}
	if (editions.includes("java") || editions.includes("schem")) {
		const s = writeSchem(g); fs.writeFileSync(path.join(out, `${name}.schem`), s);
		files.push({ name: `${name}.schem`, bytes: s.length }); log(`schem: ${name}.schem (${(s.length / 1e6).toFixed(1)} MB)`);
	}
	if (editions.includes("bedrock")) {
		const m = writeMcworld(g, { name, spawn, extra: [{ name: "ortho-earth.json", bytes: metaBytes }] });
		fs.writeFileSync(path.join(out, `${name}.mcworld`), m.bytes);
		files.push({ name: `${name}.mcworld`, bytes: m.bytes.length }); log(`bedrock: ${name}.mcworld (${(m.bytes.length / 1e6).toFixed(1)} MB)`);
	}
	return { grid: g, spawn, meta, files };
}
