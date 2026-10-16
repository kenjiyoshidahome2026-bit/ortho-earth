// MapLibre の口（src/maplibre/・公式例の門 §8）の値の型＝LngLat・LngLatBounds・MercatorCoordinate（MapLibre GL JS と同じ形・同じ意味）。
// 地図に触らない純粋な値＝エンジンの機能ではない（通訳の一部）。地球の半径は MapLibre と同じ 6371008.8m（平均半径）。
const EARTH_R = 6371008.8, EARTH_C = 2 * Math.PI * EARTH_R, D2R = Math.PI / 180;
/** 経緯度の書き方（MapLibre と同じ・[lng, lat, 高さ] も受ける） */
export type LngLatLike = LngLat | { lng: number; lat: number } | { lon: number; lat: number } | [number, number] | [number, number, number];
/** 範囲の書き方（MapLibre と同じ） */
export type LngLatBoundsLike = LngLatBounds | [LngLatLike, LngLatLike] | [number, number, number, number];
const wrapLng = (lng: number): number => { const w = ((lng + 180) % 360 + 360) % 360 - 180; return w === -180 ? 180 : w; };

export class LngLat {
	declare lng: number;
	declare lat: number;
	constructor(lng: number, lat: number) {
		if (isNaN(lng) || isNaN(lat)) throw new Error(`Invalid LngLat object: (${lng}, ${lat})`);
		this.lng = +lng; this.lat = +lat;
		if (this.lat > 90 || this.lat < -90) throw new Error("Invalid LngLat latitude value: must be between -90 and 90");
	}
	wrap(): LngLat { return new LngLat(wrapLng(this.lng), this.lat); }
	toArray(): [number, number] { return [this.lng, this.lat]; }
	toString(): string { return `LngLat(${this.lng}, ${this.lat})`; }
	distanceTo(o: LngLat): number {
		const a = this.lat * D2R, b = o.lat * D2R;
		const h = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((o.lng - this.lng) * D2R);
		return EARTH_R * Math.acos(Math.min(h, 1));
	}
	toBounds(radius = 0): LngLatBounds { return LngLatBounds.fromLngLat(this, radius); }
	static convert(input: LngLatLike): LngLat {
		if (input instanceof LngLat) return input;
		if (Array.isArray(input) && (input.length === 2 || input.length === 3)) return new LngLat(+input[0], +input[1]);
		if (input && typeof input === "object") return new LngLat(+("lng" in input ? input.lng : (input as { lon: number }).lon), +(input as { lat: number }).lat);
		throw new Error("`LngLatLike` argument must be specified as a LngLat instance, an object {lng: <lng>, lat: <lat>}, an object {lon: <lng>, lat: <lat>}, or an array of [<lng>, <lat>]");
	}
}

export class LngLatBounds {
	declare _sw: LngLat;
	declare _ne: LngLat;
	constructor(sw?: LngLatLike | LngLatBoundsLike | null, ne?: LngLatLike | null) {
		if (!sw) return;
		if (ne) this.setSouthWest(sw as LngLatLike).setNorthEast(ne);
		else if (Array.isArray(sw)) {
			if (sw.length === 4) this.setSouthWest([sw[0], sw[1]]).setNorthEast([sw[2], sw[3]]);
			else this.setSouthWest(sw[0] as LngLatLike).setNorthEast(sw[1] as LngLatLike);
		}
	}
	setNorthEast(ne: LngLatLike): this { this._ne = ne instanceof LngLat ? new LngLat(ne.lng, ne.lat) : LngLat.convert(ne); return this; }
	setSouthWest(sw: LngLatLike): this { this._sw = sw instanceof LngLat ? new LngLat(sw.lng, sw.lat) : LngLat.convert(sw); return this; }
	extend(obj: LngLatLike | LngLatBoundsLike | null | undefined): this {
		let sw2: LngLat, ne2: LngLat;
		if (obj instanceof LngLat) { sw2 = obj; ne2 = obj; }
		else if (obj instanceof LngLatBounds) { sw2 = obj._sw; ne2 = obj._ne; if (!sw2 || !ne2) return this; }
		else if (Array.isArray(obj)) {
			if (obj.length === 4 || obj.every(Array.isArray)) return this.extend(LngLatBounds.convert(obj as LngLatBoundsLike));
			return this.extend(LngLat.convert(obj as LngLatLike));
		} else if (obj && typeof obj === "object") return this.extend(LngLat.convert(obj));
		else return this;
		if (!this._sw && !this._ne) { this._sw = new LngLat(sw2.lng, sw2.lat); this._ne = new LngLat(ne2.lng, ne2.lat); }
		else {
			this._sw.lng = Math.min(sw2.lng, this._sw.lng); this._sw.lat = Math.min(sw2.lat, this._sw.lat);
			this._ne.lng = Math.max(ne2.lng, this._ne.lng); this._ne.lat = Math.max(ne2.lat, this._ne.lat);
		}
		return this;
	}
	getCenter(): LngLat { return new LngLat((this._sw.lng + this._ne.lng) / 2, (this._sw.lat + this._ne.lat) / 2); }
	getSouthWest(): LngLat { return this._sw; }
	getNorthEast(): LngLat { return this._ne; }
	getNorthWest(): LngLat { return new LngLat(this.getWest(), this.getNorth()); }
	getSouthEast(): LngLat { return new LngLat(this.getEast(), this.getSouth()); }
	getWest(): number { return this._sw.lng; }
	getSouth(): number { return this._sw.lat; }
	getEast(): number { return this._ne.lng; }
	getNorth(): number { return this._ne.lat; }
	toArray(): [number, number][] { return [this._sw.toArray(), this._ne.toArray()]; }
	toString(): string { return `LngLatBounds(${this._sw.toString()}, ${this._ne.toString()})`; }
	isEmpty(): boolean { return !(this._sw && this._ne); }
	contains(lnglat: LngLatLike): boolean {
		const { lng, lat } = LngLat.convert(lnglat);
		const inLat = this._sw.lat <= lat && lat <= this._ne.lat;
		const inLng = this._sw.lng > this._ne.lng ? (this._sw.lng >= lng && lng >= this._ne.lng) : (this._sw.lng <= lng && lng <= this._ne.lng);
		return inLat && inLng;
	}
	static convert(input: LngLatBoundsLike): LngLatBounds;
	static convert(input: LngLatBoundsLike | null | undefined): LngLatBounds | null | undefined;
	static convert(input: LngLatBoundsLike | null | undefined): LngLatBounds | null | undefined { if (input instanceof LngLatBounds) return input; if (!input) return input; return new LngLatBounds(input); }
	static fromLngLat(center: LngLatLike, radius = 0): LngLatBounds {
		const c = LngLat.convert(center), latAcc = 360 * radius / EARTH_C, lngAcc = latAcc / Math.cos(D2R * c.lat);
		return new LngLatBounds(new LngLat(c.lng - lngAcc, c.lat - latAcc), new LngLat(c.lng + lngAcc, c.lat + latAcc));
	}
}

// Web メルカトルの 0..1 の座標（MapLibre の custom 層が使う）。この地図は球で描く＝座標の換算だけを持つ（描く口は無い）
export class MercatorCoordinate {
	declare x: number;
	declare y: number;
	declare z: number;
	constructor(x: number, y: number, z = 0) { this.x = +x; this.y = +y; this.z = +z; }
	static fromLngLat(lngLatLike: LngLatLike, altitude = 0): MercatorCoordinate {
		const ll = LngLat.convert(lngLatLike);
		return new MercatorCoordinate((180 + ll.lng) / 360, (180 - (180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + ll.lat * Math.PI / 360)))) / 360,
			altitude / (EARTH_C * Math.cos(ll.lat * D2R)));
	}
	toLngLat(): LngLat { return new LngLat(this.x * 360 - 180, 360 / Math.PI * Math.atan(Math.exp((180 - this.y * 360) * Math.PI / 180)) - 90); }
	toAltitude(): number { return this.z * EARTH_C * Math.cos(this.toLngLat().lat * D2R); }
	meterInMercatorCoordinateUnits(): number { return 1 / EARTH_C * (1 / Math.cos(this.toLngLat().lat * D2R)); }
}

// ── FreeCameraOptions（MapLibre 同名・A3・2026-10-12）：カメラの位置（MercatorCoordinate・高さ込み）と向き（四元数 [x,y,z,w]）。
// 向きの約束＝メルカトルの枠（x 東・y 南・z 上）で、pitch 0・bearing 0 のカメラは真下（0,0,−1）を見て画面の上が北（0,−1,0）。bearing は +z 回り（北から時計回り）・
// pitch は視線を地平へ倒す・roll は視線まわり。分解（pitchBearingRollFromOrientation）はこの組み立ての逆＝往復は恒等（門 mlshim）。MapLibre の四元数（gl-matrix・同じ枠）と
// 符号まで一致するかは本物と並べて確かめていない（§4）＝lookAtPoint／setPitchBearing で作った向きはこの口の中で閉じる。
const qMul = (a: number[], b: number[]): number[] => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qAxis = (ax: number, ay: number, az: number, rad: number): number[] => { const s = Math.sin(rad / 2); return [ax * s, ay * s, az * s, Math.cos(rad / 2)]; };
const qRot = (q: number[], v: number[]): number[] => {   // v を q で回す
	const [x, y, z, w] = q, [vx, vy, vz] = v;
	const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
	return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
export function orientationFromPitchBearing(pitchDeg: number, bearingDeg: number, rollDeg = 0): number[] {
	let q = [0, 0, 0, 1];   // 先に掛けた物が後から効く（q·v＝a(b(v))）＝roll → pitch → bearing の順に体に効く
	q = qMul(q, qAxis(0, 0, 1, bearingDeg * D2R));     // 方位（x 東・y 南の枠で +z 回り＝北から時計回り）
	q = qMul(q, qAxis(1, 0, 0, -pitchDeg * D2R));      // チルト（視線が北＝−y の地平へ倒れる）
	if (rollDeg) q = qMul(q, qAxis(0, 0, 1, -rollDeg * D2R));   // 視線まわり（正＝絵が時計回り）
	return q;
}
export function pitchBearingRollFromOrientation(q: number[]): { pitch: number; bearing: number; roll: number } {
	const f = qRot(q, [0, 0, -1]);   // 視線
	const pitch = Math.acos(Math.max(-1, Math.min(1, -f[2]))) / D2R;
	const hor = Math.hypot(f[0], f[1]);
	const bearing = hor < 1e-9 ? (() => { const u = qRot(q, [0, -1, 0]); return Math.atan2(u[0], -u[1]) / D2R; })() : Math.atan2(f[0], -f[1]) / D2R;   // 真下＝画面の上の向きで決める
	const q0 = orientationFromPitchBearing(pitch, bearing, 0), u0 = qRot(q0, [0, -1, 0]), r0 = qRot(q0, [1, 0, 0]), u = qRot(q, [0, -1, 0]);
	const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const roll = -Math.atan2(dot(u, r0), dot(u, u0)) / D2R;   // 組み立ての −roll と対
	const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
	return { pitch, bearing: wrap(bearing), roll: wrap(roll) };
}
export class FreeCameraOptions {
	declare position: MercatorCoordinate | undefined;
	declare orientation: number[] | undefined;
	constructor(position?: MercatorCoordinate, orientation?: number[]) { this.position = position; this.orientation = orientation; }
	/** 位置から target（経緯度・高さ 0）を見る向きに（up は無視＝MapLibre も鉛直の既定だけ使う） */
	lookAtPoint(target: LngLatLike, up?: unknown): void {
		if (!this.position) return;
		const p = this.position, t = MercatorCoordinate.fromLngLat(LngLat.convert(target), 0);
		const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z, hor = Math.hypot(dx, dy);
		const bearing = Math.atan2(dx, -dy) / D2R, pitch = Math.atan2(hor, -dz) / D2R;
		this.orientation = orientationFromPitchBearing(Math.max(0, Math.min(180, pitch)), bearing, 0);
		void up;
	}
	setPitchBearing(pitch: number, bearing: number): void { this.orientation = orientationFromPitchBearing(pitch, bearing, 0); }
}
