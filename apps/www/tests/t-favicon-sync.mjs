// favicon の写しの門（2026-10-23）＝正本 assets/favicon.svg・apple-touch-icon.png から配った物がずれていないか（ずれたら node scripts/favicon-sync.mjs）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { targets } from "../../../scripts/favicon-sync.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("各アプリの favicon＝正本（japan の球儀マーク）と同じ写し", () => {
	const t = targets();
	assert.ok(t.filter(([f]) => f.endsWith("favicon.svg")).length >= 10, `${t.length} files`);
	for (const app of ["quiz", "himekuri", "yokohama"]) assert.ok(t.some(([f]) => f.includes(`/apps/${app}/public/favicon.svg`)), app);
	const stale = t.filter(([f, src]) => !readFileSync(f).equals(readFileSync(src))).map(([f]) => path.relative(ROOT, f));
	assert.deepEqual(stale, [], "run node scripts/favicon-sync.mjs");
});
