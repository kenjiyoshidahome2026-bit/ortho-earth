// 名所の 3D 模型（写真測量スキャン・CC BY）を実在の場所に置いて見せる showcase（models.html から遅移 import）。
// quakes（地下）・sats（地上）と同じ骨格：器＝models.html／一覧と飛行と配線＝ここ／読み込みと描画＝エンジンの model ガジェット（gadgets/model.js＝
// loaders.gl → PLATEAU と同じ建物メッシュ経路・renderer の meshSet スロット）。
//
// 台帳＝ortho-data/japan/models.json（id・名前 ja/en・飛び先・出典）。GLB 本体は台帳の base（bucket GIS/models/<id>.glb）から fetch。
// 中身＝PLATEAU の建築物 LOD3（テクスチャ付き）を 3D Tiles 配信から名所のぶんだけ抜いて束ねた物（apps/uploader の npm run landmarks）。
// 置き場所は glb 自身が持つ（CESIUM_RTC／絶対 ECEF）＝lon/lat は飛び先の指定であって錨ではない。
// 一覧のカードをクリック＝①先に視点へ飛ぶ（遷移の時間＝読み込みの準備時間）②並行で GLB を取りに行き、届いたら設置点に立てる（fit はしない＝視点は台帳が正）。
// 未アップロード（404）でも場所へは飛ぶ＝候補の取捨（本人）は場所と絵で判断できる。
// 選んだ模型は GLB／glTF(.zip) でそのまま落とせる＝このデモの芯（3D Tiles を GLB へ変換してから描いている）。?m=<id> で起動時に選ぶ（共有）。
import { gunzip } from "geopbf/gzip";
import { convertToFile, FORMATS } from "glbconv";
import { createPanel } from "common/panel";   // 案内パネルの枠（共有エンジンの入口）
import type { DecodeDraco, DracoDecoded, FormatName, TranscodeImage } from "glbconv";
import type { GlobeMap, ModelHandle } from "@ortho-earth/globe";   // GLB → glTF/OBJ/PLY/STL/USDZ/3D Tiles（依存ゼロの変換ライブラリ・Draco は注入口）
import { tr, setLang, getLang, loadPage } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語（i18n.js の作法）。モジュール評価時に t() を呼ばない
const t = tr();

// 台帳（models.json）の 1 件と全体。名前・場所・作者は言語別の表（{ ja, en }）か素の文字列
type Text = Record<string, string> | string;
export interface ModelEntry { id: string; name?: Text; place?: Text; author?: Text; license?: string; thumb?: string; mb?: number; url?: string; source?: string;
	lon: number; lat: number; zoom?: number; tilt?: number; bearing?: number; ground?: string; mask?: boolean }
export interface ModelCatalog { base?: string; models?: ModelEntry[] }

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
const fmt = (n: number) => n.toLocaleString(getLang());

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountModels(map: GlobeMap, { catalog, panelHost }: { catalog?: string | ModelCatalog; panelHost?: HTMLElement } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/models/${c}.json`));   // 訳を用意してから UI を組む（i18n は共有エンジンの実体＝エンジンと同じ言語状態）。ページの辞書（i18n/pages/models.json）も足す
	document.title = t("Landmarks in GLB — ortho-japan");   // 器（models.html）の題名と説明もここで＝i18n の走査器が読む頁の本体（.ts）に置く
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Japanese landmarks as PLATEAU LOD3 city models, read straight from GLB on a 3D globe. Download each one as GLB or glTF."));
	const mapEl = map.mapEl;
	const lang = getLang();
	const L = (v: Text | undefined) => (v && typeof v === "object") ? (v[lang] ?? v.en ?? Object.values(v)[0] ?? "") : (v ?? "");

	// 台帳
	const doc: ModelCatalog = typeof catalog === "string" ? await (await fetch(catalog, { credentials: "omit" })).json() : catalog as ModelCatalog;
	const base = doc.base ?? "", models = doc.models ?? [];
	const urlOf = (m: ModelEntry) => m.url ?? (base + m.id + ".glb");

	// ── パネル（quakes/sats と同じ意匠＝暗いガラス）──
	// 枠（見出し・副題・折り畳み・PC は右上／スマホは下端のシート）＝共通の器 common/panel。ここは中身だけ
	const P = createPanel({ host: panelHost || mapEl, title: t("Landmarks in GLB"), cls: "models-panel",
		labels: { fold: t("Collapse panel"), unfold: t("Expand panel") } });
	const panel = P.el;
	P.sub.innerHTML = `${t("Click a landmark to fly there and see its 3D model.")}<br>${t("The models are PLATEAU LOD3 city models (MLIT Japan, CC BY 4.0), read straight from GLB.")}`;
	P.body.insertAdjacentHTML("beforebegin", `<style>
.models-panel .status{margin:6px 0 8px;color:#fff;min-height:1.4em}
.models-panel .status.err{color:#ffb86b}
.models-panel .list{display:flex;flex-direction:column;gap:6px}
.models-panel .card{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:center;width:100%;border:1px solid transparent;background:rgba(255,255,255,.05);
 text-align:start;padding:6px;border-radius:9px;cursor:pointer;font:inherit;color:inherit}
.models-panel .card:hover{background:rgba(255,255,255,.12)}
.models-panel .card.on{border-color:rgba(255,255,255,.55);background:rgba(255,255,255,.14)}
.models-panel .card span{min-width:0}
.models-panel .card img{width:96px;height:54px;object-fit:cover;border-radius:6px;background:#1a2236;display:block}
.models-panel .card .noimg{width:96px;height:54px;border-radius:6px;display:block;background:linear-gradient(135deg,#27304a,#161d2e)}
.models-panel .card b{display:block;font-size:13px;line-height:1.3;overflow-wrap:anywhere}
.models-panel .card small{display:block;color:#9aa6bd;font-size:11px;line-height:1.4;overflow-wrap:anywhere}
.models-panel .cur{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12)}
.models-panel .cur b{font-size:13.5px}
.models-panel .cur .m{color:#b9c3d6;font-size:11.5px;overflow-wrap:anywhere}
.models-panel .cur a{color:#9cc4ff}
.models-panel .dl{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:8px;color:#b9c3d6}
.models-panel .dl a{display:inline-block;border-radius:8px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#e7ecf5;text-decoration:none;padding:3px 10px}
.models-panel .dl a:hover{background:rgba(255,255,255,.18)}
.models-panel .dl a[aria-disabled="true"]{opacity:.45;pointer-events:none}
.models-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
</style>`);
	P.body.innerHTML = `
<div class="status" data-k="status"></div>
<div class="list" data-k="list"></div>
<div class="cur" data-k="cur" style="display:none"></div>`;
	const $ = (k: string) => panel.querySelector(`[data-k="${k}"]`) as HTMLElement;

	// 一覧
	$("list").innerHTML = models.map(m => `<button type="button" class="card" data-id="${esc(m.id)}">
		${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="noimg" aria-hidden="true"></span>`}
		<span><b>${esc(L(m.name))}</b><small>${esc(L(m.place))}</small><small>${esc(L(m.author))} · ${esc(m.license)}${m.mb ? ` · ${fmt(m.mb)} MB` : ""}</small></span></button>`).join("");
	$("list").addEventListener("click", e => { const b = (e.target as Element).closest<HTMLElement>(".card"); if (b) show(b.dataset.id!); });

	// ── 表示 ──
	let cur: ModelEntry | null = null, ctl: ModelHandle | null = null, seq = 0, glb: { id: string; bytes: Uint8Array } | null = null;   // glb＝{ id, bytes }＝どの模型のバイト列かを結ぶ（B13・旧＝glbBytes 単独＝切替後も前の模型が新しい名前で落ちた）
	// ── ダウンロード（このデモの芯＝「3D Tiles を glb に変換してから描いている」ので、その glb をそのまま渡せる）──
	// GLB ＝描いているバイト列そのもの。glTF ＝同じ中身を仕様どおり .gltf（JSON）＋ .bin（バイナリ）へ分けて zip に。
	// 画像は bufferView 参照のまま .bin に載る＝外部ファイルは増えない（glTF 2.0 の正式な形）。
	const saveAs = (blob: Blob, name: string) => {
		const u = URL.createObjectURL(blob), a = document.createElement("a");
		a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(u), 10000);
	};
	// 変換＝glbconv（依存ゼロ）。Draco の展開だけは読み手を注入する（PLATEAU と同じ loaders.gl の実体を遅延で借りる）
	let dracoP: Promise<{ parse: typeof import("@ortho-earth/globe/mesh-loaders.js").loadersParse; DracoLoader: typeof import("@ortho-earth/globe/mesh-loaders.js").DracoLoader }> | null = null;
	const decodeDraco: DecodeDraco = async (bytes, attrIds) => {
		dracoP ??= import("@ortho-earth/globe/mesh-loaders.js").then(m => ({ parse: m.loadersParse, DracoLoader: m.DracoLoader }));
		const { parse, DracoLoader } = await dracoP;
		return parse(bytes!, DracoLoader, { draco: { attributeNameEntry: "name" } }) as Promise<DracoDecoded>;
	};
	// テクスチャの差し替え（OBJ/USDZ 向け）：webp のままだと読めない相手が多い＝ブラウザで jpeg へ焼き直す
	const transcodeImage: TranscodeImage = async (bytes, mime, want) => {
		const bm = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
		const cv = new OffscreenCanvas(bm.width, bm.height);
		cv.getContext("2d")!.drawImage(bm, 0, 0);
		const out = await cv.convertToBlob({ type: want, quality: 0.9 });
		bm.close();
		return { mime: out.type || want, bytes: new Uint8Array(await out.arrayBuffer()) };
	};
	const DL: FormatName[] = ["glb", "gltf", "obj", "ply", "stl", "usdz", "3dtiles"];   // パネルに出す順（左から使う頻度）
	const setStatus = (msg: string, err = false) => { const el = $("status"); el.textContent = msg || ""; el.classList.toggle("err", !!err); };
	const showCur = (m: ModelEntry | null) => {
		const el = $("cur");
		if (!m) { el.style.display = "none"; return; }
		el.style.display = "";
		// 出典（CC BY の義務）とダウンロードだけ。向き/縮尺の調整欄は廃止＝PLATEAU の glb は置き場所を自分で持つ（CESIUM_RTC）
		el.innerHTML = `<b>${esc(L(m.name))}</b>
			<div class="m">${t("3D model: $1 ($2)", esc(L(m.author)), esc(m.license))}${m.source ? ' · <a href="' + esc(m.source) + '" target="_blank" rel="noopener">' + t("Source ##link") + "</a>" : ""}</div>
			<div class="dl">${t("Download")}${DL.map(k => `<a href="#" data-f="${k}">${FORMATS[k].label}</a>`).join("")}</div>`;
		el.querySelector(".dl")!.addEventListener("click", async e => {
			const link = (e.target as Element).closest<HTMLElement>("a[data-f]"); if (!link) return;
			e.preventDefault();
			if (glb?.id !== m.id) return;   // 読み込み中・失敗＝まだこの模型のバイト列が無い
			const was = link.textContent;
			link.setAttribute("aria-disabled", "true"); link.textContent = "…";
			try {
				const out = await convertToFile(glb.bytes, link.dataset.f as FormatName, { name: m.id, decodeDraco, transcodeImage });
				saveAs(new Blob([out.bytes as Uint8Array<ArrayBuffer>], { type: out.type }), out.name);
			} catch (err) { console.error("[models] convert failed", link.dataset.f, err); setStatus(t("Failed to load: $1", String((err as Error)?.message || err)), true); }
			finally { link.removeAttribute("aria-disabled"); link.textContent = was; }
		});
	};
	async function load(m: ModelEntry) {
		const my = ++seq;
		setStatus(t("Loading model…"));
		try {
			// bucket の置き物は uploader が gzip で置く（Content-Type application/gzip＝素の fetch では解かれない）＝自分で取って gunzip（平文は素通し）してから File で渡す
			const r = await fetch(urlOf(m), { credentials: "omit" });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const blob = await gunzip(await r.blob());
			if (my !== seq) return;
			const bytes = new Uint8Array(await blob.arrayBuffer());
			if (my !== seq) return;
			glb = { id: m.id, bytes };   // ダウンロード用に持っておく（描画にも同じ物を渡す）
			// ground="each"＝建物ごとに接地（PLATEAU の一区画＝高台の城が浮かない）。台帳で ground:"batch" と書けば一体接地へ
			const c = await map.gadget.model(new File([bytes], m.id + ".glb", { type: "model/gltf-binary" }), { at: [m.lon, m.lat], fit: false, ground: m.ground || "each", mask: m.mask !== false } as { at: [number, number]; fit: boolean });   // as＝ground・mask は gadget の load が受ける（globe.d.ts の model の opts に未記載）   // mask＝足元の基図建物を伏せる（壁の明滅を断つ）
			if (my !== seq) return;   // 途中で別の模型が選ばれた＝後勝ち（ガジェットは単一スロット）
			ctl = c; setStatus("");
		} catch (e) {
			if (my !== seq) return;
			const s = String((e as Error)?.message || e);
			setStatus(/HTTP 40[34]/.test(s) ? t("Model not uploaded yet: $1", urlOf(m)) : t("Failed to load: $1", s), true);
		}
	}
	function show(id: string, { fly = true } = {}) {
		const m = models.find(x => x.id === id); if (!m) return;
		cur = m;
		for (const b of panel.querySelectorAll<HTMLElement>(".card")) b.classList.toggle("on", b.dataset.id === id);
		showCur(m);
		if (fly) map.flyTo(m.lon, m.lat, m.zoom ?? 17, m.tilt ?? 55, m.bearing ?? 0);   // 先に飛ぶ＝遷移の裏で読み込む
		try { const u = new URL(location.href); u.searchParams.set("m", id); history.replaceState(null, "", u); } catch {}
		load(m);
	}
	const first = new URLSearchParams(location.search).get("m");
	if (first && models.some(m => m.id === first)) show(first);

	return {
		models, show,
		get current() { return cur; },
		get stats() { return ctl?.stats || null; },
		destroy() { seq++; ctl?.clear?.(); P.destroy(); },
	};
}
