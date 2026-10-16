// IIIF Image API（v2・v3）の info.json から、要る段とタイルを選ぶ（#177）。level0 の静的タイル（事前に切った物）も同じ URL の作法で読む。
//   tiles[].width/height/scaleFactors があれば：段＝scaleFactor・タイル＝region（原寸の画素）と size（縮めた画素）を URL に
//   tiles が無く sizes だけ（小さな画像の配り方）：段ごとに full/{w},{h} の 1 枚を「1 タイル」とみなす
// URL の形：{id}/{region}/{size}/0/default.{fmt}（v2 の size は "w,"・v3 は "w,h"＝level0 の静的タイルはこの正準形でしか置かれていない）。依存なし。

type IiifProfile = string | { formats?: unknown[] } | null;
/** info.json の読む欄（v2 は @id・v3 は id） */
export interface IiifInfo {
	id?: string; "@id"?: string; "@context"?: unknown; type?: string; width?: number | string; height?: number | string;
	profile?: IiifProfile | IiifProfile[]; preferredFormats?: unknown[];
	tiles?: { width?: number | string; height?: number | string; scaleFactors?: (number | string)[] }[];
	sizes?: { width: number; height: number }[];
	attribution?: unknown;
}
/** 段（tiled＝タイル割り・それ以外＝sizes の 1 枚） */
export type IiifLevel =
	| { scale: number; tw: number; th: number; cols: number; rows: number; tiled: true }
	| { scale: number; w: number; h: number; cols: 1; rows: 1; tiled: false };
/** タイルの原寸の範囲 [x, y, w, h]・縮めた大きさ・URL */
export interface IiifTile { x: number; y: number; w: number; h: number; sw: number; sh: number; url: string }
export interface IiifImage {
	id: string; version: 2 | 3; width: number; height: number; format: string; levels: IiifLevel[]; attribution: string | null;
	levelFor(foot: number): IiifLevel;
	tile(L: IiifLevel, c: number, r: number): IiifTile;
	tilesIn(L: IiifLevel, box: readonly number[]): [number, number][];
}

// 末尾の "/" を落とす（旧 .replace(/\/+$/, "")）。正規表現は "/" が多い入力で二乗の後戻り（CodeQL）＝添字で同じ削り方をする
const trimSlashes = (s: string): string => { let e = s.length; while (e > 0 && s[e - 1] === "/") e--; return s.slice(0, e); };
const ver = (info: IiifInfo): 2 | 3 => /image\/3|ImageService3/.test(JSON.stringify(info["@context"] || "") + (info.type || "")) ? 3 : 2;
/** info.json → 読み口（段の一覧・タイルの URL） */
export function iiifImage(info: IiifInfo, { base }: { base?: string } = {}): IiifImage {   // base＝info.json の URL（相対の id を解く＝静的に置いた level0 の写しを置き場所に依らず読む）
	let rid = String(info.id || info["@id"] || "");
	if (base && rid && !/^[a-z][\w+.-]*:/i.test(rid)) rid = new URL(rid, base).href;
	const id = trimSlashes(rid), v = ver(info);
	const W = +(info.width ?? NaN), H = +(info.height ?? NaN);
	if (!id || !(W > 0) || !(H > 0)) throw new Error("iiif: info.json lacks id/width/height");
	const prof: IiifProfile[] = Array.isArray(info.profile) ? info.profile : [info.profile ?? null];
	// 形式＝ブラウザで解ける物だけ（jpg・png・webp・gif）。v3 は jpg が必ず使える（extraFormats の tif などは選ばない）・preferredFormats があればその順・
	// v2 は profile の formats（level0 の写しが png だけの時は png）
	const WEB = /^(jpg|png|webp|gif)$/;
	const pref = (info.preferredFormats || []).map(String).filter(f => WEB.test(f)), listed = ((prof.find(p => p && typeof p === "object") as { formats?: unknown[] } | undefined)?.formats || []).map(String).filter(f => WEB.test(f));
	const fmt = pref[0] || (listed.length && !listed.includes("jpg") ? listed[0] : "jpg");
	const level = (() => { const p = JSON.stringify(info.profile || ""); return /level2/.test(p) ? 2 : /level1/.test(p) ? 1 : 0; })();
	const t = (info.tiles || [])[0];
	let levels: IiifLevel[];
	const tiledLevels = (tw: number, th: number, sfs: (number | string)[]): IiifLevel[] => [...new Set(sfs.map(Number))].sort((a, b) => a - b).map(s => ({ scale: s, tw, th, cols: Math.ceil(W / (tw * s)), rows: Math.ceil(H / (th * s)), tiled: true as const }));
	if (t && t.width) levels = tiledLevels(+t.width, +(t.height || t.width), t.scaleFactors || [1]);
	else if (level >= 1) {   // tiles を申告しない level1/2（任意の範囲と大きさを受ける）＝512 の仮想タイル・2 の冪の段（1 枚に収まるまで）＝原寸の 1 枚を取りに行かない
		const sfs = [1]; while (Math.max(W, H) / sfs[sfs.length - 1] > 512) sfs.push(sfs[sfs.length - 1] * 2);
		levels = tiledLevels(512, 512, sfs);
	} else {
		const sizes = (info.sizes || []).filter(s => s.width > 0 && s.height > 0);
		const list = sizes.length ? sizes : [{ width: W, height: H }];
		levels = list.map(s => ({ scale: W / s.width, w: +s.width, h: +s.height, cols: 1 as const, rows: 1 as const, tiled: false as const })).sort((a, b) => a.scale - b.scale);
	}
	const sizeStr = (w: number, h: number): string => v === 3 ? `${w},${h}` : `${w},`;
	return {
		id, version: v, width: W, height: H, format: fmt, levels,
		attribution: info.attribution ? String(typeof info.attribution === "string" ? info.attribution : JSON.stringify(info.attribution)) : null,
		/** 画像の画素の足跡（画像画素 / 出力画素）→ その足跡を下回らない一番粗い段（無ければ一番細かい段） */
		levelFor(foot) { let best = levels[0]; for (const L of levels) if (L.scale <= Math.max(1, foot)) best = L; return best; },
		/** 段 L のタイル (c, r) の原寸の範囲 [x, y, w, h] と URL */
		tile(L, c, r) {
			if (!L.tiled) return { x: 0, y: 0, w: W, h: H, sw: L.w, sh: L.h, url: `${id}/full/${sizeStr(L.w, L.h)}/0/default.${fmt}` };
			const x = c * L.tw * L.scale, y = r * L.th * L.scale, w = Math.min(L.tw * L.scale, W - x), h = Math.min(L.th * L.scale, H - y);
			const sw = Math.ceil(w / L.scale), sh = Math.ceil(h / L.scale);
			return { x, y, w, h, sw, sh, url: `${id}/${x},${y},${w},${h}/${sizeStr(sw, sh)}/0/default.${fmt}` };
		},
		/** 画像の画素の範囲 [x0, y0, x1, y1] に掛かる段 L のタイルの (c, r) */
		tilesIn(L, [x0, y0, x1, y1]) {
			if (!L.tiled) return x1 < 0 || y1 < 0 || x0 > W || y0 > H ? [] : [[0, 0]];
			const sx = L.tw * L.scale, sy = L.th * L.scale, out: [number, number][] = [];
			const c0 = Math.max(0, Math.floor(x0 / sx)), c1 = Math.min(L.cols - 1, Math.floor(x1 / sx)), r0 = Math.max(0, Math.floor(y0 / sy)), r1 = Math.min(L.rows - 1, Math.floor(y1 / sy));
			for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push([c, r]);
			return out;
		},
	};
}
/** 画像サービスの id（…/info.json でも可）→ info.json の URL */
export const infoUrl = (id: unknown): string => trimSlashes(String(id).replace(/\/info\.json$/i, "")) + "/info.json";
