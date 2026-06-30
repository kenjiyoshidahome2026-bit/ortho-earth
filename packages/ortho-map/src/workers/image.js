import { geoOrthographic } from "common";
import { orthoGL2 } from "./orthoGL2.js";

// 反時計回り = 地球の裏面タイル → 描画スキップ
const counter_clockwise = a =>
	(a[1][0] - a[0][0]) * (a[1][1] + a[0][1]) + (a[2][0] - a[1][0]) * (a[2][1] + a[1][1]) +
	(a[3][0] - a[2][0]) * (a[3][1] + a[2][1]) + (a[0][0] - a[3][0]) * (a[0][1] + a[3][1]) > 0;

let canvas, gl, width, height;
let minZoom = 2, maxZoom = Infinity;

// Map<id, [texture, [w,s,e,n], dx, dy, opacity]>
// id は set 時に prop.id で指定。省略時は "w,s,e,n" を自動生成。
// dx/dy: 大きな画像を dx×dy サブタイルに分割して背面可視性問題を回避
const tub = new Map();

let proj = geoOrthographic(), zoom;
const funcs = { init, set, drawing, drawn, resize, destroy };
onmessage = e => funcs[e.data.type]?.(e.data);

function init(data) {
	canvas = data.offscreen;
	gl = orthoGL2(canvas.getContext("webgl2"), data.dpr);
	postMessage({ type: data.type, action: "done", ctx: gl.constructor.name });
}

// ---- set コマンド -------------------------------------------------------
// overlay / add: タイル画像を追加または差し替え
//   data: ArrayBuffer | TypedArray  → ワーカー内で ImageBitmap に変換（ゼロコピー転送対応）
//         string (URL)              → ワーカー内でフェッチ＆デコード
//         ImageBitmap               → そのまま使用
//   prop: { bbox:[w,s,e,n], id?, opacity?=1, dx?=1, dy?=1 }
//
// remove: prop.id のタイルを削除
// clear:  全タイルを削除
// minZoom: prop.value  または prop（数値）で最小ズームを設定
// maxZoom: prop.value  または prop（数値）で最大ズームを設定
//
async function set(data) {
	const cmd = data.cmd;

	if (cmd === "overlay" || cmd === "add") {
		const { bbox, dx = 1, dy = 1, id, opacity = 1 } = data.prop ?? {};
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
			const [w, s] = [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3])];
			const [e, n] = [Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])];
			const tileId  = id ?? `${w},${s},${e},${n}`;
			if (tub.has(tileId)) gl.deleteTexture(tub.get(tileId)[0]);
			tub.set(tileId, [texture, [w, s, e, n], dx, dy, opacity]);
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

	tub.forEach(([texture, [w, s, e, n], dx, dy, opacity]) => {
		// j=0 が北側、j=dy-1 が南側（画像座標系に合わせた順序）
		for (let i = 0; i < dx; i++) {
			for (let j = 0; j < dy; j++) {
				// 地理座標（BBOX を dx×dy に分割）
				const W = w + (e - w) * i / dx;
				const E = w + (e - w) * (i + 1) / dx;
				const S = s + (n - s) * (dy - (j + 1)) / dy;
				const N = s + (n - s) * (dy - j) / dy;

				const p = [[W, N], [E, N], [E, S], [W, S]].map(proj);
				if (counter_clockwise(p)) continue;

				// クリップ座標変換
				const q   = p.map(t => [(t[0] / width) * 2 - 1, 1 - (t[1] / height) * 2]);
				const pos = new Float32Array([q[0], q[1], q[3], q[2]].flat());

				// UV: j=0(北) → t=0(テクスチャ上端=画像先頭行=北) と対応
				const uvX0 = i / dx,       uvX1 = (i + 1) / dx;
				const uvY0 = j / dy,       uvY1 = (j + 1) / dy;
				const crd  = new Float32Array([uvX0, uvY0, uvX1, uvY0, uvX0, uvY1, uvX1, uvY1]);

				gl.drawTile(texture, crd, pos, opacity);
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
