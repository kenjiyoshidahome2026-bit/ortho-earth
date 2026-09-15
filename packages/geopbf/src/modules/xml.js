// XML のエスケープ/アンエスケープ＝encoder（kmz/gml/gpx）と decoder（gml/kmz）の単一実装（旧＝5 ファイルに 4 重定義・gpx 版だけ " を
// 逃がさず属性値に " が入ると壊れた・俯瞰レビュー 2026-09-15）。
export const escXML = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const unescXML = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
