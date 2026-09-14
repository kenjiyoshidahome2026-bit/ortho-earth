// PLATEAU バッチデコーダ（②区内デコード並列化・2026-08-28）：plateauworker が発注する「バッチ丸ごと」
//（fetch→b3dm/Draco解凍→ECEF→世界座標→dedup→接地→LOD→RTE→マスク断片）を別コアで実行して返すだけの器。
// 実体は全て plateaudecode.js＝区workerの直列経路と同一関数（経路差ゼロ）。区単位の状態（wardMask累積・
// IDB/OPFS・far-DB・クレジット・レーン）は一切持たない＝返した mesh の扱いは発注元が決める。
// stopJobs＝協調キャンセル：残りタイルの fetch をタイル境界で打ち切る（完成していても発注元が捨てる掟）。
// 発注元は busy 管理で1デコーダ1件しか出さない＝ここに並行キューは要らない。
import { decodeBatch, setDecodeEnv } from "./plateaudecode.js";

const stopped = new Set();
let out = self;   // 返信先：main が渡した MessagePort（区 worker 直結）。port 未受領の間は self（互換）
const handle = async d => {
	if (d.init) { setDecodeEnv({ ell: !!d.init.ell, exclude: d.init.exclude ?? undefined }); return; }
	if ("exclude" in d && !d.init) { setDecodeEnv({ exclude: d.exclude }); return; }   // タイル並行は既定8/デコーダ＝プール本数×8が区の実効並行
	if (d.stopJobs) { for (const j of d.stopJobs) stopped.add(j); return; }
	const stop = () => stopped.has(d.job);
	let mesh = null;
	try { mesh = await decodeBatch(d.base, d.leaves, null, d.wardBbox, () => out.postMessage({ tick: d.job }), d.brid, stop, null); }
	catch (err) { console.warn("[plateau] pooled batch failed", d.base, err?.message ?? err); }
	const dropped = stop(); stopped.delete(d.job);
	if (dropped || !mesh) { out.postMessage({ job: d.job, mesh: null }); return; }
	const tr = [mesh.pos.buffer, mesh.nrm.buffer, mesh.idx.buffer];   // transfer＝バッチ実体のコピーを作らない
	if (mesh.maskCells) tr.push(mesh.maskCells.buffer);
	out.postMessage({ job: d.job, mesh }, tr);
};
// main からの最初の便＝{init:{port}}：以後の会話（init/exclude/job/stopJobs → tick/job）は全部その port（区 worker 直結）。
// 入れ子 worker（区 worker が直接 new Worker）は使わない＝worker の所有者は main（2026-09-14）。
self.onmessage = e => {
	const d = e.data;
	if (d.init?.port) { out = d.init.port; out.onmessage = ev => handle(ev.data); return; }
	handle(d);
};
