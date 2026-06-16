import { GeoPBF } from "../pbf.js";
import { comma } from "common";
onmessage = async (e) => {
    try {
        const { buf, gintbuf } = e.data;
        const self = await (await new GeoPBF().set(buf)).setGintBUF(gintbuf);
        const fileSizePromise = self.fileSize();
        let { polygonCount, polylineCount, pointCount, nodeCount, arcCount, bbox, polygon, polyline, point } = self.unPackGint;
        const struct = {};
        [point, polyline, polygon].forEach((layer, type) => (layer || []).forEach(t => {
            const id = type? t[0]: t, len = type? t[1].length: 1;
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
        // 中間配列を生成せず型コード出現数を直接集計（O(N×K) 空間 → O(K×types) 空間）
        const K = self.keys.length;
        const typeCounts = Array.from({ length: K }, () => ({}));
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
        // FLOAT と INTEGER が共存する場合は FLOAT に統合（整数リテラルがFloat扱いになるケースへの対処）
        const typesort = tc => {
            const c = Object.entries(tc).sort((a, b) => b[1] - a[1]);
            return (c.length === 2 && GeoPBF.dataTypeNames[c[0][0]] === "FLOAT" && GeoPBF.dataTypeNames[c[1][0]] === "INTEGER")
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
        // この時点で gzip は大抵完了しているため await のコストはほぼゼロ
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
            const typeStr = typesort(typeCounts[i]).map(([dt, n]) => `${GeoPBF.dataTypeNames[dt]}:${n}`).join("|");
            str.push(` ${self.keys[i]}: ${typeStr}`);
        }
        str.push(br);
        postMessage(str.join("\n") + "\n");
    } catch (err) { postMessage(null); }
};
