// PB2002（Bird 2003, Geochem. Geophys. Geosyst. 4(3) 1027）のテキスト形式を読む。原本＝peterbird.name/oldFTP/PB2002/（自由利用・要引用）
//   *.dig: 見出し行（プレート記号 "AF" / 境界 "AF-AN  出典"）＋ " lon,lat" 行 …＋ "*** end of line segment ***"
//   PB2002_steps.dat: 1 行 1 ステップ（連番・境界・lon1 lat1 lon2 lat2・長さ km・方位・速度…・末尾に種別 OSR/OTF/OCB/CRB/CTF/CCB/SUB）
//   先頭の ":" は前のステップと連続、末尾の "*" は種別の決め方が特例（Bird の注記）
export const PLATE_NAMES = { AF: "Africa", AM: "Amur", AN: "Antarctica", AP: "Altiplano", AR: "Arabia", AS: "Aegean Sea", AT: "Anatolia", AU: "Australia", BH: "Birds Head", BR: "Balmoral Reef", BS: "Banda Sea", BU: "Burma", CA: "Caribbean", CL: "Caroline", CO: "Cocos", CR: "Conway Reef", EA: "Easter", EU: "Eurasia", FT: "Futuna", GP: "Galapagos", IN: "India", JF: "Juan de Fuca", JZ: "Juan Fernandez", KE: "Kermadec", MA: "Mariana", MN: "Manus", MO: "Maoke", MS: "Molucca Sea", NA: "North America", NB: "North Bismarck", ND: "North Andes", NH: "New Hebrides", NI: "Niuafo'ou", NZ: "Nazca", OK: "Okhotsk", ON: "Okinawa", PA: "Pacific", PM: "Panama", PS: "Philippine Sea", RI: "Rivera", SA: "South America", SB: "South Bismarck", SC: "Scotia", SL: "Shetland", SO: "Somalia", SS: "Solomon Sea", SU: "Sunda", SW: "Sandwich", TI: "Timor", TO: "Tonga", WL: "Woodlark", YA: "Yangtze" };
export const STEP_CLASSES = { OSR: "oceanic spreading ridge", OTF: "oceanic transform fault", OCB: "oceanic convergent boundary", CRB: "continental rift boundary", CTF: "continental transform fault", CCB: "continental convergent boundary", SUB: "subduction zone" };
export function parseDig(text) {   // → [{ head, coords: [[lon,lat],…] }]
	const out = []; let cur = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd(); if (!line) continue;
		if (line.startsWith("***")) { if (cur && cur.coords.length) out.push(cur); cur = null; continue; }
		if (/^\s*[-+]?\d/.test(line)) { const [x, y] = line.trim().split(",").map(Number); if (cur) cur.coords.push([x, y]); }
		else cur = { head: line.trim(), coords: [] };
	}
	if (cur && cur.coords.length) out.push(cur);
	return out;
}
export function plates(text) {   // → { code: [[lon,lat],…] }（閉じた環）
	const out = {};
	for (const { head, coords } of parseDig(text)) { const code = head.split(/\s+/)[0]; const r = coords.slice(); if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0]); out[code] = r; }
	return out;
}
export function steps(text) {   // → [{ seq, boundary, cont, a:[lon,lat], b:[lon,lat], cls, flag }]
	const out = [];
	for (const raw of text.split(/\r?\n/)) {
		const f = raw.trim().split(/\s+/); if (f.length < 8 || !/^\d+$/.test(f[0])) continue;
		const b = f[1], last = f[f.length - 1];
		out.push({ seq: +f[0], boundary: b.replace(/^:/, ""), cont: b.startsWith(":"), a: [+f[2], +f[3]], b: [+f[4], +f[5]], cls: last.replace(/[^A-Z]/g, ""), flag: last.includes("*") });
	}
	return out;
}
export function boundaryLines(stepList) {   // 連続する同じ境界・同じ種別のステップを 1 本の線に
	const lines = []; let cur = null;
	for (const s of stepList) {
		if (cur && cur.boundary === s.boundary && cur.cls === s.cls && s.cont && Math.abs(cur.coords[cur.coords.length - 1][0] - s.a[0]) < 1e-6 && Math.abs(cur.coords[cur.coords.length - 1][1] - s.a[1]) < 1e-6) { cur.coords.push(s.b); continue; }
		cur = { boundary: s.boundary, cls: s.cls, coords: [s.a, s.b] }; lines.push(cur);
	}
	return lines;
}
