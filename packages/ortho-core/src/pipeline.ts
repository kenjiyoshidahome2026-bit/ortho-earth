// データパイプライン境界：tile worker プール（fetch→decode→tessellation）＋ scene worker（geometry 保持＋merge）。
// main は geometry を一切持たず、結合済みバッファを GL に上げるだけ。重い処理も geometry も worker の向こう側。
// 入口＝style / tileUrl / requestDraw / scenePort(render worker直結)。出口＝tiles(LOD管理) と requestMerge。
// geometry は main を通らず scene worker → render worker へ直行（main は geometry を知らない）。
import { createTileManager } from "./tilemanager.ts";
import { spawnWorker, setWorkerFactory } from "./workerFactory.ts";
import { builtinWorker } from "./builtinWorkers.ts";
import { opBuffers } from "./scene.ts";
import { createTileQueue } from "./tilequeue.ts";
import type { Style } from "./build.ts";
import type { RequestFn } from "./query.ts";
import type { WorkerFactory } from "./workerFactory.ts";
import type { BuildHint, BuildTileFn, LodFloor, OrderItem, TileManager, TileResult } from "./tilemanager.ts";
import type { TileXYZ } from "./tile.ts";
import type { SceneRequest, SceneResponse, TileRequest, TileResponse } from "./worker-msg.ts";

// request(url, "Tile")＝取得の前の手入れ（#37）→ { url, headers?, credentials?, load?: () => Promise<ArrayBuffer> }｜null。load＝addProtocol の読み口（main で取って本体を worker へ）
// encoding＝基図タイルの形式（"mvt"｜"mlt"・文字列か () => 文字列＝setStyle で基図の置き場と一緒に替わる・既定 mvt・#88）。tile worker へ init／setStyle で運ぶ
// tileQueue＝優先付き共有キュー（vt perf plan §3.1・既定 on）：false＝旧の round-robin 即 post（`?tileq=0` の A/B）。perSlot＝worker 1 本の同時実行（fetch の待ちを重ねる・既定 3）
export interface PipelineOptions {
	style: Style; tileUrl: (z: number, x: number, y: number) => string; requestDraw: () => void; scenePort: MessagePort; onMerged?: ((slot: unknown, sig: unknown) => void) | null; onTile?: ((ok: boolean) => void) | null;
	lodFloor?: LodFloor | null; memBudgetMB?: number | null; coverage?: number[] | null; ell?: unknown; minZ?: number; workerFactory?: WorkerFactory | null; request?: RequestFn | null; encoding?: string | (() => string);
	tileQueue?: boolean; perSlot?: number;
	/** 地形にドレープする（線を細分する）か。関数＝init／setStyle のたびに読む（terrain の有無が替わる地図）。false＝細分なし（§3.2・`?linesub=1` で従来どおり細分） */
	drape?: boolean | (() => boolean);
}
export interface Pipeline {
	relayCtl: (msg: unknown, transfer?: Transferable[] | null) => void;
	tiles: TileManager;
	requestMerge: ((slot: unknown, order: readonly OrderItem[], origin: unknown, hidden: Set<number> | null | undefined, sig: unknown) => void) & { debugFail: () => void; stats: () => void };
	setStyle: (newStyle: Style) => void;
	/** 地形の有無が替わった（setTerrain）＝drape を読み直し、変わっていれば全タイルを再ビルド（setStyle と同じ道・稀） */
	setDrape: () => void;
	destroy: () => void;
}
interface Pending { resolve: (r: TileResult) => void; reject: (e: Error) => void; key: string; w: Worker; slot: number; noUrl: boolean }
/** キューで待つ 1 件（まだ worker に post していない）＝発送時に id を振って pending へ */
interface Queued { t: TileXYZ; key: string; resolve: (r: TileResult) => void; reject: (e: Error) => void }
export function createPipeline({ style, tileUrl, requestDraw, scenePort, onMerged, onTile, lodFloor, memBudgetMB, coverage, ell, minZ, workerFactory, request = null, encoding = "mvt", tileQueue = true, perSlot = 3, drape = true }: PipelineOptions): Pipeline {
	const encodingNow = (): string => (typeof encoding === "function" ? encoding() : encoding) || "mvt";
	const drapeNow = (): boolean => typeof drape === "function" ? drape() : drape;
	let curStyle = style;   // setStyle で差し替わる今の style（setDrape が再送する）
	if (workerFactory) setWorkerFactory(workerFactory);   // ホストの入口（役割名 "ortho:scene" / "ortho:tile" → Worker・2026-09-22）
	// scene worker：タイル geometry を保持し結合(merge)も担う。結合結果は main を経由せず
	// render worker へ直結ポートで送る（下の connect）＝main は geometry を一切知らない。
	const sceneWorker = spawnWorker("ortho:scene", () => builtinWorker("ortho:scene"))!;
	sceneWorker.postMessage({ type: "connect", port: scenePort } satisfies SceneRequest, [scenePort]);   // scene→render 直結
	// iOS WebKit の轍（2026-08-02）：WebGPU を作った worker はページからの受信が全チャネル死ぬ。
	// 生きている「page→scene worker→（scenePort）→render worker」で制御メッセージを中継する口。
	const relayCtl = (msg: unknown, transfer?: Transferable[] | null): void => sceneWorker.postMessage({ type: "relayCtl", msg } satisfies SceneRequest, transfer || []);
	// ack：merge 成功時に sig が返る＝main はこれを見て readySig を確定（投げっぱなし＋楽観確定だと
	// 一度の失敗が「静止中は永遠に欠けたタイル」になる）。失敗時は ack が来ない→main がタイムアウト再要求。
	sceneWorker.onmessage = (e: MessageEvent<SceneResponse>) => {
		if (e.data.type === "relayCtlN") { (globalThis as { __relayCtlN?: unknown }).__relayCtlN = e.data.n; return; }   // iOS診断：hop1受信数
		if (e.data.type === "merged" && onMerged) onMerged(e.data.slot, e.data.sig);
	};
	function requestMerge(slot: unknown, order: readonly OrderItem[], origin: unknown, hidden: Set<number> | null | undefined, sig: unknown): void {
		// 要求だけ main が出す（何を結合するか）。結果は render worker へ直行（merge同期＝要求順＝最後が最新）。
		sceneWorker.postMessage({ type: "merge", slot: slot as string, sig, order: order.map(o => ({ key: o.key, origin: o.origin!, z: o.z })), origin: origin as number[] | null, hidden: hidden && hidden.size ? [...hidden] : null } satisfies SceneRequest);
	}
	requestMerge.debugFail = (): void => sceneWorker.postMessage({ type: "debugFailNext" } satisfies SceneRequest);   // テスト用：次の merge を故意に失敗させる
	requestMerge.stats = (): void => sceneWorker.postMessage({ type: "stats" } satisfies SceneRequest);   // 観測用：GPU常駐プールの占有を scene worker が console に出す

	// タイル worker プール：geometry は scene worker へ転送し、main にはメタ＋ラベルだけ返す。
	const NW = Math.min(4, (navigator.hardwareConcurrency || 4) - 1) || 2;
	const tileWorkers: Worker[] = [], pending = new Map<number, Pending>(), keyToId = new Map<string, number>();
	let wIdx = 0, reqId = 0;
	// 優先付き共有キュー（§3.1）：worker に post する前に main で待たせ、空いた worker（同時 perSlot 本まで）へ役→距離の順で渡す。発送＝下の post
	const queue = tileQueue ? createTileQueue<Queued>({ slots: NW, perSlot, dispatch: (q, slot) => post(q.t, q.key, q.resolve, q.reject, slot) }) : null;
	for (let i = 0; i < NW; i++) {
		const w = spawnWorker("ortho:tile", () => builtinWorker("ortho:tile"))!;
		w.onmessage = (e: MessageEvent<TileResponse>) => {
			const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
			if (keyToId.get(p.key) === e.data.id) keyToId.delete(p.key);
			queue?.done(p.slot);   // この worker の 1 本が空いた＝次を発送
			// 成否を外へ通知（abort=視野外中断は失敗に数えない）＝main が「通信断トースト」の判断材料にする
			// 取得先の無いタイル（noUrl＝外来 style にベクタの基図が無い＝画像タイルだけ等）は通信の失敗に数えない（2026-09-29・公式例 3d-terrain で「地図データの取得に失敗」が誤って出た）
			if (onTile && !p.noUrl && (e.data.ok || !/abort/i.test(String(e.data.error)))) onTile(!!e.data.ok);
			if (!e.data.ok) { p.reject(new Error(e.data.error)); return; }
			sceneWorker.postMessage({ type: "tile", key: p.key, ops: e.data.dl.ops, buildings: e.data.buildings } satisfies SceneRequest, opBuffers(e.data.dl.ops, e.data.buildings));
			p.resolve({ origin: e.data.origin, labels: e.data.labels, z: e.data.z, bytes: e.data.bytes, t: e.data.t });   // メタ＋ラベル＋geometry実バイト（退避予算用）＋worker 内の時間（計器 e）
		};
		w.postMessage({ type: "init", style, coverage, ell, encoding: encodingNow(), drape: drapeNow() } satisfies TileRequest);   // coverage＝配信圏 bbox（圏外タイルは worker が fetch せず空タイル扱い）。ell＝楕円体ノブ（buildings の世界単位）。encoding＝タイルの形式。drape＝線の細分（§3.2）
		tileWorkers.push(w);
	}
	// 発送＝worker slot に 1 枚頼む（キュー経由でも即時でも同じ道）
	function post(t: TileXYZ, key: string, resolve: (r: TileResult) => void, reject: (e: Error) => void, slot: number): void {
		const id = ++reqId, w = tileWorkers[slot];
		const url = tileUrl(t.z, t.x, t.y), pm = !!url && /^pmtiles:\/\//i.test(url);
		// PMTiles で頁が addProtocol("pmtiles") を登録している時＝MapLibre と同じ URL の形（…/{z}/{x}/{y}）で頁の読み口に頼む（旧＝アーカイブの URL だけを渡し、pmtiles.js は何も返さず＝タイルが来ない・2026-09-30）。登録が無ければ worker の自前の読み（範囲取得）
		const rq = url && request ? request(pm ? `${url}/${t.z}/${t.x}/${t.y}` : url, "Tile") : null;
		if (rq?.load) rq.load().then(ab => { if (pending.has(id)) w.postMessage({ id, url: rq.url, z: t.z, x: t.x, y: t.y, bytes: ab } satisfies TileRequest, ab?.byteLength ? [ab] : []); },
			err => { const p = pending.get(id); if (p) { pending.delete(id); if (keyToId.get(key) === id) keyToId.delete(key); queue?.done(p.slot); if (onTile && !/abort/i.test(String(err?.message ?? err))) onTile(false); p.reject(err); } });   // 読み口の失敗＝worker の失敗と同じ扱い（旧＝keyToId が残り、通信断の数にも入らなかった）
		else w.postMessage({ id, url: pm ? url : (rq?.url ?? url), z: t.z, x: t.x, y: t.y, ...(rq?.headers || rq?.credentials ? { init: { headers: rq.headers, credentials: rq.credentials } } : {}) } satisfies TileRequest);
		keyToId.set(key, id);
		pending.set(id, { resolve, reject, key, w, slot, noUrl: !url });
	}
	// hint＝tilemanager の役（主層 0／下地 1／毛布 2）と画面中心からの距離＝キューの鍵。キュー無し（?tileq=0）は旧どおり round-robin で即 post
	const workerBuildTile: BuildTileFn = (t: TileXYZ, hint?: BuildHint): Promise<TileResult> => {
		const key = `${t.z}/${t.x}/${t.y}`;
		return new Promise<TileResult>((resolve, reject) => {
			if (queue) queue.enqueue(key, { role: hint?.role ?? 0, dist: hint?.dist ?? 0 }, { t, key, resolve, reject });
			else post(t, key, resolve, reject, wIdx = (wIdx + 1) % NW);
		});
	};
	// 視野から外れた in-flight タイルの中断（tilemanager が update 毎に呼ぶ）。
	// main側の pending を即 "aborted" で解決＝呼び出し元(ensure)がエントリを消して再訪時に再取得可能にする。
	// worker へも abort を送り fetch を実キャンセル（帯域とデコードCPUを空ける）。キューで待っているだけの物は取り下げるだけ（worker は知らない）
	workerBuildTile.abort = (key: string): void => {
		const q = queue?.remove(key); if (q) { q.reject(new Error("aborted")); return; }
		const id = keyToId.get(key); if (id == null) return;
		keyToId.delete(key);
		const p = pending.get(id); if (!p) return;
		pending.delete(id);
		queue?.done(p.slot);
		p.w.postMessage({ type: "abort", id } satisfies TileRequest);
		p.reject(new Error("aborted"));
	};
	// 優先度の付け直し（tilemanager が update 毎に、読込中の枠へ）＝待っている分だけ効く
	workerBuildTile.priority = (key: string, hint: BuildHint): void => { queue?.setPriority(key, { role: hint.role, dist: hint.dist }); };
	workerBuildTile.stats = () => queue?.stats() ?? null;

	// onEvict：main のタイルキャッシュから消えたら scene worker の geometry も同時に消す＝両者は常に鏡。
	// scene worker 側に独自の上限退避を持たせない（mainがreadyのタイルを勝手に捨てると merge で黙って穴になる）。
	const tiles = createTileManager({
		style, tileUrl, onChange: requestDraw, buildTile: workerBuildTile, lodFloor, memBudgetMB, coverage, minZ,
		onEvict: keys => sceneWorker.postMessage({ type: "evict", keys } satisfies SceneRequest),
	});
	// 配色テーマの生き替え（reload無し restyle）：tile worker 群へ新styleを配り、既存タイルを全て捨てる。
	// 色は dl.ops に焼き込まれるため、次の update() 群で可視タイルが新styleで再ビルドされる（生バイトは
	// fetchMVT のIDB/HTTP温間キャッシュ命中で速い）。scene worker の geom/GPU常駐は tiles.reset の onEvict で
	// 同時解放＝ピーク約1倍（次テーマの先組みはしない＝GPUメモリ2倍を避ける）。
	function setStyle(newStyle: Style): void {
		curStyle = newStyle; lastDrape = drapeNow();
		const enc = encodingNow();   // 外来 style の差し替え（map.setStyle）で基図の置き場と形式が一緒に替わる
		for (const w of tileWorkers) w.postMessage({ type: "setStyle", style: newStyle, encoding: enc, drape: lastDrape } satisfies TileRequest);
		tiles.reset();
	}
	let lastDrape = drapeNow();
	function setDrape(): void {
		const d = drapeNow(); if (d === lastDrape) return; lastDrape = d;   // 変わっていなければ何もしない（再ビルドは高い）
		for (const w of tileWorkers) w.postMessage({ type: "setStyle", style: curStyle, encoding: encodingNow(), drape: d } satisfies TileRequest);
		tiles.reset();
	}
	// 後片付け：worker を全て terminate（SPA等で地図を剥がす時＝アプリ側 map.destroy() から）。
	// in-flight の pending は reject＝呼び出し元の await を宙吊りにしない。
	function destroy(): void {
		for (const p of pending.values()) p.reject(new Error("destroyed"));
		pending.clear(); keyToId.clear();
		if (queue) for (const q of queue.drain()) q.reject(new Error("destroyed"));
		sceneWorker.terminate();
		tileWorkers.forEach(w => w.terminate());
	}
	return { relayCtl, tiles, requestMerge, setStyle, setDrape, destroy };
}
