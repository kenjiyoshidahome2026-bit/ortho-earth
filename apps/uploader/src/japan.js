// 日本の公共データ（国土数値情報・環境省）→ GIS/pbf。ortho-japan が読む。
import { geopbf } from "geopbf";
import { bakeEach } from "./lib/bake.js";

// 国土数値情報 N02(鉄道)/N06(高速道路時系列) を GeoPBF 化して GIS/pbf へ。ortho-japan の新幹線
// オーバーレイと将来のホバー名表示（路線名/駅名/道路名/IC名）の弾。年度更新時は URL の年式を上げて再クリック。
// ※国道は現行 KSJ に路線番号付きラインデータが無い（N13 は道路分類のみ・2400万セグメント）＝棚上げ中。
export function ksj(q) {
	const N02 = "https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip";
	const N06 = "https://nlftp.mlit.go.jp/ksj/gml/data/N06/N06-24/N06-24_GML.zip";
	const license = "国土数値情報 利用規約（政府標準利用規約準拠・出典明示で利用可）";
	const items = [
		{ zip: N02, name: "N02-25_RailroadSection", description: "鉄道区間（路線名・事業者）2025年度", attribution: "国土交通省 国土数値情報（鉄道データ N02-25）" },
		{ zip: N02, name: "N02-25_Station", description: "鉄道駅（駅名・路線名・事業者）2025年度", attribution: "国土交通省 国土数値情報（鉄道データ N02-25）" },
		{ zip: N06, name: "N06-24_HighwaySection", description: "高速道路区間（道路名・供用年度）2024年度", attribution: "国土交通省 国土数値情報（高速道路時系列データ N06-24）" },
		{ zip: N06, name: "N06-24_Joint", description: "高速道路IC/JCT/SA（施設名）2024年度", attribution: "国土交通省 国土数値情報（高速道路時系列データ N06-24）" },
	];
	return bakeEach(q, "KSJ 鉄道/高速道路", items.map(({ zip, name, description, attribution }) =>
		({ name, url: `${zip}#${name}.geojson`, header: { description, license, attribution } })));
}

// 環境省 国立公園区域・地種区分 → GIS/pbf/nps_all。属性＝名称/地域区（特別保護地区・第1〜3種特別地域・
// 海域公園地区・普通地域）＝ホバーで地種区分まで言える。
// ソースは環境ジオポータルの FeatureServer（2000件/頁でページング）。全国版 nps_all は2024-05版で
// 日高山脈襟裳十勝（2024-06指定・35番目）を含まないため、北海道事務所の nps_hokkaido から継ぎ足す。
// クリーニング＝エンコード→デコードのプローブで precision 6（±11cm）で潰れる退化スライバーと
// ソース由来 null geometry を実測除去（数十件・全て幅数cmの掃除ゴミ）。
export async function nps(q) {
	const ALL = "https://services.arcgis.com/wlVTGRSYTzAbjjiC/arcgis/rest/services/nps_all/FeatureServer/0/query";
	const HOKKAIDO = "https://services5.arcgis.com/xyLLVFhw1NuQvexI/arcgis/rest/services/nps_hokkaido/FeatureServer/0/query";
	q.clear();
	q.title("国立公園 (nps_all)");
	const page = async (url, params, offset) => (await fetch(`${url}?${new URLSearchParams({
		where: "1=1", outSR: "4326", f: "geojson", resultOffset: offset, resultRecordCount: 2000, ...params })}`)).json();
	const features = [];
	for (let off = 0; ; off += 2000) {   // 全国版（名称/地域区）
		const d = await page(ALL, { outFields: "名称,地域区" }, off);
		features.push(...d.features);
		q.log(`nps_all: ${features.length} features …`);
		if (!d.properties?.exceededTransferLimit && !d.exceededTransferLimit) break;
	}
	const hidaka = await page(HOKKAIDO, { where: "NAME LIKE '%日高%'", outFields: "NAME,ZONE" }, 0);
	for (const f of hidaka.features)
		features.push({ type: "Feature", properties: { 名称: f.properties.NAME, 地域区: f.properties.ZONE }, geometry: f.geometry });
	q.log(`日高山脈襟裳十勝: +${hidaka.features.length} features（北海道事務所データ）`);

	// プローブ＝一意IDを焼いて往復し、geometry付きで生き残った個体だけ採用
	const probeFeats = features.map((f, i) => ({ ...f, properties: { ...f.properties, __i: i } }));
	const probe = await geopbf({ type: "FeatureCollection", features: probeFeats }, { name: "nps_probe", nocache: true, gint: false });
	const aliveIdx = new Set();
	probe.geojson.features.forEach(f => { if (f.geometry?.coordinates?.length) aliveIdx.add(f.properties.__i); });
	const clean = features.filter((f, i) => aliveIdx.has(i));
	q.log(`クリーニング: ${clean.length} 採用 / ${features.length - clean.length} 除去（退化スライバー・null）`);

	const pbf = await geopbf({ type: "FeatureCollection", features: clean }, { name: "nps_all", nocache: true });
	if (!pbf.length) throw new Error("nps_all: encoding produced 0 features");
	pbf.updateHeader({
		description: "国立公園区域・地種区分 全35公園（名称・特別保護地区/第1〜3種特別地域/海域公園地区/普通地域。日高山脈襟裳十勝は北海道事務所データで補完）",
		license: "政府標準利用規約準拠・出典明示で利用可",
		attribution: "環境省 環境ジオポータル（国立公園区域等 nps_all／nps_hokkaido）",
	});
	const parks = new Set(pbf.geojson.features.map(f => f.properties["名称"]));
	q.log(`nps_all: ${pbf.length} features, 公園数 ${parks.size}`);
	if (parks.size !== 35) throw new Error(`公園数 ${parks.size} ≠ 35`);
	await pbf.save();
	q.success("nps_all: saved（35公園・地種区分付き）");
}

// 国土数値情報 N03（行政区域・2025年版）→ GIS/pbf/admin_all
// 【専用データ】描画用ではなく「座標→市区町村」の逆引き（pbf.identifyAt）専用＝
// VWランク24（≈z13・境界誤差~20m級）でガッツリ間引く。海岸線が少し太っても identify には無問題。
// 属性は code（N03_007 行政区域コード＝jp/codes.js のアドレス空間に直結）と name（住所風表記）のみ。
export async function admin(q) {
	const RANK = 24;
	q.clear();
	q.title("行政区域 (admin_all)");
	const features = [];
	let keptVerts = 0;
	for (let p = 1; p <= 47; p++) {
		const pref = String(p).padStart(2, "0");
		const url = `https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2025/N03-20250101_${pref}_GML.zip`;
		const pbf = await geopbf(url, { name: `n03_${pref}`, nocache: true });
		if (!pbf.length) throw new Error(`${pref}: 0 features`);
		const fc = pbf.simplified(RANK);
		let kept = 0;
		for (const f of fc.features) {
			const pr = f.properties;
			const code = pr["N03_007"];
			if (!code) continue;   // 所属未定地
			f.properties = { code, name: [pr["N03_001"], pr["N03_003"], pr["N03_004"], pr["N03_005"]].filter(t => t && t !== "None").join("") };
			features.push(f);
			kept++;
		}
		const nv = fc.features.reduce((s2, f) => { const g = f.geometry;
			const cr = r => s2 += r.length;
			if (g.type === "Polygon") g.coordinates.forEach(cr);
			else if (g.type === "MultiPolygon") g.coordinates.forEach(c => c.forEach(cr));
			return s2; }, 0);
		keptVerts += nv;
		q.log(`${pref}: ${kept} features / ${nv.toLocaleString()} verts`);
	}
	const out = await geopbf({ type: "FeatureCollection", features }, { name: "admin_all", nocache: true });
	if (!out.length) throw new Error("admin_all: encoding produced 0 features");
	out.updateHeader({
		description: "全国市区町村ポリゴン（座標→市区町村の逆引き専用・VWランク24間引き＝境界誤差~20m級。描画用途には元のN03を使うこと）",
		license: "政府標準利用規約準拠・出典明示で利用可",
		attribution: "国土交通省 国土数値情報（行政区域 N03 2025年版）",
	});
	const codes = new Set(out.geojson.features.map(f => f.properties.code));
	q.log(`admin_all: ${out.length.toLocaleString()} features / ${codes.size} 市区町村コード / ${(out.size / 1e6).toFixed(1)}MB / verts ${keptVerts.toLocaleString()}`);
	await out.save();
	q.success(`admin_all: saved（${codes.size}市区町村・${(out.size / 1e6).toFixed(1)}MB）`);
}
