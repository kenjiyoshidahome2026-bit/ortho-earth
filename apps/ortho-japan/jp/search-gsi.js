// 地名検索の供給元：地理院 AddressSearch API 直叩き（キー不要・CORS開放）＝ノーサーバーのまま住所も地名も引ける。
// 基図タイルが既に地理院依存なので実質的な依存追加ゼロ。APIの素性が悪い（同名の真の重複・全国散在の同名・並びの癖）ので、
// 全件を前処理してから候補にする。検索窓（UI・履歴・IME）は search.js の createSearch＝この供給元を地域宣言（JP_REGION.search）から受ける。
// 供給元の契約＝{ histKey, query(q, signal) → [{title, note, lon, lat}], viewFor(title) → {zoom, tilt?} }（2026-09-22 search.js から分離）。
const API = "https://msearch.gsi.go.jp/address-search/AddressSearch?q=";

// addressCode（JIS市区町村コード）先頭2桁→都道府県名。'' は市区町村に属さない広域地物（本物の富士山等）。
// export＝PLATEAUデータ管理モーダル（plateaudb.js）の都道府県ブロック見出しでも使う。
export const PREF = ",北海道,青森県,岩手県,宮城県,秋田県,山形県,福島県,茨城県,栃木県,群馬県,埼玉県,千葉県,東京都,神奈川県,新潟県,富山県,石川県,福井県,山梨県,長野県,岐阜県,静岡県,愛知県,三重県,滋賀県,京都府,大阪府,兵庫県,奈良県,和歌山県,鳥取県,島根県,岡山県,広島県,山口県,徳島県,香川県,愛媛県,高知県,福岡県,佐賀県,長崎県,熊本県,大分県,宮崎県,鹿児島県,沖縄県".split(",");

// 前処理：APIの生の全件（切り詰め前）を候補に整える。
// 1) 同タイトルで近接（〜2km）は真の重複（東京駅=路線別座標、スカイツリー=データ源違い）＝平均座標で1件に統合。
// 2) 統合後も同タイトルが複数残る＝全国散在の同名（富士山は完全一致だけで25件）＝県名の添え書きで区別。
//    添え書きは表示専用：検索マッチ（rerank）にも input への書き戻しにも viewFor にも使わない＝「長野」で富士山が引っかかったりしない。
export function preprocess(hits) {
	const byTitle = new Map();
	hits.forEach((h, i) => {
		const t = h.properties.title, [x, y] = h.geometry.coordinates;
		let group = byTitle.get(t);
		if (!group) byTitle.set(t, group = []);
		const near = group.find(c => Math.hypot(c.x / c.n - x, c.y / c.n - y) < 0.02);
		if (near) { near.x += x; near.y += y; near.n++; }
		else group.push({ x, y, n: 1, i, code: h.properties.addressCode || "" });
	});
	const out = [];
	for (const [title, group] of byTitle) for (const c of group)
		out.push({
			title,                                                                       // マッチ・入力値・viewFor は生タイトル
			note: group.length > 1 ? PREF[Math.floor(+c.code / 1000)] || "" : "",        // 同名が複数残る時だけ県名を添える
			lon: c.x / c.n, lat: c.y / c.n, i: c.i,
			national: !c.code,                                                           // 広域地物フラグ（同点決勝用）
		});
	return out;
}

// 再ランク：完全一致（「富士山」「琵琶湖」等の自然地名の正解はほぼこれ）→ 含む（短い題名ほど上＝
// 「東京都渋谷区」が「福島県猪苗代町渋谷」より先）→ その他はAPI順。切り詰め前の全件に掛けるのが肝
//（「大雪山」の正解は22件の奥に居る＝先に8件で切ると捨ててしまう）。
// 序列：広域地物の完全一致（本物の富士山=addressCode無し）＞ 市区の本体名一致（渋谷→東京都渋谷区）＞
// 字名の完全一致（全国の渋谷・上田市の富士山）。市区ブーストが無いと有名市区が全国の同名字名に埋もれる。
// 町村まで広げると字名の「〜町」（○○市渋谷町等）を誤って掬うので市・区に限定。1文字クエリも誤爆源（山→富山市）なので除外。
export function rerank(q, cands) {
	const muni = c => q.length >= 2 && (c.title.endsWith(q + "市") || c.title.endsWith(q + "区"));
	const score = c => c.title === q ? (c.national ? 0 : 0.001)
		: muni(c) ? 0.0005
		: c.title.includes(q) ? 1 + (c.title.length - q.length) / 100 : 2;
	return cands.map(c => [score(c), c.i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
}


// ヒットの粒度→着地ズーム＋チルト。APIは extent を返さないので名前で近似（v1の割り切り）。
// 自然地名（山・湖・岬…）は山岳レジーム（z13・チルト55°）＝地形が主役の着地。
// 住所・地名は z15.5＝PLATEAU自動ロード圏＝着地で街が立つ。
const NATURE = /([山岳峰湖沼池岬崎峠島滝湾](\s*\(.*\))?|高原|湿原|ヶ原|渓谷|盆地|平野|半島|諸島|列島)$/;
function viewFor(title) {
	if (/^(東京都|北海道|(京都|大阪)府|.{2,3}県)$/.test(title)) return { zoom: 10 };     // 都道府県
	if (NATURE.test(title)) return { zoom: 12.8, tilt: 55 };                            // 自然地名＝地形ビュー
	if (/[市区町村]$/.test(title)) return { zoom: 13 };                                 // 市区町村
	return { zoom: 15.5 };                                                              // 住所・丁目・施設
}

export const gsiSearch = {
	histKey: "ortho-japan.searches",   // 検索履歴の localStorage 鍵（分離前と同じ＝利用者の履歴を引き継ぐ）
	async query(q, signal) {
		const res = await fetch(API + encodeURIComponent(q), { signal });
		return rerank(q, preprocess(await res.json())).slice(0, 8);
	},
	viewFor,
};
