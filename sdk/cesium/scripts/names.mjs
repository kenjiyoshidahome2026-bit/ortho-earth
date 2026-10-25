// Writes the explicit export lists of src/index.ts (between the "names:" markers) from the installed @cesium/core and @cesium/widgets.
// Explicit exports win over `export * from "@cesium/engine"` (which still re-exports core classes behind a deprecation proxy); a second
// `export *` would make every shared name ambiguous and drop it. Run after updating the Cesium packages: node scripts/names.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const req = createRequire(import.meta.url);
const dir = p => path.dirname(req.resolve(`${p}/package.json`));
const names = (pkg, skip = []) => [...fs.readFileSync(path.join(dir(pkg), "index.js"), "utf8").matchAll(/export \{ default as (\w+) \}/g)].map(m => m[1]).filter(n => !skip.includes(n)).sort();
// names the package's d.ts declares as values; the rest (internals the build exports at run time, or names the d.ts has only as types)
// go on lines of their own under @ts-ignore, so the namespace matches the real Cesium's and tsc still checks everything else
const typed = pkg => new Set([...fs.readFileSync(path.join(dir(pkg), "index.d.ts"), "utf8").matchAll(/^export (?:declare )?(?:abstract )?(?:class|function|namespace|enum|const|var|let) (\w+)/gm)].map(m => m[1]));
const wrap = a => a.reduce((o, x) => { const l = o[o.length - 1]; if ((l + ", " + x).length > 150) o.push(x); else o[o.length - 1] = l ? l + ", " + x : x; return o; }, [""]).map(l => "\t" + l + ",").join("\n");
const list = (pkg, skip = []) => {
	const all = names(pkg, skip), t = typed(pkg);
	const untyped = all.filter(n => !t.has(n)).map(n => `\t// @ts-ignore -- not in the d.ts\n\t${n},`).join("\n");
	return `export {\n${wrap(all.filter(n => t.has(n)))}\n${untyped}\n} from "${pkg}";`;
};
const block = `// names: (scripts/names.mjs)\n${list("@cesium/core")}\n${list("@cesium/widgets", ["Viewer"])}\n// :names`;
const f = new URL("../src/index.ts", import.meta.url), s = fs.readFileSync(f, "utf8");
fs.writeFileSync(f, /\/\/ names:[\s\S]*?\/\/ :names/.test(s) ? s.replace(/\/\/ names:[\s\S]*?\/\/ :names/, block) : s.replace('export * from "./names.ts";', block));
console.log("ok");
