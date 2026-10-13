// 型の門（1.15.0〜）：types/*.d.ts が自分で矛盾せず、公開の口を TypeScript から呼べることを tsc --noEmit で見る。
// tsc は root の devDependency（typescript）。無ければ落ちる（npm install を促す）。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");   // root の devDependency
if (!existsSync(tsc)) { console.error("types: typescript not installed (npm install at the repository root)"); process.exit(1); }
const r = spawnSync(process.execPath, [tsc, "-p", path.join(here, "fixtures/types/tsconfig.json")], { encoding: "utf8" });
if (r.status !== 0) { console.error(r.stdout || r.stderr); console.error("types: FAIL"); process.exit(1); }
console.log("types: ok");
