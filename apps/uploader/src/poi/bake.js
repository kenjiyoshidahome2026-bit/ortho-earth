// ── POI台帳 civic（KSJ → z14 geopbfタイル）── docs/poi-ledger.md §11 / schema は ./schema.js
// KSJ をブラウザで直読み（§9 の「Node で動かない」問題がここには無い）→ 種別/rank を付与 → z14 タイルへ
// 分配 → タイルごとに geopbf 化して GIS/pbf/poi/14/x/y へ save。読み側は geopbf("poi/14/x/y") で対称に戻る。
// v1 は P29学校（京都26）から。withAnno=true で experimental注記の位置採用・鮮度判定を足す（§8・遅い＝z16を数千枚）。
import { geopbf } from "geopbf";
import * as POI from "./schema.js";

export async function poi(q, { Bucket }, { prefs = ["26"], sets = ["P29"], anno = [], withAnno = false } = {}) {
	q.clear();
	q.title(`POI civic (KSJ→z14${anno.length ? "＋注記由来" : ""}${withAnno ? "・突合" : ""})`);
	const LICENSE = "政府標準利用規約準拠・出典明示で利用可";
	const ATTR = "国土交通省 国土数値情報" + (withAnno || anno.length ? "／国土地理院 experimental_bvmap" : "");
	const recs = [];
	for (const setKey of sets) {
		const set = POI.KSJ_SETS[setKey];
		const base = `${setKey}-${set.year}`;
		for (const pref of prefs) {
			// 1) KSJ点をブラウザ直読み：geojson同梱=#inner.geojson／dbfのみ=#inner.shp（geopbf が zip 内を解決）
			const stem = set.national ? base : `${base}_${pref}`;
			const zip = set.national
				? `https://nlftp.mlit.go.jp/ksj/gml/data/${setKey}/${base}/${base}.zip`
				: `https://nlftp.mlit.go.jp/ksj/gml/data/${setKey}/${base}/${stem}_GML.zip`;
			const srcRef = `${zip}#${stem}.${set.geojson ? "geojson" : "shp"}`;
			q.log(`読込 ${setKey} ${pref} … ${srcRef.split("/").pop()}`);
			const src = await geopbf(srcRef, { name: `ksj_${setKey}_${pref}`, nocache: true, gint: false });
			let pts = src.geojson.features.map(f => ({
				ll: f.geometry?.coordinates?.slice(0, 2),
				name: (f.properties[set.nameKey] || "").trim(),
				cls: String(f.properties[set.classKey] ?? ""),
				pref: set.prefKey ? String(f.properties[set.prefKey] ?? "") : pref,
			})).filter(p => p.name && p.ll && isFinite(p.ll[0]) && isFinite(p.ll[1]));
			if (set.national) pts = pts.filter(p => p.pref.startsWith(pref));   // 全国ファイルは pref で絞る
			q.log(`  ${set.label} ${pref}: ${pts.length}点`);

			// 2) 注記突合（任意）：点が要求する z16 label タイルを取得し正規化名で索引化（§8.1/§8.3）
			const annoIndex = withAnno ? await buildAnnoIndex(pts, set, q) : null;

			// 3) 種別・位置・rank を確定（§11.4/11.5/11.7）
			for (const p of pts) {
				const type = POI.ksjType(set, p);
				let ll = p.ll, posSrc = POI.SRC.KSJ, kana = "";
				if (annoIndex) { const r = POI.resolvePoint(p, set, annoIndex); ll = r.ll; posSrc = r.posSrc; kana = r.kana; }
				const rank = POI.rankOf(type, { demote: set.demoteOf ? set.demoteOf(p.name) : 0 });
				if (rank <= 0) continue;   // 不明は描かない（§6）
				recs.push({ ll, name: p.name, type, rank, src: POI.packSrc(posSrc, POI.SRC.KSJ), kana });
			}
		}
	}

	// KSJ に無い系統（寺社など）＝experimental注記を bbox 掃引して annoCtg から直に採る（注記=正しい位置）。
	// posSrc=ANNO で焼く＝表示側が「基図注記を上書き」する（§1 の三十三間堂 274mズレを直す本手）。
	for (const a of anno) recs.push(...await sweepAnno(a, q));

	// 3.5) §12 手差分（サーバー正本 poi/overrides.json）を最終合成＝del/move/rename をタイルへ焼き込む。
	// add は焼かない（withAdds:false＝schema.applyOverrides の柵コメント参照・実行時フィードが常時適用）。
	// レコードは合成後も消さない＝履歴。意味論は冪等＝毎回の焼きで再適用してよい。
	const bkt = await Bucket("GIS/pbf");
	const ovr = bkt && await bkt.get(POI.OVR_NAME, "json");   // bucket不達＝手差分なしで続行（saveで別途落ちる）
	const appliedOvr = [];   // この焼きで効いたrec id → マニフェスト baked へ（表示が再適用しない＝再発火封じ）
	const baked = POI.applyOverrides(recs, ovr?.recs, { withAdds: false, applied: appliedOvr });
	if (ovr?.recs?.length) q.log(`手差分 ${ovr.recs.length}件 合成（${recs.length}→${baked.length}点・焼き込み${appliedOvr.length}件・add は実行時フィードのみ）`);

	// 4) z14 タイルへ分配 → タイルごとに geopbf 化 → poi/14/x/y で save（§11.8）
	const tiles = new Map();
	for (const r of baked) { const [x, y] = POI.tileXY(r.ll[0], r.ll[1]); const k = `${x}/${y}`; (tiles.get(k) || tiles.set(k, []).get(k)).push(r); }
	q.log(`合計 ${baked.length} POI → ${tiles.size} タイルを焼く…`);
	let n = 0, bytes = 0;
	for (const [k, rs] of tiles) {
		const fc = { type: "FeatureCollection", features: rs.map(r => ({
			type: "Feature",
			geometry: { type: "Point", coordinates: r.ll },
			properties: { n: r.name, t: r.type, r: r.rank, s: r.src, ...(r.kana ? { k: r.kana } : {}) },
		})) };
		const pbf = await geopbf(fc, { name: `poi/14/${k}`, nocache: true, gint: false, minZoom: 14 });
		if (!pbf.length) continue;
		pbf.updateHeader({ description: `POI civic z14 ${k}（t=種別 r=rank s=出典）`, license: LICENSE, attribution: ATTR });
		await pbf.save();
		n++; bytes += pbf.size;
		if (n % 50 === 0) q.log(`  ${n}/${tiles.size} タイル…`);
	}
	// タイル在庫マニフェスト（形と合流の正典＝schema.mergeManifest）：表示側が存在タイルだけ取りに行く＝404空振りゼロ＋
	// 版でキャッシュ制御・baked＝焼き込み済み手差分id（表示はここに無いrecだけ実行時適用＝再発火封じ）。
	let prev = null;
	try { prev = await bkt.get(POI.MANIFEST_NAME, "json"); } catch { }
	const idx = POI.mergeManifest(prev, tiles.keys(), appliedOvr);
	await bkt.put(new File([JSON.stringify(idx)], POI.MANIFEST_NAME, { type: "application/json" }));
	q.log(`マニフェスト ${POI.MANIFEST_NAME} → ${idx.tiles.length}タイル（今回${tiles.size}・既存${prev?.tiles?.length || 0}・焼き込み済み手差分${idx.baked.length}件）`);
	q.success(`POI civic: ${n} タイル・${baked.length}点・${(bytes / 1024).toFixed(0)}KB → GIS/pbf/poi/14/`);
}

// experimental注記(z16 label層)を、点が要る分のタイルだけ取得し、正規化名 → [{ll,knj,kana}] の索引に。
// withAnno のときだけ ortho-core(fetchMVT) を動的 import＝KSJ単体の焼きは ortho-core に依存しない。
async function buildAnnoIndex(pts, set, q) {
	const { fetchMVT } = await import("ortho-core/decode");   // decode.js だけ（pbf のみ依存）＝GLバレルを引かない
	const Z = 16, need = new Set();
	for (const p of pts) { const [x, y] = POI.tileXY(p.ll[0], p.ll[1], Z); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) need.add(`${x + dx}/${y + dy}`); }
	const keys = [...need];
	q.log(`  注記 z16 タイル ${keys.length} 枚を取得…（遅い）`);
	const index = new Map();
	let i = 0;
	await Promise.all(Array.from({ length: 12 }, async () => {
		while (i < keys.length) {
			const [x, y] = keys[i++].split("/").map(Number);
			try {
				const layers = await fetchMVT(`https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${Z}/${x}/${y}.pbf`, undefined, new Set(["label"]));
				const L = layers?.label; if (!L) continue;
				for (const f of L.features) {
					if (f.props.annoCtg !== set.annoCode) continue;
					const knj = (f.props.knj || "").trim(); if (!knj) continue;
					const key = set.norm(knj); if (!key) continue;
					const ll = POI.tileLocalLL(x, y, f.geom.coords[0], f.geom.coords[1], L.extent);
					(index.get(key) || index.set(key, []).get(key)).push({ ll, knj, kana: f.props.kana || "" });
				}
			} catch { /* 落ちたタイルは無視＝その点は KSJ 位置へ倒れる（§8.3 の d0 側） */ }
		}
	}));
	q.log(`  注記索引 ${index.size} 名`);
	return index;
}

// 注記由来POIの採取：a.bbox の z16 label タイルを掃引し annoCtg==a.code の注記を「POIそのもの」として採る。
// KSJに無い寺社等・位置は注記＝建物の上（§1 の三十三間堂 3m の正しい方）。posSrc/typeSrc とも ANNO で焼く。
async function sweepAnno(a, q) {
	const { fetchMVT } = await import("ortho-core/decode");
	const Z = 16, [w, s, e, n] = a.bbox;
	const [x0, y0] = POI.tileXY(w, n, Z), [x1, y1] = POI.tileXY(e, s, Z);
	const keys = [];
	for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) keys.push([x, y]);
	const type = a.type ?? POI.ANNO_TO_TYPE[a.code] ?? POI.TYPE.その他;
	q.log(`注記掃引 annoCtg=${a.code}（${a.label || ""}）… z16 ${keys.length}枚`);
	const out = [], seen = new Set();
	let i = 0;
	await Promise.all(Array.from({ length: 12 }, async () => {
		while (i < keys.length) {
			const [x, y] = keys[i++];
			try {
				const layers = await fetchMVT(`https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${Z}/${x}/${y}.pbf`, undefined, new Set(["label"]));
				const L = layers?.label; if (!L) continue;
				for (const f of L.features) {
					if (f.props.annoCtg !== a.code) continue;
					const name = (f.props.knj || "").trim(); if (!name) continue;
					const ll = POI.tileLocalLL(x, y, f.geom.coords[0], f.geom.coords[1], L.extent);
					const key = name + "@" + ll[0].toFixed(4) + "," + ll[1].toFixed(4);
					if (seen.has(key)) continue; seen.add(key);   // 隣タイル境界の同一注記（両側収録）を排除
					out.push({ ll, name, type, rank: POI.rankOf(type), src: POI.packSrc(POI.SRC.ANNO, POI.SRC.ANNO), kana: f.props.kana || "" });
				}
			} catch { /* 落ちたタイルは無視 */ }
		}
	}));
	q.log(`  → ${out.length} 件（${a.label || a.code}）`);
	return out;
}
