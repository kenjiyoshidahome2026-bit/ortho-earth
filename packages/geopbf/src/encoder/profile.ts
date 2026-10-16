import { GeoPBF } from "../pbf.ts";
import { comma } from "../modules/utility.ts";
import type { EncodeRequest } from "../worker-msg.ts";

/** 属性の添字ごとの [点の数, 線の数, 面の数] */
type Struct = [number, number, number];

onmessage = async (e: MessageEvent<EncodeRequest>) => {
	try {
		const { buf, gintbuf } = e.data;
		const self = await (await new GeoPBF().set(buf)).setGintBUF(gintbuf!);   // gintbuf 無し＝旧来どおり setGintBUF(undefined) に任せる
		const fileSizePromise = self.fileSize();
		const { polygonCount, polylineCount, pointCount, nodeCount, arcCount, bbox, polygon, polyline, point } = self.unPackGint!;
		const struct: Record<number, Struct> = {};
		// point は fid の列（Uint32Array）・polyline／polygon は [fid, parts…] の行
		([point, polyline, polygon] as (unknown[] | Uint32Array | null)[]).forEach((layer, type) => (layer || []).forEach((t: unknown) => {
			const id = type ? (t as [number, ArrayLike<unknown>])[0] : t as number, len = type ? (t as [number, ArrayLike<unknown>])[1].length : 1;
			struct[id] = struct[id] || [0, 0, 0];
			struct[id][type] += len;
		}));
		const ids = Object.keys(struct).map(Number);
		const countArr = [0, 0, 0, 0, 0, 0, 0, 0];
		for (const t of Object.values(struct)) {
			if      (t[0] && !t[1] && !t[2]) countArr[t[0] > 1 ? 1 : 0]++;
			else if (!t[0] && t[1] && !t[2]) countArr[t[1] > 1 ? 3 : 2]++;
			else if (!t[0] && !t[1] && t[2]) countArr[t[2] > 1 ? 5 : 4]++;
			else countArr[6]++;
		}
		// Count type-code occurrences directly without an intermediate array (O(N×K) space → O(K×types) space).
		const K = self.keys.length;
		const typeCounts: Record<string, number>[] = Array.from({ length: K }, () => ({}));
		const props = self.props;
		for (let i = 0; i < ids.length; i++) {
			const row = props[ids[i]];
			for (let j = 0; j < row.length; j++) {
				const v = row[j];
				if (v === undefined) continue;
				const dt = GeoPBF.dataType(v);
				const tc = typeCounts[j];
				tc[dt] = (tc[dt] || 0) + 1;
			}
		}
		// Merge FLOAT and INTEGER when both appear — guards against integer literals being typed as FLOAT.
		const typesort = (tc: Record<string, number>): [string, number][] => {
			const c = Object.entries(tc).sort((a, b) => b[1] - a[1]);
			return (c.length === 2 && GeoPBF.dataTypeNames[+c[0][0]] === "FLOAT" && GeoPBF.dataTypeNames[+c[1][0]] === "INTEGER")
				? [[c[0][0], c[0][1] + c[1][1]]]
				: c;
		};
		const br = "-".repeat(50);
		const types = countArr.map((n, i) => n ? `#${GeoPBF.geometryTypes[i]}: ${comma(n)}` : "").filter(Boolean);
		const str = [br];
		self._name        && str.push(` NAME: ${self._name}`);
		self._description && str.push(` DESCRIPTION: ${self._description}`);
		self._attribution && str.push(` ATTRIBUTION: ${self._attribution}`);
		self._license     && str.push(` LICENSE: ${self._license}`);
		// gzip is typically already done by this point, so the await adds negligible cost.
		str.push(` FILE SIZE: ${comma(await fileSizePromise)} [bytes]`);
		str.push(` FEATURES: ${comma(ids.length)} ( ${types.join(" , ")} )`);
		str.push(` PRECISION: ${self._precision} [${1 / self.e}]`);
		str.push(` BBOX: ${JSON.stringify(bbox)}`);
		str.push(br, ` GEOMETRY SECTION`, br);
		str.push(` # POINT: ${comma(pointCount)} # LINE: ${comma(polylineCount)} # POLYGON: ${comma(polygonCount)}`);
		str.push(` # TOTAL ARCS: ${comma(arcCount)}`);
		str.push(` # TOTAL COORDINATES: ${comma(nodeCount)}`);
		str.push(br, ` PROPERTIES SECTION (${K} properties)`, br);
		for (let i = 0; i < K; i++) {
			const typeStr = typesort(typeCounts[i]).map(([dt, n]) => `${GeoPBF.dataTypeNames[+dt]}:${n}`).join("|");
			str.push(` ${self.keys[i]}: ${typeStr}`);
		}
		str.push(br);
		postMessage(str.join("\n") + "\n");
	} catch (err) { postMessage(null); }
};
