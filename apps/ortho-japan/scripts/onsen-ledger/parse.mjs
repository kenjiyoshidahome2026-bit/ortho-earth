// wikitext から Template:温泉 の項目・読み・座標を抜く（純関数。02-fetch.mjs と検定から使う）
import { PREF_RE } from "./lib.mjs";

/** wikitext から Template:温泉 の項目・読み・座標を抜く */
export function parse(text) {
  const r = {};
  // 読み: 冒頭の「'''名称'''（よみ）」。全角/半角括弧どちらも。
  const lead = text.replace(/\{\{[^{}]*(\{\{[^{}]*\}\}[^{}]*)*\}\}/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/g, "");
  const m = lead.match(/'''[^']+'''\s*[（(]\s*([ぁ-ゖー・、]+)/);
  if (m) r.reading = m[1].split(/[、・]/)[0];
  // 情報箱 Template:日本の温泉地（{{日本の温泉地 | 名称=… | 所在地=… | 泉質=… | 座標={{Coord|…}} | 緯度度=…}}）。
  // 注意: {{温泉}} は記事末尾のナビボックスで情報箱ではない。
  const tpl = extractTemplate(text, /\{\{\s*(日本の温泉地|Infobox 温泉|温泉地)\s*\|/i);
  if (tpl) {
    const f = tpl;
    r.address = clean(f["所在地"]); r.quality = clean(f["泉質"]); r.temp = clean(f["泉温"]); r.ph = clean(f["pH"] ?? f["ph"]);
    r.flow = clean(f["湧出量"]); r.liquid = clean(f["液性の分類"] ?? f["液性"]); r.osmotic = clean(f["浸透圧の分類"] ?? f["浸透圧"]); r.lodgings = clean(f["宿泊施設数"] ?? f["温泉施設数"]);
    r.transport = clean(f["交通アクセス"] ?? f["交通"]); r.site = (f["外部リンク"] || "").match(/https?:\/\/[^\s\]|]+/)?.[0]; r.nameInInfobox = clean(f["名称"]);
    const lat = dms(f["緯度度"], f["緯度分"], f["緯度秒"], f["N(北緯)及びS(南緯)"] ?? f["N(S)"] ?? f["NS"]), lon = dms(f["経度度"], f["経度分"], f["経度秒"], f["E(東経)及びW(西経)"] ?? f["E(W)"] ?? f["EW"]);
    if (lat != null && lon != null) r.tplCoord = [lon, lat];
    else if (f["座標"]) { const cm = f["座標"].match(/\{\{\s*coord\s*\|([^{}]*)\}\}/i); const v = cm && parseCoordTpl(cm[1]); if (v) r.tplCoord = v; } // 座標 = {{Coord|35|33|16|N|…}}（空の {{Coord}} は Wikidata 参照）
    r.hasInfobox = true;
  }
  // 本文中の {{coord|…}} / {{ウィキ座標2段度分秒|…}}
  const c = text.match(/\{\{\s*(?:coord|ウィキ座標2段度分秒|ウィキ座標度分秒)\s*\|([^{}]*)\}\}/i);
  if (c) { const v = parseCoordTpl(c[1]); if (v) r.textCoord = v; }
  // 泉質が infobox に無ければ本文の「泉質」節から
  if (!r.quality) { const q = text.match(/==+\s*泉質\s*==+\s*\n([\s\S]*?)(?:\n==|$)/); if (q) r.quality = clean(q[1].split("\n").map(l => l.replace(/^[*#:;]+\s*/, "")).find(l => l.trim()) || "")?.slice(0, 120); }
  const plain = clean(lead.slice(0, 600)) || "";
  const p = (r.address || "").match(PREF_RE) || plain.match(PREF_RE);
  if (p) r.pref = p[1];
  if (r.pref) { const src = r.address || plain; const mm = src.slice(src.indexOf(r.pref) + r.pref.length).match(/^[^、。（）\s]*?(?:郡[^、。（）\s]*?)?[^、。（）\s]*?(市|区|町|村)/); if (mm && mm[0].length <= 14) r.muni = mm[0]; }
  return r;
}
function extractTemplate(text, re) {
  const m = text.match(re); if (!m) return null;
  let i = m.index, depth = 0, start = i;
  for (; i < text.length; i++) { if (text.startsWith("{{", i)) { depth++; i++; } else if (text.startsWith("}}", i)) { depth--; i++; if (depth === 0) break; } }
  const body = text.slice(start + 2, i - 1);
  const f = {}; let cur = null, buf = "", d = 0, b = 0;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (body.startsWith("{{", k)) { d++; buf += "{{"; k++; continue; } if (body.startsWith("}}", k)) { d--; buf += "}}"; k++; continue; }
    if (body.startsWith("[[", k)) { b++; buf += "[["; k++; continue; } if (body.startsWith("]]", k)) { b--; buf += "]]"; k++; continue; }
    if (ch === "|" && d === 0 && b === 0) { if (cur != null) f[cur] = buf.trim(); buf = ""; cur = ""; let n = k + 1; while (n < body.length && body[n] !== "=" && body[n] !== "|" && !body.startsWith("}}", n)) n++; if (body[n] === "=") { cur = body.slice(k + 1, n).trim(); k = n; } else { cur = null; k = n - 1; } continue; }
    buf += ch;
  }
  if (cur != null) f[cur] = buf.trim();
  return f;
}
function clean(s) { if (!s) return undefined; return s.replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/g, "").replace(/<br\s*\/?>/gi, " / ").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/\{\{(?:lang|仮リンク)\|[^|}]*\|([^|}]*)[^}]*\}\}/g, "$1").replace(/\{\{[^{}]*\}\}/g, "").replace(/'''?/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || undefined; }
function dms(d, m, s, h) { if (d == null || d === "") return null; let v = +d + (+m || 0) / 60 + (+s || 0) / 3600; if (isNaN(v)) return null; if (/^[SW]/i.test(h || "")) v = -v; return +v.toFixed(6); }
function parseCoordTpl(args) {
  const a = args.split("|").map(s => s.trim()).filter(s => s && !s.includes("=") && !/^(display|type|region|scale|name|source|dim|format):?/.test(s));
  const n = a.filter(s => !/^[NSEW]$/i.test(s));
  const sgn = (i) => /^[SW]$/i.test(a[i] || "") ? -1 : 1;
  if (n.length === 2 && !isNaN(n[0])) return [+n[1], +n[0]];
  if (n.length === 4) return [sgn(a.indexOf(n[2]) + 2) * (+n[2] + n[3] / 60), sgn(a.indexOf(n[0]) + 2) * (+n[0] + n[1] / 60)];
  if (n.length === 6) { const lat = +n[0] + n[1] / 60 + n[2] / 3600, lon = +n[3] + n[4] / 60 + n[5] / 3600; const sl = /S/i.test(a[3] || "") ? -1 : 1, so = /W/i.test(a[7] || "") ? -1 : 1; return [+(so * lon).toFixed(6), +(sl * lat).toFixed(6)]; }
  return null;
}

// ---- 源泉と温泉地（温泉街・宿）の位置関係（Kenji 指示 2026-10-06: 福島の岳温泉のように源泉が離れている場合は分かるように）----
// 本文の文単位で「引湯・送湯・運搬」や「源泉が…離れ」を探す。設備内の配湯（本館から引湯 等）は拾わない。
//   返り値: { sourceSeparate, sourceKind:"引湯元あり"|"遠隔"|"運搬", sourceFrom:(引湯元の温泉記事名), sourceDistanceM, sourceNote, sourceCoord:[lon,lat] }
const DIST_RE = /(?:約|およそ|延長約?)?\s*(\d+(?:\.\d+)?)\s*(km|㎞|キロメートル|キロ|m|メートル)(?![²³])/;
const toMeters = m => m ? Math.round(+m[1] * (/^(km|㎞|キロ)/.test(m[2]) ? 1000 : 1)) : undefined;
export function sourceInfo(text, title = "") {
  const r = {};
  let body = text.replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/g, ""), prev;
  do { prev = body; body = body.replace(/<!--[\s\S]*?-->/g, ""); } while (body !== prev);
  body = body.replace(/<!--|-->/g, "");   // 入れ子・閉じていない註釈の残りも消す
  const core = title.replace(/ \(.*\)$/, "").replace(/温泉郷?$/, "");
  for (const raw of body.split(/[。\n]/)) {
    const s = raw.trim(); if (!s) continue;
    const plain = s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1"); // リンク記法を外した文（語の並びの判定用）
    const hasPipe = /引湯|引き湯|送湯|配湯管|湯を引/.test(s), hasCarry = /タンクローリー|運搬|運んで/.test(s) && /源泉|湯/.test(s);
    const hasFar = /源泉[^、]{0,30}?(離れ|遠く|隔た)|(離れた|遠く離れた|離れている)[^、]{0,20}?源泉/.test(s);
    if (!hasPipe && !hasCarry && !hasFar) continue;
    if (/ボーリング|掘削|水位|深さ|地下\d/.test(s) && !hasPipe) continue;
    if (/やや離れ|少し離れ/.test(s) && !hasPipe) continue; // 施設の配置の話
    if (/(ここ|当温泉|当地|この温泉|本温泉)からの?(引湯|引き湯|送湯)/.test(plain)) continue; // 自分が引湯元
    if (core && new RegExp(core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(温泉郷?|鉱泉)?からの?(引湯|引き湯|送湯)").test(plain)) continue; // 自分が他所の引湯元になっている文
    // 引湯元の温泉記事（[[X温泉|…]]から引湯）。自分自身・同名は除く。
    const from = [...s.matchAll(/\[\[([^\]|#]*(?:温泉|鉱泉|源泉)[^\]|#]*)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\][^\]。]{0,12}?(?:から|より|の湯を)[^。]{0,12}?(?:引湯|引き湯|送湯|引|運)/g)].map(m => m[1].trim()).filter(t => !/^(源泉|温泉|引湯|鉱泉|温泉街|温泉地|温泉郷)$/.test(t) && (!core || !t.replace(/温泉郷?$/, "").startsWith(core)));
    // 「[[X温泉]]へ/に引湯・送湯」は X が引湯先（自分が源泉側）なので引湯元とは見ない
    const dest = /\]\][^\]。]{0,8}?(?:へ|に)[^。]{0,10}?(?:引湯|送湯|引かれ|送られ)/.test(s) && !from.length;
    if (dest && !hasFar && !hasCarry) continue;
    const dist = toMeters((hasPipe || hasFar || hasCarry) ? s.match(DIST_RE) : null);
    // 設備内の配湯だけの文（距離も引湯元も遠さも無い）は見送る
    if (!from.length && dist == null && !hasFar && !hasCarry) continue;
    r.sourceSeparate = true;
    r.sourceKind ??= from.length ? "引湯元あり" : hasCarry ? "運搬" : "遠隔";
    if (from.length && !r.sourceFrom) r.sourceFrom = from[0];
    if (dist != null && r.sourceDistanceM == null) r.sourceDistanceM = dist;
    if (!r.sourceNote) r.sourceNote = s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/\{\{[^{}]*\}\}/g, "").replace(/'''?/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  // 「源泉」の語の近く（直前 80 字）にある座標テンプレートは源泉の座標とみなす
  for (const m of body.matchAll(/\{\{\s*(?:coord|ウィキ座標2段度分秒|ウィキ座標度分秒)\s*\|([^{}]*)\}\}/gi)) {
    const before = body.slice(Math.max(0, m.index - 80), m.index);
    if (/源泉/.test(before) || /name\s*=\s*[^|}]*源泉/.test(m[1])) { const v = parseCoordTpl(m[1]); if (v) { r.sourceCoord = v; r.sourceSeparate = true; r.sourceKind ??= "源泉座標あり"; break; } }
  }
  return r;
}
