// lut.ts（3D LUT の読み込み）の .cube 経路の検定。data: URL で渡す＝外部データ不要。
//   ・恒等 LUT（size 2・4）→ 帯の (x＝B×size＋R, y＝G) に R・G・B がそのまま入る
//   ・DOMAIN_MIN/MAX の正規化・範囲外の切り詰め・コメントと TITLE を飛ばす
//   ・壊れた .cube（行不足・1D）と HTTP の失敗は reject
//   画像（png 等）の経路は createImageBitmap・OffscreenCanvas が要る＝ブラウザ側
import { loadLUT } from "../src/lut.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const cubeURL = text => "data:text/plain;charset=utf-8," + encodeURIComponent(text);
const identity = (n, f = x => x) => { const L = []; for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) L.push([r, g, b].map(v => f(v / (n - 1))).join(" ")); return L.join("\n"); };
const rejects = async p => { try { await p; return false; } catch { return true; } };

for (const n of [2, 4]) {
	const lut = await loadLUT(cubeURL(`# comment\nTITLE "id"\nLUT_3D_SIZE ${n}\n\n${identity(n)}\n`));
	let good = lut.size === n && lut.data.length === n ** 3 * 4;
	for (let b = 0; b < n && good; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
		const o = (g * n * n + b * n + r) * 4, e = v => Math.round(v / (n - 1) * 255);
		if (lut.data[o] !== e(r) || lut.data[o + 1] !== e(g) || lut.data[o + 2] !== e(b) || lut.data[o + 3] !== 255) good = false;
	}
	ok(`恒等 LUT（size ${n}）＝帯の (B×size＋R, G) に RGB`, good);
}
{
	const lut = await loadLUT(cubeURL(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n${identity(2, v => v * 2)}`));
	ok("DOMAIN_MAX 2 で正規化", lut.data[4] === 255 && lut.data[0] === 0, `${lut.data[4]}`);
	const c = await loadLUT(cubeURL(`LUT_3D_SIZE 2\n${identity(2, v => v * 3 - 1)}`));
	ok("範囲外は 0..255 に切り詰め", c.data[0] === 0 && c.data[4] === 255);
	const u = await loadLUT(cubeURL(`LUT_3D_SIZE 2\r\n${identity(2).replace(/\n/g, "\r\n")}`));
	ok("CRLF の行でも読める", u.size === 2 && u.data[4] === 255);
	const x = await loadLUT("data:text/plain," + encodeURIComponent(`LUT_3D_SIZE 2\n${identity(2)}`));
	ok("拡張子が無くても見出し（LUT_3D_SIZE）で .cube と分かる", x.size === 2);
}
ok("行不足は reject", await rejects(loadLUT(cubeURL("LUT_3D_SIZE 4\n0 0 0\n1 1 1"))));
ok("1D の .cube は reject", await rejects(loadLUT(cubeURL("LUT_1D_SIZE 4\n0 0 0"))));
ok(".cube でない文章は reject", await rejects(loadLUT(cubeURL("hello world"))));
{
	const real = globalThis.fetch;
	globalThis.fetch = async () => new Response("nope", { status: 404 });
	ok("HTTP 404 は reject", await rejects(loadLUT("https://example.invalid/x.cube")));
	globalThis.fetch = real;
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ lut 全 PASS");
process.exit(fail ? 1 : 0);
