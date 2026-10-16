// データパイプライン境界：tile worker プール（fetch→decode→tessellation）＋ scene worker（geometry 保持＋merge）。
// main は geometry を一切持たず、結合済みバッファを GL に上げるだけ。重い処理も geometry も worker の向こう側。
// 入口＝style / tileUrl / requestDraw / scenePort(render worker直結)。出口＝tiles(LOD管理) と requestMerge。
// geometry は main を通らず scene worker → render worker へ直行（main は geometry を知らない）。
import { createTileManager } from "./tilemanager.ts";
import { spawnWorker, setWorkerFactory } from "./workerFactory.ts";
import { builtinWorker } from "./builtinWorkers.ts";
import { opBuffers } from "./scene.ts";
import type { Style } from "./build.ts";
import type { RequestFn } from "./query.ts";
import type { WorkerFactory } from "./workerFactory.ts";
import type { LodFloor, OrderItem, TileManager, TileResult } from "./tilemanager.ts";
import type { TileXYZ } from "./tile.ts";
import type { SceneRequest, SceneResponse, TileRequest, TileResponse } from "./worker-msg.ts";

// request(url, "Tile")＝取得の前の手入れ（#37）→ { url, headers?, credentials?, load?: () => Promise<ArrayBuffer> }｜null。load＝addProtocol の読み口（main で取って本体を worker へ）
// encoding＝基図タイルの形式（"mvt"｜"mlt"・文字列か () => 文字列＝setStyle で基図の置き場と一緒に替わる・既定 mvt・#88）。tile worker へ init／setStyle で運ぶ
export interface PipelineOptions {
	style: Style; tileUrl: (z: number, x: number, y: number) => string; requestDraw: () => void; scenePort: MessagePort; onMerged?: ((slot: unknown, sig: unknown) => void) | null; onTile?: ((ok: boolean) => void) | null;
	lodFloor?: LodFloor | null; memBudgetMB?: number | null; coverage?: number[] | null; ell?: unknown; minZ?: number; workerFactory?: WorkerFactory | null; request?: RequestFn | null; encoding?: string | (() => string);
}
export interface Pipeline {
	relayCtl: (msg: unknown, transfer?: Transferable[] | null) => void;
	tiles: TileManager;
	requestMerge: ((slot: unknown, order: readonly OrderItem[], origin: unknown, hidden: Set<number> | null | undefined, sig: unknown) => void) & { debugFail: () => void; stats: () => void };
	setStyle: (newStyle: Style) => void;
	destroy: () => void;
}
interface Pending { resolve: (r: TileResult) => void; reject: (e: Error) => void; key: string; w: Worker; noUrl: boolean }
export function createPipeline({ style, tileUrl, requestDraw, scenePort, onMerged, onTile, lodFloor, memBudgetMB, coverage, ell, minZ, workerFactory, request = null, encoding = "mvt" }: PipelineOptions): Pipeline {
	const encodingNow = (): string => (typeof encoding === "function" ? encoding() : encoding) || "mvt";
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
	for (let i = 0; i < NW; i++) {
		const w = spawnWorker("ortho:tile", () => builtinWorker("ortho:tile"))!;
		w.onmessage = (e: MessageEvent<TileResponse>) => {
			const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
			if (keyToId.get(p.key) === e.data.id) keyToId.delete(p.key);
			// 成否を外へ通知（abort=視野外中断は失敗に数えない）＝main が「通信断トースト」の判断材料にする
			// 取得先の無いタイル（noUrl＝外来 style にベクタの基図が無い＝画像タイルだけ等）は通信の失敗に数えない（2026-09-29・公式例 3d-terrain で「地図データの取得に失敗」が誤って出た）
			if (onTile && !p.noUrl && (e.data.ok || !/abort/i.test(String(e.data.error)))) onTile(!!e.data.ok);
			if (!e.data.ok) { p.reject(new Error(e.data.error)); return; }
			sceneWorker.postMessage({ type: "tile", key: p.key, ops: e.data.dl.ops, buildings: e.data.buildings } satisfies SceneRequest, opBuffers(e.data.dl.ops, e.data.buildings));
			p.resolve({ origin: e.data.origin, labels: e.data.labels, z: e.data.z, bytes: e.data.bytes });   // メタ＋ラベル＋geometry実バイト（退避予算用）
		};
		w.postMessage({ type: "init", style, coverage, ell, encoding: encodingNow() } satisfies TileRequest);   // coverage＝配信圏 bbox（圏外タイルは worker が fetch せず空タイル扱い）。ell＝楕円体ノブ（buildings の世界単位）。encoding＝タイルの形式
		tileWorkers.push(w);
	}
	function workerBuildTile(t: TileXYZ): Promise<TileResult> {
		const id = ++reqId, key = `${t.z}/${t.x}/${t.y}`, w = tileWorkers[wIdx = (wIdx + 1) % NW];
		const url = tileUrl(t.z, t.x, t.y), pm = !!url && /^pmtiles:\/\//i.test(url);
		// PMTiles で頁が addProtocol("pmtiles") を登録している時＝MapLibre と同じ URL の形（…/{z}/{x}/{y}）で頁の読み口に頼む（旧＝アーカイブの URL だけを渡し、pmtiles.js は何も返さず＝タイルが来ない・2026-09-30）。登録が無ければ worker の自前の読み（範囲取得）
		const rq = url && request ? request(pm ? `${url}/${t.z}/${t.x}/${t.y}` : url, "Tile") : null;
		if (rq?.load) rq.load().then(ab => { if (pending.has(id)) w.postMessage({ id, url: rq.url, z: t.z, x: t.x, y: t.y, bytes: ab } satisfies TileRequest, ab?.byteLength ? [ab] : []); },
			err => { const p = pending.get(id); if (p) { pending.delete(id); if (keyToId.get(key) === id) keyToId.delete(key); if (onTile && !/abort/i.test(String(err?.message ?? err))) onTile(false); p.reject(err); } });   // 読み口の失敗＝worker の失敗と同じ扱い（旧＝keyToId が残り、通信断の数にも入らなかった）
		else w.postMessage({ id, url: pm ? url : (rq?.url ?? url), z: t.z, x: t.x, y: t.y, ...(rq?.headers || rq?.credentials ? { init: { headers: rq.headers, credentials: rq.credentials } } : {}) } satisfies TileRequest);
		keyToId.set(key, id);
		return new Promise<TileResult>((resolve, reject) => pending.set(id, { resolve, reject, key, w, noUrl: !url }));
	}
	// 視野から外れた in-flight タイルの中断（tilemanager が update 毎に呼ぶ）。
	// main側の pending を即 "aborted" で解決＝呼び出し元(ensure)がエントリを消して再訪時に再取得可能にする。
	// worker へも abort を送り fetch を実キャンセル（帯域とデコードCPUを空ける）。
	workerBuildTile.abort = (key: string): void => {
		const id = keyToId.get(key); if (id == null) return;
		keyToId.delete(key);
		const p = pending.get(id); if (!p) return;
		pending.delete(id);
		p.w.postMessage({ type: "abort", id } satisfies TileRequest);
		p.reject(new Error("aborted"));
	};

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
		const enc = encodingNow();   // 外来 style の差し替え（map.setStyle）で基図の置き場と形式が一緒に替わる
		for (const w of tileWorkers) w.postMessage({ type: "setStyle", style: newStyle, encoding: enc } satisfies TileRequest);
		tiles.reset();
	}
	// 後片付け：worker を全て terminate（SPA等で地図を剥がす時＝アプリ側 map.destroy() から）。
	// in-flight の pending は reject＝呼び出し元の await を宙吊りにしない。
	function destroy(): void {
		for (const p of pending.values()) p.reject(new Error("destroyed"));
		pending.clear(); keyToId.clear();
		sceneWorker.terminate();
		tileWorkers.forEach(w => w.terminate());
	}
	return { relayCtl,
 tiles, requestMerge, setStyle, destroy };
}
