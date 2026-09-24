// 全球アトラス（WORLD_ATLAS）の焼き＝R90 8 枚（bucket GIS/alt・GEBCO 焼き済み）→ 1024/90° の 1 枚（4096×2048・Int16）→ bucket GIS/alt。
// 消費側（equal の全球ハイプソ・ortho-japan の R90 固定窓）はこれ 1 本を loadTile.byName(WORLD_ATLAS) で読む＝
// 8 枚 52MB の取得＋復号 8 回＋再標本化 8 回が、3.25MB 1 本＋復号 1 回に（実測 2026-09-18）。無ければ従来の 8 枚経路へ自動退避（絵は同じ）。
// 再標本化の規約は packages/altpbf/src/worldatlas.js（downsampleFlipped と同一・Node 検定 t-worldatlas.mjs）。
// 焼き直す時（GEBCO の年替わり等）：R90 を先に「create GEBCO」で更新 → WORLD_ATLAS の版（末尾 _n）を上げてからこのボタン。
import { createTileLoader, WORLD_ATLAS, WORLD_ATLAS_CELL, bakeWorldAtlas, encode, decode, sampleWorldAtlas } from "@ortho-earth/core/elevation";

const CELLS = [[-180, -90], [-90, -90], [0, -90], [90, -90], [-180, 0], [-90, 0], [0, 0], [90, 0]];   // [west, south]
// 焼き上がりの検札点（読み戻し→復号→標本値が常識の範囲か）：エベレスト近傍・死海（-420..0 は保持）・太平洋（深海は規約で 0）・東京
// 実測 2026-09-18（GEBCO 2026 の R90 から）：Everest 6660 / Dead Sea -417 / Pacific 0 / Tokyo 32・ファイル 3.25MB（生 16.8MB）
const PROBES = [["Everest", 86.925, 27.988, [5500, 9000]], ["Dead Sea", 35.5, 31.5, [-420, 0]], ["Pacific", -150, -20, [0, 0]], ["Tokyo", 139.7, 35.7, [-50, 200]]];

export async function worldAtlas(q, { apiUrl, Bucket }) {
	q.clear();
	q.title(`world hypso atlas (R90×8 → ${WORLD_ATLAS})`);
	const t0 = performance.now();
	const loadTile = await createTileLoader({ apiUrl });
	const tiles = [];
	for (const [west, south] of CELLS) {
		const dt = performance.now();
		const t = await loadTile(west, south, 90);
		if (!t?.data) { q.error(`[R90] ${west},${south}: 取得できない（create GEBCO(R90/R10) が先）`); return; }
		tiles.push(t);
		q.log(`[R90] ${t.name} ${t.width}×${t.height} (${t.source || "?"}) ${((performance.now() - dt) / 1000).toFixed(1)}s`);
		await new Promise(r => setTimeout(r));   // ログを画面に流す
	}
	q.log(`[bake] ${WORLD_ATLAS_CELL}/90° → ${4 * WORLD_ATLAS_CELL}×${2 * WORLD_ATLAS_CELL} …`);
	const atlas = bakeWorldAtlas(tiles, WORLD_ATLAS_CELL);
	const buf = await encode(atlas);
	const file = new File([buf], WORLD_ATLAS, { type: "application/x-altpbf" });
	q.log(`[encode] ${file.size.toLocaleString()} bytes (raw Int16 ${atlas.data.byteLength.toLocaleString()})`);
	const bucket = await Bucket("GIS/alt");
	await bucket.put(file);   // ← VITE_API_KEY 未設定だと 403（他ボタンと同じ）
	q.log(`[put] GIS/alt/${WORLD_ATLAS}`);
	// 検札：bucket から読み戻して復号＝寸法・原点・標本値の突合（焼き損じを本番に残さない）
	const blob = await bucket.get(WORLD_ATLAS);
	if (!blob) { q.error("[verify] 読み戻せない"); return; }
	const back = await decode(blob);
	const dimsOk = back.width === atlas.width && back.height === atlas.height && back.lng === -180 && back.lat === -90 && back.range === 360;
	if (!dimsOk) { q.error(`[verify] 寸法/原点が違う: ${back.width}×${back.height} @${back.lng},${back.lat} r${back.range}`); return; }
	let same = 0; for (let i = 0; i < atlas.data.length; i += 997) if (back.data[i] === atlas.data[i]) same++;
	q.log(`[verify] ${back.width}×${back.height} · source="${back.source}" · 間引き突合 ${same}/${Math.ceil(atlas.data.length / 997)}`);
	let bad = 0;
	for (const [label, lon, lat, [lo, hi]] of PROBES) {
		const raw = (() => { const W = back.width, H = back.height, x = Math.min(W - 1, Math.floor((lon + 180) / 360 * W)), y = Math.min(H - 1, Math.floor((90 - lat) / 180 * H)); return back.data[y * W + x]; })();
		const ok = raw >= lo && raw <= hi;
		if (!ok) bad++;
		const msg = `[probe] ${label}: raw ${raw}m (期待 ${lo}..${hi}) / 消費側 sample ${sampleWorldAtlas(back, lon, lat).toFixed(0)}m`;
		ok ? q.log(msg) : q.error(msg);
	}
	if (bad) { q.error(`[verify] 検札点 ${bad} 件が範囲外＝R90 の中身か再標本化を疑う`); return; }
	q.success(`${WORLD_ATLAS} 焼き上がり ${((performance.now() - t0) / 1000).toFixed(1)}s ＝ 消費側は次回訪問から 1 本読み（IDB の旧 R90 は残るが使われない）`);
}
