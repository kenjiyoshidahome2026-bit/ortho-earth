const { PI, max, min, sin, asin, cos, sqrt, log, tan, atan, atan2, exp } = Math, rad = PI / 180;

export type Pt = [number, number];
/** d3 風の投影（関数＋設定子）。設定子は引数無しで現在値・引数ありで設定して自分を返す */
export interface Projection {
	(p: Pt): Pt | null;
	invert(p: Pt): Pt | null;
	rotate(): number[];
	rotate(v: number[]): Projection;
	scale(): number;
	scale(v: number): Projection;
	translate(): number[];
	translate(v: number[]): Projection;
	fitExtent(e: [Pt, Pt]): Projection;
}

export function geoOrthographic(): Projection {
	let r = [0, 0, 0], s = 150, t = [480, 250], sφ = 0, cφ = 0, sγ = 0, cγ = 0;
	const up = () => (sφ = sin(r[1] * rad), cφ = cos(r[1] * rad), sγ = sin(r[2] * rad), cγ = cos(r[2] * rad));
	const p = (([ln, lt]: Pt): Pt | null => {
		const l = (ln + r[0]) * rad, φ = lt * rad, cp = cos(φ), sp = sin(φ), cl = cos(l), sl = sin(l);
		const x = cp * sl, y = sp, z = cp * cl, yr = y * cφ + z * sφ, zr = z * cφ - y * sφ;
		return zr < 0 ? null : [t[0] + s * (x * cγ - yr * sγ), t[1] - s * (x * sγ + yr * cγ)];
	}) as Projection;
	p.invert = ([px, py]: Pt): Pt | null => {
		const x = (px - t[0]) / s, y = (t[1] - py) / s, xr = x * cγ + y * sγ, yr = -x * sγ + y * cγ, ρ2 = xr * xr + yr * yr;
		if (ρ2 > 1) return null;
		const zr = sqrt(1 - ρ2), ln = atan2(xr, zr * cφ + yr * sφ) / rad - r[0];
		return [((ln + 180) % 360 + 360) % 360 - 180, asin(max(-1, min(1, yr * cφ - zr * sφ))) / rad];
	};
	p.rotate = ((v?: number[]) => v === undefined ? r : (r = v, up(), p)) as Projection["rotate"];
	p.scale = ((v?: number) => v === undefined ? s : (s = v, p)) as Projection["scale"];
	p.translate = ((v?: number[]) => v === undefined ? t : (t = v, p)) as Projection["translate"];
	p.fitExtent = (e: [Pt, Pt]): Projection => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w, h) / 2, t = [e[0][0] + w / 2, e[0][1] + h / 2], up(), p;
	};
	return up(), p;
}

export function geoMercator(): Projection {
	let r = [0, 0, 0], s = 150, t = [480, 250];
	const p = (([ln, lt]: Pt): Pt | null => {
		const x = (ln + r[0]) * rad;
		const y = log(tan(PI / 4 + (lt + r[1]) * rad / 2));
		return [t[0] + s * x, t[1] - s * y];
	}) as Projection;
	p.invert = ([px, py]: Pt): Pt | null => {
		const x = (px - t[0]) / s;
		const y = (t[1] - py) / s;
		return [x / rad - r[0], 2 * atan(exp(y)) / rad - 90 - r[1]];
	};
	p.rotate = ((v?: number[]) => v === undefined ? r : (r = v, p)) as Projection["rotate"];
	p.scale = ((v?: number) => v === undefined ? s : (s = v, p)) as Projection["scale"];
	p.translate = ((v?: number[]) => v === undefined ? t : (t = v, p)) as Projection["translate"];
	p.fitExtent = (e: [Pt, Pt]): Projection => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w, h) / (2 * PI), t = [e[0][0] + w / 2, e[0][1] + h / 2], p;
	};
	return p;
}
export function geoEquirectangular(): Projection {
	let r = [0, 0, 0], s = 150, t = [480, 250];
	const p = (([ln, lt]: Pt): Pt | null => {
		const x = (ln + r[0]) * rad;
		const y = (lt + r[1]) * rad;
		return [t[0] + s * x, t[1] - s * y];
	}) as Projection;
	p.invert = ([px, py]: Pt): Pt | null => {
		const x = (px - t[0]) / s;
		const y = (t[1] - py) / s;
		return [x / rad - r[0], y / rad - r[1]];
	};
	p.rotate = ((v?: number[]) => v === undefined ? r : (r = v, p)) as Projection["rotate"];
	p.scale = ((v?: number) => v === undefined ? s : (s = v, p)) as Projection["scale"];
	p.translate = ((v?: number[]) => v === undefined ? t : (t = v, p)) as Projection["translate"];
	p.fitExtent = (e: [Pt, Pt]): Projection => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w / (2 * PI), h / PI), t = [e[0][0] + w / 2, e[0][1] + h / 2], p;
	};
	return p;
}
