// POI台帳の種別コード・正規化・ランク・KSJ突合ロジック（docs/poi-ledger.md §11 の実装）。
// ここは geopbf/bucket に依存しない純粋関数だけ＝焼き手順(poi())はこれを呼ぶ薄い器にする。
// ルールは scratchpad/poi-ksj-probe.mjs の京都実測で確定済み（§8-実測）。

// ── 種別コード（1B・上位ニブル=大分類 major=code>>4）── §11.4
export const TYPE = {
	不明: 0x00, 塔: 0x0E, その他: 0x0F,
	小学校: 0x11, 中学校: 0x12, 高校: 0x13, 中等教育: 0x14, 大学: 0x15, 短大高専: 0x16, 特別支援: 0x17, 専修各種: 0x18, 幼稚園こども園: 0x19,
	都道府県庁: 0x21, 市区町村役場: 0x22, 国県機関: 0x23, 郵便局: 0x24, 警察署: 0x25, 交番: 0x26, 消防署: 0x27,
	病院: 0x31, 診療所: 0x32, 福祉施設: 0x33, 保健所: 0x34,
	博物館: 0x41, 図書館: 0x42, ホール: 0x43, 体育競技: 0x44, 公園: 0x45, 観光資源: 0x46,
	百貨店モール: 0x51, アウトレット: 0x52, 駅ビル: 0x53, 市場: 0x54, コンビニ: 0x55, スーパー: 0x56, 飲食: 0x57, 宿泊: 0x58, ガソリン: 0x59, EV充電: 0x5A,
	鉄道駅: 0x61, 空港: 0x62, 港: 0x63, 道の駅: 0x64, バスターミナル: 0x65,
	寺院: 0x71, 神社: 0x72, 教会: 0x73,
};
export const MAJOR: Record<number, string> = { 0x0: "その他", 0x1: "教育", 0x2: "官公庁", 0x3: "医療福祉", 0x4: "文化", 0x5: "商業", 0x6: "交通", 0x7: "宗教" };
export const majorOf = (code: number): number => code >> 4;

// ── 出典 enum（4bit×2で1バイトに畳む）── §11.6
export const SRC = { KSJ: 0, ANNO: 1, PLATEAU: 2, MANUAL: 3, NAMERULE: 4, OSM: 5, OCM: 6 };
export const packSrc = (posSrc: number, typeSrc: number): number => (posSrc << 4) | typeSrc;

// ── ランク（1B・大きいほど重要・z14〜16内の衝突優先＋解禁段）── §11.5
// base = 同種内の粗い重み（全国ラダーではない）。heightBonus は建物のみ。値は叩き台＝要調整。
const RANK_BASE: Record<number, number> = {
	[TYPE.都道府県庁]: 235, [TYPE.空港]: 235, [TYPE.市区町村役場]: 175, [TYPE.百貨店モール]: 180, [TYPE.アウトレット]: 180,
	[TYPE.大学]: 170, [TYPE.病院]: 150, [TYPE.鉄道駅]: 150, [TYPE.港]: 150, [TYPE.駅ビル]: 150, [TYPE.国県機関]: 150,
	[TYPE.博物館]: 140, [TYPE.短大高専]: 130, [TYPE.高校]: 120, [TYPE.観光資源]: 120, [TYPE.道の駅]: 120,
	[TYPE.中等教育]: 110, [TYPE.警察署]: 110, [TYPE.図書館]: 110, [TYPE.ホール]: 110, [TYPE.バスターミナル]: 110,
	[TYPE.消防署]: 100, [TYPE.体育競技]: 100, [TYPE.保健所]: 90, [TYPE.特別支援]: 90, [TYPE.専修各種]: 90, [TYPE.公園]: 90, [TYPE.市場]: 90, [TYPE.寺院]: 90, [TYPE.神社]: 90,
	[TYPE.中学校]: 80, [TYPE.宿泊]: 80, [TYPE.小学校]: 70, [TYPE.郵便局]: 70, [TYPE.教会]: 70, [TYPE.スーパー]: 60,
	[TYPE.交番]: 55, [TYPE.診療所]: 50, [TYPE.EV充電]: 50, [TYPE.福祉施設]: 45, [TYPE.ガソリン]: 45, [TYPE.幼稚園こども園]: 40,
	[TYPE.コンビニ]: 35, [TYPE.飲食]: 30, [TYPE.塔]: 150, [TYPE.その他]: 20, [TYPE.不明]: 0,
};
export function rankOf(type: number, { height = 0, demote = 0 }: { height?: number; demote?: number } = {}): number {
	if (type === TYPE.不明) return 0;
	const base = RANK_BASE[type] ?? 40;
	const hb = height > 0 ? Math.min(80, height / 4) : 0;
	return Math.max(0, Math.min(255, Math.round(base + hb - demote)));
}
// z14→16 の解禁段（§11.5）。rank255→z14 / 中位→z15 / 下位→z16。表示側と揃える基準式。
export const zAppearOf = (rank: number): number => 14 + (255 - rank) * 3 / 255;

const WS = /\s/;
// 括弧で囲んだ所を落とす（旧 /O[^C]*C/g と同じ削り方）。開きの次の最初の閉じまで＝中に開きがあっても良い・閉じの無い開き以降はそのまま。ws＝前後の空白 1 字も落とす（旧 /\s?\(…\)\s?/g）
function stripBracketed(s: string, open: string, close: string, ws = false): string {
	let out = "", i = 0;
	for (;;) {
		let j = i; while (j < s.length && !open.includes(s[j])) j++;
		if (j >= s.length) return out + s.slice(i);
		let k = j + 1; while (k < s.length && !close.includes(s[k])) k++;
		if (k >= s.length) return out + s.slice(i);
		let a = j, b = k + 1;
		if (ws && a > i && WS.test(s[a - 1])) a--;
		if (ws && b < s.length && WS.test(s[b])) b++;
		out += s.slice(i, a); i = b;
	}
}
// 旧 s.replace(/(大学|大学院).*(キャンパス|学舎|校地).*$/, "$1")：最初の「大学」の後ろ（改行の無い範囲）にキャンパス等があれば「大学」で切る。$1 は常に「大学」（先の選択肢）
function cutCampus(s: string): string {
	const from = s.lastIndexOf("\n") + 1, first = s.indexOf("大学", from);
	if (first < 0) return s;
	const kw = Math.max(s.lastIndexOf("キャンパス"), s.lastIndexOf("学舎"), s.lastIndexOf("校地"));
	return kw >= first + 2 ? s.slice(0, first) + "大学" : s;
}
// ── 正規化（§8.2）── 系統別。norm0=merge.mjs 既存、normK=学校の自治体冠も落とす
export const norm0 = (s: unknown): string => stripBracketed(String(s)
	.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), "（(", "）)")   // 旧 .replace(/[（(][^）)]*[）)]/g, "")（CodeQL の二乗の後戻り＝添字で同じ削り方）
	.replace(/[\s　]/g, "")
	.replace(/株式会社|有限会社|一般社団法人|公益財団法人|独立行政法人|社会福祉法人|学校法人|医療法人/g, "")
	.replace(/^(都立|道立|府立|県立|市立|区立|町立|村立|国立|公立|私立|組合立)/, "")
	.replace(/[ー－\-‐‑–—]/g, "")
	.replace(/大学$/, "大").replace(/ビルディング$/, "ビル");
// 学校：KSJ「京都市立紫明小学校」対 注記「市立紫明小学校」＝自治体冠を落とす（10%→59%・実測）
export const normK = (s: unknown): string => norm0(String(s).replace(/^.{1,10}?[都道府県市区町村]立/, ""));
// 大学：885注記は「◯◯大学××キャンパス」で入る＝キャンパス接尾を落として比べる
export const normUniv = (s: unknown): string => norm0(cutCampus(String(s)));

const D2R = Math.PI / 180;
export const distM = (a: number[], b: number[]): number => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * D2R), (a[1] - b[1]) * 111320);

// ── KSJ 系統レジストリ（v1＝学校・郵便局）── §8 / §11.8
// class→種別：KSJ の分類コードが種別の芯。annoCode は位置採否・鮮度判定に使う experimental の annoCtg。
/** KSJ の 1 系統（P29 学校・P30 郵便局・P34 役場） */
export interface KsjSet {
	label: string; year: string; perPref?: boolean; national?: boolean; geojson: boolean;
	prefKey?: string; nameKey: string; classKey: string; annoCode: number;
	norm: (s: unknown) => string;
	classToType: Record<string, number> | null;
	typeOf?: (name: string) => number;
	demoteOf?: (name: string) => number;
}
/** KSJ の 1 点（突合の入力） */
export interface KsjPoint { name: string; ll: number[]; cls?: string }
/** 注記の索引の 1 件（annoIndex の値） */
export interface AnnoEntry { ll: number[]; knj?: string; code?: number; kana?: string }
export interface ResolvedPoint { ll: number[]; type: number; posSrc: number; typeSrc: number; matched: boolean; kana: string }
/** 焼き側の点（applyOverrides の入出力） */
export interface PoiRec { ll: number[]; name: string; type: number; rank: number; src: number; kana: string; [k: string]: unknown }
/** §12 手差分の 1 レコード（poi/overrides.json の recs） */
export interface OvrRec { id: number; op: "add" | "move" | "rename" | "del"; n: string; ll: number[]; to?: number[] | string; t?: number; r?: number; d?: string }
export const KSJ_SETS: Record<"P29" | "P30" | "P34", KsjSet> = {
	P29: {
		label: "学校", year: "23", perPref: true, geojson: true,
		nameKey: "P29_004", classKey: "P29_003", annoCode: 885, norm: normK,
		classToType: {
			"16001": TYPE.小学校, "16002": TYPE.中学校, "16003": TYPE.中等教育, "16004": TYPE.高校,
			"16005": TYPE.短大高専, "16006": TYPE.特別支援, "16007": TYPE.幼稚園こども園,
			"16011": TYPE.幼稚園こども園, "16012": TYPE.専修各種, "16013": TYPE.専修各種, "16014": TYPE.専修各種,
			"16015": TYPE.大学, "16016": TYPE.短大高専,
		},
	},
	P30: {
		label: "郵便局", year: "13", national: true, geojson: false,  // 全国1ファイル・dbfのみ→ブラウザは geopbf(zip) で読む
		prefKey: "P30_001", nameKey: "P30_005", classKey: "FLG", annoCode: 887, norm: norm0,
		classToType: null,  // 全件 郵便局。簡易局は名前で降格
		typeOf: name => TYPE.郵便局,
		demoteOf: name => /簡易郵便局/.test(name) ? 20 : 0,
	},
	P34: {
		label: "役場", year: "14", geojson: false,   // 都道府県別・shp+dbf のみ（SJIS・座標は shp 幾何）。役場は高rank＝z14-15 窓の主役
		nameKey: "P34_003", classKey: "P34_002", annoCode: 880, norm: norm0,
		classToType: { "1": TYPE.市区町村役場, "2": TYPE.市区町村役場 },   // 1=本庁 2=支所/出張所（両方 役場・支所は降格）
		demoteOf: name => /出張所|支所|連絡所/.test(name) ? 30 : 0,
	},
};
export function ksjType(set: KsjSet, row: KsjPoint): number {
	if (set.typeOf) return set.typeOf(row.name);
	const t = set.classToType?.[row.cls as string];
	return t ?? TYPE.その他;
}

// ── annoCtg → 種別（注記側からの補完・PLATEAU固有点の種別づけにも使う）──
export const ANNO_TO_TYPE: Record<number, number> = {
	885: TYPE.高校, 887: TYPE.郵便局, 883: TYPE.警察署, 886: TYPE.病院, 889: TYPE.博物館,
	880: TYPE.市区町村役場, 631: TYPE.大学, 422: TYPE.鉄道駅, 662: TYPE.寺院, 890: TYPE.福祉施設,
};

// ── 突合の芯（§8.1/§11.7）── KSJ点1件に対し、正規化名一致の注記から位置を採り種別を確定。
// annoIndex = Map<正規化名, [{ll, knj, code, kana}...]>（呼び側が set.norm で索引化して渡す）。
// 返り＝{ ll, type, posSrc, typeSrc, matched(注記に当たったか) }。位置優先は PLATEAU>注記>KSJ だが
// PLATEAU は別途（civic側で建物代表点がある時に上書き）。ここは 注記>KSJ を決める。
export function resolvePoint(ksjPt: KsjPoint, set: KsjSet, annoIndex: Map<string, AnnoEntry[]>, { radiusM = 250 }: { radiusM?: number } = {}): ResolvedPoint {
	const key = set.norm(ksjPt.name);
	let hit: AnnoEntry | null = null, hd = radiusM * 4;
	for (const a of (annoIndex.get(key) || [])) { const d = distM(ksjPt.ll, a.ll); if (d < hd) { hd = d; hit = a; } }
	const type = ksjType(set, ksjPt);   // 種別の芯は KSJ 分類（§5）
	if (hit && hd <= radiusM) return { ll: (hit as AnnoEntry).ll, type, posSrc: SRC.ANNO, typeSrc: SRC.KSJ, matched: true, kana: (hit as AnnoEntry).kana || "" };
	// 注記に当たらない＝廃止/移転か注記外種（幼稚園・大学略記）。位置は KSJ のまま（§8.3）
	return { ll: ksjPt.ll, type, posSrc: SRC.KSJ, typeSrc: SRC.KSJ, matched: false, kana: "" };
}

// ── 手差分 overrides（§12・本人裁定2026-08-10「ベクターファイルとは分離して、サーバー管理が基本」）──
// 器＝bucket の poi/overrides.json 1本（civic専用・OSMバケツは編集不可）：
//   { v: 版(Date.now・保存ごと更新), seq: 次に振るid, recs: [{id, op, n, ll, to?, t?, r?, d}] }
//   op: "add"(n,ll,t,r) / "move"(n,ll → to=[lon,lat]) / "rename"(n,ll → to=新名) / "del"(n,ll)。d=編集日。
// z14タイルは焼き成果物＝直接編集しない。焼き込み後もレコードは消さない＝履歴・毎回再適用（下記の意味論で冪等）。
// match＝名前の完全一致∧OVR_MATCH_M以内の最近傍1件（normは不要＝編集は表示中のタイル文字列を記録するため。
// 300m＝plateau-names の同名クラスタ畳みと同じ距離感＝全国の同名別施設「本町郵便局」を拾わない）。
// 適用＝id昇順の逐次fold＝編集は「その時見えていた状態」への操作（rename後の編集は新名でmatchして正しく繋がる）。
// 表示側 app.js applyPoiOvr は同じ意味論の実行時版（表示形 {anchor,n,r,s}）＝tests/t-poioverrides.mjs が同値を機械検証。
// ⚠再発火の封じ（t-poioverrides が突いた穴）：焼き込み後のタイルへ同じレコードを再適用すると、del/move が
// 「本来の対象は焼きで消えた/動いた」まま同名近傍（≤300m）の別施設を最近傍matchして誤爆しうる。
// → 焼きは applied（効いたrecのid）をマニフェスト baked に記録し、表示は未焼き分だけ適用する（§12.4）。
export const OVR_NAME = "poi/overrides.json";
export const OVR_MATCH_M = 300;
export function applyOverrides(recs: PoiRec[], ovrRecs: OvrRec[] | null | undefined, { withAdds = true, applied = null }: { withAdds?: boolean; applied?: number[] | null } = {}): PoiRec[] {
	const out = recs.map(r => ({ ...r }));
	for (const o of [...(ovrRecs || [])].sort((a, b) => a.id - b.id)) {
		if (o.op === "add") {
			// 焼きは withAdds=false＝addを焼かない（点の無いz14タイルへ焼くと「1点だけのタイル」で既存タイルを
			// 上書きする事故の柵。addは実行時フィードが常時適用＝見た目は常に正しい。タイル在庫と合流する焼きはv2）
			if (withAdds) { out.push({ ll: o.ll, name: o.n, type: o.t ?? TYPE.その他, rank: o.r ?? 120, src: packSrc(SRC.MANUAL, SRC.MANUAL), kana: "" }); applied?.push(o.id); }
			continue;
		}
		let bi = -1, bd = OVR_MATCH_M;
		for (let i = 0; i < out.length; i++) {
			if (out[i].name !== o.n) continue;
			const d = distM(out[i].ll, o.ll);
			if (d < bd) { bd = d; bi = i; }
		}
		if (bi < 0) continue;   // 対象なし＝対象外地域など＝no-op
		applied?.push(o.id);
		if (o.op === "del") out.splice(bi, 1);
		else if (o.op === "move") { out[bi].ll = o.to as number[]; out[bi].src = packSrc(SRC.MANUAL, out[bi].src & 0x0F); }   // 人が置いた位置＝権威（typeSrcは維持）
		else if (o.op === "rename") out[bi].name = o.to as string;
	}
	return out;
}

// ── タイル在庫マニフェスト poi/14/index.json＝{v, tiles:[], baked:[]} の正典（writer=uploader poi()・reader=ortho-japan）──
// v＝版（Date.now＝表示側 ?v= のキャッシュ失効）／tiles＝存在タイル一覧（404空振りゼロ）／baked＝焼き込み済み手差分id
//（表示は baked に無い rec だけ実行時適用＝上の⚠再発火封じの永続表現。タイルと同じ便で届く＝新旧が食い違わない）。
// 焼き便ごとに既存へ合流＝他地域を別便で焼いても消えない。
export const MANIFEST_NAME = "poi/14/index.json";
export interface PoiManifestJson { v: number; tiles: string[]; baked: number[] }
export function mergeManifest(prev: Partial<PoiManifestJson> | null | undefined, tileKeys: Iterable<string>, appliedIds?: number[] | null): PoiManifestJson {
	return {
		v: Date.now(),
		tiles: [...new Set([...(prev?.tiles || []), ...tileKeys])].sort(),
		baked: [...new Set([...(prev?.baked || []), ...(appliedIds || [])])].sort((a, b) => a - b),
	};
}

// タイル座標（z14）。バケツの poi/14/x/y 名に使う。
export const Z14 = 14;
export const tileXY = (lon: number, lat: number, z = Z14): [number, number] => [
	Math.floor((lon + 180) / 360 * 2 ** z),
	Math.floor((1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2 * 2 ** z),
];
// 注記(z16 MVT)のタイル内ローカル座標 → 経緯度（fetchMVT の geom.coords[0/1] と extent を渡す）
export const tileLocalLL = (x: number, y: number, px: number, py: number, extent: number, z = 16): [number, number] => {
	const wx = (x + px / extent) / 2 ** z, wy = (y + py / extent) / 2 ** z;
	const R2D = 180 / Math.PI;
	return [wx * 360 - 180, R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * wy))) - Math.PI / 2)];
};
