// クラウド保存パネル：account Worker（/auth*・/me*）へ GeoPBF を出し入れする。
// 全て同一オリジン（www.ortho-earth.com。dev は vite proxy で :8787 へ）＝CORS もクロスサイト Cookie も無し。
// ログインはトップレベル遷移（<a href="/auth/login/…">）＝fetch にしない（OAuth リダイレクトの掟）。
// 編集中の内容は IndexedDB 自動保存が生きているのでログイン往復では消えない。

import { tr } from "../../ortho-japan/i18n.js";   // UI二言語化（ja正典・en辞書引き＝エンジン i18n.js の流儀。辞書は各モジュール持参）
const t = tr({
	"1ファイル 200MB までです": "Each file is limited to 200MB",
	"合計 1GB の上限に達しました（不要なファイルを削除してください）": "The 1GB total limit has been reached (delete files you no longer need)",
	"100 ファイルまでです": "Up to 100 files",
	"ファイル名が使えません": "Invalid file name",
	"ログインが切れました（開き直してください）": "Session expired (reopen the panel)",
	"URL が使えません（https:// か gh:user/repo/path 形式）": "Invalid URL (use https:// or gh:user/repo/path)",
	"台帳は 50 件までです": "The catalog holds up to 50 entries",
	"公開は 1 日 20 件までです（明日どうぞ）": "Up to 20 publications per day (try again tomorrow)",
	"失敗しました (HTTP {0})": "Failed (HTTP {0})",
	"クラウド保存": "Cloud save",
	"接続中…": "Connecting…",
	"サーバーに接続できません": "Cannot reach the server",
	"クラウド保存は準備中です": "Cloud save is not available yet",
	"ログインすると編集データをサーバーに保存できます。": "Log in to save your edits on the server.",
	"{0} でログイン": "Log in with {0}",
	"編集中の内容は自動保存されるので、ログイン後この画面に戻ります。": "Your edits are autosaved, so you will return here after logging in.",
	"ログイン中": "Logged in",
	"ログアウト": "Log out",
	"ファイル名（.geopbf）": "File name (.geopbf)",
	"保存": "Save",
	"保存されたファイルはまだありません": "No saved files yet",
	"開く（現在の編集は置き換わります）": "Open (replaces the current edits)",
	"削除": "Delete",
	"「{0}」をクラウドから削除しますか？": "Delete “{0}” from the cloud?",
	"使用量: {0} ファイル・{1} / {2}": "Usage: {0} files, {1} / {2}",
	"公開台帳": "Public catalog",
	"公開URL（gh:user/repo/map.geopbf か https://…）": "Public URL (gh:user/repo/map.geopbf or https://…)",
	"題名": "Title",
	"公開": "Publish",
	"公開URL と題名を入れてください": "Enter the public URL and a title",
	"台帳を更新しました": "Catalog entry updated",
	"台帳に公開しました": "Published to the catalog",
	"共有URLをコピー": "Copy share URL",
	"共有URLをコピーしました": "Share URL copied",
	"台帳から下ろす（データ本体は消えません＝あなたの置き場のまま）": "Remove from the catalog (the data itself stays where you host it)",
	"「{0}」を台帳から下ろしますか？": "Remove “{0}” from the catalog?",
	"ファイル名を入れてください": "Enter a file name",
	"ファイル名に / は使えません（100字まで）": "File names cannot contain / (max 100 chars)",
	"保存するデータがありません": "Nothing to save",
	"エンコードに失敗しました": "Encoding failed",
	"クラウドへ保存: {0}": "Saved to the cloud: {0}",
	"保存に失敗しました": "Save failed",
	"読込中… {0}": "Loading… {0}",
	"読み込みに失敗しました": "Failed to load",
	"閉じる": "Close",
});
const fmtSize = n =>
	n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" :
	n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" :
	n >= 1e3 ? (n / 1e3).toFixed(1) + " KB" : n + " B";
const fmtDate = t => new Date(t * 1000).toLocaleDateString();
const ERRMSG = {   // サーバーの error コード → 人向けの言葉（形は workers/files.js が正本）
	file_too_large: t("1ファイル 200MB までです"),
	quota_exceeded: t("合計 1GB の上限に達しました（不要なファイルを削除してください）"),
	too_many_files: t("100 ファイルまでです"),
	bad_request: t("ファイル名が使えません"),
	unauthorized: t("ログインが切れました（開き直してください）"),
	bad_url: t("URL が使えません（https:// か gh:user/repo/path 形式）"),
	too_many_works: t("台帳は 50 件までです"),
	rate_limited: t("公開は 1 日 20 件までです（明日どうぞ）"),
};

import { composeLayersToCanvas } from "../../ortho-japan/gadgets/compose.js";   // 層合成の核（shot/print と同じ）

// 公開サムネ＝現在の画面（エンジン生スナップ+編集オーバレイ）を1枚に合成し 480×300 cover へ縮めて webp。
// 撮れない環境（旧lib・スナップ非対応）は null＝サムネ無しのまま公開は通す（best-effort・公開を人質にしない）。
async function makeThumb(map) {
	try {
		if (!map?.requestSnapshot) return null;
		const full = composeLayersToCanvas(await map.requestSnapshot(), null);
		const ov = map.mapEl?.querySelector(".ge-overlay");   // @シンボル・帯・blur＝作品の見た目はここに乗っている
		if (ov?.width) full.getContext("2d").drawImage(ov, 0, 0, full.width, full.height);
		const W = 480, H = 300, out = new OffscreenCanvas(W, H), ctx = out.getContext("2d");
		const s = Math.max(W / full.width, H / full.height);
		ctx.drawImage(full, (W - full.width * s) / 2, (H - full.height * s) / 2, full.width * s, full.height * s);
		return await out.convertToBlob({ type: "image/webp", quality: 0.8 });
	} catch (e) { console.warn("[geoedit] thumb capture failed", e); return null; }
}

// hooks = { getPbf: async()=>pbf|null（書き出しと同じ口）, loadBuffer: async(ArrayBuffer)=>void, map（サムネ撮影用） }
export function cloudPanel(container, hooks, toast) {
	container.querySelector(".ge-dialog")?.remove();   // 二重開き防止＝開き直し（書き出しと同じ一枠）
	const panel = document.createElement("div");
	panel.className = "ge-panel ge-cloud ge-dialog";
	container.append(panel);
	const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
	const fail = async res => toast(ERRMSG[(await res.json().catch(() => ({}))).error] || t("失敗しました (HTTP {0})", res.status));

	async function render() {
		panel.innerHTML = `<h3>${t("クラウド保存")}</h3><p>${t("接続中…")}</p>`;
		let meRes;
		try { meRes = await fetch("/me", { credentials: "same-origin" }); }
		catch { panel.querySelector("p").textContent = t("サーバーに接続できません"); return; }
		if (meRes.status === 401) return renderLogin();
		if (!meRes.ok || !(meRes.headers.get("Content-Type") || "").includes("json"))
			{ panel.querySelector("p").textContent = t("クラウド保存は準備中です"); return; }   // Worker 未デプロイ＝assets の404等
		renderFiles(await meRes.json());
	}

	function renderLogin() {
		panel.innerHTML = `<h3>${t("クラウド保存")}</h3><p>${t("ログインすると編集データをサーバーに保存できます。")}</p>`;
		const ret = encodeURIComponent(location.pathname + location.search);
		// X は2026年2月のAPI従量課金化（クレカ登録必須・ログイン毎に課金）で保留＝Worker側の対応は温存。
		// 復活はここに ["x", "X"] を足して account の X_CLIENT_ID/SECRET を投入するだけ。
		for (const [p, label] of [["github", "GitHub"], ["google", "Google"]]) {
			const a = el("a", t("{0} でログイン", label));
			a.href = `/auth/login/${p}?return=${ret}`;
			a.style.cssText = "display:block;margin:6px 0;padding:6px 10px;border-radius:7px;background:rgba(255,255,255,.08);color:#e8eef8;text-decoration:none";
			panel.append(a);
		}
		panel.append(el("p", t("編集中の内容は自動保存されるので、ログイン後この画面に戻ります。")));
		addClose();
	}

	async function renderFiles(me) {
		panel.innerHTML = "";
		const head = el("div", null, "ge-head");
		head.append(el("h3", me.user.name || t("ログイン中")));
		const logout = el("button", t("ログアウト"));
		logout.onclick = async () => { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }); render(); };
		head.append(logout);
		panel.append(head);

		// 保存（名前を付けて）
		const row = el("div", null, "ge-row");
		const name = el("input");
		name.placeholder = t("ファイル名（.geopbf）");
		name.value = `edit-${new Date().toISOString().slice(0, 10)}.geopbf`;
		name.style.flex = "1";
		const saveB = el("button", t("保存"));
		saveB.onclick = () => save(name.value, saveB);
		row.append(name, saveB);
		panel.append(row);

		// 一覧
		const listRes = await fetch("/me/files", { credentials: "same-origin" });
		if (!listRes.ok) return fail(listRes);
		const { files } = await listRes.json();
		if (!files.length) panel.append(el("p", t("保存されたファイルはまだありません")));
		for (const f of files) {
			const r = el("div", null, "ge-row");
			const openB = el("button", f.name);
			openB.title = t("開く（現在の編集は置き換わります）");
			openB.style.cssText = "flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
			openB.onclick = () => open(f.name);
			const meta = el("span", `${fmtSize(f.size)}・${fmtDate(f.updated_at)}`);
			meta.style.cssText = "opacity:.6;white-space:nowrap";
			const delB = el("button", "✕");
			delB.title = t("削除");
			delB.onclick = async () => {
				if (!confirm(t("「{0}」をクラウドから削除しますか？", f.name))) return;
				const res = await fetch(`/me/files/${encodeURIComponent(f.name)}`, { method: "DELETE", credentials: "same-origin" });
				res.ok ? render() : fail(res);
			};
			r.append(openB, meta, delB);
			panel.append(r);
		}
		panel.append(el("p", t("使用量: {0} ファイル・{1} / {2}", me.usage.files, fmtSize(me.usage.bytes), fmtSize(me.usage.maxBytes))));

		// ---- 公開台帳 ---- データ本体は預からない＝GitHub 等の公開 URL を登録して台帳に載せる（workers/works.js が正本）。
		// 台帳の行＝共有 URL（/japan/?g=…）そのもの。題名クリック＝共有 URL をコピー＝名刺・SNS へそのまま。
		panel.append(document.createElement("hr"));
		panel.append(el("h3", t("公開台帳")));
		const urlRow = el("div", null, "ge-row");
		const urlIn = el("input");
		urlIn.placeholder = t("公開URL（gh:user/repo/map.geopbf か https://…）");
		urlIn.style.flex = "1";
		urlRow.append(urlIn);
		const tiRow = el("div", null, "ge-row");
		const titleIn = el("input");
		titleIn.placeholder = t("題名");
		titleIn.style.flex = "1";
		const pubB = el("button", t("公開"));
		pubB.onclick = async () => {
			const url = urlIn.value.trim(), title = titleIn.value.trim();
			if (!url || !title) return toast(t("公開URL と題名を入れてください"));
			try {
				pubB.disabled = true;
				const res = await fetch("/me/works", {
					method: "POST", credentials: "same-origin",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title, url }),
				});
				if (!res.ok) return fail(res);
				const { id, updated } = await res.json();
				const blob = await makeThumb(hooks.map);   // 今見えている画面がサムネ＝再公開のたびに撮り直し
				if (blob) await fetch(`/me/works/${id}/thumb`, {
					method: "PUT", credentials: "same-origin", body: blob,
					headers: { "Content-Type": "image/webp" },
				}).catch(() => {});
				toast(updated ? t("台帳を更新しました") : t("台帳に公開しました"));
				render();
			} finally { pubB.disabled = false; }
		};
		tiRow.append(titleIn, pubB);
		panel.append(urlRow, tiRow);
		const shareUrl = w => `${location.origin}/japan/?g=${encodeURIComponent(w.url)}${w.view || ""}`;
		const wRes = await fetch("/me/works", { credentials: "same-origin" });
		if (wRes.ok) for (const w of (await wRes.json()).works) {
			const r = el("div", null, "ge-row");
			const copyB = el("button", w.title);
			copyB.title = t("共有URLをコピー");
			copyB.style.cssText = "flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
			copyB.onclick = async () => { await navigator.clipboard?.writeText(shareUrl(w)); toast(t("共有URLをコピーしました")); };
			const delB = el("button", "✕");
			delB.title = t("台帳から下ろす（データ本体は消えません＝あなたの置き場のまま）");
			delB.onclick = async () => {
				if (!confirm(t("「{0}」を台帳から下ろしますか？", w.title))) return;
				const res = await fetch(`/me/works/${w.id}`, { method: "DELETE", credentials: "same-origin" });
				res.ok ? render() : fail(res);
			};
			r.append(copyB, delB);
			panel.append(r);
		}
		addClose();
	}

	async function save(name, btn) {
		name = (name || "").trim();
		if (!name) return toast(t("ファイル名を入れてください"));
		if (/[/\\]/.test(name) || name.length > 100) return toast(t("ファイル名に / は使えません（100字まで）"));
		if (!/\.[A-Za-z0-9]+$/.test(name)) name += ".geopbf";
		try {
			btn.disabled = true;
			const pbf = await hooks.getPbf();
			if (!pbf) return toast(t("保存するデータがありません"));
			const file = await pbf.geopbfFile();   // 書き出しと同じエンコード（Blob＝Content-Length はブラウザが付ける）
			if (!file) return toast(t("エンコードに失敗しました"));
			const res = await fetch(`/me/files/${encodeURIComponent(name)}`, {
				method: "PUT", credentials: "same-origin", body: file,
				headers: { "Content-Type": "application/x-geopbf" },
			});
			if (!res.ok) return fail(res);
			toast(t("クラウドへ保存: {0}", name));
			render();
		} catch (e) { console.error("[geoedit] cloud save failed", e); toast(t("保存に失敗しました")); }
		finally { btn.disabled = false; }
	}

	async function open(name) {
		try {
			toast(t("読込中… {0}", name));
			const res = await fetch(`/me/files/${encodeURIComponent(name)}`, { credentials: "same-origin" });
			if (!res.ok) return fail(res);
			const buf = await res.arrayBuffer();
			panel.remove();
			await hooks.loadBuffer(buf);   // ドロップ取込と同じ経路＝新セッション扱い
		} catch (e) { console.error("[geoedit] cloud open failed", e); toast(t("読み込みに失敗しました")); }
	}

	function addClose() {
		const close = el("button", t("閉じる"));
		close.onclick = () => panel.remove();
		panel.append(document.createElement("hr"), close);
	}

	render();
	return panel;
}
