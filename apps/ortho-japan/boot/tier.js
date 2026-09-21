// 起動時の裁き＝navigator と location だけで決まる純関数の集まり。app.js から動作を変えずに移した（2026-09-17）＝Node で検定できる（tests/t-tier.mjs）。
//   lowMem(nav)            … 低メモリ端末（≤4GB のスマホ帯・iOS はタッチで一律）
//   classifyTier({…})      … 非力デスクトップ（MID_TIER）／ハイスペック（HI_TIER）／スマホ・タブレット（MOBILE_UA）
//   probeGL()              … WebGL2 の生存確認＋GPU 素性の文字列（判定用の使い捨てコンテキスト）
//   fatalOverlay(mapEl, …) … 起動できない環境を白画面でなく言葉で受け止める案内
//   deadMap()              … 起動不能時に呼び側へ返す「何もしない地図」（どんな連鎖も無害に空転する Proxy）
// ノブを変えたら台帳（packages/ortho-core/fallback-ladder.md）も更新の規律。

// 低メモリ端末判定：deviceMemory は Chrome系のみ（≤4GB＝スマホ帯）。iOS/iPadOS Safari は非対応だが
// タブ1枚あたり ~1-1.5GB でOSが強制終了（落ちて自動リロード）するため、タッチ端末は一律低メモリ扱い。
// 誤検知側の被害は「同時2区・キャッシュ縮小」だけ＝安全側に倒す。
export const lowMem = nav => nav.deviceMemory ? nav.deviceMemory <= 4 : nav.maxTouchPoints > 1;

// --- 非力デスクトップ・ティア（MID_TIER）：メモリ天井の低い機体を見抜いて PLATEAU の山を半分にする ---
// 2026-08-03 実測：Windows10 / i7 / 16GB / 内蔵HD Graphics / HDD が、コールド（キャッシュ無し）の PLATEAU 表示で
// タブごと落ちた。既定値（同時4区・常駐1.2GB・worker4本・worker内cache 2区/本）は Apple の 16GB ユニファイド機で
// 調律したもので、コールド時のピークは 16GB 機で renderer 12.3GB という自前実測がある（mesh/manager.js の bldCap のコメント）。
// なぜ deviceMemory で見抜けないか：Chrome の deviceMemory は 8 が上限＝16GB機も64GB機も 8 を返す。
// LOW_MEM（≤4GB＝スマホ帯）は素通りし、非力な 8〜16GB デスクトップだけが素の既定値を浴びる。
// 代わりの signal＝GPU の素性：内蔵GPU（Apple 以外）は VRAM がシステムRAMの取り分＝PLATEAU の常駐・過渡と
// 同じ財布を食う（Apple のユニファイドは同じ物理RAMでも OS がまとめて面倒を見る＝別枠扱いしない）。
// 不明（文字列マスク環境）は現状維持側＝回帰を出さない。?mid=1 / ?mid=0 で手動上書き（実機A/Bの戻し口）。
// もう一つの穴＝**RAM の多いスマホ**：LOW_MEM は deviceMemory ≤4 だけなので、8GB の Android（入門機でも
// 「8GB+仮想4GB」を謳う機種が普通にある）は LOW_MEM を素通りして**デスクトップ扱い**になっていた
// （4区・1.2GB・worker4本）。タブ予算はデスクトップより遥かに小さい＝最低でも非力機ティアへ落とす。
// 判定は coarse ポインタ×タッチ＝スマホ/タブレット（タッチ対応ノートPCは主ポインタが fine ＝巻き込まない）。
// ハイスペック判定（初の「上へ伸ばす」側のtier）：deviceMemory は 8 が上限＝16GB機も64GB機も同じ顔（上のコメント）
// なので、コア数≥12 を物差しにする。効くのは PLATEAU のロード並行度だけ（fast枠3区・タイル並行16）＝描画系は不変。
// ?hi=0 が逃げ道・?hi=1 で強制（弱い機でのA/B用）。
//   search … location.search／nav … navigator／coarse() … matchMedia("(pointer: coarse)").matches（userAgentData.mobile が真なら呼ばれない＝元の短絡のまま）
export function classifyTier({ LOW_MEM, gpuRenderer = "", search = "", nav, coarse }) {
	const MOBILE_UA = nav.userAgentData?.mobile === true || (coarse() && nav.maxTouchPoints > 1);
	const MID_TIER = /[?&]mid=1/.test(search) || (!/[?&]mid=0/.test(search) && !LOW_MEM && (
		MOBILE_UA ||                                                            // RAM の多いスマホ/タブレット（LOW_MEM を素通りする層）
		(nav.hardwareConcurrency || 8) <= 4 ||                                  // 4コア以下＝worker4本を養えない
		(/\bintel\b/i.test(gpuRenderer) && !/\barc\b/i.test(gpuRenderer)) ||    // Intel HD/UHD/Iris/Xe＝内蔵（Arc は独立GPU＝対象外）
		/\bvega\b|radeon\(tm\) graphics/i.test(gpuRenderer) ||                  // AMD APU の内蔵GPU
		/swiftshader|llvmpipe|basic render/i.test(gpuRenderer)));               // ソフトウェアラスタ＝論外に非力
	const HI_TIER = /[?&]hi=1/.test(search) || (!/[?&]hi=0/.test(search) && !LOW_MEM && !MID_TIER && (nav.hardwareConcurrency || 0) >= 12);
	return { MOBILE_UA, MID_TIER, HI_TIER };
}

// 対応判定用の使い捨て WebGL2 コンテキスト：生存（ok）と GPU 素性（renderer＝拡張が無ければ null）。専用コンテキストは新設せず
// この 1 枚に相乗りし、即返却（スロットを食い潰さない）。
export function probeGL() {
	const g = document.createElement("canvas").getContext("webgl2");
	const dbg = g?.getExtension("WEBGL_debug_renderer_info");
	const renderer = dbg ? (g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "") : null;
	g?.getExtension("WEBGL_lose_context")?.loseContext();
	return { ok: !!g, renderer };
}

// --- 初見が死なない：起動できない環境・壊れた環境を白画面でなく言葉で受け止める ---
// reloadLabel（文字列）で「再読み込み」ボタン付き（null＝無し）。fatal は紙色の全面＝地図の世界観のまま静かに伝える。
export function fatalOverlay(mapEl, title, detail, reloadLabel) {
	const d = document.createElement("div");
	d.id = "fatal";   // スタイルは style.css（#fatal）。最後に起きる事件＝最後の append＝DOM順で最上面
	d.innerHTML = `<div class="fatal-box">
		<div class="fatal-title">${title}</div>
		<div class="fatal-detail">${detail}</div>
		${reloadLabel ? `<button class="fatal-reload" onclick="location.reload()">${reloadLabel}</button>` : ""}</div>`;
	mapEl.appendChild(d);
	return d;
}
// 起動不能時の静かな退場：案内オーバーレイを出した後、呼び側（site.js / SDK 埋め込み）には「何もしない地図」を
// 返す。旧・throw は未捕捉例外＝呼び側の then 連鎖ごと死に、site の boot カバーも畳まれない（Chrome の
// ハードウェアアクセラレーション off で「エラーを吐いて落ちる」実測 2026-09-02）。Proxy＝map.gadget.search() の
// ようなどんな連鎖・呼び出しも無害に自分を返して空転する（then だけ undefined＝await が即解決する約束）。
export const deadMap = () => {
	const stub = new Proxy(function () {}, {
		get: (_, k) => k === "then" ? undefined : (k === Symbol.toPrimitive || k === "toString") ? () => "" : stub,
		apply: () => stub,
		set: () => true,
	});
	return stub;
};
