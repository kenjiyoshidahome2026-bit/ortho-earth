// N02（国土数値情報 鉄道）＝新幹線の路線と駅を常駐オーバーレイに（鉄道チップ ON で表示・初回だけ fetch）。ミニ新幹線（秋田・山形）は
// 在来線区間の緯度帯クリップで仲間に入れる。日本の知識＝地域パック @ortho-earth/jp の中（本人裁定 2026-09-17・パック化 2026-09-22）。app.js の一塊（旧 1392〜1471 行）を
// **動作を変えずに**ここへ移した（2026-09-17）。地域宣言（packages/jp/src/region.js の rail）から注入＝/nl/ では作らない（2026-09-22）。
// env … renderer, requestDraw／land（紙色＝テーマで差し替わる getter）／BASEMAP_MINZOOM（路線を描く下限＝基図と同じ門）
// 戻り値 … load()／loaded（読込済フラグ＝テーマ切替が false に戻して引き直す）
import { buildGeoJSONOverlay } from "@ortho-earth/core";
import { geopbf } from "geopbf";

export function createN02Overlay(env) {
const { renderer, requestDraw } = env;

// N02（国土数値情報 鉄道）から新幹線だけ抽出して常駐オーバーレイに（gishub-jp と同じ geopbf 経路）。
// 新幹線＝N02_002(事業者種別)=1「JRの新幹線」。全国一括・疎＝軽い。鉄道チップONで表示、初回だけ fetch。※駅/空港/道の駅は次段。
// ソースは coast と同じ事前変換 GeoPBF（bucket GIS/pbf/N02-25_RailroadSection・路線名/事業者の属性付き＝
// 将来の全線ホバー名表示にそのまま使える）。bucket に無い間だけ生 zip へフォールバック。
// 同じ棚に N02-25_Station（駅名）/ N06-24_HighwaySection（高速道路名）/ N06-24_Joint（IC/JCT名）も配置済み＝次段の弾。
const N02_ZIP = "https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip";
const N02_ORIGIN = [138, 37];   // 全国オーバーレイの原点（delta符号化用・度スケール＝精度問題なし）
let n02Loaded = false;
async function loadN02() {
	if (n02Loaded) return;
	n02Loaded = true;
	console.log("[N02] loading rail geojson (extracting shinkansen)…");
	let rail = await geopbf("N02-25_RailroadSection").catch(e => { console.warn("[N02] bucket load failed", e); return null; });
	if (!rail?.geojson?.features?.length) {
		console.warn("[N02] no geopbf in bucket -> falling back to raw zip");
		rail = await geopbf(`${N02_ZIP}#N02-25_RailroadSection.geojson`).catch(e => { console.warn("[N02] rail failed", e); return null; });
	}
	const fc = rail?.geojson;   // GeoPBF の境界は FeatureCollection。.geojson getter＝{type:"FeatureCollection",features,name}
	const feats = fc?.features;
	if (!feats?.length) { console.warn("[N02] rail load failed", rail && Object.keys(rail)); n02Loaded = false; return; }
	// フル新幹線＝N02_002(事業者種別)=1。ミニ新幹線（秋田・山形）は法規上在来線＝N02には田沢湖線・奥羽線として
	// 収録されているので、該当区間を緯度帯クリップで切り出して仲間に入れる（奥羽線は福島→青森へ緯度ほぼ単調）。
	const sn = feats.filter(f => { const p = f.properties || {}; return p.N02_002 == 1 || /新幹線/.test(String(p.N02_003)); });
	const latClip = (f, lo, hi) => {   // 緯度帯 [lo,hi] に入る線分だけ残す（区間抽出）
		const g = f.geometry; if (!g) return null;
		const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
		const out = [];
		for (const line of lines) {
			let cur = [];
			for (const pt of line) {
				if (pt[1] >= lo && pt[1] <= hi) cur.push(pt);
				else { if (cur.length > 1) out.push(cur); cur = []; }
			}
			if (cur.length > 1) out.push(cur);
		}
		return out.length ? { geometry: { type: "MultiLineString", coordinates: out } } : null;
	};
	let miniN = 0;
	for (const f of feats) {
		const n = String(f.properties?.N02_003 || "");
		if (/^田沢湖線$/.test(n)) { sn.push(f); miniN++; }                       // 秋田新幹線 盛岡—大曲（全線が共用）
		else if (/^奥羽(本)?線$/.test(n)) {
			const ya = latClip(f, 37.74, 38.77), ak = latClip(f, 39.44, 39.73);   // 山形新幹線 福島—新庄／秋田新幹線 大曲—秋田
			if (ya) { sn.push(ya); miniN++; }
			if (ak) { sn.push(ak); miniN++; }
		}
	}
	console.log("[N02] rail", feats.length, "-> shinkansen", sn.length, `(mini ${miniN})`, "| lines:", [...new Set(sn.map(f => f.properties?.N02_003 || "(mini section)"))].join("、"));
	// 濃緑の実線（鉄道点火#4b9e6aより暗く、高速の青#2f6cadと衝突しない）。半幅0.9＝計1.8px＝高速(低ズーム)と同太
	const SN_GREEN = [0.04, 0.42, 0.25, 0.95];
	const scenes = sn.length ? [buildGeoJSONOverlay(sn, N02_ORIGIN, { lineColor: SN_GREEN, lineWidth: 0.9 })] : [];
	// 路線ラインも基図と同じ z≥BASEMAP_MINZOOM でだけ描く：全球(z<4)は基図オフの「地球ぐるぐる」＝
	// 路線だけが宙に浮くバグになる（minZoom 未設定だと renderer の s.minZoom||0=0 で全ズーム描画）。
	if (scenes.length) scenes[0].minZoom = env.BASEMAP_MINZOOM;
	// 駅（Station.geojson＝線路沿いの短いポリライン）：新幹線駅だけをビーズ○で。濃緑の玉に紙色の芯を重ねる＝
	// 線シェーダは capsule（丸端）なので、極小セグメント×太い半幅がそのまま駅の玉になる。ミニ新幹線の停車駅は
	// 在来線駅として収録＝路線×駅名の許可リストで拾う（フル新幹線駅は N02_002=1 で正確に取れる）。
	const stn = await geopbf(`${N02_ZIP}#N02-25_Station.geojson`).catch(e => { console.warn("[N02] station failed", e); return null; });
	const stFeats = stn?.geojson?.features || [];
	const MINI_STOPS = new Set(["米沢", "高畠", "赤湯", "かみのやま温泉", "山形", "天童", "さくらんぼ東根", "村山", "大石田", "新庄",   // 山形新幹線
		"雫石", "田沢湖", "角館", "大曲", "秋田"]);                                                                                  // 秋田新幹線
	const stSn = stFeats.filter(f => {
		const p = f.properties || {};
		return p.N02_002 == 1 || (/^(田沢湖線|奥羽(本)?線)$/.test(String(p.N02_003)) && MINI_STOPS.has(String(p.N02_005)));
	});
	console.log("[N02] stations", stFeats.length, "-> shinkansen stations", stSn.length, "/ regular stations", stFeats.length - stSn.length);
	// 通常駅（新幹線駅以外の全駅）：駅名注記(422)が出るズームから点灯（minZoom）。鉄道点火と同じ緑の小ぶりビーズ。
	const snStnSet = new Set(stSn);
	const stReg = stFeats.filter(f => !snStnSet.has(f));
	if (stReg.length) {
		const rOuter = buildGeoJSONOverlay(stReg, N02_ORIGIN, { lineColor: [0.294, 0.62, 0.416, 1], lineWidth: 1.8 });      // 玉＝鉄道点火#4b9e6a
		const rCore = buildGeoJSONOverlay(stReg, N02_ORIGIN, { lineColor: [env.land[0], env.land[1], env.land[2], 1], lineWidth: 0.9 });      // 芯（紙色＝style由来＝夜も自動追従）
		rOuter.minZoom = rCore.minZoom = 11.5;   // 駅名の出るタイル(z11)が選ばれ始める頃から
		scenes.push(rOuter, rCore);
	}
	if (stSn.length) {   // 新幹線駅は通常駅の後＝重なったら新幹線ビーズが勝つ
		const sOuter = buildGeoJSONOverlay(stSn, N02_ORIGIN, { lineColor: SN_GREEN, lineWidth: 2.4 });                      // 玉（外径）
		const sCore = buildGeoJSONOverlay(stSn, N02_ORIGIN, { lineColor: [env.land[0], env.land[1], env.land[2], 1], lineWidth: 1.2 });       // 芯（紙色＝style由来）＝○に見える
		sOuter.minZoom = sCore.minZoom = 7.5;   // 全国ビュー(z〜6)ではビーズ不要＝広域(z7.5+)から。路線の線は z≥5（基図と同ゲート）
		scenes.push(sOuter, sCore);
	}
	renderer.set("rail", scenes);   // core の路線の口（地域に依らない名）
	requestDraw();
	console.log("[N02] shinkansen drawn");
}

return { load: loadN02, get loaded() { return n02Loaded; }, set loaded(v) { n02Loaded = v; } };
}
