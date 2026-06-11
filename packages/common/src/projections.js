const { PI, max, min, sin, asin, cos, sqrt, log, tan, atan, atan2, exp } = Math, rad = PI / 180;

export function geoOrthographic() {
	let r = [0, 0, 0], s = 150, t = [480, 250], sφ, cφ, sγ, cγ;
	const up = () => (sφ = sin(r[1] * rad), cφ = cos(r[1] * rad), sγ = sin(r[2] * rad), cγ = cos(r[2] * rad));
	const p = ([ln, lt]) => {
		const l = (ln + r[0]) * rad, φ = lt * rad, cp = cos(φ), sp = sin(φ), cl = cos(l), sl = sin(l);
		const x = cp * sl, y = sp, z = cp * cl, yr = y * cφ + z * sφ, zr = z * cφ - y * sφ;
		return zr < 0 ? null : [t[0] + s * (x * cγ - yr * sγ), t[1] - s * (x * sγ + yr * cγ)];
	};
	p.invert = ([px, py]) => {
		const x = (px - t[0]) / s, y = (t[1] - py) / s, xr = x * cγ + y * sγ, yr = -x * sγ + y * cγ, ρ2 = xr * xr + yr * yr;
		if (ρ2 > 1) return null;
		const zr = sqrt(1 - ρ2), ln = atan2(xr, zr * cφ + yr * sφ) / rad - r[0];
		return [((ln + 180) % 360 + 360) % 360 - 180, asin(max(-1, min(1, yr * cφ - zr * sφ))) / rad];
	};
	p.rotate = v => v === undefined ? r : (r = v, up(), p);
	p.scale = v => v === undefined ? s : (s = v, p);
	p.translate = v => v === undefined ? t : (t = v, p);
	p.fitExtent = (e) => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w, h) / 2, t = [e[0][0] + w / 2, e[0][1] + h / 2], up(), p;
	};
	return up(), p;
}

export function geoMercator() {
	let r = [0, 0, 0], s = 150, t = [480, 250];
	const p = ([ln, lt]) => {
		const x = (ln + r[0]) * rad;
		const y = log(tan(PI / 4 + (lt + r[1]) * rad / 2));
		return [t[0] + s * x, t[1] - s * y];
	};
	p.invert = ([px, py]) => {
		const x = (px - t[0]) / s;
		const y = (t[1] - py) / s;
		return [x / rad - r[0], 2 * atan(exp(y)) / rad - 90 / 180 * 360 - r[1]];
	};
	p.rotate = v => v === undefined ? r : (r = v, p);
	p.scale = v => v === undefined ? s : (s = v, p);
	p.translate = v => v === undefined ? t : (t = v, p);
	p.fitExtent = (e) => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w, h) / (2 * PI), t = [e[0][0] + w / 2, e[0][1] + h / 2], p;
	};
	return p;
}
export function geoEquirectangular() {
	let r = [0, 0, 0], s = 150, t = [480, 250];
	const p = ([ln, lt]) => {
		const x = (ln + r[0]) * rad;
		const y = (lt + r[1]) * rad;
		return [t[0] + s * x, t[1] - s * y];
	};
	p.invert = ([px, py]) => {
		const x = (px - t[0]) / s;
		const y = (t[1] - py) / s;
		return [x / rad - r[0], y / rad - r[1]];
	};
	p.rotate = v => v === undefined ? r : (r = v, p);
	p.scale = v => v === undefined ? s : (s = v, p);
	p.translate = v => v === undefined ? t : (t = v, p);
	p.fitExtent = (e) => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w / (2 * PI), h / PI), t = [e[0][0] + w / 2, e[0][1] + h / 2], p;
	};
	return p;
}