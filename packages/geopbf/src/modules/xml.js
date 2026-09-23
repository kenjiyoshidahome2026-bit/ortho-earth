// XML のエスケープ/アンエスケープ＝encoder（kmz/gml/gpx）と decoder（gml/kmz）の単一実装（旧＝5 ファイルに 4 重定義・gpx 版だけ " を
// 逃がさず属性値に " が入ると壊れた・俯瞰レビュー 2026-09-15）。
export const escXML = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescText = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
// CDATA（<![CDATA[…]]>）はそのまま中身＝逃がし記号を戻さない（CDATA の中の "&amp;" は字面どおり）。外側だけ unescText。
// 旧＝CDATA を剥がさず <![CDATA[名前]]> が名前になっていた（KML の description・一部の GPX 書き出しで常用・2026-09-23）
export const unescXML = s => String(s).split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map(p => p.startsWith("<![CDATA[") ? p.slice(9, -3) : unescText(p)).join("");
