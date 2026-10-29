// glTF/GLB 直読みの worker（gadgets/model.js の相方・2026-09-20）。ArrayBuffer を受け、meshdecode の decodeModel
// （loaders.gl の遅延チャンク＋PLATEAU と同じ後段）で建物メッシュにして返す＝main は解析で塞がない。
// PLATEAU の worker/デコーダプールとは独立＝建物 3D が停止（opts.mesh=false）でも模型は立つ。
// 返すのはマテリアルごとのバッチ列（uv・頂点色・テクスチャ画像つき）＝ImageBitmap も transfer で渡す（コピーしない）。
// kind:"extrude"＝任意ポリゴンの押し出し（extrude.js・2026-09-21）。返す形は模型と同じ（バッチ 1 本・テクスチャ無し）。
import { decodeModel, setDecodeEnv, setTextureTranscoders } from "./meshdecode.ts";
import { extrudeMesh } from "./extrude.ts";
import { decodeTile3D } from "./tiles3d-decode.ts";   // 3D Tiles のタイル（#41）＝kind:"tile3d"
import { i3sOpen, i3sNodes, i3sContent } from "./i3s-decode.ts";
import { computeSunShadow, computeViewshed } from "./sunshadow.ts";   // 日影・可視域・見通し線（#44）＝kind:"sunshadow"/"viewshed"   // I3S（#48）＝kind:"i3sOpen"/"i3sNodes"/"i3sContent"（loaders.gl の i3s は最初に使う時だけ読む）
import type { SunShadowOptions, ViewshedOptions } from "./sunshadow.ts";

import type { ExtrudeInPoly } from "./extrude.ts";
import type { MeshOut, TexOut, VoxelTileOpts } from "./meshdecode.ts";

/** main からの仕事（kind 省略＝模型の glTF/GLB） */
interface ModelJob {
	id: number; kind?: "extrude" | "viewshed" | "sunshadow" | "i3sOpen" | "i3sNodes" | "i3sContent" | "tile3d";
	ab?: ArrayBuffer; at?: ArrayLike<number> | null; heading?: number; scale?: number; baseUri?: string | null; ell?: boolean; textures?: boolean; ground?: string; mask?: boolean; featureIdSet?: number; mc?: boolean;
	polys?: ExtrudeInPoly[]; refine?: number; transcoders?: unknown; opts?: Record<string, unknown>;
	url?: string; token?: string; ids?: Array<number | string>; nodeId?: number | string; baseH?: number; groundMode?: string;
	transform?: ArrayLike<number> | null; headers?: Record<string, string>; credentials?: RequestCredentials; maxInstances?: number; splats?: boolean; voxels?: boolean | VoxelTileOpts;
}
/** transfer を集める束（模型・3D Tiles・I3S・押し出しの batches） */
type XferBatch = { mesh: MeshOut; features?: { ids?: ArrayBufferView | null; tblV?: ArrayLike<number> | null; tex?: { ids: ArrayBufferView } | null } | null; tex?: TexOut | null; texMR?: TexOut | null; texN?: TexOut | null; texOcc?: TexOut | null; texEm?: TexOut | null; meta?: { texs: (TexOut | null)[] } | null; skin?: Array<{ P: ArrayBufferView; N?: ArrayBufferView | null; J: ArrayBufferView; W: ArrayBufferView }> | null };

const TEX_KEYS = ["tex", "texMR", "texN", "texOcc", "texEm"] as const;   // 模型のテクスチャ（baseColor＋#46 段 2 の材質 4 枚）＝transfer の対象
const transferOf = (batches: XferBatch[]): Transferable[] => {   // skin の区間（P/N/J/W・2026-10-28）も transfer
	const tr = new Set<Transferable>();
	for (const b of batches) { for (const t of b.meta?.texs || []) { if (t?.bitmap) tr.add(t.bitmap); if (t?.rgba) tr.add(t.rgba.buffer as ArrayBuffer); } for (const k of ["pos", "nrm", "idx", "uv", "col", "mc", "uvm"] as const) if (b.mesh[k]?.buffer) tr.add(b.mesh[k]!.buffer as ArrayBuffer); if (b.features?.ids) tr.add(b.features.ids.buffer as ArrayBuffer); if (b.features?.tex) tr.add(b.features.tex.ids.buffer as ArrayBuffer); for (const sg of b.skin || []) for (const a of [sg.P, sg.N, sg.J, sg.W]) if (a?.buffer) tr.add(a.buffer as ArrayBuffer); if (b.features?.tblV) tr.add((b.features.tblV as Int16Array).buffer as ArrayBuffer); for (const k of TEX_KEYS) { if (b[k]?.bitmap) tr.add(b[k]!.bitmap!); if (b[k]?.rgba) tr.add(b[k]!.rgba!.buffer as ArrayBuffer); } }
	return [...tr];
};

// 楕円体の状態（meshdecode のモジュール状態＝finishMesh・geoWorld が読む）は worker 全体で 1 つ（#43・2026-09-28）。
// 仕事は await（取得・画像の復号）を挟んで並行に進む＝違うモードの仕事が同時に走ると、後から来た方が状態を書き換えて先の方の置き方が変わる
// （楕円体の 3D Tiles のタイルを解いている間に日影の計算＝球 が割り込む→どちらかが約 10km ずれる）。
// 関所＝同じモードの仕事は並行のまま・違うモードは前の仕事が全部抜けるまで待つ。先着順（頭が違うモードなら後ろの同じモードも待つ＝飢えない）。
const gate = { cur: false, inflight: 0, q: [] as Array<{ ell: boolean; go: (v?: unknown) => void }> };
const pump = () => {
	while (gate.q.length && (gate.inflight === 0 || gate.q[0].ell === gate.cur)) {
		const r = gate.q.shift()!;
		if (gate.inflight === 0) { gate.cur = r.ell; setDecodeEnv({ ell: r.ell }); }
		gate.inflight++; r.go();
	}
};
const enter = (ell: boolean) => new Promise(go => { gate.q.push({ ell, go }); pump(); });
const leave = () => { gate.inflight--; pump(); };
// 仕事の種類 → 楕円体のモード（null＝メッシュを置かない＝関所を通らない）。日影・可視域は球で解いて球の式で経緯度へ戻す＝常に球
const modeOf = (d: ModelJob) => d.kind === "sunshadow" || d.kind === "viewshed" ? false : d.kind === "i3sOpen" || d.kind === "i3sNodes" ? null : !!d.ell;

self.onmessage = async (e: MessageEvent<ModelJob>) => {
	const mode = modeOf(e.data);
	if (mode === null) return work(e);
	await enter(mode);
	try { await work(e); } finally { leave(); }
};
async function work(e: MessageEvent<ModelJob>) {
	const { id, kind, ab, at, heading, scale, baseUri, ell, textures, ground, mask, polys } = e.data;
	try {
		if ("transcoders" in e.data) setTextureTranscoders(e.data.transcoders);   // registry.textureTranscoders の写し（W5）＝模型・3D Tiles の KTX2
		if (kind === "extrude") {
			const r = extrudeMesh(polys!, { mask: mask !== false, refine: e.data.refine ?? 1500 });   // refine＝屋根の細分の刻み(m)（沿わせる=1500・平面=20000）
			if (!r) { self.postMessage({ id, error: "no-triangles" }); return; }
			const batches = [{ mesh: r.mesh, tex: null, alphaMode: "OPAQUE", alphaCutoff: 0.5 }];
			self.postMessage({ id, batches, mask: r.mask, stats: r.stats }, transferOf(batches));
			return;
		}
		if (kind === "viewshed") { const r = await computeViewshed(e.data.opts as unknown as ViewshedOptions); self.postMessage({ id, ...r }, [r.rgba.buffer]); return; }
		if (kind === "sunshadow") { const r = await computeSunShadow(e.data.opts as unknown as SunShadowOptions); self.postMessage({ id, ...r }, [r.rgba.buffer]); return; }
		if (kind === "i3sOpen") { self.postMessage({ id, ...(await i3sOpen(e.data.url!, e.data.token)) }); return; }
		if (kind === "i3sNodes") { self.postMessage({ id, nodes: await i3sNodes(e.data.url!, e.data.ids!, e.data.token) }); return; }
		if (kind === "i3sContent") {
			const r = await i3sContent(e.data.url!, e.data.nodeId!, { baseH: e.data.baseH ?? 0, ground: e.data.groundMode, token: e.data.token });
			self.postMessage({ id, batches: r.batches, points: [], stats: r.stats }, transferOf(r.batches));
			return;
		}
		if (kind === "tile3d") {   // 3D Tiles のタイル＝worker が取りに行く（main は URL と変換だけ渡す）
			const { url, transform, baseH, groundMode, headers, credentials } = e.data;
			let buf: ArrayBuffer | undefined = e.data.ab;   // 独自スキーム（addProtocol）＝main が取った本体（#37）
			if (!buf) {
				const res = await fetch(url!, { credentials: credentials || "omit", ...(headers ? { headers } : {}), signal: AbortSignal.timeout(30000) });   // headers/credentials＝transformRequest
				if (!res.ok) { self.postMessage({ id, error: `HTTP ${res.status}` }); return; }
				buf = await res.arrayBuffer();
			}
			const r = await decodeTile3D(buf, { transform, baseUri: url, baseH: baseH ?? 0, textures: textures !== false, maxInstances: e.data.maxInstances ?? 5000, ground: groundMode, featureIdSet: e.data.featureIdSet ?? 0, mc: !!e.data.mc, splats: !!e.data.splats, voxels: e.data.voxels ?? false, fetchOpts: headers || credentials ? { headers: headers ?? null, credentials: credentials ?? null } : null });
			if (!r) { self.postMessage({ id, batches: [], points: [], splats: [], voxels: [], stats: { triangles: 0, points: 0, splats: 0, splatPoints: 0, voxels: 0, voxelsSkipped: 0, bytes: buf.byteLength } }); return; }
			r.stats.bytes = buf.byteLength;
			const tr = transferOf(r.batches); for (const p of r.points) tr.push(p.pos.buffer, p.rgba.buffer);
			for (const s of r.splats) { for (const a of [s.positions, s.scales, s.rotations, s.colors, s.sh, s.spz]) if (a && a.byteLength && !tr.includes(a.buffer as ArrayBuffer)) tr.push(a.buffer as ArrayBuffer); }   // splat の配列も transfer（spz＝bufferView の写し）
			for (const v of r.voxels) if (!tr.includes(v.values.buffer as ArrayBuffer)) tr.push(v.values.buffer as ArrayBuffer);   // voxel の値も transfer
			self.postMessage({ id, batches: r.batches, points: r.points, splats: r.splats, voxels: r.voxels, stats: r.stats }, tr);
			return;
		}
		const r = await decodeModel(ab!, { at, heading, scale, baseUri, textures: textures !== false, ground, mask, featureIdSet: e.data.featureIdSet ?? 0, mc: !!e.data.mc });
		if (!r) { self.postMessage({ id, error: "no-triangles" }); return; }
		self.postMessage({ id, batches: r.batches, mask: r.mask, stats: r.stats, rig: r.rig || null, place: r.place || null }, transferOf(r.batches));   // rig/place＝rigid アニメ（W4）
	} catch (err) { self.postMessage({ id, error: (err as Error)?.message || String(err) }); }
}
