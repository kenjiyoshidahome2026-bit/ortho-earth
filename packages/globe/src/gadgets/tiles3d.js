// ガジェット：任意の 3D Tiles を画面上の誤差で流す（#41・2026-09-23・Cesium の 3D Tiles ストリーミング相当）。
//   map.gadget.tiles3d(url, opts) / map.add3DTiles(url, opts) / ?tiles3d=<tileset.json の URL>。
//   選び方＝画面上の誤差（SSE）：タイルの geometricError を今の距離で画面の px に直し、maxSSE（既定 16px）を超えるなら子へ降りる。
//   refine REPLACE＝子が揃うまで親を出したまま（穴を開けない）・ADD＝親も子も描く。外部 tileset（content が .json）はその時に読む。
//   中身（b3dm・i3dm・pnts・cmpt・glb/glTF）は worker（model 役・tiles3d-decode.js）が取りに行って解く＝main は URL と変換行列だけ渡す。
//   三角形＝建物メッシュ（PLATEAU・模型と同じ GPU 経路・noLift＝絶対高さ）・点＝点のオーバーレイ（points-gl.js・原点相対）。
//   GPU に上げたタイルは表示を切り替えるだけで残し（meshVis）、予算（既定 512MB・LOW_MEM 160MB）を超えたら使っていない物から捨てる。
// 高さ＝既定は tileset の高さのまま（絶対高さ・写真測量の街並みや点群）。地形とずれる時は heightOffset[m] で合わせるか、
//   建物の tileset なら ground:"terrain"＝1 棟ずつ最低点で地面に接地（PLATEAU の経路と同じ）。
// 未対応：implicit tiling（3D Tiles 1.1 の subtree）・メタデータとスタイル・楕円体表示（?ell=1）での点群。
import { cameraState } from "@ortho-earth/core";
import pointsUrl from "./points-gl.js?url";

const EARTH_M = 6371000;
const R2D = 180 / Math.PI;
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const m4mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3]; return o; };
const m4pt = (m, v) => [m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12], m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13], m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]];
const m4vec = (m, v) => [m[0]*v[0] + m[4]*v[1] + m[8]*v[2], m[1]*v[0] + m[5]*v[1] + m[9]*v[2], m[2]*v[0] + m[6]*v[1] + m[10]*v[2]];
const len = v => Math.hypot(v[0], v[1], v[2]);
function ecef2geo(x, y, z) {   // meshdecode と同じ（Newton 2 回）
	const a = 6378137, e2 = 0.00669437999014, p = Math.hypot(x, y), lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2)), h = 0;
	for (let i = 0; i < 2; i++) { const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
	return [lon, lat, h];
}
function geo2ecef(lon, lat, h) { const a = 6378137, e2 = 0.00669437999014, s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); return [(N + h) * Math.cos(lat) * Math.cos(lon), (N + h) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h) * s]; }
// ECEF → この地図の世界座標（単位球・メッシュの finishMesh と同じ軸）
const worldOf = (e, baseH) => { const [lon, lat, h] = ecef2geo(e[0], e[1], e[2]), r = 1 + (h - baseH) / EARTH_M, cb = Math.cos(lat); return [cb * Math.cos(lon) * r, Math.sin(lat) * r, cb * Math.sin(lon) * r]; };

// 境界体積 → ECEF の球 { c, r }
function sphereOf(bv, M) {
	if (bv?.box) {
		const b = bv.box, c = m4pt(M, [b[0], b[1], b[2]]);
		const u = m4vec(M, [b[3], b[4], b[5]]), v = m4vec(M, [b[6], b[7], b[8]]), w = m4vec(M, [b[9], b[10], b[11]]);
		return { c, r: Math.sqrt(len(u) ** 2 + len(v) ** 2 + len(w) ** 2) };
	}
	if (bv?.region) {
		const [w, s, e, n, h0, h1] = bv.region, lon = (w + e) / 2, lat = (s + n) / 2, c = geo2ecef(lon, lat, (h0 + h1) / 2);
		let r = 0; for (const x of [w, e]) for (const y of [s, n]) for (const h of [h0, h1]) { const p = geo2ecef(x, y, h); r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])); }
		return { c, r };
	}
	if (bv?.sphere) { const s = bv.sphere, c = m4pt(M, [s[0], s[1], s[2]]); const k = Math.max(len(m4vec(M, [1, 0, 0])), len(m4vec(M, [0, 1, 0])), len(m4vec(M, [0, 0, 1]))); return { c, r: s[3] * k }; }
	return null;
}
// mvp（列優先）から視錐台の 6 面（法線は内向き・正規化）
function planesOf(m) {
	const row = i => [m[i], m[4 + i], m[8 + i], m[12 + i]];
	const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3), out = [];
	for (const [a, sg] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]]) {
		const p = [r3[0] + sg * a[0], r3[1] + sg * a[1], r3[2] + sg * a[2], r3[3] + sg * a[3]], l = Math.hypot(p[0], p[1], p[2]) || 1;
		out.push([p[0] / l, p[1] / l, p[2] / l, p[3] / l]);
	}
	return out;
}

export function createTiles3D(map, { cam, size, dpr, setMesh, meshVis, lowMem = false, signal } = {}) {
	const sets = new Map();   // id → tileset
	let seq = 0, tileSeq = 0;
	// worker（model 役）を 2 本＝取りに行く・解くを並列に。1 本あたり同時 3 件まで
	const workers = [], waiting = new Map();
	let rpcSeq = 0, wi = 0;
	const worker = () => {
		if (workers.length < 2) {
			const w = new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "model" });
			w.onmessage = e => { const p = waiting.get(e.data.id); if (!p) return; waiting.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); };
			w.onerror = e => console.error("[tiles3d] worker error", e.message);
			workers.push(w);
			return w;
		}
		return workers[(wi++) % workers.length];
	};
	const rpc = msg => new Promise((res, rej) => { const id = ++rpcSeq; waiting.set(id, { res, rej }); worker().postMessage({ id, ...msg }); });
	const BUDGET = (lowMem ? 160 : 512) * 1024 * 1024, MAX_INFLIGHT = lowMem ? 3 : 6;
	let inflight = 0, gpuBytes = 0, rafPending = 0;
	const schedule = () => { if (rafPending) return; rafPending = requestAnimationFrame(() => { rafPending = 0; update(); }); };

	const tileNode = (json, parentM, base, set, parent) => {
		const M = json.transform ? m4mul(parentM, json.transform) : parentM;
		const uri = json.content?.uri ?? json.content?.url ?? null;
		const n = { id: ++tileSeq, set, parent, M, ge: json.geometricError ?? 0, refine: (json.refine || parent?.refine || "REPLACE").toUpperCase(),
			sphere: sphereOf(json.boundingVolume, M), uri: uri ? new URL(uri, base).href : null, children: null, json, base,
			state: "none", ward: null, bytes: 0, pts: null, on: false, used: 0, err: 0 };
		if (n.uri && set.query) { const u = new URL(n.uri); for (const [k, v] of set.query) if (!u.searchParams.has(k)) u.searchParams.set(k, v); n.uri = u.href; }   // 親の URL の鍵（?key= 等）を子へ引き継ぐ
		n.external = !!n.uri && /\.json(\?|$)/i.test(n.uri);
		return n;
	};
	const kidsOf = n => n.children ??= (n.json.children || []).map(c => tileNode(c, n.M, n.base, n.set, n));

	// 外部 tileset（content が .json）＝読めたらその根を子にする
	const loadExternal = n => {
		if (n.state !== "none") return;
		n.state = "loading"; inflight++;
		fetch(n.uri, { credentials: "omit" }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then(j => {
			n.children = [tileNode(j.root, n.M, n.uri, n.set, n)];
			n.uri = null; n.external = false; n.state = "ready";
		}).catch(err => { n.state = "failed"; console.warn("[tiles3d] external tileset", n.uri, err.message); })
			.finally(() => { inflight--; schedule(); });
	};
	const load = n => {
		if (n.state !== "none" || inflight >= MAX_INFLIGHT) return;
		n.state = "loading"; inflight++;
		const set = n.set;
		const onGround = set.opts.ground === "terrain";
		rpc({ kind: "tile3d", url: n.uri, transform: n.M, baseH: -set.opts.heightOffset, textures: set.opts.textures !== false, groundMode: onGround ? "terrain" : "absolute" }).then(r => {
			if (set.removed) return;
			n.ward = `t3d:${set.id}:${n.id}`;
			n.bytes = 0;

			r.batches.forEach((b, k) => {
				const m = b.mesh;
				n.bytes += (m.pos?.byteLength || 0) + (m.nrm?.byteLength || 0) + (m.idx?.byteLength || 0) + (m.uv?.byteLength || 0) + (m.col?.byteLength || 0) + (b.tex?.rgba?.byteLength || (b.tex?.bitmap ? b.tex.bitmap.width * b.tex.bitmap.height * 4 : 0));
				setMesh(`${n.ward}#${k}`, { ...m, noLift: !onGround, drape: onGround, keep2d: true, ward: n.ward, tex: b.tex, alphaMode: b.alphaMode, alphaCutoff: b.alphaCutoff, maskBbox: null, maskN: 0 });
			});
			n.meshN = r.batches.length; n.bbox = r.batches[0]?.mesh.bbox?.map(v => +v.toFixed(5)) ?? null;
			if (r.points.length) {
				set.pts ??= map.overlay(pointsUrl, { name: `tiles3d:${set.id}` });
				set.pts.post({ type: "style", size: set.opts.pointSize ?? 1.5, color: [0.85, 0.85, 0.85, 1] });
				n.pts = r.points.map((p, k) => { const q = `${n.id}:${k}`; n.bytes += p.pos.byteLength + p.rgba.byteLength; set.pts.post({ type: "layer", q, n: p.n, pos: p.pos, rgba: p.rgba, origin: p.origin }, [p.pos.buffer, p.rgba.buffer]); return q; });
			}
			gpuBytes += n.bytes; set.stats.loaded++; set.stats.triangles += r.stats.triangles; set.stats.points += r.stats.points; set.stats.bytes += r.stats.bytes || 0;
			n.state = "ready"; n.on = true;   // 上げた直後は見えている（次の update で要らなければ消す）
		}).catch(err => { n.state = "failed"; n.err++; set.stats.failed++; console.warn("[tiles3d] tile", n.uri, err.message); })
			.finally(() => { inflight--; schedule(); });
	};
	const unload = n => {
		if (n.state !== "ready") return;
		if (n.ward) setMesh(n.ward, null);
		if (n.pts) for (const q of n.pts) n.set.pts?.post({ type: "remove", q });
		gpuBytes -= n.bytes; n.bytes = 0; n.pts = null; n.ward = null; n.state = "none"; n.on = false; n.set.stats.loaded--;
	};
	const setOn = (n, on) => {
		if (n.on === on || n.state !== "ready") return;
		n.on = on;
		if (n.ward) meshVis(n.ward, on);
		if (n.pts) for (const q of n.pts) n.set.pts?.post({ type: "vis", q, on });
	};

	// 選び（毎移動・rAF に畳む）
	let frameNo = 0;
	function update() {
		if (!sets.size) return;
		frameNo++;
		const W = size().w, H = size().h, s = cameraState(cam, W, H), planes = planesOf(s.mvp), eye = s.eye, fpx = s.focal / (cam.dpr || dpr || 1);
		const want = [];   // 読みたいタイル（優先度＝SSE）
		for (const set of sets.values()) {
			if (!set.root || set.hidden) continue;
			const show = new Set();
			const baseH = -set.opts.heightOffset, maxSSE = set.opts.maxSSE ?? (lowMem ? 24 : 16);
			const visible = n => {
				if (!n.sphere) return { ok: true, dist: 1 };
				const c = worldOf(n.sphere.c, baseH), r = n.sphere.r / EARTH_M;
				for (const p of planes) if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return { ok: false };
				// 地平線の向こう（球の裏側）＝地平面（接点の面 dot(X,E)=1）より向こうに境界球ごと居る
				const d = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]], dl = len(d), el = len(eye);
				if (el > 1 && (c[0] * eye[0] + c[1] * eye[1] + c[2] * eye[2]) / el + r < 1 / el) return { ok: false };
				return { ok: true, dist: Math.max(1e-9, dl - r) * EARTH_M };
			};
			const walk = (n, out) => {   // 戻り＝描くべき物が全部揃ったか
				const v = visible(n);
				if (!v.ok) return true;
				n.used = frameNo;
				const sse = n.ge * fpx / v.dist;
				if (n.external) { if (n.state === "none") loadExternal(n); return n.state === "failed"; }
				const kids = kidsOf(n);
				const leaf = !kids.length || (sse <= maxSSE && !!n.uri);   // 中身を持たない節点（外部 tileset の口・空の根）は子へ降りる
				const need = x => { if (x.state === "none") want.push({ n: x, pri: sse }); return x.state === "ready" || x.state === "failed"; };
				if (leaf) { if (!n.uri) return true; const ok = need(n); if (n.state === "ready") out.push(n); return ok; }
				if (n.refine === "ADD") {
					let ok = true;
					if (n.uri) { ok = need(n); if (n.state === "ready") out.push(n); }
					for (const k of kids) ok = walk(k, out) && ok;
					return ok;
				}
				const mark = out.length;
				let all = true;
				for (const k of kids) all = walk(k, out) && all;
				if (all) return true;
				if (n.uri) {   // 子が揃うまで親を出す（揃った子は伏せる＝重ねない）
					need(n);
					if (n.state === "ready") { out.length = mark; out.push(n); return true; }
					return false;
				}
				return false;
			};
			const out = [];
			walk(set.root, out);
			for (const n of out) show.add(n);
			// 出す/伏せる
			for (const n of set.loaded()) setOn(n, show.has(n));
			set.stats.shown = show.size;
		}
		// 読む（SSE の大きい＝粗すぎて目立つ物から）
		want.sort((a, b) => b.pri - a.pri);
		for (const { n } of want) { if (inflight >= MAX_INFLIGHT) break; load(n); }
		// 予算＝使っていない物（今回選ばれず表示もしていない）から古い順に捨てる
		if (gpuBytes > BUDGET) {
			const cand = [...sets.values()].flatMap(s2 => s2.loaded()).filter(n => !n.on).sort((a, b) => a.used - b.used);
			for (const n of cand) { if (gpuBytes <= BUDGET * 0.85) break; unload(n); }
		}
	}

	const onMove = () => schedule();
	map.on("move", onMove); map.on("settle", onMove);
	const ctl = {
		// url＝tileset.json。opts＝{ maxSSE:16, heightOffset:0（m・高さへの足し込み）, ground:"absolute"|"terrain"（1 棟ずつ地面へ接地）, pointSize:1.5（px）, textures:true, fit:true（寄る）}
		async add(url, opts = {}) {
			const abs = new URL(url, location.href);
			const r = await fetch(abs.href, { credentials: "omit" });
			if (!r.ok) throw new Error(`tileset HTTP ${r.status}`);
			const j = await r.json();
			if (!j.root) throw new Error("not a 3D Tiles tileset (no root)");
			const id = opts.id ?? `t${++seq}`;
			if (sets.has(id)) ctl.remove(id);
			const set = { id, url: abs.href, opts: { heightOffset: 0, ...opts }, stats: { loaded: 0, shown: 0, failed: 0, triangles: 0, points: 0, bytes: 0 }, query: [...abs.searchParams], pts: null, removed: false, hidden: false, asset: j.asset };
			set.root = tileNode(j.root, I4, abs.href, set, null);
			if (!set.root.ge) set.root.ge = j.geometricError ?? 0;
			const all = function* (n) { if (!n) return; yield n; for (const k of n.children || []) yield* all(k); };
			set.loaded = () => [...all(set.root)].filter(n => n.state === "ready" && (n.ward || n.pts));
			sets.set(id, set);
			const sp = set.root.sphere;
			if (opts.fit !== false && sp) {   // 寄る＝境界球が画面に収まる所へ（傾けて）
				const [lon, lat] = ecef2geo(sp.c[0], sp.c[1], sp.c[2]);
				const z = Math.log2(Math.min(size().w, size().h) / (cam.dpr || dpr || 1) * 360 / (256 * Math.max(1e-6, 2.4 * sp.r / 111320)));
				map.flyTo(lon * R2D, lat * R2D, Math.max(2, Math.min(18, z)), 50);
			}
			schedule();
			return { id, get stats() { return { ...set.stats, gpuMB: +(gpuBytes / 1048576).toFixed(1), inflight } }, get bbox() { return sp ? (() => { const [lo, la] = ecef2geo(sp.c[0], sp.c[1], sp.c[2]), d = sp.r / 111320; return [lo * R2D - d / Math.cos(la), la * R2D - d, lo * R2D + d / Math.cos(la), la * R2D + d]; })() : null; },
				get tiles() { return set.loaded().map(n => ({ id: n.id, uri: n.uri?.split("/").pop(), on: n.on, ward: n.ward, meshes: n.meshN, pts: n.pts?.length || 0, bbox: n.bbox })); },   // 検分用
				remove: () => ctl.remove(id), setVisible: v => { set.hidden = !v; for (const n of set.loaded()) setOn(n, false); schedule(); },
				setOptions: o => { Object.assign(set.opts, o); schedule(); } };
		},
		remove(id) {
			const set = sets.get(id); if (!set) return;
			set.removed = true;
			for (const n of set.loaded()) unload(n);
			set.pts?.remove();
			sets.delete(id);
		},
		get ids() { return [...sets.keys()]; },
		destroy() { for (const id of [...sets.keys()]) ctl.remove(id); for (const w of workers) w.terminate(); workers.length = 0; map.off("move", onMove); map.off("settle", onMove); },
	};
	signal?.addEventListener("abort", () => ctl.destroy(), { once: true });
	return ctl;
}
