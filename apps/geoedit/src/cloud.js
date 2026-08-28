// クラウド保存パネル：account Worker（/auth*・/me*）へ GeoPBF を出し入れする。
// 全て同一オリジン（www.ortho-earth.com。dev は vite proxy で :8787 へ）＝CORS もクロスサイト Cookie も無し。
// ログインはトップレベル遷移（<a href="/auth/login/…">）＝fetch にしない（OAuth リダイレクトの掟）。
// 編集中の内容は IndexedDB 自動保存が生きているのでログイン往復では消えない。

const fmtSize = n =>
	n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" :
	n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" :
	n >= 1e3 ? (n / 1e3).toFixed(1) + " KB" : n + " B";
const fmtDate = t => new Date(t * 1000).toLocaleDateString();
const ERRMSG = {   // サーバーの error コード → 人向けの言葉（形は workers/files.js が正本）
	file_too_large: "1ファイル 200MB までです",
	quota_exceeded: "合計 1GB の上限に達しました（不要なファイルを削除してください）",
	too_many_files: "100 ファイルまでです",
	bad_request: "ファイル名が使えません",
	unauthorized: "ログインが切れました（開き直してください）",
};

// hooks = { getPbf: async()=>pbf|null（書き出しと同じ口）, loadBuffer: async(ArrayBuffer)=>void }
export function cloudPanel(container, hooks, toast) {
	container.querySelector(".ge-cloud")?.remove();   // 二重開き防止＝開き直し
	const panel = document.createElement("div");
	panel.className = "ge-panel ge-cloud";
	container.append(panel);
	const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
	const fail = async res => toast(ERRMSG[(await res.json().catch(() => ({}))).error] || `失敗しました (HTTP ${res.status})`);

	async function render() {
		panel.innerHTML = "<h3>クラウド保存</h3><p>接続中…</p>";
		let meRes;
		try { meRes = await fetch("/me", { credentials: "same-origin" }); }
		catch { panel.querySelector("p").textContent = "サーバーに接続できません"; return; }
		if (meRes.status === 401) return renderLogin();
		if (!meRes.ok || !(meRes.headers.get("Content-Type") || "").includes("json"))
			{ panel.querySelector("p").textContent = "クラウド保存は準備中です"; return; }   // Worker 未デプロイ＝assets の404等
		renderFiles(await meRes.json());
	}

	function renderLogin() {
		panel.innerHTML = "<h3>クラウド保存</h3><p>ログインすると編集データをサーバーに保存できます。</p>";
		const ret = encodeURIComponent(location.pathname + location.search);
		// X は2026年2月のAPI従量課金化（クレカ登録必須・ログイン毎に課金）で保留＝Worker側の対応は温存。
		// 復活はここに ["x", "X"] を足して account の X_CLIENT_ID/SECRET を投入するだけ。
		for (const [p, label] of [["github", "GitHub"], ["google", "Google"]]) {
			const a = el("a", `${label} でログイン`);
			a.href = `/auth/login/${p}?return=${ret}`;
			a.style.cssText = "display:block;margin:6px 0;padding:6px 10px;border-radius:7px;background:rgba(255,255,255,.08);color:#e8eef8;text-decoration:none";
			panel.append(a);
		}
		panel.append(el("p", "編集中の内容は自動保存されるので、ログイン後この画面に戻ります。"));
		addClose();
	}

	async function renderFiles(me) {
		panel.innerHTML = "";
		const head = el("div", null, "ge-head");
		head.append(el("h3", `${me.user.name || "ログイン中"}`));
		const logout = el("button", "ログアウト");
		logout.onclick = async () => { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }); render(); };
		head.append(logout);
		panel.append(head);

		// 保存（名前を付けて）
		const row = el("div", null, "ge-row");
		const name = el("input");
		name.placeholder = "ファイル名（.geopbf）";
		name.value = `edit-${new Date().toISOString().slice(0, 10)}.geopbf`;
		name.style.flex = "1";
		const saveB = el("button", "保存");
		saveB.onclick = () => save(name.value, saveB);
		row.append(name, saveB);
		panel.append(row);

		// 一覧
		const listRes = await fetch("/me/files", { credentials: "same-origin" });
		if (!listRes.ok) return fail(listRes);
		const { files } = await listRes.json();
		if (!files.length) panel.append(el("p", "保存されたファイルはまだありません"));
		for (const f of files) {
			const r = el("div", null, "ge-row");
			const openB = el("button", f.name);
			openB.title = "開く（現在の編集は置き換わります）";
			openB.style.cssText = "flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
			openB.onclick = () => open(f.name);
			const meta = el("span", `${fmtSize(f.size)}・${fmtDate(f.updated_at)}`);
			meta.style.cssText = "opacity:.6;white-space:nowrap";
			const delB = el("button", "✕");
			delB.title = "削除";
			delB.onclick = async () => {
				if (!confirm(`「${f.name}」をクラウドから削除しますか？`)) return;
				const res = await fetch(`/me/files/${encodeURIComponent(f.name)}`, { method: "DELETE", credentials: "same-origin" });
				res.ok ? render() : fail(res);
			};
			r.append(openB, meta, delB);
			panel.append(r);
		}
		panel.append(el("p", `使用量: ${me.usage.files} ファイル・${fmtSize(me.usage.bytes)} / ${fmtSize(me.usage.maxBytes)}`));
		addClose();
	}

	async function save(name, btn) {
		name = (name || "").trim();
		if (!name) return toast("ファイル名を入れてください");
		if (/[/\\]/.test(name) || name.length > 100) return toast("ファイル名に / は使えません（100字まで）");
		if (!/\.[A-Za-z0-9]+$/.test(name)) name += ".geopbf";
		try {
			btn.disabled = true;
			const pbf = await hooks.getPbf();
			if (!pbf) return toast("保存するデータがありません");
			const file = await pbf.geopbfFile();   // 書き出しと同じエンコード（Blob＝Content-Length はブラウザが付ける）
			if (!file) return toast("エンコードに失敗しました");
			const res = await fetch(`/me/files/${encodeURIComponent(name)}`, {
				method: "PUT", credentials: "same-origin", body: file,
				headers: { "Content-Type": "application/x-geopbf" },
			});
			if (!res.ok) return fail(res);
			toast(`クラウドへ保存: ${name}`);
			render();
		} catch (e) { console.error("[geoedit] cloud save failed", e); toast("保存に失敗しました"); }
		finally { btn.disabled = false; }
	}

	async function open(name) {
		try {
			toast(`読込中… ${name}`);
			const res = await fetch(`/me/files/${encodeURIComponent(name)}`, { credentials: "same-origin" });
			if (!res.ok) return fail(res);
			const buf = await res.arrayBuffer();
			panel.remove();
			await hooks.loadBuffer(buf);   // ドロップ取込と同じ経路＝新セッション扱い
		} catch (e) { console.error("[geoedit] cloud open failed", e); toast("読み込みに失敗しました"); }
	}

	function addClose() {
		const close = el("button", "閉じる");
		close.onclick = () => panel.remove();
		panel.append(document.createElement("hr"), close);
	}

	render();
	return panel;
}
