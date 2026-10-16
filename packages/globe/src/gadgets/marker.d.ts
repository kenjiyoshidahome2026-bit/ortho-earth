// gadgets/marker.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝marker.js が TS になれば消える。
// 型の正本は globe.d.ts の Marker／Popup（export の口と map.Marker／map.Popup は同じ class）
export { Marker, Popup } from "../../globe.d.ts";
