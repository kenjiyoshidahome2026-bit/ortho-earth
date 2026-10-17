// 人工衛星ビューア＝いま軌道にいる衛星（CelesTrak GP・active 約 1.6 万機）を地球儀のまわりに実時刻で立体表示する＝地震（quakes.html＝地下）と対の「3D の地上」。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域なし）を自分の束に焼いてエンジンを起こし（quakes.html と同型）、
// 描画と案内板は ./sats.js（遅延 chunk・GPU 描画は sats-gl.js＝レンダーワーカー内の同一フレーム）。
// データ＝ミラー（www.ortho-earth.com/sats/active.csv＝apps/sats-mirror・CORS 開放）→ だめなら CelesTrak 直読み。ブラウザが SGP4 で伝播する（鯖焼き無し）。
// ?src=URL で差し替え可（CSV・OMM 形式）。
// 言語（html の lang/dir）・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。文言（title/description/パネル）は sats.js が t() で組む
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("sats", async () => {
	const [{ createGlobe }, { mountSats, MIRROR, CELESTRAK }] = await Promise.all([import("@ortho-earth/globe"), import("./sats.js")]);
	// 初期視点＝地球を少し引いて眺める（低軌道の殻と中軌道が見える距離。静止軌道はさらに引く）（共有 URL の hash があればそちら）
	const map = await createGlobe({ target: "#map", view: location.hash || "#1.9/25/140", chips: false, zoomMax: 8,   // 世界のアプリ＝地球儀（地域の申告なし・z<8＝LAYERS.md 段階 2 S6）
		// glOverlay＝同一フレームのオーバーレイ（人工衛星）を重ねる宣言。WebKit は本体が WebGPU だとこの 2 枚目が描かれない（本人 iPad 実機 2026-09-21）
		mesh: false, glOverlay: true, stars: false, countryTip: false, instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });   // stars/countryTip=false＝恒星と国名 tip は出さない（衛星が主役・tip が重なる）。惑星・月は残す（衛星のスケールの物差し）。地球は通常配色（quakes の暗い地下向けテーマは使わない）
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.clock(); map.gadget.lang();   // clock＝共通の時計（#42）＝早送り・巻き戻し・日時で衛星も夜の側も同じ時刻へ
	const src = new URLSearchParams(location.search).get("src") || [MIRROR, CELESTRAK];   // 読む順＝ミラー → 本家
	const sats = await mountSats(map, { src } as Parameters<typeof mountSats>[1]);   // 引数の型＝JS 本体の既定値からの推論（既定値の無い欄・null 既定は狭く出る）＝呼び口で JS の口に合わせる
	window.__map = map; window.__sats = sats;   // console 検証用
});
