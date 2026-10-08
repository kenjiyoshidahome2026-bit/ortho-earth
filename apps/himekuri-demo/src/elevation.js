// 現在地の標高（m）＝日の出入りの「地平線の降下」に使う。器（クラウド）は外部網が閉じているので取得は必ずクライアント側＝検定はモック（tests/t-elevation.mjs）。
// 取り方の順（取れた所で止まる・出所を source に残す）：
//   ① Open-Meteo の標高 API（全球・Copernicus DEM 90m・鍵なし・CORS 可）
//   ② 地理院の標高タイル（テキスト形式 .txt＝256×256 の CSV・'e' は無効値）：日本は dem5a（z15・5m）→ dem（z14・DEM10B）、国外は demgm（z8・全球 1km）
//   ③ GPS の高度（navigator.geolocation の altitude＝粗い）
//   ④ 0 m（海抜）
// 同じ場所（0.001° ≒ 100m 丸め）は localStorage に 30 日持つ＝毎回叩かない。
const KEY = "himekuri.elev.v1", TTL = 30 * 864e5;
export const SOURCES = {
	"open-meteo": { label: "Open-Meteo (Copernicus DEM 90 m)", href: "https://open-meteo.com/en/docs/elevation-api" },
	dem5a: { label: "GSI DEM5A (5 m)", href: "https://maps.gsi.go.jp/development/ichiran.html#dem" },
	dem: { label: "GSI DEM10B (10 m)", href: "https://maps.gsi.go.jp/development/ichiran.html#dem" },
	demgm: { label: "GSI global DEM (1 km)", href: "https://maps.gsi.go.jp/development/ichiran.html#dem" },
	gps: { label: "GPS altitude", href: null },
	manual: { label: "Entered by hand", href: null },
	none: { label: "Sea level (0 m)", href: null },
};
const inJapan = (lat, lon) => lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154;
export const tileXY = (lat, lon, z) => {
	const n = 2 ** z, x = Math.floor((lon + 180) / 360 * n);
	const r = lat * Math.PI / 180, y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
	const px = Math.floor(((lon + 180) / 360 * n - x) * 256), py = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n - y) * 256);
	return { x, y, px, py };
};
// 地理院の .txt タイルから 1 画素（行＝北から・列＝西から）
export function pickGsiTxt(text, px, py) {
	const row = text.split("\n")[py];
	if (row == null) return null;
	const v = row.split(",")[px];
	if (v == null || v.trim() === "e" || v.trim() === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
async function fromGsi(lat, lon, z, name, fetchFn) {
	const { x, y, px, py } = tileXY(lat, lon, z);
	const r = await fetchFn(`https://cyberjapandata.gsi.go.jp/xyz/${name}/${z}/${x}/${y}.txt`);
	if (!r.ok) return null;
	return pickGsiTxt(await r.text(), px, py);
}
async function fromOpenMeteo(lat, lon, fetchFn) {
	const r = await fetchFn(`https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`);
	if (!r.ok) return null;
	const j = await r.json(), v = j?.elevation?.[0];
	return Number.isFinite(v) ? v : null;
}
const cacheKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;
function readCache(storage, k) {
	try { const all = JSON.parse(storage?.getItem(KEY) || "{}"), v = all[k]; return v && Date.now() - v.at < TTL ? v : null; } catch { return null; }
}
function writeCache(storage, k, v) {
	try { const all = JSON.parse(storage?.getItem(KEY) || "{}"); all[k] = { ...v, at: Date.now() }; storage?.setItem(KEY, JSON.stringify(all)); } catch { /* 容量切れ・private mode＝持たないだけ */ }
}
// → { elevation（m）, source（SOURCES の鍵）}。gpsAlt＝geolocation の altitude（無ければ null）
export async function lookupElevation(lat, lon, { gpsAlt = null, fetchFn = (u) => fetch(u), storage = globalThis.localStorage, timeout = 8000 } = {}) {
	const k = cacheKey(lat, lon), hit = readCache(storage, k);
	if (hit) return { elevation: hit.elevation, source: hit.source, cached: true };
	const guarded = async (fn) => {
		const ac = typeof AbortController === "function" ? new AbortController() : null;
		const timer = setTimeout(() => ac?.abort(), timeout);
		try { return await fn(u => fetchFn(u, ac ? { signal: ac.signal } : undefined)); } catch { return null; } finally { clearTimeout(timer); }
	};
	const steps = [["open-meteo", f => fromOpenMeteo(lat, lon, f)]];
	if (inJapan(lat, lon)) steps.push(["dem5a", f => fromGsi(lat, lon, 15, "dem5a", f)], ["dem", f => fromGsi(lat, lon, 14, "dem", f)]);
	else steps.push(["demgm", f => fromGsi(lat, lon, 8, "demgm", f)]);
	for (const [source, fn] of steps) {
		const v = await guarded(fn);
		if (Number.isFinite(v)) { const out = { elevation: Math.round(v * 10) / 10, source }; writeCache(storage, k, out); return out; }
	}
	if (Number.isFinite(gpsAlt)) return { elevation: Math.round(gpsAlt), source: "gps" };
	return { elevation: 0, source: "none" };
}
