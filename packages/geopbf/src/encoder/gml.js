import { GeoPBF } from "../pbf-base.js";
import { encodeZIP } from "../../../native-bucket/src/encodeZIP.js";

self.onmessage = async (e) => {
    const { buf, name, gz } = e.data; // gzフラグをZIP/GZIPの切り替えに流用
    try {
        const pbf = await new GeoPBF().name(name).set(buf);
        const pos = c => `${c[1]} ${c[0]}`;
        const posList = r => r.map(pos).join(" ");

        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;

        for (let i = 0, len = pbf.length; i < len; i++) {
            const f = pbf.getFeature(i);
            const { type, coordinates: c } = f.geometry;
            const fid = f.id || `f${i}`;

            xml += `  <gml:featureMember>\n    <gml:GenericFeature gml:id="${fid}">\n      <gml:geometryProperty>\n`;
            if (type === "Point") {
                xml += `        <gml:Point gml:id="p${i}"><gml:pos>${pos(c)}</gml:pos></gml:Point>\n`;
            } else if (type === "LineString") {
                xml += `        <gml:LineString gml:id="l${i}"><gml:posList>${posList(c)}</gml:posList></gml:LineString>\n`;
            } else if (type === "Polygon") {
                xml += `        <gml:Polygon gml:id="s${i}">\n`;
                c.forEach((ring, j) => {
                    const tag = j === 0 ? "exterior" : "interior";
                    xml += `          <gml:${tag}><gml:LinearRing><gml:posList>${posList(ring)}</gml:posList></gml:LinearRing></gml:${tag}>\n`;
                });
                xml += `        </gml:Polygon>\n`;
            }
            xml += `      </gml:geometryProperty>\n`;

            for (const [k, v] of Object.entries(f.properties)) {
                if (v !== null && typeof v !== 'object' && k !== "id") {
                    const sk = k.replace(/[^a-zA-Z0-9_]/g, '_');
                    xml += `      <${sk}>${v}</${sk}>\n`;
                }
            }
            xml += `    </gml:GenericFeature>\n  </gml:featureMember>\n`;
        }
        xml += `</gml:FeatureCollection>`;

        const gmlFile = new File([xml], `${name}.gml`, { type: "application/gml+xml" });

        // gzフラグが立っていればZIP圧縮、そうでなければ生のGML
        if (gz) {
            const zip = await encodeZIP([gmlFile], `${name}_gml.zip`);
            self.postMessage(zip);
        } else {
            self.postMessage(gmlFile);
        }
    } catch (err) { self.postMessage(null); }
};