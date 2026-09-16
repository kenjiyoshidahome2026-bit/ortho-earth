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
import { DATASETS, defaultRange, searchScenes, cogUrl, cogOpts, renewingFetch, orbitLabel } from "./tellus-api.js";   // Tellus の読み口（tellus.html と共用）
import { createFootprint } from "./footprint.js";   // フットプリント描画（tellus.html と共用・辺は大円）
const t = tr();

const API = "https://earth-search.aws.element84.com/v1/search";   // 公開 STAC API（Sentinel-2 L2A COGs on AWS）
// ソース台帳＝Sentinel-2（直読み）＋ Tellus の 2 つ（tellus-api.js の DATASETS）。days/period＝ソース別の既定期間
//（Sentinel-2 の「直近 90 日」のままだと、再訪間隔の長い PALSAR-2 や 2011 年で終わった AVNIR-2 は 0 件になる）。
const SOURCES = [
	{ key: "s2", label: "Sentinel-2", credit: "Sentinel-2 © Copernicus / Earth Search", cloud: true, days: 90 },
	...Object.values(DATASETS).map(d => ({ ...d, label: `${d.label} (Tellus)` })),   // PALSAR-2 / PALSAR / AVNIR-2 / GCOM-C SST＝台帳の順
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
			<select id="stac-src" aria-label="${t("Imagery source")}">${SOURCES.map(s => `<option value="${s.key}">${s.label}</option>`).join("")}</select>
			<input type="date" id="stac-from" value="${d(from)}"><span>–</span><input type="date" id="stac-to" value="${d(today)}">
			<button id="stac-go">${t("Search at this spot")}</button>
		</div>
		<div id="stac-status"></div>
		<div id="stac-list"></div>
		<div id="stac-foot"><span id="stac-credit">${SOURCES[0].credit}</span><button id="stac-clear">${t("Remove imagery")}</button></div>`;
	mapEl.append(panel);   // 末尾append＝DOM順で最上面（z-index全廃の裁き）
	const $ = (id) => panel.querySelector(id);
	const status = (s) => { $("#stac-status").textContent = s; };
	const source = () => SOURCES.find(s => s.key === $("#stac-src").value) || SOURCES[0];
	const applyRange = (src) => { const [a, b] = defaultRange(src); $("#stac-from").value = a; $("#stac-to").value = b; };   // ソースの既定期間を日付欄へ（利用者はそのあと自由に動かせる）

	// シーンの居場所＝フットプリント（gadgets/footprint.js）。行ホバーの間だけ太枠。選択枠は置かない＝載った画像自身が範囲を示す
	//（枠を残すと僅かなズレだけが目立つ・本人裁定 9/6）。
	const foot = createFootprint(map, mapEl);
	const setHover = (g) => foot.set(g);
	const ringOf = foot.ringOf;

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
	// ---- ソース別アダプタ：検索 → 行の正規形 {id, date, sub, cloud, geometry, thumb, resolve()→COG の URL, renew?} ----
	const fromTo = () => [$("#stac-from").value, $("#stac-to").value];
	const searchS2 = async (c, bbox, sig) => {
		const [from, to] = fromTo();
		const r = await fetch(API, {
			method: "POST", headers: { "content-type": "application/json" }, signal: sig, credentials: "omit",
			body: JSON.stringify({
				collections: ["sentinel-2-l2a"],
				...(c ? { intersects: { type: "Point", coordinates: [c[0], c[1]] } } : { bbox }),
				datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
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
		return (await searchScenes(src, { c, bbox, from, to, signal: sig })).map(it => ({
			...it, sub: src.cloud ? it.sub : [it.sub, orbitLabel(it.props, t)].filter(Boolean).join(" "), thumb: null, renew: true,
			resolve: async () => (await cogUrl(src, it.id)).url,   // webcog の署名 URL（1 時間）→ /proxy 経由。失効は fetch 包みが再発行
			cog: { ...cogOpts(src), cacheKey: `${src.key}/${it.id}` },   // 見せ方（PALSAR-2 は偽色・SST はカラーマップ）＋生タイルキャッシュの鍵
		}));
	};
	const renewing = (resolve, first) => renewingFetch(first, resolve);

	let ac = null, activeHref = null;
	const search = async () => {
		// 意味論＝「画面中心の地点が写っているシーン」（STAC intersects に中心点）。bbox 検索だと「かすった」周辺タイルが
		// 混ざり、雲量ソート×limit で肝心の中心タイルが締め出される（本人指摘 9/6）。点なら範囲外ゼロ・中心は必ず写る。
		const src = source();
		const c = map.unprojectXY(mapEl.clientWidth / 2, mapEl.clientHeight / 2);
		const bbox = c ? null : viewBbox();   // 球外（宇宙ビュー等）だけ bbox にフォールバック
		if (!c && !bbox) return status(t("No scenes found (try a wider area or date range)"));
		ac?.abort(); ac = new AbortController();
		signal?.addEventListener("abort", () => ac?.abort(), { once: true });
		status(t("Searching…")); $("#stac-list").replaceChildren(); $("#stac-credit").textContent = src.credit;
		try {
			const items = src.ds ? await searchTellus(src, c, bbox, ac.signal) : await searchS2(c, bbox, ac.signal);
			status(items.length ? "" : t("No scenes found (try a wider area or date range)"));
			for (const it of items.slice(0, 15)) {
				const cloud = Math.round(it.cloud);
				const row = document.createElement("button");
				row.className = "stac-row"; row.dataset.id = it.id;
				row.innerHTML = `<img loading="lazy" alt=""><span><span class="d">${it.date}</span> <span class="c">${it.sub}</span><br><span class="c">${src.cloud ? `${t("cloud")} ${cloud >= 0 ? cloud + "%" : "?"}` : src.label}</span></span>`;
				if (it.thumb) row.querySelector("img").src = it.thumb;
				const ring = ringOf(it.geometry);
				row.addEventListener("mouseenter", () => setHover(ring), { signal });
				row.addEventListener("mouseleave", () => setHover(null), { signal });
				row.addEventListener("click", async () => {
					panel.querySelectorAll(".stac-row.on").forEach(x => x.classList.remove("on"));
					row.classList.add("on"); status(t("Loading…"));
					setHover(null);   // 枠は消す＝範囲は載った画像自身が示す
					try {
						const href = await it.resolve();
						await loadCog(href, { fit: activeHref === null, ...(it.cog || {}), ...(it.renew ? { fetch: renewing(it.resolve, href) } : {}) });   // 初回だけシーンへ寄る＝以降は据え置きで日付比較
						activeHref = href; status("");
					} catch (e) { status(t("Search failed") + ": " + e.message); }
				}, { signal });
				$("#stac-list").append(row);
			}
		} catch (e) { if (e?.name !== "AbortError") { console.warn("[stac]", e); status(t("Search failed")); } }
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
