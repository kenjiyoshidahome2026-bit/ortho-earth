// ガジェット：GISファイルのドラッグ＆ドロップ取り込み（dropFile）。標準装備でなくオプトイン＝
// orthoJapan() の戻り値から map.gadget.dropFile() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// #map にGISファイルを落とすと geopbf がFileを拡張子で振り分けデコード→GeoPBF化→gint（GeoPBF-native
// GPUレンダラ）の単一スロットへ載せる。対応＝GeoJSON/TopoJSON/Shapefile(zip)/FlatGeobuf/KML(kmz)/GPX/GML/
// GeoPBF＋自動gunzip（geopbf が食える全形式＝拡張子判定は geopbf 側）。
// 描画・ホバー/クリック識別・データへのカメラ寄せは applyGintData が担い、それを束ねた手綱 loadFile(file)＝
// geopbf(file,{gint:true})→applyGintData を登録側が注入する（グローバルに手を伸ばさない掟）。
// gint 単一スロットは海岸線/14条筆と共有＝毎回置き換え（複数ドロップは素直に「最後の1枚が勝つ」）。
// 進捗は geopbf の window発火 ConvertProgress（detail: {name, loaded, total}）を拾って歩を出す。
// signal＝destroy 時のリスナ解除。DOMは自給＝#map直下の後置（z-index全廃＝DOM順の裁き）。

import { tr } from "../i18n.js";
const t = tr({
	"GISファイル / シーンをここにドロップ\nGeoJSON / Shapefile(zip) / KML / GPX / FlatGeobuf / .scenes": "Drop GIS files / scenes here\nGeoJSON / Shapefile(zip) / KML / GPX / FlatGeobuf / .scenes",
	"✕ 図形を消去": "✕ Clear shapes",
	"図形を消去しました": "Shapes cleared",
	"🎬 上映中はドロップ無効": "🎬 Drop disabled during playback",
	"🎬 シーン再生: {0}": "🎬 Playing scene: {0}",
	"読込中: {0} …": "Loading: {0} …",
	"読込失敗: {0}": "Failed to load: {0}",
	"表示: {0}（{1} 地物）— ホバー/クリックで識別": "Showing: {0} ({1} features) — hover/click to identify",
	"エラー: {0}\n{1}": "Error: {0}\n{1}",
	"変換中 {0}%…": "Converting {0}%…",
});

// 落としたファイルが共有シーン台本(type:"scenes")か嗅ぎ分ける（demo/scene-format.md §0）。
//   .scenes / .scenes.gz（正典・単一サフィックス＋gzip）は確定／.json・.geojson は先頭64KBに discriminator があるか覗いてから全 parse（巨大 geojson を無駄に読まない）。
//   権威は中身の type:"scenes"（geopbf の掟＝IF は type で見分ける に揃える。geojson=FeatureCollection）。
//   gzip は拡張子でなく中身の印（1f 8b）で判定＝.scenes のまま gzip でも通る（解凍はブラウザ標準 DecompressionStream・依存ゼロ）。
export const gunzipText = async bytes => await new Response(new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"))).text();
export async function sniffScene(file) {
	const name = (file.name || "").toLowerCase();
	const isSceneExt = name.endsWith(".scenes") || name.endsWith(".scenes.gz");
	if (!isSceneExt && !/\.(json|geojson)$/.test(name)) return null;
	try {
		let text;
		if (isSceneExt) {
			const buf = new Uint8Array(await file.arrayBuffer());
			text = (buf[0] === 0x1f && buf[1] === 0x8b) ? await gunzipText(buf) : new TextDecoder().decode(buf);
		} else {   // 素の .json/.geojson＝まず覗く（無ければ geopbf に譲る）
			const head = await file.slice(0, 65536).text();
			if (!/["']type["']\s*:\s*["']scenes["']/.test(head)) return null;
			text = await file.text();
		}
		const obj = JSON.parse(text);
		return obj && obj.type === "scenes" ? obj : null;
	} catch (e) { console.warn("[dropFile] scene parse failed", file.name, e); return null; }
}

// busy＝上映中判定（app が注入・任意）：デモ/シーン再生の上映中はドロップを無視する（上映と積み込み・flyTo が喧嘩しない）。
export function dropFile({ yieldTo, loadFile, clearGint, playScene, busy, signal } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#dropzone")) return () => {};   // 二重搭載は無害

	// ドロップゾーン（ドラッグ中だけ現れる全面カバー）。pointerEvents:none＝ドラッグ判定は mapEl で拾い、
	// ゾーン自身はイベントを食わない（dragleave のちらつき源にしない）。
	const zone = document.createElement("div");
	zone.id = "dropzone";
	Object.assign(zone.style, {
		position: "absolute", inset: "0", display: "none",
		alignItems: "center", justifyContent: "center",
		background: "rgba(20,28,40,.32)", pointerEvents: "none",
	});
	const card = document.createElement("div");
	Object.assign(card.style, {
		padding: "22px 30px", borderRadius: "12px",
		border: "2.5px dashed rgba(255,255,255,.85)", background: "rgba(30,40,56,.5)",
		textAlign: "center", whiteSpace: "pre-line",
		font: "600 15px/1.6 system-ui, sans-serif", color: "#fff",
	});
	card.textContent = t("GISファイル / シーンをここにドロップ\nGeoJSON / Shapefile(zip) / KML / GPX / FlatGeobuf / .scenes");
	zone.append(card);
	mapEl.append(zone);

	// 進捗/結果トースト（左下・数秒で自動退場）。sticky＝処理中は残す。
	const toast = document.createElement("div");
	toast.id = "drop-toast";
	Object.assign(toast.style, {
		position: "absolute", left: "12px", bottom: "12px", display: "none",
		maxWidth: "60%", padding: "8px 12px", borderRadius: "8px",
		background: "rgba(20,28,40,.82)", color: "#fff", whiteSpace: "pre-line",
		font: "500 12px/1.45 system-ui, sans-serif", pointerEvents: "none",
	});
	mapEl.append(toast);
	let toastT = 0;
	const say = (t, sticky) => {
		toast.textContent = t; toast.style.display = t ? "block" : "none";
		clearTimeout(toastT);
		if (t && !sticky) toastT = setTimeout(() => { toast.style.display = "none"; }, 3500);
	};

	// クリアボタン（右上・図形が載っている間だけ表示）。押すと gint スロットを空にしドロップ図形を消す。
	const clearBtn = document.createElement("button");
	clearBtn.id = "dropclear-btn"; clearBtn.type = "button";
	clearBtn.textContent = t("✕ 図形を消去");
	Object.assign(clearBtn.style, {
		position: "absolute", top: "12px", right: "150px", display: "none",   // 右上の #chips 帯（right:10px・縦積み）の左へ寄せる
		padding: "7px 12px", borderRadius: "8px", border: "none", cursor: "pointer",
		background: "rgba(20,28,40,.82)", color: "#fff",
		font: "600 12px/1 system-ui, sans-serif", boxShadow: "0 1px 4px rgba(0,0,0,.25)",
	});
	mapEl.append(clearBtn);
	const showClear = on => { clearBtn.style.display = on ? "block" : "none"; };
	clearBtn.addEventListener("click", () => { clearGint?.(); showClear(false); say(t("図形を消去しました")); }, { signal });

	// Files を含むドラッグだけ受ける（テキスト等の巻き込みを弾く）。
	const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes("Files");
	// 子要素の出入りで dragenter/leave が乱発する＝深さカウンタでゾーンのちらつきを消す。
	let depth = 0;
	const arm = on => { zone.style.display = on ? "flex" : "none"; };

	mapEl.addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); if (++depth === 1) arm(true); }, { signal });
	mapEl.addEventListener("dragover", e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }, { signal });
	mapEl.addEventListener("dragleave", e => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; arm(false); } }, { signal });
	mapEl.addEventListener("drop", async e => {
		if (!hasFiles(e)) return;
		e.preventDefault(); depth = 0; arm(false);
		const files = Array.from(e.dataTransfer.files || []);
		if (!files.length) return;
		if (yieldTo?.()) return;   // 編集ガジェットが載っている＝ドロップはエディタの取込へ（ビューアは黙って譲る）
		if (busy?.()) { say(t("🎬 上映中はドロップ無効")); return; }   // デモ中はドロップ禁止（無視）＝台本もGISファイルも受けない
		for (const file of files) {   // 単一スロット置き換え＝順に読み最後の1枚が残る
			const scene = playScene ? await sniffScene(file) : null;   // シーン台本(.scenes / type:"scenes")＝プレーヤーへ回す（geopbf に渡さない）
			if (scene) { say(t("🎬 シーン再生: {0}", scene.title || file.name)); playScene(scene); continue; }
			say(t("読込中: {0} …", file.name), true);
			try {
				const pbf = await loadFile(file);
				if (!pbf) { say(t("読込失敗: {0}", file.name)); continue; }
				showClear(true);   // 図形が載った＝消去ボタンを出す（新しいドロップは前図形を置き換え＝ボタンは出たまま）
				say(t("表示: {0}（{1} 地物）— ホバー/クリックで識別", file.name, pbf.length ?? "?"));
			} catch (err) {
				console.error("[dropFile]", file.name, err);
				say(t("エラー: {0}\n{1}", file.name, err?.message || err));
			}
		}
	}, { signal });

	// 変換進捗（大きな Shapefile 等で効く）。バイト比＝loaded/total。
	window.addEventListener("ConvertProgress", e => {
		const d = e.detail || {};
		if (d.total) say(t("変換中 {0}%…", Math.round((d.loaded / d.total) * 100)), true);
	}, { signal });

	return { say, clear: () => { clearGint?.(); showClear(false); }, destroy: () => { zone.remove(); toast.remove(); clearBtn.remove(); } };
}
