// Wikipedia「List of national parks of the United States」の wikitext（action=raw）→ list.json（63 行：en 記事名・州・座標・指定日・面積 acre・来訪者・写真・一文）
import fs from "node:fs";
const [src, out] = process.argv.slice(2);
const w = fs.readFileSync(src, "utf8");
const table = w.slice(w.indexOf('{| class="wikitable sortable"'), w.indexOf("\n|}", w.indexOf('{| class="wikitable sortable"')));
const rows = table.split(/\n\|-\s*\n/).slice(1);
const MONTH = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const strip = s => s.replace(/<ref[^>]*\/>/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "").replace(/\{\{[^{}]*\}\}/g, "").replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/'{2,}/g, "").replace(/<[^>]+>/g, "").trim();
const list = [];
for (const r of rows) {
	const cells = r.split(/\n\|(?!\|)/);   // 先頭＝!scope="row" | [[Title|Short]]
	const m = cells[0].match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/); if (!m) continue;
	const title = m[1], short = (m[2] || m[1]).replace(/&nbsp;/g, " ");
	const img = (cells[1] || "").match(/\[\[File:([^\]|]+)/)?.[1]?.trim() ?? null;
	const loc = cells[2] || "";
	const states = [...loc.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(x => x[1]);
	const co = loc.match(/\{\{coord\|(-?[\d.]+)\|(-?[\d.]+)/);
	const d = (cells[3] || "").match(/\{\{dts\|([A-Z][a-z]+) (\d+), (\d{4})/);
	const a = (cells[4] || "").match(/\{\{convert\|([\d,.]+)\|acre/);
	const v = strip(cells[5] || "").replace(/,/g, "");
	const desc = strip(cells.slice(6).join("|"));
	list.push({ title, short, image: img, states, coord: co ? [+co[2], +co[1]] : null,
		established: d ? `${d[3]}-${String(MONTH[d[1]]).padStart(2, "0")}-${d[2].padStart(2, "0")}` : null,
		areaAcres: a ? +a[1].replace(/,/g, "") : null, visitors: /^\d+$/.test(v) ? +v : null, desc });
}
fs.writeFileSync(out, JSON.stringify(list, null, 1));
console.log(list.length, "rows;", list.filter(x => !x.established || !x.areaAcres || !x.coord || !x.states.length).map(x => x.title));
