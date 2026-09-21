// 建物 3D（PLATEAU）の管理＝表示判定・ヒステリシス・ロード順・取り消し・降格・常駐予算・追い出し・遠景の星座・先読み・
// 読込トースト・データ管理モーダル。app.js から動作を変えずに移し（2026-09-17 第一歩）、次いで env と戻り値を契約の形に整えた（第二歩）。
// 作法＝クラスも継承も作らない。登録簿（catalog）と除外マップはここが持つ。永続化の鍵（DECODE_VER / PLQ_VER / FAR_VER）はここに無い。
//
// env（生成時に渡す・3 束）：
//   meshOn                 … 機能スイッチ（opts.mesh=false［旧 opts.plateau］ / ?nopl=1）
//   device                    … 起動時に確定する装置の旗 { LOW_MEM, MID_TIER, HI_TIER, gpuBackend, hudOn, ELL_ON }
//   catalog                   … 登録簿の Promise<set[]>（null＝機能 OFF）。到着の裁き（合図・自動ロード）はここ
//   renderer, attachMeshPort  … 描画側：renderer.set(cmd,…)／区 worker→render worker のメッシュ直結ポートを渡す口
//   mapEl, dbgHost, emit      … 読込トーストの容れ物／デバッグ手（__farState/__meshPurge）の宿主／map.on("mesh") の合図
//   requestDraw()             … 描画要求（pipeline と同じ口）
//   cam, moving, flying, printHold, elevBusy … app の状態の覗き窓（getter＝毎回読む。cam は生成後に定義される）
//   footPoint()               … 画面下端中央の接地点 [lon,lat]|null（チルト時の「手前」＝選抜とタイル順の錨）
//   viewBbox(cam)             … 視野の粗い矩形（app の物差し＝POI と共有）
//   playingNow(), flyTo(...)  … 上映中判定／球面フライト（生成後に定義される＝app 側でラップ）
//
// 戻り値（契約）：
//   update(settled)           … 表示判定の一突き（onMove 毎・settle で true）
//   standUp(set)              … 特定区を今すぐ立てる（カメラは動かさない）→ Promise<bool>
//   prefetch(views, names, onProgress) … 台本の先読み（IDB へ）→ Promise<set[]>
//   trimForScript(views)      … 静穏窓の大掃除／firstRevealSets(views) … 開幕で立つ区の最小集合
//   setExcludeMap(map)        … 捨てる地物（起きている worker と後から起きる worker の両方へ）
//   setProgressTap(fn)        … 読込進捗の中継口（シーン再生の待ちパネル）
//   terminate()               … worker・デコーダ・見張りタイマーの後片付け（destroy）
//   sets / progress           … 登録簿（読み取り）／読込進捗 Map（読み取り）
//   isActive(name) / isDead(name) / visibleLoading() / memStats() … 上映の待ち判定と HUD の物差し
//   openDb()                  … データ管理モーダル
import { parseViewHash, wrapLon } from "@ortho-earth/core";
import { createMeshDb } from "../meshdb.js";
import { dockStack } from "../gadgets/stack.js";   // 左下ドック（読込トーストの容れ物）
import { tr } from "../i18n.js";
const t = tr();   // 英語キー＝t("…") がそのまま辞書のキー（i18n-scan が plateau/ も舐める）
const qNum = (re, def) => { const m = location.search.match(re); return m ? +m[1] : def; };   // ?paz= 等の調律ノブ（app.js と同形）

const D2R = Math.PI / 180;

export function createMeshManager(env) {
const { meshOn, device: { LOW_MEM, MID_TIER, HI_TIER, gpuBackend, hudOn, ELL_ON }, dbgHost, mapEl, renderer, attachMeshPort, emit, requestDraw, footPoint, viewBbox, playingNow, flyTo } = env;
let SETS = [];             // 登録簿（カタログ到着で確定。地域宣言の catalog＋地域が直書きする set）
let excludeMap = null;     // 捨てる地物（gml_id）＝起動後に来ても、後から起きる worker（遅延生成）にも配れるよう保持
// 登録簿の到着＝合図（map.on("mesh") catalog）と自動ロードの一突き（復元ビューが z15+ の街なら起動直後に立つ＝settled 扱い）。
// 取得の失敗は警告のみ＝待つ側（prefetch）は解決を待ってから空の登録簿を見て諦める。一突きは .catch の外＝表示判定の例外を
// 「catalog fetch failed」の皮を被せて飲まない（第二歩で foot の自己シャドウ TDZ がこの皮の下に隠れた轍・t-mesh が捕まえた）。
const catalogReady = Promise.resolve(env.catalog).then(sets => {
	if (!sets) return;   // 機能 OFF（catalog=null）
	SETS = sets; console.log(`[mesh] catalog loaded -> ${sets.length} municipalities`);
	emit({ phase: "catalog", count: sets.length });
}).catch(e => console.warn("[mesh] catalog fetch failed", e)).then(() => { if (SETS.length) autoMesh(true); });

const MESH_AUTO_Z = qNum(/[?&]paz=(\d+(?:\.\d+)?)/, 15);   // これ以上寄ると自動ロード（遠景は対象外＝ズームアウトで全解放）。?paz=16＝タイル最細(z≈16-17)までベクタ建物で粘るA/B実験ノブ（デモのz15.5フライトは15前提＝既定は据置）
// ズームアウトの保持：既に立っている区はズームアウトでは消さない＝「一回消えて基図建物で書き直す」没入切れ
// の根治（本人裁定2026-08-03「格段良くなった」＝全保持を既定化）。手放すのは遠方離脱（FAR_DEG）と真俯瞰だけ。
// 非表示は元々メモリを返さない（解放は遠方evictのみ＝常駐保持）ので保持のコストは頂点処理時間だけ
// → WebGPU×非LOW_MEM 限定（GL2/低メモリ端末は従来どおりズームアウトで即非表示）。新規ロード発火は従来どおり AUTO_Z 以上のみ。
// ?pazh=N＝保持を浅く戻す口（AUTO_Z−N で非表示・低ズームの頂点代が問題になった時の後退線。例 pazh=2）。
// ── 消灯線（本人裁定 2026-09-08「z 値が 14 以下になったら、潔く PLATEAU は出力しない」）：実メッシュの保持も遠景箱も z≤14 で消す。
// 保持（ヒステリシス）は AUTO_Z(15) との間の 1 段だけ＝ズームアウトで一度消えたら基図建物に任せる。?pazoff=N で線を動かせる（既定 14）。
const MESH_OFF_Z = qNum(/[?&]pazoff=(\d+(?:\.\d+)?)/, 14);
const MESH_HIDE_Z = (gpuBackend && !LOW_MEM) ? Math.max(MESH_OFF_Z + 1e-6, MESH_AUTO_Z - qNum(/[?&]pazh=(\d+(?:\.\d+)?)/, Infinity)) : MESH_AUTO_Z;   // +1e-6＝「14 以下」を < で表す
// ── 遠景far-DB＝「いつも描くDB」（本人裁定2026-08-04・閾値15m）：z15帯の建物の崖をPLATEAU抽出の軽量箱で埋める。
// 実体は meshworker（#far導出・プリズム生成）→ 既存plateauパイプに `${ward}#far` バッチで相乗り（マスク不参加）。
// 可用性＝一度でも完走焼きした区だけ＝訪れるほど遠景が育つ（ambient/データ重力と同思想）。WebGPU×非LOW_MEM限定。
const FAR_H = qNum(/[&?]farh=(\d+)/, 200);  // 高さ閾値(m)＝200m級＝真の超高層だけの星座（本人裁定2026-08-04夜「z14から+200m以上で少し綺麗にかつ軽く」・100m=都内~600棟から更に絞る）。
                                            // 15m案は都心区でほぼ全建物が通り数万箱＝メモリ爆上がりの轍→50m→実機比較で100に着地。?farh=Nで実験可
const FAR_Z = MESH_OFF_Z + 1e-6;         // 遠景箱の点灯下限ズーム＝消灯線と同じ（旧 14 固定＝本人裁定2026-08-04夜 13→14。9/8 に「z≤14 は PLATEAU 無し」へ統一）
const noFar = /[?&]nofar=1/.test(location.search);   // ?nofar=1＝遠景far-DB箱を完全に切る（刺さり/めり込みの切り分け用）
const farShown = new Set();                 // 要求済み/表示中の区（active化で退場→再要求可に戻す）
const farMissed = new Set();                // #far整備不能（完走焼き無し）＝farReadyが来るまで再要求しない
// far育成キュー：#far無し(farMiss)の区は、焼きがあれば worker のfarBakeで「読むだけ導出」。1区ずつ直列＝
// 視界いっぱいのfarMiss一斉発生でIDB/OPFS読みの山を作らない。育ったら farReady→autoFar が次のパスで点灯。
const farBakeQ = []; const farBakeTried = new Set(); let farBaking = null;
function farBakeNext() {
	if (farBaking || !farBakeQ.length) return;
	// 育成は暇な時だけ：v3/閾値移行の残務（区ごと全量読み直し）が復元・飛行と重なると、workerヒープの
	// 一時ゴミ高水位が段階的に積み上がる（本人実測「FlyToで+1GB→14.5GB」2026-08-04夜）。移動/飛行中は退いて再試行
	if (env.moving || env.flying) { setTimeout(farBakeNext, 3000); return; }
	farBaking = farBakeQ.shift();
	spawnMeshWorkers();
	meshWorkers[hashStr(farBaking.base) % MESH_NW].postMessage({ type: "farBake", base: farBaking.base, ward: farBaking.name });
}
dbgHost.__farState = () => ({ shown: [...farShown], missed: [...farMissed], baking: farBaking?.name ?? null, q: farBakeQ.length, tried: [...farBakeTried],
	active: [...meshActive.keys()], loading: [...meshLoading.keys()], resident: [...meshResident.keys()],
	failed: [...meshFailed].map(([n, f]) => `${n}${f.perm ? "(perm)" : `(${Math.max(0, MESH_RETRY_MS - performance.now() + f.ts) / 1000 | 0}s left)`}`),
	zoom: +env.cam.zoom.toFixed(2), pitch: +((env.cam.pitch || 0) * 180 / Math.PI).toFixed(1), farLit,
	// autoMesh のゲートと選抜の「今この瞬間」：flying/moving が真のままなら本体は凍結（ロードも退場も走らない）。
	// hits＝実ロード候補の順位（autoMesh と同じ 足元(foot)主キー・中心第2キー）。ここが期待どおりなのに
	// loading が空なら settle が来ていない＝ゲート側、が切り分けの読み方。
	flying: env.flying, moving: env.moving, printHold: env.printHold,
	hits: (() => {
		try {
			const view = viewBbox(env.cam);
			const foot = footPoint();
			if (foot) { view[0] = Math.min(view[0], foot[0]); view[1] = Math.min(view[1], foot[1]); view[2] = Math.max(view[2], foot[0]); view[3] = Math.max(view[3], foot[1]); }
			const pd2 = (s, p) => { const dx = Math.max(s.bbox[0] - p[0], 0, p[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - p[1], 0, p[1] - s.bbox[3]); return dx * dx + dy * dy; };
			return SETS.filter(s => !s.noMask && bboxIntersects(s.bbox, view) && !meshDead(s.name))
				.map(s => ({ n: s.name, d: +Math.sqrt(pd2(s, foot || env.cam.center)).toFixed(4) }))
				.sort((a, b) => a.d - b.d).slice(0, 8).map(h => `${h.n}:${h.d}`);
		} catch (e) { return ["ERR:" + (e.message || e)]; }
	})() });   // デバッグ：遠景枠の現在地＋本物側の状態機械＋カメラ＋ゲート＋選抜（箱残留の切り分けに一式）
// LOW_MEM（低メモリ端末判定）はファイル冒頭で定義（renderWorker init にも渡すため）。
if (LOW_MEM) console.log("[mesh] low-memory device mode: 2 concurrent wards, 1 worker, no cache");
// 同時アクティブ地区数の上限＝GPUメモリを有界にする（密集地区(都心部)1件あたりGPUバッファ~100-140MB）。
// デスクトップは4区（計~0.5GB＝余裕内）＝高チルトで「手前の区＋正面の区」を同時に立てる。
// 4はシェーダの被覆マスクスロット上限（glsl u_meshMask0..3・renderer MAX_MESH_MASKS）＝これ以上は基図建物を伏せられず二重に立つ。
const MESH_MAX_ACTIVE = qNum(/[?&]maxact=(\d+)/, LOW_MEM ? (gpuBackend ? 2 : 1) : (MID_TIER ? 2 : 4));   // LOW_MEM=2区（千代田⇄中央カタカタ根治）。worker切離し済＝増えるのは常駐のみ(+1区~100-140MB)・過渡はbldCap据置で不変。
                            // MID_TIER=2区＝内蔵GPU機はVRAMがシステムRAMの取り分＝4区(~0.5GB)が同じ財布から出る（Windows 16GB+HD の落ち・2026-08-03）
const MESH_DEC = Math.min(4, qNum(/[?&]dec=(\d+)/, HI_TIER ? ((navigator.hardwareConcurrency || 0) >= 16 ? 3 : 2) : 0));   // ②区内デコード並列プール本数（meshworker が同数の meshdecoder を lazy 起動）。HI_TIER限定＝バッチ過渡×本数の勘定が許せる機だけ。?dec=NでA/B・0=従来直列
                            // GL2フォールバック時のLOW_MEMは1区＝WebGPUの無い旧iOS(XR級3GB)の②常駐天井を守る安全モード（XS=4GBは2でも実証済みだが端末RAMはiOSから検出不能＝低い方に合わせる。?maxact=2 が戻し口）
// マスク無しセット（橋梁等 noMask:true）の同時数＝別枠。被覆マスクのシェーダスロット(4)を使わないので
// 建物4区の構図を奪わずに載る。橋梁データは区あたり数MB〜数十MB＝建物より一桁軽い。
const MESH_EXTRA_ACTIVE = LOW_MEM ? 1 : (MID_TIER ? 2 : 4);
// GPU常駐（再訪の再アップロード根絶）：視野から外れた区は「削除」でなく「非表示(meshVis)」＝VAOをVRAMに残す。
// 再訪は vis:true を送るだけ＝100MB級の slice→transfer→bufferData が丸ごと消える（ズームアウト→戻るがタダに）。
// 本当に削除するのは ①視野中心が区bboxから MESH_FAR_DEG 超離れた時（完全に離れた＝当分戻らない扱い）
// ②常駐予算超過のLRU。低メモリ端末は常駐なし＝従来どおり即削除（タブ強制終了対策を崩さない）。
// 上限は「区数」でなく「バイト」＝ackに同乗する実測メッシュバイトで数える。旧・区数8上限は橋梁も建物も同じ「1」と
// 数える上、テクスチャ付き都市は区あたり数百MB級＝区数では総量が読めない。GPUメモリOOM→context lost→自動リロード
// →GPU未復帰でwebgl2 probe null＝「表示できません」誤診の連鎖（M1 16GB実機で発生）を、総量の物差しで元から断つ。
// 実測（IDB #meta・都心notexture）：港141/新宿109/品川100/中央98MB…23区+川崎横浜の建物15セット計1.28GB。
const MESH_RESIDENT_BYTES = LOW_MEM ? 0 : (MID_TIER ? 0.5e9 : 1.2e9);   // 非表示常駐まで含めた総予算。表示中(最大4+橋4)は退避対象外＝予算超過でも守る
                                                      // MID_TIER=0.5GB＝内蔵GPUは常駐がシステムRAMを直に削る（1.2GBは独立VRAM/ユニファイド前提の値）
const MESH_BYTES_FALLBACK = 200e6;                 // ack未着/不明時の安全側見積り（notexture実測最大141MB・texture都市はより大の想定）。橋梁(noMask)は一桁軽い
const meshBytes = new Map();                       // name → メッシュ実バイト（workerのackに同乗。セッション中は不変なので消さない）
const bytesOf = (name, set) => meshBytes.get(name) ?? (set?.noMask ? 20e6 : MESH_BYTES_FALLBACK);
const residentBytes = () => [...meshResident].reduce((s, [n, st]) => s + bytesOf(n, st), 0);
const MESH_FAR_DEG = 0.5;                    // 本削除の距離閾値（deg≈55km）。都心の区巡り・近郊往復では誰も落ちない
const meshActive = new Map();           // 表示中の地区（renderer で vis=on）：name → set({name,base,bbox})
const meshResident = new Map();         // GPUにVAOが乗っている地区（表示中＋非表示）：name → set。Map挿入順＝LRU
const meshLoading = new Set();          // fetch/デコード中の地区名（二重発火防止）
const meshAutoLoading = new Map();      // autoMesh 発のロード中地区：name → set。視界確定時の退避対象（手動/プレロードは含めない）
const meshCancelling = new Set();       // 遠方離脱→キャンセル送信済みの地区名。bldCap から除外＋再訪は promote で即再開（un-cancel）。部分はIDBに残る
const meshDemoted = new Set();          // 近距離の視界外→slow lane（在庫化）中の地区名。完走して IDB＋非表示常駐へ＝さりげない仕込み。再訪は promote で fast 復帰
const meshFastT = new Map();            // name → fast レーン入場時刻。fast枠ローテーション（下）の物差し
const MESH_ROTATE_MS = 60e3;            // （旧）fast枠の占有タイムスライス＝待ち行列制（9/8）で不使用
// ── 同時ロード数と待ち行列（本人指定 2026-09-08「最大読み取り数は 3・後は待ち行列。スコープから外れたら途中までを保存して即座に打ち切り」）──
// R2 焼き（第三の入口）で 1 区が数秒になり、旧・slow レーン在庫化（視界外でも読み続ける）と fast 枠ローテーションは不要になった。
// 視界外＝即キャンセル（部分は worker が逐次 IDB/OPFS 保存済＝再訪は続きから）。枠待ちの区は「待ち行列」＝枠が空いた瞬間の
// autoMesh(true)（ロード完了/中止の finally）で優先順の先頭から着手。LOW_MEM は 2（GPU/タブ予算）。?loadmax=N
const MESH_LOAD_MAX = qNum(/[?&]loadmax=(\d+)/, LOW_MEM ? 2 : 3);
let meshQueued = [];                    // 待ち行列（表示用＝毎パス再導出・視界内で枠待ちの区名・優先順）
let meshPrefetchBusy = false;           // デモ先読みが直列デコード中＝autoMesh の建物枠を1つ譲る（総同時2区の保証）
// ロード失敗の台帳：perm=葉0枚（廃止区＝浜松西区22133等の残骸）＝恒久に掴まない／非perm=通信失敗（APIハング等の
// 一時障害）＝60秒バックオフ後に再挑戦（旧・Set＝一時障害もセッション永久追放で、真上に立っても本物が二度と
// 来ず遠景箱だけが残った＝渋谷/新宿 z15.9 実測 2026-08-11）。毎onMoveの再挑戦スパムはバックオフが断つ。
const meshFailed = new Map();           // 地区名 → { perm, ts }
const MESH_RETRY_MS = 60000;
const meshDead = name => { const f = meshFailed.get(name); return !!f && (f.perm || performance.now() - f.ts < MESH_RETRY_MS); };
let meshPinned = new Set();             // 台本 plateau: リスト記載の地区名＝視界内なら選抜キャップ無視で強制表示（デモ▶で設定・カタカタ根治）
let meshScriptOnly = null;              // 台本 preload 明示時の関所＝上映中（playingNow）はこの集合外の区の新規自動ロードを始めない
                                           //（Kenji裁定 2026-08-21：デモ観客の自機で経由地の無関係区＝世田谷等を拾い急に重くなる件。preload 無し＝視点導出の台本は絞らない）
function meshHide(name) {   // 視野外れ＝非表示（GPU常駐は維持）。常駐対象外（低メモリ端末）はそのまま削除
	if (meshResident.has(name)) renderer.set("meshVis", false, name);
	else renderer.set("meshSet", null, name);
}
function meshEvict(name) {  // 本削除＝GPUバッファ解放（遠方離脱/常駐上限超過だけがここへ来る）
	meshResident.delete(name);
	renderer.set("meshSet", null, name);   // freeMeshWard の prefix 一致で `名前#far` の遠景箱も同時に手放す
	farShown.delete(name);                     // 再訪時に autoFar が箱を再点灯できるように
}
function meshRetain(name, set) {   // 常駐登録＋LRU touch。予算超過は最古の非表示区から追い出す（表示中/読込中は守る）
	if (!MESH_RESIDENT_BYTES) return;
	meshResident.delete(name); meshResident.set(name, set);
	while (residentBytes() > MESH_RESIDENT_BYTES) {
		// n !== name＝いま touch した本人は守る（常駐ヒット経路は meshActive.set より先に retain が走る＝
		// activeガードだけだと「これから点灯する区」を自分で追い出し、消えたメッシュに vis:true を送る亡霊状態になる）
		const oldest = [...meshResident.keys()].find(n => n !== name && !meshActive.has(n) && !meshLoading.has(n));
		if (!oldest) break;   // 退避できるのは非表示だけ＝表示中だけで予算超過なら何もしない（構図は崩さない）
		meshEvict(oldest);
		console.log(`[mesh] resident budget -> evicted ${oldest} (left ${meshResident.size} wards ~${(residentBytes() / 1048576) | 0}MB / budget ${(MESH_RESIDENT_BYTES / 1048576) | 0}MB)`);
	}
}

// PLATEAU worker プール：tileset fetch・Draco解凍・ECEF変換・重複面dedup・RTE・被覆マスク、全部ここでやる（メインスレッドはブロックしない）。
// 密集地区(都心部)1件のデコードは実測40〜50秒かかる重い処理＝worker化しないとその間UIが完全に固まる。
// 非LOW_MEM は MESH_MAX_ACTIVE と同数だけ用意＝同時アクティブな複数地区が別コアで並行デコードできる。
// メッシュ本体（密集区で~160MB の typed array）は sceneChan と同じく worker→render worker の直結ポートで渡す。
// main 経由で postMessage すると transfer 無しの構造化クローン＝メインスレッドが数百msブロックされるため、main には ok/失敗の ack しか流さない。
// ⚠ LOW_MEM は worker 1本固定＝maxact と非連動。各 worker は loaders.gl(Draco wasm/3d-tiles) を丸ごと抱える＝起動ベースラインが重く、
// maxact=2 で 2本に増やすと PLATEAU 描画前（2D段階）にタブ予算を超えて落ちた（8GB実機で実測 2026-07-30）。
// bldCap=1 で同時デコードは1区ずつ＝worker 1本で maxact=2 の「表示2区」も順次達成できる（並行デコードは不要）。
// MID_TIER は 2本上限＝各 worker が loaders.gl(Draco wasm/3d-tiles) を丸ごと抱える起動ベースラインが、
// コールドの山にそのまま人数分加算されるため（8GB実機では 1→2 本でも 2D 段階で落ちた実測＝上のコメント）。
const MESH_NW = LOW_MEM ? 1 : (Math.min(MID_TIER ? 2 : MESH_MAX_ACTIVE, (navigator.hardwareConcurrency || 4) - 1) || 1);
const meshWorkers = [], meshDecoders = [], meshPending = new Map();   // meshDecoders＝区 worker 配下のデコーダ（main が生成・所有）
const MESH_BAKE_URL = (location.search.match(/[?&]bake=([^&]+)/) || [])[1] ? decodeURIComponent(location.search.match(/[?&]bake=([^&]+)/)[1]) : null;   // ?bake=URL＝R2 焼きの置き場差し替え（ローカル検証）・既定は worker 側の api.ortho-earth.com
const meshMemW = [];   // ?hud=1（旧mem=1）：worker index → {cache, live}＝HUD の「過渡」行（常駐台帳に乗らないRAM）
let meshReqId = 0;
let meshCamSent = 0;   // カメラ放送のスロットル（ロード中のみ~4Hz）
// PLATEAU worker プールは初回必要時に起こす（処方②・ortho-earth#12・2026-09-14）。旧＝起動時に MESH_NW 本を無条件生成＝
// z4 の初期ロードで worker 起動＋IDB/OPFS open＋init が人数分走っていた。今は autoMesh の暖機（z≥AUTO_Z−2 でチルト）か
// 最初の要求（ロード／遠景／IDB 管理／焼き）で立てる。plateau OFF＝1 本も起こさない（従来どおり）。
function spawnMeshWorkers() {
	if (meshWorkers.length || !meshOn) return;
	for (let i = 0; i < MESH_NW; i++) {
	const w = new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "mesh" });
	const meshChan = new MessageChannel();   // この worker → render worker のメッシュ直結パイプ
	// ②区内デコード並列プール（MESH_DEC 本／区 worker）は **main が生成して MessagePort で渡す**。旧＝区 worker が入れ子で
	// new Worker していたが、入口 1 本化（worker.js・name で役割指名）後は vite が入れ子生成を new Worker(self.location.href,…) に
	// 書き換え、環境によって子が一度も走らず（in-app 3/3・headless 稀）ライブデコードが永久 STALL した（2026-09-14 実測）。
	// worker の所有者を main に一本化＝入れ子 worker を使わない。デコーダは区 worker と同時に起きる（遅延生成の暖機に乗る）。
	const decPorts = [];
	for (let k = 0; k < MESH_DEC; k++) {
		const d = new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "meshdecoder" });
		const ch = new MessageChannel();
		d.postMessage({ init: { port: ch.port1 } }, [ch.port1]);   // 以後の会話（init/exclude/job/tick）は全部この port で区 worker と直結
		meshDecoders.push(d); decPorts.push(ch.port2);
	}
	w.postMessage({ type: "init", meshPort: meshChan.port1, decPorts, lowMem: LOW_MEM, mid: MID_TIER, hi: HI_TIER, dec: MESH_DEC, mem: hudOn, noOpfs: /[?&]noopfs=1/.test(location.search), farH: FAR_H, ell: ELL_ON, noBake: /[?&]nobake=1/.test(location.search), bakeUrl: MESH_BAKE_URL }, [meshChan.port1, ...decPorts]);   // noBake/bakeUrl＝R2 焼き（第三の入口）の封印/置き場差し替え   // ?noopfs=1＝バッチ本体のOPFS置きを無効化（従来IDB）＝A/B・切り分け用。farH＝遠景far-DBの高さ閾値
	attachMeshPort(meshChan.port2);   // render worker へ直結ポートを渡す（transfer は app 側）
	w.onmessage = e => {
		if (e.data.prog) { const p = e.data.prog; const old = meshProg.get(p.name); if (old?.stall && (old.done ?? -1) === (p.done ?? -2)) p.stall = old.stall; meshProg.set(p.name, p); renderMeshProg(); return; }   // タイル/走査進捗（ネットワーク経路のみ）。停滞印は進捗が動くまで残す
		if (e.data.type === "stall") {   // worker の見張り（30s 無進捗）＝トーストに ⚠ 理由を出し、60s 超で一度だけ打ち切り→再要求（partial から続き）
			const n = e.data.name, p = meshProg.get(n) || { name: n };
			p.stall = e.data.info; meshProg.set(n, p); renderMeshProg();
			console.warn("[mesh] stall reported", n, e.data.info);
			const s = meshAutoLoading.get(n);
			if (s && !meshCancelling.has(n) && !meshRestarted.has(n) && /\b(6\d|[7-9]\d|\d{3,})s\b/.test(e.data.info)) {
				meshRestarted.add(n);
				meshWorkers[hashStr(s.base) % MESH_NW].postMessage({ type: "cancel", base: s.base });
				meshCancelling.add(n);
				console.warn("[mesh] watchdog: cancel & re-request (partial resume)", n);
			}
			return;
		}
		if (e.data.farMiss) {   // #far無し：焼きがあるかもしれない＝一度だけ育成を試す（perm=完走焼き無し＝実ロード完走待ち）
			const n = e.data.farMiss.name;
			farShown.delete(n); farMissed.add(n);   // 育成中/不能の間は再要求を止める（解除は farReady）
			if (farBaking?.name === n) { farBaking = null; setTimeout(farBakeNext, 3000); }   // 育成失敗の返信＝間を置いて次の区へ（連打で churn の山を作らない）
			const s = !e.data.farMiss.perm && !farBakeTried.has(n) && SETS.find(x => x.name === n);
			if (s) { farBakeTried.add(n); farBakeQ.push({ base: s.base, name: n }); farBakeNext(); }
			return;
		}
		if (e.data.farSent) {   // 箱の実送達通知：退場と競争して負けた（遅着した）箱をここで検分して即退場させる。
			// 正常系＝farShown に居て本物も来ていない→何もしない。競争系＝退場済み（farShown に無い）or
			// 本物が立つ/来る区→空メッシュで即消し（autoFar の退場と同じ所作・冪等）。
			const n = e.data.farSent.name;
			if (!farShown.has(n) || meshActive.has(n) || meshLoading.has(n)) {
				renderer.set("meshSet", { pos: new Float32Array(0), nrm: new Int8Array(0), idx: new Uint32Array(0) }, n + "#far");
				farShown.delete(n);
				requestDraw();
			}
			return;
		}
		if (e.data.farReady) {   // #farが育った（完走保存/育成どちらでも）＝点灯可
			farMissed.delete(e.data.farReady.name);
			if (farBaking?.name === e.data.farReady.name) { farBaking = null; setTimeout(farBakeNext, 3000); }   // 間隔つき＝残務を静かに消化
			if (!env.moving && !env.flying) autoMesh(true);   // 静止シーンでも即点灯（onMoveが来ない＝この一突きが無いと次のカメラ操作まで立たない）
			return;
		}
		if (e.data.type === "idbList") { meshListPending.shift()?.(e.data.items); return; }              // データ管理モーダルの一覧応答
		if (e.data.type === "idbDeleted") { meshDeletePending.get(e.data.base)?.(e.data.n); meshDeletePending.delete(e.data.base); return; }
		if (e.data.type === "membytes") { meshMemW[i] = e.data; return; }   // ?hud=1：この worker の過渡（内部cache＋ロード中の保持）バイト
		const p = meshPending.get(e.data.id); if (!p) return; meshPending.delete(e.data.id);
		if (p.name) { meshProg.delete(p.name); renderMeshProg(); }   // 完了/失敗どちらでも ack で消灯＝消し忘れが無い
		if (e.data.bytes && p.name) meshBytes.set(p.name, e.data.bytes);   // 実測メッシュバイト＝常駐バイト予算LRUの物差し
		if (e.data.error) p.reject(new Error(e.data.error));
		else p.resolve(e.data.ok);   // ok=false は0三角形など soft failure（worker側でconsole.error済み）。メッシュ本体は直結ポートで render worker へ送付済み
	};
	meshWorkers.push(w);
	if (excludeMap) w.postMessage({ type: "exclude", map: excludeMap });   // 起動前に届いていた除外マップを配る
	}
}
// base URL のハッシュで固定の worker へルーティング＝同じ地区は毎回同じ worker が受ける→worker内蔵cacheが再訪で効く。
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; }
// デバッグ用：PLATEAUのメモリ/IDBキャッシュ全消去（デコード形式が壊れた疑いがある時に）。通常はFMT_VERが自動無効化する。
dbgHost.__meshPurge = () => {
	meshWorkers.forEach(w => w.postMessage({ type: "purge" }));
	for (const n of [...meshResident.keys()]) if (!meshActive.has(n)) meshEvict(n);   // GPU常駐も非表示分は解放（表示中は残す）
};
// タイル読み順の錨＝「目の前」。真俯瞰は注視点（center）だが、チルト時は画面下端の接地点（foot）＝
// 正射投影では画面下半分が数kmぶんの手前地面を占め、注視点中心のリング順だと**画面の主役（足元の街）が
// 最後に立つ**（飯山 z15.75/63t 実測 2026-08-03「手前に何もない」）。区の選抜（autoMesh の foot 優先）と
// 同じ作法を、区内タイルのソート（meshworker への camCenter／cam 放送）にも通す。foot が球外なら center。
function meshSortAnchor() {
	const foot = footPoint();
	return foot ? [wrapLon(foot[0]), foot[1]] : [env.cam.center[0], env.cam.center[1]];
}
function workerLoadMesh(base, tiles, name, wardBbox, brid, ex = {}) {
	spawnMeshWorkers();
	const id = ++meshReqId, w = meshWorkers[hashStr(base) % MESH_NW];
	// wardBbox＝区単位の被覆マスク座標系。camCenter＝バッチのカメラ近傍優先ソート（目の前から立ち始める）。
	// brid＝橋梁モード：バッチ接地（桁が海面へ沈まない）＋両面描画（ケーブル等の開いた薄面が裏から消えない）。
	// clip/tilesetUrl＝登録簿の任意欄（オランダ3DBAG等の「国土1枚もの」を街の矩形で切って使うため。PLATEAUは共に undefined）
	w.postMessage({ id, base, tiles, name, wardBbox, brid: !!brid, camCenter: meshSortAnchor(), clip: ex.clip || null, tilesetUrl: ex.tilesetUrl || null });
	return new Promise((resolve, reject) => meshPending.set(id, { resolve, reject, name }));   // name＝進捗の消灯キー
}
// PLATEAU 読込進捗（左下）：地区別のバッチ進捗を1行に集計。ネットワーク経路（初回訪問）だけ表示され、
// メモリ/IDBキャッシュ命中時は一瞬で終わるので出ない。消灯は ack（完了/失敗）で行う。
const meshEl = document.createElement("div");
meshEl.id = "plateau-toast";   // スタイルは quiet-mono。左下ドック＝elev-toast の上へ積まれる
dockStack(mapEl).append(meshEl);
const meshProg = new Map();   // name → { scan } | { done, total }（scan＝カタログ走査中の枚数）
let sceneProgTap = null;   // シーン再生(waitLoading)の進捗パネルへの中継口＝待機中だけ playScene が配線（宣言は使用点 renderMeshProg より先＝初期化中の worker 便で TDZ を踏まない）
// 市区町村ごとに 1 行＝名前・プログレスバー・枚数（本人指定 9/8）。待ち行列の区は「待機」行（バー空）。
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
function renderMeshProg() {
	const rows = [];
	for (const p of meshProg.values()) {
		const pct = p.total ? Math.min(100, Math.round(p.done / p.total * 100)) : 0;
		rows.push(`<div class="pl-row${p.stall ? " pl-stall" : ""}"><span class="pl-name">${escHtml(p.name)}</span><span class="pl-bar"><i style="width:${pct}%"></i></span><span class="pl-n">${p.total ? `${p.done}/${p.total}` : t("scanning")}</span></div>${p.stall ? `<div class="pl-why">⚠ ${escHtml(p.stall)}</div>` : ""}`);
	}
	for (const n of meshQueued) if (!meshProg.has(n)) rows.push(`<div class="pl-row pl-wait"><span class="pl-name">${escHtml(n)}</span><span class="pl-bar"></span><span class="pl-n">${t("queued")}</span></div>`);
	if (!rows.length) meshEl.style.display = "none";
	else { meshEl.innerHTML = `<div class="pl-head">${t("🏙 Loading 3D buildings")}</div>` + rows.join(""); meshEl.style.display = "block"; }
	meshDb.onProg(meshProg);   // データ管理モーダルにも同じ進捗を流す（開いていなければ即return）
	sceneProgTap?.();   // シーン再生の読み込み待ちパネルにも同じ進捗を流す（waitLoading 中だけ配線・未設定なら無音）
}
// --- 建物3D（PLATEAU）データ管理モーダル：カタログ×IDB。worker 配線だけ渡し、DOMはモジュール側が組む。
const meshListPending = [];        // idbList 応答待ち（FIFO。IDBは全workerで共有＝worker0固定で聞く）
const meshDeletePending = new Map();   // base → resolver（削除は base ルーティング＝メモリキャッシュの持ち主に届く）
const meshIdbList = () => new Promise(res => { spawnMeshWorkers(); meshListPending.push(res); meshWorkers[0].postMessage({ type: "idbList" }); });
const meshIdbDelete = base => new Promise(res => { spawnMeshWorkers(); meshDeletePending.set(base, res); meshWorkers[hashStr(base) % MESH_NW].postMessage({ type: "idbDelete", base }); })
	.then(n => {   // GPU常駐コピーも道連れ（表示中は従来どおり残す）＝「削除」した区が常駐ヒットで蘇らないように
		const name = [...meshResident.entries()].find(([, s]) => s.base === base)?.[0];
		if (name && !meshActive.has(name)) meshEvict(name);
		return n;
	});
// デモ台本のPLATEAU先読み：z14+で着地するシーンの足元の区を台本から自動導出し、IDBへ静かに仕込む（描画へは送らない）。
// 台本の早いシーン（球・列島・スライド）の間に裏で完走→PLATEAUシーンに着いた時はIDB直読み＝初見のPCでも一発で街が立つ。
// 直列1区ずつ＝訪問者の帯域を占有しない（飛行中の基図タイルと取り合わない）。IDB命中は即成功＝二度目からはタダ。
async function prefetchMeshForViews(views, names, onProgress) {
	if (!meshOn) return [];
	// 【▶の瞬間から走る】旧・LOW_MEM は boot+45秒遅延（鉄道地図z14.5タイルとデコードが重なる jetsam 対策）
	// だったが、テーマ切替（c=）の各ページは十数秒で reload されタイマーごと消える＝iPhone では実質
	// 「最後の reload+45秒後」まで先読みが始まらず、重要シーンに間に合わなかった。遅延は撤去。
	// reload で切れても meshworker の部分再開が続きから＝reload 毎の切れ端も貯金になる。
	// names＝台本（scenes.js の plateau:）の明示リスト（優先順）。指定があれば導出は使わない＝決定的。
	await catalogReady;
	if (!SETS.length) return [];
	if (names?.length) {
		const bad = [];
		const wanted = names
			.map(n => { const s = SETS.find(x => x.name === n); if (!s) bad.push(n); return s; })
			.filter(s => s && !meshDead(s.name));
		if (bad.length) console.warn("[demo] plateau names not in catalog (script typo?):", bad.join(", "));
		// ピン留め＝リスト記載の区は autoMesh の選抜キャップを無視して強制表示（デモ終了後もセッション中は有効）
		meshPinned = new Set(wanted.map(s => s.name));
		meshScriptOnly = meshPinned;   // preload 明示＝上映中はこの集合が自動ロードの全て（関所は playingNow 中だけ効く＝終演で自然解除）
		return runPrefetch(wanted, "scripted", onProgress);
	}
	meshScriptOnly = null;   // preload 無指定＝関所なし（前の台本の集合を持ち越さない＝台本の持ち物の掟）
	return runPrefetch(deriveScriptSets(views), "derived from views", onProgress);
}
// 台本の視点列→PLATEAU区集合の導出（2026-08-12 関数化＝先読みと静穏窓の大掃除で共用）。
// 【順序＝一巡目に「各停止位置の中心区＋橋梁」】旧・台本順に停止位置ごと全区を流すと、序盤の停止位置の
// 隣接区で時間を使い切り後半の停止位置は素通しになる（iPhone のデモ実測＝重要シーンほど出ない）。
// 一巡目＝各停止位置の最寄り建物1区＋橋梁（サイズ一桁小さい割にシーンの主役＝レインボーブリッジ等。
// Kenji 指定 2026-07-29）→二巡目＝「視線の先に居る」隣接建物区だけ。
// 隣接区の要否は距離でなく構図＝チルト時は視界が bearing 方向へ伸びる。前方点（中心から視線方向へ
// ~900m）への近さで裁く＝東京駅シーン(東向き)の中央区(八重洲)は入り、新宿シーン(北東向き)の南隣・
// 渋谷区（大区＝読むのに時間がかかる割に構図外）は落ちる（Kenji 指摘 2026-07-29）。
// 中断は meshworker の部分再開が貯金に変える＝テーマ切替 reload で切れても続きから。
function deriveScriptSets(views) {
	const MARGIN = 0.012;   // 区bboxへの点距離ゲート（≈1.3km）＝着地視界＋隣接区まで拾う
	const NEIGH = 0.008;    // 隣接区の前方点ゲート（≈900m）。MARGIN より狭い＝構図に実際入る近さだけ
	const perView = [];
	for (const hash of views) {
		const v = typeof hash === "string" ? parseViewHash(hash) : null;
		if (!v || v.zoom < MESH_AUTO_Z) continue;
		const p = [wrapLon(v.lon), v.lat];
		// 前方点＝チルト構図（pitch>20°）だけ視線方向へ押し出す（autoMesh の foot と対の「奥」判定）
		const fwd = v.pitch > 0.35
			? [p[0] + Math.sin(v.bearing) * NEIGH / Math.max(0.2, Math.cos(v.lat * D2R)), p[1] + Math.cos(v.bearing) * NEIGH]
			: p;
		const pd2 = (s, q) => { const dx = Math.max(s.bbox[0] - q[0], 0, q[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - q[1], 0, q[1] - s.bbox[3]); return dx * dx + dy * dy; };
		// 同点タイブレーク＝重心距離（autoMesh の near と同じ規約）。bbox は矩形＝密集地では複数区の
		// bbox が停止点を含み pd2=0 の同点になり、旧・カタログ配列順の成り行きで
		// 東京駅→港区／スカイツリー→荒川区／新宿→渋谷区 と「主役でない区」を先読みしていた
		//（＝正しい区はシーン到着後にゼロから読む二重読み＝iPhone クラッシュ圧の正体。実カタログで再現確認済み）。
		const c2 = s => { const cx = (s.bbox[0] + s.bbox[2]) / 2, cy = (s.bbox[1] + s.bbox[3]) / 2; return (cx - p[0]) ** 2 + (cy - p[1]) ** 2; };
		const near = SETS.filter(s => !meshDead(s.name) && pd2(s, p) < MARGIN * MARGIN)
			.sort((a, b) => (pd2(a, p) - pd2(b, p)) || (c2(a) - c2(b)));
		// 建物枠＋橋梁(noMask)別枠＝autoMesh の選抜と同じ構成＝着地時に立つ区を過不足なく仕込む
		perView.push({
			bld:  near.filter(s => !s.noMask).slice(0, MESH_MAX_ACTIVE),
			brid: near.filter(s => s.noMask).slice(0, MESH_EXTRA_ACTIVE),
			fwd,
		});
	}
	const wanted = [], seen = new Set();
	const take = s => { if (s && !seen.has(s.name)) { seen.add(s.name); wanted.push(s); } };
	const pd2q = (s, q) => { const dx = Math.max(s.bbox[0] - q[0], 0, q[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - q[1], 0, q[1] - s.bbox[3]); return dx * dx + dy * dy; };
	for (const v of perView) { take(v.bld[0]); v.brid.forEach(take); }          // 一巡目＝各停止位置の中心区＋橋梁（軽くて主役）
	for (const v of perView) v.bld.slice(1).filter(s => pd2q(s, v.fwd) < NEIGH * NEIGH).forEach(take);   // 二巡目＝視線の先の隣接区だけ
	return wanted;
}
// 静穏窓の大掃除（裁定2026-08-12「書き終わった後の静かな時間を活用」）＝自動上演の各行で書き終わりゲートが
// 開いた瞬間（hold開始＝飛行も読み込みも静か）に demo が呼ぶ（onQuiet 注入・行ごと1回）。
// 「残りの台本にもう出ない」非表示常駐区を GPU から降ろす＝台本知の特権（通常運転の LRU は未来を知らない）。
// 表示中・読込中・現在視界と交差する区は触らない（構図と直後の回り込みを崩さない）。LOW_MEM は常駐ゼロ＝素通り。
function meshTrimForScript(views) {
	if (!meshResident.size) return;
	const keep = new Set(deriveScriptSets(views).map(s => s.name));
	let freed = 0;
	for (const n of [...meshResident.keys()]) {
		if (keep.has(n) || meshActive.has(n) || meshLoading.has(n)) continue;
		const s = meshResident.get(n);
		if (s?.bbox && bboxIntersects(s.bbox, viewBbox(env.cam))) continue;
		freed += bytesOf(n, s); meshEvict(n);
	}
	if (freed) console.log(`[mesh] quiet-window cleanup = evicted residents absent from remaining script ~${(freed / 1048576) | 0}MB (left ${meshResident.size} wards ~${(residentBytes() / 1048576) | 0}MB)`);
}
async function runPrefetch(wanted, how, onProgress) {   // 戻り値＝対象区リスト（scene 再生のリビール準備＝全区スタンドアップが使う）
	if (!wanted.length) return wanted;
	console.log(`[demo] PLATEAU prefetch ${wanted.length} wards (${how}): ${wanted.map(s => s.name).join(", ")}`);
	meshPrefetchBusy = true;   // 先読み中＝autoMesh の建物枠を1つ譲る（デコード同時数の総枠を保つ）
	let done = 0; onProgress?.(0, wanted.length, null);   // 進捗＝総区数を先に伝える（waitLoading の中央表示用）
	try {
		// 並行2区（Kenji 指定 2026-07-29「2つずつぐらい読まないと間に合わない」）。直列1区は帯域を
		// 使い切れず（fetch レイテンシの谷）、東京駅到着までに主役区が揃わなかった。到着済みの区は
		// autoMesh がIDB直読みで立てる。base ハッシュの worker 固定ルーティングは並行でも維持される。
		// 【本番最優先】①可視の自動ロード（PLATEAUシーンで今まさに立てている区）②標高タイル読込
		//（elevBusy＝地形シーンの起伏。iPhone13実測：▶直後から全速の先読みが富士山〜阿蘇帯で標高タイルと
		// 帯域/IDBを取り合い「標高が表示されない」）——のどちらかが走っている間は次の先読みを始めない＝
		// 帯域・Dracoデコード・IDB書き込みを全部シーンへ明け渡す。キャンセル中/在庫slow中の区は待たない＝背景同士。
		// 既に走っている先読みは中断しない（多くは同区で inflight 合流する）。
		// flying/moving も柵に加える（2026-08-04）：飛行中は terrainGate が標高 ensure を止めるので elevBusy=false
		// ＝旧柵では「飛行中こそ先読みが全力で回る」だった。着地の瞬間は R01 近傍9枚（生Int16 26MB級×並列）＋
		// R10 窓のデコードバーストが来る＝そこへ Draco デコードが重なるのが 3GB 機（iPad Air3）の飛行中 jetsam の型。
		// 飛行は数秒＝先読みの遅れは誤差（走行中の先読みは中断しない＝止めるのは「次の区の開始」だけ）。
		// 【9/8 緩和】R2 焼きで先読みは Draco 無し・数 MB＝飛行/移動/標高読込を柵にしない（行送りゲート 6s 化でデモはほぼ常に
		// 飛行か標高読込＝旧柵では先読みが一度も回らず「先読みが全く無くなった」本人報告）。譲るのは可視区のロード中だけ。
		// LOW_MEM は標高タイル（R01 近傍 9 枚のデコードバースト）との帯域/IDB 取り合いを避けて elevBusy も待つ。
		const visibleBusy = () => (LOW_MEM && env.elevBusy) || [...meshAutoLoading.keys()].some(n => !meshCancelling.has(n) && !meshDemoted.has(n));
		let wi = 0;
		const pump = async () => {
			for (;;) {
				while (visibleBusy()) await new Promise(r => setTimeout(r, 1000));
				const s = wanted[wi++];
				if (!s) return;
				await meshPreload(s);
				onProgress?.(++done, wanted.length, s.name);   // 1区 IDB へ焼けた＝進捗を1つ進める
				autoMesh(true);   // 先読み完了の瞬間に表示判定を一突き＝「先読み中にもう着いていた」際、静止したままでも即立つ（読込中ガードで見送られた分の敗者復活）
			}
		};
		await Promise.all([pump(), pump()]);
	} finally { meshPrefetchBusy = false; autoMesh(true); }   // 先読み終了＝譲っていた枠を返して再選抜
	return wanted;
}
function meshPreload(set) {   // プレロード＝IDBに貯めるだけ（描画へ送らない）。表示中/読込中の地区はそのまま成功扱い
	if (meshLoading.has(set.name) || meshActive.has(set.name)) return Promise.resolve(true);
	meshLoading.add(set.name);
	spawnMeshWorkers();
	const id = ++meshReqId, w = meshWorkers[hashStr(set.base) % MESH_NW];
	// レーンは fast のまま（lowMem も）。slow（並行1本＋250ms間隔）を一度試したが、港区級（数百タイル）が
	// デモ1周かかっても終わらない実測＝「故意に遅い」。lowMem の jetsam 余裕は BATCH_TILES=16・並行4・
	// CACHE_MAX=0・クレジット送出で既に取ってある＝先読みは普通の速度で焼き、直列1区が帯域の上限を裁く。
	w.postMessage({ id, base: set.base, name: set.name, wardBbox: set.noMask ? null : set.bbox, brid: !!set.noMask, camCenter: meshSortAnchor(), preload: true, clip: set.clip || null, tilesetUrl: set.tilesetUrl || null });
	return new Promise((resolve, reject) => meshPending.set(id, { resolve, reject, name: set.name }))
		.catch(() => false).finally(() => meshLoading.delete(set.name));
}
const meshDb = createMeshDb({
	getSets: () => SETS, idbList: meshIdbList, idbDelete: meshIdbDelete, preload: meshPreload,
	// 描画＝モーダルを閉じて地区中心へ球面フライト（z15.5=PLATEAU自動ロード圏・チルト45°）→ autoMesh がキャッシュ命中で即表示
	show: set => { meshDb.close(); flyTo((set.bbox[0] + set.bbox[2]) / 2, (set.bbox[1] + set.bbox[3]) / 2, 15.5, 45); },
});
// モーダルを開くボタンはオプトインガジェット（gadgets/plateau.js）＝末尾の map.gadget("plateau", …) で open を注入。
// ストレージの永続化を要求＝ディスク逼迫時にブラウザ都合でオリジンごと退避されるのを防ぐ（デモ機の仕込み保護）。
// persist() は window 限定 API。Chrome はエンゲージメント次第で無言許可、拒否でも動作は変わらない。
if (meshOn) navigator.storage?.persist?.().then(ok => console.log(`[mesh] storage persist: ${ok ? "granted" : "denied"}`)).catch(() => {});

const bboxIntersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// 現在地＋ズームで登録簿を引き、視野に重なる地区を全部ロード／外れた地区は解放。区境をまたぐと複数地区が同時アクティブになる（上限 MESH_MAX_ACTIVE）。
// onMove から毎回呼ぶがガードで実質タダ。
// settled＝「視界が落ち着いた」（onMove の settle タイマー発火）。ロードの意思決定はこの瞬間だけ：
// - 新規ネットワークロードは settled 時のみ発火＝パンで通過しただけの区はそもそも読み始めない
// - settled 時に現地点が未ロードなら優先度MAX＝視界に居ない在庫ロードを全キャンセルし帯域/CPUを明け渡す
//   （現地点が揃っているなら在庫ロードは完走させる＝IDBが温まり無駄にならない）
// 移動中(settled=false)は表示系のみ：常駐ヒットの即表示・視野外の非表示・カメラ放送（従来の体感は不変）。
// 遠景far枠の選抜：視界に掛かる非active区の軽量箱を点灯・本物が立つ区は箱を退場（二重立ち回避）。
// 常駐（VRAM保持）区は触らない＝本物のメッシュ/マスクの状態機械（autoMesh）と競合させない。
// z13未満/真俯瞰は消灯（本人裁定2026-08-04「流石の遠景もz13で辞めていい」）＝vis切替のみ＝GPU常駐保持・復帰はタダ。
let farLit = true;
function autoFar() {
	if (noFar || !meshOn || !gpuBackend || LOW_MEM || !SETS.length) return;   // ?nofar=1＝遠景箱を切る
	if (env.cam.zoom < FAR_Z || (env.cam.pitch || 0) < 0.02) {
		if (farLit) { for (const n of farShown) renderer.set("meshVis", false, n + "#far"); farLit = false; }
		return;
	}
	if (!farLit) { for (const n of farShown) renderer.set("meshVis", true, n + "#far"); farLit = true; }
	const view = viewBbox(env.cam);
	// 近接抑制の物差し：区bboxへの点距離（autoMesh の pd2 と同式）。箱は「数km先のスカイライン」用の遠景家具＝
	// 実メッシュ帯（z≥AUTO_Z）で約2km圏の区は箱を出さない。本物の同時表示枠（MESH_MAX_ACTIVE=4＝マスク
	// スロットの物理上限）から溢れた隣接区（麻布台 z17.6 で渋谷区が hits5位・実測 2026-08-11）は実メッシュに
	// 交代する日が来ない＝巨大箱が本物の隣に立ち続ける、の根治。遠景の箱は従来どおり。
	const farNearD2 = 0.025 * 0.025;   // ~2.2km
	const farPd2 = s => { const dx = Math.max(s.bbox[0] - env.cam.center[0], 0, env.cam.center[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - env.cam.center[1], 0, env.cam.center[1] - s.bbox[3]); return dx * dx + dy * dy; };
	for (const s of SETS) {
		if (s.noMask) continue;   // 橋梁等は遠景箱の対象外
		if (meshActive.has(s.name) || meshLoading.has(s.name)) {
			// 本物が立つ/来る区＝箱は退場（空メッシュ送信＝rendererが旧バッチを削除）。擬似ward `#far` なので
			// 本物の hide/vis には一切触れない。常駐で隠れているだけの区は箱を出したまま（本物は暗いまま）
			if (farShown.has(s.name)) {
				renderer.set("meshSet", { pos: new Float32Array(0), nrm: new Int8Array(0), idx: new Uint32Array(0) }, s.name + "#far");
				farShown.delete(s.name);
			}
			continue;
		}
		if (meshDead(s.name) || (env.cam.zoom >= MESH_AUTO_Z && farPd2(s) < farNearD2)) {
			// 死亡（廃止区）/バックオフ中＝本物が来ない区、または近接（実メッシュ帯で目の前の区＝選抜4区から
			// 溢れても箱で誤魔化さない）＝箱を出さない・出ていれば退場（旧：failed も近接も知らず箱が出続けた）
			if (farShown.has(s.name)) {
				renderer.set("meshSet", { pos: new Float32Array(0), nrm: new Int8Array(0), idx: new Uint32Array(0) }, s.name + "#far");
				farShown.delete(s.name); requestDraw();
			}
			continue;
		}
		if (farShown.has(s.name) || farMissed.has(s.name)) continue;
		if (!bboxIntersects(s.bbox, view)) continue;
		farShown.add(s.name);
		renderer.set("meshVis", true, s.name + "#far");   // 冪等unhide＝evict後の残りhideフラグ/消灯帯で届いたバッチの両方を掃除
		spawnMeshWorkers();
		meshWorkers[hashStr(s.base) % MESH_NW].postMessage({ type: "far", base: s.base, ward: s.name });
	}
}
// 飛行中の「見せるだけ」：移動中は新規ロードしない（＝ロードのジッタ対策の原spec を保つ）。ただし既に GPU 常駐している区を
// 表示へ戻すのは"ロード"でない（vis フリップ＝転送ゼロ・ジッタ無し）。waitLoading が停止中に GPU まで積んだ区を、シーンの
// グライドがチルトで立ち上げる瞬間に灯すだけ＝基図の押し出し箱（LOD1）を出さず本物の PLATEAU がそのまま立ち上がる（手動チルトと同じ絵）。
function showResidentInFlight() {
	if (!gpuBackend || LOW_MEM || env.cam.zoom < MESH_AUTO_Z || (env.cam.pitch || 0) < 0.02) return;
	const view = viewBbox(env.cam);
	for (const [name, s] of meshResident) {
		if (meshActive.has(name) || !bboxIntersects(s.bbox, view)) continue;
		meshRetain(name, s); renderer.set("meshVis", true, name); meshActive.set(name, s); requestDraw();   // 常駐＝転送ゼロの点灯（ロードでない）
	}
}
function autoMesh(settled = false) {
	if (!meshOn) return;   // 機能ごと停止（opts.mesh=false）
	if (env.flying) { showResidentInFlight(); return; }   // フライト中は新規ロード/解放はしない（原spec＝ジッタ対策）が、既に常駐する区の点灯（=ロードでない）だけは通す＝グライドのリビールで基図の箱を出さない
	if (env.printHold) return;   // 印刷（平面図）撮影中＝印刷カメラで自動ロード/解放をしない（帯域と現ロード状態を乱さない）
	if (env.cam.zoom >= MESH_AUTO_Z - 2 && (env.cam.pitch || 0) >= 0.02) spawnMeshWorkers();   // 暖機＝街に寄り始めたら先に worker を起こす（初回ロードの待ちを短く）
	autoFar();   // 遠景枠は本流のゲート（zoom/pitch/視界）と独立に毎パス選抜
	// 「完全に離れた」常駐区の本削除：区bboxへの点距離が閾値超。ズームアウトだけでは落とさない＝同じ街への戻りはタダのまま。
	for (const [name, s] of meshResident) {
		if (meshActive.has(name) || meshLoading.has(name)) continue;
		const dx = Math.max(s.bbox[0] - env.cam.center[0], 0, env.cam.center[0] - s.bbox[2]);
		const dy = Math.max(s.bbox[1] - env.cam.center[1], 0, env.cam.center[1] - s.bbox[3]);
		if (dx * dx + dy * dy > MESH_FAR_DEG * MESH_FAR_DEG) { meshEvict(name); console.log("[mesh] far away -> evicted resident", name); }
	}
	// 視界確定時の退避＝距離で二段構え（Kenji 体感フィードバック 2026-08-01「読み込みが極端に遅い」で全キャンセルから戻した）：
	// ・近距離（MESH_FAR_DEG 内＝同じ街・チルト往復・ズームバウンス）→ demote＝slow lane 在庫化。完走して
	//   IDB＋非表示常駐に落ちる＝捨てない（通過した区は「さりげない仕込み」）。一時離脱のたびに殺すと
	//   戻り毎に読み直しになり体感が壊れる。bldCap から除外済みなので新規区は塞がない（旧・全demote時代の
	//   ブロック問題は bldCap 側で解決済み）。
	// ・遠距離（55km 超＝都市を跨いだ＝当分戻らない）→ cancel＝協調キャンセル。帯域/CPU/デコードメモリを
	//   現地点へ全部返す。完成済みバッチは逐次 IDB（partial）済み＝戻れば idbLoadPartial が「続きから」。
	const parkStale = (wanted) => {   // 視界から外れたロード中の区＝即キャンセル（部分は保存済＝再訪で続きから）。旧・近距離 demote（slow 在庫）は廃止（9/8）
		for (const [name, s] of meshAutoLoading) {
			if (wanted?.has(name) || meshCancelling.has(name)) continue;
			meshWorkers[hashStr(s.base) % MESH_NW].postMessage({ type: "cancel", base: s.base });
			meshCancelling.add(name);
			console.log("[mesh] out of view -> cancelled (partial saved; resumes on revisit)", name);
		}
	};
	// ロード中があれば最新カメラを worker 群へ放送（~4Hz）＝バッチ境界の残タイル再ソートで「今見ている側」から立つ。
	if (meshLoading.size && performance.now() - meshCamSent > 250) {
		meshCamSent = performance.now();
		meshWorkers.forEach(w => w.postMessage({ type: "cam", center: meshSortAnchor() }));
	}
	// 真俯瞰（pitch<0.02＝show3d と同閾）は平面地図の世界＝建物3Dは描かれない＝PLATEAU を読み込まない
	//（Kenji決定 2026-07-23「平面＋3D」：真俯瞰=筆界/ユーザー層、チルト=地形/建物）。傾けた瞬間の
	// settle で従来どおり自動ロード。常駐（VRAM保持）は触らない＝チルト再開はタダのまま。
	if (env.cam.zoom < MESH_AUTO_Z || (env.cam.pitch || 0) < 0.02) {
		if (settled) parkStale(null);   // ズームアウト/真俯瞰で確定＝表示に急ぎは無い。近距離は在庫slowで完走・遠方のみ中止
		if (env.cam.zoom >= MESH_HIDE_Z && (env.cam.pitch || 0) >= 0.02) {   // ヒステリシス帯＝既表示は保持（消して書き直さない）・新規ロードだけ止める
			for (const [name, s] of meshActive) {   // 保持中でも「完全に離れた」区だけは手放す（evictと同じ物差し）＝active が遠方evictを永久に塞ぐ漏れの防止
				const dx = Math.max(s.bbox[0] - env.cam.center[0], 0, env.cam.center[0] - s.bbox[2]);
				const dy = Math.max(s.bbox[1] - env.cam.center[1], 0, env.cam.center[1] - s.bbox[3]);
				if (dx * dx + dy * dy > MESH_FAR_DEG * MESH_FAR_DEG) { meshActive.delete(name); meshHide(name); requestDraw(); console.log("[mesh] left far in hold band -> hidden", name); }
			}
			return;
		}
		for (const name of meshActive.keys()) { meshHide(name); console.log("[mesh] out of range -> hidden", name); }
		if (meshActive.size) requestDraw();
		meshActive.clear();
		return;
	}
	const view = viewBbox(env.cam);
	// 高チルトでは画面中心の接地点(cam.center)が手前よりずっと先＝「手前（画面下＝足元）の区」が中心距離の
	// 選抜で落ち、基図の押し出し建物のまま残る（z14.9/70°の新橋で実測）。画面下端中央の接地点(foot)も
	// 基準点に加え、視野bboxにも含める＝下にある（＝手前で大きく見える）区ほど優先で立つ。
	// 真俯瞰では下端＝単に南＝優先の意味が無いので、傾き20°超の時だけ使う。
	const foot = footPoint();   // 球外(null)はfootなし扱い
	if (foot) {
		view[0] = Math.min(view[0], foot[0]); view[1] = Math.min(view[1], foot[1]);
		view[2] = Math.max(view[2], foot[0]); view[3] = Math.max(view[3], foot[1]);
	}
	const hitsAll = SETS.filter(s => bboxIntersects(s.bbox, view) && !meshDead(s.name));   // 死んだ/バックオフ中の地区は候補から除外（恒久＝廃止区・一時＝60秒後に再挑戦）
	// 近さ＝「bboxまでの点距離」（bbox内なら0）。重心距離だと南北に長い区（江東=臨海部で重心が南へ~4km）が
	// 足元に居ても落選し、チルト北向きの構図で手前だけ基図の間引き建物になる。
	// 優先順位＝チルト時は「画面下方（足元）に近い区」が主キー（手前＝一番大きく見える建物が先）、
	// 同点は中心への近さ、それも同点（bbox重複）は重心距離。ロード発火もこの順＝手前から立ち始める。
	const pd2 = (s, p) => { const dx = Math.max(s.bbox[0] - p[0], 0, p[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - p[1], 0, p[1] - s.bbox[3]); return dx * dx + dy * dy; };
	const d2 = s => pd2(s, foot || env.cam.center);   // 主キー：足元（真俯瞰は中心）
	const m2 = s => pd2(s, env.cam.center);           // 第2キー：中心
	const c2 = s => { const cx = (s.bbox[0] + s.bbox[2]) / 2, cy = (s.bbox[1] + s.bbox[3]) / 2; return (cx - env.cam.center[0]) ** 2 + (cy - env.cam.center[1]) ** 2; };
	const near = (a, b) => (d2(a) - d2(b)) || (m2(a) - m2(b)) || (c2(a) - c2(b));
	// 選抜は建物（被覆マスクのスロット4を使う）と橋梁等（noMask＝スロット不要）で別枠＝橋が建物4区の枠を奪わない。
	// 台本 plateau: リスト記載の区＝ピン留め＝視界に入っていれば選抜キャップを無視して同時表示
	//（マスクスロット上限=4区まで）。旧・LOW_MEM の同時1区キャップは、東京駅〜丸の内の滑走で最寄り区が
	// 千代田⇄中央と入れ替わるたび「片方を消して片方を読み直す」スラッシング（カタカタ）を起こしていた
	//（lowMem=常駐ゼロ＝flip 毎に再ロード）。→ LOW_MEM=2区に既定化＝両方立てて入れ替わり自体が消えた（Kenji 指定 2026-07-29／2化 2026-07-30）。
	const capMerge = (list, cap) => {
		const sel = list.slice(0, cap);
		for (const s of list.slice(cap)) if (meshPinned.has(s.name) && sel.length < 4) sel.push(s);
		return sel;
	};
	const hits = capMerge(hitsAll.filter(s => !s.noMask).sort(near), MESH_MAX_ACTIVE)
		.concat(capMerge(hitsAll.filter(s => s.noMask).sort(near), MESH_EXTRA_ACTIVE));
	const hitNames = new Set(hits.map(h => h.name));
	if (settled) parkStale(hitNames);   // 視界確定＝現地点の優先度MAX。視界外は近距離=在庫slow・遠方=中止（部分IDB保持）
	for (const name of [...meshActive.keys()]) {
		if (hitNames.has(name)) continue;
		meshActive.delete(name); meshHide(name); requestDraw();
		console.log("[mesh] out of range -> hidden", name);
	}
	// 枠＝同時ロード数（キャンセル中は数えない＝すぐ空く。デモ先読み中は 1 枠譲る）
	// 橋梁等（noMask）は一桁軽い＝建物の枠に並ばせず +1 枠（本人報告 9/8「新宿の橋梁が出なくなった」＝建物 3 区の後ろに並んで
	// 始まらない）。建物は MESH_LOAD_MAX。数えるのは cancel 中を除くロード中の全区
	const loadingN = () => [...meshAutoLoading.keys()].filter(n => !meshCancelling.has(n)).length;
	const slotsFree = (noMask = false) => MESH_LOAD_MAX + (noMask ? 1 : 0) - (meshPrefetchBusy ? 1 : 0) - loadingN();
	const queued = [];
	for (const h of hits) {
		if (meshActive.has(h.name)) continue;
		if (meshLoading.has(h.name)) {
			// キャンセル中に戻ってきた（worker がまだ降りていない）＝枠が空いていれば旗を降ろして続行。塞がっていれば降りて待ち行列へ
			if (meshCancelling.has(h.name) && slotsFree(h.noMask) > 0 && !(meshScriptOnly && playingNow() && !meshScriptOnly.has(h.name))) {
				meshCancelling.delete(h.name);
				meshWorkers[hashStr(h.base) % MESH_NW].postMessage({ type: "promote", base: h.base });
				console.log("[mesh] revisit -> load resumed", h.name);
			}
			continue;
		}
		if (meshResident.has(h.name)) {   // 常駐ヒット＝GPUにVAOが居る→表示フラグを戻すだけ（転送ゼロ・即表示）
			meshRetain(h.name, h);
			renderer.set("meshVis", true, h.name);
			meshActive.set(h.name, h);
			requestDraw();
			console.log("[mesh] resident hit (no re-upload) ->", h.name);
			continue;
		}
		if (!settled) continue;   // 新規ネットワークロードは「視界が落ち着いた」時だけ発火＝パンで通過した区は読み始めない
		// 上映中の関所：台本が preload を明示していれば、リスト外の区は読み始めない（経由地・画面端の無関係区で
		// 観客の自機が急に重くなる件＝Kenji裁定 2026-08-21）。表示系（常駐ヒット点灯・退避復帰）は上で素通し済み＝触らない。
		if (meshScriptOnly && playingNow() && !meshScriptOnly.has(h.name)) { console.log("[mesh] not in script preload -> skipped during show", h.name); continue; }
		if (slotsFree(h.noMask) <= 0) { queued.push(h.name); continue; }   // 待ち行列＝枠が空いた瞬間（完了/中止の finally → autoMesh(true)）に先頭から
		meshLoading.add(h.name);
		meshAutoLoading.set(h.name, h);   // 視界確定時の退避対象へ
		console.log("[mesh] auto-load ->", h.name);
		loadMesh(h.base, undefined, h.name, h.noMask ? null : h.bbox, h.noMask, h)   // noMask（橋梁等）＝マスク不参加＋橋梁モード（バッチ接地・両面）
			.then(ok => {
				if (ok === "cancelled") {   // 協調キャンセル＝failed 扱いにしない（戻れば再ロードできる）。部分バッチのGPU残骸を掃除
					meshEvict(h.name);
					console.log("[mesh] cancel complete (partial batches freed)", h.name);
					return;
				}
				if (ok === "demoted") {   // slow のまま完走（GPU全量済み＝送出は完走時に必ず流し切る・IDB済み）
					meshRetain(h.name, h);
					// 視界内で完走した在庫（fast枠ローテーション中の区など）＝そのまま点灯。従来の一律非表示だと
					// 目の前に立っていた既送出バッチごと消える。視界外だけ従来どおり非表示常駐（再訪は常駐ヒットで即）。
					if (env.cam.zoom >= MESH_HIDE_Z && (env.cam.pitch || 0) >= 0.02 && bboxIntersects(h.bbox, viewBbox(env.cam))) {
						renderer.set("meshVis", true, h.name);
						meshActive.set(h.name, h);
						requestDraw();
						console.log("[mesh] stock complete -> in view = shown", h.name);
					} else {
						meshHide(h.name);   // 低メモリ端末（常駐なし）はここでメッシュ削除＝IDBだけが残る
						console.log("[mesh] stock complete -> hidden resident", h.name);
					}
					return;
				}
				if (!ok) { meshFailed.set(h.name, { perm: true, ts: performance.now() }); console.warn("[mesh] unreadable, skipping (abolished ward / empty data?):", h.name); return; }   // 恒久＝以後は候補から除外
				meshActive.set(h.name, h);
				meshRetain(h.name, h);
				// ★完了時に既に低ズーム/視野外なら stale＝即非表示（ロード中にズームアウトすると3Dが居残る件を断つ。常駐には残る＝戻ればタダ）。
				if (env.cam.zoom < MESH_HIDE_Z || !bboxIntersects(h.bbox, viewBbox(env.cam))) {
					meshActive.delete(h.name); meshHide(h.name); requestDraw();
					console.log("[mesh] out of view at load completion -> hidden", h.name);
				}
			})
			.catch(e => { meshFailed.set(h.name, { perm: false, ts: performance.now() }); console.warn("[mesh] load failed, skipping (retry in 60s):", h.name, e.message || e); })   // 一時＝バックオフ
			.finally(() => {
				meshLoading.delete(h.name); meshAutoLoading.delete(h.name); meshCancelling.delete(h.name); meshDemoted.delete(h.name); meshFastT.delete(h.name); meshRestarted.delete(h.name);
				// 枠が空いた瞬間に再選抜（静止シーン中はonMoveが来ない＝これが無いと3区目以降が
				// 次のカメラ操作まで立たない）。failed/cancelled はそれぞれのガードが再発火を止める。
				if (!env.moving) autoMesh(true);
			});
	}
	if (settled) { meshQueued = queued; renderMeshProg(); }   // 待ち行列の表示（読込トーストの「待機」行）
	// ── 隣接区の先読み（9/8・本人「先読みが全く無くなった」）＝可視区が全て着手済みで枠が余っていれば、視界の外周 NEAR_PRE 内の
	// 未焼き区を IDB へだけ先読み（meshPreload＝描画へ送らない・GPU 常駐しない）。旧・slow 在庫化の代わり。視界に入れば OPFS 復元＝1 秒
	if (settled && !queued.length && !LOW_MEM && !(meshScriptOnly && playingNow())) {
		const NEAR_PRE = 0.012;   // ≈1.3km（デモ先読みの MARGIN と同じ物差し）
		let free = slotsFree() - meshNeighborPre.size;
		if (free > 0) {
			const pd = s => { const dx = Math.max(s.bbox[0] - view[2], 0, view[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - view[3], 0, view[1] - s.bbox[3]); return dx * dx + dy * dy; };
			const cand = SETS.filter(s => !hitNames.has(s.name) && !meshLoading.has(s.name) && !meshActive.has(s.name) && !meshResident.has(s.name) && !meshDead(s.name) && !meshPreDone.has(s.name) && pd(s) < NEAR_PRE * NEAR_PRE)
				.sort((x, y) => pd(x) - pd(y));
			for (const s of cand.slice(0, free)) {
				meshNeighborPre.add(s.name);
				console.log("[mesh] neighbor prefetch (IDB only) ->", s.name);
				meshPreload(s).then(ok => { if (ok) meshPreDone.add(s.name); }).finally(() => { meshNeighborPre.delete(s.name); if (!env.moving && !env.flying) autoMesh(true); });
			}
		}
	}
}
const meshRestarted = new Set();        // 見張りで一度打ち切った区（同じロードで二度はしない＝ループ防止。finally で解除）
const meshNeighborPre = new Set();      // 隣接区の先読み中（枠に数える）
const meshPreDone = new Set();          // このセッションで先読み済（同じ区を何度も IDB 確認しない＝存在確認は worker 側で即返るが往復は省く）
// 静止中の見張り：ロード中が居る間は10秒毎に再選抜＝fast枠ローテーション・枠空き補充・退避復帰を
// カメラ操作なしでも回す（onMove/settle が来ない「静止して待つ」シーンでの飢餓/取りこぼし対策）。
const pollT = setInterval(() => { if (meshLoading.size && !env.moving && !env.flying) autoMesh(true); }, 10e3);
const pokeT = setTimeout(() => { if (!env.moving && !env.flying) autoMesh(true); }, 46e3);   // 起動猶予(45s)明けの一突き＝触らず眺めているだけでも在庫slowが静かに育ち始める（上のポーラーはロード中のみ発火のため）


// --- PLATEAU LOD2 建物スパイク（A＝loaders.gl）：b3dm を Draco 解凍→ECEF→単位球へ変換→mesh pass で球に立てる ---
// 実体（fetch/デコード/ECEF/RTE/被覆マスク）は全て meshworker.js（メインスレッドをブロックしないためworker化）。
// 特定区を「今すぐ立てる」（カメラは動かさない）：常駐ヒット＝vis を戻すだけ（転送ゼロ）／未常駐＝IDB（温）or 網から
// ロードして常駐＋表示。ロードのジッタ対策の外＝停止中の積み込み（waitLoading のリビール準備）と手打ちデモ(__mesh)で共用。
// onMove→autoMesh との二重ロードは meshLoading ガードで防ぐ。返り＝立ったか(bool)の Promise。
function standUpWard(set, tiles) {
	if (meshActive.has(set.name) || meshLoading.has(set.name)) return Promise.resolve(false);
	if (meshResident.has(set.name)) {   // 常駐ヒット＝表示フラグを戻すだけ（autoMesh と同じ経路）
		meshRetain(set.name, set); renderer.set("meshVis", true, set.name); meshActive.set(set.name, set); requestDraw();
		return Promise.resolve(true);
	}
	meshLoading.add(set.name);
	return loadMesh(set.base, tiles, set.name, set.noMask ? null : set.bbox, set.noMask, set)
		.then(ok => { if (ok === true) { meshActive.set(set.name, set); meshRetain(set.name, set); } return ok === true; })   // "cancelled"（自動ロード合流の端ケース）は活性化しない
		.finally(() => meshLoading.delete(set.name));
}


// ロード本体（カメラは動かさない）：重い処理は meshworker.js に丸投げ。メッシュはバッチ単位で worker→render worker
// 直結ポートを流れ逐次表示される（main を通らない。ここに返るのは全バッチ完了の ack だけ）。
// 成功可否 bool＝呼び出し側が meshActive に加えるかの判断に使う。
async function loadMesh(base, tiles, name, wardBbox, brid, ex = {}) {
	emit({ phase: "start", name, base });
	const ok = await workerLoadMesh(base, tiles, name, wardBbox, brid, ex);
	if (ok === "cancelled") { emit({ phase: "cancelled", name, base }); return ok; }   // 視野離脱の協調キャンセル＝呼び出し側（autoMesh）が残骸掃除する
	if (!ok) { emit({ phase: "failed", name, base }); return false; }
	requestDraw();
	console.log("[mesh] done", base);
	emit({ phase: "done", name, base });
	return true;
}


// 台本の中で「建物が実際に見える最初の視点」（チルト＋寄り＝pitch≥閾 かつ zoom≥AUTO_Z）の視界に掛かる建物区を返す。
// waitLoading のリビール準備で「開幕で立つ区だけ」を停止中に GPU へ積むための最小集合＝要らない区（真俯瞰・低ズーム・視界外の隣接・後続ホップ）は含めない。
function firstRevealSets(views) {
	for (const hash of views || []) {
		const v = typeof hash === "string" ? parseViewHash(hash) : hash;
		if (!v || v.zoom < MESH_AUTO_Z || (v.pitch || 0) < 0.02) continue;   // 真俯瞰/低ズーム＝建物は出ない＝積まない
		const vb = viewBbox({ center: [v.lon, v.lat], zoom: v.zoom });   // viewBbox は zoom と center だけ使う（pitch/bearing 不問）
		return SETS.filter(s => !s.noMask && bboxIntersects(s.bbox, vb));
	}
	return [];
}
function setExcludeMap(map) {   // 起動前に届けば spawn 時に配り、起動後なら起きている worker へ即配る
	excludeMap = map;
	meshWorkers.forEach(w => w.postMessage({ type: "exclude", map }));
}
function memStats() {   // HUD の物差し＝常駐（表示＋非表示）の実測バイト・区数・過渡（worker 内 cache／ロード中の全量保持）・ティア
	const names = new Set([...meshActive.keys(), ...meshResident.keys()]);
	let bytes = 0; for (const n of names) bytes += bytesOf(n, meshActive.get(n) || meshResident.get(n));
	const cache = meshMemW.reduce((s, w) => s + (w?.cache || 0), 0);   // 過渡＝worker内cache（常駐台帳外・コールド落ちの主役）
	const live = meshMemW.reduce((s, w) => s + (w?.live || 0), 0);     // 過渡＝ロード中の区の全量保持
	return { bytes, regions: meshActive.size, transient: { cache, live, bytes: cache + live },
		tier: MID_TIER ? { active: MESH_MAX_ACTIVE, residentGB: MESH_RESIDENT_BYTES / 1e9, workers: MESH_NW } : null };
}
function terminate() {   // destroy：worker・デコーダ（main 所有＝道連れ）・見張りタイマー（残すと destroy 後に worker を起こし直す）
	meshWorkers.forEach(w => w.terminate());
	meshDecoders.forEach(w => w.terminate());
	clearInterval(pollT); clearTimeout(pokeT);
}
return {
	update: autoMesh, standUp: standUpWard, prefetch: prefetchMeshForViews, trimForScript: meshTrimForScript, firstRevealSets,
	setExcludeMap, setProgressTap: fn => { sceneProgTap = fn; }, terminate,
	get sets() { return SETS; }, progress: meshProg,
	isActive: name => meshActive.has(name), isDead: meshDead,
	visibleLoading: () => [...meshAutoLoading.keys()].filter(n => !meshDemoted.has(n) && !meshCancelling.has(n)),   // 「これから見える区」＝demote/cancel 中は載せない
	memStats, openDb: meshDb.open,
};
}
