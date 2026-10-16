// 3D Tiles の ground:"terrain"（1 棟ずつ最低点で接地）が i3dm にも効くかの検定（node・網なし・fixtures/tiles3d）。
// 旧＝decodeTile3D が i3dm へ ground を渡さず、terrain でも絶対高さのまま（呼び手は地形へ持ち上げる＝地形の上に浮いた）。b3dm は前から効く。
import { readFileSync } from "node:fs";
import { decodeTile3D } from "../src/tiles3d-decode.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const dir = new URL("./fixtures/tiles3d/", import.meta.url);
const ts = JSON.parse(readFileSync(new URL("tileset.json", dir), "utf8"));
const transform = ts.root.transform;
const load = f => { const b = readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const decode = (f, ground) => decodeTile3D(load(f), { transform, textures: false, ground, baseUri: dir.href });
// 頂点の高さ（m）の最低と最高＝mesh は origin＋pos（地球の半径＝1 の単位）
const R = 6371008.8;
const hRange = r => { let lo = Infinity, hi = -Infinity; for (const b of r?.batches ?? []) { const m = b.mesh, o = m.origin; for (let i = 0; i < m.pos.length; i += 3) { const h = (Math.hypot(o[0] + m.pos[i], o[1] + m.pos[i + 1], o[2] + m.pos[i + 2]) - 1) * R; lo = Math.min(lo, h); hi = Math.max(hi, h); } } return [lo, hi]; };
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

// fixtures：parent.b3dm＝箱（高さ 20）・inst.i3dm＝箱（高さ 30）×9。tileset の変換で地表から 40m 上
for (const [f, tall] of [["parent.b3dm", 20], ["inst.i3dm", 30]]) {
	const abs = await decode(f, "absolute"), ter = await decode(f, "terrain");
	const def = await decodeTile3D(load(f), { transform, textures: false, baseUri: dir.href });
	const [a0, a1] = hRange(abs), [t0, t1] = hRange(ter), [d0, d1] = hRange(def);
	ok(`${f} absolute＝絶対高さ（40m 上）`, near(a0, 40) && near(a1 - a0, tall), `${a0.toFixed(2)}..${a1.toFixed(2)}`);
	ok(`${f} terrain＝最低点で接地（0m）・高さは同じ`, near(t0, 0) && near(t1 - t0, tall), `${t0.toFixed(2)}..${t1.toFixed(2)}`);
	ok(`${f} 既定＝absolute`, d0 === a0 && d1 === a1);
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ tiles3d-ground 全 PASS");
process.exit(fail ? 1 : 0);
