// 共有URL（パーマリンク）codec：#zoom/lat/lon[/45t][/-30r][/l=a.b][/c=dark][/c]。語順は地理院地図・OSMと同じ。
// 後置トークン＝ t:チルト(度) / r:方位(度) / l=点火チップのON集合 / c=配色テーマ名 / c:等高線（旧互換・裸のc＝別トークン）。
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// 経度を(-180,180]へ正規化。地球を回し続けるとlonが1周ごとに+360°累積し、シーン結合の原点相対float32の
// 前提|Δ|≤0.4°が壊れて基図が~44m格子に量子化される（「階段バグ」の正体。実測=保存カメラにlon 5539°=139°+15周）。
// 周期関数には無害＝見た目は一切変わらない。消すと再発する。
export const wrapLon = lon => (Number.isFinite(lon) && (lon > 180 || lon <= -180)) ? ((lon + 180) % 360 + 360) % 360 - 180 : lon;

export function parseViewHash(h) {
	const p = (h || "").replace(/^#/, "").split("/").filter(Boolean);
	if (p.length < 3) return null;
	const zoom = +p[0], lat = +p[1], lon = +p[2];
	if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	const v = { zoom, lat, lon, pitch: 0, bearing: 0, layers: null, contour: false, theme: null };
	for (const t of p.slice(3)) {
		let m;
		if ((m = /^(-?[\d.]+)t$/.exec(t))) v.pitch = +m[1] * D2R;
		else if ((m = /^(-?[\d.]+)r$/.exec(t))) v.bearing = +m[1] * D2R;
		else if ((m = /^l=(.*)$/.exec(t))) v.layers = m[1] ? m[1].split(".") : [];   // l=（空）＝全チップOFF も区別する
		else if ((m = /^c=([\w-]+)$/.exec(t))) v.theme = m[1];   // 配色テーマ（c=dark…台帳はアプリ側）。裸の c とは別トークン
		else if (t === "c") v.contour = true;
	}
	return v;
}

// 現在ビュー→ハッシュ。桁は lat/lon 5桁(≈1m)・zoom 2桁＝短く安定。既定と同じ項は省く＝素の視点はURLも素。
// extras＝アプリ固有の後置トークン（例: "l=rail.river"）。
export function buildViewHash(cam, extras = []) {
	const parts = [cam.zoom.toFixed(2), cam.center[1].toFixed(5), cam.center[0].toFixed(5)];
	if (cam.pitch > 0.001) parts.push(Math.round(cam.pitch * R2D) + "t");
	if (Math.abs(cam.bearing) > 0.001) parts.push(Math.round(cam.bearing * R2D) + "r");
	for (const t of extras) parts.push(t);
	return "#" + parts.join("/");
}
