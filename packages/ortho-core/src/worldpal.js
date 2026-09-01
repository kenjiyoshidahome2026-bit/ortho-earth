// 全球ハイプソの正準パレット＝world色の単一の出所。GL/WGSL両レンダラの uniform 既定と、
// app 側の湖レイヤ(style-world)の塗りが全員ここから引く（海色が3箇所のリテラルで手動同期していた轍の根治）。
// テーマは view.worldHypso に同名キーで部分上書き（palettes.js の台帳）＝未指定キー＝この既定
// ＝mono(knob無し)は従来出力と一致・gsi の「海だけ差し替え」も per-key マージで自動成立。
// 標高ブレークポイント(400/1300/2800/4800m)・脱彩度・snow/arid の式はテーマ対象外＝シェーダ側に残る。
export const WORLD_PAL_DEFAULT = {
	sea:      [0.757, 0.847, 0.891],   // #c1d8e3（GLOBE u_seaC と湖レイヤは常に同色＝面一の水面）
	lowHumid: [0.582, 0.716, 0.531],   // 低地・湿潤＝緑
	lowArid:  [0.839, 0.796, 0.639],   // 低地・乾燥＝砂（cross-blend先）
	midHumid: [0.752, 0.790, 0.578],   // 〜400m・湿潤＝黄緑
	midArid:  [0.855, 0.788, 0.612],   // 〜400m・乾燥
	ramp1:    [0.871, 0.831, 0.659],   // 400–1300m＝砂
	ramp2:    [0.788, 0.718, 0.635],   // 1300–2800m＝茶灰
	peak:     [0.925, 0.925, 0.937],   // 2800–4800m＝高峰
	snow:     [0.945, 0.953, 0.962],   // 氷床・雪
	belowSea: [0.84, 0.92, 0.82],      // wdepr 専用＝0→-60m の乗算ティント（globe との縫い目契約の外）
	grat:     [1, 1, 1, 1],            // レチクル rgb＋α係数（レンダラのz帯フェードに乗算）
};
export function resolveWorldPal(knob) {   // per-key マージ。knob=view.worldHypso（clim 等の異種キーは素通し無視）
	const p = {};
	for (const k in WORLD_PAL_DEFAULT) p[k] = (knob && knob[k]) || WORLD_PAL_DEFAULT[k];
	return p;
}
