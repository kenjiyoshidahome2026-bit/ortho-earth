// ガジェット本体：衛星シーン検索＝「STAC が見つけ、COG が運ぶ」。
// ソースは 3 つ（パネル左上のセレクタ）：
//   ・Sentinel-2 … Earth Search（Element 84 の公開 STAC API・CORS 開放・鯖レスの流儀どおり直読み）。assets.visual（TCI の COG）
//   ・PALSAR-2 / AVNIR-2 … Tellus（さくらインターネットの衛星データPF・JAXA データ）。Traveler API は CORS 無し・要 Bearer
//     なので native-bucket の /tellus 代理口（トークンは Worker の secret）へ。シーンの「*_webcog.tif」（Tellus 表示用 COG・
//     EPSG:4326）の署名 URL（S3 型・1 時間）を /proxy?url= 経由で Range 読み（署名 URL の CORS は tellusxdp.com 固定＝直読み不可）。
//     失効（403）したら /tellus/webcog で再発行して読み直す（loadCog の fetch 注入）。実測は 2026-09-16。
// 現在ビューの中心点（Tellus は Point 不可＝極小四角）＋期間で検索し、行クリックで map.gadget.cog へ＝球にドレープ。
// シーン切替は fit:false＝カメラ据え置き（同じ場所の別日・別センサを見比べる道具）。
// 四戒: 独立（注入 loadCog/clearCog のみ）／遅延（stac-stub が初回クリックで import）／抽象アクセス／UI はこのパネルのみ。
import { tr } from "../i18n.js";
import { gcInterpolate } from "geopbf/edit/sphere";   // 完全球体＝辺は大円で結ぶ（経緯度線形の内挿は禁止・9/15 の canvas2D 総点検）
const t = tr({
	"衛星画像を探す": "Find satellite imagery",
	"この地点で検索": "Search at this spot",
	"検索中…": "Searching…",
	"シーンが見つかりません（範囲か期間を広げてみてください）": "No scenes found (try a wider area or date range)",
	"検索に失敗しました": "Search failed",
	"雲": "cloud",
	"画像を消す": "Remove imagery",
	"読込中…": "Loading…",
	"画像ソース": "Imagery source",
	"上昇": "asc", "下降": "desc",
});

const API = "https://earth-search.aws.element84.com/v1/search";   // 公開 STAC API（Sentinel-2 L2A COGs on AWS）
// native-bucket Worker（/tellus 代理口と /proxy）。?tellusapi=http://localhost:8787 で wrangler dev の手元 Worker に向ける（開発用）
const API_BASE = (typeof location !== "undefined" && new URLSearchParams(location.search).get("tellusapi")) || "https://api.ortho-earth.com";
// ソース台帳。ds＝Tellus の dataset_id（【Tellus公式】…・allow_network_type=global＝Tellus 外利用可のものだけ）。
// cloud＝雲量が properties にある（光学）＝雲量昇順で並べる／無い（SAR）＝新しい順。
// days＝既定の期間（今日から遡る日数）／period＝固定の期間（運用終了センサ）。ソース切替で日付欄をこれに合わせる
//（Sentinel-2 の「直近 90 日」のままだと、再訪間隔の長い PALSAR-2 や 2011 年で終わった AVNIR-2 は 0 件になる）。
const SOURCES = [
	{ key: "s2", label: "Sentinel-2", credit: "Sentinel-2 © Copernicus / Earth Search", cloud: true, days: 90 },
	{ key: "palsar2", label: "PALSAR-2 (Tellus)", credit: "PALSAR-2 © JAXA / Tellus", ds: "45ff087d-be02-4788-bc4c-28cd947a1167", cloud: false, days: 3 * 365 },
	{ key: "avnir2", label: "AVNIR-2 (Tellus)", credit: "AVNIR-2 © JAXA / Tellus", ds: "ea71ef6e-9569-49fc-be16-ba98d876fb73", cloud: true, period: ["2006-01-01", "2011-04-30"] },
];
const CSS = `
#stac-panel { position: absolute; top: 8px; left: 52px; width: min(300px, calc(100vw - 64px)); max-height: min(70%, 560px);
	display: none; flex-direction: column; background: rgba(255,255,255,.96); color: #3f4757; border-radius: 10px;
	box-shadow: 0 4px 18px rgba(0,0,0,.18); font: 12px/1.5 system-ui; overflow: hidden; }
#stac-panel.on { display: flex; }
#stac-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px 6px; }
#stac-head input[type=date], #stac-src { min-width: 0; font: 11px system-ui; color: inherit; border: 1px solid #cdd3dd; border-radius: 6px; padding: 2px 4px; background: #fff; }
#stac-head input[type=date] { flex: 1; }
#stac-src { flex: 1 0 100%; }
#stac-go { border: 1px solid #cdd3dd; background: #fff; border-radius: 6px; padding: 2px 8px; cursor: pointer; font: 11px system-ui; color: inherit; }
#stac-status { padding: 0 10px 6px; color: #8a93a3; }
#stac-list { overflow-y: auto; padding: 0 6px 6px; }
.stac-row { display: flex; gap: 8px; align-items: center; width: 100%; border: 0; background: none; text-align: left;
	padding: 4px 6px; border-radius: 8px; cursor: pointer; font: 12px system-ui; color: inherit; }
.stac-row:hover { background: #eef1f6; }
.stac-row.on { background: #e2ecff; }
.stac-row img { width: 44px; height: 44px; object-fit: cover; border-radius: 6px; background: #dfe3ea; flex: none; }
.stac-row .d { font-weight: 600; }
.stac-row .c { color: #8a93a3; }
#stac-foot { display: flex; justify-content: space-between; align-items: center; padding: 4px 10px 8px; color: #9aa2b1; font-size: 10px; }
#stac-clear { border: 0; background: none; color: #6b7385; cursor: pointer; font: 11px system-ui; text-decoration: underline; }`;

export function stac({ btn, loadCog, clearCog, signal } = {}) {
	const map = this, mapEl = this.mapEl;
	if (!mapEl.querySelector("#stac-style")) {
		const st = document.createElement("style"); st.id = "stac-style"; st.textContent = CSS; mapEl.append(st);
	}
	const panel = document.createElement("div");
	panel.id = "stac-panel";
	const today = new Date(), from = new Date(today.getTime() - 90 * 864e5);
	const d = (x) => x.toISOString().slice(0, 10);
	panel.innerHTML = `
		<div id="stac-head">
			<select id="stac-src" aria-label="${t("画像ソース")}">${SOURCES.map(s => `<option value="${s.key}">${s.label}</option>`).join("")}</select>
			<input type="date" id="stac-from" value="${d(from)}"><span>–</span><input type="date" id="stac-to" value="${d(today)}">
			<button id="stac-go">${t("この地点で検索")}</button>
		</div>
		<div id="stac-status"></div>
		<div id="stac-list"></div>
		<div id="stac-foot"><span id="stac-credit">${SOURCES[0].credit}</span><button id="stac-clear">${t("画像を消す")}</button></div>`;
	mapEl.append(panel);   // 末尾append＝DOM順で最上面（z-index全廃の裁き）
	const $ = (id) => panel.querySelector(id);
	const status = (s) => { $("#stac-status").textContent = s; };
	const source = () => SOURCES.find(s => s.key === $("#stac-src").value) || SOURCES[0];
	const applyRange = (src) => {   // ソースの既定期間を日付欄へ（利用者はそのあと自由に動かせる）
		const [a, b] = src.period || [d(new Date(Date.now() - src.days * 864e5)), d(new Date())];
		$("#stac-from").value = a; $("#stac-to").value = b;
	};

	// シーンの居場所＝フットプリントを自前 canvas で描く（measure/anno と同じ作法＝map の公開面のみ）。
	// 行ホバーの間だけ太枠＝標高込みで投影（makeProjectorH + getHeight＝地形ドレープ済みの画像と視差ゼロ）。
	// 選択枠は置かない＝載った画像自身が範囲を示す（枠を残すと僅かなズレだけが目立つ・本人裁定 9/6）。
	const cv = document.createElement("canvas");
	cv.style.cssText = "position:absolute;inset:0;pointer-events:none;";
	mapEl.append(cv);
	let hoverPts = null, hoverH = null, hoverSeq = 0, unsub = null;
	const ringOf = (g) => g?.type === "Polygon" ? g.coordinates[0] : g?.type === "MultiPolygon" ? g.coordinates[0][0] : null;
	const drawFoot = () => {
		const dpr = devicePixelRatio || 1, W = mapEl.clientWidth, H = mapEl.clientHeight;
		if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
		const ctx = cv.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		if (!hoverPts) return;
		const prH = map.makeProjectorH?.(), pr = map.makeProjector();
		ctx.beginPath();
		let started = false;
		for (let i = 0; i < hoverPts.length; i++) {
			const q = hoverPts[i];
			const p = (prH && hoverH) ? prH(q[0], q[1], hoverH[i]) : pr(q[0], q[1]);   // 標高キャッシュ到着後は地形の高さで投影＝画像と視差ゼロ
			if (!p || p[2] < 0) { started = false; continue; }
			started ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); started = true;
		}
		ctx.lineWidth = 4.5; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.stroke();   // 白フチ＝衛星画像の上でも読める
		ctx.lineWidth = 2; ctx.strokeStyle = "#3f4757"; ctx.stroke();
	};
	// ホバー開始＝辺を16分割した標本点列（大円＝slerp。経緯度線形だと広いシーンで辺が緯線寄りに曲がる）を作り、
	// 標高（map.getHeight＝非同期）を一括プリフェッチ→到着で差し替え再描画。未着の間は海抜0で即描き＝反応の速さを落とさない。
	const setHover = (ring) => {
		if (!ring) { hoverPts = null; hoverH = null; footOff(); drawFoot(); return; }
		const pts = [];
		for (let i = 0; i < ring.length; i++) {
			const a = ring[i], b = ring[(i + 1) % ring.length];
			for (let k = 0; k < 16; k++) pts.push(gcInterpolate(a, b, k / 16));
		}
		hoverPts = pts; hoverH = null; footOn();
		const seq = ++hoverSeq;
		Promise.all(pts.map(q => map.getHeight?.(q[0], q[1]) ?? 0))
			.then(hs => { if (seq === hoverSeq && hoverPts === pts) { hoverH = hs; drawFoot(); } })
			.catch(() => {});
	};
	const footOn = () => { unsub ??= map.onFrame(drawFoot); drawFoot(); map.requestDraw?.(); };
	const footOff = () => { if (!hoverPts) { unsub?.(); unsub = null; drawFoot(); } };

	// 現在ビューの bbox（画面四隅+中心の unproject ∩ ズーム由来の視野幅キャップ）。
	// ⚠チルト時は画面上部が地平線近くまで届き、素の四隅 bbox が北へ大きく膨張＝「この範囲」の体感とズレる
	//（本人指摘 9/6）。視野幅 deg＝360×W/(256×2^z)（fit の逆算と同式・WORLD_PX=256 正本）でキャップ＝
	// 中心の周り「画面のスケール感」の箱に収める。真俯瞰はキャップ≒素の bbox＝挙動不変。
	const viewBbox = () => {
		const W = mapEl.clientWidth, H = mapEl.clientHeight;
		const pts = [[W / 2, H / 2], [0, 0], [W, 0], [0, H], [W, H]].map(p => map.unprojectXY(p[0], p[1]));
		const c = pts[0];
		if (!c) return null;
		const capW = 360 * W / (256 * Math.pow(2, map.getZoom())) * 0.75;   // 中心±＝計1.5画面ぶん
		const capH = capW * H / W;
		if (pts.some(p => !p)) return [c[0] - capW, Math.max(c[1] - capH, -85), c[0] + capW, Math.min(c[1] + capH, 85)];
		let w = 1e9, s = 1e9, e = -1e9, n = -1e9;
		for (const [lo, la] of pts) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
		return [Math.max(w, c[0] - capW), Math.max(s, c[1] - capH, -85), Math.min(e, c[0] + capW), Math.min(n, c[1] + capH, 85)];
	};
	const bboxPoly = ([w, s, e, n]) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

	// ---- ソース別アダプタ：検索 → 行の正規形 {id, date, sub, cloud, geometry, thumb, resolve()→COG の URL, fetch?} ----
	const fromTo = () => [`${$("#stac-from").value}T00:00:00Z`, `${$("#stac-to").value}T23:59:59Z`];
	const searchS2 = async (c, bbox, sig) => {
		const [from, to] = fromTo();
		const r = await fetch(API, {
			method: "POST", headers: { "content-type": "application/json" }, signal: sig, credentials: "omit",
			body: JSON.stringify({
				collections: ["sentinel-2-l2a"],
				...(c ? { intersects: { type: "Point", coordinates: [c[0], c[1]] } } : { bbox }),
				datetime: `${from}/${to}`,
				limit: 40, sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
			}),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return ((await r.json()).features || []).filter(it => it.assets?.visual?.href).map(it => ({
			id: it.id, date: (it.properties?.datetime || "").slice(0, 10),
			sub: (it.properties?.["grid:code"] || "").replace(/^MGRS-/, ""),
			cloud: it.properties?.["eo:cloud_cover"] ?? -1, geometry: it.geometry, thumb: it.assets?.thumbnail?.href,
			resolve: async () => it.assets.visual.href,
		}));
	};
	const searchTellus = async (src, c, bbox, sig) => {
		const [from, to] = fromTo();
		const eps = 5e-4;   // Tellus の intersects は Polygon 限定＝中心点を極小四角で（「中心が写っているシーン」の意味論は同じ）
		const poly = c ? bboxPoly([c[0] - eps, c[1] - eps, c[0] + eps, c[1] + eps]) : bboxPoly(bbox);
		const r = await fetch(`${API_BASE}/tellus/datasets/${src.ds}/data-search/`, {
			method: "POST", headers: { "content-type": "application/json" }, signal: sig, credentials: "omit",
			body: JSON.stringify({
				intersects: poly,
				query: { start_datetime: { gte: from, lte: to } },
				sortby: [src.cloud ? { field: "properties.eo:cloud_cover", direction: "asc" } : { field: "properties.start_datetime", direction: "desc" }],
				paginate: { size: 40, cursor: null },   // size は 10 以上・cursor は null でも必須（422）
			}),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return ((await r.json()).features || []).map(it => {
			const p = it.properties || {};
			const sub = src.cloud ? (p["tellus:name"] || "") : [p["sar:polarizations"], p["sat:orbit_state"] && t(p["sat:orbit_state"] === "ascending" ? "上昇" : "下降"), p["palsar2:beam"]].filter(Boolean).join(" ");
			// webcog の署名 URL（1 時間）を /proxy 経由の URL に。失効したら fetch 包みが再発行して読み直す
			const resolve = async () => {
				const rr = await fetch(`${API_BASE}/tellus/webcog?dataset=${src.ds}&data=${it.id}`, { credentials: "omit" });
				if (!rr.ok) throw new Error(`HTTP ${rr.status}`);
				const { download_url } = await rr.json();
				return `${API_BASE}/proxy?url=${encodeURIComponent(download_url)}`;
			};
			return {
				id: it.id, date: (p.start_datetime || "").slice(0, 10), sub, cloud: p["eo:cloud_cover"] ?? -1,
				geometry: it.geometry, thumb: null, resolve, renew: true,
			};
		});
	};
	// 署名 URL 失効（403）で一度だけ再発行して読み直す fetch 包み。読み口（geopbf/cog/source）は常に同じ src を撃つので
	// 引数 URL は無視して現在の URL へ＝差し替えが読み口に見えない。
	const renewing = (resolve, first) => {
		let cur = first, inflight = null;
		return async (_u, init) => {
			let r = await fetch(cur, init);
			if (r.status === 403) {
				inflight ??= resolve().then(n => { cur = n; }).finally(() => { inflight = null; });
				await inflight;
				r = await fetch(cur, init);
			}
			return r;
		};
	};

	let ac = null, activeHref = null;
	const search = async () => {
		// 意味論＝「画面中心の地点が写っているシーン」（STAC intersects に中心点）。bbox 検索だと「かすった」周辺タイルが
		// 混ざり、雲量ソート×limit で肝心の中心タイルが締め出される（本人指摘 9/6）。点なら範囲外ゼロ・中心は必ず写る。
		const src = source();
		const c = map.unprojectXY(mapEl.clientWidth / 2, mapEl.clientHeight / 2);
		const bbox = c ? null : viewBbox();   // 球外（宇宙ビュー等）だけ bbox にフォールバック
		if (!c && !bbox) return status(t("シーンが見つかりません（範囲か期間を広げてみてください）"));
		ac?.abort(); ac = new AbortController();
		signal?.addEventListener("abort", () => ac?.abort(), { once: true });
		status(t("検索中…")); $("#stac-list").replaceChildren(); $("#stac-credit").textContent = src.credit;
		try {
			const items = src.ds ? await searchTellus(src, c, bbox, ac.signal) : await searchS2(c, bbox, ac.signal);
			status(items.length ? "" : t("シーンが見つかりません（範囲か期間を広げてみてください）"));
			for (const it of items.slice(0, 15)) {
				const cloud = Math.round(it.cloud);
				const row = document.createElement("button");
				row.className = "stac-row"; row.dataset.id = it.id;
				row.innerHTML = `<img loading="lazy" alt=""><span><span class="d">${it.date}</span> <span class="c">${it.sub}</span><br><span class="c">${src.cloud ? `${t("雲")} ${cloud >= 0 ? cloud + "%" : "?"}` : src.label}</span></span>`;
				if (it.thumb) row.querySelector("img").src = it.thumb;
				const ring = ringOf(it.geometry);
				row.addEventListener("mouseenter", () => setHover(ring), { signal });
				row.addEventListener("mouseleave", () => setHover(null), { signal });
				row.addEventListener("click", async () => {
					panel.querySelectorAll(".stac-row.on").forEach(x => x.classList.remove("on"));
					row.classList.add("on"); status(t("読込中…"));
					setHover(null);   // 枠は消す＝範囲は載った画像自身が示す
					try {
						const href = await it.resolve();
						await loadCog(href, { fit: activeHref === null, ...(it.renew ? { fetch: renewing(it.resolve, href) } : {}) });   // 初回だけシーンへ寄る＝以降は据え置きで日付比較
						activeHref = href; status("");
					} catch (e) { status(t("検索に失敗しました") + ": " + e.message); }
				}, { signal });
				$("#stac-list").append(row);
			}
		} catch (e) { if (e?.name !== "AbortError") { console.warn("[stac]", e); status(t("検索に失敗しました")); } }
	};

	$("#stac-go").addEventListener("click", search, { signal });
	$("#stac-src").addEventListener("change", () => { applyRange(source()); search(); }, { signal });
	$("#stac-clear").addEventListener("click", () => { clearCog?.(); activeHref = null; panel.querySelectorAll(".stac-row.on").forEach(x => x.classList.remove("on")); }, { signal });
	const toggle = () => {
		const on = panel.classList.toggle("on");
		btn?.classList.toggle("on", on);   // quiet-mono のインク色ガラス（.on 節に登録済み）
		if (!on) setHover(null);   // 閉じたら枠も消す（画像は残る＝消すのは「画像を消す」）
		else if (!$("#stac-list").children.length) search();
	};
	btn?.addEventListener("click", toggle, { signal });   // スタブの初回起動後はこのリスナーがトグルを担う（初回は stub が g.toggle() を呼ぶ）
	signal?.addEventListener("abort", () => { ac?.abort(); unsub?.(); panel.remove(); cv.remove(); }, { once: true });
	return { toggle, search };
}
