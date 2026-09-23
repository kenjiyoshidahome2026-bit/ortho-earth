// 汎用 PMTiles 基図（?pm=<URL>）の描画規則を、アーカイブが metadata で宣言する層名から組み立てる。
// 相手は「誰が焼いたか分からない MVT」＝作り込んだ配色は書けない。狙いは二つだけ：
//   ① どのアーカイブでも「とりあえず地図に見える」（無地の灰色べた塗りにしない）
//   ② この地図の掟を破らない＝球のハイプソを潰さない・破線を使わない・静かな色域に収める
// 作り込みが要るなら style を書く（style-mono.js / style-gsi.js が前例）。ここはその手前の既定値。
//
// 色は固定値を持たず「紙（背景）からインクへ寄せた階調」で作る＝mono/dark が自ら宣言している作法
// （「薄さは opacity でなく実色で作る＝紙へ寄せる」）にそのまま乗る。紙が暗いテーマではインク側が
// 明るい色に反転する＝dark/sepia でも色対応表を足さずに追随する。

const hex2rgb = h => {
	const s = String(h || "").replace("#", "");
	const n = s.length === 3 ? s.split("").map(c => c + c).join("") : s.slice(0, 6);
	const v = parseInt(n, 16);
	return Number.isFinite(v) && n.length === 6 ? [(v >> 16) & 255, (v >> 8) & 255, v & 255] : null;
};
const rgb2hex = c => "#" + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const lum = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

// style の層から色を拾う（テーマは mono の構造を色対応表で機械変換＝層 id は全テーマ共通）。
const pick = (style, id, prop) => {
	const v = style?.layers?.find(L => L.id === id)?.paint?.[prop];
	return typeof v === "string" ? v : null;   // 式（match/interpolate）で塗る層はここでは使わない
};

// 層名 → 役割。Protomaps basemaps v4 / OpenMapTiles / Shortbread / tippecanoe 出力の語彙を素直に拾う。
// 判定は部分一致の小文字＝"transportation" も "roads" も "road_major" も道路になる。
const ROLES = [
	["ground", /^(earth|land|landmass|background)$|^land_/],   // 地面＝描かない（下の GROUND 参照）
	["label", /place|poi|label|name|annotation/],              // 注記＝描かない（点は線規則で空振りするだけ・decode も省ける）
	["water", /water|ocean|sea|lake|reservoir/],
	["waterway", /waterway|river|stream|canal/],
	["building", /building|structure/],
	["rail", /rail|train|transit/],
	["road", /road|transportation|highway|street|path|track|ferry|aeroway/],
	["boundary", /boundar|admin|border|division/],
	["landuse", /landuse|landcover|park|forest|green|wood|farm|glacier|sand|beach/],
];
const roleOf = id => (ROLES.find(([, re]) => re.test(String(id).toLowerCase()))?.[0]) || "other";

// 描かない役割：
//  ground＝球のハイプソ（GEBCO×気候）が主役＝塗ると潰れる（style-world.js の裁定を踏襲）。
//  label ＝注記は symbol の作り込み（書体・ハロー・衝突回避）が要る別仕事。描けないものは decode もしない
//          （need は style から作られる＝載せなければ MVT の該当層を展開すらしない）。
const SKIP = new Set(["ground", "label"]);

// 描画順（配列の後ろほど上）。mono の並び（水→建物→道路→鉄道）に倣い、境界を最上へ。
const ORDER = ["landuse", "water", "waterway", "other", "building", "road", "rail", "boundary"];

const W = (...pairs) => ["interpolate", ["linear"], ["zoom"], ...pairs];   // ズーム対応の線幅

export function pmLayers(info, theme) {
	const style = theme?.style;
	const paper = pick(style, "bg", "background-color") || "#f6f6f4";
	const pRGB = hex2rgb(paper) || [246, 246, 244];
	// インク＝紙の反対側。紙が暗ければ明るいインクへ反転（dark テーマが色表を足さずに追随する）。
	const ink = lum(pRGB) < 0.5 ? [232, 236, 242] : [43, 49, 56];
	const tone = t => rgb2hex(pRGB.map((v, i) => v + (ink[i] - v) * t));   // 紙→インクの階調

	// 水だけはテーマの実色を使う＝利用者が「水色」として認識している唯一の色（無ければ階調で代用）
	const waterC = pick(style, "water", "fill-color") || tone(0.10);
	const waterHiC = pick(style, "water-hi", "fill-color") || tone(0.30);
	const bldC = pick(style, "building", "fill-color") || tone(0.08);

	// アーカイブの粒度で「塗るか/線だけか」を決める。粗いアーカイブ（世界概観＝maxZoom が小さい）の面は
	// 1タイル数ポリゴンの粗い塗り絵で、球のハイプソ（GEBCO×気候）とバスィメトリを覆い隠すだけ＝
	// 2026-08-30 の裁定「landcover 淡彩は撤去＝NEラスタの方が綺麗／絵はラスタ・陰影の領分」をそのまま規則にする。
	// 細かいアーカイブ（都市・地域スケール）の面は本物の情報＝塗る。閾は「z6 以上を持っているか」＝
	// 基図の門（view z6.5＝タイル z≒5.5）と同じ地点で線を引く。※style の minzoom はタイル z 基準ゆえ使えない
	// （maxZoom 3 のアーカイブでは永久に発火しない）＝アーカイブの持ち分そのもので判定する。
	const coarse = (info.maxZoom ?? 14) <= 5;

	const byRole = new Map();
	for (const id of info.layers || []) {
		const r = roleOf(id);
		if (SKIP.has(r)) continue;
		if (!byRole.has(r)) byRole.set(r, []);
		byRole.get(r).push(id);
	}

	const out = [];
	const fill = (id, color) => ({ id: `pm-${id}-fill`, type: "fill", "source-layer": id, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": color } });
	const line = (id, color, width) => ({ id: `pm-${id}-line`, type: "line", "source-layer": id, filter: ["!=", ["geometry-type"], "Polygon"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": color, "line-width": width } });

	for (const role of ORDER) {
		for (const id of byRole.get(role) || []) {
			switch (role) {
				case "landuse":   // 淡彩は紙のすぐ隣まで＝標高の絵と喧嘩させない（粗いアーカイブでは描かない）
					if (!coarse) out.push(fill(id, tone(0.05)));
					break;
				case "water":     // 粗いアーカイブは海岸線（線）だけ＝海の塗りでバスィメトリを潰さない
					if (!coarse) out.push(fill(id, waterC));
					out.push(line(id, waterHiC, W(6, 0.4, 12, 0.8, 16, 1.4)));
					break;
				case "waterway":
					out.push(line(id, waterHiC, W(8, 0.4, 12, 0.9, 16, 1.8))); break;
				case "building":
					out.push(fill(id, bldC), line(id, tone(0.14), W(15, 0.3, 17, 0.7))); break;
				case "road":      // 格の区別はしない（属性名がアーカイブ毎に違う）＝一段の細い線で骨格だけ
					out.push(line(id, tone(0.22), W(6, 0.3, 10, 0.6, 14, 1.2, 16, 2.0))); break;
				case "rail":      // トンネルの破線は描かない（紙の遺物）＝実線一本
					out.push(line(id, tone(0.30), W(10, 0.5, 14, 1.1, 16, 2.0))); break;
				case "boundary":  // 最上・やや強い＝国境/行政界は「読む」線
					out.push(line(id, tone(0.42), W(2, 0.5, 6, 0.9, 12, 1.3))); break;
				default:          // 語彙に無い層＝中立の階調で素直に出す（黙って消さない）。coarse でも塗る＝
					// 「球の絵を潰すな」は landuse/water と分かっている層への戒めで、正体不明の層に
					// 適用すると「面しか持たない粗いアーカイブが真っ白」になる（疑わしきは描く側へ）。
					out.push(fill(id, tone(0.07)), line(id, tone(0.28), W(6, 0.4, 12, 0.9, 16, 1.6)));
			}
		}
	}
	return out;
}

// 検証・説明用：どの層をどの役割に振ったか（?pm= の [pm] ログが使う）。
export const pmRoles = info => (info.layers || []).map(id => `${id}:${roleOf(id)}`);
