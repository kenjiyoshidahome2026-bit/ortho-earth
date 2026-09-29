// 公式例の門（台帳 §8）の比べる部品＝純関数だけ（node の検定 tests/mlexamples-compare.mjs で確かめる）。
// 段 1 の分：PNG を読む・標本点の色（5×5 の中央値）・同じ側の 2 回の走りの突き合わせ（揺れの無い例の選別）。
// 段 4 で：本物とこちらの位置合わせ・段の判定を足す。
import zlib from "node:zlib";

// ── PNG（Chrome の captureScreenshot＝8bit・非インターレース）→ { w, h, rgba } ──
export function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
	let off = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0;
	const idat = [];
	while (off < buf.length) {
		const len = buf.readUInt32BE(off), type = buf.toString("latin1", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; inter = data[12]; }
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		off += 12 + len;
	}
	const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
	if (depth !== 8 || !ch || inter) throw new Error(`unsupported PNG (depth ${depth} type ${ctype} interlace ${inter})`);
	const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = new Uint8Array(w * h * 4);
	let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let i = 0; i < stride; i++) {
			const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
			let v = row[i];
			if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			cur[i] = v & 255;
		}
		for (let x = 0; x < w; x++) {
			const o = (y * w + x) * 4, s = x * ch;
			if (ch === 1 || ch === 2) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = ch === 2 ? cur[s + 1] : 255; }
			else { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = ch === 4 ? cur[s + 3] : 255; }
		}
		[prev, cur] = [cur, prev];
	}
	return { w, h, rgba: out };
}

// 点のまわり (2r+1)² の画素の、明るさの中央値の画素の色（外れる点は null）。中央値＝注記の細い字・線の縁の 1 画素に引かれない
export function sampleMedian(img, x, y, r = 2) {
	const cx = Math.round(x), cy = Math.round(y);
	if (cx - r < 0 || cy - r < 0 || cx + r >= img.w || cy + r >= img.h) return null;
	const px = [];
	for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
		const o = ((cy + j) * img.w + (cx + i)) * 4;
		px.push([img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]]);
	}
	px.sort((p, q) => (p[0] * 299 + p[1] * 587 + p[2] * 114) - (q[0] * 299 + q[1] * 587 + q[2] * 114));
	return px[px.length >> 1];
}

// 色の距離＝RGB のユークリッド（0〜441）。知覚の差ではないが、同じ絵かどうかの門には足りる（閾値は段 5 で本人の目で決める）
export const colorDist = (a, b) => (a && b) ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : null;

// 標本点ごとの色（probes＝[{x,y,…}]・x,y は容れ物の左上原点の CSS px＝canvas だけの写しと同じ座標）
export const probeColors = (img, probes, r = 2) => probes.map(p => sampleMedian(img, p.x, p.y, r));

// 問い合わせの集合の鍵（層・source・source-layer）。symbol の層は注記の衝突で揺れる＝外す（段 2 の判定と同じ）。
// id は鍵に入れない：OpenMapTiles の地物の id はタイルのズームごとに違う＝タイルの詳しさの選び方（緯度の差）で変わる＝答えの差ではない（最初の走り o2 で 72＋35＋24 点）
export const featKey = f => `${f.layer}|${f.source ?? ""}|${f.sourceLayer ?? ""}`;
export const featSet = (feats, { dropSymbol = true } = {}) => [...new Set((feats || []).filter(f => !(dropSymbol && f.type === "symbol")).map(featKey))].sort();
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 同じ側の 2 回の走り（run＝走らせ台の 1 例の記録 JSON＋色）を突き合わせる。戻り＝{ stable, reasons[], maxDist, p95 }
export function diffRuns(a, b, { tolColor = 24, tolCam = 1e-6 } = {}) {
	const reasons = [];
	if (!!a.map !== !!b.map) return { stable: false, reasons: ["map 有無が違う"] };
	if (!a.map) return { stable: true, reasons: [] };
	const la = (a.layers || []).map(l => l.id), lb = (b.layers || []).map(l => l.id);
	if (!sameArr(la, lb)) reasons.push("layers");
	const ca = a.camera, cb = b.camera;
	if (ca && cb && ["lng", "lat", "zoom", "bearing", "pitch"].some(k => Math.abs(ca[k] - cb[k]) > tolCam)) reasons.push("camera");
	let qd = 0;
	const n = Math.min(a.probes?.length || 0, b.probes?.length || 0);
	for (let i = 0; i < n; i++) if (!sameArr(featSet(a.probes[i].feats), featSet(b.probes[i].feats))) qd++;
	if (qd) reasons.push(`query(${qd})`);
	const d = [];
	for (let i = 0; i < n; i++) { const v = colorDist(a.colors?.[i], b.colors?.[i]); if (v != null) d.push(v); }
	d.sort((x, y) => x - y);
	const maxDist = d.length ? d[d.length - 1] : 0, p95 = d.length ? d[Math.floor(d.length * 0.95)] : 0;
	const over = d.filter(v => v > tolColor).length;
	if (over) reasons.push(`color(${over}/${d.length} > ${tolColor})`);
	return { stable: !reasons.length, reasons, maxDist: Math.round(maxDist), p95: Math.round(p95) };
}

// ── 段 4：本物（ref）とこちら（ortho）の突き合わせ＝段 0〜3 ──
// 閾値の初期値（段 5 で本人が見比べ帳を見て決める）：色の許し（RGB の距離）・足した層の点／基図の点の一致率・問い合わせの一致率・比べられる点の下限
// 段 5 の目合わせ（2026-09-27・o7/o8 の見比べ帳で決めた）：色の許し 40・基図の点 ≥0.8・足した層の点 ≥0.85 ただし標本が少ない層（≤6 点）は 1 点のはずれを許す
// （細い線に載った 5×5 の中央値は 1 点だけ外れ得る＝add-a-geojson-line 5/6 は目で見て同じ絵）。比べられる点が 30% 未満＝絵は比べない。問い合わせ ≥0.9
// 問い合わせ ≥0.85：許し 0 で MapLibre と同じ式にしても、線の縁の 0.5px 未満の量子化（画面→タイル単位の丸め）で 1 割前後の点が食い違う
// （fit-to-the-bounds 142/160・display-a-popup 121/160・change-a-layers-color 143/160＝0.89〜0.75・許しを 0.25/0.5 にすると余計な当たりが増えて悪化＝実測 2026-09-27）
export const THRESH = { colorTol: 40, addedMin: 0.85, baseMin: 0.8, queryMin: 0.85, minComparable: 0.3, smallN: 6, smallMiss: 1,
	textMin: 0.6, textGate: false, textTol: 16, inkTol: 24, inkMin: 4 };   // 文字（段 0＝測るだけ・textGate:true で段 2 の条件に）：本物が置いた点の記号の hit 率・錨の周り ±24×±10px の差分画素
// 一致率の判定（少ない標本の 1 点はずれを許す）
export const passRatio = (ok, n, min, T = THRESH) => !n || ok / n >= min || (n <= T.smallN && n - ok <= T.smallMiss);
const BAD_END = new Set(["no-map", "crash", "harness-error"]);
const STILL_END = new Set(["stable"]);   // 絵を比べるのは両側とも止まって撮れた例だけ（animated/moving/timeout は段 2 まで）

// 「動く」か（段 1 の条件）。戻り＝理由（null＝動く）。shared＝両側で同じ文言の例外＝例の側の不具合（例が読む外部スクリプト等）＝どちらの落ちにも数えない
// （2026-09-30・sync-movement-of-multiple-maps：unpkg の CommonJS のプラグインが `module is not defined` を投げるが syncMaps は先に定義済＝本物は 3 枚とも動く）
export function runsWhy(rec, shared = null) {
	if (!rec) return "no record";
	if (BAD_END.has(rec.end)) return rec.end;
	if (!rec.map) return "no map";
	if (!rec.loadVia) return "no load";
	const exc = (rec.exceptions || []).filter(e => !shared?.has(e));
	if (exc.length) return `exception: ${exc[0]}`;
	if (rec.consoleErrors?.some(e => /\[style\] cannot load/.test(e))) return "style fell back to the default basemap";
	return null;
}
// unsupported の記録 "口 (kind)" → { semantic, cosmetic }
export function splitUnsupported(list) {
	const out = { semantic: [], cosmetic: [] };
	for (const u of list || []) { const m = /^(.*) \((semantic|cosmetic)\)$/.exec(u); (m?.[2] === "cosmetic" ? out.cosmetic : out.semantic).push(m ? m[1] : u); }
	return out;
}
const hav = (a, b) => { const R = 6371008.8, d = Math.PI / 180, x = Math.sin((b.lat - a.lat) * d / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin((b.lng - a.lng) * d / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(x))); };

// 色の一致を「足した層に当たる点」と「基図の点」に分けて数える（両側とも比べられる点だけ）
export function colorMatch(R, O, T = THRESH) {
	const added = new Set(R.added || []), g = { added: { n: 0, ok: 0 }, base: { n: 0, ok: 0 } };
	let comparable = 0;
	const n = Math.min(R.probes?.length || 0, O.probes?.length || 0), marks = [];
	for (let i = 0; i < n; i++) {
		const rp = R.probes[i], op = O.probes[i], rc = R.colors?.[i], oc = O.colors?.[i];
		if (!rp?.ok || !op?.ok || !rc || !oc) { marks.push(null); continue; }
		comparable++;
		const grp = rp.feats?.some(f => added.has(f.layer)) ? g.added : g.base, hit = colorDist(rc, oc) <= T.colorTol;
		grp.n++; if (hit) grp.ok++;
		marks.push({ hit, added: grp === g.added });
	}
	return { ...g, comparable, total: n, marks };
}
// 問い合わせの集合の一致（symbol を除く・両側とも比べられる点だけ）
// 違った点では、どの型の層に余計に当たった／取りこぼしたかも数える（順位表の粒度）
export function queryMatch(R, O) {
	let n = 0, ok = 0;
	const extra = new Set(), missing = new Set();
	const m = Math.min(R.probes?.length || 0, O.probes?.length || 0);
	for (let i = 0; i < m; i++) {
		if (!R.probes[i]?.ok || !O.probes[i]?.ok) continue;
		n++;
		const a = featSet(R.probes[i].feats), b = featSet(O.probes[i].feats);
		if (a.length === b.length && a.every((v, k) => v === b[k])) { ok++; continue; }
		const typeOf = (fs, key) => fs.find(f => featKey(f) === key)?.type ?? "?";
		for (const k of b) if (!a.includes(k)) extra.add(typeOf(O.probes[i].feats, k));
		for (const k of a) if (!b.includes(k)) missing.add(typeOf(R.probes[i].feats, k));
	}
	return { n, ok, extra, missing };
}

// 文字のインク（段 0）：文字あり／文字なしの写しの差分が、点（本物の記号の錨＝こちらの画面座標）の周りの箱にあるか。boxes＝[x,y]|null の列・戻り＝true/false/null の列
export function inkHits(imgA, imgB, points, { hw = 24, hh = 10, tol = THRESH.inkTol, min = THRESH.inkMin } = {}) {
	if (!imgA || !imgB || imgA.w !== imgB.w || imgA.h !== imgB.h) return points.map(() => null);   // decodePng の形＝{ w, h, rgba }
	const W = imgA.w, H = imgA.h, a = imgA.rgba, b = imgB.rgba;
	return points.map(p => {
		if (!p) return null;
		const x0 = Math.max(0, Math.round(p[0] - hw)), x1 = Math.min(W - 1, Math.round(p[0] + hw)), y0 = Math.max(0, Math.round(p[1] - hh)), y1 = Math.min(H - 1, Math.round(p[1] + hh));
		let n = 0;
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * W + x) * 4; if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > tol) { if (++n >= min) return true; } }
		return false;
	});
}
// 文字の突き合わせ（段 0）：本物が置いた点の記号（R.symbols・線/面は line に数えるだけ）を、こちらの画面へ写した位置（O.refSym）の近くに、
// こちらが同じ層のラベル/記号（O.placed）を置いたか（hit）。こちらだけが置いた物（extra）・錨の周りのインク（O.ink）も数える。文字の中身は比べない（同じ地物＝同じ式）
export function textMatch(R, O, T = THRESH) {
	const out = { n: 0, hit: 0, extra: 0, placedN: 0, ink: 0, inkN: 0, line: 0, lineHit: 0, linePlaced: 0, layers: {}, lineLayers: {} };
	const syms = (R?.symbols || []).filter(sy => !sy.error), placed = O?.placed || [], rs = O?.refSym || [], ink = O?.ink || [];
	if (!syms.length) return out;
	const W = O?.container?.W ?? Infinity, H = O?.container?.H ?? Infinity;
	const used = new Set();
	// 線沿い（段 4）＝本物は線の記号の位置を返さない（線の幾何だけ）＝層ごとの本数で測る：lineHit＝層ごとの min(本物, こちら) の和・linePlaced＝こちらの線の注記（画面の中）
	const lineRef = {}, lineOurs = {};
	for (const sy of syms) if (sy.placement === "line" || sy.placement === "line-center") lineRef[sy.layer] = (lineRef[sy.layer] || 0) + 1;
	for (const q of placed) if (lineRef[q.layer] && !(q.x < 0 || q.y < 0 || q.x >= W || q.y >= H)) { lineOurs[q.layer] = (lineOurs[q.layer] || 0) + 1; out.linePlaced++; }   // 本物が線に置く層に、こちらが置いた物（線に沿う字も、錨に回さず置いた盾も）
	syms.forEach((sy, i) => {
		if (sy.lng == null || sy.placement !== "point") { out.line++; return; }   // 線沿い・面の記号＝位置が無い
		const p = rs[i]; if (!p?.ok) return;   // こちらでは裏か画面の外
		out.n++;
		const L = out.layers[sy.layer] ??= { n: 0, hit: 0 }; L.n++;
		let best = -1, bd = Infinity;
		placed.forEach((q, k) => { if (used.has(k) || q.layer !== sy.layer) return; const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= Math.max(T.textTol, (q.w || 0) / 2 + (q.h || 0)) && d < bd) { bd = d; best = k; } });
		if (best >= 0) { used.add(best); out.hit++; L.hit++; }
		if (ink[i] != null) { out.inkN++; if (ink[i]) out.ink++; }
	});
	for (const [k, n] of Object.entries(lineRef)) { const m = lineOurs[k] || 0; out.lineLayers[k] = { n, ours: m }; out.lineHit += Math.min(n, m); }
	const layersR = new Set(syms.filter(sy => sy.placement === "point").map(sy => sy.layer));
	for (const [k, q] of placed.entries()) { if (q.line || lineRef[q.layer] || q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) continue; out.placedN++; if (!used.has(k) && layersR.has(q.layer)) out.extra++; }   // 本物にもある層で、こちらだけが置いた物（線の注記は本数で別に測る）
	return out;
}
// 1 例の段。level＝こちらの段（null＝本物が落ちる＝分母の外）・refLevel＝本物が届く段（止まって撮れたら 3・動く例は 2）
export function grade(R, O, T = THRESH) {
	const out = { level: 0, refLevel: 0, reasons: [], blockers: [], unsupported: splitUnsupported(O?.unsupported) };
	const shared = new Set((R?.exceptions || []).filter(e => O?.exceptions?.includes(e)));
	if (shared.size) out.sharedExceptions = [...shared];
	const rw = runsWhy(R, shared);
	if (rw) { out.level = null; out.refWhy = rw; return out; }
	out.refLevel = STILL_END.has(R.end) ? 3 : 2;
	const ow = runsWhy(O, shared);
	if (ow) { out.reasons.push(ow); out.blockers.push(ow.startsWith("exception: ") ? `exception: ${normError(ow.slice(11))}` : ow); return out; }
	out.level = 1;
	// 段 2＝同じ答え
	const why = [];
	if (out.unsupported.semantic.length) { why.push(`unsupported: ${out.unsupported.semantic.join(", ")}`); out.blockers.push(...out.unsupported.semantic.map(u => `unsupported: ${u}`)); }
	// 通訳が捕まえたエンジンのエラー（MapLibre なら投げない所でエンジンが投げた＝通訳は error 事象に替えて例を走らせ続ける）＝段 2 を塞ぐ（§8 C）
	const engErr = (O.consoleErrors || []).map(e => /^\[mlshim\] ([\w.]+):\s*([\s\S]*)$/.exec(e)).filter(Boolean);
	if (engErr.length) {
		why.push(`engine errors: ${[...new Set(engErr.map(m => m[1]))].join(", ")}`);
		for (const m of engErr) out.blockers.push(`engine error: ${m[1]}: ${normError(m[2].replace(new RegExp(`^${m[1]}: `), ""))}`);
	}
	const lr = (R.layers || []).map(l => l.id), lo = (O.layers || []).map(l => l.id);
	if (lr.length !== lo.length || lr.some((v, i) => v !== lo[i])) {
		const miss = lr.filter(id => !lo.includes(id)), extra = lo.filter(id => !lr.includes(id));
		why.push(`layers (missing ${miss.length}: ${miss.slice(0, 4).join(",")}${miss.length > 4 ? "…" : ""} / extra ${extra.length}${!miss.length && !extra.length ? " / order" : ""})`);
		// 順位表は抜けた層の型ごと（getStyle が描かない層を落とす＝型で原因が分かれる）・足された層・順番
		const typeOf = id => (R.layers.find(l => l.id === id)?.type ?? "?");
		for (const t of new Set(miss.map(typeOf))) out.blockers.push(`getStyle lacks ${t} layers`);
		if (extra.length) out.blockers.push("getStyle has extra layers");
		if (!miss.length && !extra.length) out.blockers.push("layer order differs");
	}
	const q = out.query = queryMatch(R, O);
	if (q.n && q.ok / q.n < T.queryMin) {
		why.push(`query ${q.ok}/${q.n}${q.extra.size ? ` · extra ${[...q.extra].join(",")}` : ""}${q.missing.size ? ` · missing ${[...q.missing].join(",")}` : ""}`);
		for (const t of q.extra) out.blockers.push(`query: extra ${t} hits`);
		for (const t of q.missing) out.blockers.push(`query: missed ${t} hits`);
		if (!q.extra.size && !q.missing.size) out.blockers.push("query answers differ");
	}
	const tx = out.text = textMatch(R, O, T);
	if (T.textGate && tx.n >= 5 && tx.hit / tx.n < T.textMin) { why.push(`text ${tx.hit}/${tx.n}`); out.blockers.push("text: labels not placed where MapLibre placed them"); }
	if ((R.markers?.length || 0) !== (O.markers?.length || 0)) { why.push(`markers ${R.markers?.length || 0}/${O.markers?.length || 0}`); out.blockers.push("markers differ"); }
	if ((R.popups?.length || 0) !== (O.popups?.length || 0)) { why.push(`popups ${R.popups?.length || 0}/${O.popups?.length || 0}`); out.blockers.push("popups differ"); }
	// MapLibre のメルカトルは「世界の高さが画面を満たす」までしかズームアウトしない（600px で z≈0.23・中心も緯度 0 へ寄る）。
	// 本物がちょうどその下限に居て、こちらが同じかそれより引いている時はカメラを比べない（球にその下限は無い＝意図した違い）
	const mlMinZ = R.container?.H ? Math.log2(R.container.H / 512) : null;
	const clampedML = mlMinZ != null && R.camera && O.camera && Math.abs(R.camera.zoom - mlMinZ) < 0.01 && O.camera.zoom <= R.camera.zoom + 0.01;
	if (R.camera && O.camera && !clampedML) {
		const lat = R.camera.lat, zTol = 0.1 + Math.abs(Math.log2(Math.max(0.05, Math.cos(lat * Math.PI / 180))));   // 緯度の差（台帳 §4）は許す
		const span = R.bounds ? hav({ lng: R.bounds[0][0], lat }, { lng: R.bounds[1][0], lat }) : 0;
		const d = hav(R.camera, O.camera);
		if (Math.abs(R.camera.zoom - O.camera.zoom) > zTol || (span && d > 0.02 * span)) { why.push(`camera (Δz ${(O.camera.zoom - R.camera.zoom).toFixed(2)} · Δc ${Math.round(d)}m)`); out.blockers.push("camera differs"); }
	}
	const cm = out.color = colorMatch(R, O, T);
	// 絵だけの一致（段 2 の答えに依らない副の数＝描く力そのもの）：両側とも止まって撮れ・比べられる点が足りて・色が閾値を越える
	out.pictureOnly = STILL_END.has(R.end) && STILL_END.has(O.end) && cm.comparable >= T.minComparable * cm.total
		&& passRatio(cm.added.ok, cm.added.n, T.addedMin, T) && passRatio(cm.base.ok, cm.base.n, T.baseMin, T);
	if (why.length) { out.reasons.push(...why); return out; }
	out.level = 2;
	// 段 3＝同じ絵
	if (out.refLevel < 3 || !STILL_END.has(O.end)) { out.reasons.push(`picture not compared (${R.end}/${O.end})`); if (out.refLevel === 3) out.blockers.push(`picture never settled (${O.end})`); return out; }
	if (cm.comparable < T.minComparable * cm.total) { out.reasons.push(`picture not comparable (${cm.comparable}/${cm.total} probes)`); out.level = Math.min(out.level, 2); out.refLevel = 2; return out; }
	const okA = passRatio(cm.added.ok, cm.added.n, T.addedMin, T), okB = passRatio(cm.base.ok, cm.base.n, T.baseMin, T);
	if (!okA) { out.reasons.push(`added layers ${cm.added.ok}/${cm.added.n}`); out.blockers.push("added layers look different"); }
	if (!okB) { out.reasons.push(`basemap ${cm.base.ok}/${cm.base.n}`); out.blockers.push("basemap looks different"); }
	if (okA && okB) out.level = 3;
	return out;
}
// 例外の文を束ねる（URL・数・引用の中身を伏せて同じ原因を 1 行に）
export const normError = e => String(e).replace(/https?:\/\/\S+/g, "<url>").replace(/(['"`])[^'"`]{1,80}\1/g, "$1…$1").replace(/\d+(\.\d+)?/g, "N").slice(0, 140);

// 足りない口の順位表＝こちらの段が本物の段より低い例の「塞いでいる物」を数える（1 例 1 回）
export function rankBlockers(graded) {
	const c = new Map();
	for (const g of graded) {
		if (g.level == null || g.level >= g.refLevel) continue;
		for (const b of new Set(g.blockers)) { const e = c.get(b) || { blocker: b, n: 0, examples: [] }; e.n++; e.examples.push(g.name); c.set(b, e); }
	}
	return [...c.values()].sort((a, b) => b.n - a.n || a.blocker.localeCompare(b.blocker));
}
