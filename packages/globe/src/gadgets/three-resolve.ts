// three.js の bare import を render worker の中で解く（map.addThree・2026-10-18）。
// worker には import map が無い＝利用者のモジュールや three の addons（GLTFLoader 等）が書く `import … from "three"`・`"three/addons/…"` はそのままでは読めない。
// そこで本文を取ってきて指定子を絶対 URL に書き換え、blob: の URL で import する：
//   "three"                          → opts.three（three.module.js の URL）＝setup の THREE と同じ実体（同じ URL＝module map で 1 つ）
//   "three/addons/…"・"three/examples/jsm/…" → addons の基底 + 残り（既定＝three の URL の /build/three.module.js を /examples/jsm/ に）
//   相対（./ ../ /）                 → 元の URL で解いて、その先も同じく書き換える（blob: は相対を解けない）
//   import.meta.url                  → 元の URL（模型を new URL("./a.glb", import.meta.url) で引く書き方がそのまま効く）
// 利用者のモジュールは常に書き換えて読む（相対の先が bare の three を書いていても解ける）。setup の THREE だけを使う従来の書き方もそのまま動く。
// 正規表現で指定子を拾う（構文解析はしない）。注釈は先に伏せる（three の addons は JSDoc の @example に自分自身の import を書く＝拾うと自分を辿る循環になる）。
// 文字列の中の "from '…'" は拾い得るが、three の名前か相対でなければ触らない。

/** import 文・export … from・動的 import の指定子 */
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;

/** 注釈（/* … *\/・// …）を同じ長さの空白に伏せる（位置を保つ＝伏せた本文で見つけた位置を元の本文で置き換える）。"://" の // は伏せない */
export const maskComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre: string | undefined) => pre != null ? pre + " ".repeat(m.length - pre.length) : m.replace(/[^\n]/g, " "));

/** 三つの名前の基底 */
export interface ThreeSpecMap { three: string; addons: string | null }

/** three の URL から addons の基底を推す（build/three.module(.min).js → examples/jsm/）。推せない＝null */
export function addonsBaseOf(threeUrl: string): string | null {
	const m = /^(.*\/)build\/three\.module(\.min)?\.js(\?.*)?$/.exec(threeUrl);
	return m ? m[1] + "examples/jsm/" : null;
}

/** 指定子を解く。戻り＝{ url, rewrite }（rewrite＝その先も書き換えて読む）・null＝触らない（よその bare・http の絶対 URL） */
export function resolveSpec(spec: string, base: string, map: ThreeSpecMap): { url: string; rewrite: boolean } | null {
	if (spec === "three") return { url: map.three, rewrite: false };
	if (spec === "three/webgpu" || spec === "three/tsl") return { url: new URL(spec === "three/webgpu" ? "three.webgpu.js" : "three.tsl.js", map.three).href, rewrite: false };   // build/ の隣（three.core.js を共有＝同じ実体）
	const sub = /^three\/(addons|examples\/jsm)\/(.+)$/.exec(spec);
	if (sub) {
		if (!map.addons) throw new Error(`three overlay: cannot resolve "${spec}" (pass addons: <URL of three/examples/jsm/>)`);
		return { url: new URL(sub[2], map.addons).href, rewrite: true };
	}
	if (/^\.{0,2}\//.test(spec)) return { url: new URL(spec, base).href, rewrite: true };
	return null;
}

/** 本文の指定子を置き換える（resolved＝指定子 → 置き換える URL）。import.meta.url は元の URL に */
export function rewriteSource(src: string, url: string, resolved: (spec: string) => string | null) {
	const masked = maskComments(src), edits: Array<[number, number, string]> = [];
	SPEC_RE.lastIndex = 0;
	for (let m; (m = SPEC_RE.exec(masked));) { const u = resolved(m[3]); if (u != null) { const at = m.index + m[1].length + 1; edits.push([at, at + m[3].length, u]); } }
	for (const m of masked.matchAll(/\bimport\.meta\.url\b/g)) edits.push([m.index!, m.index! + m[0].length, JSON.stringify(url)]);
	edits.sort((a, b) => b[0] - a[0]);
	let out = src;
	for (const [a, b, u] of edits) out = out.slice(0, a) + u + out.slice(b);
	return out;
}

/** 指定子の一覧（重複なし・注釈の中は数えない） */
export function specifiersOf(src: string) { const out = new Set<string>(), masked = maskComments(src); SPEC_RE.lastIndex = 0; for (let m; (m = SPEC_RE.exec(masked));) out.add(m[3]); return [...out]; }

/** 書き換えて読む仕掛け（overlay の実体ごとに 1 つ＝blob: の URL を destroy で返す） */
export function createThreeLoader(map: ThreeSpecMap, fetchText: (url: string) => Promise<string> = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`three overlay: ${r.status} ${u}`); return r.text(); }) {
	const done = new Map<string, Promise<string>>(), blobs: string[] = [];
	async function blobOf(url: string, stack: string[]): Promise<string> {
		if (stack.includes(url)) throw new Error(`three overlay: circular import ${[...stack, url].join(" → ")}`);
		let p = done.get(url);
		if (!p) {
			p = (async () => {
				const src = await fetchText(url), table = new Map<string, string>();
				for (const spec of specifiersOf(src)) {
					const r = resolveSpec(spec, url, map);
					if (r) table.set(spec, r.rewrite ? await blobOf(r.url, [...stack, url]) : r.url);
				}
				const b = URL.createObjectURL(new Blob([rewriteSource(src, url, s => table.get(s) ?? null)], { type: "text/javascript" }));
				blobs.push(b);
				return b;
			})();
			done.set(url, p);
		}
		return p;
	}
	return {
		/** 書き換えた本文の blob: の URL（検定はここで本文を見る） */
		prepare: (url: string) => blobOf(url, []),
		/** 利用者のモジュールを読む（指定子を書き換えた blob: で） */
		async load(url: string): Promise<unknown> { return import(/* @vite-ignore */ await blobOf(url, [])); },
		/** 利用者が実行時に addons を読む口（h.importAddon("loaders/GLTFLoader.js")） */
		async addon(path: string): Promise<unknown> {
			const r = resolveSpec("three/addons/" + path.replace(/^\/+/, ""), map.three, map)!;
			return import(/* @vite-ignore */ await blobOf(r.url, []));
		},
		dispose() { for (const b of blobs.splice(0)) URL.revokeObjectURL(b); done.clear(); },
	};
}
