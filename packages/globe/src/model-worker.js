// glTF/GLB 直読みの worker（gadgets/model.js の相方・2026-09-20）。ArrayBuffer を受け、meshdecode の decodeModel
// （loaders.gl の遅延チャンク＋PLATEAU と同じ後段）で建物メッシュにして返す＝main は解析で塞がない。
// PLATEAU の worker/デコーダプールとは独立＝建物 3D が停止（opts.mesh=false）でも模型は立つ。
// 返すのはマテリアルごとのバッチ列（uv・頂点色・テクスチャ画像つき）＝ImageBitmap も transfer で渡す（コピーしない）。
// kind:"extrude"＝任意ポリゴンの押し出し（extrude.js・2026-09-21）。返す形は模型と同じ（バッチ 1 本・テクスチャ無し）。
import { decodeModel, setDecodeEnv } from "./meshdecode.js";
import { extrudeMesh } from "./extrude.js";
import { decodeTile3D } from "./tiles3d-decode.js";   // 3D Tiles のタイル（#41）＝kind:"tile3d"
import { i3sOpen, i3sNodes, i3sContent } from "./i3s-decode.js";
import { computeSunShadow, computeViewshed } from "./sunshadow.js";   // 日影・可視域・見通し線（#44）＝kind:"sunshadow"/"viewshed"   // I3S（#48）＝kind:"i3sOpen"/"i3sNodes"/"i3sContent"（loaders.gl の i3s は最初に使う時だけ読む）

export const TEX_KEYS = ["tex", "texMR", "texN", "texOcc", "texEm"];   // 模型のテクスチャ（baseColor＋#46 段 2 の材質 4 枚）＝transfer の対象
const transferOf = batches => {
	const tr = new Set();
	for (const b of batches) { for (const k of ["pos", "nrm", "idx", "uv", "col"]) if (b.mesh[k]?.buffer) tr.add(b.mesh[k].buffer); for (const k of TEX_KEYS) { if (b[k]?.bitmap) tr.add(b[k].bitmap); if (b[k]?.rgba) tr.add(b[k].rgba.buffer); } }
	return [...tr];
};

// 楕円体の状態（meshdecode のモジュール状態＝finishMesh・geoWorld が読む）は worker 全体で 1 つ（#43・2026-09-28）。
// 仕事は await（取得・画像の復号）を挟んで並行に進む＝違うモードの仕事が同時に走ると、後から来た方が状態を書き換えて先の方の置き方が変わる
// （楕円体の 3D Tiles のタイルを解いている間に日影の計算＝球 が割り込む→どちらかが約 10km ずれる）。
// 関所＝同じモードの仕事は並行のまま・違うモードは前の仕事が全部抜けるまで待つ。先着順（頭が違うモードなら後ろの同じモードも待つ＝飢えない）。
const gate = { cur: false, inflight: 0, q: [] };
const pump = () => {
	while (gate.q.length && (gate.inflight === 0 || gate.q[0].ell === gate.cur)) {
		const r = gate.q.shift();
		if (gate.inflight === 0) { gate.cur = r.ell; setDecodeEnv({ ell: r.ell }); }
		gate.inflight++; r.go();
	}
};
const enter = ell => new Promise(go => { gate.q.push({ ell, go }); pump(); });
const leave = () => { gate.inflight--; pump(); };
// 仕事の種類 → 楕円体のモード（null＝メッシュを置かない＝関所を通らない）。日影・可視域は球で解いて球の式で経緯度へ戻す＝常に球
const modeOf = d => d.kind === "sunshadow" || d.kind === "viewshed" ? false : d.kind === "i3sOpen" || d.kind === "i3sNodes" ? null : !!d.ell;

self.onmessage = async e => {
	const mode = modeOf(e.data);
	if (mode === null) return work(e);
	await enter(mode);
	try { await work(e); } finally { leave(); }
};
async function work(e) {
	const { id, kind, ab, at, heading, scale, baseUri, ell, textures, ground, mask, polys } = e.data;
	try {
		if (kind === "extrude") {
			const r = extrudeMesh(polys, { mask: mask !== false, refine: e.data.refine ?? 1500 });   // refine＝屋根の細分の刻み(m)（沿わせる=1500・平面=20000）
			if (!r) { self.postMessage({ id, error: "no-triangles" }); return; }
			const batches = [{ mesh: r.mesh, tex: null, alphaMode: "OPAQUE", alphaCutoff: 0.5 }];
			self.postMessage({ id, batches, mask: r.mask, stats: r.stats }, transferOf(batches));
			return;
		}
		if (kind === "viewshed") { const r = await computeViewshed(e.data.opts); self.postMessage({ id, ...r }, [r.rgba.buffer]); return; }
		if (kind === "sunshadow") { const r = await computeSunShadow(e.data.opts); self.postMessage({ id, ...r }, [r.rgba.buffer]); return; }
		if (kind === "i3sOpen") { self.postMessage({ id, ...(await i3sOpen(e.data.url, e.data.token)) }); return; }
		if (kind === "i3sNodes") { self.postMessage({ id, nodes: await i3sNodes(e.data.url, e.data.ids, e.data.token) }); return; }
		if (kind === "i3sContent") {
			const r = await i3sContent(e.data.url, e.data.nodeId, { baseH: e.data.baseH ?? 0, ground: e.data.groundMode, token: e.data.token });
			self.postMessage({ id, batches: r.batches, points: [], stats: r.stats }, transferOf(r.batches));
			return;
		}
		if (kind === "tile3d") {   // 3D Tiles のタイル＝worker が取りに行く（main は URL と変換だけ渡す）
			const { url, transform, baseH, groundMode, headers, credentials } = e.data;
			let buf = e.data.ab;   // 独自スキーム（addProtocol）＝main が取った本体（#37）
			if (!buf) {
				const res = await fetch(url, { credentials: credentials || "omit", ...(headers ? { headers } : {}), signal: AbortSignal.timeout(30000) });   // headers/credentials＝transformRequest
				if (!res.ok) { self.postMessage({ id, error: `HTTP ${res.status}` }); return; }
				buf = await res.arrayBuffer();
			}
			const r = await decodeTile3D(buf, { transform, baseUri: url, baseH: baseH ?? 0, textures: textures !== false, maxInstances: e.data.maxInstances ?? 5000, ground: groundMode });
			if (!r) { self.postMessage({ id, batches: [], points: [], stats: { triangles: 0, points: 0, bytes: buf.byteLength } }); return; }
			r.stats.bytes = buf.byteLength;
			const tr = transferOf(r.batches); for (const p of r.points) tr.push(p.pos.buffer, p.rgba.buffer);
			self.postMessage({ id, batches: r.batches, points: r.points, stats: r.stats }, tr);
			return;
		}
		const r = await decodeModel(ab, { at, heading, scale, baseUri, textures: textures !== false, ground, mask });
		if (!r) { self.postMessage({ id, error: "no-triangles" }); return; }
		self.postMessage({ id, batches: r.batches, mask: r.mask, stats: r.stats }, transferOf(r.batches));
	} catch (err) { self.postMessage({ id, error: err?.message || String(err) }); }
}
