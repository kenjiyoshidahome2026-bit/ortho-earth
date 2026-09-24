// クラウド保存パネル（共通）：account Worker（/auth*・/me*）へファイルを出し入れする器。geoedit（geopbf）と
// scenes エディタ（.scenes）の両方が使う＝中身の作り方/開き方はフックで注入し、ここは「ログイン・一覧・保存・開く・削除・
// 公開台帳」の器だけを持つ（ガジェット三戒＝DOM自給・CSS自給・依存は fetch と注入フックだけ）。
// 全て同一オリジン（www.ortho-earth.com。dev は vite proxy で :8787 へ）＝CORS もクロスサイト Cookie も無し。
// ログインはトップレベル遷移（<a href="/auth/login/…">）＝fetch にしない（OAuth リダイレクトの掟）。
// hooks = {
//   getFile: async () => File|null           保存する中身（名前は入力欄が決める・空なら「保存するデータがありません」）
//   open: async (ArrayBuffer, name) => bool   一覧から開く（真＝受理・偽＝この器では読めない）
//   accept?: name => bool                     一覧に出す名前の条件（ユーザーの置き場は1つ＝各エディタは自分の種類だけ見せる）
//   defaultName?: () => string                保存欄の初期値／ ext?: ".geopbf"＝拡張子なしの名前に補う／ contentType?: PUT の Content-Type
//   className?: "oj-cloud"                    器の class（位置決めは呼び手の CSS＝ここは見た目だけ）
//   works?: bool, map?, overlayEl?            公開台帳の節を出すか（地図作品用）・公開サムネの材料
// }
import { tr } from "../i18n.js";
import { composeLayersToCanvas } from "./compose.js";   // 層合成の核（shot/print と同じ）＝公開サムネ
const t = tr();

const fmtSize = n =>
	n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" :
	n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" :
	n >= 1e3 ? (n / 1e3).toFixed(1) + " KB" : n + " B";
const fmtDate = s => new Date(s * 1000).toLocaleDateString();
const ERRMSG = () => ({   // サーバーの error コード → 人向けの言葉（形は workers/files.js が正本）
	file_too_large: t("Each file is limited to 200MB"),
	quota_exceeded: t("The 1GB total limit has been reached (delete files you no longer need)"),
	too_many_files: t("Up to 100 files"),
	bad_request: t("Invalid file name"),
	unauthorized: t("Session expired (reopen the panel)"),
	bad_url: t("Invalid URL (use https:// or gh:user/repo/path)"),
	too_many_works: t("The catalog holds up to 50 entries"),
	rate_limited: t("Up to 20 publications per day (try again tomorrow)"),
});

// 見た目（CSS自給・位置決めは呼び手）＝geoedit の浮きパネルと同じ黒硝子。呼び手が同系の class を重ねても値が同じ＝衝突しない
const CSS = `
.oj-cloud { box-sizing:border-box; padding:8px 12px 12px; border-radius:10px; background:rgba(16,24,44,.55); border:1px solid rgba(255,255,255,.14);
	backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); font:12px/1.6 "Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif; color:#cdd6e6; }
.oj-cloud h3 { margin:0 0 6px; font-size:12px; font-weight:600; opacity:.85; }
.oj-cloud p { margin:4px 0; }
.oj-cloud hr { border:none; border-top:1px solid rgba(255,255,255,.12); margin:8px 0; }
.oj-cloud .head { display:flex; align-items:center; gap:6px; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid rgba(255,255,255,.12); }
.oj-cloud .head h3 { flex:1; margin:0; }
.oj-cloud .row { display:flex; align-items:center; gap:6px; margin:4px 0; }
.oj-cloud input { all:unset; box-sizing:border-box; padding:2px 5px; border-radius:5px; background:rgba(255,255,255,.08); color:#e8eef8; }
.oj-cloud button { all:unset; cursor:pointer; padding:4px 9px; border-radius:7px; background:rgba(255,255,255,.08); color:#cdd6e6; white-space:nowrap; }
.oj-cloud button:hover { background:rgba(255,255,255,.16); }
.oj-cloud button:disabled { opacity:.4; cursor:default; }
.oj-cloud a.login { display:block; margin:6px 0; padding:6px 10px; border-radius:7px; background:rgba(255,255,255,.08); color:#e8eef8; text-decoration:none; }
.oj-cloud .name { flex:1; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.oj-cloud .meta { opacity:.6; white-space:nowrap; }`;
const ensureCss = () => { if (!document.getElementById("oj-cloud-css")) { const s = document.createElement("style"); s.id = "oj-cloud-css"; s.textContent = CSS; document.head.append(s); } };

// 公開サムネ＝現在の画面（エンジン生スナップ＋任意のオーバレイ canvas）を 480×300 cover へ縮めて webp。
// 撮れない環境（旧lib・スナップ非対応）は null＝サムネ無しのまま公開は通す（best-effort・公開を人質にしない）。
async function makeThumb(map, overlayEl) {
	try {
		if (!map?.requestSnapshot) return null;
		const full = composeLayersToCanvas(await map.requestSnapshot(), null);
		if (overlayEl?.width) full.getContext("2d").drawImage(overlayEl, 0, 0, full.width, full.height);
		const W = 480, H = 300, out = new OffscreenCanvas(W, H), ctx = out.getContext("2d");
		const s = Math.max(W / full.width, H / full.height);
		ctx.drawImage(full, (W - full.width * s) / 2, (H - full.height * s) / 2, full.width * s, full.height * s);
		return await out.convertToBlob({ type: "image/webp", quality: 0.8 });
	} catch (e) { console.warn("[cloud] thumb capture failed", e); return null; }
}

export function cloudPanel(container, hooks, toast) {
	ensureCss();
	const { accept = () => true, ext = "", contentType = "application/octet-stream", works = false } = hooks;
	container.querySelector(".oj-cloud")?.remove();   // 二重開き防止＝開き直し
	const panel = document.createElement("div");
	panel.className = `oj-cloud ${hooks.className || ""}`.trim();
	container.append(panel);
	const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
	const fail = async res => toast(ERRMSG()[(await res.json().catch(() => ({}))).error] || t("Failed (HTTP $1)", res.status));

	async function render() {
		panel.innerHTML = ""; panel.append(el("h3", t("Cloud save")), el("p", t("Connecting…")));
		let meRes;
		try { meRes = await fetch("/me", { credentials: "same-origin" }); }
		catch { panel.querySelector("p").textContent = t("Cannot reach the server"); addClose(); return; }
		if (meRes.status === 401) return renderLogin();
		if (!meRes.ok || !(meRes.headers.get("Content-Type") || "").includes("json"))
			{ panel.querySelector("p").textContent = t("Cloud save is not available yet"); addClose(); return; }   // Worker 未デプロイ＝assets の404等
		renderFiles(await meRes.json());
	}

	function renderLogin() {
		panel.innerHTML = ""; panel.append(el("h3", t("Cloud save")), el("p", t("Log in to save your work on the server.")));
		const ret = encodeURIComponent(location.pathname + location.search);
		// X は2026年2月のAPI従量課金化（クレカ登録必須・ログイン毎に課金）で保留＝Worker側の対応は温存。
		for (const [p, label] of [["github", "GitHub"], ["google", "Google"]]) {
			const a = el("a", t("Log in with $1", label), "login");
			a.href = `/auth/login/${p}?return=${ret}`;
			panel.append(a);
		}
		panel.append(el("p", t("Your work is autosaved, so you will return here after logging in.")));
		addClose();
	}

	async function renderFiles(me) {
		panel.innerHTML = "";
		const head = el("div", null, "head");
		head.append(el("h3", me.user.name || t("Logged in")));
		const logout = el("button", t("Log out"));
		logout.onclick = async () => { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }); render(); };
		head.append(logout);
		panel.append(head);

		// 保存（名前を付けて）
		const row = el("div", null, "row");
		const name = el("input");
		name.placeholder = t("File name") + (ext ? `（${ext}）` : "");
		name.value = hooks.defaultName?.() ?? "";
		name.style.flex = "1";
		const saveB = el("button", t("Save"));
		saveB.onclick = () => save(name.value, saveB);
		row.append(name, saveB);
		panel.append(row);

		// 一覧（この器で開ける名前だけ＝置き場は1つ・種類はエディタ毎）
		const listRes = await fetch("/me/files", { credentials: "same-origin" });
		if (!listRes.ok) return fail(listRes);
		const files = ((await listRes.json()).files || []).filter(f => accept(f.name));
		if (!files.length) panel.append(el("p", t("No saved files yet")));
		for (const f of files) {
			const r = el("div", null, "row");
			const openB = el("button", f.name, "name");
			openB.title = t("Open (replaces the current work)");
			openB.onclick = () => open(f.name);
			const meta = el("span", `${fmtSize(f.size)}・${fmtDate(f.updated_at)}`, "meta");
			const delB = el("button", "✕");
			delB.title = t("Delete");
			delB.onclick = async () => {
				if (!confirm(t("Delete “$1” from the cloud?", f.name))) return;
				const res = await fetch(`/me/files/${encodeURIComponent(f.name)}`, { method: "DELETE", credentials: "same-origin" });
				res.ok ? render() : fail(res);
			};
			r.append(openB, meta, delB);
			panel.append(r);
		}
		panel.append(el("p", t("Usage: $1 files, $2 / $3", me.usage.files, fmtSize(me.usage.bytes), fmtSize(me.usage.maxBytes))));

		if (works) await renderWorks();
		addClose();
	}

	// ---- 公開台帳（地図作品用） ---- データ本体は預からない＝GitHub 等の公開 URL を登録して台帳に載せる（workers/works.js が正本）。
	// 台帳の行＝共有 URL（/japan/?g=…）そのもの。題名クリック＝共有 URL をコピー＝名刺・SNS へそのまま。
	async function renderWorks() {
		panel.append(el("hr"), el("h3", t("Public catalog")));
		const urlRow = el("div", null, "row");
		const urlIn = el("input");
		urlIn.placeholder = t("Public URL (gh:user/repo/map.geopbf or https://…)");
		urlIn.style.flex = "1";
		urlRow.append(urlIn);
		const tiRow = el("div", null, "row");
		const titleIn = el("input");
		titleIn.placeholder = t("Title ##publish");
		titleIn.style.flex = "1";
		const pubB = el("button", t("Publish"));
		pubB.onclick = async () => {
			const url = urlIn.value.trim(), title = titleIn.value.trim();
			if (!url || !title) return toast(t("Enter the public URL and a title"));
			try {
				pubB.disabled = true;
				const res = await fetch("/me/works", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, url }) });
				if (!res.ok) return fail(res);
				const { id, updated } = await res.json();
				const blob = await makeThumb(hooks.map, hooks.overlayEl?.());   // 今見えている画面がサムネ＝再公開のたびに撮り直し
				if (blob) await fetch(`/me/works/${id}/thumb`, { method: "PUT", credentials: "same-origin", body: blob, headers: { "Content-Type": "image/webp" } }).catch(() => {});
				toast(updated ? t("Catalog entry updated") : t("Published to the catalog"));
				render();
			} finally { pubB.disabled = false; }
		};
		tiRow.append(titleIn, pubB);
		panel.append(urlRow, tiRow);
		// 共有 URL＝今の頁の置き場（ディレクトリ）の入口＝その家の地図（/japan/geoedit → /japan/・/globe/quakes → /globe/）。地域の URL は書かない。hooks.shareBase で上書き可
		const shareBase = hooks.shareBase ?? new URL("./", location.href).pathname;
		const shareUrl = w => `${location.origin}${shareBase}?g=${encodeURIComponent(w.url)}${w.view || ""}`;
		const wRes = await fetch("/me/works", { credentials: "same-origin" });
		if (wRes.ok) for (const w of (await wRes.json()).works) {
			const r = el("div", null, "row");
			const copyB = el("button", w.title, "name");
			copyB.title = t("Copy share URL");
			copyB.onclick = async () => { await navigator.clipboard?.writeText(shareUrl(w)); toast(t("Share URL copied")); };
			const delB = el("button", "✕");
			delB.title = t("Remove from the catalog (the data itself stays where you host it)");
			delB.onclick = async () => {
				if (!confirm(t("Remove “$1” from the catalog?", w.title))) return;
				const res = await fetch(`/me/works/${w.id}`, { method: "DELETE", credentials: "same-origin" });
				res.ok ? render() : fail(res);
			};
			r.append(copyB, delB);
			panel.append(r);
		}
	}

	async function save(name, btn) {
		name = (name || "").trim();
		if (!name) return toast(t("Enter a file name"));
		if (/[/\\]/.test(name) || name.length > 100) return toast(t("File names cannot contain / (max 100 chars)"));
		if (ext && !/\.[A-Za-z0-9]+$/.test(name)) name += ext;
		try {
			btn.disabled = true;
			const file = await hooks.getFile();
			if (!file) return toast(t("Nothing to save"));
			const res = await fetch(`/me/files/${encodeURIComponent(name)}`, { method: "PUT", credentials: "same-origin", body: file, headers: { "Content-Type": contentType } });
			if (!res.ok) return fail(res);
			toast(t("Saved to the cloud: $1", name));
			render();
		} catch (e) { console.error("[cloud] save failed", e); toast(t("Save failed")); }
		finally { btn.disabled = false; }
	}

	async function open(name) {
		try {
			toast(t("Loading… $1", name));
			const res = await fetch(`/me/files/${encodeURIComponent(name)}`, { credentials: "same-origin" });
			if (!res.ok) return fail(res);
			const buf = await res.arrayBuffer();
			panel.remove();
			if (!(await hooks.open(buf, name))) toast(t("This editor cannot open that file"));
		} catch (e) { console.error("[cloud] open failed", e); toast(t("Failed to load")); }
	}

	function addClose() {
		const close = el("button", t("Close"));
		close.onclick = () => panel.remove();
		panel.append(el("hr"), close);
	}

	render();
	return panel;
}
