// MapLibre の口（src/maplibre/・公式例の門 §8）の「無い口」の記録＝投げずに 1 回だけ console へ（地図ごと・口ごと）。
// 書式 `[mlshim] unsupported: <口> (<kind>)` は門の走らせ台（scripts/verify-examples.mjs）が拾って順位表にする＝変えない。
// kind＝"semantic"（描く・答える・動かす口＝段 2 を塞ぐ）／"cosmetic"（見た目の付け足し・操作の手触り＝段を塞がない）
const seen = new WeakMap();
export function unsupported(owner, name, kind = "semantic") {
	let s = seen.get(owner);
	if (!s) seen.set(owner, (s = new Set()));
	if (s.has(name)) return;
	s.add(name);
	console.warn(`[mlshim] unsupported: ${name} (${kind})`);
}
