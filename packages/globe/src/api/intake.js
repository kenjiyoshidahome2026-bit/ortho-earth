// 取得の手入れ（map.setTransformRequest・addProtocol・fetchResource）・Marker／Popup・取り込みの表（ファイルの形式ごとの載せ方）と
// ファイル取り込みの一本道（loadUserFile＝D&D と ?g= の共用）＝createGlobe から切り出した（globe.js の分割 ⑥・2026-10-15）。中身は切り出す前と同じ。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { Marker, Popup } from "../gadgets/marker.js";
import { WORLD_PX } from "@ortho-earth/core";
import { addProtocol, removeProtocol } from "../request.js";
import { geopbf, geopbfCachePrune } from "geopbf";
import { tr } from "../i18n.js";

export function installIntake(map, live, {
	D2R, cam, columnarOn, columnarProbe, columnarView, dbgHost, flyTo, gint, pageHash, remoteUrl, requester, size
}) {
	map.Marker = Marker; map.Popup = Popup;
	// 取得の前の手入れ（#37・MapLibre 同名）：setTransformRequest(fn)＝以後の取得に効く（すでに取った基図タイルは取り直さない）・addProtocol は大域（SDK の export と同じ）
	map.setTransformRequest = fn => { requester.setTransform(fn); return map; };
	map.addProtocol = addProtocol; map.removeProtocol = removeProtocol;
	map.fetchResource = (url, type = "Unknown", init) => requester.fetch(url, type, init);
	// フィーチャーサービスの控え（#176）を消す＝鍵の接頭辞 FS1:: の物だけ（地図の他の控えは残る）。opts＝{ maxAge, maxEntries, maxBytes }（省略＝全部）
	map.clearFeatureServiceCache = (opts = { maxEntries: 0 }) => geopbfCachePrune({ prefix: "FS1::", ...opts });   // 部品（記号帳・3D Tiles）が同じ手入れで取るための口   // new map.Marker().setLngLat(…).addTo(map)（import しなくても使える口）
	{
		const q = new URLSearchParams(location.search), spec = q.get("tiles3d");
		const u = spec ? remoteUrl(spec, "tiles3d") : null;
		if (u) { const off = map.onFrame(() => { off(); map.gadget.tiles3d(u.href, { heightOffset: +q.get("t3dh") || 0, fit: !pageHash }).catch(err => console.warn("[tiles3d] ?tiles3d=", err)); }); }
		const iu = q.get("i3s") ? remoteUrl(q.get("i3s"), "i3s") : null;   // ?i3s=<SceneServer の URL>（門は ?g= と共用）
		if (iu) { const off = map.onFrame(() => { off(); map.addI3S(iu.href, { heightOffset: +q.get("t3dh") || 0, fit: !pageHash, ground: q.get("i3sground") || "absolute" }).catch(err => console.warn("[i3s] ?i3s=", err)); }); }
	}
	// @スタイルの見分け＝geopbf のキー表に @属性 があるか（描画系の @キーだけ見る＝他レイヤの誤検知を避ける）
	const ANNO_KEYS = new Set(["@shape", "@icon", "@text", "@size", "@fill", "@stroke", "@width", "@tip", "@pop", "@spline", "@blur", "@poly", "@start", "@end", "@cap0", "@cap1", "@cap"]);
	// ファイル取り込みの一本道（D&D と ?g= の共用）＝geopbf(File,{gint:true})→ @検知で anno 再生 or applyGintData→bboxへ球面フライト
	// ── 取り込みの表（載せる口）─────────────────────────────────────────────────
	// 形式ごとに1行。行の型は二つだけ：
	//   draw    … その形式が自分で描き切る（GeoPBF 本道へは行かない）。返り値はトーストが使う {length}
	//   convert … File を GeoPBF の File へ変え、下の本道（gint 焼き→識別→ドレープ→fit）へ合流する
	// 旧構造は if の連なりで、形式が増えるたびに本道の手前が一段伸びた。表なら「行を1つ足す」で済む。
	// ⚠ 順序が意味を持つ：上から順に test して最初に当たった行を使う。
	// CZML・GPX の時刻再生（#113 段 4）＝遅延 chunk（gadgets/czml.js）。起動時の URL の t=／s= は最初の 1 回だけ勝つ（本人裁定＝読み込んだ clock より URL）
	const czmlGet = async () => live.czmlCtl ??= (await import("../gadgets/czml.js")).createCzmlPlayer({ map, keepUrlClock: () => { const k = live.czmlUrlClock; live.czmlUrlClock = false; return k; } });
	const INTAKE = [
		{
			name: "timed",   // CZML・GPX＝時刻付きの地物は共通の時計で再生（render worker の組み込み czml・#113）・時刻の無い地物は本道（gint）へ。時刻付きが無ければ本道だけ（従来どおり）
			test: f => /\.(czml|gpx)$/i.test(f.name),
			draw: async (file, ctx) => {
				const fs = (await geopbf(file, { gint: false, name: `drop/${file.name}` }).catch(err => { console.error("[timed] geopbf", file.name, err); return null; }))?.geojson?.features || [];
				let packets = null; if (/\.czml$/i.test(file.name)) try { packets = JSON.parse(await file.text()); } catch { /* 読めない＝clock は無し */ }
				const c = await czmlGet(), timed = fs.filter(c.isTimed), rest = fs.filter(f => !c.isTimed(f));
				if (!timed.length) { c.clear(); return mainRoad(file, ctx); }
				if (rest.length) await mainRoad(new File([JSON.stringify({ type: "FeatureCollection", features: rest })], file.name.replace(/\.[^.]+$/, "") + ".geojson"), { ...ctx, fit: false });
				else { gint.clearUserGint(); live.annoCtl?.clear(); }
				const n = c.show(timed, { packets });
				if (ctx?.fit !== false) { const b = c.bounds(); if (b) map.fitBounds(b, { padding: 40 }); }
				return { length: n + rest.length };
			},
		},
		{
			name: "raster-mbtiles",   // MBTiles（画像タイル）＝ローカル容器→プロバイダ worker→画像タイル層（基図・塗りは伏せる・2026-09-21）。ベクタ MBTiles は理由を言って断る
			test: f => /\.mbtiles$/i.test(f.name),
			draw: async file => live.rasterDropFile(file),
		},
		{
			name: "raster-gpkg",   // GeoPackage のラスタ（タイル表）。タイル表が無い（地物層だけ）なら従来のベクタ本道へ合流
			test: f => /\.gpkg$/i.test(f.name),
			draw: async (file, ctx) => { const r = await live.rasterDropFile(file, true); return r === false ? mainRoad(file, ctx) : r; },
		},
		{
			name: "cog",   // COG/GeoTIFF＝cog ガジェットへ（gint 経路の geopbf() は TIFF 非対応で null 死する）
			test: f => /\.tiff?$/i.test(f.name),
			draw: async file => {
				live.annoCtl?.clear(); gint.clearUserGint();
				return map.gadget.cog(file).then(c => ({ length: `${c.width}×${c.height}px` })).catch(err => { console.error("[dropFile] cog", file.name, err); return null; });
			},
		},
		{
			name: "image",   // 素の画像（PNG/JPEG/WebP…）＝落とした地点（無ければ画面中心）に画面の半分の幅・北向きで貼る（2026-09-21）。
			// 中身は「@image つき 4 頂点の面」の GeoPBF＝本道へ合流＝編集ボタンで geoedit に渡せば四隅をドラッグで合わせられる（古地図の位置合わせ）
			test: f => /\.(png|jpe?g|webp|gif|avif)$/i.test(f.name),
			convert: async (file, ctx) => {
				const { placeCorners, quadPolygon, IMAGE_KEY: K } = await import("geopbf/edit/imagequad");
				const bm = await createImageBitmap(file); const aspect = bm.height / bm.width; bm.close?.();
				const c = ctx?.at || [cam.center[0], cam.center[1]];
				const wDeg = 360 * size.w / (WORLD_PX * 2 ** cam.zoom) * 0.5, widthM = Math.max(5, Math.min(2e6, wDeg * 111320 * Math.cos(c[1] * D2R)));
				const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: file.name.replace(/\.[^.]+$/, ""), [K]: file }, geometry: quadPolygon(placeCorners(c, widthM, aspect)) }] };
				const pbf = await geopbf(fc, { gint: false, name: file.name });
				return new File([pbf.arrayBuffer], file.name.replace(/\.[^.]+$/, ".geopbf"));
			},
		},
		{
			name: "model",   // glTF/GLB＝3D 模型（PLATEAU と同じ建物メッシュ経路・gadgets/model.js・遅延chunk・2026-09-20）。落とした地点（ctx.at）に置く／CESIUM_RTC・ECEF 入りは埋め込みが勝つ
			test: f => /\.(glb|gltf)$/i.test(f.name),
			draw: async (file, ctx) => {
				live.annoCtl?.clear(); gint.clearUserGint();
				const c = await map.gadget.model(file, { at: ctx?.at, heading: ctx?.heading, scale: ctx?.scale });
				return { length: c.toastLength() };
			},
		},
		{
			name: "geoparquet-columnar",   // GeoParquet＝大きさに依らず列チャンク層（src/columnar・#90）。File は slice で Range 同等。?columnar=0・ctx.gint・規則が gint（塗り分け）なら下の gint 経路へ
			test: (f, ctx) => /\.(parquet|geoparquet)$/i.test(f.name) && !ctx?.gint && columnarOn(Infinity),
			draw: async (file, ctx) => { const r = await columnarView(file, file.name, { fit: ctx?.fit !== false, probe: columnarProbe(file.size) }); return r ?? mainRoad(await parquetToGeopbf(file), ctx); },
		},
		{
			name: "geopbf-columnar",   // 大きな GeoPBF（COLUMNAR_BYTES 超）＝列チャンク層（#90）。編集ボタン用に「今の図形」は素の GeoPBF のまま預ける（押した時だけ geoedit が gint へ）
			test: (f, ctx) => /\.geopbf(\.gz)?$/i.test(f.name) && !ctx?.gint && columnarOn(f.size),
			draw: async (file, ctx) => {
				const buf = await file.arrayBuffer();
				const r = await columnarView(buf.slice(0), file.name, { fit: ctx?.fit !== false, probe: columnarProbe(file.size) });
				if (!r) return mainRoad(file, ctx);   // 規則が gint と言った（弧の共有が多い塗り分け）
				live.editDocHook?.({ arrayBuffer: buf }, file.name, ctx?.persist);
				return r;
			},
		},
		{
			name: "fgb-columnar",   // FlatGeobuf＝大きい時は列チャンク層（geopbf/fgb 経由の全量読み・#90 段 5）。以下は従来（geopbf の変換 → gint）
			test: (f, ctx) => /\.fgb$/i.test(f.name) && !ctx?.gint && columnarOn(f.size),
			draw: async (file, ctx) => { const r = await columnarView(file, file.name, { fit: ctx?.fit !== false, probe: columnarProbe(file.size) }); return r ?? mainRoad(file, ctx); },
		},
		{
			name: "geoparquet",   // ?columnar=0・規則が gint の時＝従来の全量変換（fromGeoParquet → gint）
			test: f => /\.(parquet|geoparquet)$/i.test(f.name),
			// 本体は動的 import＝.parquet を受けた時だけチャンクが降りる（初期バンドルは不変・ガジェットの遅延ロードと同じ規律）。
			// 内部圧縮は none/snappy/gzip を自前で読む。zstd はブラウザに実装が無い（DecompressionStream("zstd") は未実装）＝
			// fzstd を注入して読む（2026-09-22）。それでも読めない時の素のエラーは読み手を惑わすので包み直す。
			convert: file => parquetToGeopbf(file),
		},
		{
			name: "copc",   // COPC の点群（#178）＝ファイルのまま Range 相当（Blob.slice）で節だけ読む。.copc.laz 以外の LAS/LAZ は扱わない（流せない）
			test: f => /\.copc\.laz$/i.test(f.name),
			draw: async (file, ctx) => { live.annoCtl?.clear(); gint.clearUserGint(); const h = await map.addCOPC(file, { id: "drop", fit: ctx?.fit !== false }); return { length: h.info.count }; },
		},
		{
			name: "georef",   // 基準点の注記（Georeference Annotation・Allmaps の JSON・#177）＝IIIF の古地図を地面に貼る。注記でない .json は本道（従来どおり）へ
			test: f => /\.json$/i.test(f.name) && f.size < 32e6,
			draw: async (file, ctx) => {
				if (!/"georeferencing"/.test(await file.slice(0, 65536).text())) return mainRoad(file, ctx);   // 頭に印が無い＝従来の .json（parse もしない＝従来と同じ道・同じ手間）
				let j = null; try { j = JSON.parse(await file.text()); } catch { /* 読めない＝本道に任せる */ }
				if (!j) return mainRoad(file, ctx);
				const info = await map.raster.add("iiif", { iiif: j, name: file.name.replace(/\.[^.]+$/, "") }, { order: "over", opacity: 1, hideFills: false });
				const b = info?.bbox || map.raster.info("iiif")?.bbox;
				if (b && ctx?.fit !== false) map.fitBounds(b, { padding: 40 });
				return { length: 1 };
			},
		},
	];
	// GeoParquet → GeoPBF の File（従来の全量変換・gint の道）＝INTAKE の geoparquet 行と、列チャンク層が「gint 向き」と言った時の合流に共用
	const parquetToGeopbf = async file => {
		const [{ fromGeoParquet }, { setZstdDecoder }] = await Promise.all([import("geopbf/geoparquet"), import("geopbf/parquet")]);
		setZstdDecoder(async u8 => (await import("fzstd")).decompress(u8));   // zstd の列＝fzstd（当たった時だけ読み込む・geopbf は依存ゼロのまま＝注入）
		const r = await fromGeoParquet(new Uint8Array(await file.arrayBuffer())).catch(err => {
			if (/zstd/i.test(err?.message || "")) throw new Error(tr()("zstd-compressed GeoParquet cannot be read in a browser (re-write it with gzip or snappy)."));
			throw err;   // それ以外（CRS 不一致・幾何列なし等）は geopbf の文面が既に具体的＝そのまま上げてトーストへ
		});
		const s = r.stats;
		if (s?.skipped?.length) console.warn("[dropFile] parquet: skipped columns", s.skipped.map(k => `${k.name}(${k.reason})`).join(" "));
		console.info(`[dropFile] parquet -> GeoPBF  ${s?.features ?? "?"} features, ${s?.vertices ?? "?"} vertices, ${s?.columns?.length ?? "?"} columns, CRS ${s?.crs ?? "?"}, writer ${s?.created || "?"}`);
		return new File([r.pbf.arrayBuffer], file.name.replace(/\.[^.]+$/, ".geopbf"));
	};

	// 落とされた/URL で渡された1件を載せる。表で振り分け→（変換行なら）GeoPBF 本道。
	// 本道＝geopbf(gint 焼き) → @スタイル付きなら anno（canvas2D 再生）／それ以外は gint スロット → bbox へ fit。
	// fit＝読んだ図形へ寄る（ドロップ/?g=）。編集から戻した図形・起動時の復元は寄らない（今の視点のまま置き換える）。
	// editDocHook＝編集ボタンを載せた頁だけ＝読んだ図形を「編集中の図形」として保存する口（単独 geoedit の頁では null）
	const loadUserFile = async (file, { fit = true, persist, ...ctx } = {}) => {   // ctx＝形式固有の文脈（glb の at/heading/scale 等・gint:true＝列チャンク層を使わない）＝draw 行へそのまま・persist＝編集中の図形の置き場の扱い（mainRoad 参照）
		live.gFollow?.destroy(); live.gFollow = null;   // ?g= のサービスの視野追従＝別の図形に替わった
		if (!/\.(czml|gpx)$/i.test(file?.name || "")) live.czmlCtl?.clear();   // 別の図形に替わった＝時刻再生を消す（timed 行は自分で入れ替える）
		for (const fmt of INTAKE) {
			if (!fmt.test(file, ctx)) continue;
			if (fmt.draw) return fmt.draw(file, { fit, persist, ...ctx });
			file = await fmt.convert(file, ctx);   // 変換行＝本道へ合流（以降の扱いは素の .geopbf と同一）
			break;
		}
		return mainRoad(file, { fit, persist });
	};
	dbgHost.__loadUserFile = loadUserFile;   // 検証窓（ドロップと同じ一本道を CDP から＝自動押し出しの確認）
	// 本道（gint 焼き→@検知で anno 再生 or gint スロット→bbox へ fit）＝取り込み表の draw 行からも合流できる（raster-gpkg の地物層フォールバック）
	// persist＝編集中の図形の置き場（IDB）の扱い："save"＝編集の結果（× で戻した）を残す／"keep"＝起動の復元（置き場はそのまま）／
	// 既定＝見ただけ（ドロップ・?g=）＝置き場を空にする（画面が別の図形に替わった＝古い編集結果を次の起動で蘇らせない・2026-09-22 本人再裁定）
	const mainRoad = async (file, { fit = true, persist } = {}) => {
		const pbf = await geopbf(file, { gint: true, name: `drop/${file.name}` }).catch(err => { console.error("[dropFile] geopbf", file.name, err); return null; });
		if (!pbf?.unPackGint) return null;
		// 低ズーム描画が速くなった＝先に現在ビューへ図形を描き（カメラは動かさない）、その後 flyTo で寄る。
		// 瞬間ジャンプ(ポップイン)でなく「図形が現れて→近づく」。着地は真俯瞰(tilt/bearing=0)・北向き＝fit の north-up 前提。
		// 四隅で貼った画像（@image つき 4 頂点の面＝geoedit で置いた古地図・写真）＝画像タイル層へ。描く図形からは抜く（枠を二重に描かない）
		const drawPbf = pbf.keys?.includes(IMAGE_KEY) ? await live.placeImages(pbf, file.name) : (live.clearImages(), pbf);
		if (!drawPbf) { gint.clearUserGint(); live.annoCtl?.clear(); }
		else if (drawPbf.keys?.some(k => ANNO_KEYS.has(k))) {   // @スタイル付き＝注釈レイヤ（geoedit 作）＝canvas2D 再生（gint スロットは触らない→前の層は消す）
			gint.clearUserGint();
			await map.gadget.anno(drawPbf);
		} else {
			live.annoCtl?.clear();
			gint.applyGintData(drawPbf, file.name, false, { drape: true });   // 先に描画（gint スロットへ set・識別点火・カメラ据え置き）＋ポリゴンは地形沿い境界線を自動発火
		}
		live.editDocHook?.(pbf, file.name, persist);
		// 高さの列を持つ面＝自動で 3D 押し出し（geoedit の面パネル「高さ」もここ）。?extrude=0＝しない／?extrude=<列名>[,倍率]＝列を指定
		const ex = await live.autoExtrude(pbf);
		const bb = pbf.unPackGint.bbox;
		if (fit && bb && bb.length === 4) {
			const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
			const wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);   // 30%余白（縁ぴったりを避ける）
			// 視野幅[deg]=360*size.w/(WORLD_PX*2^z)（flight の van Wijk 尺と同一）を逆解き＝横/縦の狭い側に合わせる。
			const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
			flyTo(cx, cy, Math.max(3, Math.min(17, z)), 0);   // 描画後に寄る＝fit へ球面フライト（tilt/bearing=0）。押し出しがあっても傾けない（本人裁定 9/21＝立体は傾けた時に見えればよい）
		}
		return pbf;   // gadget が pbf.length（地物数）をトーストに使う
	};
	// 四隅で貼った画像＝1 枚ごとに画像タイル層 "img:<n>"（重ね・@opacity）。前の画像は外す（「最後の 1 枚が勝つ」＝図形と同じ）。
	// 戻り値＝画像を抜いた残りの図形（gint/anno へ）。残りが無ければ null。imagequad（判定・四隅）は遅延 import＝画像の無い読み込みは降ろさない
	const IMAGE_KEY = "@image";
	return { loadUserFile, IMAGE_KEY };
}
