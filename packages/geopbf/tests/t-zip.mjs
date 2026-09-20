#!/usr/bin/env node
// encodeZIP/decodeZIP の常設検定。要点＝**64KB を超えるファイル**（ストリームが複数チャンクに割れる）。
// 2026-09-21 の実バグ：CRC をチャンク毎に確定（^-1）していたため、1 チャンクに収まらないファイルだけ
// 「bad CRC」で出ていた（unzip -t が落ちる・実物は解凍できるので気づきにくい）。
import { encodeZIP } from "../src/modules/encodeZIP.js";
import { decodeZIP } from "../src/modules/decodeZIP.js";
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
console.log(ng ? `\nFAIL ${ng}` : `\nPASS ${ok}`);
process.exit(ng ? 1 : 0);
