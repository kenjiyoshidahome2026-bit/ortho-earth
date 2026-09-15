import { unPackGintBuffer } from "../extension/topology.js";
// 返り便＝内部 buffer（unpack が slice した 1 本＝全ビューの共有元）を transfer（旧＝structured clone＋ネスト配列まで複写）。
// polygon/polyline/neighbors は非列挙の遅延 accessor＝clone に乗らない＝受け側（pbf.js setGintBUF）が attachLazyStreams を掛け直す
onmessage = ({ data: { sab } }) => {
	const d = unPackGintBuffer(sab);
	const b = d ? (d.arcBuffer ?? d.pointBuffer ?? d.arcMeta ?? d.polyStream)?.buffer : null;
	postMessage(d, b ? [b] : []);
};
