import { GeoPBF } from "../pbf-base.js";
export async function precision(self, precision) {
	if (precision === undefined) return self._precision;
	precision = Math.round(precision);
	if (!Number.isFinite(precision) || precision < 1 || precision > 9) {
		throw new RangeError("precision: Number must be Integer [1~9]");
	}
	if (precision === self._precision) return self;
	const [keys, bufs] = [self.keys, self.bufs];
	const dst = new GeoPBF({ precision,
		name: self._name, description: self._description, license: self._license, attribution: self._attribution
	});
	dst.setHead(keys, bufs);
	dst.setBody(() => self.each((i) => {
		const geometry = self.getGeometry(i), properties = self.getProperties(i);
		dst.setFeature({ type: "Feature", geometry, properties });
	}));
	dst.close();
	await dst.getPosition();
	return dst.gint();
}
