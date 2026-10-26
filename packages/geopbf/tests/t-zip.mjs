#!/usr/bin/env node
// encodeZIP/decodeZIP の常設検定。要点＝**64KB を超えるファイル**（ストリームが複数チャンクに割れる）。
// 2026-09-21 の実バグ：CRC をチャンク毎に確定（^-1）していたため、1 チャンクに収まらないファイルだけ
// 「bad CRC」で出ていた（unzip -t が落ちる・実物は解凍できるので気づきにくい）。
import { encodeZIP } from "../src/modules/encodeZIP.ts";
import { decodeZIP } from "../src/modules/decodeZIP.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = 0, ng = 0;
const t = (name, cond) => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name); } };

const small = new TextEncoder().encode("hello glTF");
const big = new Uint8Array(1_500_000);
for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 8)) & 255;   // deflate が縮む程度の規則性

const zip = await encodeZIP([new File([small], "a.txt"), new File([big], "b.bin")]);
const buf = Buffer.from(await zip.arrayBuffer());
const f = path.join(os.tmpdir(), `geopbf-zip-${process.pid}.zip`);
fs.writeFileSync(f, buf);
try {
	const out = execFileSync("unzip", ["-t", f], { encoding: "utf8" });
	t("unzip -t が CRC を通す（64KB 超のファイル込み）", /No errors detected/.test(out));
} catch (e) { t("unzip -t が CRC を通す（64KB 超のファイル込み）", false); console.error(String(e.stdout || e.message).slice(0, 400)); }

const back = await decodeZIP(new Blob([buf]));
const byName = Object.fromEntries((Array.isArray(back) ? back : [back]).map(x => [x.name, x]));
t("2 ファイルとも戻る", !!byName["a.txt"] && !!byName["b.bin"]);
if (byName["b.bin"]) {
	const got = new Uint8Array(await byName["b.bin"].arrayBuffer());
	t("大きいファイルが byte 一致", got.length === big.length && got.every((v, i) => v === big[i]));
}
fs.rmSync(f, { force: true });

// UTF-8 フラグの無い Shift_JIS 名（国土数値情報の A09・A53-2023 等の zip）。中身の文字コード（utf8）が名前に渡っても化けない（2026-10-26）
const sjisZip = (nameBytes, body) => {   // 無圧縮・フラグ 0 の 1 本だけの zip を手で組む
	const n = nameBytes.length, len = body.length;
	const lfh = new Uint8Array(30 + n), cdh = new Uint8Array(46 + n), eocd = new Uint8Array(22);
	const lv = new DataView(lfh.buffer), cv = new DataView(cdh.buffer), ev = new DataView(eocd.buffer);
	lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, len, true); lv.setUint32(22, len, true); lv.setUint16(26, n, true); lfh.set(nameBytes, 30);
	cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, len, true); cv.setUint32(24, len, true); cv.setUint16(28, n, true); cdh.set(nameBytes, 46);
	ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, cdh.length, true); ev.setUint32(16, lfh.length + len, true);
	return new Blob([lfh, body, cdh, eocd]);
};
const sjisName = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x2e, 0x74, 0x78, 0x74]);   // 「日本.txt」の Shift_JIS
const sz = sjisZip(sjisName, new TextEncoder().encode("ok"));
t("SJIS 名（フラグ無し）を既定で読む", (await decodeZIP(sz, "日本.txt"))?.name === "日本.txt");
t("SJIS 名（フラグ無し）を encoding utf8 でも読む（native-bucket の Fetch の渡し方）", (await decodeZIP(sz, { target: "日本.txt", encoding: "utf8" }))?.name === "日本.txt");
t("UTF-8 名（フラグ無し）はそのまま", (await decodeZIP(sjisZip(new TextEncoder().encode("日本.txt"), new TextEncoder().encode("ok")), "日本.txt"))?.name === "日本.txt");
console.log(ng ? `\nFAIL ${ng}` : `\nPASS ${ok}`);
process.exit(ng ? 1 : 0);
