// convert/attrs.js ── 属性の選別（tippecanoe の -y / -x / -X 相当）。PMTiles（tags）と GeoParquet（列）で共用。
// include（残すキー）・exclude（落とすキー）・excludeAll（属性なし）。戻りは keep(key) → bool か、選別なしなら null。
// キーは平坦化後（"a.b"）でも元のまま（"a"）でも当たる。
export function attrFilter(opts = {}) {
	if (opts.excludeAll) return () => false;
	const inc = opts.include ? new Set(opts.include) : null, exc = opts.exclude ? new Set(opts.exclude) : null;
	if (!inc && !exc) return null;
	const hit = (set, k) => set.has(k) || (k.includes(".") && set.has(k.slice(0, k.indexOf("."))));
	return (k) => (!inc || hit(inc, k)) && !(exc && hit(exc, k));
}
