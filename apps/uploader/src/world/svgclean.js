// 国旗 SVG の無害化（S7・2026-09-25）＝旧 FlagSVG.clean の現代版。bucket へ置く前に通す。
// 落とす物：実行できる要素（script・foreignObject・iframe・embed・object）／on* 属性／
//          href・xlink:href のうち自前の #id と data:image/ 以外（外部参照・javascript:）／javascript: を含む属性値／
//          <style> の @import と url(外部)。
// 旗の見た目に要る物（path・g・defs・use の #参照・linearGradient・style の色）は残す。
// 何も落とさなかった旗は元のバイト列のまま返す（XMLSerializer の書き直しで 267 旗のバイトが一斉に変わらないように）。
const BAD_EL = new Set(["script", "foreignobject", "iframe", "embed", "object"]);
const okRef = v => v.startsWith("#") || v.startsWith("data:image/");

/** SVG の文字列を無害化する。戻り＝{ text, removed }（removed＝落とした物の数・0 なら text は入力のまま） */
export function cleanSVGText(text, { parser = new DOMParser(), serializer = new XMLSerializer() } = {}) {
	const doc = parser.parseFromString(text, "image/svg+xml");
	const root = doc.documentElement;
	if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("SVG として読めない");
	let removed = 0;
	const walk = el => {
		for (const c of [...el.children]) {
			if (BAD_EL.has(c.localName.toLowerCase())) { c.remove(); removed++; continue; }
			walk(c);
		}
		for (const a of [...el.attributes]) {
			const n = a.name.toLowerCase(), v = a.value.replace(/\s+/g, "").toLowerCase();
			if (n.startsWith("on") || ((n === "href" || n.endsWith(":href")) && !okRef(v)) || v.includes("javascript:")) { el.removeAttribute(a.name); removed++; }
		}
	};
	walk(root);
	for (const s of [...root.getElementsByTagName("style")]) {
		const css = s.textContent, out = css.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(['"]?)(?!#|data:image\/)[^)]*\)/gi, "none");
		if (out !== css) { s.textContent = out; removed++; }
	}
	return removed ? { text: serializer.serializeToString(doc), removed } : { text, removed: 0 };
}

/** File → 無害化した File（何も落とさなければ同じ File をそのまま返す） */
export async function cleanSVG(file) {
	const { text, removed } = cleanSVGText(await file.text());
	if (!removed) return file;
	console.warn(`[flag] ${file.name}: ${removed} か所を無害化して保存`);
	return new File([text], file.name, { type: "image/svg+xml" });
}
