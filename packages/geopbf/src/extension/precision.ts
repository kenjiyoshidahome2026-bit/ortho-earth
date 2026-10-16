import type { GeoPBF } from "../pbf.ts";
import type { GeoPBFOptions } from "../../types/geopbf.js";
// 引数なしは同期の読み取り（pbf.ts の GeoPBF.precision() が先に返す）＝ここは再エンコードだけ（undefined の枝は旧来の名残＝Promise<number>）
export async function precision(self: GeoPBF, precision: number): Promise<GeoPBF> {
	if (precision === undefined) return self._precision as unknown as GeoPBF;
	precision = Math.round(precision);
	if (!Number.isFinite(precision) || precision < 1 || precision > 9) {
		throw new RangeError("precision: Number must be Integer [1~9]");
	}
	if (precision === self._precision) return self;
	const [keys, bufs] = [self.keys, self.bufs];
	// 新しいインスタンスは受け手と同じ class（gint() を持つ "geopbf" の GeoPBF）で作る（旧＝pbf-base の GeoPBF＝後付けで同じ class だった・TS 化 段 4）
	const dst = new (self.constructor as new (options?: GeoPBFOptions) => GeoPBF)({ precision,
		name: self._name, description: self._description, license: self._license, attribution: self._attribution
	});
	dst.setHead(keys, bufs);
	dst.setBody(() => self.forEach((i) => {
		const geometry = self.getGeometry(i), properties = self.getProperties(i);
		dst.setFeature({ type: "Feature", geometry, properties });
	}));
	dst.close();
	await dst.getPosition();
	return dst.gint();
}
