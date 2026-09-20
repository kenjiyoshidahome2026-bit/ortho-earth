// glb の中の webp テクスチャを jpeg へ焼き直す（macOS の sips を使う・他 OS は cwebp/dwebp か sharp に差し替え）。
// なぜ：PLATEAU の 3D Tiles は EXT_texture_webp（webp を bufferView に置く）。エンジンの読み手（loaders.gl）が
// webp を画像として解かず、テクスチャが黙って無地になる（実測 2026-09-21・jpeg の tile だけ色が出た）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseGlb } from "./glbmerge.mjs";
const enc = new TextEncoder();
export function webpToJpeg(glb, { quality = 82 } = {}) {
	const { json: j, bin } = parseGlb(glb);
	const targets = (j.images || []).map((im, i) => ({ im, i })).filter(({ im }) => im.mimeType === "image/webp" && im.bufferView != null);
	if (!targets.length) return glb;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glbwebp-"));
	const repl = new Map();   // bufferView index → 新しいバイト列
	for (const { im, i } of targets) {
		const bv = j.bufferViews[im.bufferView], off = bv.byteOffset || 0;
		const w = path.join(tmp, `${i}.webp`), o = path.join(tmp, `${i}.jpg`);
		fs.writeFileSync(w, bin.subarray(off, off + bv.byteLength));
		const r = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), w, "--out", o], { stdio: "ignore" });
		if (r.status !== 0 || !fs.existsSync(o)) { console.warn("  sips failed for image", i); continue; }
		repl.set(im.bufferView, new Uint8Array(fs.readFileSync(o)));
		im.mimeType = "image/jpeg";
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	if (!repl.size) return glb;
	// BIN を組み直す（差し替えた画像はサイズが変わる＝全 bufferView の byteOffset を振り直す）
	const chunks = []; let len = 0;
	for (let i = 0; i < j.bufferViews.length; i++) {
		const bv = j.bufferViews[i], pad = (4 - (len % 4)) % 4;
		if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
		const body = repl.get(i) ?? bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
		bv.byteOffset = len; bv.byteLength = body.length;
		chunks.push(body); len += body.length;
	}
	const binAll = new Uint8Array(len); { let o = 0; for (const c of chunks) { binAll.set(c, o); o += c.length; } }
	j.buffers = [{ byteLength: len }];
	let jb = enc.encode(JSON.stringify(j)); { const p = (4 - (jb.length % 4)) % 4; if (p) { const t = new Uint8Array(jb.length + p); t.set(jb); t.fill(0x20, jb.length); jb = t; } }
	const out = new Uint8Array(12 + 8 + jb.length + 8 + binAll.length), dv = new DataView(out.buffer);
	out.set(enc.encode("glTF"), 0); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
	dv.setUint32(12, jb.length, true); out.set(enc.encode("JSON"), 16); out.set(jb, 20);
	const bo = 20 + jb.length; dv.setUint32(bo, binAll.length, true); out.set(enc.encode("BIN\0"), bo + 4); out.set(binAll, bo + 8);
	return out;
}
