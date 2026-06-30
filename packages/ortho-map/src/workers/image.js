import { geoOrthographic } from "common";
import { orthoGL2 } from "./orthoGL2.js";

// 反時計回り = 地球の裏面タイル → 描画スキップ
const counter_clockwise = a =>
	(a[1][0] - a[0][0]) * (a[1][1] + a[0][1]) + (a[2][0] - a[1][0]) * (a[2][1] + a[1][1]) +
	(a[3][0] - a[2][0]) * (a[3][1] + a[2][1]) + (a[0][0] - a[3][0]) * (a[0][1] + a[3][1]) > 0;

const R_EARTH = 6371; // km

let canvas, gl, dpr = 1, width, height;
let minZoom = 2, maxZoom = Infinity;

// Map<id, [texture, [w,s,e,n], dx, dy, opacity, clip]>
//   clip = null                              → 矩形タイル
//   clip = { center, radius, rotation }      → 円形（全値ラジアン）
const tub = new Map();

let proj = geoOrthographic(), zoom;
const funcs = { init, set, drawing, drawn, resize, destroy };
onmessage = e => funcs[e.data.type]?.(e.data);

function init(data) {
	dpr = data.dpr ?? 1;
	canvas = data.offscreen;
	gl = orthoGL2(canvas.getContext("webgl2"), dpr);
	postMessage({ type: data.type, action: "done", ctx: gl.constructor.name });
}

// ---- set コマンド -------------------------------------------------------
// overlay / add: タイル画像を追加または差し替え
//   data: ArrayBuffer | TypedArray  → ワーカー内で ImageBitmap に変換（ゼロコピー転送対応）
//         string (URL)              → ワーカー内でフェッチ＆デコード
//         ImageBitmap               → そのまま使用
//
// 矩形モード prop: { bbox:[w,s,e,n], id?, opacity?=1, dx?=1, dy?=1 }
// 円形モード prop: { center:[lng,lat](度), radius:km, rotation?:度, id?, opacity?=1 }
//
// remove: prop.id のタイルを削除
// clear:  全タイルを削除
// minZoom / maxZoom: prop.value または prop（数値）でズーム範囲を設定
//
async function set(data) {
	const cmd = data.cmd;

	if (cmd === "overlay" || cmd === "add") {
		const { bbox, center, radius, dx = 1, dy = 1, id, opacity = 1, rotation = 0 } = data.prop ?? {};
		let src = data.data;
		try {
			if (typeof src === 'string') {
				const res = await fetch(src);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				src = await createImageBitmap(await res.blob());
			} else if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) {
				src = await createImageBitmap(new Blob([src]));
			}
			const texture = gl.createTileTexture(src);

			if (center && radius != null) {
				// 円形モード: BBOX を center+radius から自動計算
				const [lng0, lat0] = center;
				const dlat = radius / R_EARTH * 180 / Math.PI;
				const dlng = dlat / Math.max(Math.cos(lat0 * Math.PI / 180), 0.001);
				const bw = lng0 - dlng, be = lng0 + dlng;
				const bs = lat0 - dlat, bn = lat0 + dlat;
				const tileId = id ?? `circle:${lng0},${lat0},${radius}`;
				if (tub.has(tileId)) gl.deleteTexture(tub.get(tileId)[0]);
				tub.set(tileId, [texture, [bw, bs, be, bn], 1, 1, opacity, {
					center:   new Float32Array([lng0 * Math.PI / 180, lat0 * Math.PI / 180]),
					radius:   radius / R_EARTH,            // ラジアン
					rotation: rotation * Math.PI / 180,    // ラジアン（時計回り）
				}]);
			} else {
				// 矩形モード
				const [w, s] = [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3])];
				const [e, n] = [Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])];
				const tileId = id ?? `${w},${s},${e},${n}`;
				if (tub.has(tileId)) gl.deleteTexture(tub.get(tileId)[0]);
				tub.set(tileId, [texture, [w, s, e, n], dx, dy, opacity, null]);
			}
		} catch (err) {
			postMessage({ type: data.type, action: "done", error: err.message });
			return;
		}

	} else if (cmd === "remove") {
		const entry = tub.get(data.prop.id);
		if (entry) { gl.deleteTexture(entry[0]); tub.delete(data.prop.id); }

	} else if (cmd === "clear") {
		tub.forEach(([texture]) => gl.deleteTexture(texture));
		tub.clear();

	} else if (cmd === "minZoom") {
		minZoom = data.prop?.value ?? data.prop ?? 2;

	} else if (cmd === "maxZoom") {
		maxZoom = data.prop?.value ?? data.prop ?? Infinity;
	}

	postMessage({ type: data.type, action: "done" });
}

function resize(data) {
	gl.resizeBySize(width = data.width, height = data.height);
	proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
	postMessage({ type: data.type, action: "done" });
}

function drawing(data) {
	gl.clearContext();
	proj.rotate(data.rotate).scale(data.scale);
	zoom = Math.log2(data.scale * Math.PI * 2 / 256);
	if (zoom < minZoom || zoom > maxZoom) return;

	// 円形シェーダー用グローブパラメータ（フレームごとに1回計算）
	const translate = new Float32Array([gl.canvas.width / 2, gl.canvas.height / 2]);
	const scaleVal  = data.scale * dpr;
	const rotateVec = new Float32Array(data.rotate);

	tub.forEach(([texture, [w, s, e, n], dx, dy, opacity, clip]) => {
		if (clip) {
			// ---- 円形クリップ ----
			const p = [[w, n], [e, n], [e, s], [w, s]].map(proj);
			if (counter_clockwise(p)) return;
			const q   = p.map(t => [(t[0] / width) * 2 - 1, 1 - (t[1] / height) * 2]);
			const pos = new Float32Array([q[0], q[1], q[3], q[2]].flat());
			gl.drawCircle(texture, pos, clip.center, clip.radius, clip.rotation, opacity, translate, scaleVal, rotateVec);
		} else {
			// ---- 矩形タイル（dx×dy サブタイル分割） ----
			// j=0 が北側、j=dy-1 が南側（画像座標系に合わせた順序）
			for (let i = 0; i < dx; i++) {
				for (let j = 0; j < dy; j++) {
					const W = w + (e - w) * i / dx;
					const E = w + (e - w) * (i + 1) / dx;
					const S = s + (n - s) * (dy - (j + 1)) / dy;
					const N = s + (n - s) * (dy - j) / dy;

					const p = [[W, N], [E, N], [E, S], [W, S]].map(proj);
					if (counter_clockwise(p)) continue;

					const q   = p.map(t => [(t[0] / width) * 2 - 1, 1 - (t[1] / height) * 2]);
					const pos = new Float32Array([q[0], q[1], q[3], q[2]].flat());

					// UV: j=0(北) → t=0(テクスチャ上端=北) と対応
					const uvX0 = i / dx, uvX1 = (i + 1) / dx;
					const uvY0 = j / dy, uvY1 = (j + 1) / dy;
					const crd  = new Float32Array([uvX0, uvY0, uvX1, uvY0, uvX0, uvY1, uvX1, uvY1]);

					gl.drawTile(texture, crd, pos, opacity);
				}
			}
		}
		gl.flush();
	});
}

function drawn() { }

function destroy(data) {
	canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
	tub.forEach(([texture]) => gl.deleteTexture(texture));
	tub.clear();
	gl = proj = null;
	postMessage({ type: data.type, action: "done" });
}
