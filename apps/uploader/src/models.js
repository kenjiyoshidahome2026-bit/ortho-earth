// 名所 3D 模型（GLB）の一括アップロード → bucket GIS/models/<id>.glb（ortho-japan の /japan/models.html が読む）。
// 台帳＝apps/ortho-japan/public/models.json（monorepo 直読み＝正本は japan 側）。GLB（npm run landmarks が作る）を選ぶ→
// ファイル名から台帳の id を推定（手で直せる）→「全部アップロード」＝順に put（50 MB 以上は native-bucket が multipart）。
// 置き物は native-bucket の put が gzip で置く（.glb は圧縮対象）＝読む側（models.js）は自分で gunzip する。
// 台帳に無い模型は「ファイル名のまま」で置ける（後で台帳へ行を足す）。
import * as d3 from "d3";
import { comma } from "common";
import catalog from "../../ortho-japan/public/models.json";

const DIRE = "GIS/models";
const norm = s => String(s).toLowerCase().normalize("NFKC").replace(/\.(glb|gltf|zip)$/i, "").replace(/[^a-z0-9぀-ヿ一-鿿]+/g, " ").trim();
const tokens = s => norm(s).split(" ").filter(t => t.length >= 2);
// ファイル名 → 台帳 id の推定（id・英名・和名の語をいくつ含むか＝多い順）。同点は無し（null＝ファイル名のまま）
function guess(fileName, models) {
	const ft = new Set(tokens(fileName));
	let best = null, bestN = 0;
	for (const m of models) {
		const mt = new Set([...tokens(m.id), ...tokens(m.name?.en || ""), ...tokens(m.name?.ja || "")]);
		let n = 0; for (const t of mt) if (ft.has(t)) n++;
		if (n > bestN) { bestN = n; best = m.id; }
	}
	return best;
}
const safeName = s => s.replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

export function modelsUI({ CMD, q, Bucket }) {
	CMD.append("h2").text("3D 模型");
	CMD.append("button").text("3D 模型 GLB → GIS/models（名所 showcase）").on("click", () => open().catch(e => { console.error(e); q.error(String(e?.message || e)); }));

	async function open() {
		q.clear(); q.title(`3D 模型 GLB → ${DIRE}/{id}.glb`);
		const bucket = await Bucket(DIRE);
		if (!bucket) throw new Error(`Bucket(${DIRE}) に到達できない`);
		const models = catalog.models || [];
		const root = q.target.append("div").style("padding", "0 1em 1em").style("font", "13px/1.6 system-ui, sans-serif");
		root.append("p").html(`台帳＝apps/ortho-japan/public/models.json（${models.length} 件）。GLB を選ぶ → id を確かめる → 全部アップロード。<br>
			読む側の URL＝<code>${catalog.base}&lt;id&gt;.glb</code>（50 MB 以上は multipart・置き物は gzip）`);

		// 台帳と bucket の突き合わせ（在庫）
		const stock = root.append("table").style("border-collapse", "collapse").style("margin", "0.5em 0 1em");
		const refreshStock = async () => {
			const have = new Map((await bucket.list()).map(f => [f.Key, f]));
			stock.html("");
			const hd = stock.append("tr"); for (const h of ["id", "名前", "台帳 MB", "bucket"]) hd.append("th").text(h).style("text-align", "left").style("padding", "2px 10px 2px 0").style("border-bottom", "1px solid #555");
			for (const m of models) {
				const f = have.get(m.id + ".glb"), tr = stock.append("tr");
				tr.append("td").text(m.id).style("padding", "1px 10px 1px 0").style("font-family", "ui-monospace, monospace");
				tr.append("td").text(m.name?.ja || m.name?.en || "").style("padding", "1px 10px 1px 0");
				tr.append("td").text(m.mb ?? "").style("padding", "1px 10px 1px 0");
				tr.append("td").text(f ? `✓ ${comma(f.Size)} bytes` : "—").style("padding", "1px 10px 1px 0").style("color", f ? "#8f8" : "#888");
				have.delete(m.id + ".glb");
			}
			for (const [k, f] of have) {   // 台帳に無い置き物（ファイル名のままのもの・古い物）
				const tr = stock.append("tr").style("color", "#cc9");
				tr.append("td").text("(台帳外)").style("padding", "1px 10px 1px 0"); tr.append("td").text(k); tr.append("td").text(""); tr.append("td").text(`${comma(f.Size)} bytes`);
			}
		};
		await refreshStock();

		// ファイル選択 → 行ごとに置き先（台帳 id か「ファイル名のまま」）
		const pick = root.append("div").style("margin", "0.5em 0");
		pick.append("input").attr("type", "file").attr("multiple", true).attr("accept", ".glb,model/gltf-binary").on("change", function () { setFiles([...this.files]); });
		const rows = root.append("table").style("border-collapse", "collapse").style("margin", "0.5em 0");
		const act = root.append("div");
		const btn = act.append("button").text("全部アップロード").style("font-size", "16px").style("padding", "0.4em 1.2em").attr("disabled", true);
		let queue = [];   // { file, sel (d3 select), prog (d3 td) }
		function setFiles(files) {
			queue = []; rows.html("");
			const hd = rows.append("tr"); for (const h of ["ファイル", "サイズ", "置き先（id）", "状態"]) hd.append("th").text(h).style("text-align", "left").style("padding", "2px 10px 2px 0").style("border-bottom", "1px solid #555");
			for (const file of files) {
				const tr = rows.append("tr");
				tr.append("td").text(file.name).style("padding", "2px 10px 2px 0");
				tr.append("td").text(`${(file.size / 1048576).toFixed(1)} MB`).style("padding", "2px 10px 2px 0");
				const sel = tr.append("td").style("padding", "2px 10px 2px 0").append("select").style("font-size", "13px");
				sel.append("option").attr("value", "").text(`（ファイル名のまま: ${safeName(file.name)}）`);
				for (const m of models) sel.append("option").attr("value", m.id).text(`${m.id} — ${m.name?.ja || m.name?.en || ""}`);
				const g = guess(file.name, models); if (g) sel.property("value", g);
				const prog = tr.append("td").text("").style("padding", "2px 10px 2px 0").style("color", "#8f8");
				queue.push({ file, sel, prog });
			}
			btn.attr("disabled", files.length ? null : true);
		}
		btn.on("click", async () => {
			btn.attr("disabled", true);
			const onProg = e => { const it = queue.find(x => x.cur && e.detail?.name === x.cur); if (it) it.prog.text(`${Math.round(100 * e.detail.saved / e.detail.total)}%`); };
			window.addEventListener("SaveProgress", onProg);
			try {
				for (const it of queue) {
					const id = it.sel.property("value"), name = id ? `${id}.glb` : safeName(it.file.name);
					it.cur = name; it.prog.text("送信中…");
					const t0 = performance.now();
					try {
						await bucket.put(new File([it.file], name, { type: "model/gltf-binary" }));
						it.prog.text(`✓ ${((performance.now() - t0) / 1000).toFixed(1)} s`);
						q.success(`${name}: ${comma(it.file.size)} bytes → ${catalog.base}${name}`);
					} catch (e) { it.prog.text("✖ " + (e?.message || e)).style("color", "#f88"); q.error(`${name}: ${e?.message || e}`); }
				}
			} finally { window.removeEventListener("SaveProgress", onProg); btn.attr("disabled", null); }
			await refreshStock();
		});
	}
}
