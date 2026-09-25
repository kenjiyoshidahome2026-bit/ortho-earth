// t-dissolve: 同じ属性の地物の併合（extension/dissolve.js）が、型の違う値を同じ属性とみなさないこと（B7・2026-09-25）
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf-base.js";
import { dissolve } from "../src/extension/dissolve.js";
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const P = (props, c) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });
for (const [tag, feats, want] of [
	['1 と "1" は別の地物', [P({ k: 1 }, [0, 0]), P({ k: "1" }, [1, 1])], 2],
	['"" と null は別の地物', [P({ k: "" }, [0, 0]), P({ k: null }, [1, 1])], 2],
	['{a:"a|",b:"b"} と {a:"a",b:"|b"} は別の地物', [P({ a: "a|", b: "b" }, [0, 0]), P({ a: "a", b: "|b" }, [1, 1])], 2],
	["同じ属性はまとまる（従来どおり）", [P({ k: 1 }, [0, 0]), P({ k: 1 }, [1, 1])], 1],
]) {
	const p = await new GeoPBF().set({ type: "FeatureCollection", features: feats });
	await dissolve(p);
	ok(p.length === want, `${tag}（${p.length} 件）`);
}
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
