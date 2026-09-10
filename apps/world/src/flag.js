// ── 国旗 svg の小道具（旧 FlagSVG の必要分だけ）── url()/format()/ratio()/colors()
const gcd = (a, b) => b ? gcd(b, a % b) : a;
// 旗は bucket の個別ファイル（flags/<key>.svg）＝URL を直接 <img> に渡し、本文（縦横比/色/DL）は必要時に fetch
export function makeFlag(url) {
	let text = null;
	const load = async () => text || (text = await fetch(url).then(r => r.ok ? r.text() : "").catch(() => ""));
	return {
		url: () => url,
		format: async () => new Blob([await load()], { type: "image/svg+xml" }),
		// 縦横比＝viewBox（無ければ width/height）を最大公約数で約分（例: 3:2）
		ratio: async () => {
			const s = await load();
			let m = s.match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/);
			if (!m) { const w = s.match(/\swidth="([\d.]+)/), h = s.match(/\sheight="([\d.]+)/); m = (w && h) ? [0, w[1], h[1]] : null; }
			if (!m) return "-";
			const [w, h] = [Math.round(+m[1] * 100), Math.round(+m[2] * 100)], g = gcd(w, h) || 1;
			const [rw, rh] = [w / g, h / g];
			return (rw > 50 || rh > 50) ? `${(+m[1] / +m[2]).toFixed(2)}:1` : `${rw}:${rh}`;
		},
		// 使用色＝fill/stroke の色値（#rgb→#rrggbb・named color は素通し・none/url() 除外）を出現順で
		colors: async () => {
			const s = await load(), out = [], seen = new Set();
			for (const m of s.matchAll(/(?:fill|stroke)\s*[:=]\s*"?\s*(#[0-9a-fA-F]{3,8}|rgb\([^)]*\)|[a-zA-Z]+)/g)) {
				let c = m[1].toLowerCase(); if (c == "none" || c == "transparent" || c == "currentcolor" || c.startsWith("url")) continue;
				if (/^#[0-9a-f]{3}$/.test(c)) c = "#" + [...c.slice(1)].map(x => x + x).join("");
				if (!seen.has(c)) { seen.add(c); out.push(c); }
			}
			return out;
		},
	};
}
