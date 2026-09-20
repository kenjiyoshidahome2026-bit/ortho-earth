// 複数の glb（3D Tiles の b3dm から抜いた物＝CESIUM_RTC 付き）を 1 枚の glb に束ねる。依存ゼロ・中身は解かない
// （Draco 圧縮も webp テクスチャも bufferView の中身のまま運ぶ＝番号の付け替えだけ）。
// 位置合わせ：CESIUM_RTC は「ECEF の平行移動」＝各 glb を (rtc_i − rtc_0) だけずらして束ね、束の RTC は rtc_0。
// glTF は Y-up・RTC は ECEF なので、ずらし量は SWAP⁻¹（(x,y,z)→(x,z,−y)）を通す。
const dec = new TextDecoder(), enc = new TextEncoder();
export function parseGlb(glb) {
	const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	if (dec.decode(glb.subarray(0, 4)) !== "glTF") throw new Error("not glb");
	const total = dv.getUint32(8, true);
	let off = 12, json = null, bin = new Uint8Array(0);
	while (off + 8 <= total) {
		const len = dv.getUint32(off, true), type = dec.decode(glb.subarray(off + 4, off + 8));
		const body = glb.subarray(off + 8, off + 8 + len);
		if (type.startsWith("JSON")) json = JSON.parse(dec.decode(body)); else bin = body;
		off += 8 + len + ((4 - (len % 4)) % 4) * 0;   // チャンクは 4 byte 境界で詰められている（len は境界込み）
	}
	return { json, bin };
}
const remapTexRefs = (o, tex) => {   // material 内のテクスチャ参照を付け替える（再帰）
	if (!o || typeof o !== "object") return;
	if (typeof o.index === "number" && ("texCoord" in o || "scale" in o || "strength" in o || Object.keys(o).length <= 2)) o.index = tex(o.index);
	for (const v of Object.values(o)) remapTexRefs(v, tex);
};
export function mergeGlb(parts) {   // parts＝[Uint8Array]（最初の RTC が束の基準）
	const out = { asset: { version: "2.0", generator: "ortho-earth tiles3d merge" }, scene: 0, scenes: [{ nodes: [] }],
		nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], images: [], textures: [], samplers: [], buffers: [{ byteLength: 0 }] };
	const used = new Set(), required = new Set();
	const bins = []; let binLen = 0, rtc0 = null;
	for (const raw of parts) {
		const { json: g, bin } = parseGlb(raw);
		const rtc = g.extensions?.CESIUM_RTC?.center || null;
		if (!rtc0 && rtc) rtc0 = rtc;
		for (const e of g.extensionsUsed || []) if (e !== "CESIUM_RTC" && e !== "EXT_texture_webp") used.add(e);
		for (const e of g.extensionsRequired || []) if (e !== "CESIUM_RTC" && e !== "EXT_texture_webp") required.add(e);
		const pad = (4 - (binLen % 4)) % 4;
		if (pad) { bins.push(new Uint8Array(pad)); binLen += pad; }
		const base = binLen; bins.push(bin); binLen += bin.length;
		const bv0 = out.bufferViews.length, ac0 = out.accessors.length, mt0 = out.materials.length,
			tx0 = out.textures.length, im0 = out.images.length, sm0 = out.samplers.length, ms0 = out.meshes.length, nd0 = out.nodes.length;
		for (const v of g.bufferViews || []) out.bufferViews.push({ ...v, buffer: 0, byteOffset: (v.byteOffset || 0) + base });
		for (const a of g.accessors || []) out.accessors.push(a.bufferView == null ? { ...a } : { ...a, bufferView: a.bufferView + bv0 });
		for (const s of g.samplers || []) out.samplers.push({ ...s });
		for (const im of g.images || []) out.images.push(im.bufferView == null ? { ...im } : { ...im, bufferView: im.bufferView + bv0 });
		for (const t of g.textures || []) { const c = { ...t };
			if (c.source != null) c.source += im0;
			if (c.sampler != null) c.sampler += sm0;
			if (c.extensions?.EXT_texture_webp?.source != null) c.extensions = { ...c.extensions, EXT_texture_webp: { source: c.extensions.EXT_texture_webp.source + im0 } };
			// webp のテクスチャ（EXT_texture_webp）は素の source へ畳み、拡張そのものを落とす。
			// ＝拡張を解さない読み手（loaders.gl の worker で webp 対応判定が立たない場合を含む）でも普通の texture として画像に辿り着ける。
			// glb の中身は webp のまま＝ブラウザの createImageBitmap が解く。
			if (c.extensions?.EXT_texture_webp?.source != null) { if (c.source == null) c.source = c.extensions.EXT_texture_webp.source;
				const e = { ...c.extensions }; delete e.EXT_texture_webp; c.extensions = Object.keys(e).length ? e : undefined; }
			out.textures.push(c); }
		for (const m of g.materials || []) { const c = JSON.parse(JSON.stringify(m)); remapTexRefs(c, i => i + tx0); out.materials.push(c); }
		for (const me of g.meshes || []) {
			const prims = (me.primitives || []).map(p => { const c = JSON.parse(JSON.stringify(p));
				c.attributes = Object.fromEntries(Object.entries(p.attributes || {}).map(([k, v]) => [k, v + ac0]));
				if (c.indices != null) c.indices += ac0;
				if (c.material != null) c.material += mt0;
				const d = c.extensions?.KHR_draco_mesh_compression;
				if (d) { d.bufferView += bv0; d.attributes = Object.fromEntries(Object.entries(d.attributes || {})); }
				return c; });
			out.meshes.push({ ...me, primitives: prims });
		}
		for (const n of g.nodes || []) { const c = { ...n };
			if (c.mesh != null) c.mesh += ms0;
			if (c.children) c.children = c.children.map(i => i + nd0);
			out.nodes.push(c); }
		const roots = (g.scenes?.[g.scene ?? 0]?.nodes ?? g.nodes.map((_, i) => i)).map(i => i + nd0);
		const d = rtc && rtc0 ? [rtc[0] - rtc0[0], rtc[1] - rtc0[1], rtc[2] - rtc0[2]] : [0, 0, 0];
		const t = [d[0], d[2], -d[1]];   // SWAP⁻¹：ECEF のずれ → glTF Y-up のずれ
		out.nodes.push({ translation: t, children: roots });
		out.scenes[0].nodes.push(out.nodes.length - 1);
	}
	if (rtc0) { out.extensions = { CESIUM_RTC: { center: rtc0 } }; used.add("CESIUM_RTC"); required.add("CESIUM_RTC"); }
	if (used.size) out.extensionsUsed = [...used];
	required.delete("EXT_texture_webp");   // 素の source を張った＝必須にしない（対応しない読み手を弾かない）
	if (required.size) out.extensionsRequired = [...required];
	const binAll = new Uint8Array(binLen); { let o = 0; for (const b of bins) { binAll.set(b, o); o += b.length; } }
	out.buffers[0].byteLength = binLen;
	let jb = enc.encode(JSON.stringify(out)); { const p = (4 - (jb.length % 4)) % 4; if (p) { const t = new Uint8Array(jb.length + p); t.set(jb); t.fill(0x20, jb.length); jb = t; } }
	const glb = new Uint8Array(12 + 8 + jb.length + 8 + binAll.length), dv = new DataView(glb.buffer);
	glb.set(enc.encode("glTF"), 0); dv.setUint32(4, 2, true); dv.setUint32(8, glb.length, true);
	dv.setUint32(12, jb.length, true); glb.set(enc.encode("JSON"), 16); glb.set(jb, 20);
	const bo = 20 + jb.length;
	dv.setUint32(bo, binAll.length, true); glb.set(enc.encode("BIN\0"), bo + 4); glb.set(binAll, bo + 8);
	return glb;
}
