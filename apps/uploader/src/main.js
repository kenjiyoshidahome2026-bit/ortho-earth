// uploader＝データを焼いて bucket（api.ortho-earth.com）へ置く作業台。
// このファイルは「接続」と「メニュー表」だけ。焼きの中身は分野ごとのモジュールへ：
//   globe.js       全球の基図（背景画像・Natural Earth）
//   space/         星座線・メシエ・天体名・月の地名
//   terrain/       標高（GEBCO 由来の海面下の陸・全球アトラス）
//   japan.js       国土数値情報・環境省
//   poi/           POI 台帳（schema.js は ortho-japan の検定と共用＝動かさない）
//   world/         国別 DB（自前の節を持つ）
//   models.js      名所 3D 模型（自前の節を持つ）
//   lib/           共通の手順（bakeEach）と画像変換
// ボタンを足す時は MENU に一行（と、中身は分野のモジュールへ）。
import * as d3 from 'd3';
import "./main.scss";
import { screenLogger } from "common/screenLogger";
import "common/d3/selection.js";
import { nativeBucket } from "native-bucket";
import { createGeopbf } from "geopbf";
import { GEBCO } from "./terrain/gebco.js";   // GEBCO の GeoTIFF → 標高タイル（焼きの道具＝uploader 専用・2026-09-25 に altpbf から移設）

import * as globe from "./globe.js";
import * as space from "./space/index.js";
import * as japan from "./japan.js";
import { poi } from "./poi/bake.js";
import { belowSeaLand } from "./terrain/belowsea.js";
import { worldAtlas } from "./terrain/worldatlas.js";
import { worldUI } from "./world/index.js";
import { modelsUI } from "./models.js";   // 名所 3D 模型（GLB）の一括アップロード → GIS/models（/japan/models.html の台帳と突き合わせ）

const API_BASE = import.meta.env.DEV ? `${location.origin}/api` : "https://api.ortho-earth.com";
// 書込キーはソースに置かない（過去に履歴掃除で "***REMOVED***" 化＝無効キーで PUT が黙って死ぬ事故）。
// .env.local の VITE_API_KEY から注入。無ければ起動時に警告＝気づけるように。
const API_KEY = import.meta.env.VITE_API_KEY ?? "";
if (!API_KEY) console.warn("uploader: VITE_API_KEY が未設定（.env.local）＝アップロードは 403 で失敗します");
createGeopbf(API_BASE, { apiKey: API_KEY, bucket: nativeBucket });
const { Fetch, Bucket, Cache } = nativeBucket(API_BASE, { apiKey: API_KEY });
const ctx = { Fetch, Bucket, Cache, apiUrl: API_BASE };

const body = d3.select("body");
const CMD = body.append("div").classed("command", true);
const LOG = body.append("div").attr("id", "logArea").classed("logArea", true);
const q = new screenLogger(LOG);

// [節, [[ボタン, 実行]...]]。実行は (q, ctx) を受ける
const MENU = [
	["全球の基図", [
		["base ER pictures", globe.baseImages],
		["borders and stars", globe.borders],
		["admin0 countries (50m+10m)", globe.admin0],
		["NE lakes (50m+10m)", globe.lakes],
		["NE rivers + airports + maritime (10m)", globe.riversAirports],
	]],
	["宇宙", [
		["constellation lines", space.constellations],
		["messier", space.messier],
		["space names", space.spaceNames],
		["moon names", space.moonNames],
	]],
	["標高", [
		["create GEBCO(R90/R10)", q => GEBCO({ year: 2026, log: q })],
		["below-sea land (GEBCO×admin0)", belowSeaLand],
		["world hypso atlas (R90×8 → 1枚)", worldAtlas],   // R90 を GEBCO で更新してから
	]],
	["日本", [
		["KSJ 鉄道/高速道路 (N02/N06)", japan.ksj],
		["国立公園 (環境省 nps_all)", japan.nps],
		["行政区域 (N03 admin_all)", japan.admin],
	]],
	["POI 台帳", [
		["POI civic (KSJ P29→z14)", poi],
		["POI civic (P29+注記突合)", (q, c) => poi(q, c, { sets: ["P29"], withAnno: true })],
		// 京都・全civic合流＝学校P29＋郵便局P30＋役場P34（z14窓）＋寺院662を注記から掃引（三十三間堂の正しい位置＝§1解決）。
		["POI civic 京都 (P29+P30+P34+寺院)", (q, c) => poi(q, c, {
			sets: ["P29", "P30", "P34"], anno: [{ code: 662, label: "寺院", bbox: [135.70, 34.95, 135.83, 35.06] }],
		})],
	]],
];

const head = CMD.append("header");
head.append("h1").text("Uploader");
const conn = head.append("div").classed("conn", true);
conn.append("span").classed("dot", true).classed("ng", !API_KEY);
conn.append("span").text(`api.ortho-earth.com${import.meta.env.DEV ? "（dev proxy 経由）" : ""}${API_KEY ? "" : "・書き込み鍵なし＝403 になる"}`);   // dev でも書き込み先は本番 bucket
LOG.append("div").classed("empty", true).text("左のボタンで焼いて bucket へ置く。進み具合と結果はここに出る。");

for (const [title, buttons] of MENU) {
	CMD.append("h2").text(title);
	for (const [label, run] of buttons) {
		const btn = CMD.append("button").text(label);
		btn.on("click", async () => {
			if (btn.classed("busy")) return;   // 二度押しで同じ焼きが並走しない
			btn.classed("busy", true).classed("ok ng", false);
			try { await run(q, ctx); btn.classed("ok", true); }
			catch (e) { console.error(e); q.error(`${label}: 失敗 — ${e?.message || e}`); btn.classed("ng", true); }
			finally { btn.classed("busy", false); }
		});
	}
}
// 自前の節を持つもの。置き場所の div を先に確保＝world の疎通確認（非同期）を待たずに並び順が決まる
modelsUI({ CMD: CMD.append("div"), q, Bucket });
worldUI({ CMD: CMD.append("div"), q, Bucket, Fetch }).catch(e => console.error("worldUI:", e));   // await しない＝疎通待ちで他の節を塞がない
