// 門：URL で読まれるオーバーレイの .js（生成物）が正本の .ts と合っているか（scripts/build-overlays.mjs --check）。使い方：node packages/globe/tests/overlays-gen.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const r = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/build-overlays.mjs", import.meta.url)), "--check"], { stdio: "inherit" });
process.exit(r.status ?? 1);
