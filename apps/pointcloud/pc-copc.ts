// 静岡県の点群の COPC 版（2026-11-09・本人「生成したファイルは Hugging Face に置く」）＝県の .zip（deflate＝途中だけ読めない）を前もって COPC に変えた物の台帳（純関数・node の検定 tests/t-pc-copc.mjs）。
// 置き場＝Hugging Face の dataset KenjiYoshida/shizuoka-pointcloud（resolve の URL は CDN へ 302・Range と CORS が通る＝2026-11-09 にブラウザで 206 を確かめた）。
//   並び＝"<年>/<計測>/<種類>/<図郭>.copc.laz"（S3 の組の名と同じ・図郭は "08ND7794" の大文字）。台帳＝同じ所の index.json（{ version: 1, sets: { "2021/LP/Original": { "08ND7794": bytes, … } } }）。
// 頁は台帳にある図郭だけ COPC を読む（浅い節から点の上限まで＝ZIP を丸ごと取らない）・無い図郭は従来どおり県の .zip。

export const HF_BASE = "https://huggingface.co/datasets/KenjiYoshida/shizuoka-pointcloud/resolve/main/";
export interface CopcIndex { version: number; sets: Record<string, Record<string, number>> }
export interface CopcSheet { path: string; url: string; size: number }

/** 台帳の形を確かめて返す（壊れていれば空） */
export function parseCopcIndex(x: unknown): CopcIndex {
	const o = x as Partial<CopcIndex> | null;
	if (!o || o.version !== 1 || !o.sets || typeof o.sets !== "object") return { version: 1, sets: {} };
	const sets: CopcIndex["sets"] = {};
	for (const [id, m] of Object.entries(o.sets)) {
		if (!/^\d{4}\/\w+\/\w+$/.test(id) || !m || typeof m !== "object") continue;
		const s: Record<string, number> = {};
		for (const [code, n] of Object.entries(m)) if (/^08[A-T][A-H]\d{4}$/.test(code) && Number.isFinite(n) && (n as number) > 0) s[code] = n as number;
		sets[id] = s;
	}
	return { version: 1, sets };
}

/** S3 の鍵（"2021/LP/Original/08/ND/77/08ND7794.zip"・小文字の名も）→ 台帳にあれば COPC の置き場。無ければ null */
export function copcOf(ix: CopcIndex, s3key: string, base = HF_BASE): CopcSheet | null {
	const p = s3key.split("/"); if (p.length < 4) return null;
	const set = p.slice(0, 3).join("/"), code = p[p.length - 1].replace(/\.zip$/i, "").toUpperCase();
	const size = ix.sets[set]?.[code]; if (!size) return null;
	const path = `${set}/${code}.copc.laz`;
	return { path, url: base + path, size };
}

/** 台帳を取る（取れなければ空＝全部 .zip のまま・頁は止めない） */
export async function loadCopcIndex(base = HF_BASE, signal?: AbortSignal): Promise<CopcIndex> {
	try { const r = await fetch(base + "index.json", { signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return parseCopcIndex(await r.json()); }
	catch (e) { console.warn("[pointcloud] COPC index unavailable", e); return { version: 1, sets: {} }; }
}
