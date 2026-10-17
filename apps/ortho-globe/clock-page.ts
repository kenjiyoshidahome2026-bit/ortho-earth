// 世界時計（issue #309）＝その場所がいま何時か。NE の時間帯の面＋admin0 の国 → IANA の名前 → ブラウザの Intl（夏時間つき）。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域の申告なし）を起こし、部品 ./clock.js（遅延 chunk）を置く。
// 時刻＝地図の共通の時計（既定は実時間・#…/t=<UTC> で決まった時刻・時計の操作盤で動かす＝夜の側も同じ時刻）。
// ?tz=URL で時間帯の面を差し替え可（既定＝Natural Earth の S3 を直読み）。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("clock", async () => {
	const [{ createGlobe, geopbf }, { mountClock }] = await Promise.all([import("@ortho-earth/globe"), import("./clock.js")]);
	// 初期視点＝見ている人の経度を正面に（UTC との差 1 時間＝15°）。共有 URL の hash があればそちら
	const lon = Math.max(-180, Math.min(180, Math.round(-new Date().getTimezoneOffset() / 4)));
	const map = await createGlobe({ target: "#map", view: location.hash || `#2.4/20/${lon}`, chips: false, zoomMax: 8,   // 世界のアプリ＝地球儀（地域の申告なし）
		mesh: false, stars: false, countryTip: false, instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });   // countryTip:false＝国名は時計の tip が出す（Shift の国の一覧と重ねない）
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.clock(); map.gadget.lang();   // clock＝共通の時計（#42）＝時刻を動かすと夏時間の切り替わりと夜の側が一緒に動く
	const tzSrc = new URLSearchParams(location.search).get("tz") || undefined;
	const clock = await mountClock(map, geopbf, { tzSrc });
	window.__map = map; window.__clock = clock;   // console 検証用
	return map;
}, { page: c => import(`./i18n/lang/clock/${c}.json`) });
