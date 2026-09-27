// MapLibre の口（src/maplibre/・公式例の門 §8）の値の型＝LngLat・LngLatBounds・MercatorCoordinate（MapLibre GL JS と同じ形・同じ意味）。
// 地図に触らない純粋な値＝エンジンの機能ではない（通訳の一部）。地球の半径は MapLibre と同じ 6371008.8m（平均半径）。
const EARTH_R = 6371008.8, EARTH_C = 2 * Math.PI * EARTH_R, D2R = Math.PI / 180;
const wrapLng = lng => { const w = ((lng + 180) % 360 + 360) % 360 - 180; return w === -180 ? 180 : w; };

export class LngLat {
	constructor(lng, lat) {
		if (isNaN(lng) || isNaN(lat)) throw new Error(`Invalid LngLat object: (${lng}, ${lat})`);
		this.lng = +lng; this.lat = +lat;
		if (this.lat > 90 || this.lat < -90) throw new Error("Invalid LngLat latitude value: must be between -90 and 90");
	}
	wrap() { return new LngLat(wrapLng(this.lng), this.lat); }
	toArray() { return [this.lng, this.lat]; }
	toString() { return `LngLat(${this.lng}, ${this.lat})`; }
	distanceTo(o) {
		const a = this.lat * D2R, b = o.lat * D2R;
		const h = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((o.lng - this.lng) * D2R);
		return EARTH_R * Math.acos(Math.min(h, 1));
	}
	toBounds(radius = 0) { return LngLatBounds.fromLngLat(this, radius); }
	static convert(input) {
		if (input instanceof LngLat) return input;
		if (Array.isArray(input) && (input.length === 2 || input.length === 3)) return new LngLat(+input[0], +input[1]);
		if (input && typeof input === "object") return new LngLat(+("lng" in input ? input.lng : input.lon), +input.lat);
		throw new Error("`LngLatLike` argument must be specified as a LngLat instance, an object {lng: <lng>, lat: <lat>}, an object {lon: <lng>, lat: <lat>}, or an array of [<lng>, <lat>]");
	}
}

export class LngLatBounds {
	constructor(sw, ne) {
		if (!sw) return;
		if (ne) this.setSouthWest(sw).setNorthEast(ne);
		else if (Array.isArray(sw)) {
			if (sw.length === 4) this.setSouthWest([sw[0], sw[1]]).setNorthEast([sw[2], sw[3]]);
			else this.setSouthWest(sw[0]).setNorthEast(sw[1]);
		}
	}
	setNorthEast(ne) { this._ne = ne instanceof LngLat ? new LngLat(ne.lng, ne.lat) : LngLat.convert(ne); return this; }
	setSouthWest(sw) { this._sw = sw instanceof LngLat ? new LngLat(sw.lng, sw.lat) : LngLat.convert(sw); return this; }
	extend(obj) {
		let sw2, ne2;
		if (obj instanceof LngLat) { sw2 = obj; ne2 = obj; }
		else if (obj instanceof LngLatBounds) { sw2 = obj._sw; ne2 = obj._ne; if (!sw2 || !ne2) return this; }
		else if (Array.isArray(obj)) {
			if (obj.length === 4 || obj.every(Array.isArray)) return this.extend(LngLatBounds.convert(obj));
			return this.extend(LngLat.convert(obj));
		} else if (obj && typeof obj === "object") return this.extend(LngLat.convert(obj));
		else return this;
		if (!this._sw && !this._ne) { this._sw = new LngLat(sw2.lng, sw2.lat); this._ne = new LngLat(ne2.lng, ne2.lat); }
		else {
			this._sw.lng = Math.min(sw2.lng, this._sw.lng); this._sw.lat = Math.min(sw2.lat, this._sw.lat);
			this._ne.lng = Math.max(ne2.lng, this._ne.lng); this._ne.lat = Math.max(ne2.lat, this._ne.lat);
		}
		return this;
	}
	getCenter() { return new LngLat((this._sw.lng + this._ne.lng) / 2, (this._sw.lat + this._ne.lat) / 2); }
	getSouthWest() { return this._sw; }
	getNorthEast() { return this._ne; }
	getNorthWest() { return new LngLat(this.getWest(), this.getNorth()); }
	getSouthEast() { return new LngLat(this.getEast(), this.getSouth()); }
	getWest() { return this._sw.lng; }
	getSouth() { return this._sw.lat; }
	getEast() { return this._ne.lng; }
	getNorth() { return this._ne.lat; }
	toArray() { return [this._sw.toArray(), this._ne.toArray()]; }
	toString() { return `LngLatBounds(${this._sw.toString()}, ${this._ne.toString()})`; }
	isEmpty() { return !(this._sw && this._ne); }
	contains(lnglat) {
		const { lng, lat } = LngLat.convert(lnglat);
		const inLat = this._sw.lat <= lat && lat <= this._ne.lat;
		const inLng = this._sw.lng > this._ne.lng ? (this._sw.lng >= lng && lng >= this._ne.lng) : (this._sw.lng <= lng && lng <= this._ne.lng);
		return inLat && inLng;
	}
	static convert(input) { if (input instanceof LngLatBounds) return input; if (!input) return input; return new LngLatBounds(input); }
	static fromLngLat(center, radius = 0) {
		const c = LngLat.convert(center), latAcc = 360 * radius / EARTH_C, lngAcc = latAcc / Math.cos(D2R * c.lat);
		return new LngLatBounds(new LngLat(c.lng - lngAcc, c.lat - latAcc), new LngLat(c.lng + lngAcc, c.lat + latAcc));
	}
}

// Web メルカトルの 0..1 の座標（MapLibre の custom 層が使う）。この地図は球で描く＝座標の換算だけを持つ（描く口は無い）
export class MercatorCoordinate {
	constructor(x, y, z = 0) { this.x = +x; this.y = +y; this.z = +z; }
	static fromLngLat(lngLatLike, altitude = 0) {
		const ll = LngLat.convert(lngLatLike);
		return new MercatorCoordinate((180 + ll.lng) / 360, (180 - (180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + ll.lat * Math.PI / 360)))) / 360,
			altitude / (EARTH_C * Math.cos(ll.lat * D2R)));
	}
	toLngLat() { return new LngLat(this.x * 360 - 180, 360 / Math.PI * Math.atan(Math.exp((180 - this.y * 360) * Math.PI / 180)) - 90); }
	toAltitude() { return this.z * EARTH_C * Math.cos(this.toLngLat().lat * D2R); }
	meterInMercatorCoordinateUnits() { return 1 / EARTH_C * (1 / Math.cos(this.toLngLat().lat * D2R)); }
}
