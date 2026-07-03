// JS側の正射投影（gl/glsl.js の projectDelta と同一式）。衝突判定・カリング用。
// cam: { origin:[lon,lat], center:[lon,lat], scale, translate:[x,y] }
const D2R = Math.PI / 180;

// 経緯度差分(dx,dy) → [screenX, screenY(device px), cosc]（cosc>=0 で前面）
export function projectDelta(cam, dx, dy) {
	const lon = (cam.origin[0] + dx) * D2R, lat = (cam.origin[1] + dy) * D2R;
	const lon0 = cam.center[0] * D2R, lat0 = cam.center[1] * D2R;
	const dl = lon - lon0;
	const clat = Math.cos(lat), slat = Math.sin(lat), clat0 = Math.cos(lat0), slat0 = Math.sin(lat0), cdl = Math.cos(dl);
	const cosc = slat0 * slat + clat0 * clat * cdl;
	const X = clat * Math.sin(dl);
	const Y = clat0 * slat - slat0 * clat * cdl;
	return [cam.translate[0] + cam.scale * X, cam.translate[1] - cam.scale * Y, cosc];
}
