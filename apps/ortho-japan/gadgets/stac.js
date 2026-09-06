// ガジェット本体：衛星シーン検索＝「STAC が見つけ、COG が運ぶ」。
// Earth Search（Element 84 の公開 STAC API・CORS 開放・鯖レスの流儀どおり直読み）へ現在ビューの bbox＋期間を
// POST し、Sentinel-2 L2A のシーンを雲量昇順で一覧。行クリックで assets.visual（TCI の COG）を
// map.gadget.cog へ＝球にドレープ。シーン切替は fit:false＝カメラ据え置き（同じ場所の別日を見比べる道具）。
// 四戒: 独立（注入 loadCog/clearCog のみ）／遅延（stac-stub が初回クリックで import）／抽象アクセス／UI はこのパネルのみ。
import { tr } from "../i18n.js";
const t = tr({
	"衛星画像を探す": "Find satellite imagery",
	"この地点で検索": "Search at this spot",
	"検索中…": "Searching…",
	"シーンが見つかりません（範囲か期間を広げてみてください）": "No scenes found (try a wider area or date range)",
	"検索に失敗しました": "Search failed",
	"雲": "cloud",
	"画像を消す": "Remove imagery",
	"読込中…": "Loading…",
});

const API = "https://earth-search.aws.element84.com/v1/search";   // 公開 STAC API（Sentinel-2 L2A COGs on AWS）
const CSS = `
#stac-panel { position: absolute; top: 8px; left: 52px; width: min(300px, calc(100vw - 64px)); max-height: min(70%, 560px);
	display: none; flex-direction: column; background: rgba(255,255,255,.96); color: #3f4757; border-radius: 10px;
	box-shadow: 0 4px 18px rgba(0,0,0,.18); font: 12px/1.5 system-ui; overflow: hidden; }
#stac-panel.on { display: flex; }
#stac-head { display: flex; gap: 6px; align-items: center; padding: 8px 10px 6px; }
#stac-head input[type=date] { flex: 1; min-width: 0; font: 11px system-ui; color: inherit; border: 1px solid #cdd3dd; border-radius: 6px; padding: 2px 4px; background: #fff; }
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
			<input type="date" id="stac-from" value="${d(from)}"><span>–</span><input type="date" id="stac-to" value="${d(today)}">
			<button id="stac-go">${t("この地点で検索")}</button>
		</div>
		<div id="stac-status"></div>
		<div id="stac-list"></div>
		<div id="stac-foot"><span>Sentinel-2 © Copernicus / Earth Search</span><button id="stac-clear">${t("画像を消す")}</button></div>`;
	mapEl.append(panel);   // 末尾append＝DOM順で最上面（z-index全廃の裁き）
	const $ = (id) => panel.querySelector(id);
	const status = (s) => { $("#stac-status").textContent = s; };

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
	// ホバー開始＝辺を16分割した標本点列を作り、標高（map.getHeight＝非同期）を一括プリフェッチ→到着で差し替え再描画。
	// 未着の間は海抜0で即描き＝反応の速さを落とさない（数百msで地形へ吸い付く）。
	const setHover = (ring) => {
		if (!ring) { hoverPts = null; hoverH = null; footOff(); drawFoot(); return; }
		const pts = [];
		for (let i = 0; i < ring.length; i++) {
			const a = ring[i], b = ring[(i + 1) % ring.length];
			for (let k = 0; k < 16; k++) pts.push([a[0] + (b[0] - a[0]) * k / 16, a[1] + (b[1] - a[1]) * k / 16]);
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

	let ac = null, activeHref = null;
	const search = async () => {
		// 意味論＝「画面中心の地点が写っているシーン」（STAC intersects に中心点）。bbox 検索だと「かすった」周辺タイルが
		// 混ざり、雲量ソート×limit で肝心の中心タイルが締め出される（本人指摘 9/6）。点なら範囲外ゼロ・中心は必ず写る。
		const c = map.unprojectXY(mapEl.clientWidth / 2, mapEl.clientHeight / 2);
		const bbox = c ? null : viewBbox();   // 球外（宇宙ビュー等）だけ bbox にフォールバック
		if (!c && !bbox) return status(t("シーンが見つかりません（範囲か期間を広げてみてください）"));
		ac?.abort(); ac = new AbortController();
		signal?.addEventListener("abort", () => ac?.abort(), { once: true });
		status(t("検索中…")); $("#stac-list").replaceChildren();
		try {
			const r = await fetch(API, {
				method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal, credentials: "omit",
				body: JSON.stringify({
					collections: ["sentinel-2-l2a"],
					...(c ? { intersects: { type: "Point", coordinates: [c[0], c[1]] } } : { bbox }),
					datetime: `${$("#stac-from").value}T00:00:00Z/${$("#stac-to").value}T23:59:59Z`,
					limit: 40, sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
				}),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const items = (await r.json()).features || [];
			status(items.length ? "" : t("シーンが見つかりません（範囲か期間を広げてみてください）"));
			for (const it of items.slice(0, 15)) {
				const href = it.assets?.visual?.href;
				if (!href) continue;
				const cloud = Math.round(it.properties?.["eo:cloud_cover"] ?? -1);
				const date = (it.properties?.datetime || "").slice(0, 10);
				const grid = (it.properties?.["grid:code"] || "").replace(/^MGRS-/, "");
				const row = document.createElement("button");
				row.className = "stac-row"; row.dataset.href = href;
				row.innerHTML = `<img loading="lazy" alt=""><span><span class="d">${date}</span> <span class="c">${grid}</span><br><span class="c">${t("雲")} ${cloud >= 0 ? cloud + "%" : "?"}</span></span>`;
				const th = it.assets?.thumbnail?.href; if (th) row.querySelector("img").src = th;
				const ring = ringOf(it.geometry);
				row.addEventListener("mouseenter", () => setHover(ring), { signal });
				row.addEventListener("mouseleave", () => setHover(null), { signal });
				row.addEventListener("click", async () => {
					panel.querySelectorAll(".stac-row.on").forEach(x => x.classList.remove("on"));
					row.classList.add("on"); status(t("読込中…"));
					setHover(null);   // 枠は消す＝範囲は載った画像自身が示す
					try {
						await loadCog(href, { fit: activeHref === null });   // 初回だけシーンへ寄る＝以降は据え置きで日付比較
						activeHref = href; status("");
					} catch (e) { status(t("検索に失敗しました") + ": " + e.message); }
				}, { signal });
				$("#stac-list").append(row);
			}
		} catch (e) { if (e?.name !== "AbortError") { console.warn("[stac]", e); status(t("検索に失敗しました")); } }
	};

	$("#stac-go").addEventListener("click", search, { signal });
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
