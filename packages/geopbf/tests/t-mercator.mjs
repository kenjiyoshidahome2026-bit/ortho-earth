// t-mercator: 楕円体メルカトル（EPSG:3395 等）の逆変換（convert/proj.js・B9c・2026-09-25）。
// 旧＝球の式で逆変換（緯度 35° で約 −20 km）・縮尺係数と原点移動を無視。順変換は EPSG Guidance Note 7-2 の式で独立に計算して突き合わせる。
import { crsFromWKT, mercInverse } from "../src/convert/proj.js";
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const D = 180 / Math.PI, a = 6378137, f = 1 / 298.257223563, e = Math.sqrt(2 * f - f * f);
const fwd = (lon, lat, { k0 = 1, lon0 = 0, fe = 0, fn = 0 } = {}) => {
	const p = lat / D, s = Math.sin(p);
	return [fe + a * k0 * (lon - lon0) / D, fn + a * k0 * Math.log(Math.tan(Math.PI / 4 + p / 2) * Math.pow((1 - e * s) / (1 + e * s), e / 2))];
};
const W3395 = `PROJCS["WGS 84 / World Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]`;
const c = crsFromWKT(W3395);
ok(c.kind === "projected", `EPSG:3395 の WKT を投影として認識（${c.kind}）`);
let worst = 0;
for (const lat of [-80, -35, 0, 20, 35, 45, 70, 84]) for (const lon of [-170, 0, 139.7]) {
	const [x, y] = fwd(lon, lat), [lo, la] = c.toLonLat([x, y]);
	worst = Math.max(worst, Math.abs(lo - lon), Math.abs(la - lat));
}
ok(worst < 1e-9, `3395：往復の誤差 ${worst.toExponential(2)}°（< 1e-9°）`);
// 縮尺係数・中央子午線・原点移動
{
	const o = { k0: 0.9996, lon0: 110, fe: 3900000, fn: 900000 };
	const wkt = W3395.replace('"central_meridian",0', '"central_meridian",110').replace('"scale_factor",1', '"scale_factor",0.9996').replace('"false_easting",0', '"false_easting",3900000').replace('"false_northing",0', '"false_northing",900000');
	const [x, y] = fwd(115, 20, o), [lo, la] = crsFromWKT(wkt).toLonLat([x, y]);
	ok(Math.abs(lo - 115) < 1e-9 && Math.abs(la - 20) < 1e-9, `縮尺係数・中央子午線・原点移動を反映（${lo.toFixed(9)}, ${la.toFixed(9)}）`);
}
// variant B（2SP）：標準緯線から縮尺係数（EPSG の例：Pulkovo 1942 / Mercator 2SP、φ1=42°、Krassowsky）
{
	const inv = mercInverse({ a: 6378245, f: 1 / 298.3, phi1: 42, lon0: 51 });
	const [lo, la] = inv(165704.29, 5171848.07);
	ok(Math.abs(lo - 53) < 1e-6 && Math.abs(la - 53) < 1e-6, `2SP：EPSG の検算例 E=165704.29 N=5171848.07 → 53°E 53°N（${lo.toFixed(7)}, ${la.toFixed(7)}）`);
}
// Web メルカトル（球）は従来どおり
{
	const W3857 = W3395.replace("World Mercator", "Pseudo-Mercator").replace("Mercator_1SP", "Mercator_Auxiliary_Sphere");
	const [lo, la] = crsFromWKT(W3857).toLonLat([15540000, 4163881]);
	ok(Math.abs(la - (2 * Math.atan(Math.exp(4163881 / a)) - Math.PI / 2) * D) < 1e-12 && Math.abs(lo - 15540000 / a * D) < 1e-12, "3857（球）は球の式のまま");
}
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
