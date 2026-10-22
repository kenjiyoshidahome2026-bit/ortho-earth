import { unPackGintBuffer } from "../extension/topology.ts";
import type { GintDecodeRequest, GintDecodeResponse } from "../worker-msg.ts";
// 返り便＝内部 buffer（unpack が slice した 1 本＝全ビューの共有元）を transfer（旧＝structured clone＋ネスト配列まで複写）。
// polygon/polyline/neighbors は非列挙の遅延 accessor＝clone に乗らない＝受け側（pbf.js setGintBUF）が attachLazyStreams を掛け直す
// 2026-10-11 ゼロコピー: unpack は渡されたバッファの上に view を切る＝SAB なら共有のまま返す（transfer 不可・不要）、
// ArrayBuffer（Safari＝SAB 無し・structured clone で届いた写し）なら transfer で返す
onmessage = ({ data: { sab } }: MessageEvent<GintDecodeRequest>) => {
	const d = unPackGintBuffer(sab);
	// 解けない（版検札落ち＝旧キャッシュ等）は null ではなく印で返す。null は workerPool が「脚本の読込失敗」として reject する約束＝
	// setGintBUF が例外で抜け、呼び手の自己修復（_staleGint→再焼き→上書き保存）に届かず旧 GINT が IDB に居座っていた（2026-10-21 N02 駅）
	if (!d) { postMessage({ unpackFailed: true } satisfies GintDecodeResponse); return; }
	const b = (d.arcBuffer ?? d.pointBuffer ?? d.arcMeta ?? d.polyStream)?.buffer;
	postMessage(d, b instanceof ArrayBuffer ? [b] : []);
};
