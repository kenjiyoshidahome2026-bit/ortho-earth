import { GeoPBF } from "../pbf-base.js";
import { encodeZIP } from "native-bucket";

// Webカラー(#RRGGBB) または [r,g,b,a] を KML形式(aabbggrr)に変換
const toKMLColor = (c, opacity = 1) => {
    const a = Math.round(opacity * 255).toString(16).padStart(2, '0');
    if (Array.isArray(c)) { // [r, g, b]
        return a + c[2].toString(16).padStart(2, '0') + c[1].toString(16).padStart(2, '0') + c[0].toString(16).padStart(2, '0');
    }
    const hex = c.replace('#', ''); // ff0000 (Red)
    const r = hex.substring(0, 2), g = hex.substring(2, 4), b = hex.substring(4, 6);
    return a + b + g + r;
};

onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        const pbf = await new GeoPBF().name(name).set(buf);
        const embeddedFiles = []; // ZIPに同梱するファイルのリスト

        let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n`;

        // 共有スタイルの定義（メモリ節約のためスタイルはまとめる）
        kml += `  <Style id="defaultStyle">\n    <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>\n    <PolyStyle><color>400000ff</color></PolyStyle>\n  </Style>\n`;

        for (let i = 0, len = pbf.length; i < len; i++) {
            const f = pbf.getFeature(i);
            const { type, coordinates: c } = f.geometry;
            const { color, fillOpacity, iconData, iconName } = f.properties;

            kml += `  <Placemark>\n    <name>${f.id || i}</name>\n`;

            // --- カラーハンドリング ---
            if (color) {
                const kmlColor = toKMLColor(color, fillOpacity || 1);
                kml += `    <Style><LineStyle><color>${kmlColor}</color></LineStyle><PolyStyle><color>${kmlColor}</color></PolyStyle></Style>\n`;
            } else {
                kml += `    <styleUrl>#defaultStyle</styleUrl>\n`;
            }

            // --- ファイルの埋め込み (アイコン等) ---
            if (iconData && iconName) {
                const iconPath = `files/${iconName}`;
                kml += `    <Style><IconStyle><Icon><href>${iconPath}</href></Icon></IconStyle></Style>\n`;
                // iconDataがBlobやArrayBufferなら、後でZIPに詰めるために保持
                embeddedFiles.push(new File([iconData], iconPath));
            }

            kml += `    <ExtendedData>\n`;
            for (const [k, v] of Object.entries(f.properties)) {
                if (v !== null && typeof v !== 'object' && !['iconData', 'iconName'].includes(k)) {
                    kml += `      <Data name="${k}"><value>${v}</value></Data>\n`;
                }
            }
            kml += `    </ExtendedData>\n`;

            // ジオメトリ（経度,緯度,0）
            const pos = pt => `${pt[0]},${pt[1]},0`;
            const posList = r => r.map(pos).join(" ");
            if (type === "Point") kml += `    <Point><coordinates>${pos(c)}</coordinates></Point>\n`;
            else if (type === "LineString") kml += `    <LineString><coordinates>${posList(c)}</coordinates></LineString>\n`;
            else if (type === "Polygon") {
                kml += `    <Polygon>\n`;
                c.forEach((r, j) => {
                    const t = j === 0 ? "outerBoundaryIs" : "innerBoundaryIs";
                    kml += `      <${t}><LinearRing><coordinates>${posList(r)}</coordinates></LinearRing></${t}>\n`;
                });
                kml += `    </Polygon>\n`;
            }
            kml += `  </Placemark>\n`;
        }
        kml += `</Document>\n</kml>`;

        const kmlFile = new File([kml], `doc.kml`, { type: "application/vnd.google-earth.kml+xml" });

        if (gz) {
            // KMZとしてパッケージング。doc.kml と files/ を同梱
            const zip = await encodeZIP([kmlFile, ...embeddedFiles], `${name}.kmz`);
            postMessage(zip);
        } else {
            postMessage(kmlFile);
        }
    } catch (err) { postMessage(null); }
};