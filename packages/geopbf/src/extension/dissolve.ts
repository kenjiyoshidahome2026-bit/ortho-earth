import { GeoPBF, propsKeyOf } from "../pbf-base.ts";
import type { GeoPBFBase } from "../pbf-base.ts";
import type { Feature, Geometry, GeometryCollection, Position, Properties } from "../../types/geopbf.js";

const { geometryTypes, geometryMap } = GeoPBF;

/** 同じ属性（key＝その鍵だけ・true＝全部同じ・false＝全属性）の地物を併合して同じインスタンスを返す */
export async function dissolve<T extends GeoPBFBase>(pbfInstance: T, key: string | boolean | number = false): Promise<T> {
	if (typeof key === "string") {
		key = pbfInstance.keys.indexOf(key);
		if (key < 0) key = false;
	}
	// 全属性のキーは型ごとに（2026-09-25・B7）：旧 join("|") は 1 と "1"、"" と null、["a|","b"] と ["a","|b"] を同じ地物として併合した（propsKeyOf）
	// 行は propsRow＝worker 復号の遅延 props でも読める
	const keyAt = (i: number): unknown => typeof key === "number" ? pbfInstance.propsRow(i)[key] : key === true ? "" : propsKeyOf(pbfInstance.propsRow(i));
	// 併合ゼロの先行判定（props のみ・ジオメトリ復号なし）：全キーが一意なら dissolve は
	// 「全地物デコード→全再エンコード→再インデックス」の空回り（実測 1.4s/57k 地物）。
	// 地番を持つ地籍・建物・住所系は本質的に全キー一意＝ここで即帰る。重複が1つでもあれば従来経路。
	{
		const seen = new Set();
		let dup = false;
		for (let i = 0, n = pbfInstance.length; i < n; i++) {
			const k = keyAt(i);
			if (seen.has(k)) { dup = true; break; }
			seen.add(k);
		}
		if (!dup) return pbfInstance;
	}
	/** 鍵 → [代表の地物, [点, 線, 面], 点の重複除け] */
	const propTub = new Map<unknown, [number, [Position[], Position[][], Position[][][]], Set<string>]>();
	pbfInstance.forEach(i => {
		const pkey = keyAt(i);
		if (!propTub.has(pkey)) propTub.set(pkey, [i, [[], [], []], new Set()]);
		const [, a, ptSet] = propTub.get(pkey)!;
		const geom = pbfInstance.getGeometry(i);
		if (!geom) return;
		geom.type === geometryTypes[6] ? (geom as GeometryCollection).geometries.forEach(elem) : elem(geom);
		function elem(geom: Geometry): void {
			const { type, coordinates } = geom as Geometry & { coordinates: unknown };
			const n = geometryMap[type], multi = (n % 2), fig = n < 2 ? 0 : n < 4 ? 1 : 2;
			if (fig === 0) {
				((multi ? coordinates : [coordinates]) as Position[]).forEach(pt => {
					const k = pt.join(",");
					if (!ptSet.has(k)) { ptSet.add(k); a[0].push(pt); }
				});
			} else {
				const af = a[fig] as unknown[];
				multi ? af.push(...(coordinates as unknown[])) : af.push(coordinates);
			}
		}
	});
	pbfInstance.pbf.pos = pbfInstance._bodyPos;
	pbfInstance.setBody(() => {
		for (const [id, a] of propTub.values()) {
			const properties: Properties = key === false ? pbfInstance.getProperties(id) : {};
			if (typeof key === "number") properties![pbfInstance.keys[key]] = pbfInstance.propsRow(id)[key];
			const active: number[] = [];
			[0, 1, 2].forEach(n => a[n].length && active.push(n));
			if (active.length === 1) {
				write(active[0]);
			} else if (active.length > 1) {
				const geometries = active.map(n => geom(n));
				pbfInstance.setFeature({ geometry: { type: geometryTypes[6], geometries }, properties } as Feature);
			}
			function geom(n: number): Geometry { 
				const isM = a[n].length > 1, type = geometryTypes[n * 2 + (isM ? 1 : 0)], coordinates = isM ? a[n] : a[n][0];
				return { type, coordinates } as Geometry;
			}   
			function write(n: number): void { pbfInstance.setFeature({ geometry: geom(n), properties } as Feature); }
		}
	});
	pbfInstance.close();
	await pbfInstance.getPosition();
	return pbfInstance;
}