// フレームの係数（改善計画の段階 3・2026-11-01）＝gl/renderer.ts と gpu/renderer.ts が「同式」と注記して二重に持っていた純関数の正本。
// 霧・チルト・都市帯・世界ハイプソ・星空劇場・対数深度の係数＝カメラと style の数から出る値だけ（GPU API は読まない）。
// 式は両 renderer にあった物をそのまま＝演算の順も同じ（絵は bit 同値）。片方だけ直すと絵がずれる＝ここで一度に直す。

/** 霧の濃さの係数（sky の fog-ground-blend：0＝霧なし・0.5＝従来・1＝半分の距離から）。sky が無ければ view.fog:false＝1e6（近/遠が実質無限＝霧を焚かない） */
export const fogKOf = (sky: { groundBlend: number } | null | undefined, fogOff: boolean): number => (sky ? (sky.groundBlend <= 0 ? 1e6 : 0.5 / sky.groundBlend) : fogOff ? 1e6 : 1);

/** フォグ距離の臨界減衰追従：直結だと霞の帯がホイール毎に跳び・凍結だとズームアウトで旧距離の霞が画面を覆う。
 *  霧を焚かない時（fogK ≥ 1e6）とカメラが飛んだ時（1 フレームで距離が 2 倍超・半分未満）は追わずに合わせる（2026-10-23）。prev＝前フレームの値（0＝初回） */
export function fogFollow(prev: number, lastCamDist: number, camDist: number, fogK: number): number {
	let d = prev;
	if (!d || fogK >= 1e6 || camDist > lastCamDist * 2 || camDist * 2 < lastCamDist) d = camDist;
	else d += (camDist - d) * 0.18;
	if (Math.abs(camDist - d) < camDist * 0.002) d = camDist;
	return d;
}
/** 基図・建物・overlay の霧の近端／遠端 */
export const fogNearOf = (fogDist: number, fogK: number): number => fogDist * 2.5 * fogK;
export const fogFarOf = (fogDist: number, fogK: number): number => fogDist * 14.0 * fogK;
/** 地形の霧の近端（視程下限はチルト係数 pfFog で） */
export const terrainFogNearOf = (fogDist: number, pfFog: number, fogK: number): number => Math.max(fogDist * 1.2, 0.008 * pfFog) * fogK;
/** 線・塗り・地形の共通の霧の終端＝地形が完全に霞んだ先に線だけ生き残って「空に浮く白線」になるのを構造的に防ぐ（遠景平ら化 df もこれ基準） */
export const fogFarCapOf = (fogDist: number, pfFog: number, fogK: number): number => Math.max(fogDist * 5.0, 0.026 * pfFog) * fogK;

/** 視程下限のチルト係数（20°→46°）：真俯瞰 0＝平面地図の縁を青く染めない／傾けるほど実距離の視程が効く */
export const pitchFogK = (pitch: number | undefined): number => Math.max(0, Math.min(1, ((pitch || 0) - 0.35) / 0.45));
/** 真俯瞰では標高オフ・傾けるほどフェードイン（3.4°→11.5°・smoothstep） */
export function pitchElevK(pitch: number | undefined): number { const pt = Math.max(0, Math.min(1, ((pitch || 0) - 0.06) / 0.14)); return pt * pt * (3 - 2 * pt); }
/** z14 切替のランプ（z13.5→14 の 0.5 幅）＝DSM 帯⇄都市帯のリフトの連続モーフ（keepFine 保持のズームアウトの段差ポップ対策）。地形の深度を書かない時は 0 */
export const cityKOf = (zoom: number | undefined, terrainDepth: boolean): number => (terrainDepth ? Math.max(0, Math.min(1, ((zoom || 0) - 13.5) / 0.5)) : 0);

/** 世界ハイプソ（と大気散乱）の出現度＝退場ズーム whZ（view.worldHypsoZ・既定 6.5）の手前 0.8 幅 */
export const worldHypsoKOf = (zoom: number, whZ: number): number => Math.max(0, Math.min(1, (whZ - zoom) / 0.8));
/** 10 度レチクルの出現度（v1 geoGraticule10 移植）：z1.7→2.2 出現・ハイプソと同じ帯で退場 × 基礎 α0.5 */
export const graticuleKOf = (zoom: number, whZ: number): number => Math.max(0, Math.min(1, (zoom - 1.7) / 0.5)) * Math.max(0, Math.min(1, (whZ - zoom) / 0.5)) * 0.5;
/** 星空劇場（星・夜面）共通の出現フェード（z<5・0.5 幅） */
export const worldFadeOf = (zoom: number): number => (zoom < 5 ? Math.min(1, (5 - zoom) / 0.5) : 0);
/** 天球倍率 ∝ (0.4+0.3z)（v1 移植・z4 で 1 に正規化）。z1 の硬クランプは太陽系圏の出入りで星の動きが不連続（本人指摘 2026-09-02「上手に繋げて」）
 *  → softplus の軟クランプ＝C∞ 接続：z≫1 は従来の線形・z≪1 は z1 相当へ漸近凍結（負 z の係数反転も防ぐ） */
export function skyKOf(zoom: number): number {
	const zx = zoom - 1, zs = 1 + (zx > 0 ? zx + 0.25 * Math.log(1 + Math.exp(-zx / 0.25)) : 0.25 * Math.log(1 + Math.exp(zx / 0.25)));   // 数値安定形 softplus（幅 0.25z）
	return (0.4 + 0.3 * zs) / 1.6;
}
/** 対数深度の係数（u_logCoef・Frame.logCoef）＝地平線の縁 limb と camDist から（gint・AO・classify も同じ値を読む） */
export function logCoefOf(camDist: number): number { const limb = Math.sqrt(Math.max((1 + camDist) * (1 + camDist) - 1, 1e-12)); return 2.0 / Math.log2(limb * 1.15 + camDist + 1.0); }
/** 画面 1px が何 m（赤道・LOD 打ち切りの物差し） */
export const mppxOf = (zoom: number | undefined): number => 156543.03392 * 0.819 / Math.pow(2, zoom || 0);
