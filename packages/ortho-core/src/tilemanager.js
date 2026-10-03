// タイル・マネージャ：距離別LOD（近=高z/遠=低z、重なりなし）で可視タイルを選び、取得・生成・キャッシュ。
// buildScene で全選択タイルを style層ごとに1バッファへ結合（mixed-z, 共通原点に再ベース）。
// ラベルは近景（高z）タイルのみ＝遠方はテキスト無し。
import { fetchMVT, neededSourceLayers } from "./decode.js";
import { labelKey } from "./labelkey.js";
import { isPMTiles, fetchPMTiles } from "./pmtiles-src.js";
import { tileOutsideCoverage } from "./tile.js";
import { buildTilePayload } from "./tilepayload.js";   // 組み立て（drawlist・水域・ラベル・建物・実バイト）は tile worker と共通
import { mergeTiles } from "./scene.js";
import { selectLOD } from "./tilecover.js";

const keyOf = t => `${t.z}/${t.x}/${t.y}`;

// lodFloor＝{ minViewZoom, z }：ビューが minViewZoom 以上のとき詳細シーンの LOD 下限を z に強制。
// optbv の海（WA）は z8 タイルから全面収録＝z7 以下が混ざる遠景は海が紙色に抜ける。下限 z8 で敷けば
// 海の色がズーム段間で揃う（沖合の z8 タイルは全面WA一枚=50B級なので枚数が増えても実質タダ）。
// minZ＝タイルzの床（既定4＝bvmap の配信下限）。全球ソース（PMTiles等・z0から配信）を混ぜるアプリは 0 を渡す
// ＝ズームアウトで選抜・下地・毛布・祖先フォールバックが z0 まで降りる（既定4なら従来挙動と完全同一）。
// encoding＝タイルの形式（"mvt"｜"mlt"・文字列か () => 文字列・既定 mvt・#88）＝main で解く既定経路（defaultBuildTile）だけが読む（worker 経路は pipeline が init で運ぶ）
export function createTileManager({ style, tileUrl, onChange, cap = 256, buildTile, onEvict, lodFloor, memBudgetMB, coverage, minZ = 4, encoding = "mvt" }) {
	const cache = new Map();   // key → { status, origin, dl, labels, z, bytes, seen }
	// 常駐の実バイトの合計（set／delete のたびに足し引き＝毎 update で全キャッシュを数え直さない）。キャッシュの出し入れは下の put／drop だけを通す
	let totalBytes = 0;
	const put = (k, v) => { const o = cache.get(k); if (o) totalBytes -= o.bytes || 0; cache.set(k, v); totalBytes += v.bytes || 0; };
	const drop = k => { const o = cache.get(k); if (o) { totalBytes -= o.bytes || 0; cache.delete(k); } };

	// tess済み geometry の常駐量を「枚数」でなく「実バイト」で束ねる：z16密都市(~100KB級)と沖合z8(数十B)を
	// 同一に数えると枚数上限がメモリの代理にならない。予算は端末メモリで自動調整（navigator.deviceMemory=GB・
	// 上限8で頭打ち／Safari・FF は未提供＝4GB相当とみなす）。呼び出し側 memBudgetMB で明示上書き可。
	// geometry の実体は scene worker 側（main はメタのみ保持）＝この予算は onEvict 経由で鏡(scene worker)を縛る。
	const dm = (typeof navigator !== "undefined" && navigator.deviceMemory) || 4;
	const autoMB = Math.max(24, Math.min(96, dm * 12));   // 自動＝端末メモリで [24,96]MB（16GB機≒96 / 4GBタブ≒48 / 2GB≒24）
	const budgetBytes = (memBudgetMB || autoMB) * 1024 * 1024;   // memBudgetMB 明示時はそのまま（呼び出し側を信頼＝上限に丸めない）
	const hardCap = Math.max(cap, 4096);   // 極小タイル多数での Map 肥大だけ抑える二次ガード（バイト予算が主）
	let clock = 0;   // update 連番＝LRU の時刻（keep に入る度に更新＝「最近見えた」を保つ）

	// 既定：メインスレッドで fetch→decode→tessellation（重い）。buildTile 注入で worker へ退避できる。
	const need = neededSourceLayers(style);
	async function defaultBuildTile(t) {
		// 配信圏外は fetch を省き空タイル(=404と同じ全面水域)扱い＝外洋・国外への無駄な 404 を断つ（worker 経路 tileworker.js と同処置）
		const url = tileUrl(t.z, t.x, t.y);
		const layers = isPMTiles(url) ? await fetchPMTiles(url, t.z, t.x, t.y, undefined, need)   // 全球ソース（PMTiles）＝coverage 対象外
			: tileOutsideCoverage(t.x, t.y, t.z, coverage) ? { __empty: true } : await fetchMVT(url, undefined, need, null, null, (typeof encoding === "function" ? encoding() : encoding) || "mvt");
		return buildTilePayload(layers, t, style);   // 図郭外（404/図郭縁の WA スライバ）の標高ゲート付き全面水域も worker 経路と同じ処置
	}
	const build = buildTile || defaultBuildTile;

	async function ensure(t) {
		const k = keyOf(t);
		const ex = cache.get(k);
		if (ex && ex.status !== "error") return;   // loading/ready はそのまま
		const tries = ex ? (ex.tries || 0) : 0;
		if (tries >= 3) return;                     // 3回失敗＝諦める（本当に無いタイル等での永久リトライ回避）
		put(k, { status: "loading", tries });
		try {
			const r = await build(t);   // worker or main
			put(k, { status: "ready", ...r });
			onChange && onChange();
		} catch (e) {
			// abort（視野から外れて中断）はエントリごと消す＝再訪時に再取得できる。
			if (String(e && e.message) === "aborted") { drop(k); return; }
			// その他のエラー（ネット瞬断/デコード失敗）は "error" のまま残すと永久欠け＝そこだけ粗いタイルが透けて
			// 静止中もズーム混在になる。tries を数えてバックオフ再取得を促す（onChange→再update→ensure がリトライ）。
			put(k, { status: "error", origin: null, dl: null, labels: [], z: t.z, tries: tries + 1 });
			setTimeout(() => onChange && onChange(), 300 * (tries + 1));
		}
	}

	// keepFine（ズームアウトの書き直し回避）：選択タイルの枠を「常駐している最細の子孫」で隙間なく覆えるなら
	// その子孫集合を、覆えなければ ready な自身を返す（どちらも無ければ null＝従来どおり pending）。
	// 子孫優先＝ズームアウトで親が ready でも細かい絵を保つ。判断はキャッシュ照合 O(4^depth)＝マイクロ秒級で、
	// 集合が変わらなければ上位の merge シグネチャも変わらない＝MB級の再結合＋GPU再アップロードが丸ごと消える。
	function residentCover(z, x, y, depth) {
		if (depth > 0) {
			const kids = [];
			for (let i = 0; i < 4; i++) {
				const r = residentCover(z + 1, x * 2 + (i & 1), y * 2 + (i >> 1), depth - 1);
				if (!r) { kids.length = 0; break; }
				kids.push(...r);
			}
			if (kids.length) return kids;
		}
		const c = cache.get(`${z}/${x}/${y}`);
		return c && c.status === "ready" ? [{ z, x, y }] : null;
	}

	// 距離LODで可視タイルを選定→ロード。ready なタイル列 { key, origin, z } を返す。
	let stickySplit = null;   // 前回 update で分割された祖先ノード集合＝selectLOD のヒステリシス（境界の親⇔子振動を止める）
	let selMaxZ = 0;          // 直近 update の「選択レベル」の最細 z（keepFine の子孫代打を除いた素の選抜）＝labels の近景窓の基準
	let lod = null;           // 選抜の memo（update 冒頭の説明）
	function update(cam, W, H, opts) {
		clock++;
		const floorZ = lodFloor && cam.zoom >= lodFloor.minViewZoom ? lodFloor.z : 0;
		// tilePx＝分割閾（画面px）。静止時に小さく渡すと主層だけ一段細かく割れる＝近景ほど画面サイズが
		// 大きい＝真っ先に閾を越えて分割＝「手前のズームが上がる」。下地/毛布は据置（先端の空白埋めは粗いまま）。
		// 未指定(undefined)なら selectLOD 既定(560)＝移動中は従来通り重くしない。
		// zOf＝MapLibre の目盛りの地図（mlcover.mlTileZoomOf）＝主層の z を MapLibre と同じ規則で選ぶ（tilePx は使わない）。下地・毛布は従来どおり
		// groundR＝地形リフト球の半径（app が表示中の地形変位と同式で計算）。主層・下地・毛布の3経路とも
		// 同じ球で選抜する＝チルト×高標高地の「手前くさび欠け」をどの層にも作らない（草津1200m根治）。
		const groundR = opts?.groundR ?? 1;
		// 選抜の memo：カメラ・画面・選抜の入力が前回と同じなら 3 本の selectLOD（チルトで数 ms）を丸ごと省く（静止・再描画だけのフレーム）。
		// 主層は sticky（前回の分割）も読むが、結果 A の祖先集合 S(A) を sticky にして同じ入力で解き直しても A のまま（A で割った節は S(A) で閾が下がるだけ・
		// 割らなかった節は閾が上がるだけ・子が全部 cull の節は出力に出ない）＝同じ入力なら前回の結果そのもの（tests/tilemanager-lod.mjs）。
		// zOf は関数＝入力に数えられない＝key（mlTileZoomOf が付ける）の無い zOf の時は memo しない
		const zk = opts?.zOf ? opts.zOf.key : "";
		const ck = zk === undefined ? null : [cam.center[0], cam.center[1], cam.zoom, cam.pitch, cam.bearing, cam.fovy, cam.dpr, cam.centerAlt, W, H, floorZ, opts?.tilePx, groundR, opts?.maxZ, zk].join();
		const hit = ck !== null && lod && lod.key === ck;
		let selected;
		if (hit) selected = lod.selected;
		else {
			selected = selectLOD(cam, W, H, { sticky: stickySplit, floorZ, tilePx: opts?.tilePx ?? undefined, groundR, minZ, maxZ: opts?.maxZ ?? undefined, zOf: opts?.zOf ?? null });   // null/未指定→undefined＝selectLOD既定560（destructuring既定はundefinedでのみ発火・nullだと閾0で全分割の罠）。maxZ＝呼び出し側の上限（全球ビュー＝世界ソースの領分に留める）
			// 「分割されたノード」＝選択タイルの祖先チェーンそのもの。次回のヒステリシス判定に持ち越す。
			stickySplit = new Set();
			for (const t of selected) {
				let z = t.z, x = t.x, y = t.y;
				while (z > minZ) { z--; x >>= 1; y >>= 1; const k = `${z}/${x}/${y}`; if (stickySplit.has(k)) break; stickySplit.add(k); }
			}
			selMaxZ = 0; for (const t of selected) if (t.z > selMaxZ) selMaxZ = t.z;
		}
		// keepFine＝ズームアウトの書き直し回避：常駐子孫（keepFine 段まで）で隙間なく覆える枠は親に差し替えず
		// 子孫のまま描く＝描画キー集合が変わらない＝merge シグネチャ不変＝再結合ゼロ。親の ensure は従来どおり
		// 走る（下で ensure(selected)）＝子孫が LRU 予算で消えた象限だけ、その時点で用意済みの親へ一度で交代する。
		// 象限単位の再帰＝端の未訪問域は親のまま・訪問済みの中心だけ細かさが残る（全か無かにしない）。
		let drawSel = selected;
		if (opts?.keepFine) {
			drawSel = [];
			for (const t of selected) {
				const cov = residentCover(t.z, t.x, t.y, opts.keepFine);
				if (cov) drawSel.push(...cov); else drawSel.push(t);
			}
		}
		// 粗い下地：3段低いズームで広く覆う。移動中の先端の空白を常に埋める underlay。
		// lodFloor 有効時は下地も z8 で敷く（floorZ が強制分割・maxZ が上限開放）：z5-7 の下地は海（WA）を
		// 持たないため、移動中に下地が顔を出す瞬間だけ海が紙色に白転してちらつく（実害はまさに下地側だった）。
		// opts.maxZ＝呼び出し側の上限（全球ビュー＝世界ソースの領分 z≤3 に留める）は下地・毛布にも掛ける：
		// 主層だけ縛っても下地(z4)に optbv が混ざれば「日本固有はまだ出さない」ゲートが破れる。
		const capZ = z => opts?.maxZ != null ? Math.min(z, opts.maxZ) : z;
		const coarse = hit ? lod.coarse : selectLOD(cam, W, H, { maxZ: capZ(Math.max(floorZ || 4, minZ, Math.round(cam.zoom) - 4)), floorZ, groundR, minZ });   // -4＝主層(タイルz≈zoom-1)の3段下（256px世界の z はタイルzより1大きい）
		// 毛布：固定 z4 の床タイル＝フォールバックの終点保証。「zoom-6」の動く目標だと高速ズームアウト中に
		// 毎段コールドフェッチで間に合わず白が出る。z4 固定なら1枚で22.5°＝数枚で日本全体、初回以降キャッシュ常駐
		// ＝どんな引き方をしても床が必ず先に居る。W/H×3＝視野の3倍を先回り（外周の白露出も防ぐ）。
		// minZ<4（全球ソース混在）だけ低ズームで毛布の段も下げる：全球ビューで固定 z4 だと視野3倍が
		// 世界全体＝256枚 ensure の爆発。世界タイル（低z・軽量）は段が動いてもコールドフェッチ負けしない。
		const blanketZ = capZ(minZ < 4 ? Math.max(minZ, Math.min(4, Math.round(cam.zoom) - 2)) : 4);
		const blanket = hit ? lod.blanket : selectLOD(cam, W * 3, H * 3, { maxZ: blanketZ, groundR, minZ });
		lod = ck === null ? null : { key: ck, selected, coarse, blanket };
		const keep = new Set([...selected, ...drawSel, ...coarse, ...blanket].map(keyOf));   // drawSel（keepFine の子孫代打）も keep＝描画中の子孫を LRU に食わせない
		for (const t of blanket) ensure(t);
		for (const t of coarse) ensure(t);
		for (const t of selected) ensure(t);
		// 視野から外れた読込中タイルは fetch ごと中断（高速パンで帯域とworker CPUを空ける）。
		// エントリは ensure の catch("aborted") が消す＝パンで戻ってきたら普通に再取得される。
		if (build.abort) {
			for (const [k, c] of cache) if (c.status === "loading" && !keep.has(k)) build.abort(k);
		}
		// keep（今見えている／下地／毛布）は常に残す＝merge の穴を作らない。予算はそれを超えて「パンで戻った時に
		// 即出す」ための履歴分を束ねる。keep 外を LRU（最後に見えた update が古い順）で、バイト予算 かつ 枚数ガードを
		// 満たすまで退避。geometry の実体は scene worker＝ここで消せば onEvict で鏡が同時に縮む（知らせないと
		// 「main は ready・worker は破棄」の食い違いで merge が黙って穴になる。scene 側独自CAP退避で実際に起きた）。
		for (const k of keep) { const c = cache.get(k); if (c) c.seen = clock; }   // 「最近見えた」を更新＝LRUの新しさ
		let total = totalBytes;
		if (total > budgetBytes || cache.size > hardCap) {
			const cands = [];
			for (const [k, c] of cache) if (!keep.has(k)) cands.push(k);
			cands.sort((a, b) => (cache.get(a).seen || 0) - (cache.get(b).seen || 0));   // 古い(seen小)順＝先に捨てる
			const evicted = [];
			for (const k of cands) {
				if (total <= budgetBytes && cache.size <= hardCap) break;
				drop(k); total = totalBytes; evicted.push(k);
			}
			if (evicted.length && onEvict) onEvict(evicted);
		}
		const ready = arr => { const o = []; for (const t of arr) { const c = cache.get(keyOf(t)); if (c && c.status === "ready") o.push({ key: keyOf(t), origin: c.origin, z: t.z }); } return o; };
		// 下地は祖先フォールバック付き：ズームで下地の段(round(zoom)-4)が切り替わる度に新段が未着で
		// 紙色の空白がチラつくのを、キャッシュ済みの粗い親で埋めて防ぐ。粗い順＝下に描かれる。
		// フォールバックの床：opts.maxZ（全球ソースの領分に cap 中＝世界帯）は minZ まで降ろすが、
		// cap 無し（基図の領分 z≥6.5）は従来どおり z4 で止める＝世界タイル(z≤3・湖入り)が移動中だけ
		// 下地に顔を出し、静止で消える明滅を断つ（湖 drawing⇄drawn 明滅の根治 2026-08-31）。
		const fbFloor = opts?.maxZ != null ? minZ : Math.max(minZ, 4);
		const readyWithFallback = arr => {
			const o = [], seen = new Set();
			for (const t of arr) {
				let z = t.z, x = t.x, y = t.y;
				while (z >= fbFloor) {
					const k = `${z}/${x}/${y}`, c = cache.get(k);
					if (c && c.status === "ready") {
						if (!seen.has(k)) { seen.add(k); o.push({ key: k, origin: c.origin, z }); }
						break;
					}
					z--; x >>= 1; y >>= 1;
				}
			}
			return o.sort((a, b) => a.z - b.z);
		};
		// 毛布は祖先フォールバックの「保険」でなく下地mergeに直接混ぜる（z昇順ソートで一番下に敷かれる）
		// ＝ズームを引いた瞬間も画面全域に必ず一番粗い絵がある。真っ白は出ない。
		// covered＝「この視野を覆うために描くべき枠（keepFine の子孫代打後）」が全部 ready＝主層に穴が無いことが
		// 構造的に確定。app の render は これと merge 済み集合の一致で下地(base)の要否を厳密に判定する
		// （「移動中かどうか」という代理指標に頼らない）。sel＝その枠数（診断用）。total は従来どおり素の選抜数。
		const draw = ready(drawSel);
		return { order: draw, coarseOrder: readyWithFallback([...blanket, ...coarse]), total: selected.length, sel: drawSel.length, covered: draw.length === drawSel.length };
	}

	// order の全タイルの op を style層(li)ごとに結合。origin(=cam.center)へ再ベースして精度確保。
	// 結合の本体は scene.js の mergeTiles（scene worker と同じ純関数）＝旧＝ここに下敷きの線の伏せ（coveredTiles）と図郭外の水域の消灯（seaFbReal）を欠いた写しがあった
	function buildScene(order, opts = {}) {
		return mergeTiles(order, k => { const c = cache.get(k); return c && c.dl ? { ops: c.dl.ops, buildings: c.buildings } : null; }, opts);
	}

	// 近景（高z）タイルのラベルだけ結合＆重複排除。遠方（粗タイル）はテキスト無し。
	function labels(order) {
		if (!order.length) return [];
		const maxZ = Math.max(...order.map(o => o.z));
		// 近景窓の基準は「選択レベル」（selMaxZ）＝keepFine の子孫代打で order に混ざる高zに引きずられて
		// 窓が上がり、親のままの象限（選択レベル素のタイル）が無ラベル化するのを防ぐ。子孫は窓より上＝常に通る。
		const near = (selMaxZ || maxZ) - 2;    // 最細から2段以内＝近景
		const out = [], seen = new Set();
		for (const { key, z } of order) {
			if (z < near) continue;
			const c = cache.get(key);
			if (!c || c.status !== "ready") continue;
			for (const L of c.labels) {
				const dk = labelKey(L);   // tile worker が焼いた鍵（labelkey.js＝labels2d の当選集合と同じ式）。MapLibre 由来の層は層ごと（poi_transit が poi_r1 に消されていた・2026-09-28）・記号だけの注記は記号名で
				if (seen.has(dk)) continue; seen.add(dk); out.push(L);
			}
		}
		return out;
	}

	// 常駐 geometry の観測（メモリ確認用）：ready タイル枚数・実バイト・予算・端末メモリ推定。
	function stats() {
		let tiles = 0, bytes = 0;
		for (const c of cache.values()) if (c.status === "ready") { tiles++; bytes += c.bytes || 0; }
		return { tiles, bytes, budgetBytes, deviceMemoryGB: dm, cacheEntries: cache.size };
	}

	// restyle（配色テーマの生き替え）：全タイルを捨てる＝scene worker の鏡(geom/GPU常駐)も onEvict で同時に空へ。
	// 次の update() で可視タイルが新style（tile worker 側で差替済み）で再ビルドされる。stickySplit も捨てて、
	// 分割ヒステリシスが「もう無いタイル」を指さないようにする（clock=LRU時刻は単調のまま据置で無害）。
	function reset() {
		if (cache.size && onEvict) onEvict([...cache.keys()]);
		cache.clear(); totalBytes = 0; stickySplit = null; lod = null;
	}
	return { update, buildScene, labels, cache, stats, reset };
}
