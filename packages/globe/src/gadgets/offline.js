// ガジェット：オフラインパック（#40・2026-09-25）。ボタン（↓）を押すと小さなパネル：
//   範囲＝今の画面（bbox）・ズーム上限（12/14/15/16・既定 15）・建物（任意）・画像タイル（表示中の物・任意）
//   見積り（枚数・容量・空き）→ 作る（進捗・中断）→ パックの一覧（容量・削除）
// 中身の置き場と配り方は offline-pack.js の頭書き。ホストが注入する物＝sources（地域の申告を読んだ結果＝この gadget は地域を知らない）。
//   sources.basemap＝{ tileUrl(z,x,y), coverage, minZ }・sources.dem＝{ byName(name) → Promise }｜null・
//   sources.rasters＝{ list() → [{ id, url, minZoom, maxZoom }]（表示中） }・sources.mesh＝{ sets() → [{ name, bbox }], prefetch(names, onProg) → Promise }｜null
// 台帳＝IDB GIS/pack（native-bucket の Cache）。SW（japan の sw.js）が PACK_CACHE の URL を cache-first で返す＝機内モードで同じ範囲が開く。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
import { Cache } from "native-bucket";
import { expandTemplate } from "@ortho-earth/core/raster-src";   // {z}/{x}/{y}・{s}・{-y}/tms の展開＝エンジンと同じ URL を作る
import { PACK_CACHE, tilesFor, tileCount, demNames, estimateBytes, bboxIntersects, fmtMB, runFetches, tplOf } from "../offline-pack.js";
const t = tr();

const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>`;
const ZMAX = [12, 14, 15, 16];
const DEM_BYTES = { R10: 6e6, R01: 3e6 };   // 見積り用の 1 セルあたり（日本の焼き＝おおよそ）

export function offline({ sources, bounds, onOpen, signal, zmaxDefault = 15 } = {}) {
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#offline-btn")) return () => {};
	if (!sources?.basemap?.tileUrl) return () => {};   // XYZ の基図が無い（PMTiles・基図なし）＝載せない
	const btn = document.createElement("button");
	btn.id = "offline-btn"; btn.className = "qm-panel-btn"; btn.type = "button"; btn.dataset.tip = t("Offline pack"); btn.setAttribute("aria-label", t("Offline pack"));
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);
	// 台帳（IDB GIS/pack）と Cache Storage は開いた時に初めて開く（起動時に GIS の版を上げに行かない）。失敗＝次の機会にもう一度
	let ledgerH = null, cacheH = null;
	const ledger = async () => ledgerH ??= await Cache("GIS/pack").catch(() => null);
	const store = async () => cacheH ??= typeof caches !== "undefined" ? await caches.open(PACK_CACHE).catch(() => null) : null;
	const swNotify = () => { try { navigator.serviceWorker?.controller?.postMessage({ type: "oj-pack" }); } catch { /* SW なし */ } };   // SW の「パックがあるか」を取り直させる
	let panel = null, ac = null, est = null, estSeq = 0;

	// パックの中身（URL 列）＝台帳の記録から作り直す（型紙と被覆は記録に残す＝後で基図が変わっても同じ URL）
	const urlsOf = p => {
		const out = [];
		for (const [z, x, y] of tilesFor(p.bbox, p.zmin, p.zmax, p.cov)) out.push(expandTemplate(p.tpl, z, x, y));
		for (const r of p.rasters || []) for (const [z, x, y] of tilesFor(p.bbox, Math.max(r.minZoom ?? 0, p.zmin), Math.min(r.maxZoom ?? 22, p.zmax))) out.push(expandTemplate(r.url, z, x, y, r.subdomains, r.tms));
		return out;
	};
	const keyOf = p => JSON.stringify([p.bbox, p.zmin, p.zmax, p.tpl, (p.rasters || []).map(r => r.id)]);   // 同じ計画＝同じパック（もう一度＝続きから）
	const planOf = () => {   // 今のパネルの入力から計画
		const $ = s => panel.querySelector(s);
		const bbox = bounds(); if (!bbox) return null;
		const zmax = +$(".of-z").value, zmin = Math.max(sources.basemap.minZ ?? 4, 4);
		const rasters = $(".of-ras")?.checked ? sources.rasters.list() : [];
		const meshSets = sources.mesh && $(".of-mesh")?.checked ? sources.mesh.sets().filter(s => bboxIntersects(s.bbox, bbox)).map(s => s.name) : [];
		return { bbox: bbox.map(v => +v.toFixed(4)), zmin, zmax, tpl: tplOf(sources.basemap.tileUrl), cov: sources.basemap.coverage || null, rasters: rasters.map(r => ({ id: r.id, url: r.url, minZoom: r.minZoom, maxZoom: r.maxZoom, subdomains: r.subdomains || null, tms: !!r.tms })), mesh: meshSets, dem: sources.dem ? demNames(bbox, zmax) : [] };
	};
	// 見積り＝基図は zmax の標本 6 枚を実測して外挿・標高は定数・建物は区の数だけ
	const estimate = async () => {
		const $ = s => panel.querySelector(s), seq = ++estSeq, plan = planOf();
		est = null; $(".of-run").disabled = true;   // 古い見積りで作らない（見積り中・範囲が取れない間は押せない）
		if (!plan) { $(".of-est").textContent = t("Move the map so the whole view is on the globe"); return; }
		const tiles = tileCount(plan.bbox, plan.zmin, plan.zmax, sources.basemap.coverage);
		let rasTiles = 0; for (const r of plan.rasters) rasTiles += tileCount(plan.bbox, Math.max(r.minZoom ?? 0, plan.zmin), Math.min(r.maxZoom ?? 22, plan.zmax));
		$(".of-est").textContent = t("Estimating…");
		const top = tilesFor(plan.bbox, plan.zmax, plan.zmax, sources.basemap.coverage), samples = [];
		const pick = Array.from({ length: Math.min(6, top.length) }, (_, i) => top[Math.floor(i * top.length / Math.min(6, top.length))]);
		await Promise.all(pick.map(async ([z, x, y]) => { try { const r = await fetch(sources.basemap.tileUrl(z, x, y)); const b = r.ok ? (await r.arrayBuffer()).byteLength : 0; samples.push(b); } catch { /* 標本なし＝既定 */ } }));
		if (seq !== estSeq) return;
		const demB = plan.dem.reduce((a, n) => a + (n.startsWith("R10") ? DEM_BYTES.R10 : DEM_BYTES.R01), 0);
		const bytes = estimateBytes(tiles, samples) + rasTiles * 30e3 + demB;
		let free = null; try { const e = await navigator.storage.estimate(); free = (e.quota || 0) - (e.usage || 0); } catch { /* 口が無い */ }
		est = { plan, tiles: tiles + rasTiles, bytes, free };
		const parts = [t("$1 tiles, about $2", (tiles + rasTiles).toLocaleString(), fmtMB(bytes))];
		if (plan.mesh.length) parts.push(t("$1 building districts (size not included)", plan.mesh.length));
		if (free != null) parts.push(t("free $1", fmtMB(free)));
		const tooBig = free != null && bytes > free * 0.8;
		$(".of-est").textContent = parts.join(" · ") + (tooBig ? " — " + t("Not enough space. Lower the zoom or narrow the view.") : "");
		$(".of-run").disabled = tooBig || tiles + rasTiles === 0;
	};
	const listPacks = async () => {
		const $ = s => panel.querySelector(s), led = await ledger();
		const keys = led ? await led() : [], rows = [];
		for (const k of keys) { const p = await led(k); if (p) rows.push(p); }
		rows.sort((a, b) => b.ts - a.ts);
		$(".of-list").innerHTML = rows.length ? rows.map(p => `<div class="of-row" data-id="${p.id}" style="display:flex;gap:6px;align-items:center;margin-top:4px"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}<br><small style="opacity:.7">z≤${p.zmax} · ${fmtMB(p.bytes)}${p.done ? "" : " · " + t("incomplete")}${p.mesh?.length ? " · " + t("$1 districts", p.mesh.length) : ""}</small></span><button type="button" class="qm-btn of-go" data-tip="${t("Go there")}">⌖</button><button type="button" class="qm-btn of-del">${t("Delete")}</button></div>`).join("") : `<div style="opacity:.7">${t("No packs yet")}</div>`;
		$(".of-list").querySelectorAll(".of-del").forEach(b => b.addEventListener("click", () => delPack(b.closest(".of-row").dataset.id)));
		$(".of-list").querySelectorAll(".of-go").forEach(b => b.addEventListener("click", () => { const p = rows.find(x => x.id === b.closest(".of-row").dataset.id); if (p) map.fitBounds(p.bbox, { animate: true }); }));
	};
	const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const delPack = async id => {
		const led = await ledger(), cache = await store(); if (!led) return;
		const p = await led(id); if (!p) return;
		if (cache) {   // 他のパックが使う URL は残す。消すのは Cache に実際にある物だけ・64 件ずつ並列
			const keep = new Set();
			for (const k of await led()) if (k !== id) { const q = await led(k); if (q) for (const u of urlsOf(q)) keep.add(u); }
			const have = new Set((await cache.keys()).map(r => r.url));
			const del = urlsOf(p).filter(u => have.has(u) && !keep.has(u));
			for (let i = 0; i < del.length; i += 64) await Promise.all(del.slice(i, i + 64).map(u => cache.delete(u)));
		}
		await led(id, null);
		if (!(await led()).length && typeof caches !== "undefined") { cacheH = null; await caches.delete(PACK_CACHE).catch(() => {}); }   // 最後の 1 つ＝置き場ごと消す（SW の照会が止まる）
		swNotify();
		listPacks();
	};
	const run = async () => {
		if (ac || !est) return;
		const $ = s => panel.querySelector(s), plan = est.plan, cache = await store(), led = await ledger();
		ac = new AbortController();
		$(".of-run").style.display = "none"; $(".of-stop").style.display = "";
		// 同じ計画のパックが台帳にあれば続き（記録を引き継ぎ・容量は足す）。無ければ新規
		let rec = null;
		if (led) for (const k of await led()) { const q = await led(k); if (q && keyOf(q) === keyOf(plan)) { rec = q; break; } }
		if (!rec) rec = { id: "p" + Date.now().toString(36), name: $(".of-name").value.trim() || defaultName(plan.bbox), bbox: plan.bbox, zmin: plan.zmin, zmax: plan.zmax, tpl: plan.tpl, cov: plan.cov, rasters: plan.rasters, mesh: plan.mesh, dem: plan.dem, tiles: est.tiles, bytes: 0, ts: Date.now(), done: false };
		else { rec.mesh = plan.mesh; rec.dem = plan.dem; rec.ts = Date.now(); rec.done = false; }
		const id = rec.id;
		if (led) await led(id, rec);
		const prog = (label, p) => { $(".of-prog").textContent = `${label} ${p.done}/${p.total}${p.bytes ? " · " + fmtMB(p.bytes) : ""}${p.failed ? " · " + t("$1 failed", p.failed) : ""}`; $(".of-bar").style.width = (p.total ? 100 * p.done / p.total : 0) + "%"; };
		try {
			// ① 基図とラスタ＝Cache Storage
			const urls = urlsOf(plan);
			const r1 = await runFetches(urls, {
				has: async u => !!(cache && await cache.match(u)),
				fetchOne: async (u, sig) => { const res = await fetch(u, { signal: sig }); if (!cache) return res.ok ? (await res.arrayBuffer()).byteLength : 0; if (res.status === 206 || (!res.ok && res.status !== 404 && res.status !== 204)) return -1; const b = res.ok ? (await res.clone().arrayBuffer()).byteLength : 0; await cache.put(u, res); return b; },   // 404/204＝空タイルとして残す（オフラインでも「無い」が分かる）。大きさは中身で数える（Content-Length は他オリジンだと読めない）
				onProgress: p => prog(t("Map tiles"), p), signal: ac.signal, concurrency: 6,
			});
			rec.bytes += r1.bytes;
			// ② 標高＝core のローダ（IDB GIS/alt）
			if (!r1.aborted && plan.dem.length && sources.dem) {
				const r2 = await runFetches(plan.dem, { fetchOne: async n => { await sources.dem.byName(n); return 0; }, onProgress: p => prog(t("Terrain"), p), signal: ac.signal, concurrency: 2 });
				if (r2.aborted) r1.aborted = true;
			}
			// ③ 建物＝既存の先読み（進捗はそちらのトースト）
			if (!r1.aborted && plan.mesh.length && sources.mesh) { prog(t("Buildings"), { done: 0, total: plan.mesh.length, bytes: 0, failed: 0 }); await sources.mesh.prefetch(plan.mesh, (d, n) => prog(t("Buildings"), { done: d, total: n, bytes: 0, failed: 0 })); }
			rec.done = !r1.aborted && !r1.failed;
			$(".of-prog").textContent = r1.aborted ? t("Stopped (run again to resume)") : r1.failed ? t("Done with $1 failed (run again to retry)", r1.failed) : t("Done. This area now opens offline.");
		} catch (e) { $(".of-prog").textContent = String(e?.message || e); }
		if (led) await led(id, rec);
		swNotify();
		ac = null; $(".of-run").style.display = ""; $(".of-stop").style.display = "none";
		listPacks();
	};
	const defaultName = b => `${new Date().toISOString().slice(0, 10)} ${((b[1] + b[3]) / 2).toFixed(3)}, ${((b[0] + b[2]) / 2).toFixed(3)}`;
	const build = () => {
		panel = document.createElement("div");
		panel.className = "qm-panel offline-panel";
		panel.style.cssText = "position:absolute;left:56px;bottom:12px;z-index:5;width:300px;max-width:calc(100% - 68px);max-height:calc(100% - 24px);overflow:auto;box-sizing:border-box;padding:10px 12px;border-radius:8px;background:var(--qm-surface,#fff);color:var(--qm-text,#222);box-shadow:0 1px 6px rgba(0,0,0,.25);font-size:12.5px;line-height:1.5";
		panel.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${t("Offline pack")}</div>
			<div style="opacity:.8;margin-bottom:6px">${t("Saves the map tiles and terrain of the current view so it opens without a connection.")}</div>
			<label style="display:block">${t("Name")} <input type="text" class="of-name" style="width:100%;box-sizing:border-box" placeholder="${t("(automatic)")}"></label>
			<label style="display:block;margin-top:4px">${t("Detail up to zoom")} <select class="of-z">${ZMAX.map(z => `<option value="${z}"${z === zmaxDefault ? " selected" : ""}>z${z}</option>`).join("")}</select></label>
			${sources.mesh ? `<label style="display:block"><input type="checkbox" class="of-mesh"> ${t("3D buildings (large)")}</label>` : ""}
			<label style="display:block"><input type="checkbox" class="of-ras"> ${t("Image tiles shown now")}</label>
			<div class="of-est" style="margin-top:6px;opacity:.85"></div>
			<div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="of-run qm-btn">${t("Create pack")}</button><button type="button" class="of-stop qm-btn" style="display:none">${t("Stop")}</button><button type="button" class="of-re qm-btn">${t("Re-estimate")}</button></div>
			<div style="height:4px;background:rgba(0,0,0,.12);border-radius:2px;margin-top:6px"><div class="of-bar" style="height:100%;width:0;background:#3f4757;border-radius:2px"></div></div>
			<div class="of-prog" style="margin-top:4px;min-height:1.4em"></div>
			<div style="font-weight:600;margin-top:8px">${t("Saved packs")}</div>
			<div class="of-list"></div>
			<div style="opacity:.6;margin-top:6px;font-size:11px">${t("Buildings and terrain live in their own stores (with their own limits); deleting a pack removes only its map tiles.")}</div>`;
		mapEl.append(panel);
		const $ = s => panel.querySelector(s);
		$(".of-z").addEventListener("change", estimate);
		$(".of-mesh")?.addEventListener("change", estimate);
		$(".of-ras").addEventListener("change", estimate);
		$(".of-re").addEventListener("click", estimate);
		$(".of-run").addEventListener("click", run);
		$(".of-stop").addEventListener("click", () => ac?.abort());
	};
	const open = async () => { if (!panel) build(); panel.style.display = ""; btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); onOpen?.(); listPacks(); if (sources.mesh?.warm) await sources.mesh.warm(); estimate(); };
	const close = () => { if (panel) panel.style.display = "none"; btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); };
	btn.addEventListener("click", () => panel && panel.style.display !== "none" ? close() : open(), { signal });
	return { open, close, estimate: async () => { if (!panel) build(); await estimate(); return est; }, run, list: async () => { const led = await ledger(); if (!led) return []; const out = []; for (const k of await led()) { const p = await led(k); if (p) out.push(p); } return out.sort((a, b) => b.ts - a.ts); }, delete: delPack, get busy() { return !!ac; } };
}
