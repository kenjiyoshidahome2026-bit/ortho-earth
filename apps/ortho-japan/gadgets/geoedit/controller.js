// 編集コントローラ＝状態機械と結線の中枢（読込/コミット/再抽出のパイプライン・コマンド適用と履歴・選択/複数選択・ツール・鍵盤）。
// 入力の各面は独立モジュールへ分割（9/4）＝ drag.js（頂点/フィーチャのドラッグ）・sketch.js（作図）・tip.js（ホバー）・
// contextmenu.js（右クリック）・worker-rpc.js（Worker 往復）。各モジュールは共有文脈 ed（下の initEditor 冒頭）を受け取り、
// 可変状態は全て st に置く（tool/drag/editGen も）＝モジュール間で閉包変数を共有しない。
//   idle/selected → dragVertex（capture-phase pointerdown でハンドルを掴む＝エンジンのパンは発火しない）
//   point/line/polygon → editClick スロット経由の作図（クリックvs.ドラッグ弁別は input.js の4px裁定に任せる）
// コミット頻度＝頂点数で二段（<10万: drag-end 300ms デバウンス / ≥10万: アイドル2s or 明示操作）。
// 構造操作（add/del）→ Worker/同期のトポロジ再抽出（デバウンス）＝頂点吸着の共有化・arc分割を回復。
import { buildTopology } from "geopbf/edit/topo-extract";
import { createModel, adoptRebuilt, rebuildModel, topoFromTransfer, topoToTransfer } from "geopbf/edit/model";
import { createHistory } from "geopbf/edit/history";
import { createGintLayer } from "./gint-layer.js";
import { createOverlay } from "./overlay.js";
import { createPopLayer } from "./pop-layer.js";
import { initToolbar } from "./toolbar.js";
import { initDrop, exportPanel, idbSave, idbLoad, idbClear } from "./io.js";
import { cloudPanel } from "./cloud.js";
import { createPropsPanel, mergeProps } from "./properties.js";
import { createLargeModel } from "geopbf/edit/large-model";
import { createWorkerRpc } from "./worker-rpc.js";
import { createSketch } from "./sketch.js";
import { installDrag, moveTargets } from "./drag.js";
import { createTip } from "./tip.js";
import { installContextMenu } from "./contextmenu.js";
import { geopbf } from "geopbf";
import { GeoPBF } from "geopbf/pbf-base";
import { dockStack } from "../stack.js";   // 左下ドック（#log/#pos と同じ容れ物＝重なりを構造で排除）
import css from "./editor.scss?inline";    // CSS自給（ガジェット三戒）＝遅延chunkに同乗・初回搭載で <style> を1枚
import { ellipsoidOn } from "ortho-core";
import { tr } from "../../i18n.js";   // UI 多言語化（英語キー＝既定値・訳は i18n/<lang>.json＝i18n.js）
const t = tr();

const BIG = 100_000;          // これ以上の頂点数＝コミットをアイドル寄せ
const SYNC_REBUILD = 200_000; // これ未満＝再抽出は main 同期（Worker往復より速い）
// 大規模モードの門＝2段：①バイト数（既定64MB＝解析すら main で持たない・?th=n MB）②頂点数（既定200万＝
// 全量位相抽出の JS Map 網は 1.36M頂点で ~550MB（7a8b331 実測）＝これを超える密なファイルはバイト数が小さくても OOM 圏・?tv=n 個）。
// ②は Worker がデコードついでに数え、超えた時点で打ち切って大規模経路へ回す（main の費用ゼロ）。
const Q = new URLSearchParams(location.search);
const LARGE_BYTES = (() => { const n = +Q.get("th"); return Math.round((n > 0 ? n : 64) * 1048576); })();
const LARGE_VERTS = (() => { const n = +Q.get("tv"); return n > 0 ? Math.round(n) : 2_000_000; })();

export function initEditor(map, { adopt = true, setDropOwner = null } = {}) {   // adopt＝表示中のユーザーデータ（ドロップ/?g=）があればそれを編集へ取り込む／setDropOwner＝本体地図の dropFile を譲らせる手綱（app が注入）
	const mapEl = map.mapEl;
	const ac = new AbortController(), signal = ac.signal;
	if (!document.getElementById("ge-css")) { const st = document.createElement("style"); st.id = "ge-css"; st.textContent = css; document.head.append(st); }
	// 真上固定＝編集中はチルト上限 0（オーバレイは地形リフト・裏半球を考えない設計）。destroy で搭載前の上限へ戻す
	const prevMaxPitch = map.maxPitch?.(), prevZoomMin = map.zoomMin?.();
	map.setMaxPitch?.(0);
	map.setZoomMin?.(2.5);   // 編集の縮尺は z>2.5（本人裁定 9/4）＝編集ボタンの出現域（z>2.5）から下へ落ちない
	mapEl.classList.add("ge-on");   // 編集中の印＝星空劇場の家具（右上の日時計 #sky-clock）を出さない（本人裁定 9/15）。CSS は editor.scss
	setDropOwner?.(true);
	// ツールバー＝mapEl 直下（DOM順＝エンジン家具の後＝上に重なる。z-index 不使用の掟）
	const toolbarEl = document.createElement("div");
	toolbarEl.id = "ge-toolbar"; toolbarEl.hidden = true;
	mapEl.append(toolbarEl);
	// 可変状態は全部ここ（各入力モジュールと共有）
	const st = {
		model: null, selection: null, dragEids: null, hidden: null, sketch: null, snapMark: null, rot: null, busy: false, multi: null, focus: null,   // multi＝複数選択（Shift+クリックで累積・selection は最後の1件・2件以上で頂点編集は無し）
		tool: "select",
		drag: null,        // ドラッグ中の記述（drag.js）
		editGen: 0,        // 編集世代＝「このコミットは最新の編集を含むか」の判定（含むなら隠し/オーバレイを引き継ぐ）
		envGen: 0,         // 環境層世代＝点/blur/帯の**顔ぶれ**が変わった時だけ進む（overlay の描画リスト再構築の鍵。頂点移動では進めない）
		largeDirty: false, // 大規模モード＝自動保存が無い（Phase4）＝未保存編集の有無を beforeunload の警告に使う
	};
	let gridExp = 6;
	let loadGen = 0;   // 直近の読込時点の editGen＝「読込後に編集があったか」（空コミットで自動保存を消してよいかの判定）
	const hist = createHistory();
	const layer = createGintLayer(map);
	const overlay = createOverlay(map, mapEl, () => st);
	// @pop の再生＝エンジンの pop ガジェットへ委譲（v2 ビューアと同一実装＝動きが一致）。
	// 常時表示でなくクリックで開く（編集は選択とかぶるので右クリック「吹き出しを表示」）。× は箱を閉じるだけ。
	const popLayer = createPopLayer(map, () => st);
	// 作図ツールの既定スタイル（=「次に描くもの」の@プロパティ。styleform が toolbar 経由で書く）
	const drawDefaults = { point: {}, text: { "@text": t("Text ##default content") }, line: {}, polygon: {} };

	// ---- トースト ----
	let toastEl = null, toastT = 0;
	const toast = msg => {
		if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "ge-toast"; mapEl.append(toastEl); }
		toastEl.textContent = msg;
		toastEl.classList.remove("gone");
		clearTimeout(toastT);
		toastT = setTimeout(() => toastEl.classList.add("gone"), 2600);
	};

	// ---- 左下バナー（ドックに積む・行動ボタン付き・自動で消える）：起動時の復元通知など「答えを迫らない」告知用（confirm() 廃止 9/4）----
	const banner = (text, action, onAction, ttl = 15000) => {
		const el = document.createElement("div");
		el.className = "ge-banner";
		el.append(Object.assign(document.createElement("span"), { textContent: text }));
		if (action) { const b = document.createElement("button"); b.textContent = action; b.onclick = () => { el.remove(); onAction(); }; el.append(b); }
		const x = document.createElement("button"); x.className = "ge-x"; x.textContent = "×"; x.title = t("Close"); x.onclick = () => el.remove(); el.append(x);
		dockStack(mapEl).append(el);   // display:none は詰むのでドックの掟＝出す/消すは append/remove
		if (ttl) setTimeout(() => el.remove(), ttl);
		return el;
	};

	// ---- 共有文脈（入力モジュールへ渡す。関数は後で足す＝呼ばれる時点で揃っていればよい）----
	const localXY = e => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	// 地図面への押下か＝mapEl の capture 監視は「ツールバー/パネル/確定バー/エンジン家具」の押下も見えてしまう。
	// 家具の上で奪うと setPointerCapture で click の宛先が mapEl に化け、ボタンが押せなくなる（free から抜けられない 9/14）。
	// エンジン自身は canvas に直接 listen＝家具を見ない。ここも同じ土俵に揃える（overlay canvas は pointer-events:none＝地図 canvas が target）
	const onSurface = e => e.target instanceof HTMLCanvasElement;
	// 画面座標→eid：①シンボルの見た目（アイコンは足元アンカー＝絵の位置と実座標がずれるため画面矩形で）②gint識別
	// wide＝移動ツールの掴み（シンボル±10px・点20px・線14px＝通常の約1.7倍。「掴みにくい」本人指摘 9/14）
	const PICK_WIDE = { point: 20, polyline: 14 };
	const pick = (x, y, ll = map.unprojectXY(x, y), wide = false) => ll ? (overlay.symbolAt(x, y, wide ? 10 : 4) ?? layer.identify(ll[0], ll[1], map.getZoom(), wide ? PICK_WIDE : undefined)) : null;
	const ed = { map, mapEl, signal, st, hist, layer, overlay, popLayer, toast, drawDefaults, localXY, pick, onSurface };

	// Shift+クリック＝複数選択（選択に足す/外す・本人裁定 9/15「複数選択は +shift の方がいい」）。エンジンは shift を tilt/回転扱いにして onClick を
	// 出さない（input.js）ため、editClick 経由でなく mapEl で直接拾う。動いた時（shift+ドラッグ＝回転）はエンジンに委ねる。
	// ⌘/Ctrl+クリックも同じ（editClick に修飾が来ないので pointerdown で控える）。@pop は右クリック「吹き出しを表示」で開く（旧＝shift+クリック）。
	let shiftDown = null;   // shift 押下の開始点 [x,y]／非shift は null
	let modDown = false;    // ⌘/Ctrl 押下でのクリック＝複数選択（別名）
	mapEl.addEventListener("pointerdown", e => { shiftDown = e.shiftKey ? localXY(e) : null; modDown = !!(e.metaKey || e.ctrlKey); }, { capture: true, signal });
	mapEl.addEventListener("pointerup", e => {
		const d = shiftDown; shiftDown = null;
		if (!d || st.busy || !st.model || !onSurface(e)) return;
		if (st.tool !== "select" && st.tool !== "move") return;
		const [x, y] = localXY(e);
		if (Math.hypot(x - d[0], y - d[1]) >= 4) return;   // shift+ドラッグ＝回転はエンジンへ
		const eid = pick(x, y, map.unprojectXY(x, y));
		if (eid != null) toggleMulti(eid);
	}, { capture: true, signal });

	// ---- Worker（構築/再抽出）----
	const rpc = createWorkerRpc();

	// ---- コミット（確定層＋自動保存）----
	let commitTimer = 0;
	const scheduleCommit = force => {
		clearTimeout(commitTimer);
		const big = st.model && st.model.stats().vertices >= BIG;
		commitTimer = setTimeout(() => { commitTimer = 0; commit(); }, force ? 0 : big ? 2000 : 300);
	};
	ed.scheduleCommit = scheduleCommit;
	const flushCommit = async () => { await flushRebuild(); clearTimeout(commitTimer); commitTimer = 0; return commit(false); };   // 明示フラッシュ（試験・保存前・全消去前）＝保留中の再抽出も先に着地
	// タブを隠した時（モバイルのアプリ切替・タブ切替）＝デバウンス待ちのコミットを即流す（pagehide では bake が間に合わない）
	document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && commitTimer) { clearTimeout(commitTimer); commitTimer = 0; commit(); } }, { signal });
	// 閉じる直前＝未着地のコミット or 大規模モードの未保存編集があれば確認（自動保存は着地後にしか書けない）
	addEventListener("beforeunload", e => { if (commitTimer || (st.model?.large && st.largeDirty)) { e.preventDefault(); e.returnValue = ""; } }, { signal });
	async function commit(moveCamera = false) {
		if (!st.model) return;
		if (st.model.large) {   // 大規模モード＝スタイルは restyleProps 直送・自動保存なし（Phase4）。幾何編集だけ g再送（rebake）
			if (!st.model.geomDirty) return;
			const genAt = st.editGen;
			const done = await layer.resendLarge(st.model);
			if (done && st.editGen === genAt && !st.drag) {   // 新しい焼きが「この時点までの編集」を含んで着地＝隠しを解く（小規模コミットと同じ引き継ぎ規約）
				st.model.clearGeomDirty();
				layer.unhide();
				st.dragEids = null; st.hidden = null;
				overlay.redraw();
			}
			popLayer.sync();
			return;
		}
		const genAt = st.editGen;
		const done = await layer.commit(st.model, { moveCamera });
		// 新gintが「この時点までの編集」を含んで着地＝隠し/オーバレイの役目をここで初めて引き継ぐ
		//（旧実装はドラッグ終端で即解除＝コミット着地までの間「前のデータ」が顔を出していた＝本人指摘 8/20）
		if (done && st.editGen === genAt && !st.drag) {
			layer.unhide();
			st.dragEids = null; st.hidden = null;
			overlay.redraw();
		}
		popLayer.sync();   // 確定後のアンカーで @pop 箱を再生（ドラッグで隠していた箱を新位置に戻す・削除分を掃く）
		if (layer.saveBuffer) idbSave({ buf: layer.saveBuffer, gridExp, view: map.view?.hash, t: Date.now() });   // 保存＝制御点のまま（@splineの表示細分を保存しない＝再読込の多重細分封じ）
		else if (!st.model.feats.size && st.editGen !== loadGen) idbClear();   // 編集で空になった＝空も「今の姿」＝前回分を残さない（再読込で削除前が復活する穴）。起動時の空セッション（復元を断った直後）は前回分を温存
	}

	// ---- 再抽出（構造操作の後始末＝共有回復）----
	// デバウンス＝add/del/hole の連打を 1 回に畳む（旧＝多重実行ガードだけで、点を 1 個置くたびに全量再抽出が同期で走っていた＝
	// 効率レビュー C-3・2026-09-15）。flushCommit（試験・保存・全消去）は先に flushRebuild で着地させる
	let rebuilding = false, rebuildQueued = false, rebuildTimer = 0;
	const REBUILD_MS = 250;
	const scheduleRebuild = () => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(() => { rebuildTimer = 0; rebuild(); }, REBUILD_MS); };
	const flushRebuild = async () => { if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = 0; await rebuild(); } while (rebuilding) await new Promise(r => setTimeout(r, 10)); };
	async function rebuild() {
		if (!st.model) return;
		if (rebuilding) { rebuildQueued = true; return; }
		rebuilding = true;
		try {
			if (st.model.stats().vertices < SYNC_REBUILD) st.model = rebuildModel(st.model);
			else {
				st.busy = true; toast(t("Rebuilding topology…"));
				const { payload: out, transfer } = topoToTransfer(st.model, { snap: false });   // 送り便＝基底ソート不要
				const res = await rpc.call({ mode: "retopo", payload: out, gridExp: st.model.gridExp }, transfer);
				st.model = adoptRebuilt(topoFromTransfer(res), res.eids, st.model);
				st.busy = false;
			}
		} catch (e) { console.error("[geoedit] rebuild failed", e); st.busy = false; }
		rebuilding = false;
		if (rebuildQueued) { rebuildQueued = false; return rebuild(); }
		overlay.redraw();
	}

	// ---- 読み込み（fc → モデル → コミット）----
	async function finishLoad(model, { fly = true, stripEid = false } = {}) {
		if (stripEid) for (const f of model.feats.values()) if (f.properties && "__eid" in f.properties) { const p2 = { ...f.properties }; delete p2.__eid; f.properties = p2; }   // 復元＝コミット時に注入した__eidを剥がす
		st.model = model; loadGen = st.editGen; st.envGen++;
		for (const w of model.warnings) console.warn("[geoedit]", w);
		hist.clear();
		st.selection = null; st.sketch = null;
		await commit(fly && model.feats.size > 0);
		const stat = model.stats();
		if (stat.features) toast(t("Loaded: $1 features, $2 arcs, $3 vertices", stat.features, stat.arcs, stat.vertices));
		bar.syncHist(hist.canUndo, hist.canRedo);
	}
	async function loadFC(fc, { fly = true } = {}) {   // GeoJSON入口（試験・API互換。大規模の正規経路は loadBuffer）
		try {
			st.busy = true;
			const n = fc.features.length;
			if (n) toast(t("Extracting topology… ($1 features)", n));
			const model = n >= 2000
				? createModel(topoFromTransfer(await rpc.call({ mode: "fc", fc, gridExp })))
				: createModel(buildTopology(fc, gridExp));
			await finishLoad(model, { fly });
		} catch (e) { console.error("[geoedit] load failed", e); toast(t("Failed to load")); }
		finally { st.busy = false; overlay.redraw(); }
	}
	async function loadBuffer(buffer, { fly = true, stripEid = false } = {}) {   // geopbfバイト列＝正規経路（GeoJSON中間なし）
		if (buffer.byteLength >= LARGE_BYTES)   // 取込ルーター①バイト数：閾値超え＝位相抽出せず大規模モードへ（解析はdecoder worker＝createGeopbf配線済み）
			return loadLarge(await new GeoPBF({}).set(buffer), { fly });
		try {
			st.busy = true;
			toast(t("Extracting topology…"));
			const res = await rpc.call({ mode: "pbf", buffer, gridExp, maxVerts: LARGE_VERTS }, [buffer]);
			if (res.large) {   // 取込ルーター②頂点数：Worker が数えて打ち切った＝バッファは返却便で戻る
				toast(t("More than $1 vertices — opening in large mode", LARGE_VERTS.toLocaleString()));
				return await loadLarge(await new GeoPBF({}).set(res.buffer), { fly });
			}
			await finishLoad(createModel(topoFromTransfer(res)), { fly, stripEid });
		} catch (e) { console.error("[geoedit] load failed", e); toast(t("Failed to load")); }
		finally { st.busy = false; overlay.redraw(); }
	}
	// 大規模モード（Phase1＝8/25設計）：gint直表示・identifyAt選択・属性/スタイル/tip/pop編集のみ。
	// ジオメトリ編集はPhase2（GintBUF部分lift）・書き出しはストリーム置換複写（model.toPbf）・自動保存はPhase4。
	async function loadLarge(built, { fly = true } = {}) {
		try {
			st.busy = true;
			toast(t("Large mode: baking GPU data… ($1 features)", built.length.toLocaleString()));
			await built.gint();   // GintBUF＝表示と編集背骨の真実源（facade が polygon/polyline 位相を読む＝model 生成より先）
			const model = createLargeModel(built);
			for (const w of model.warnings) console.warn("[geoedit]", w);
			hist.clear();
			st.selection = null; st.sketch = null; st.multi = null; st.dragEids = null; st.hidden = null; st.focus = null;
			props.close();
			popLayer.clear();
			st.model = model; st.largeDirty = false; st.envGen++;
			setTool("select");
			await layer.applyLarge(built, model.featsArr, { moveCamera: fly });
			toast(t("Large mode: $1 features (attributes, style, vertex moves; add/delete and autosave not yet)", model.feats.size.toLocaleString()));
			bar.syncHist(false, false);
		} catch (e) { console.error("[geoedit] large load failed", e); toast(t("Failed to load")); }
		finally { st.busy = false; overlay.redraw(); }
	}
	async function importFile(file) {
		try {
			toast(t("Converting… $1", file.name));
			const pbf = await geopbf(file, { name: "drop/" + file.name });   // 任意形式→geopbfバイト列（デコードworker）。.geojson は呼ばない
			if (!pbf) return toast(t("Unsupported format"));
			if (pbf.size >= LARGE_BYTES) return loadLarge(pbf);   // 大規模＝この解析済みインスタンスをそのまま真実源に（arrayBufferコピーもしない）
			const buffer = pbf.arrayBuffer;
			pbf.destroy?.();   // デコード器の即時解放（旧世代を残さない）
			await loadBuffer(buffer);
		} catch (e) { console.error("[geoedit] import failed", e); toast(t("Import failed: $1", file.name)); }
	}

	// ---- スナップ ----
	const snapLL = (ll, skip) => {
		const en = st.model?.snap.nearest(ll[0], ll[1], skip);
		if (en) { st.snapMark = [en.x, en.y]; return [en.x, en.y]; }
		st.snapMark = null;
		return ll;
	};
	ed.snapLL = snapLL;

	// ---- 履歴経由の適用（undo/redo・構造操作共通）----
	const GEOM_ONLY = new Set(["move", "movePt", "rot", "insert", "delete"]);   // 顔ぶれ（点/blur/帯の集合）を変えない操作
	const ENV_KEYS = ["@blur", "@poly", "@spline", "@icon", "@shape", "@text", "@size", "@tip", "@pop"];   // 顔ぶれ/描画リストに効く鍵（色・線幅は表だけ）
	const affectedEids = (cmd, res) => {   // このコマンドで gint 表示が古くなるフィーチャ群
		const out = new Set();
		const arcRefs = aid => { const a = st.model.arcs.get(aid); if (a) for (const e of a.refs) out.add(e); };
		if (cmd.op === "move" && res?.dirty) for (const aid of res.dirty) arcRefs(aid);
		else if (cmd.op === "movePt" || cmd.op === "del" || cmd.op === "add" || cmd.op === "hole" || cmd.op === "unhole") out.add(cmd.eid);
		else if (cmd.op === "rot") for (const e of moveTargets(st.model, cmd.eid)) out.add(e);   // rot＝移動ツール（回転移動/ホイール回転）の undo/redo でも隣ごと隠す
		else if (cmd.op === "insert" || cmd.op === "delete") { const r = st.model.resolveAddr(cmd.addr); if (r) arcRefs(r.arcId); }
		else if (cmd.op === "combine") for (const e of cmd.eids) out.add(e);
		else if (cmd.op === "uncombine") for (const p of cmd.parts) out.add(p.eid);
		else if (cmd.op === "split") { out.add(cmd.eid); if (cmd.newEids) for (const e of cmd.newEids) out.add(e); }
		return out;
	};
	const applyR = cmd => {
		const res = st.model.applyCmd(cmd);
		if (cmd.op === "delete" && !res) return false;   // 消せない頂点（端点/最小構成）＝何も起きていない＝隠しも履歴も付けない
		st.editGen++;
		if (!GEOM_ONLY.has(cmd.op)) st.envGen++;
		if (cmd.op === "props") layer.restyleOne(st.model, cmd.eid);   // スタイルは表の即時再焼き（1 件）＝コミットを待たない
		else {
			const aff = affectedEids(cmd, res);
			if (aff.size) { st.dragEids = new Set([...(st.dragEids || []), ...aff]); st.hidden = st.dragEids; layer.hide(st.dragEids); }
		}
		if (cmd.op === "add" || cmd.op === "del" || cmd.op === "hole" || cmd.op === "unhole") { if (st.selection === cmd.eid && cmd.op === "del") { st.selection = null; props.close(); } scheduleRebuild(); }
		if (st.selection != null && !st.model.feats.has(st.selection)) { st.selection = null; props.close(); }   // 束ね等で消えた選択の後始末
		if (cmd.op === "props" && props.eid === cmd.eid) props.render(cmd.eid);   // undo/redo でもパネルを追随
		scheduleCommit();
		overlay.redraw();
		popLayer.sync();   // @pop の生成/文言変化/除去・構造操作(add/del)を箱へ即反映
		return res;
	};
	const doCmd = cmd => {
		if (st.model?.large && cmd.op !== "props" && cmd.op !== "move") { toast(t("Large mode allows attributes, style and vertex moves (add/delete not yet)")); return false; }   // 構造操作（arc数が変わる）はPhase3
		if (applyR(cmd) === false) return false;
		if (st.model.large) st.largeDirty = true;
		hist.push(cmd); bar.syncHist(hist.canUndo, hist.canRedo);
		return true;
	};
	ed.doCmd = doCmd;
	const undo = () => { hist.undo(applyR, c => st.model.invertCmd(c)); bar.syncHist(hist.canUndo, hist.canRedo); };
	const redo = () => { hist.redo(applyR); bar.syncHist(hist.canUndo, hist.canRedo); };

	// ---- 選択パネル（styleform＝日本語UI・生の属性は「属性を表示」でだけ）----
	const props = createPropsPanel(mapEl, {
		getFeature: eid => st.model?.feats.get(eid),
		applyProps: (eid, next, { history = true, from = null } = {}) => {
			if (history) doCmd({ op: "props", eid, from: from ?? st.model.feats.get(eid).properties, to: next });
			else {   // input中の即プレビュー（表は 1 件差し替え＋@pop箱の追随）。顔ぶれ（点/blur/帯の集合）に効く鍵が変わった時だけ envGen を進める（全件走査を 60Hz で起こさない）
				const f = st.model.feats.get(eid), prev = f.properties || {};
				f.properties = next; st.editGen++;
				if (ENV_KEYS.some(k => (prev[k] ?? "") !== (next[k] ?? ""))) st.envGen++;
				layer.restyleOne(st.model, eid); scheduleCommit(); overlay.redraw(); popLayer.sync();
			}
		},
		onDelete: eid => { if (eid != null) doCmd({ op: "del", eid }); },   // パネルの🗑
		toast,
	}, signal);
	ed.props = props;

	// ---- 点の配置（クリック・右クリックメニュー共通）----
	const placePointAt = (ll, defs) => {
		const cmd = { op: "add", feature: { type: "Feature", properties: { ...defs }, geometry: { type: "Point", coordinates: snapLL(ll) } } };
		doCmd(cmd);
		select(cmd.eid);
	};
	ed.placePointAt = placePointAt;

	// ---- 選択 ----
	// 大規模モードの編集近傍＝選択＋arc共有する隣接（暴走ガード64件）。gintを消灯しオーバレイが正確に描く＝
	// LODキャップ（ZCTA=minWeight27焼き付け）や間引きの簡略線が編集ズームで「余計な線」に見える問題の根治（本人特定 8/26）。
	const focusHood = eid => {
		if (eid == null || !st.model?.large) return null;
		const f = st.model.feats.get(eid);
		if (!f || f.coords) return new Set([eid]);
		const hood = new Set([eid]);
		for (const { list } of st.model.listsOf(f)) for (const sref of list)
			for (const nb of (st.model.arcs.get(sref < 0 ? ~sref : sref)?.refs ?? [])) { hood.add(nb); if (hood.size > 64) return new Set([eid]); }
		return hood;
	};
	const select = (eid, { keepMulti = false } = {}) => {
		ed.flushRot?.();   // 選択替え＝進行中のホイール回転（Alt+ホイール）を先に1手へ確定
		st.selection = eid; st.sketch = null;
		if (!keepMulti) st.multi = null;
		if (st.model?.large) { st.focus = focusHood(eid); layer.focus(st.focus); }   // 編集近傍＝gint消灯・オーバレイ描画へ
		eid != null && st.tool === "select" ? props.render(eid) : props.close();   // パネルは選択ツール時のみ（作図中は既定スタイルパネルが主役）。選択表示はオーバレイ一本（大規模も同じ＝gint橙強調は撤去 8/26）
		overlay.redraw();
	};
	ed.select = select;

	// ---- 複数選択とグループ化（本人裁定 9/15＝ツールバーから外し右クリックへ）：Shift（⌘/Ctrl も可）+クリックで選択に足す/外す（selection＝最後の1件・
	//      multi＝全員）。右クリック「グループ化（n件）」＝同族（面同士/線同士）の multi 化。グループ（Multi*）を指して「グループ化解除」。----
	const toggleMulti = eid => {
		if (eid == null) return;
		if (!st.multi) st.multi = new Set(st.selection != null ? [st.selection] : []);
		if (st.multi.has(eid) && st.multi.size > 1) { st.multi.delete(eid); if (st.selection === eid) st.selection = [...st.multi].pop(); }
		else st.multi.add(eid), st.selection = eid;
		if (st.model?.large) { st.focus = focusHood(st.selection); layer.focus(st.focus); }
		st.multi.size > 1 ? props.close() : props.render(st.selection);   // 2件以上＝パネルは閉じる（どの1件の属性か曖昧）
		overlay.redraw();
		if (st.multi.size > 1) toast(t("Selected: $1 (Shift+click to add, right-click to group)", st.multi.size));
	};
	const groupMulti = () => {
		const eids = st.multi ? [...st.multi] : [];
		if (eids.length < 2) return toast(t("Select two or more"));
		const fams = eids.map(e => st.model.familyOf(st.model.feats.get(e)?.type || ""));
		if (fams.includes("point")) return toast(t("Points cannot be grouped (polygons/lines only)"));
		if (new Set(fams).size > 1) return toast(t("Only the same kind can be grouped (polygons with polygons, lines with lines)"));
		doCmd({ op: "combine", eids });   // 代表=先頭。プロパティは代表を継承
		select(eids[0]);
		toast(t("Grouped ($1)", eids.length));
	};
	const isMulti = eid => { const f = eid != null ? st.model?.feats.get(eid) : null; return !!f && (f.type === "MultiPolygon" || f.type === "MultiLineString"); };
	const explodeEid = eid => {   // グループ化解除：指定 multi を単体へ分解（先頭は同eidを再利用）
		if (!isMulti(eid)) return toast(t("This is not a multi"));
		doCmd({ op: "split", eid });
		select(eid);
	};
	Object.assign(ed, { toggleMulti, groupMulti, isMulti, explodeEid });

	// ---- 入力モジュール（作図・ドラッグ・ホバー・右クリック）----
	const sketch = createSketch(ed);
	ed.sketch = sketch;
	const tip = createTip(ed);
	ed.hideTip = tip.hide;
	installDrag(ed);

	// ---- クリック（editClick スロット＝エンジンの4px裁定済み）：ツール別の振り分け ----
	map.setEditClick((x, y) => {
		if (st.busy || !st.model) return;
		const ll = map.unprojectXY(x, y);
		if (!ll) return;
		const tool = st.tool;
		if (tool === "free") return;   // フリーハンド＝ドラッグ作図（sketch.js が pointer 直取り）。クリックでは何も置かない
		if (tool === "select" || tool === "move") { const e = pick(x, y, ll); return modDown ? toggleMulti(e) : select(e); }   // ⌘/Ctrl+クリック＝複数選択。移動ツール＝クリックで対象選択（ドラッグは drag.js）
		if (tool === "point" || tool === "text") {
			if (tool === "text" && !drawDefaults.text["@text"]) return toast(t("Enter the text in the panel first"));
			return placePointAt(ll, drawDefaults[tool]);
		}
		sketch.click(tool, ll);   // line / polygon / hole / rect / circle
	});

	// ---- キーボード ----
	const typing = () => { const t = document.activeElement?.tagName; return t === "INPUT" || t === "TEXTAREA" || document.activeElement?.isContentEditable; };
	const KEY_TOOL = { v: "select", a: "point", t: "text", l: "line", p: "polygon", f: "free", r: "rect", c: "circle", h: "hole", m: "move" };
	addEventListener("keydown", e => {
		if (typing() || st.busy) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
		if (e.key === "Escape") {   // 二段＝①描きかけがあれば描画だけ取り消す（ツールは残る）②無ければ選択ツールへ戻る（本人裁定 9/14「描画後も Esc で抜けられる方が自然」）
			if (st.sketch) { sketch.cancel(); return; }
			select(null);   // multi も捨てる
			if (st.tool !== "select") setTool("select");
			return;
		}
		if (e.key === "Enter") { if (st.sketch) { e.preventDefault(); sketch.finish(); } return; }
		if ((e.key === "Delete" || e.key === "Backspace") && st.selection != null) {
			e.preventDefault();
			const eids = st.multi && st.multi.size > 1 ? [...st.multi] : [st.selection];   // 複数選択＝全部消す（1件ずつのコマンド＝undo も1件ずつ）
			for (const eid of eids) doCmd({ op: "del", eid });
			st.multi = null;
			return;
		}
		if (!mod && !e.altKey && e.key.toLowerCase() === "g") { groupMulti(); return; }   // G＝複数選択をグループ化（右クリックと同じ）
		if (mod || e.altKey) return;   // ⌘C/⌘V/⌘A/⌘L/⌘P/⌘G 等のブラウザ操作をツール切替に化けさせない
		const kt = KEY_TOOL[e.key.toLowerCase()];
		if (kt) setTool(kt);
	}, { signal });

	// ---- ツールバー結線 ----
	const setTool = next => {
		if (st.model?.large && next !== "select") { toast(t("Large mode: selection and attribute/style editing only (no drawing or vertex editing)")); next = "select"; }
		ed.flushRot?.();   // ツール替え＝進行中のホイール回転を先に確定
		st.tool = next;
		sketch.cancel();
		if (next === "line" || next === "polygon" || next === "free" || next === "hole" || next === "rect" || next === "circle") select(null);   // 作図モードに選択は残さない（最初の一打がハンドルドラッグに化ける競合の根治）
		else if (next === "select" && st.selection != null) props.render(st.selection);
		else props.close();               // 点/テキスト/移動ツール＝パネルは出さない or 既定スタイルが主役
		bar.syncTool(next);
	};
	ed.setTool = setTool;
	if (ellipsoidOn()) toast(t("Editing assumes a perfect sphere (ell=0); it differs slightly from the ?ell=1 ellipsoid view"));   // 幾何は球面（大円・回転・小円）＝楕円体表示（?ell=1）では告知だけ
	const getPbf = () => st.model && (st.model.large ? st.model.toPbf() : layer.exportPbf(st.model));   // 書き出し/クラウド共通の口（大規模＝ストリーム置換複写：幾何はバイト複写・属性だけ再エンコード）
	const bar = initToolbar(toolbarEl, {
		setTool, undo, redo,
		gridExp: () => gridExp,
		setGrid: exp => { gridExp = exp; st.model?.setGrid(exp); toast(t("Snap grid: 1e-$1 degrees", exp)); },
		getDefaults: t => drawDefaults[t === "rect" || t === "circle" ? "polygon" : t === "free" ? "line" : t],   // 矩形/円＝面・フリーハンド＝線の既定スタイルを共有
		setDefaults: (t, partial) => { const k = t === "rect" || t === "circle" ? "polygon" : t === "free" ? "line" : t; drawDefaults[k] = mergeProps(drawDefaults[k], partial); },
		importFile,
		exportOpen: () => exportPanel(mapEl, getPbf, toast),
		cloudOpen: () => cloudPanel(mapEl, {
			getPbf,
			loadBuffer: buf => loadBuffer(buf),   // ドロップ取込と同経路＝新セッション扱い
			map,   // 公開サムネの撮影用（map.requestSnapshot・mapEl）
		}, toast),
		// 全消去＝確認ダイアログなし（本人裁定 9/4）。代わりに直前の姿を控え、左下バナー「元に戻す」で15秒間だけ復帰できる
		clearAll: async () => {
			if (!st.model?.feats.size) return toast(t("Nothing to clear"));
			await flushCommit();   // デバウンス待ちの編集も控えに含める
			const keep = layer.saveBuffer ? layer.saveBuffer.slice(0) : (await getPbf())?.arrayBuffer?.slice(0);   // 大規模モード＝自動保存が無いので書き出しの口から
			const grid = gridExp;
			await idbClear();
			await loadFC({ type: "FeatureCollection", features: [] });
			banner(t("Everything cleared"), t("Undo"), () => { gridExp = grid; if (keep) loadBuffer(keep, { fly: false, stripEid: true }); });
		},
	}, signal);
	ed.bar = bar;
	bar.syncHist(false, false);

	const ctxRestore = installContextMenu(ed);   // 本体地図＝既定メニューの項目を差し替え（destroy で戻す）
	initDrop(mapEl, importFile, signal);   // 取り込み（ドロップ）

	// ---- 画面上の「確定／取消」バー（タッチ端末＝Enter/Esc が無い）：作図中（頂点1つ以上）だけ出す。
	//      状態変化は全て overlay.redraw()→frame を通るので、frame フックで差分だけ DOM に反映（gadget の _update と同型）----
	const confirmBar = document.createElement("div");
	confirmBar.className = "ge-confirm"; confirmBar.hidden = true;
	const okB = document.createElement("button"), ngB = document.createElement("button");
	okB.className = "ge-ok"; ngB.className = "ge-cancel";
	confirmBar.append(okB, ngB);
	mapEl.append(confirmBar);
	okB.addEventListener("click", () => { if (st.sketch) sketch.finish(); }, { signal });
	ngB.addEventListener("click", () => { if (st.sketch) sketch.cancel(); }, { signal });
	let confirmSig = "";
	const syncConfirm = () => {
		let sig = "";
		if (st.sketch && st.sketch.coords.length && st.sketch.kind !== "free") sig = st.sketch.kind === "rect" || st.sketch.kind === "circle" ? "two" : `draw:${st.sketch.coords.length}`;   // free＝pointerup が確定＝バー不要
		if (sig === confirmSig) return;
		confirmSig = sig;
		confirmBar.hidden = !sig;
		if (!sig) return;
		okB.hidden = sig === "two";   // 2点作図＝2打目が確定＝「確定」は出さない
		okB.textContent = t("Done");
		ngB.textContent = t("Cancel");
	};
	const unsubConfirm = map.onFrame(syncConfirm);

	// ---- セッション復元 or 空モデルで開始 ----
	// 前回分があれば黙って復元し、左下バナーで告知＋「新規で始める」を添える（起動のたびに confirm() で答えを迫らない＝本人裁定 9/4）。
	const startEmpty = async () => { await loadFC({ type: "FeatureCollection", features: [] }); toast(t("Drop a GIS file, or start drawing with the tools")); };
	(async () => {
		const viewer = adopt ? map.userPbf?.() : null;   // ビューアで開いているデータ（ドロップ/?g=）＝そのまま編集へ（自動保存より優先＝「見ている物を編む」）
		if (viewer) {
			if (viewer.size >= LARGE_BYTES) await loadLarge(viewer); else await loadBuffer(viewer.arrayBuffer.slice(0), { stripEid: true });   // 自分の焼き（__eid 入り）を拾い直す場合もある＝剥がす（他人のデータには無害）
			banner(t("Opened the data shown in the viewer for editing"), null, null);
			return;
		}
		const rec = await idbLoad();
		if (!rec?.buf) return startEmpty();
		gridExp = rec.gridExp ?? 6;
		if (rec.view) location.hash = rec.view;
		await loadBuffer(rec.buf, { fly: !rec.view, stripEid: true });   // コミット由来の__eidは剥がす
		const when = rec.t ? new Date(rec.t).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
		banner(t("Previous session restored") + (when ? `（${when}）` : ""), t("Start fresh"), async () => { await idbClear(); startEmpty(); });
	})();

	return {
		destroy() {
			ac.abort(); map.setEditClick(null); overlay.destroy(); popLayer.destroy(); clearTimeout(commitTimer); clearTimeout(rebuildTimer); tip.hide(); rpc.terminate(); unsubConfirm();
			confirmBar.remove(); toolbarEl.remove(); props.close(); mapEl.querySelectorAll(".ge-panel, .ge-toast, .ge-banner").forEach(el => el.remove());
			map.setMaxPitch?.(prevMaxPitch ?? null); map.setZoomMin?.(prevZoomMin ?? null); setDropOwner?.(false); ctxRestore?.(); mapEl.classList.remove("ge-on");
		},
		get state() { return st; },
		get model() { return st.model; },
		commitNow: flushCommit,
		layer,   // デバッグの手すり（identify/pbf の検分用。公式口ではない）
		decode: file => geopbf(file, { name: "decode/" + file.name }),   // 同じく手すり＝自バンドルのgeopbfで任意ファイルを解く（計測・検分用）
		loadFC, loadBuffer, importFile, toast,
	};
}
