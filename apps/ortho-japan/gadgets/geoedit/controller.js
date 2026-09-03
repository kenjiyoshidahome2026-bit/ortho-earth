// 編集コントローラ＝状態機械と結線の中枢（読込/コミット/再抽出のパイプライン・コマンド適用と履歴・選択/束ね・ツール・鍵盤）。
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
import { tr } from "../../i18n.js";   // UI二言語化（ja正典・en辞書引き＝エンジン i18n.js の流儀。辞書は各モジュール持参）
const t = tr({
	"テキスト": "Text",
	"閉じる": "Close",
	"トポロジ再抽出中…": "Rebuilding topology…",
	"読込完了：{0}フィーチャ・{1}arc・{2}頂点": "Loaded: {0} features, {1} arcs, {2} vertices",
	"トポロジ抽出中…（{0}フィーチャ）": "Extracting topology… ({0} features)",
	"読み込みに失敗しました": "Failed to load",
	"トポロジ抽出中…": "Extracting topology…",
	"頂点数が {0} を超えるため大規模モードで開きます": "More than {0} vertices — opening in large mode",
	"大規模モード：GPUデータを焼いています…（{0}フィーチャ）": "Large mode: baking GPU data… ({0} features)",
	"大規模モード：{0}フィーチャ（属性・スタイル・頂点移動／追加削除と自動保存はまだ）": "Large mode: {0} features (attributes, style, vertex moves; add/delete and autosave not yet)",
	"変換中… {0}": "Converting… {0}",
	"対応していない形式です": "Unsupported format",
	"取込失敗: {0}": "Import failed: {0}",
	"大規模モードでは属性・スタイルと頂点移動ができます（追加/削除はまだ）": "Large mode allows attributes, style and vertex moves (add/delete not yet)",
	"点は束ねられません（面/線のみ）": "Points cannot be combined (polygons/lines only)",
	"同じ種類（面同士／線同士）だけ束ねられます": "Only the same kind can be combined (polygons with polygons, lines with lines)",
	"束ね: {0}件（Enterで確定・Escで取消）": "Combine: {0} selected (Enter to confirm, Esc to cancel)",
	"2つ以上選んでください": "Select two or more",
	"これは multi ではありません": "This is not a multi",
	"分解する要素を選択してください": "Select a feature to split",
	"パネルに文字を入れてから置いてください": "Enter the text in the panel first",
	"束ね取消": "Combine cancelled",
	"大規模モード＝選択と属性・スタイル編集のみ（作図・頂点編集は不可）": "Large mode: selection and attribute/style editing only (no drawing or vertex editing)",
	"束ねる要素をクリック→Enterで確定（Escで取消）": "Click features to combine → Enter to confirm (Esc to cancel)",
	"スナップ格子: 1e-{0} 度": "Snap grid: 1e-{0} degrees",
	"消すものがありません": "Nothing to clear",
	"全て消去しました": "Everything cleared",
	"元に戻す": "Undo",
	"合成を確定（{0}件）": "Confirm combine ({0})",
	"確定": "Done",
	"取消": "Cancel",
	"GISファイルをドロップ、またはツールで作図を始めてください": "Drop a GIS file, or start drawing with the tools",
	"前回の編集を復元しました": "Previous session restored",
	"新規で始める": "Start fresh",
	"表示中のデータを編集に取り込みました": "Opened the data shown in the viewer for editing",
});

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
	setDropOwner?.(true);
	// ツールバー＝mapEl 直下（DOM順＝エンジン家具の後＝上に重なる。z-index 不使用の掟）
	const toolbarEl = document.createElement("div");
	toolbarEl.id = "ge-toolbar"; toolbarEl.hidden = true;
	mapEl.append(toolbarEl);
	// 可変状態は全部ここ（各入力モジュールと共有）
	const st = {
		model: null, selection: null, dragEids: null, hidden: null, sketch: null, snapMark: null, busy: false, bundle: null, focus: null,
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
	// 常時表示でなくクリックで開く（編集は選択とかぶるので shift+click）。× は箱を閉じるだけ。
	const popLayer = createPopLayer(map, () => st);
	// 作図ツールの既定スタイル（=「次に描くもの」の@プロパティ。styleform が toolbar 経由で書く）
	const drawDefaults = { point: {}, text: { "@text": t("テキスト") }, line: {}, polygon: {} };

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
		const x = document.createElement("button"); x.className = "ge-x"; x.textContent = "×"; x.title = t("閉じる"); x.onclick = () => el.remove(); el.append(x);
		dockStack(mapEl).append(el);   // display:none は詰むのでドックの掟＝出す/消すは append/remove
		if (ttl) setTimeout(() => el.remove(), ttl);
		return el;
	};

	// ---- 共有文脈（入力モジュールへ渡す。関数は後で足す＝呼ばれる時点で揃っていればよい）----
	const localXY = e => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	// 画面座標→eid：①シンボルの見た目（アイコンは足元アンカー＝絵の位置と実座標がずれるため画面矩形で）②gint識別
	const pick = (x, y, ll = map.unprojectXY(x, y)) => ll ? (overlay.symbolAt(x, y) ?? layer.identify(ll[0], ll[1], map.getZoom())) : null;
	const ed = { map, mapEl, signal, st, hist, layer, overlay, popLayer, toast, drawDefaults, localXY, pick };

	// Shift+クリック＝その要素の @pop を開く。エンジンは shift を tilt/回転扱いにして onClick を出さない（input.js）ため、
	// editClick 経由でなく mapEl で直接拾う。動いた時（shift+ドラッグ＝回転）はエンジンに委ねる（pop にしない）。
	let shiftDown = null;   // shift 押下の開始点 [x,y]／非shift は null
	mapEl.addEventListener("pointerdown", e => { shiftDown = e.shiftKey ? localXY(e) : null; }, { capture: true, signal });
	mapEl.addEventListener("pointerup", e => {
		const d = shiftDown; shiftDown = null;
		if (!d || st.busy || !st.model) return;
		const [x, y] = localXY(e);
		if (Math.hypot(x - d[0], y - d[1]) >= 4) return;   // shift+ドラッグ＝回転はエンジンへ（pop にしない）
		const ll = map.unprojectXY(x, y);
		const eid = pick(x, y, ll);
		if (eid != null) popLayer.open(eid, { x, y, ll });   // クリック点＝tip の場所に開く／ll＝参照点（面=クリック点・線=最寄り線分上）
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
	const flushCommit = () => { clearTimeout(commitTimer); commitTimer = 0; return commit(false); };   // 明示フラッシュ（試験・保存前・全消去前）
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
	let rebuilding = false, rebuildQueued = false;
	async function rebuild() {
		if (!st.model) return;
		if (rebuilding) { rebuildQueued = true; return; }
		rebuilding = true;
		try {
			if (st.model.stats().vertices < SYNC_REBUILD) st.model = rebuildModel(st.model);
			else {
				st.busy = true; toast(t("トポロジ再抽出中…"));
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
		if (stat.features) toast(t("読込完了：{0}フィーチャ・{1}arc・{2}頂点", stat.features, stat.arcs, stat.vertices));
		bar.syncHist(hist.canUndo, hist.canRedo);
	}
	async function loadFC(fc, { fly = true } = {}) {   // GeoJSON入口（試験・API互換。大規模の正規経路は loadBuffer）
		try {
			st.busy = true;
			const n = fc.features.length;
			if (n) toast(t("トポロジ抽出中…（{0}フィーチャ）", n));
			const model = n >= 2000
				? createModel(topoFromTransfer(await rpc.call({ mode: "fc", fc, gridExp })))
				: createModel(buildTopology(fc, gridExp));
			await finishLoad(model, { fly });
		} catch (e) { console.error("[geoedit] load failed", e); toast(t("読み込みに失敗しました")); }
		finally { st.busy = false; overlay.redraw(); }
	}
	async function loadBuffer(buffer, { fly = true, stripEid = false } = {}) {   // geopbfバイト列＝正規経路（GeoJSON中間なし）
		if (buffer.byteLength >= LARGE_BYTES)   // 取込ルーター①バイト数：閾値超え＝位相抽出せず大規模モードへ（解析はdecoder worker＝createGeopbf配線済み）
			return loadLarge(await new GeoPBF({}).set(buffer), { fly });
		try {
			st.busy = true;
			toast(t("トポロジ抽出中…"));
			const res = await rpc.call({ mode: "pbf", buffer, gridExp, maxVerts: LARGE_VERTS }, [buffer]);
			if (res.large) {   // 取込ルーター②頂点数：Worker が数えて打ち切った＝バッファは返却便で戻る
				toast(t("頂点数が {0} を超えるため大規模モードで開きます", LARGE_VERTS.toLocaleString()));
				return await loadLarge(await new GeoPBF({}).set(res.buffer), { fly });
			}
			await finishLoad(createModel(topoFromTransfer(res)), { fly, stripEid });
		} catch (e) { console.error("[geoedit] load failed", e); toast(t("読み込みに失敗しました")); }
		finally { st.busy = false; overlay.redraw(); }
	}
	// 大規模モード（Phase1＝8/25設計）：gint直表示・identifyAt選択・属性/スタイル/tip/pop編集のみ。
	// ジオメトリ編集はPhase2（GintBUF部分lift）・書き出しはストリーム置換複写（model.toPbf）・自動保存はPhase4。
	async function loadLarge(built, { fly = true } = {}) {
		try {
			st.busy = true;
			toast(t("大規模モード：GPUデータを焼いています…（{0}フィーチャ）", built.length.toLocaleString()));
			await built.gint();   // GintBUF＝表示と編集背骨の真実源（facade が polygon/polyline 位相を読む＝model 生成より先）
			const model = createLargeModel(built);
			for (const w of model.warnings) console.warn("[geoedit]", w);
			hist.clear();
			st.selection = null; st.sketch = null; st.bundle = null; st.dragEids = null; st.hidden = null; st.focus = null;
			props.close();
			popLayer.clear();
			st.model = model; st.largeDirty = false; st.envGen++;
			setTool("select");
			await layer.applyLarge(built, model.featsArr, { moveCamera: fly });
			toast(t("大規模モード：{0}フィーチャ（属性・スタイル・頂点移動／追加削除と自動保存はまだ）", model.feats.size.toLocaleString()));
			bar.syncHist(false, false);
		} catch (e) { console.error("[geoedit] large load failed", e); toast(t("読み込みに失敗しました")); }
		finally { st.busy = false; overlay.redraw(); }
	}
	async function importFile(file) {
		try {
			toast(t("変換中… {0}", file.name));
			const pbf = await geopbf(file, { name: "drop/" + file.name });   // 任意形式→geopbfバイト列（デコードworker）。.geojson は呼ばない
			if (!pbf) return toast(t("対応していない形式です"));
			if (pbf.size >= LARGE_BYTES) return loadLarge(pbf);   // 大規模＝この解析済みインスタンスをそのまま真実源に（arrayBufferコピーもしない）
			const buffer = pbf.arrayBuffer;
			pbf.destroy?.();   // デコード器の即時解放（旧世代を残さない）
			await loadBuffer(buffer);
		} catch (e) { console.error("[geoedit] import failed", e); toast(t("取込失敗: {0}", file.name)); }
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
	const GEOM_ONLY = new Set(["move", "movePt", "tr", "insert", "delete"]);   // 顔ぶれ（点/blur/帯の集合）を変えない操作
	const affectedEids = (cmd, res) => {   // このコマンドで gint 表示が古くなるフィーチャ群
		const out = new Set();
		const arcRefs = aid => { const a = st.model.arcs.get(aid); if (a) for (const e of a.refs) out.add(e); };
		if (cmd.op === "move" && res?.dirty) for (const aid of res.dirty) arcRefs(aid);
		else if (cmd.op === "movePt" || cmd.op === "del" || cmd.op === "add" || cmd.op === "hole" || cmd.op === "unhole") out.add(cmd.eid);
		else if (cmd.op === "tr") for (const e of moveTargets(st.model, cmd.eid)) out.add(e);
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
		if (cmd.op === "props") layer.restyleProps(st.model);   // スタイルは表の即時再焼き＝コミットを待たない
		else {
			const aff = affectedEids(cmd, res);
			if (aff.size) { st.dragEids = new Set([...(st.dragEids || []), ...aff]); st.hidden = st.dragEids; layer.hide(st.dragEids); }
		}
		if (cmd.op === "add" || cmd.op === "del" || cmd.op === "hole" || cmd.op === "unhole") { if (st.selection === cmd.eid && cmd.op === "del") { st.selection = null; props.close(); } rebuild(); }
		if (st.selection != null && !st.model.feats.has(st.selection)) { st.selection = null; props.close(); }   // 束ね等で消えた選択の後始末
		if (cmd.op === "props" && props.eid === cmd.eid) props.render(cmd.eid);   // undo/redo でもパネルを追随
		scheduleCommit();
		overlay.redraw();
		popLayer.sync();   // @pop の生成/文言変化/除去・構造操作(add/del)を箱へ即反映
		return res;
	};
	const doCmd = cmd => {
		if (st.model?.large && cmd.op !== "props" && cmd.op !== "move") { toast(t("大規模モードでは属性・スタイルと頂点移動ができます（追加/削除はまだ）")); return false; }   // 構造操作（arc数が変わる）はPhase3
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
			else { st.model.feats.get(eid).properties = next; st.editGen++; st.envGen++; layer.restyleProps(st.model); scheduleCommit(); overlay.redraw(); popLayer.sync(); }   // input中の即プレビュー（表の即時再焼き＋@pop箱の追随）
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
	const select = eid => {
		st.selection = eid; st.sketch = null;
		if (st.model?.large) { st.focus = focusHood(eid); layer.focus(st.focus); }   // 編集近傍＝gint消灯・オーバレイ描画へ
		eid != null && st.tool === "select" ? props.render(eid) : props.close();   // パネルは選択ツール時のみ（作図中は既定スタイルパネルが主役）。選択表示はオーバレイ一本（大規模も同じ＝gint橙強調は撤去 8/26）
		overlay.redraw();
	};
	ed.select = select;

	// ---- 束ね（multi化）：束ねツールでクリック累積→Enterで確定。同族（面同士/線同士）のみ。----
	const toggleBundle = eid => {
		if (!st.bundle) st.bundle = new Set();
		if (st.bundle.has(eid)) st.bundle.delete(eid);
		else {
			const f = st.model.feats.get(eid); if (!f) return;
			const fam = st.model.familyOf(f.type);
			if (fam === "point") return toast(t("点は束ねられません（面/線のみ）"));
			const first = st.bundle.values().next().value;
			if (first != null) { const ff = st.model.feats.get(first); if (ff && st.model.familyOf(ff.type) !== fam) return toast(t("同じ種類（面同士／線同士）だけ束ねられます")); }
			st.bundle.add(eid);
		}
		overlay.redraw();
		if (st.bundle.size) toast(t("束ね: {0}件（Enterで確定・Escで取消）", st.bundle.size));
	};
	const confirmBundle = () => {
		const eids = st.bundle ? [...st.bundle] : [];
		if (eids.length < 2) return toast(t("2つ以上選んでください"));
		doCmd({ op: "combine", eids });   // 代表=先頭。プロパティは代表を継承
		st.bundle = null;
		setTool("select");
		select(eids[0]);
	};
	const isMulti = eid => { const f = eid != null ? st.model?.feats.get(eid) : null; return !!f && (f.type === "MultiPolygon" || f.type === "MultiLineString"); };
	const explodeEid = eid => {   // ばらす：指定 multi を単体へ分解（先頭は同eidを再利用）
		if (!isMulti(eid)) return toast(t("これは multi ではありません"));
		doCmd({ op: "split", eid });
		select(eid);
	};
	const explode = () => { st.selection == null ? toast(t("分解する要素を選択してください")) : explodeEid(st.selection); };
	const startBundleWith = eid => { setTool("bundle"); if (eid != null) toggleBundle(eid); };   // 合成開始＝束ねモードに入り、指定要素を最初の仲間に
	Object.assign(ed, { confirmBundle, isMulti, explodeEid, startBundleWith });

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
		if (tool === "bundle") {   // 束ね＝クリックで対象を選集合へ足す/外す（Enterで確定）
			const eid = pick(x, y, ll);
			if (eid != null) toggleBundle(eid);
			return;
		}
		if (tool === "select" || tool === "move") return select(pick(x, y, ll));   // 移動ツール＝クリックで対象選択（ドラッグは drag.js）
		if (tool === "point" || tool === "text") {
			if (tool === "text" && !drawDefaults.text["@text"]) return toast(t("パネルに文字を入れてから置いてください"));
			return placePointAt(ll, drawDefaults[tool]);
		}
		sketch.click(tool, ll);   // line / polygon / hole / rect / circle
	});

	// ---- キーボード ----
	const typing = () => { const t = document.activeElement?.tagName; return t === "INPUT" || t === "TEXTAREA" || document.activeElement?.isContentEditable; };
	const KEY_TOOL = { v: "select", a: "point", t: "text", l: "line", p: "polygon", r: "rect", c: "circle", h: "hole", m: "move", g: "bundle" };
	addEventListener("keydown", e => {
		if (typing() || st.busy) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
		if (e.key === "Escape") { sketch.cancel(); if (st.bundle) { st.bundle = null; overlay.redraw(); toast(t("束ね取消")); } select(null); return; }
		if (e.key === "Enter") { if (st.sketch) { e.preventDefault(); sketch.finish(); } else if (st.tool === "bundle") { e.preventDefault(); confirmBundle(); } return; }
		if ((e.key === "Delete" || e.key === "Backspace") && st.selection != null) {
			e.preventDefault();
			doCmd({ op: "del", eid: st.selection });
			return;
		}
		if (mod || e.altKey) return;   // ⌘C/⌘V/⌘A/⌘L/⌘P/⌘G 等のブラウザ操作をツール切替に化けさせない
		const kt = KEY_TOOL[e.key.toLowerCase()];
		if (kt) setTool(kt);
	}, { signal });

	// ---- ツールバー結線 ----
	const setTool = next => {
		if (st.model?.large && next !== "select") { toast(t("大規模モード＝選択と属性・スタイル編集のみ（作図・頂点編集は不可）")); next = "select"; }
		const wasBundle = st.tool === "bundle";
		st.tool = next;
		sketch.cancel();
		if (wasBundle && next !== "bundle" && st.bundle) { st.bundle = null; overlay.redraw(); }   // 束ねツールを抜けたら選集合を捨てる
		if (next === "bundle") { select(null); st.bundle = new Set(); toast(t("束ねる要素をクリック→Enterで確定（Escで取消）")); overlay.redraw(); }
		else if (next === "line" || next === "polygon" || next === "hole" || next === "rect" || next === "circle") select(null);   // 作図モードに選択は残さない（最初の一打がハンドルドラッグに化ける競合の根治）
		else if (next === "select" && st.selection != null) props.render(st.selection);
		else props.close();               // 点/テキスト/移動ツール＝パネルは出さない or 既定スタイルが主役
		bar.syncTool(next);
	};
	ed.setTool = setTool;
	const getPbf = () => st.model && (st.model.large ? st.model.toPbf() : layer.exportPbf(st.model));   // 書き出し/クラウド共通の口（大規模＝ストリーム置換複写：幾何はバイト複写・属性だけ再エンコード）
	const bar = initToolbar(toolbarEl, {
		setTool, undo, redo, explode,
		gridExp: () => gridExp,
		setGrid: exp => { gridExp = exp; st.model?.setGrid(exp); toast(t("スナップ格子: 1e-{0} 度", exp)); },
		getDefaults: t => drawDefaults[t === "rect" || t === "circle" ? "polygon" : t],   // 矩形/円＝面の既定スタイルを共有
		setDefaults: (t, partial) => { const k = t === "rect" || t === "circle" ? "polygon" : t; drawDefaults[k] = mergeProps(drawDefaults[k], partial); },
		importFile,
		exportOpen: () => exportPanel(mapEl, getPbf, toast),
		cloudOpen: () => cloudPanel(mapEl, {
			getPbf,
			loadBuffer: buf => loadBuffer(buf),   // ドロップ取込と同経路＝新セッション扱い
			map,   // 公開サムネの撮影用（map.requestSnapshot・mapEl）
		}, toast),
		// 全消去＝確認ダイアログなし（本人裁定 9/4）。代わりに直前の姿を控え、左下バナー「元に戻す」で15秒間だけ復帰できる
		clearAll: async () => {
			if (!st.model?.feats.size) return toast(t("消すものがありません"));
			await flushCommit();   // デバウンス待ちの編集も控えに含める
			const keep = layer.saveBuffer ? layer.saveBuffer.slice(0) : (await getPbf())?.arrayBuffer?.slice(0);   // 大規模モード＝自動保存が無いので書き出しの口から
			const grid = gridExp;
			await idbClear();
			await loadFC({ type: "FeatureCollection", features: [] });
			banner(t("全て消去しました"), t("元に戻す"), () => { gridExp = grid; if (keep) loadBuffer(keep, { fly: false, stripEid: true }); });
		},
	}, signal);
	ed.bar = bar;
	bar.syncHist(false, false);

	const ctxRestore = installContextMenu(ed);   // 本体地図＝既定メニューの項目を差し替え（destroy で戻す）
	initDrop(mapEl, importFile, signal);   // 取り込み（ドロップ）

	// ---- 画面上の「確定／取消」バー（タッチ端末＝Enter/Esc が無い）：作図中（頂点1つ以上）と束ね中だけ出す。
	//      状態変化は全て overlay.redraw()→frame を通るので、frame フックで差分だけ DOM に反映（gadget の _update と同型）----
	const confirmBar = document.createElement("div");
	confirmBar.className = "ge-confirm"; confirmBar.hidden = true;
	const okB = document.createElement("button"), ngB = document.createElement("button");
	okB.className = "ge-ok"; ngB.className = "ge-cancel";
	confirmBar.append(okB, ngB);
	mapEl.append(confirmBar);
	okB.addEventListener("click", () => { if (st.sketch) sketch.finish(); else if (st.tool === "bundle") confirmBundle(); }, { signal });
	ngB.addEventListener("click", () => { if (st.sketch) sketch.cancel(); else if (st.tool === "bundle") setTool("select"); }, { signal });
	let confirmSig = "";
	const syncConfirm = () => {
		let sig = "";
		if (st.sketch && st.sketch.coords.length) sig = st.sketch.kind === "rect" || st.sketch.kind === "circle" ? "two" : `draw:${st.sketch.coords.length}`;
		else if (st.tool === "bundle") sig = `bundle:${st.bundle?.size || 0}`;
		if (sig === confirmSig) return;
		confirmSig = sig;
		confirmBar.hidden = !sig;
		if (!sig) return;
		okB.hidden = sig === "two";   // 2点作図＝2打目が確定＝「確定」は出さない
		okB.textContent = sig.startsWith("bundle") ? t("合成を確定（{0}件）", st.bundle?.size || 0) : t("確定");
		ngB.textContent = t("取消");
	};
	const unsubConfirm = map.onFrame(syncConfirm);

	// ---- セッション復元 or 空モデルで開始 ----
	// 前回分があれば黙って復元し、左下バナーで告知＋「新規で始める」を添える（起動のたびに confirm() で答えを迫らない＝本人裁定 9/4）。
	const startEmpty = async () => { await loadFC({ type: "FeatureCollection", features: [] }); toast(t("GISファイルをドロップ、またはツールで作図を始めてください")); };
	(async () => {
		const viewer = adopt ? map.userPbf?.() : null;   // ビューアで開いているデータ（ドロップ/?g=）＝そのまま編集へ（自動保存より優先＝「見ている物を編む」）
		if (viewer) {
			if (viewer.size >= LARGE_BYTES) await loadLarge(viewer); else await loadBuffer(viewer.arrayBuffer.slice(0), { stripEid: true });   // 自分の焼き（__eid 入り）を拾い直す場合もある＝剥がす（他人のデータには無害）
			banner(t("表示中のデータを編集に取り込みました"), null, null);
			return;
		}
		const rec = await idbLoad();
		if (!rec?.buf) return startEmpty();
		gridExp = rec.gridExp ?? 6;
		if (rec.view) location.hash = rec.view;
		await loadBuffer(rec.buf, { fly: !rec.view, stripEid: true });   // コミット由来の__eidは剥がす
		const when = rec.t ? new Date(rec.t).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
		banner(t("前回の編集を復元しました") + (when ? `（${when}）` : ""), t("新規で始める"), async () => { await idbClear(); startEmpty(); });
	})();

	return {
		destroy() {
			ac.abort(); map.setEditClick(null); overlay.destroy(); popLayer.destroy(); clearTimeout(commitTimer); tip.hide(); rpc.terminate(); unsubConfirm();
			confirmBar.remove(); toolbarEl.remove(); props.close(); mapEl.querySelectorAll(".ge-panel, .ge-toast, .ge-banner").forEach(el => el.remove());
			map.setMaxPitch?.(prevMaxPitch ?? null); map.setZoomMin?.(prevZoomMin ?? null); setDropOwner?.(false); ctxRestore?.();
		},
		get state() { return st; },
		get model() { return st.model; },
		commitNow: flushCommit,
		layer,   // デバッグの手すり（identify/pbf の検分用。公式口ではない）
		decode: file => geopbf(file, { name: "decode/" + file.name }),   // 同じく手すり＝自バンドルのgeopbfで任意ファイルを解く（計測・検分用）
		loadFC, loadBuffer, importFile, toast,
	};
}
