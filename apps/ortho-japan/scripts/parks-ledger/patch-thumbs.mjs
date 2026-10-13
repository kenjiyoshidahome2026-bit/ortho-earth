// Commons の API で 640px のサムネを「作らせて」URL を得る（任意幅の直叩きは 400＝API 経由で生成された幅だけが配信される・2026-10 実測）。utm の query は落とす
const UA = { "User-Agent": "ortho-earth-parks/0.1 (kenji.yoshida.home.2026@gmail.com)" };
import fs from "node:fs";
const path = process.argv[2];
const doc = JSON.parse(fs.readFileSync(path, "utf8"));
const strip = u => u ? u.split("?")[0] : u;
const files = doc.parks.map(p => p.photo?.file).filter(Boolean);
console.error("files with name", files.length);
// 台帳に file 名が無い（build-ledger が落とした）＝src から復元
for (const p of doc.parks) if (p.photo?.src && !p.photo.file) p.photo.file = decodeURIComponent(strip(p.photo.src).replace(/^.*\/\d+px-/, "").replace(/^.*\/commons\/[0-9a-f]\/[0-9a-f]{2}\//, ""));
const all = doc.parks.map(p => p.photo?.file).filter(Boolean);
const got = {};
for (let i = 0; i < all.length; i += 10) {
	const titles = all.slice(i, i + 10).map(f => "File:" + f).join("|");
	const j = await (await fetch(`https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&iiurlwidth=640&titles=${encodeURIComponent(titles)}&format=json`, { headers: UA })).json();
	for (const pg of Object.values(j.query.pages)) { const ii = pg.imageinfo?.[0]; if (ii) got[pg.title.replace(/^File:/, "").replace(/ /g, "_")] = strip(ii.thumburl); }
}
let bad = 0;
for (const p of doc.parks) {
	if (!p.photo) continue;
	p.photo.src = strip(p.photo.src); p.photo.thumb = got[p.photo.file.replace(/ /g, "_")] ?? p.photo.src;
	for (const u of [p.photo.src, p.photo.thumb]) { const r = await fetch(u, { method: "HEAD", headers: UA }); if (!r.ok) { bad++; console.error("✗", r.status, p.id, u); } }
}
fs.writeFileSync(path, JSON.stringify(doc, null, 1));
console.log("done, bad =", bad);
